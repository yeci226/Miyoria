// Her persistent workspace (`<root>/profiles/<profile>/workspace`): files she keeps between runs
// and sessions. The host writes and reads it through this class; a container with
// `mount_workspace` gets the same directory read-write at `/workspace`, so everything in it may
// have been written by a hostile program: paths are checked lexically (`normalizeRelativePath`)
// and component by component with `lstat` (no link is ever followed, so a symlink or junction a
// program planted cannot lead a host read or write outside), and `enforce` removes what a run
// left that breaks the rules (links, special files, files and totals over the quotas).

import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  constants,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_PATH_DEPTH, normalizeRelativePath, pathKey, safeJoin } from "./paths.js";
import { type Language, SandboxError } from "./types.js";
import { signatures, type WorkWalk, walkWork } from "./workspace.js";

/** Quotas of the workspace. */
export interface WorkspaceLimits {
  maxBytes: number;
  maxFiles: number;
  maxFileBytes: number;
}

/** A file in the workspace. */
export interface WorkspaceEntry {
  path: string;
  size: number;
}

export interface WorkspaceUsage {
  files: number;
  bytes: number;
  /** More entries than the walk looks at (or unreadable ones): treat the workspace as full. */
  overflow: boolean;
}

/** What a read returns: a slice of the text, in characters. */
export interface WorkspaceRead {
  path: string;
  /** Size of the whole file in bytes. */
  size: number;
  text: string;
  /** Characters skipped before `text`. */
  offset: number;
  /** Where the next read continues, or `null` when `text` reaches the end. */
  next_offset: number | null;
}

/** One thing `enforce` removed. */
export interface Removed {
  path: string;
  reason: "link" | "special" | "too_deep" | "file_too_large" | "over_quota";
}

/** The file operations of the workspace, as the gate and the skills store use them. */
export interface WorkspaceApi {
  readonly limits: WorkspaceLimits;
  usage(): Promise<WorkspaceUsage>;
  list(prefix?: string): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }>;
  read(path: string, options?: { offset?: number; maxChars?: number }): Promise<WorkspaceRead>;
  write(path: string, text: string, options?: { append?: boolean }): Promise<WorkspaceEntry>;
  /** Removes a file, or a directory with everything in it; `false` when there is none. */
  remove(path: string): Promise<boolean>;
  exists(path: string): Promise<boolean>;
  /**
   * Saves a `.py` / `.mjs` script and records its hash as approved. Only the reviewed
   * `workspace.save_script` calls this: a script a program wrote into the workspace is not
   * approved, and one whose text changed since is not either.
   */
  saveScript(path: string, text: string): Promise<WorkspaceEntry>;
  /** The script's text if it is approved and unchanged since, else `null`. */
  approvedScript(path: string): Promise<{ language: Language; text: string } | null>;
}

const MAX_ENTRIES_FLOOR = 100;
/** Most entries `enforce` looks at (more are left and make `usage` report overflow). */
const ENFORCE_ENTRIES = 20_000;

function invalid(path: string, why: string): SandboxError {
  return new SandboxError(
    "invalid_path",
    `invalid workspace path \`${path.slice(0, 80)}\`: ${why}`,
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

const SCRIPT_LANGUAGE: Record<string, Language> = { ".py": "python", ".mjs": "node" };

/** The language a script path runs as, or `null` when it is not a `.py` / `.mjs` file. */
export function scriptLanguage(path: string): Language | null {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? null : (SCRIPT_LANGUAGE[name.slice(dot).toLowerCase()] ?? null);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export class PersistentWorkspace implements WorkspaceApi {
  #ledger: Map<string, string> | null = null;

  /**
   * `ledgerFile`: where the approved scripts' hashes are kept. It must be outside `dir`, which a
   * program can write; without it approvals last only as long as the process.
   */
  constructor(
    readonly dir: string,
    readonly limits: WorkspaceLimits,
    readonly ledgerFile?: string,
  ) {}

  /** Creates the directory (world-writable, so a container's non-root uid can write in it). */
  async ensure(): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    await chmod(this.dir, 0o777);
    return this.dir;
  }

  #maxEntries(): number {
    return this.limits.maxFiles * 2 + MAX_ENTRIES_FLOOR;
  }

  /** Walks the whole workspace (links and special files are not counted). */
  async #walk(): Promise<WorkWalk> {
    return walkWork(this.dir, this.#maxEntries());
  }

  async usage(): Promise<WorkspaceUsage> {
    const walked = await this.#walk();
    return { files: walked.files.length, bytes: walked.bytes, overflow: walked.truncated };
  }

  /** File signatures, to tell what a run changed (pass to `enforce`). */
  async snapshot(): Promise<Map<string, string>> {
    return signatures(await this.#walk());
  }

  /**
   * Checks that no existing component of `path` is a link and returns the host path. With
   * `parents`, missing parent directories are created (world-writable). Throws `invalid_path`.
   */
  async #resolve(path: string, parents: boolean): Promise<string> {
    const normalized = normalizeRelativePath(path);
    const full = safeJoin(this.dir, normalized);
    const parts = normalized.split("/");
    let current = this.dir;
    for (const [i, part] of parts.entries()) {
      current = join(current, part);
      const last = i === parts.length - 1;
      let stat: Awaited<ReturnType<typeof lstat>>;
      try {
        stat = await lstat(current);
      } catch (error) {
        if (!isMissing(error)) throw invalid(path, "cannot be read");
        if (last) return full;
        if (!parents) return full;
        await mkdir(current).catch(() => undefined);
        await chmod(current, 0o777).catch(() => undefined);
        stat = await lstat(current).catch(() => {
          throw invalid(path, "cannot create the directory");
        });
      }
      if (stat.isSymbolicLink()) throw invalid(path, "goes through a link");
      if (!last && !stat.isDirectory()) throw invalid(path, `\`${part}\` is not a directory`);
    }
    return full;
  }

  async list(prefix?: string): Promise<{ entries: WorkspaceEntry[]; truncated: boolean }> {
    let base = "";
    if (prefix !== undefined && prefix !== "") {
      base = normalizeRelativePath(prefix.replace(/\/+$/, ""));
      await this.#resolve(base, false);
    }
    const walked = await this.#walk();
    const entries: WorkspaceEntry[] = [];
    for (const f of walked.files) {
      if (base !== "" && f.path !== base && !f.path.startsWith(`${base}/`)) continue;
      try {
        normalizeRelativePath(f.path);
      } catch {
        // A name a program made that the tools cannot address; `enforce` leaves it, list hides it.
        continue;
      }
      entries.push({ path: f.path, size: f.size });
    }
    return { entries, truncated: walked.truncated };
  }

  async exists(path: string): Promise<boolean> {
    const full = await this.#resolve(path, false);
    try {
      const stat = await lstat(full);
      return stat.isFile() || stat.isDirectory();
    } catch {
      return false;
    }
  }

  async read(
    path: string,
    options: { offset?: number; maxChars?: number } = {},
  ): Promise<WorkspaceRead> {
    const full = await this.#resolve(path, false);
    const offset = Math.max(0, Math.floor(options.offset ?? 0));
    const maxChars = Math.max(1, Math.floor(options.maxChars ?? 3000));
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      // O_NOFOLLOW (where the platform has it) closes the gap between the check and the open.
      handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    } catch (error) {
      if (isMissing(error)) throw new SandboxError("not_found", `no file \`${path}\``);
      throw invalid(path, "cannot be opened");
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new SandboxError("not_found", `\`${path}\` is not a file`);
      if (stat.size > this.limits.maxFileBytes) {
        throw new SandboxError("limit", `\`${path}\` is over ${this.limits.maxFileBytes} bytes`);
      }
      const data = await handle.readFile();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(data);
      } catch {
        throw new SandboxError("invalid_request", `\`${path}\` is not a text file`);
      }
      const chars = [...text];
      const slice = chars.slice(offset, offset + maxChars);
      const end = offset + slice.length;
      return {
        path,
        size: data.length,
        text: slice.join(""),
        offset,
        next_offset: end < chars.length ? end : null,
      };
    } finally {
      await handle.close();
    }
  }

  async write(
    path: string,
    text: string,
    options: { append?: boolean } = {},
  ): Promise<WorkspaceEntry> {
    await this.ensure();
    const full = await this.#resolve(path, true);
    let oldSize = 0;
    let existed = false;
    try {
      const stat = await lstat(full);
      if (!stat.isFile()) throw invalid(path, "exists and is not a file");
      oldSize = stat.size;
      existed = true;
    } catch (error) {
      if (error instanceof SandboxError) throw error;
    }
    const add = Buffer.from(text, "utf8");
    let data = add;
    if (options.append && existed) {
      const old = await this.#readBytes(full, path);
      data = Buffer.concat([old, add]);
    }
    if (data.length > this.limits.maxFileBytes) {
      throw new SandboxError("limit", `a file is at most ${this.limits.maxFileBytes} bytes`);
    }
    const usage = await this.usage();
    if (usage.overflow) {
      throw new SandboxError("limit", "the workspace has too many entries; delete some first");
    }
    if (usage.files + (existed ? 0 : 1) > this.limits.maxFiles) {
      throw new SandboxError("limit", `at most ${this.limits.maxFiles} files`);
    }
    if (usage.bytes - oldSize + data.length > this.limits.maxBytes) {
      throw new SandboxError("limit", `the workspace is full (${this.limits.maxBytes} bytes)`);
    }
    // Written beside the target and renamed over it: the rename replaces a link a program put
    // there instead of following it.
    const temp = join(join(full, ".."), `.tmp-${randomBytes(6).toString("hex")}`);
    const handle = await open(temp, "wx", 0o666);
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    try {
      await chmod(temp, 0o666);
      await rename(temp, full);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    return { path: normalizeRelativePath(path), size: data.length };
  }

  async #loadLedger(): Promise<Map<string, string>> {
    if (this.#ledger) return this.#ledger;
    const ledger = new Map<string, string>();
    if (this.ledgerFile !== undefined) {
      try {
        const parsed: unknown = JSON.parse(await readFile(this.ledgerFile, "utf8"));
        if (parsed !== null && typeof parsed === "object") {
          for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === "string" && /^[0-9a-f]{64}$/.test(value)) ledger.set(key, value);
          }
        }
      } catch {
        // No ledger yet (or unreadable): nothing is approved, which is the safe answer.
      }
    }
    this.#ledger = ledger;
    return ledger;
  }

  async saveScript(path: string, text: string): Promise<WorkspaceEntry> {
    if (scriptLanguage(path) === null) {
      throw new SandboxError("invalid_request", "a script is a .py or .mjs file");
    }
    const entry = await this.write(path, text);
    const ledger = await this.#loadLedger();
    ledger.set(pathKey(entry.path), sha256(text));
    if (this.ledgerFile !== undefined) {
      await mkdir(dirname(this.ledgerFile), { recursive: true });
      const temp = `${this.ledgerFile}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, JSON.stringify(Object.fromEntries(ledger)), "utf8");
      await rename(temp, this.ledgerFile);
    }
    return entry;
  }

  async approvedScript(path: string): Promise<{ language: Language; text: string } | null> {
    let normalized: string;
    try {
      normalized = normalizeRelativePath(path);
    } catch {
      return null;
    }
    const language = scriptLanguage(normalized);
    const approved = (await this.#loadLedger()).get(pathKey(normalized));
    if (language === null || approved === undefined) return null;
    try {
      const { text } = await this.read(normalized, { maxChars: this.limits.maxFileBytes });
      return sha256(text) === approved ? { language, text } : null;
    } catch {
      return null;
    }
  }

  async #readBytes(full: string, path: string): Promise<Buffer> {
    const handle = await open(full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(() => {
      throw invalid(path, "cannot be opened");
    });
    try {
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  }

  async remove(path: string): Promise<boolean> {
    const full = await this.#resolve(path, false);
    let stat: Awaited<ReturnType<typeof lstat>>;
    try {
      stat = await lstat(full);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) throw invalid(path, "is a link");
    if (!stat.isFile() && !stat.isDirectory()) throw invalid(path, "is not a file or directory");
    // `rm` never follows links inside a tree it deletes.
    await rm(full, { recursive: true, force: true });
    return true;
  }

  /**
   * Makes the workspace obey the rules again after a program had it mounted read-write: links,
   * devices, FIFOs and sockets are removed, so are too-deep trees and files over the per-file
   * quota, then files that are new or changed since `before` (newest first, then the rest) go
   * until the file count and the total size fit. Never follows a link.
   */
  async enforce(before: ReadonlyMap<string, string> = new Map()): Promise<Removed[]> {
    const removed: Removed[] = [];
    const files: Array<{ path: string; full: string; size: number; mtime: number; sig: string }> =
      [];
    let seen = 0;
    const drop = async (full: string, path: string, reason: Removed["reason"]): Promise<void> => {
      try {
        await rm(full, { recursive: true, force: true });
      } catch {
        await unlink(full).catch(() => undefined);
      }
      removed.push({ path, reason });
    };
    const walk = async (dir: string, prefix: string, depth: number): Promise<void> => {
      let names: string[];
      try {
        names = (await readdir(dir)).sort();
      } catch {
        return;
      }
      for (const name of names) {
        if (++seen > ENFORCE_ENTRIES) return;
        const full = join(dir, name);
        const path = prefix === "" ? name : `${prefix}/${name}`;
        let stat: Awaited<ReturnType<typeof lstat>>;
        try {
          stat = await lstat(full);
        } catch {
          await drop(full, path, "special");
          continue;
        }
        if (stat.isSymbolicLink()) await drop(full, path, "link");
        else if (stat.isDirectory()) {
          if (depth >= MAX_PATH_DEPTH) await drop(full, path, "too_deep");
          else await walk(full, path, depth + 1);
        } else if (stat.isFile()) {
          if (stat.size > this.limits.maxFileBytes) await drop(full, path, "file_too_large");
          else {
            files.push({
              path,
              full,
              size: stat.size,
              mtime: stat.mtimeMs,
              sig: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
            });
          }
        } else await drop(full, path, "special");
      }
    };
    await walk(this.dir, "", 1);

    let count = files.length;
    let bytes = files.reduce((n, f) => n + f.size, 0);
    if (count > this.limits.maxFiles || bytes > this.limits.maxBytes) {
      const changed = (f: (typeof files)[number]) => before.get(pathKey(f.path)) !== f.sig;
      const order = [
        ...files.filter(changed).sort((a, b) => b.mtime - a.mtime),
        ...files.filter((f) => !changed(f)).sort((a, b) => b.mtime - a.mtime),
      ];
      for (const f of order) {
        if (count <= this.limits.maxFiles && bytes <= this.limits.maxBytes) break;
        await drop(f.full, f.path, "over_quota");
        count -= 1;
        bytes -= f.size;
      }
    }
    return removed;
  }
}
