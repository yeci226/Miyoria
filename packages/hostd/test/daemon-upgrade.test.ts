// `host.upgrade` inside a daemon: who may ask, the opt-in, Core's own machine, and what the report
// says. The checkout is the pretend repository of `upgrade-fakes.ts`: nothing runs git.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOST_ERROR_CODE, type HostInfo } from "@miyoria/contracts/host";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, daemonFor, fake, workspace } from "./fakes.js";
import { fakeRepo, repoRunner, sha } from "./upgrade-fakes.js";

afterEach(cleanup);

const CORE = { kind: "core" } as const;
const OP = { kind: "operator" } as const;
const T = { timeout: 30_000 };

function opened(extra: string, services = [] as ReturnType<typeof fake>[]) {
  const ws = workspace(services, extra);
  writeFileSync(join(ws.root, ".git"), "gitdir: nowhere\n");
  const repo = fakeRepo();
  const daemon = daemonFor(ws, { upgrade: { runner: repoRunner(repo, ws.root), pollMs: 5 } });
  return { ws, repo, daemon };
}

describe("host.upgrade in the daemon", () => {
  it("reports the checkout, and refuses an update on a host that opted out", T, async () => {
    const { repo, daemon } = opened("[update]\nallow_remote = false\n");
    await daemon.start();
    const info = (await daemon.call("host.info", null, CORE)) as HostInfo;
    expect(info.checkout).toMatchObject({
      commit: sha(2),
      branch: "main",
      upstream: "origin/main",
    });
    expect(info.remote_update?.allowed).toBe(false);
    expect(info.remote_update?.reason).toContain("allow_remote");
    await expect(daemon.call("host.upgrade", { commit: sha(4) }, CORE)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
    });
    expect(repo.calls).toEqual([]);
  });

  it("takes it from Core only, and runs it on a host.toml without [update]", T, async () => {
    const { repo, daemon } = opened("");
    await daemon.start();
    expect(daemon.remoteUpdate()).toEqual({ allowed: true });
    await expect(daemon.call("host.upgrade", { commit: sha(4) }, OP)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
    });
    await expect(daemon.call("host.upgrade", { commit: "nope" }, CORE)).rejects.toThrow(/commit/);
    const job = await daemon.call("host.upgrade", { commit: sha(4), by: "panel" }, CORE);
    expect(job).toMatchObject({ target: sha(4), from: sha(2) });
    for (let i = 0; i < 200 && repo.head !== sha(4); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(repo.head).toBe(sha(4));
    let info = (await daemon.call("host.info", null, CORE)) as HostInfo;
    for (let i = 0; i < 200 && info.upgrade?.state !== "done"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      info = (await daemon.call("host.info", null, CORE)) as HostInfo;
    }
    expect(info.upgrade).toMatchObject({ state: "done", commit: sha(4), by: "panel" });
  });

  it("never updates the machine Core runs on", T, async () => {
    const { daemon } = opened("", [
      fake("core", "health.cjs", { port: "auto", command: ["{node}", "{service}/health.cjs"] }),
    ]);
    await daemon.start();
    const remote = daemon.remoteUpdate();
    expect(remote.allowed).toBe(false);
    expect(remote.reason).toContain("Core");
    await expect(daemon.call("host.upgrade", { commit: sha(4) }, CORE)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
    });
  });

  it("counts a Core reached at a local address as Core's machine too", T, async () => {
    const { daemon } = opened('[cluster]\nurl = "ws://127.0.0.1:7880/cluster-link"\n');
    await daemon.start();
    expect(daemon.remoteUpdate().allowed).toBe(false);
    expect(daemon.remoteUpdate().reason).toContain("Core");
  });

  it("has no checkout and no git where there is no .git", T, async () => {
    const ws = workspace([], "");
    let ran = 0;
    const daemon = daemonFor(ws, {
      upgrade: {
        runner: async () => {
          ran += 1;
          return { code: 0, missing: false, tail: [] };
        },
      },
    });
    await daemon.start();
    const info = (await daemon.call("host.info", null, CORE)) as HostInfo;
    expect(info.checkout).toBeNull();
    expect(info.remote_update?.allowed).toBe(false);
    expect(ran).toBe(0);
  });
});
