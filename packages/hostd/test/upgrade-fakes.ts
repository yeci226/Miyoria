// A pretend git repository and pnpm for the update tests: the runner answers the commands the
// update and the checkout reading send, from a small model of one branch tracking `origin/main`.
// Nothing here runs git or pnpm.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandRunner, RunSpec } from "../src/index.js";
import { TMP } from "./fakes.js";

export const sha = (n: number | string): string =>
  typeof n === "number" ? n.toString(16).padStart(40, "0") : n.padEnd(40, "0");

export interface FakeRepo {
  /** The commits of the line `main` follows, oldest first. */
  chain: string[];
  /** A commit on another line (not on `main`). */
  side: string;
  head: string;
  /** `null`: detached. */
  branch: string | null;
  /** `branch.<b>.remote`; `null` for no upstream. */
  remote: string | null;
  /** The upstream tip the local repository knows; the fetch moves it to `remoteTip`. */
  upstream: string;
  remoteTip: string;
  /** Lines of `git status --porcelain --untracked-files=no`. */
  dirty: string[];
  /** What `git diff --name-only` answers. */
  files: string[];
  fetchFails: boolean;
  pnpmFails: number;
  /** Commands in order, as `git fetch ...` / `pnpm install ...`. */
  calls: string[];
}

export function fakeRepo(over: Partial<FakeRepo> = {}): FakeRepo {
  const chain = [sha(1), sha(2), sha(3), sha(4)];
  return {
    chain,
    side: sha("bad"),
    head: sha(2),
    branch: "main",
    remote: "origin",
    upstream: sha(2),
    remoteTip: sha(4),
    dirty: [],
    files: ["workers/py/server.py"],
    fetchFails: false,
    pnpmFails: 0,
    calls: [],
    ...over,
  };
}

/** A folder with a `.git` file, so the update looks at it as a checkout. */
export function checkoutRoot(): string {
  mkdirSync(TMP, { recursive: true });
  const root = mkdtempSync(join(TMP, "repo-"));
  writeFileSync(join(root, ".git"), "gitdir: nowhere\n");
  return root;
}

export function repoRunner(repo: FakeRepo, root: string): CommandRunner {
  const known = () => {
    const fetched = repo.calls.some((c) => c.startsWith("git fetch"));
    const upTo = repo.chain.indexOf(fetched ? repo.remoteTip : repo.upstream);
    const local = repo.chain.indexOf(repo.head);
    return new Set([...repo.chain.slice(0, Math.max(upTo, local) + 1), repo.side]);
  };
  const resolveRef = (ref: string) => (ref === "@{upstream}" ? repo.upstream : ref);
  const ancestor = (a: string, b: string) => {
    const x = repo.chain.indexOf(resolveRef(a));
    const y = repo.chain.indexOf(resolveRef(b));
    if (resolveRef(a) === resolveRef(b)) return true;
    return x >= 0 && y >= 0 && x <= y;
  };
  return async (spec: RunSpec, hooks) => {
    const say = (...lines: string[]) => {
      for (const l of lines) hooks?.onLine?.(l);
    };
    const done = (code: number) => ({ code, missing: false, tail: [] });
    const out = (code: number, ...lines: string[]) => {
      say(...lines);
      return done(code);
    };
    const args = spec.args;
    const line = `${spec.file} ${args.join(" ")}`;
    if (spec.file === "pnpm") {
      repo.calls.push(line);
      if (repo.pnpmFails > 0) {
        repo.pnpmFails -= 1;
        say("ERR_PNPM_EPERM operation not permitted");
        return done(1);
      }
      return done(0);
    }
    if (spec.file !== "git") return { code: null, missing: true, tail: [] };
    if (spec.env.GIT_TERMINAL_PROMPT !== "0") throw new Error("git without GIT_TERMINAL_PROMPT=0");
    const [cmd, ...rest] = args;
    const is = (...xs: string[]) => xs.every((x, i) => rest[i] === x);
    switch (cmd) {
      case "rev-parse":
        if (is("--show-toplevel")) return out(0, root);
        if (is("--verify", "HEAD")) return out(0, repo.head);
        if (is("--abbrev-ref", "--symbolic-full-name", "@{upstream}")) {
          if (repo.remote === null || repo.branch === null) return done(128);
          return out(0, `${repo.remote}/${repo.branch}`);
        }
        if (is("--git-path", "FETCH_HEAD")) return out(0, ".git/FETCH_HEAD");
        return done(128);
      case "symbolic-ref":
        if (repo.branch === null) return done(1);
        return out(0, repo.branch);
      case "rev-list": {
        const h = repo.chain.indexOf(repo.head);
        const u = repo.chain.indexOf(repo.upstream);
        return out(0, `${Math.max(0, h - u)}\t${Math.max(0, u - h)}`);
      }
      case "status":
        return out(0, ...repo.dirty);
      case "config": {
        const key = rest[1] ?? "";
        if (repo.remote === null || repo.branch === null) return done(1);
        if (key === `branch.${repo.branch}.remote`) return out(0, repo.remote);
        if (key === `branch.${repo.branch}.merge`) return out(0, `refs/heads/${repo.branch}`);
        return done(1);
      }
      case "fetch":
        repo.calls.push(line);
        if (repo.fetchFails) return out(128, "fatal: unable to access");
        repo.upstream = repo.remoteTip;
        return done(0);
      case "cat-file": {
        const c = (rest[1] ?? "").replace("^{commit}", "");
        return done(known().has(c) ? 0 : 128);
      }
      case "merge-base":
        return done(ancestor(rest[1] ?? "", rest[2] ?? "") ? 0 : 1);
      case "merge": {
        repo.calls.push(line);
        const target = rest.at(-1) ?? "";
        if (!ancestor(repo.head, target)) return out(128, "fatal: Not possible to fast-forward");
        repo.head = target;
        return done(0);
      }
      case "diff":
        return out(0, ...repo.files);
      case "reset":
        repo.calls.push(line);
        repo.head = rest.at(-1) ?? repo.head;
        return done(0);
      default:
        return done(129);
    }
  };
}
