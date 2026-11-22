// Core's own checkout (docs/design/v5-hostd.md §14): the commit a remote update names, and how a
// host's commit stands to it. Read from the local repository with git, never fetched; the answers
// are kept for a short while so the hosts page can ask on every poll.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { HostCheckout } from "@miyoria/contracts/host";

/** How a host's commit stands to Core's. `behind` and `ahead` carry the count. */
export type CommitRelation =
  | { relation: "same" }
  | { relation: "behind"; count: number }
  | { relation: "ahead"; count: number }
  | { relation: "diverged" }
  /** Core's repository does not have the host's commit, or git could not say. */
  | { relation: "unknown" };

/** What the cluster routes ask of Core's checkout. */
export interface CheckoutSource {
  /** Core's checkout now; `null` when Core does not run from one. */
  read(): Promise<HostCheckout | null>;
  /** How `commit` stands to Core's `HEAD`. */
  relation(commit: string): Promise<CommitRelation>;
}

/** One git command: its exit code and its standard output. */
export type GitExec = (args: readonly string[]) => Promise<{ code: number; stdout: string }>;

/** The real one: `git` in `root`, no shell, no prompt, no optional lock. */
export function execGit(root: string): GitExec {
  return (args) =>
    new Promise((done) => {
      execFile(
        "git",
        [...args],
        {
          cwd: root,
          timeout: 15_000,
          windowsHide: true,
          maxBuffer: 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        },
        (error, stdout) => {
          const code =
            error === null ? 0 : typeof error.code === "number" ? error.code : Number.NaN;
          done({ code, stdout: String(stdout) });
        },
      );
    });
}

/**
 * The top of the repository holding `from` (a file or folder of Core's code): the first folder up
 * with both `pnpm-workspace.yaml` and `.git`. `null` for a packaged install.
 */
export function findCheckoutRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const SHA = /^[0-9a-f]{40}$/u;

export interface GitCheckoutOptions {
  exec: GitExec;
  now?: () => number;
  /** How long an answer is kept. Default 15 s. */
  ttlMs?: number;
}

/** A `CheckoutSource` over git. */
export function gitCheckout(options: GitCheckoutOptions): CheckoutSource {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 15_000;
  const run = options.exec;
  let cached: { at: number; value: Promise<HostCheckout | null> } | null = null;
  const relations = new Map<string, CommitRelation>();

  const first = async (args: readonly string[]): Promise<string | null> => {
    const r = await run(args);
    if (r.code !== 0) return null;
    const line = r.stdout.split(/\r?\n/u)[0]?.trim() ?? "";
    return line === "" ? null : line;
  };

  const readNow = async (): Promise<HostCheckout | null> => {
    const commit = await first(["rev-parse", "--verify", "HEAD"]);
    if (commit === null || !SHA.test(commit)) return null;
    const branch = await first(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const upstream =
      branch === null
        ? null
        : await first(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    let ahead: number | null = null;
    let behind: number | null = null;
    if (upstream !== null) {
      const m = /^(\d+)\s+(\d+)$/u.exec(
        (await first(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])) ?? "",
      );
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    }
    const status = await run(["status", "--porcelain", "--untracked-files=no"]);
    return {
      commit,
      branch,
      upstream,
      ahead,
      behind,
      dirty: status.code !== 0 || status.stdout.trim() !== "",
      fetched_at: null,
      read_at: now(),
    };
  };

  const read = (): Promise<HostCheckout | null> => {
    if (cached === null || now() - cached.at > ttl) {
      cached = { at: now(), value: readNow().catch(() => null) };
    }
    return cached.value;
  };

  const count = async (range: string): Promise<number | null> => {
    const line = await first(["rev-list", "--count", range]);
    return line !== null && /^\d+$/u.test(line) ? Number(line) : null;
  };

  return {
    read,
    async relation(commit) {
      const core = await read();
      if (core === null || !SHA.test(commit)) return { relation: "unknown" };
      if (commit === core.commit) return { relation: "same" };
      const key = `${commit}..${core.commit}`;
      const known = relations.get(key);
      if (known !== undefined) return known;
      let answer: CommitRelation = { relation: "unknown" };
      const exists = await run(["cat-file", "-e", `${commit}^{commit}`]);
      if (exists.code === 0) {
        const behind = await run(["merge-base", "--is-ancestor", commit, core.commit]);
        const ahead = await run(["merge-base", "--is-ancestor", core.commit, commit]);
        if (behind.code === 0) {
          const n = await count(`${commit}..${core.commit}`);
          answer = n === null ? { relation: "unknown" } : { relation: "behind", count: n };
        } else if (ahead.code === 0) {
          const n = await count(`${core.commit}..${commit}`);
          answer = n === null ? { relation: "unknown" } : { relation: "ahead", count: n };
        } else if (behind.code === 1 && ahead.code === 1) {
          answer = { relation: "diverged" };
        }
      }
      // Commits never move: an answer about two of them stays true. Unknown is asked again.
      if (answer.relation !== "unknown") {
        if (relations.size > 256) relations.clear();
        relations.set(key, answer);
      }
      return answer;
    },
  };
}
