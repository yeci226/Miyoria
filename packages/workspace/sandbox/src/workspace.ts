// Host-side directories: one disposable workspace per run, one per session (kept between its
// runs), and the profile's persistent tools workspace. Everything the container wrote is treated as hostile: entries are lstat'ed, only
// regular files are read, symlinks are never followed, and walks are bounded.

import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getLogger } from "@miyoria/runtime/kernel";
import { isUlid } from "@miyoria/types";
import { ENTRY_FILE } from "./args.js";
import type { SandboxCaps } from "./config.js";
import { checkName, MAX_PATH_DEPTH, normalizeRelativePath, pathKey, safeJoin } from "./paths.js";
import {
  type FileIn,
  type FileOut,
  type Language,
  SandboxError,
  type ScriptInfo,
  type ToolsWorkspaceApi,
} from "./types.js";

const log = getLogger("sandbox.workspace");

/** Most directory entries an output walk of a run looks at. */
const MAX_WALK_ENTRIES = 2000;
/** Most directory entries a session's `/work` may hold (more counts as over its disk quota). */
export const MAX_SESSION_ENTRIES = 10_000;

export interface RunDirs {
  /** `<root>/runs/<run id>` */
  dir: string;
  /** Program, mounted read-only at `/code`. */
  codeDir: string;
  /** Workspace, mounted read-write at `/work`. */
  workDir: string;
}

export function runsDir(root: string): string {
  return join(root, "runs");
}

/** Creates the directories of one run. `work` is world-writable so a non-root uid can write. */
export async function createRunDirs(root: string, runId: string): Promise<RunDirs> {
  if (!isUlid(runId)) throw new SandboxError("invalid_request", `bad run id \`${runId}\``);
  const dir = join(runsDir(root), runId);
  const codeDir = join(dir, "code");
  const workDir = join(dir, "work");
  await mkdir(codeDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await chmod(codeDir, 0o755);
  await chmod(workDir, 0o777);
  return { dir, codeDir, workDir };
}

/** `<root>/profiles/<profile>/sessions`: one `<container id>` directory per live session. */
export function sessionsDir(root: string, profile: string): string {
  return join(root, "profiles", profile, "sessions");
}

/** Creates the directories of one session (same layout and modes as a run's). */
export async function createSessionDirs(base: string, id: string): Promise<RunDirs> {
  if (!isUlid(id)) throw new SandboxError("invalid_request", `bad session id \`${id}\``);
  const dir = join(base, id);
  const codeDir = join(dir, "code");
  const workDir = join(dir, "work");
  await mkdir(codeDir, { recursive: true });
  await mkdir(workDir, { recursive: true });
  await chmod(codeDir, 0o755);
  await chmod(workDir, 0o777);
  return { dir, codeDir, workDir };
}

/** Writes the program to `codeDir` (as `file`; default the language's `ENTRY_FILE`). */
export async function writeProgram(
  codeDir: string,
  language: Language,
  code: string,
  file: string = ENTRY_FILE[language],
): Promise<void> {
  await writeFile(join(codeDir, file), code, { flag: "wx", mode: 0o644 });
}

function decode(file: FileIn): Buffer {
  if (file.encoding === "base64") {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)) {
      throw new SandboxError("invalid_request", `file \`${file.path}\` is not valid base64`);
    }
    return Buffer.from(file.content, "base64");
  }
  return Buffer.from(file.content, "utf8");
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Makes way for an input in a session's `/work`, which earlier runs wrote: every existing parent
 * must be a real directory (not a link the program left to steer the host's write elsewhere), and
 * an existing file of that name is removed (a regular file only). Only call it while nothing runs
 * in the session's container.
 */
async function clearForInput(workDir: string, path: string): Promise<void> {
  const parts = path.split("/");
  let current = workDir;
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(current);
    } catch {
      return;
    }
    const last = i === parts.length - 1;
    if (!last && !stat.isDirectory()) {
      throw new SandboxError(
        "invalid_path",
        `input file \`${path}\`: \`${part}\` is not a directory`,
      );
    }
    if (last) {
      if (!stat.isFile()) {
        throw new SandboxError("invalid_path", `input file \`${path}\` exists and is not a file`);
      }
      await unlink(current);
    }
  }
}

/**
 * Checks the input files against the caps and path rules, then writes them under `workDir`
 * (never through an existing file: `wx`). `replace` (a session's `/work`) first removes files of
 * the same name an earlier run left. Returns the sha256 of each input by case-folded path, so
 * unchanged inputs are not returned as outputs.
 */
export async function writeInputs(
  workDir: string,
  files: readonly FileIn[],
  caps: SandboxCaps,
  options: { replace?: boolean } = {},
): Promise<Map<string, string>> {
  if (files.length > caps.max_files_in) {
    throw new SandboxError("invalid_request", `at most ${caps.max_files_in} input files`);
  }
  const prepared: Array<{ path: string; data: Buffer }> = [];
  const seen = new Set<string>();
  let total = 0;
  for (const file of files) {
    const path = normalizeRelativePath(file.path);
    const key = pathKey(path);
    if (seen.has(key)) throw new SandboxError("invalid_path", `duplicate input file \`${path}\``);
    // A file and a directory of the same name (`a` and `a/b`) cannot both exist.
    for (const other of seen) {
      if (other.startsWith(`${key}/`) || key.startsWith(`${other}/`)) {
        throw new SandboxError("invalid_path", `input file \`${path}\` clashes with another`);
      }
    }
    seen.add(key);
    const data = decode(file);
    total += data.length;
    if (total > caps.max_files_in_bytes) {
      throw new SandboxError(
        "invalid_request",
        `input files over ${caps.max_files_in_bytes} bytes`,
      );
    }
    prepared.push({ path, data });
  }
  const hashes = new Map<string, string>();
  for (const { path, data } of prepared) {
    const full = safeJoin(workDir, path);
    if (options.replace) await clearForInput(workDir, path);
    const parts = path.split("/");
    let dir = workDir;
    for (const part of parts.slice(0, -1)) {
      dir = join(dir, part);
      await mkdir(dir, { recursive: true });
      await chmod(dir, 0o777);
    }
    await writeFile(full, data, { flag: "wx", mode: 0o666 });
    hashes.set(pathKey(path), sha256(data));
  }
  return hashes;
}

function isUtf8(data: Buffer): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return true;
  } catch {
    return false;
  }
}

/** A regular file found by `walkWork`. */
interface WalkEntry {
  path: string;
  full: string;
  size: number;
  /** Changes when the file is written (size, mtime, ctime). */
  sig: string;
}

/** What `walkWork` found. */
export interface WorkWalk {
  files: WalkEntry[];
  /** Some entries were skipped (links, special or unreadable files, depth or entry limits). */
  truncated: boolean;
  /** Entries looked at (files, directories and the rest). */
  entries: number;
  /** Bytes of the regular files found. */
  bytes: number;
}

/**
 * Regular files under `workDir` in path order. Symlinks, devices, FIFOs and sockets are skipped,
 * unreadable entries too (both set `truncated`); the walk never follows links and stops at
 * `MAX_PATH_DEPTH` levels and `maxEntries` entries.
 */
export async function walkWork(workDir: string, maxEntries = MAX_WALK_ENTRIES): Promise<WorkWalk> {
  const files: WalkEntry[] = [];
  let truncated = false;
  let entries = 0;
  let bytes = 0;
  const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(dir)).sort();
    } catch {
      truncated = true;
      return;
    }
    for (const name of names) {
      if (++entries > maxEntries) {
        truncated = true;
        return;
      }
      const full = join(dir, name);
      const path = prefix === "" ? name : `${prefix}/${name}`;
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(full);
      } catch {
        // e.g. a FIFO the container made, which Windows cannot even stat through the share.
        truncated = true;
        continue;
      }
      if (stat.isDirectory()) {
        if (depth >= MAX_PATH_DEPTH) truncated = true;
        else await walk(full, path, depth + 1);
      } else if (stat.isFile()) {
        bytes += stat.size;
        const sig = `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        files.push({ path, full, size: stat.size, sig });
      } else {
        truncated = true;
      }
    }
  };
  await walk(workDir, "", 1);
  return { files, truncated, entries, bytes };
}

/** File signatures by case-folded path, to tell which files a session run changed. */
export function signatures(walked: WorkWalk): Map<string, string> {
  return new Map(walked.files.map((f) => [pathKey(f.path), f.sig]));
}

/**
 * Regular files under `workDir` that are new or differ from the inputs (and, in a session, whose
 * signature differs from `before`, taken just before the run), in path order, within the caps.
 * `walked` reuses a walk. Call it only once nothing runs in the container any more.
 */
export async function collectOutputs(
  workDir: string,
  inputs: ReadonlyMap<string, string>,
  caps: SandboxCaps,
  options: { before?: ReadonlyMap<string, string>; walked?: WorkWalk } = {},
): Promise<{ files: FileOut[]; truncated: boolean }> {
  const walked = options.walked ?? (await walkWork(workDir));
  let truncated = walked.truncated;
  const found = walked.files.filter((f) => options.before?.get(pathKey(f.path)) !== f.sig);

  const files: FileOut[] = [];
  let total = 0;
  for (const entry of found) {
    if (files.length >= caps.max_files_out || total + entry.size > caps.max_files_out_bytes) {
      truncated = true;
      continue;
    }
    let data: Buffer;
    try {
      const stat = await lstat(entry.full);
      if (!stat.isFile()) {
        truncated = true;
        continue;
      }
      data = await readFile(entry.full);
    } catch {
      truncated = true;
      continue;
    }
    if (inputs.get(pathKey(entry.path)) === sha256(data)) continue;
    if (total + data.length > caps.max_files_out_bytes) {
      truncated = true;
      continue;
    }
    total += data.length;
    const text = isUtf8(data);
    files.push({
      path: entry.path,
      size: data.length,
      encoding: text ? "utf8" : "base64",
      content: text ? data.toString("utf8") : data.toString("base64"),
    });
  }
  return { files, truncated };
}

/** Removes a directory tree; failures are logged, never thrown. */
export async function removeDir(path: string): Promise<boolean> {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 2 });
    return true;
  } catch (error) {
    log.warn({ path, err: (error as Error).message }, "could not remove a sandbox directory");
    return false;
  }
}

/**
 * Deletes all but the newest `keep` run directories (run ids are ULIDs, so names sort by
 * time). Only ULID-named directories that are not `active` are touched. Returns how many were
 * removed.
 */
export async function pruneRuns(
  root: string,
  keep: number,
  active: ReadonlySet<string> = new Set(),
): Promise<number> {
  let names: string[];
  try {
    names = await readdir(runsDir(root));
  } catch {
    return 0;
  }
  const runs = names.filter((name) => isUlid(name) && !active.has(name)).sort();
  const old = runs.slice(0, Math.max(0, runs.length - keep));
  let removed = 0;
  for (const name of old) if (await removeDir(join(runsDir(root), name))) removed++;
  return removed;
}

const EXTENSION: Record<Language, string> = { python: ".py", node: ".mjs" };

/**
 * The profile's persistent tools workspace (`<root>/profiles/<profile>/tools`): scripts she
 * keeps, written only by the host (this class) and mounted read-only at `/tools` when a run asks
 * for it. A script is `<name>.py` or `<name>.mjs`; names follow `NAME`.
 */
export class ToolsWorkspace implements ToolsWorkspaceApi {
  constructor(
    readonly dir: string,
    readonly limits: { maxScripts: number; maxScriptBytes: number },
  ) {}

  async ensure(): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    return this.dir;
  }

  async list(): Promise<ScriptInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: ScriptInfo[] = [];
    for (const file of names.sort()) {
      const info = await this.#info(file);
      if (info) out.push(info);
    }
    return out;
  }

  async #info(file: string): Promise<ScriptInfo | null> {
    for (const language of ["python", "node"] as const) {
      const ext = EXTENSION[language];
      if (!file.endsWith(ext)) continue;
      const name = file.slice(0, -ext.length);
      try {
        checkName(name);
        const stat = await lstat(join(this.dir, file));
        if (!stat.isFile()) return null;
        return { name, language, file, size: stat.size };
      } catch {
        return null;
      }
    }
    return null;
  }

  async read(name: string): Promise<{ info: ScriptInfo; code: string } | null> {
    checkName(name);
    for (const language of ["python", "node"] as const) {
      const info = await this.#info(`${name}${EXTENSION[language]}`);
      if (info) return { info, code: await readFile(join(this.dir, info.file), "utf8") };
    }
    return null;
  }

  async save(name: string, language: Language, code: string): Promise<ScriptInfo> {
    checkName(name);
    const size = Buffer.byteLength(code, "utf8");
    if (size > this.limits.maxScriptBytes) {
      throw new SandboxError(
        "invalid_request",
        `scripts are at most ${this.limits.maxScriptBytes} bytes`,
      );
    }
    const existing = await this.list();
    if (!existing.some((s) => s.name === name) && existing.length >= this.limits.maxScripts) {
      throw new SandboxError("limit", `at most ${this.limits.maxScripts} scripts`);
    }
    await this.ensure();
    // One script per name: saving in another language replaces the old file.
    for (const s of existing) {
      if (s.name === name && s.language !== language) await rm(join(this.dir, s.file));
    }
    const file = `${name}${EXTENSION[language]}`;
    await writeFile(safeJoin(this.dir, file), code, { mode: 0o644 });
    return { name, language, file, size };
  }

  async remove(name: string): Promise<boolean> {
    checkName(name);
    let removed = false;
    for (const language of ["python", "node"] as const) {
      const info = await this.#info(`${name}${EXTENSION[language]}`);
      if (info) {
        await rm(join(this.dir, info.file));
        removed = true;
      }
    }
    return removed;
  }
}
