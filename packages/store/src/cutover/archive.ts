// `miyoria db archive`: steps 2 to 4 of the cut-over (docs/design/v5-data.md §7) for a stopped V4.
//
// - It refuses a file that is not V4, and refuses while anything holds the database open
//   (`heldFiles`).
// - It renames `miyoria.db`, `-wal` and `-shm` together to `archive/miyoria-v4-<date>.db{,-wal,
//   -shm}`. SQLite finds the WAL by name, so the writes still in it stay with the file.
// - It makes a single-file copy, `miyoria-v4-<date>.single.db`, with `VACUUM INTO` over a
//   read-only connection, and checks it (`integrity_check`).
// - It appends the sha256 of the archived file, its WAL and the copy to `archive/MANIFEST.txt`, in
//   `sha256sum` format.
// It deletes nothing of the database.
//
// Re-running after a failure at any point is safe. Before it moves anything it writes a plan,
// `miyoria-v4-<date>.plan.json`, with each file's size and hash; a later run finds the plan,
// checks that every file is where the plan expects and unchanged (a file in both places, missing
// from both, or changed is refused, and nothing moves), and does what is left. A rename that fails
// puts back the ones it already did, so the data folder is whole again. The copy is written to
// `.single.db.partial` and renamed when it is complete: a leftover `.partial` is its own unfinished
// output and is replaced. The `-shm` file is only an index of the WAL that SQLite rebuilds, and
// opening the archive to copy it may rewrite it, so it is moved but not hashed.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { type Clock, systemClock, toTimestamp } from "@miyoria/types";
import { CutoverError, fileFacts, openReadOnly, tablesOf } from "./old-file.js";

/** The database file and the side files SQLite keeps next to it. */
const SUFFIXES = ["", "-wal", "-shm"] as const;
type Suffix = (typeof SUFFIXES)[number];

/**
 * The order they are moved in: the side files first, so the data folder never holds a WAL without
 * its database (SQLite would apply it to whatever new file got that name).
 */
const MOVE_ORDER: readonly Suffix[] = ["-wal", "-shm", ""];

/** Not hashed: an index SQLite rebuilds, which reading the archive may rewrite. */
const UNHASHED: ReadonlySet<Suffix> = new Set(["-shm"]);

export const MANIFEST_FILE = "MANIFEST.txt";

interface PlannedFile {
  suffix: Suffix;
  size: number;
  /** `null` for the `-shm`. */
  sha256: string | null;
}

interface ArchivePlan {
  format: 1;
  /** The database as it was named before (absolute). */
  source: string;
  date: string;
  created_at: string;
  files: PlannedFile[];
  single_sha256: string | null;
  done: boolean;
}

/** One file of the archive. */
export interface ArchivedFile {
  /** Where it was. */
  from: string;
  /** Where it is (or goes, in a dry run). */
  to: string;
  size: number;
  sha256: string | null;
  /** Already in the archive before this run. */
  moved: boolean;
}

export interface ArchiveResult {
  dry_run: boolean;
  /**
   * `archived`: this run finished it. `already`: an earlier run did, nothing was left to do.
   * `planned`: a dry run, nothing changed.
   */
  state: "archived" | "already" | "planned";
  /** It continued a run that had stopped part way. */
  resumed: boolean;
  date: string;
  /** The archive folder. */
  dir: string;
  files: ArchivedFile[];
  /** The single-file copy, and its hash once made. */
  single: { path: string; sha256: string | null };
  manifest: string;
  /** What it noticed on the way, in English (the CLI words its own lines). */
  notes: string[];
}

export interface ArchiveOptions {
  /** The V4 database, `data/miyoria.db`. */
  path: string;
  /** Default: `archive` next to the database. */
  dir?: string;
  /** Names the archive by its local date. */
  clock?: Clock;
  /** Check and say what it would do; change nothing. */
  dryRun?: boolean;
  /** Which of these files another process holds open. Default `heldFiles`. */
  held?: (files: readonly string[]) => string[];
  /** Called before each step (`rename-wal`, `rename-shm`, `rename-db`, `copy`, `manifest`). */
  onStep?: (step: string) => void;
}

// ---- who holds a file ---------------------------------------------------------------------------

/**
 * The files of `files` that a process has open.
 * - Windows: SQLite opens its files without `FILE_SHARE_DELETE`, so renaming one onto its own name
 *   fails (EBUSY) while any connection, or another program that does the same, holds it. Nothing
 *   moves.
 * - Linux: the `/proc/<pid>/fd` links of every process this user may read.
 * - elsewhere: `lsof`; without it the check cannot be made and it refuses.
 */
export function heldFiles(files: readonly string[], platform = process.platform): string[] {
  const present = files.filter((f) => existsSync(f));
  if (present.length === 0) return [];
  if (platform === "win32") {
    return present.filter((f) => {
      try {
        renameSync(f, f);
        return false;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return false;
        if (code === "EBUSY" || code === "EPERM" || code === "EACCES") return true;
        throw error;
      }
    });
  }
  if (platform === "linux" && existsSync("/proc/self/fd")) {
    const wanted = new Map(present.map((f) => [realpathSync(f), f] as const));
    const found = new Set<string>();
    for (const pid of readdirSync("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      let fds: string[];
      try {
        fds = readdirSync(`/proc/${pid}/fd`);
      } catch {
        continue;
      }
      for (const fd of fds) {
        try {
          const file = wanted.get(readlinkSync(`/proc/${pid}/fd/${fd}`));
          if (file !== undefined) found.add(file);
        } catch {
          // gone, or not ours to read
        }
      }
    }
    return present.filter((f) => found.has(f));
  }
  let out: string;
  try {
    out = execFileSync("lsof", ["-F", "n", "--", ...present], { encoding: "utf8" });
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { status?: number; stdout?: string };
    if (e.code === "ENOENT") {
      throw new CutoverError("held", "cannot tell whether the database is open: `lsof` is missing");
    }
    // lsof exits 1 when no process has any of them open.
    out = e.status === 1 ? (e.stdout ?? "") : "";
    if (e.status !== 1) throw error;
  }
  const names = new Set(
    out
      .split("\n")
      .filter((l) => l.startsWith("n"))
      .map((l) => l.slice(1)),
  );
  return present.filter((f) => names.has(f) || names.has(resolve(f)));
}

// ---- helpers --------------------------------------------------------------------------------

/** `YYYY-MM-DD` in local time: the archive is named for the day a person did it. */
export function archiveDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The names of one archive. */
class Names {
  readonly source: string;
  readonly dir: string;
  readonly base: string;

  constructor(source: string, dir: string, date: string) {
    this.source = source;
    this.dir = dir;
    this.base = `${basename(source).replace(/\.db$/i, "")}-v4-${date}`;
  }

  from(suffix: Suffix): string {
    return `${this.source}${suffix}`;
  }

  to(suffix: Suffix): string {
    return join(this.dir, `${this.base}.db${suffix}`);
  }

  get single(): string {
    return join(this.dir, `${this.base}.single.db`);
  }

  get partial(): string {
    return `${this.single}.partial`;
  }

  get plan(): string {
    return join(this.dir, `${this.base}.plan.json`);
  }

  get manifest(): string {
    return join(this.dir, MANIFEST_FILE);
  }
}

function savePlan(names: Names, plan: ArchivePlan): void {
  const tmp = `${names.plan}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(plan, null, 2)}\n`);
  renameSync(tmp, names.plan);
}

/** The plans in `dir` for the database `source`, oldest first. */
function plansFor(dir: string, source: string): ArchivePlan[] {
  if (!existsSync(dir)) return [];
  const prefix = `${basename(source).replace(/\.db$/i, "")}-v4-`;
  const plans: ArchivePlan[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.startsWith(prefix) || !name.endsWith(".plan.json")) continue;
    try {
      const plan = JSON.parse(readFileSync(join(dir, name), "utf8")) as ArchivePlan;
      if (plan.format === 1 && resolve(plan.source) === source) plans.push(plan);
    } catch (cause) {
      throw new CutoverError("archive_state", `${join(dir, name)} is not readable`, { cause });
    }
  }
  return plans;
}

function filesOf(names: Names, plan: ArchivePlan, moved: (s: Suffix) => boolean): ArchivedFile[] {
  return plan.files.map((f) => ({
    from: names.from(f.suffix),
    to: names.to(f.suffix),
    size: f.size,
    sha256: f.sha256,
    moved: moved(f.suffix),
  }));
}

async function makePlan(names: Names, date: string, now: number): Promise<ArchivePlan> {
  const files: PlannedFile[] = [];
  for (const suffix of SUFFIXES) {
    const path = names.from(suffix);
    if (!existsSync(path)) continue;
    files.push({
      suffix,
      size: fileFacts(path).size,
      sha256: UNHASHED.has(suffix) ? null : await sha256(path),
    });
  }
  return {
    format: 1,
    source: names.source,
    date,
    created_at: toTimestamp(now),
    files,
    single_sha256: null,
    done: false,
  };
}

function refuseHeld(held: (files: readonly string[]) => string[], files: readonly string[]): void {
  const open = held(files);
  if (open.length > 0) {
    throw new CutoverError(
      "held",
      `still open: ${open.join(", ")}. Stop Core (and anything else using the database) first`,
    );
  }
}

// ---- the archive --------------------------------------------------------------------------------

/** Archives the V4 database (see the file comment). Throws a `CutoverError` when it refuses. */
export async function archiveDatabase(options: ArchiveOptions): Promise<ArchiveResult> {
  const source = resolve(options.path);
  const dir = resolve(options.dir ?? join(dirname(source), "archive"));
  const clock = options.clock ?? systemClock;
  const held = options.held ?? ((files: readonly string[]) => heldFiles(files));
  const step = options.onStep ?? (() => undefined);
  const dryRun = options.dryRun === true;
  const notes: string[] = [];

  const plans = plansFor(dir, source);
  let plan = plans.filter((p) => !p.done).at(-1) ?? null;
  let names: Names;
  let resumed = false;
  /** An earlier plan that moved nothing, replaced by a new one. */
  let stale: string | null = null;

  if (plan !== null) {
    names = new Names(source, dir, plan.date);
    const current = plan;
    const where = new Map<Suffix, "data" | "archive">();
    for (const f of current.files) {
      const inData = existsSync(names.from(f.suffix));
      const inArchive = existsSync(names.to(f.suffix));
      if (inData && inArchive) {
        throw new CutoverError(
          "archive_state",
          `${names.from(f.suffix)} and ${names.to(f.suffix)} both exist: something wrote a new ` +
            "database after the archive began. Nothing was moved; sort it out by hand",
        );
      }
      if (!inData && !inArchive) {
        throw new CutoverError(
          "archive_state",
          `${basename(names.from(f.suffix))} is neither in ${dirname(source)} nor in ${dir}`,
        );
      }
      where.set(f.suffix, inData ? "data" : "archive");
    }
    const nothingMoved = [...where.values()].every((w) => w === "data");
    const extra = SUFFIXES.filter(
      (s) => existsSync(names.from(s)) && !current.files.some((f) => f.suffix === s),
    );
    let changed = extra.length > 0;
    for (const f of current.files) {
      if (f.sha256 === null) continue;
      const path = where.get(f.suffix) === "data" ? names.from(f.suffix) : names.to(f.suffix);
      if ((await sha256(path)) !== f.sha256) {
        if (where.get(f.suffix) === "archive" || !nothingMoved) {
          throw new CutoverError(
            "archive_state",
            `${path} changed after the archive began (its hash is not the one in ${names.plan}). ` +
              "Nothing was moved",
          );
        }
        changed = true;
      }
    }
    if (changed && !nothingMoved) {
      throw new CutoverError(
        "archive_state",
        `${dirname(source)} has files the archive plan does not know: ${extra.join(", ")}`,
      );
    }
    if (changed) {
      // Nothing moved yet and the database changed (V4 ran again): plan again from what is there.
      notes.push("the database changed since an earlier plan that moved nothing; planned again");
      stale = names.plan;
      plan = null;
    } else {
      resumed = true;
    }
  }

  if (plan === null) {
    const facts = fileFacts(source);
    if (!facts.exists) {
      const finished = plans.filter((p) => p.done).at(-1);
      if (finished !== undefined) {
        const done = new Names(source, dir, finished.date);
        return {
          dry_run: dryRun,
          state: "already",
          resumed: false,
          date: finished.date,
          dir,
          files: filesOf(done, finished, () => true),
          single: { path: done.single, sha256: finished.single_sha256 },
          manifest: done.manifest,
          notes,
        };
      }
      throw new CutoverError("missing", `${source} does not exist`);
    }
    if (facts.walMode === null) {
      throw new CutoverError("not_database", `${source} is not a SQLite database`);
    }
    // Only a V4 file is archived: `core.database_url` may already name the new database.
    const ro = openReadOnly(source);
    let v4: boolean;
    try {
      v4 = tablesOf(ro.db).has("schema_version");
    } finally {
      ro.close();
    }
    if (!v4) throw new CutoverError("not_v4", `${source} is not a V4 database`);
    const date = archiveDate(clock.now());
    names = new Names(source, dir, date);
    const clash = [...SUFFIXES.map((s) => names.to(s)), names.single, names.plan].filter(
      (p) => p !== stale && existsSync(p),
    );
    if (clash.length > 0) {
      throw new CutoverError(
        "archive_state",
        `${clash.join(", ")} already exist${clash.length === 1 ? "s" : ""}: an archive of ` +
          `${date} is there. Nothing was moved`,
      );
    }
    refuseHeld(
      held,
      SUFFIXES.map((s) => names.from(s)),
    );
    plan = await makePlan(names, date, clock.now());
    if (!dryRun) {
      mkdirSync(dir, { recursive: true });
      // The plan is the archive's own bookkeeping: one that moved nothing is simply replaced.
      if (stale !== null) rmSync(stale, { force: true });
      savePlan(names, plan);
    }
  } else {
    names = new Names(source, dir, plan.date);
    refuseHeld(
      held,
      plan.files.map((f) => names.from(f.suffix)).filter((p) => existsSync(p)),
    );
  }

  const active = plan;
  const inArchive = (s: Suffix) => existsSync(names.to(s));
  if (dryRun) {
    return {
      dry_run: true,
      state: "planned",
      resumed,
      date: active.date,
      dir,
      files: filesOf(names, active, inArchive),
      single: { path: names.single, sha256: active.single_sha256 },
      manifest: names.manifest,
      notes,
    };
  }

  // 1. The renames, side files first; a failure puts back what this run moved.
  const moved: Suffix[] = [];
  const toMove = MOVE_ORDER.flatMap((s) => active.files.filter((f) => f.suffix === s));
  for (const f of toMove) {
    if (inArchive(f.suffix)) continue;
    step(`rename-${f.suffix === "" ? "db" : f.suffix.slice(1)}`);
    try {
      renameSync(names.from(f.suffix), names.to(f.suffix));
      moved.push(f.suffix);
    } catch (cause) {
      const undone: string[] = [];
      for (const s of moved.reverse()) {
        try {
          renameSync(names.to(s), names.from(s));
        } catch {
          undone.push(names.to(s));
        }
      }
      const code = (cause as NodeJS.ErrnoException).code;
      throw new CutoverError(
        code === "EBUSY" || code === "EPERM" || code === "EACCES" ? "held" : "archive_state",
        `cannot move ${names.from(f.suffix)}` +
          (undone.length > 0
            ? `; these stay in the archive, run again to finish: ${undone.join(", ")}`
            : "; everything was put back"),
        { cause },
      );
    }
  }

  // 2. The single-file copy.
  if (active.single_sha256 === null || !existsSync(names.single)) {
    step("copy");
    if (!existsSync(names.single)) {
      if (existsSync(names.partial)) {
        rmSync(names.partial, { force: true });
        notes.push("replaced an unfinished copy from an earlier run");
      }
      const ro = openReadOnly(names.to(""));
      try {
        ro.db.exec(`VACUUM INTO '${names.partial.replaceAll("'", "''")}'`);
      } finally {
        ro.close();
      }
      checkCopy(names.partial);
      renameSync(names.partial, names.single);
    } else {
      checkCopy(names.single);
    }
    active.single_sha256 = await sha256(names.single);
    savePlan(names, active);
  }

  // 3. The manifest.
  step("manifest");
  const lines = [
    ...active.files
      .filter((f) => f.sha256 !== null)
      .map((f) => `${f.sha256}  ${basename(names.to(f.suffix))}`),
    `${active.single_sha256}  ${basename(names.single)}`,
  ];
  const written = existsSync(names.manifest) ? readFileSync(names.manifest, "utf8") : "";
  const missing = lines.filter((l) => !written.split(/\r?\n/).includes(l));
  if (missing.length > 0) {
    const head = `# ${names.base}: ${source}, archived ${toTimestamp(clock.now())}\n`;
    appendFileSync(
      names.manifest,
      `${written === "" || written.endsWith("\n") ? "" : "\n"}${head}${missing.join("\n")}\n`,
    );
  }
  active.done = true;
  savePlan(names, active);

  return {
    dry_run: false,
    state: "archived",
    resumed,
    date: active.date,
    dir,
    files: filesOf(names, active, (s) => !moved.includes(s)),
    single: { path: names.single, sha256: active.single_sha256 },
    manifest: names.manifest,
    notes,
  };
}

/** Throws unless the copy at `path` is a sound database. */
function checkCopy(path: string): void {
  const ro = openReadOnly(path);
  try {
    const rows = ro.db.prepare("PRAGMA integrity_check").all();
    const result = rows.map((r) => String(r.integrity_check)).join("; ");
    if (result !== "ok") {
      throw new CutoverError("archive_state", `the single-file copy ${path} is damaged: ${result}`);
    }
  } finally {
    ro.close();
  }
}
