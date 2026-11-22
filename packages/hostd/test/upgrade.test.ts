// The remote update's sequence (docs/design/v5-hostd.md §14) against a pretend repository and a
// pretend daemon: what it refuses, what it waits for, the order it changes things in, and how it
// goes back. No git, no pnpm, no process.

import type { HostUpgradeJob } from "@miyoria/contracts/host";
import { describe, expect, it } from "vitest";
import {
  type CatalogEntry,
  HostRpcError,
  readCheckout,
  servicesChangedBy,
  type UpgradeHost,
  Upgrader,
  upgradeNotes,
} from "../src/index.js";
import { checkoutRoot, type FakeRepo, fakeRepo, repoRunner, sha } from "./upgrade-fakes.js";

const ROOT_SERVICES = ["py", "node", "idle"] as const;

function entry(name: string, runtime: "python" | "node" | "none", root: string): CatalogEntry {
  const folder = runtime === "node" ? `apps/${name}` : `workers/${name}`;
  return {
    name,
    dir: `${root}/${folder}`,
    file: `${root}/${folder}/service.toml`,
    descriptor: { name, kind: "worker", install: { runtime } },
  } as unknown as CatalogEntry;
}

interface FakeHost extends UpgradeHost {
  calls: string[];
  running: Set<string>;
  busyAnswers: string[][];
  stale: string[];
  syncFails: Set<string>;
  unhealthy: Set<string>;
  reports: number;
}

function fakeHost(root: string, over: Partial<Pick<FakeHost, "stale">> = {}): FakeHost {
  const entries = new Map<string, CatalogEntry>([
    ["py", entry("py", "python", root)],
    ["node", entry("node", "node", root)],
    ["idle", entry("idle", "none", root)],
  ]);
  const host: FakeHost = {
    calls: [],
    running: new Set(["py", "node"]),
    busyAnswers: [],
    stale: over.stale ?? [],
    syncFails: new Set(),
    unhealthy: new Set(),
    reports: 0,
    services: () =>
      ROOT_SERVICES.map((name) => ({
        name,
        entry: entries.get(name) ?? null,
        running: host.running.has(name),
      })),
    busy: async () => host.busyAnswers.shift() ?? [],
    reload: () => host.calls.push("reload"),
    staleEnvs: () => [...host.stale],
    sync: async (name) => {
      host.calls.push(`sync ${name}`);
      return host.syncFails.has(name) ? { ok: false, detail: "uv failed" } : { ok: true };
    },
    stop: async (name) => {
      host.calls.push(`stop ${name}`);
      host.running.delete(name);
    },
    start: async (name) => {
      host.calls.push(`start ${name}`);
      host.running.add(name);
    },
    restart: async (name) => {
      host.calls.push(`restart ${name}`);
    },
    healthy: async (names) =>
      names.filter((n) => host.unhealthy.has(n)).map((service) => ({ service, reason: "exited" })),
    missing: () => [{ service: "py", kind: "file", what: "models/x.onnx" }],
    changed: () => {
      host.reports += 1;
    },
    log: { info: () => {}, warn: () => {} },
  };
  return host;
}

function setup(repoOver: Partial<FakeRepo> = {}, hostOver: Partial<Pick<FakeHost, "stale">> = {}) {
  const root = checkoutRoot();
  const repo = fakeRepo(repoOver);
  const host = fakeHost(root, hostOver);
  const upgrader = new Upgrader({
    root,
    runner: repoRunner(repo, root),
    host,
    pollMs: 5,
    newId: () => "job-1",
  });
  return { root, repo, host, upgrader };
}

async function finished(upgrader: Upgrader): Promise<HostUpgradeJob> {
  await upgrader.settled();
  return upgrader.job as HostUpgradeJob;
}

const TARGET = sha(4);

describe("the checkout", () => {
  it("is read from the local repository: branch, upstream, counts, a clean tree", async () => {
    const root = checkoutRoot();
    const repo = fakeRepo({ head: sha(2), upstream: sha(3) });
    const checkout = await readCheckout({ root, runner: repoRunner(repo, root), now: () => 7 });
    expect(checkout).toMatchObject({
      commit: sha(2),
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 1,
      dirty: false,
      read_at: 7,
    });
    expect(repo.calls).toEqual([]);
  });

  it("is not read where there is no .git: nothing runs", async () => {
    let ran = 0;
    const checkout = await readCheckout({
      root: "/nowhere/at/all",
      runner: async () => {
        ran += 1;
        return { code: 0, missing: false, tail: [] };
      },
      now: () => 0,
    });
    expect(checkout).toBeNull();
    expect(ran).toBe(0);
  });
});

describe("refusals before anything changes", () => {
  it.each([
    ["a changed tracked file", { dirty: [" M packages/x.ts"] }, "還沒提交的變更"],
    ["a detached HEAD", { branch: null }, "detached"],
    ["no upstream", { remote: null }, "沒有追蹤遠端"],
  ])("%s", async (_what, over, words) => {
    const { repo, upgrader } = setup(over);
    const error = await upgrader.begin({ commit: TARGET }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRpcError);
    expect((error as Error).message).toContain(words);
    expect(upgrader.job).toMatchObject({ state: "refused", target: TARGET });
    expect(repo.calls).toEqual([]);
    expect(upgrader.busy).toBe(false);
  });

  it("is done at once when HEAD already is the commit", async () => {
    const { repo, upgrader } = setup({ head: TARGET, upstream: TARGET });
    const job = await upgrader.begin({ commit: TARGET });
    expect(job).toMatchObject({ state: "done", commit: TARGET });
    expect(repo.calls).toEqual([]);
  });

  it("refuses a commit the remote does not have, after fetching", async () => {
    const { repo, host, upgrader } = setup();
    await upgrader.begin({ commit: sha(99) });
    const job = await finished(upgrader);
    expect(job.state).toBe("refused");
    expect(job.error).toContain("找不到提交");
    expect(repo.calls).toEqual(["git fetch --no-tags origin"]);
    expect(host.calls).toEqual([]);
  });

  it("refuses a commit on another line, and an older one", async () => {
    const side = setup();
    await side.upgrader.begin({ commit: side.repo.side });
    expect((await finished(side.upgrader)).error).toContain("不在這台追蹤的 origin/main 上");

    const older = setup({ head: sha(3), upstream: sha(3) });
    await older.upgrader.begin({ commit: sha(1) });
    expect((await finished(older.upgrader)).error).toContain("比要求的版本");
    expect(older.repo.calls.filter((c) => c.startsWith("git merge"))).toEqual([]);
  });

  it("says why a fetch failed and changes nothing", async () => {
    const { repo, upgrader } = setup({ fetchFails: true });
    await upgrader.begin({ commit: TARGET });
    const job = await finished(upgrader);
    expect(job.state).toBe("failed");
    expect(job.error).toContain("git fetch 失敗");
    expect(repo.head).toBe(sha(2));
  });

  it("allows one update at a time", async () => {
    const { host, upgrader } = setup();
    host.busyAnswers = [["sing 正在處理工作"], ["sing 正在處理工作"]];
    await upgrader.begin({ commit: TARGET });
    await expect(upgrader.begin({ commit: TARGET })).rejects.toThrow("已經在更新");
    await upgrader.settled();
  });
});

describe("waiting for her", () => {
  it("waits, visibly, while a job runs, then goes on", async () => {
    const { host, upgrader } = setup();
    host.busyAnswers = [["sing 正在處理工作"], ["sing 正在處理工作"]];
    const seen: string[] = [];
    const changed = host.changed;
    host.changed = () => {
      changed();
      const job = upgrader.job;
      if (job?.state === "waiting" && job.waiting_for) seen.push(job.waiting_for);
    };
    await upgrader.begin({ commit: TARGET });
    const job = await finished(upgrader);
    expect(seen).toContain("sing 正在處理工作");
    expect(job.state).toBe("done");
    expect(job.steps.find((s) => s.step === "wait")).toMatchObject({ state: "done" });
  });

  it("gives up after wait_s without changing anything", async () => {
    const { repo, host, upgrader } = setup();
    host.busy = async () => ["她正在直播"];
    await upgrader.begin({ commit: TARGET, wait_s: 0 });
    const job = await finished(upgrader);
    expect(job.state).toBe("refused");
    expect(job.error).toContain("等了太久還在忙(她正在直播)");
    expect(repo.head).toBe(sha(2));
    expect(repo.calls.some((c) => c.startsWith("git merge"))).toBe(false);
  });

  it("can be cancelled while it waits", async () => {
    const { repo, host, upgrader } = setup();
    host.busy = async () => ["她正在唱歌"];
    await upgrader.begin({ commit: TARGET });
    while (upgrader.job?.state !== "waiting") await new Promise((r) => setTimeout(r, 2));
    expect(upgrader.cancel()).toBe(true);
    const job = await finished(upgrader);
    expect(job.state).toBe("cancelled");
    expect(repo.head).toBe(sha(2));
  });

  it("refuses when HEAD moved while it waited", async () => {
    const { repo, host, upgrader } = setup();
    let first = true;
    host.busy = async () => {
      if (first) {
        first = false;
        repo.head = sha(3);
        return ["sing 正在處理工作"];
      }
      return [];
    };
    await upgrader.begin({ commit: TARGET });
    const job = await finished(upgrader);
    expect(job.state).toBe("refused");
    expect(job.error).toContain("HEAD 變了");
    expect(repo.calls.some((c) => c.startsWith("git merge"))).toBe(false);
  });
});

describe("the update", () => {
  it("fast-forwards, installs, syncs and restarts in that order", async () => {
    const { repo, host, upgrader } = setup(
      {
        files: [
          "pnpm-lock.yaml",
          "apps/node/src/a.ts",
          "workers/py/uv.lock",
          "packages/hostd/src/x.ts",
        ],
      },
      { stale: ["py"] },
    );
    await upgrader.begin({ commit: TARGET, by: "owner" });
    const job = await finished(upgrader);
    expect(job).toMatchObject({ state: "done", from: sha(2), commit: TARGET, by: "owner" });
    expect(repo.calls).toEqual([
      "git fetch --no-tags origin",
      `git merge --ff-only --no-edit ${TARGET}`,
      "pnpm install --frozen-lockfile",
    ]);
    // Node stopped before pnpm, py stopped before its sync; both started again after.
    expect(host.calls).toEqual([
      "stop node",
      "reload",
      "stop py",
      "sync py",
      "start node",
      "start py",
    ]);
    expect(job.restarted).toEqual(["node", "py"]);
    expect(job.missing).toEqual([{ service: "py", kind: "file", what: "models/x.onnx" }]);
    expect(job.notes?.some((n) => n.includes("hostd 本身"))).toBe(true);
    expect(job.steps.map((s) => `${s.step}:${s.state}`)).toEqual([
      "check:done",
      "fetch:done",
      "wait:skipped",
      "merge:done",
      "install:done",
      "sync:done",
      "restart:done",
      "verify:done",
    ]);
  });

  it("restarts only what changed, and nothing it did not stop when no package changed", async () => {
    const { repo, host, upgrader } = setup({ files: ["workers/py/server.py"] });
    await upgrader.begin({ commit: TARGET });
    const job = await finished(upgrader);
    expect(job.state).toBe("done");
    expect(repo.calls.some((c) => c.startsWith("pnpm"))).toBe(false);
    expect(host.calls).toEqual(["reload", "restart py"]);
    expect(job.steps.find((s) => s.step === "install")?.state).toBe("skipped");
  });

  it("leaves a changed service running when she got busy again, and says so", async () => {
    const { host, upgrader } = setup({ files: ["workers/py/server.py"] });
    let calls = 0;
    host.busy = async () => (++calls >= 2 ? ["她正在唱歌"] : []);
    await upgrader.begin({ commit: TARGET, wait_s: 0 });
    const job = await finished(upgrader);
    expect(job.commit).toBe(TARGET);
    expect(job.not_restarted?.[0]).toMatchObject({ service: "py" });
    expect(host.calls).not.toContain("restart py");
  });

  it("reports a service that does not come back", async () => {
    const { host, upgrader } = setup({ files: ["workers/py/server.py"] });
    host.unhealthy.add("py");
    await upgrader.begin({ commit: TARGET });
    const job = await finished(upgrader);
    expect(job.state).toBe("failed");
    expect(job.failed).toEqual([{ service: "py", reason: "exited" }]);
    expect(job.commit).toBe(TARGET);
    expect(job.rolled_back).toBeUndefined();
  });
});

describe("going back", () => {
  it("goes back to the commit before when pnpm install fails", async () => {
    const { repo, host, upgrader } = setup({ files: ["pnpm-lock.yaml"], pnpmFails: 1 });
    await upgrader.begin({ commit: TARGET });
    const job = await finished(upgrader);
    expect(job).toMatchObject({ state: "failed", rolled_back: true, commit: sha(2) });
    expect(job.error).toContain("pnpm install 失敗");
    expect(repo.head).toBe(sha(2));
    expect(repo.calls).toEqual([
      "git fetch --no-tags origin",
      `git merge --ff-only --no-edit ${TARGET}`,
      "pnpm install --frozen-lockfile",
      `git reset --keep ${sha(2)}`,
      "pnpm install --frozen-lockfile",
    ]);
    // The Node service stopped for the install is running again.
    expect(host.running.has("node")).toBe(true);
    expect(job.steps.find((s) => s.step === "rollback")?.state).toBe("done");
  });

  it("goes back when a sync fails, and syncs the old environment again", async () => {
    const { repo, host, upgrader } = setup({ files: ["workers/py/uv.lock"] }, { stale: ["py"] });
    host.syncFails.add("py");
    await upgrader.begin({ commit: TARGET });
    const job = await finished(upgrader);
    expect(job).toMatchObject({ state: "failed", rolled_back: true });
    expect(repo.head).toBe(sha(2));
    expect(host.running.has("py")).toBe(true);
  });
});

describe("what a change set means", () => {
  const root = "/r";
  const entries = [
    entry("py", "python", root),
    entry("node", "node", root),
    entry("idle", "none", root),
  ];

  it("finds the services a change touches; Node ones by the whole tree only when asked", () => {
    expect([...servicesChangedBy(["workers/common.py"], entries, root)]).toEqual(["py"]);
    expect([...servicesChangedBy(["packages/voice/a.ts"], entries, root)]).toEqual([]);
    expect([
      ...servicesChangedBy(["packages/voice/a.ts"], entries, root, { nodeWide: true }),
    ]).toEqual(["node"]);
  });

  it("notes hostd's own code and what only miyoria update builds", () => {
    expect(upgradeNotes(["workers/a.py"])).toEqual([]);
    expect(upgradeNotes(["packages/contracts/x.ts", "apps/panel/src/a.tsx"])).toHaveLength(2);
  });
});
