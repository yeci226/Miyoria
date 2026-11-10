// `DockerSandbox` with her workspace mounted and with the egress network, against the fake
// runner. What a real container does with the mounts and the network is in the Docker
// integration test (not run here).

import { mkdtempSync, rmSync } from "node:fs";
import { readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DockerSandbox,
  egressNetworkName,
  egressProxyName,
  SandboxConfigSchema,
  SandboxError,
} from "../src/index.js";
import { FakeRunner, mountSource, result } from "./fake-runner.js";

let root: string;
let runner: FakeRunner;
let events: Array<[string, unknown]>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miyoria-sandbox-ws-"));
  runner = new FakeRunner();
  events = [];
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sandbox(config: Record<string, unknown> = {}): DockerSandbox {
  return new DockerSandbox(SandboxConfigSchema.parse(config), {
    root,
    profile: "deepseek-chan",
    runner,
    hostUser: null,
    killGraceMs: 50,
    publisher: (topic, payload) => events.push([topic, payload]),
  });
}

async function errorOf(promise: Promise<unknown>): Promise<SandboxError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    return error as SandboxError;
  }
  throw new Error("expected a SandboxError");
}

const argValue = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];

describe("persistent workspace in runs", () => {
  it("mounts_the_same_directory_read_write_and_keeps_files_between_runs", async () => {
    const sbx = sandbox();
    const dir = join(root, "profiles", "deepseek-chan", "workspace");
    runner.onRun = async (args) => {
      const mounted = mountSource(args, "/workspace") as string;
      await writeFile(join(mounted, "counter.txt"), `${runner.calledWith("run").length}`);
      return result({ stdout: Buffer.from("ok\n") });
    };
    await sbx.run({ language: "python", code: "x", mount_workspace: true });
    await sbx.run({ language: "python", code: "x", mount_workspace: true });
    const [first, second] = runner.calledWith("run");
    for (const args of [first, second]) {
      expect(args?.some((a) => a === `type=bind,source=${dir},target=/workspace`)).toBe(true);
    }
    expect(await readFile(join(dir, "counter.txt"), "utf8")).toBe("2");
    // The workspace outlives the run directories, and the tools see it too.
    expect((await sbx.workspace?.read("counter.txt"))?.text).toBe("2");
  });

  it("mounts_nothing_unless_asked", async () => {
    const sbx = sandbox();
    await sbx.run({ language: "python", code: "x" });
    expect(runner.calledWith("run")[0]?.some((a) => a.includes("target=/workspace"))).toBe(false);
  });

  it("does_not_use_a_warm_container_for_a_run_with_the_workspace", async () => {
    const sbx = sandbox({ pool_size: 1 });
    sbx.warm();
    await new Promise((r) => setTimeout(r, 30));
    await sbx.run({ language: "python", code: "x", mount_workspace: true });
    const runs = runner.calledWith("run");
    const last = runs.at(-1);
    expect(last?.some((a) => a.includes("target=/workspace"))).toBe(true);
    await sbx.close();
  });

  it("removes_a_link_and_trims_files_a_program_left_over_the_quota_and_says_so", async () => {
    const sbx = sandbox({ workspace: { max_file_kb: 1, max_files: 3 } });
    const ws = sbx.workspace;
    if (!ws) throw new Error("no workspace");
    await ws.write("mine.txt", "keep me");
    runner.onRun = async (args) => {
      const mounted = mountSource(args, "/workspace") as string;
      await writeFile(join(mounted, "huge.bin"), Buffer.alloc(4096));
      for (const name of ["a.txt", "b.txt", "c.txt"]) {
        await writeFile(join(mounted, name), name);
        await new Promise((r) => setTimeout(r, 5));
      }
      try {
        await symlink(
          root,
          join(mounted, "planted"),
          process.platform === "win32" ? "junction" : "dir",
        );
      } catch {
        // no links here
      }
      return result({ stdout: Buffer.from("done\n") });
    };
    const out = await sbx.run({ language: "python", code: "x", mount_workspace: true });
    const reasons = (out.workspace_removed ?? []).map((r) => r.reason);
    expect(reasons).toContain("file_too_large");
    expect(reasons).toContain("over_quota");
    const left = (await ws.list()).entries.map((e) => e.path);
    expect(left).toContain("mine.txt");
    expect(left.length).toBeLessThanOrEqual(3);
    await expect(
      stat(join(root, "profiles", "deepseek-chan", "workspace", "planted")),
    ).rejects.toThrow();
    expect(events.some(([topic]) => topic === "sandbox.workspace.enforced")).toBe(true);
  });

  it("checks_the_workspace_even_when_the_run_fails_and_leaves_no_key_without_a_mount", async () => {
    const sbx = sandbox();
    const plain = await sbx.run({ language: "python", code: "x" });
    expect("workspace_removed" in plain).toBe(false);
    const mounted = await sbx.run({ language: "python", code: "x", mount_workspace: true });
    expect(mounted.workspace_removed).toEqual([]);
  });

  it("refuses_a_workspace_in_a_session_or_when_it_is_off_or_full_of_entries", async () => {
    const sbx = sandbox();
    expect(
      (
        await errorOf(
          sbx.run({ language: "python", code: "x", session: "a", mount_workspace: true }),
        )
      ).kind,
    ).toBe("invalid_request");
    const off = sandbox({ workspace: { enabled: false } });
    expect(off.workspace).toBeNull();
    expect(
      (await errorOf(off.run({ language: "python", code: "x", mount_workspace: true }))).kind,
    ).toBe("invalid_request");
    const small = sandbox({ workspace: { max_files: 1 } });
    for (let i = 0; i < 110; i++) {
      await writeFile(
        join(await (small.workspace as NonNullable<typeof small.workspace>).ensure(), `f${i}`),
        "x",
      );
    }
    expect(
      (await errorOf(small.run({ language: "python", code: "x", mount_workspace: true }))).kind,
    ).toBe("limit");
    expect(runner.calledWith("run")).toHaveLength(0);
  });
});

describe("network allowlist", () => {
  const allow = { network: { allow: ["pypi.org", "*.pythonhosted.org"] } };

  it("is_closed_by_default_and_refuses_an_allowlist_request", async () => {
    const sbx = sandbox();
    expect(sbx.networkAllow).toEqual([]);
    const error = await errorOf(
      sbx.run({ language: "python", code: "x", network: { allow: ["pypi.org"] } }),
    );
    expect(error.kind).toBe("network_unsupported");
    await sbx.run({ language: "python", code: "x" });
    const args = runner.calledWith("run")[0] ?? [];
    expect(argValue(args, "--network")).toBe("none");
    expect(runner.calledWith("network")).toHaveLength(0);
  });

  it("refuses_hosts_that_are_not_in_the_configured_list_and_sessions", async () => {
    const sbx = sandbox(allow);
    expect(
      (
        await errorOf(
          sbx.run({ language: "python", code: "x", network: { allow: ["evil.example"] } }),
        )
      ).kind,
    ).toBe("invalid_request");
    expect(
      (
        await errorOf(
          sbx.run({
            language: "python",
            code: "x",
            session: "a",
            network: { allow: ["pypi.org"] },
          }),
        )
      ).kind,
    ).toBe("invalid_request");
    expect(runner.calledWith("run")).toHaveLength(0);
  });

  it("starts_an_internal_network_and_the_proxy_once_and_puts_the_run_on_that_network", async () => {
    const sbx = sandbox(allow);
    await sbx.run({ language: "python", code: "x", network: { allow: ["pypi.org"] } });
    await sbx.run({ language: "node", code: "x", network: { allow: ["pypi.org"] } });
    const network = egressNetworkName(sbx.instance);
    const proxy = egressProxyName(sbx.instance);
    // One network and one proxy for both runs; the network is internal.
    expect(runner.calledWith("network create")).toHaveLength(1);
    expect(runner.calledWith("network create")[0]).toContain("--internal");
    expect(runner.calledWith("network connect")).toHaveLength(1);
    expect(runner.calledWith("network connect")[0]).toEqual([
      "network",
      "connect",
      "--alias",
      "egress-proxy",
      network,
      proxy,
    ]);
    const proxyStart = runner.started.get(proxy);
    expect(proxyStart).toContain("EGRESS_ALLOW=pypi.org,*.pythonhosted.org");
    expect(runner.networks.has(network)).toBe(true);
    // The proxy is up before the run, and the run is on the internal network with the proxy env.
    const calls = runner.calls.map((c) => c.join(" "));
    const startAt = calls.findIndex((c) => c.startsWith("run --rm -d"));
    const runAt = calls.findIndex((c) => c.startsWith("run --rm -i"));
    expect(startAt).toBeGreaterThanOrEqual(0);
    expect(startAt).toBeLessThan(runAt);
    for (const args of runner.calledWith("run").filter((a) => a[2] === "-i")) {
      expect(argValue(args, "--network")).toBe(network);
      expect(args).toContain("HTTPS_PROXY=http://egress-proxy:3128");
      expect(args).toContain("--cap-drop");
    }
    // The node image runs the proxy: it is pulled/checked like a run's image.
    expect(proxyStart?.includes("node:24-slim")).toBe(true);
  });

  it("starts_the_proxy_again_when_it_died_and_a_run_without_network_never_touches_it", async () => {
    const sbx = sandbox(allow);
    await sbx.run({ language: "python", code: "x", network: { allow: ["pypi.org"] } });
    runner.running.delete(egressProxyName(sbx.instance));
    await sbx.run({ language: "python", code: "x", network: { allow: ["pypi.org"] } });
    expect(runner.calledWith("network create")).toHaveLength(1);
    expect(runner.started.size).toBe(1);
    expect(runner.running.has(egressProxyName(sbx.instance))).toBe(true);
    const before = runner.calls.length;
    await sbx.run({ language: "python", code: "x" });
    const added = runner.calls.slice(before).filter((c) => c[0] === "network");
    expect(added).toEqual([]);
  });

  it("fails_a_run_with_docker_failed_when_the_proxy_cannot_start_and_runs_nothing", async () => {
    const sbx = sandbox(allow);
    runner.startFails = true;
    const error = await errorOf(
      sbx.run({ language: "python", code: "x", network: { allow: ["pypi.org"] } }),
    );
    expect(error.kind).toBe("docker_failed");
    expect(runner.calledWith("run").filter((a) => a[2] === "-i")).toHaveLength(0);
  });

  it("tears_the_proxy_and_network_down_on_close_and_when_reaping_leftovers", async () => {
    const sbx = sandbox(allow);
    await sbx.run({ language: "python", code: "x", network: { allow: ["pypi.org"] } });
    await sbx.close();
    expect(runner.running.has(egressProxyName(sbx.instance))).toBe(false);
    expect(runner.networks.size).toBe(0);

    const next = sandbox(allow);
    runner.networks.add(egressNetworkName(next.instance));
    runner.psOutput = "0123456789ab\n";
    await next.reap();
    expect(runner.networks.size).toBe(0);
  });
});
