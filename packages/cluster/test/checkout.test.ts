// Core's own checkout and the hosts' update state on the link (docs/design/v5-hostd.md §14). Git
// is a pretend `GitExec`: nothing runs against a repository.

import { afterEach, describe, expect, it } from "vitest";
import { type GitExec, gitCheckout } from "../src/index.js";
import { approvedHost, FakeHost, Harness, report, service, waitUntil } from "./helpers.js";

const sha = (n: number) => n.toString(16).padStart(40, "0");

/** Commits 1..5 on one line, Core at 4; `side` (0xbad) is on another; 0xfff is unknown. */
function fakeGit(calls: string[] = []): GitExec {
  const line = [1, 2, 3, 4, 5].map(sha);
  const side = sha(0xbad);
  const head = sha(4);
  return async (args) => {
    calls.push(args.join(" "));
    const [cmd, ...rest] = args;
    const ok = (stdout = "") => ({ code: 0, stdout });
    switch (cmd) {
      case "rev-parse":
        if (rest[0] === "--verify") return ok(`${head}\n`);
        return ok("origin/main\n");
      case "symbolic-ref":
        return ok("main\n");
      case "rev-list": {
        if (rest[0] === "--left-right") return ok("0\t1\n");
        const [a, b] = (rest[1] ?? "").split("..");
        return ok(`${Math.abs(line.indexOf(b ?? "") - line.indexOf(a ?? ""))}\n`);
      }
      case "status":
        return ok("");
      case "cat-file": {
        const c = (rest[1] ?? "").replace("^{commit}", "");
        return { code: line.includes(c) || c === side ? 0 : 128, stdout: "" };
      }
      case "merge-base": {
        const a = line.indexOf(rest[1] ?? "");
        const b = line.indexOf(rest[2] ?? "");
        return { code: a >= 0 && b >= 0 && a <= b ? 0 : 1, stdout: "" };
      }
      default:
        return { code: 129, stdout: "" };
    }
  };
}

describe("Core's checkout", () => {
  it("reads HEAD, branch, upstream and a clean tree, and keeps the answer a while", async () => {
    const calls: string[] = [];
    let t = 0;
    const source = gitCheckout({ exec: fakeGit(calls), now: () => t, ttlMs: 1000 });
    expect(await source.read()).toMatchObject({
      commit: sha(4),
      branch: "main",
      upstream: "origin/main",
      behind: 1,
      ahead: 0,
      dirty: false,
    });
    const asked = calls.length;
    await source.read();
    expect(calls.length).toBe(asked);
    t = 2000;
    await source.read();
    expect(calls.length).toBeGreaterThan(asked);
  });

  it("says how a host's commit stands to Core's", async () => {
    const source = gitCheckout({ exec: fakeGit() });
    expect(await source.relation(sha(4))).toEqual({ relation: "same" });
    expect(await source.relation(sha(2))).toEqual({ relation: "behind", count: 2 });
    expect(await source.relation(sha(5))).toEqual({ relation: "ahead", count: 1 });
    expect(await source.relation(sha(0xbad))).toEqual({ relation: "diverged" });
    expect(await source.relation(sha(0xfff))).toEqual({ relation: "unknown" });
    expect(await source.relation("not-a-commit")).toEqual({ relation: "unknown" });
  });
});

describe("the hosts' update state on the link", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.stop();
    harness = null;
  });

  it("is what the last report says, and absent from an old daemon's report", async () => {
    harness = await Harness.start();
    const cluster = harness.cluster();
    const { id, key } = approvedHost(cluster, "pc", ["sing"]);
    const host = await FakeHost.connect(harness.url(), { host: id, key });
    host.peer.notify("host.report", report([service({ name: "sing" })]));
    await waitUntil(() => cluster.registry.candidates("sing").length > 0, "old report");
    const old = cluster.hosts.connected()[0];
    expect(old?.checkout).toBeUndefined();
    expect(old?.remoteUpdate).toBeUndefined();

    const checkout = {
      commit: sha(2),
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      dirty: false,
      fetched_at: null,
      read_at: 1,
    };
    host.peer.notify("host.report", {
      ...report([service({ name: "sing" })]),
      checkout,
      remote_update: { allowed: true },
      upgrade: null,
    });
    await waitUntil(() => cluster.hosts.connected()[0]?.checkout !== undefined, "new report");
    expect(cluster.hosts.connected()[0]).toMatchObject({
      checkout,
      remoteUpdate: { allowed: true },
      upgrade: null,
    });
  });
});
