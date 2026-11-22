// The git a host runs on its own checkout (docs/design/v5-hostd.md §14): read-only questions for
// the report, and the few commands an update needs. Every call is an argument list through the
// installer's `CommandRunner` (no shell), with `GIT_TERMINAL_PROMPT=0` so a fetch that wants a
// password fails instead of waiting, and `GIT_OPTIONAL_LOCKS=0` so a status never takes the
// index lock from the person working there.

import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { HostCheckout } from "@miyoria/contracts/host";
import type { CommandRunner } from "../install/run.js";

/** What a git command said: its exit code (`null`: git could not run) and its output lines. */
export interface GitResult {
  code: number | null;
  missing: boolean;
  lines: string[];
}

export interface GitOptions {
  /** The checkout's top folder. */
  root: string;
  runner: CommandRunner;
  /** The environment git runs with (default `process.env`). */
  env?: Record<string, string | undefined>;
}

/** How long a local git question may take. */
const LOCAL_MS = 15_000;
/** How long a fetch may take. */
export const FETCH_MS = 180_000;

/** The environment of every git command. */
export function gitEnv(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) out[key] = value;
  out.GIT_TERMINAL_PROMPT = "0";
  out.GIT_OPTIONAL_LOCKS = "0";
  return out;
}

/** Runs `git <args>` in the checkout and collects its output. Never throws. */
export async function git(
  options: GitOptions,
  args: readonly string[],
  hooks: { timeoutMs?: number; signal?: AbortSignal; onLine?: (line: string) => void } = {},
): Promise<GitResult> {
  const lines: string[] = [];
  const signals = [AbortSignal.timeout(hooks.timeoutMs ?? LOCAL_MS)];
  if (hooks.signal !== undefined) signals.push(hooks.signal);
  const outcome = await options.runner(
    { file: "git", args: [...args], cwd: options.root, env: gitEnv(options.env ?? process.env) },
    {
      signal: AbortSignal.any(signals),
      onLine: (line) => {
        lines.push(line);
        hooks.onLine?.(line);
      },
    },
  );
  return { code: outcome.code, missing: outcome.missing, lines };
}

/** The first line of a command that worked; `null` otherwise. */
async function one(options: GitOptions, args: readonly string[]): Promise<string | null> {
  const r = await git(options, args);
  if (r.code !== 0) return null;
  const line = r.lines[0]?.trim();
  return line === undefined || line === "" ? null : line;
}

const SHA = /^[0-9a-f]{40}$/u;

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => {
    const r = resolve(p).replaceAll("\\", "/").replace(/\/+$/u, "");
    return platform === "win32" ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/**
 * Whether `root` is the top of a git checkout, without running git: a `.git` folder or file (a
 * worktree) right there. A packaged install, or a test workspace inside some other checkout, is
 * not one, so nothing is ever asked of a repository the host was not started from.
 */
export function looksLikeCheckout(root: string): boolean {
  return existsSync(join(root, ".git"));
}

/** `HEAD` of the checkout; `null` when it cannot be read. */
export async function headOf(options: GitOptions): Promise<string | null> {
  const head = await one(options, ["rev-parse", "--verify", "HEAD"]);
  return head !== null && SHA.test(head) ? head : null;
}

/** The changes to tracked files (`git status --porcelain --untracked-files=no`); `null`: unknown. */
export async function trackedChanges(options: GitOptions): Promise<string[] | null> {
  const r = await git(options, ["status", "--porcelain", "--untracked-files=no"]);
  return r.code === 0 ? r.lines.filter((l) => l.trim() !== "") : null;
}

/** Where the branch fetches from: `branch.<name>.remote` and `.merge`; `null` without both. */
export async function trackingOf(
  options: GitOptions,
  branch: string,
): Promise<{ remote: string; merge: string } | null> {
  const remote = await one(options, ["config", "--get", `branch.${branch}.remote`]);
  const merge = await one(options, ["config", "--get", `branch.${branch}.merge`]);
  // `.` is a local branch tracking another local branch: there is nothing to fetch.
  if (remote === null || merge === null || remote === "." || remote.startsWith("-")) return null;
  if (!merge.startsWith("refs/heads/")) return null;
  return { remote, merge };
}

/**
 * The checkout as the report shows it, from the local repository only. `null` when `root` is not
 * the top of a checkout or git cannot read it.
 */
export async function readCheckout(
  options: GitOptions & { now: () => number; platform?: NodeJS.Platform },
): Promise<HostCheckout | null> {
  if (!looksLikeCheckout(options.root)) return null;
  const top = await one(options, ["rev-parse", "--show-toplevel"]);
  if (top === null || !samePath(top, options.root, options.platform ?? process.platform)) {
    return null;
  }
  const commit = await headOf(options);
  if (commit === null) return null;
  const branch = await one(options, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const upstream =
    branch === null
      ? null
      : await one(options, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream !== null) {
    const counts = await one(options, [
      "rev-list",
      "--left-right",
      "--count",
      "HEAD...@{upstream}",
    ]);
    const m = counts === null ? null : /^(\d+)\s+(\d+)$/u.exec(counts);
    if (m) {
      ahead = Number(m[1]);
      behind = Number(m[2]);
    }
  }
  const changes = await trackedChanges(options);
  const fetchHead = await one(options, ["rev-parse", "--git-path", "FETCH_HEAD"]);
  let fetchedAt: number | null = null;
  if (fetchHead !== null) {
    try {
      fetchedAt = statSync(resolve(options.root, fetchHead)).mtimeMs;
    } catch {
      fetchedAt = null;
    }
  }
  return {
    commit,
    branch,
    upstream,
    ahead,
    behind,
    // Unknown counts as dirty: an update refuses a tree it cannot see.
    dirty: changes === null || changes.length > 0,
    fetched_at: fetchedAt === null ? null : Math.round(fetchedAt),
    read_at: options.now(),
  };
}

/** `git merge-base --is-ancestor a b`: `true`, `false`, or `null` when git failed otherwise. */
export async function isAncestor(
  options: GitOptions,
  a: string,
  b: string,
): Promise<boolean | null> {
  const r = await git(options, ["merge-base", "--is-ancestor", a, b]);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  return null;
}

/** The commit exists in the local repository. */
export async function hasCommit(options: GitOptions, sha: string): Promise<boolean> {
  const r = await git(options, ["cat-file", "-e", `${sha}^{commit}`]);
  return r.code === 0;
}

/** The files that differ between two commits; `null` when git cannot say. */
export async function changedFiles(
  options: GitOptions,
  from: string,
  to: string,
): Promise<string[] | null> {
  const r = await git(options, ["diff", "--name-only", "--no-renames", from, to], {
    timeoutMs: 60_000,
  });
  if (r.code !== 0) return null;
  return r.lines.map((l) => l.trim()).filter((l) => l !== "");
}
