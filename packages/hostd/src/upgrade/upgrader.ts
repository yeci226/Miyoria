// One update of this host's checkout, asked for by Core (`host.upgrade`, docs/design/v5-hostd.md
// §14). Core names a commit and nothing else; the sequence is this file's:
//
//   check    not opted out (the daemon), a git checkout, on a branch that tracks a remote, no
//            changes to tracked files. No network. A refusal here changes nothing.
//   fetch    `git fetch --no-tags <the branch's remote>`; the commit must exist, be on the tracked
//            upstream, and be a fast-forward of HEAD (not older, not on another line).
//   wait     while a job runs (a song being made, singing, live, a GPU lease): visible as
//            `waiting`, up to `wait_s`; cancellable.
//   merge    HEAD and the tree checked again, then `git merge --ff-only <commit>`; HEAD must be
//            the commit afterwards.
//   install  `pnpm install --frozen-lockfile` when a package file changed, with the Node services
//            that will restart stopped first (Windows keeps their native modules locked).
//   sync     `uv sync` of the Python environments that are stale now (user-managed ones never),
//            each stopped first when it runs.
//   restart  the running services whose code changed, one at a time, after the host is idle
//            again; the ones stopped above are started again whatever happens.
//   verify   the restarted services come back healthy; what they need that an update never
//            downloads (model files, models, things placed by hand) is listed.
//
// A failure in merge, install or sync goes back: `git reset --keep <from>` (only while HEAD is
// still the commit this job made; `--keep` refuses rather than touch a changed file), the old
// lockfile's `pnpm install`, the environments synced again, the stopped services started. A
// service that does not come back after the restart is reported, not rolled back. Nothing here
// ever resets a tree it did not move, discards a change, or downloads a model.

import { randomUUID } from "node:crypto";
import type {
  HostUpgrade,
  HostUpgradeJob,
  HostUpgradeMissing,
  HostUpgradeStepName,
} from "@miyoria/contracts/host";
import { HOST_ERROR_CODE } from "@miyoria/contracts/host";
import { HostRpcError } from "../api.js";
import type { CatalogEntry } from "../catalog.js";
import type { CommandRunner } from "../install/run.js";
import { needsPnpmInstall, servicesChangedBy, upgradeNotes } from "./changes.js";
import {
  changedFiles,
  FETCH_MS,
  type GitOptions,
  git,
  gitEnv,
  hasCommit,
  headOf,
  isAncestor,
  looksLikeCheckout,
  readCheckout,
  trackedChanges,
  trackingOf,
} from "./git.js";

/** One service as the update sees it. */
export interface UpgradeService {
  name: string;
  /** `null` for a service the catalog no longer has. */
  entry: CatalogEntry | null;
  /** Its process runs (`running`, `starting` or `backoff`): it runs the code it was started with. */
  running: boolean;
}

/** What the update needs of the daemon. */
export interface UpgradeHost {
  /** The services of this host, in start order. */
  services(): UpgradeService[];
  /** Why the host is not idle now, in words; empty when it is. */
  busy(signal: AbortSignal): Promise<string[]>;
  /** Reads `host.toml` and the descriptors again (the merge changed them). */
  reload(): void;
  /** The managed Python environments that differ from their lock, extras or descriptor now. */
  staleEnvs(): string[];
  /** `uv sync` of one service's environment. */
  sync(
    name: string,
    signal: AbortSignal,
    onLine: (line: string) => void,
  ): Promise<{ ok: boolean; detail?: string }>;
  stop(name: string): Promise<void>;
  /** Starts a stopped service with its plan read again. */
  start(name: string): Promise<void>;
  /** Stops and starts a running service with its plan read again (no guard: the update waited). */
  restart(name: string): Promise<void>;
  /** Waits until each is running and healthy; returns the ones that are not, with why. */
  healthy(
    names: readonly string[],
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<Array<{ service: string; reason: string }>>;
  /** What the enabled services lack that an update never fetches. */
  missing(): HostUpgradeMissing[];
  /** The job changed: report it. */
  changed(): void;
  log: {
    info(fields: object, message: string): void;
    warn(fields: object, message: string): void;
  };
}

export interface UpgraderOptions {
  /** The checkout's top folder (the catalog root). */
  root: string;
  runner: CommandRunner;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  host: UpgradeHost;
  now?: () => number;
  /** How often a waiting update asks whether the host is idle. Default 5 s. */
  pollMs?: number;
  /** How long the restarted services have to become healthy. Default 10 minutes. */
  healthyMs?: number;
  /** Default `wait_s`. 30 minutes. */
  defaultWaitS?: number;
  newId?: () => string;
  /** `pnpm` (tests). */
  pnpm?: string;
}

/** `pnpm install` may take this long. */
const INSTALL_MS = 15 * 60_000;
/** A line of a failed program's output kept in the job. */
const TAIL = 6;

class Refused extends Error {
  override name = "Refused";
}

class Cancelled extends Error {
  override name = "Cancelled";
}

/** Why a sequence stopped after the merge: it goes back. */
class Failed extends Error {
  override name = "Failed";
}

function tail(lines: readonly string[]): string {
  return lines.slice(-TAIL).join(" / ");
}

const short = (sha: string) => sha.slice(0, 8);

export class Upgrader {
  readonly #o: UpgraderOptions;
  readonly #git: GitOptions;
  #job: HostUpgradeJob | null = null;
  #run: Promise<void> | null = null;
  #cancel: AbortController | null = null;
  /** The working tree has been changed by the running job. */
  #touched = false;

  constructor(options: UpgraderOptions) {
    this.#o = options;
    this.#git = {
      root: options.root,
      runner: options.runner,
      ...(options.env !== undefined ? { env: options.env } : {}),
    };
  }

  /** The running job, or the last one; `null` before the first. */
  get job(): HostUpgradeJob | null {
    return this.#job === null ? null : structuredClone(this.#job);
  }

  /** A job is waiting or running. */
  get busy(): boolean {
    return this.#run !== null;
  }

  /** Waits for the running job (tests, shutdown). */
  async settled(): Promise<void> {
    await this.#run;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /**
   * Starts an update to `params.commit`. Runs the check step now: a refusal is recorded as the
   * last job and thrown (`NotAllowed`, with the reason). Otherwise answers with the job at once;
   * the rest runs on and is reported through `changed`.
   */
  async begin(params: HostUpgrade): Promise<HostUpgradeJob> {
    if (this.#run !== null) {
      throw new HostRpcError(HOST_ERROR_CODE.Busy, "這台已經在更新了,等它結束再試");
    }
    const now = this.#now();
    const job: HostUpgradeJob = {
      id: (this.#o.newId ?? randomUUID)(),
      target: params.commit,
      from: null,
      state: "running",
      step: "check",
      steps: [],
      started_at: now,
      ...(params.by !== undefined ? { by: params.by } : {}),
    };
    this.#job = job;
    this.#touched = false;
    const cancel = new AbortController();
    this.#cancel = cancel;
    // Holds the slot while the check runs, so a second call is refused.
    let release: () => void = () => {};
    this.#run = new Promise<void>((done) => {
      release = done;
    });
    let tracking: { remote: string; merge: string };
    try {
      this.#step("check", "running");
      tracking = await this.#check(job);
      if (job.state === "done") {
        this.#run = null;
        release();
        return this.job as HostUpgradeJob;
      }
      this.#step("check", "done");
    } catch (error) {
      this.#end(error);
      this.#run = null;
      release();
      throw new HostRpcError(HOST_ERROR_CODE.NotAllowed, job.error ?? String(error));
    }
    const waitMs = (params.wait_s ?? this.#o.defaultWaitS ?? 1800) * 1000;
    const run = this.#rest(job, tracking, waitMs, cancel.signal)
      .catch((error: unknown) => this.#end(error))
      .finally(() => {
        this.#run = null;
        this.#cancel = null;
        release();
        this.#o.host.changed();
      });
    this.#run = run;
    return this.job as HostUpgradeJob;
  }

  /** Cancels a job that has not changed anything yet. Returns whether it did. */
  cancel(): boolean {
    if (this.#run === null || this.#touched || this.#cancel === null) return false;
    this.#cancel.abort(new Cancelled("cancelled"));
    return true;
  }

  // ---- the steps ---------------------------------------------------------------------------

  async #check(job: HostUpgradeJob): Promise<{ remote: string; merge: string }> {
    const root = this.#o.root;
    if (!looksLikeCheckout(root)) {
      throw new Refused(
        "這台不是從 git checkout 執行的,不能遠端更新(用 npm 安裝的請用套件管理員升級)",
      );
    }
    const checkout = await readCheckout({
      ...this.#git,
      now: () => this.#now(),
      ...(this.#o.platform !== undefined ? { platform: this.#o.platform } : {}),
    });
    if (checkout === null)
      throw new Refused("讀不到這台的 git 狀態(git 沒有裝,或不是 checkout 的最上層)");
    job.from = checkout.commit;
    if (checkout.branch === null) throw new Refused("HEAD 不在任何分支上(detached),不會動它");
    const tracking = await trackingOf(this.#git, checkout.branch);
    if (tracking === null) {
      throw new Refused(`分支 ${checkout.branch} 沒有追蹤遠端的分支,不知道該從哪裡拿`);
    }
    if (checkout.dirty) {
      throw new Refused("這台有還沒提交的變更(git status),不會動它;請那台的主人先處理");
    }
    if (checkout.commit === job.target) {
      this.#step("check", "done", "已經是這個版本");
      job.state = "done";
      job.commit = checkout.commit;
      job.finished_at = this.#now();
      this.#o.host.changed();
    }
    return tracking;
  }

  async #rest(
    job: HostUpgradeJob,
    tracking: { remote: string; merge: string },
    waitMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const deadline = this.#now() + waitMs;
    const from = job.from as string;
    const upstream = `${tracking.remote}/${tracking.merge.slice("refs/heads/".length)}`;

    // fetch: the network, nothing on disk but the remote's refs.
    this.#step("fetch", "running", `git fetch ${tracking.remote}`);
    const fetched = await git(this.#git, ["fetch", "--no-tags", tracking.remote], {
      timeoutMs: FETCH_MS,
      signal,
    });
    this.#throwIfCancelled(signal);
    if (fetched.code !== 0) {
      throw new Error(`git fetch 失敗:${tail(fetched.lines) || "沒有輸出"}`);
    }
    if (!(await hasCommit(this.#git, job.target))) {
      throw new Refused(
        `${upstream} 上找不到提交 ${short(job.target)}(Core 那台的提交還沒推上去?)`,
      );
    }
    if ((await isAncestor(this.#git, job.target, "@{upstream}")) !== true) {
      throw new Refused(`提交 ${short(job.target)} 不在這台追蹤的 ${upstream} 上,不會切過去`);
    }
    if ((await isAncestor(this.#git, from, job.target)) !== true) {
      const newer = await isAncestor(this.#git, job.target, from);
      throw new Refused(
        newer === true
          ? `這台(${short(from)})比要求的版本 ${short(job.target)} 新,不會退回去`
          : `這台的分支和 ${upstream} 分岔了,不能快轉;請那台的主人處理`,
      );
    }
    this.#step("fetch", "done", `${short(from)} → ${short(job.target)} 可以快轉`);

    // wait: nothing changes while she is busy.
    await this.#waitIdle(job, deadline, signal, "wait");

    // merge: the last moment anyone could have changed the tree or HEAD.
    this.#step("merge", "running");
    const head = await headOf(this.#git);
    const changes = await trackedChanges(this.#git);
    if (head !== from) {
      throw new Refused(`等待的時候 HEAD 變了(${head === null ? "讀不到" : short(head)}),不會動它`);
    }
    if (changes === null || changes.length > 0) {
      throw new Refused("等待的時候這台多了還沒提交的變更,不會動它");
    }
    this.#touched = true;
    const merged = await git(this.#git, ["merge", "--ff-only", "--no-edit", job.target], {
      timeoutMs: 120_000,
    });
    const after = await headOf(this.#git);
    if (merged.code !== 0 || after !== job.target) {
      // `--ff-only` either moved HEAD to the commit or left everything as it was.
      if (after === from) {
        this.#touched = false;
        throw new Error(
          `git merge --ff-only 失敗,這台沒有變動:${tail(merged.lines) || "沒有輸出"}`,
        );
      }
      await this.#rollback(job, from, { pnpm: false, synced: [], stopped: [] });
      throw new Failed(`git merge 之後 HEAD 不是要求的提交:${tail(merged.lines)}`);
    }
    const files = (await changedFiles(this.#git, from, job.target)) ?? null;
    this.#step(
      "merge",
      "done",
      files === null
        ? `已快轉到 ${short(job.target)}`
        : `已快轉到 ${short(job.target)},${files.length} 個檔案`,
    );

    const host = this.#o.host;
    const before = host.services();
    const stopped: string[] = [];
    const synced: string[] = [];
    let pnpm = false;
    try {
      // install
      const all = files ?? [];
      const entriesBefore = before.flatMap((s) => (s.entry === null ? [] : [s.entry]));
      const changedBefore = servicesChangedBy(all, entriesBefore, this.#o.root, { nodeWide: true });
      if (files === null || needsPnpmInstall(all)) {
        await this.#waitIdle(job, deadline, signal, "install");
        this.#step("install", "running", "pnpm install --frozen-lockfile");
        for (const s of before) {
          if (!s.running || s.entry?.descriptor.install.runtime !== "node") continue;
          if (files !== null && !changedBefore.has(s.name)) continue;
          await host.stop(s.name);
          stopped.push(s.name);
        }
        pnpm = true;
        const out = await this.#pnpmInstall();
        if (!out.ok) throw new Failed(`pnpm install 失敗:${out.detail}`);
        this.#step("install", "done");
      } else {
        this.#step("install", "skipped", "套件沒有變");
      }

      // sync
      host.reload();
      const stale = host.staleEnvs();
      if (stale.length === 0) {
        this.#step("sync", "skipped", "Python 環境都和 uv.lock 一致");
      } else {
        this.#step("sync", "running", stale.join("、"));
        for (const name of stale) {
          const s = host.services().find((x) => x.name === name);
          if (s?.running && !stopped.includes(name)) {
            await host.stop(name);
            stopped.push(name);
          }
          const r = await host.sync(name, signal, () => {});
          if (!r.ok) throw new Failed(`${name} 的環境同步失敗:${r.detail ?? "沒有說明"}`);
          synced.push(name);
        }
        this.#step("sync", "done", synced.join("、"));
      }
    } catch (error) {
      await this.#rollback(job, from, { pnpm, synced, stopped });
      throw error instanceof Failed ? error : new Failed(String((error as Error).message ?? error));
    }

    // restart: whatever was stopped comes back; the rest of what changed restarts when idle.
    const now = host.services();
    const entries = now.flatMap((s) => (s.entry === null ? [] : [s.entry]));
    const changed = servicesChangedBy(files ?? [], entries, this.#o.root, { nodeWide: true });
    const toRestart = now
      .filter((s) => s.running && !stopped.includes(s.name))
      .filter((s) => changed.has(s.name) || synced.includes(s.name) || files === null)
      .filter((s) => s.entry !== null && s.entry.descriptor.kind !== "external")
      .map((s) => s.name);
    this.#step("restart", "running", [...stopped, ...toRestart].join("、") || "沒有要重啟的");
    const started: string[] = [];
    const failedStarts: Array<{ service: string; reason: string }> = [];
    for (const name of stopped) {
      try {
        await host.start(name);
        started.push(name);
      } catch (error) {
        failedStarts.push({ service: name, reason: (error as Error).message ?? String(error) });
      }
    }
    const notRestarted: Array<{ service: string; reason: string }> = [];
    if (toRestart.length > 0) {
      let idle = true;
      try {
        await this.#waitIdle(job, deadline, signal, "restart");
      } catch (error) {
        if (error instanceof Cancelled) throw error;
        idle = false;
        for (const name of toRestart) {
          notRestarted.push({ service: name, reason: (error as Error).message });
        }
      }
      if (idle) {
        for (const name of toRestart) {
          try {
            await host.restart(name);
            started.push(name);
          } catch (error) {
            notRestarted.push({ service: name, reason: (error as Error).message ?? String(error) });
          }
        }
      }
    }
    this.#step("restart", "done", started.length === 0 ? "沒有重啟任何服務" : started.join("、"));

    // verify
    this.#step("verify", "running");
    const unhealthy =
      started.length === 0
        ? []
        : await host.healthy(started, this.#o.healthyMs ?? 10 * 60_000, signal);
    const failed = [...failedStarts, ...unhealthy];
    const missing = host.missing();
    const commit = await headOf(this.#git);
    job.commit = commit;
    job.restarted = started.filter((n) => !unhealthy.some((u) => u.service === n));
    if (notRestarted.length > 0) job.not_restarted = notRestarted;
    if (failed.length > 0) job.failed = failed;
    if (missing.length > 0) job.missing = missing;
    const notes = upgradeNotes(files ?? []);
    if (files === null) notes.push("讀不到這次改了哪些檔案,所以所有正在跑的服務都重啟了");
    if (notes.length > 0) job.notes = notes;
    this.#step(
      "verify",
      failed.length > 0 ? "failed" : "done",
      [
        failed.length > 0 ? `沒有起來:${failed.map((f) => f.service).join("、")}` : null,
        missing.length > 0 ? `缺 ${missing.length} 項模型或檔案` : null,
      ]
        .filter((x): x is string => x !== null)
        .join(";") || undefined,
    );
    job.state = failed.length > 0 || commit !== job.target ? "failed" : "done";
    if (commit !== job.target)
      job.error = `結束時 HEAD 是 ${commit === null ? "讀不到" : short(commit)}`;
    else if (failed.length > 0) job.error = `程式已更新到 ${short(job.target)},但有服務沒有起來`;
    job.finished_at = this.#now();
    this.#o.host.log.info(
      { target: job.target, from, restarted: job.restarted, failed: job.failed },
      "remote update finished",
    );
  }

  /** Waits until the host is idle, as `waiting`, until `deadline`. Throws when time runs out. */
  async #waitIdle(
    job: HostUpgradeJob,
    deadline: number,
    signal: AbortSignal,
    step: HostUpgradeStepName,
  ): Promise<void> {
    let first = true;
    for (;;) {
      this.#throwIfCancelled(signal);
      const reasons = await this.#o.host.busy(signal);
      if (reasons.length === 0) {
        if (!first || step === "wait") {
          if (job.state === "waiting") job.state = "running";
          delete job.waiting_for;
          if (step === "wait")
            this.#step("wait", first ? "skipped" : "done", first ? "沒有在忙" : undefined);
          else this.#o.host.changed();
        }
        return;
      }
      const words = reasons.join("、");
      if (this.#now() >= deadline) {
        delete job.waiting_for;
        if (job.state === "waiting") job.state = "running";
        const message = `等了太久還在忙(${words})`;
        if (step === "wait") throw new Refused(`${message},沒有更新`);
        throw new Error(message);
      }
      if (first || job.waiting_for !== words) {
        job.state = "waiting";
        job.waiting_for = words;
        if (step === "wait") this.#step("wait", "running", words);
        else this.#o.host.changed();
      }
      first = false;
      await sleep(Math.min(this.#o.pollMs ?? 5000, Math.max(0, deadline - this.#now())), signal);
    }
  }

  #throwIfCancelled(signal: AbortSignal): void {
    if (signal.aborted) throw new Cancelled("已取消");
  }

  async #pnpmInstall(): Promise<{ ok: boolean; detail: string }> {
    const lines: string[] = [];
    const out = await this.#o.runner(
      {
        file: this.#o.pnpm ?? "pnpm",
        args: ["install", "--frozen-lockfile"],
        cwd: this.#o.root,
        env: gitEnv(this.#o.env ?? process.env),
      },
      { signal: AbortSignal.timeout(INSTALL_MS), onLine: (l) => lines.push(l) },
    );
    if (out.missing) return { ok: false, detail: "找不到 pnpm" };
    return { ok: out.code === 0, detail: tail(lines) || `exit ${out.code}` };
  }

  /** Back to `from`, as far as it goes. Records the step; never throws. */
  async #rollback(
    job: HostUpgradeJob,
    from: string,
    done: { pnpm: boolean; synced: readonly string[]; stopped: readonly string[] },
  ): Promise<void> {
    const host = this.#o.host;
    this.#step("rollback", "running", `回到 ${short(from)}`);
    const problems: string[] = [];
    const head = await headOf(this.#git);
    if (head === job.target) {
      const reset = await git(this.#git, ["reset", "--keep", from], { timeoutMs: 120_000 });
      if (reset.code !== 0) problems.push(`git reset --keep 失敗:${tail(reset.lines)}`);
    } else if (head !== from) {
      problems.push(
        `HEAD 是 ${head === null ? "讀不到" : short(head)},不是這次更新移過去的,沒有動它`,
      );
    }
    const back = await headOf(this.#git);
    if (back === from) {
      this.#touched = false;
      if (done.pnpm) {
        const out = await this.#pnpmInstall();
        if (!out.ok) problems.push(`舊版的 pnpm install 失敗:${out.detail}`);
      }
      host.reload();
      for (const name of done.synced) {
        const r = await host.sync(name, AbortSignal.timeout(INSTALL_MS), () => {});
        if (!r.ok) problems.push(`${name} 的環境沒能同步回舊版:${r.detail ?? ""}`);
      }
    }
    for (const name of done.stopped) {
      try {
        await host.start(name);
      } catch (error) {
        problems.push(`${name} 沒能重新啟動:${(error as Error).message}`);
      }
    }
    job.rolled_back = back === from;
    job.commit = back;
    this.#step(
      "rollback",
      problems.length === 0 && back === from ? "done" : "failed",
      problems.length === 0 ? `已回到 ${short(from)}` : problems.join(";"),
    );
    host.log.warn({ from, target: job.target, problems }, "remote update rolled back");
  }

  // ---- bookkeeping -------------------------------------------------------------------------

  #step(
    step: HostUpgradeStepName,
    state: "running" | "done" | "failed" | "skipped",
    detail?: string,
  ) {
    const job = this.#job;
    if (job === null) return;
    const at = this.#now();
    const last = job.steps.at(-1);
    const entry = { step, state, at, ...(detail !== undefined ? { detail } : {}) };
    if (last !== undefined && last.step === step && last.state === "running") {
      job.steps[job.steps.length - 1] = entry;
    } else {
      job.steps.push(entry);
    }
    job.step = step;
    this.#o.host.changed();
  }

  /** Ends the job with an error. */
  #end(error: unknown): void {
    const job = this.#job;
    if (job === null) return;
    const message = error instanceof Error ? error.message : String(error);
    const last = job.steps.at(-1);
    if (last !== undefined && last.state === "running") {
      job.steps[job.steps.length - 1] = {
        ...last,
        state: "failed",
        detail: message,
        at: this.#now(),
      };
    }
    job.state =
      error instanceof Cancelled ? "cancelled" : error instanceof Refused ? "refused" : "failed";
    job.error = error instanceof Cancelled ? "已取消,這台沒有變動" : message;
    delete job.waiting_for;
    job.finished_at = this.#now();
    this.#o.host.log.warn(
      { target: job.target, state: job.state, error: message },
      "remote update ended",
    );
    this.#o.host.changed();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
