// Real containers for the workspace and the egress allowlist. Not run by default: set
// MIYORIA_LIVE_WORKSPACE_TESTS=1 with Docker running (the images are pulled if missing, and the
// network test needs the internet: it reaches pypi.org through the proxy). What it checks that
// the fake-runner tests cannot: the bind mount is writable by the container's uid, a link planted
// in /workspace is removed, and a program cannot reach anything but the allowed hosts.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox, ProcessDockerRunner, SandboxConfigSchema } from "../src/index.js";

function enabled(): boolean {
  if (process.env.MIYORIA_LIVE_WORKSPACE_TESTS !== "1") return false;
  const probe = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    timeout: 15_000,
    windowsHide: true,
    encoding: "utf8",
  });
  return probe.status === 0 && probe.stdout.trim() !== "";
}

describe.skipIf(!enabled())("workspace and egress (live Docker)", () => {
  let root: string;
  let sandbox: DockerSandbox;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "miyoria-workspace-live-"));
    sandbox = new DockerSandbox(
      SandboxConfigSchema.parse({ network: { allow: ["pypi.org", "*.pythonhosted.org"] } }),
      { root, profile: "deepseek-chan", runner: new ProcessDockerRunner("docker") },
    );
    await sandbox.ensureImage("python");
    await sandbox.ensureImage("node");
  }, 900_000);

  afterAll(async () => {
    await sandbox.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps_files_between_runs_and_removes_a_planted_link", async () => {
    const first = await sandbox.run({
      language: "python",
      mount_workspace: true,
      code: [
        "import os",
        "open('/workspace/a.txt', 'w').write('kept')",
        "os.symlink('/etc', '/workspace/etc-link')",
      ].join("\n"),
    });
    expect(first.exit_code).toBe(0);
    expect(first.workspace_removed?.map((r) => r.reason)).toContain("link");
    const second = await sandbox.run({
      language: "python",
      mount_workspace: true,
      code: "print(open('/workspace/a.txt').read())",
    });
    expect(second.stdout.trim()).toBe("kept");
    expect(existsSync(join(root, "profiles", "deepseek-chan", "workspace", "etc-link"))).toBe(
      false,
    );
  }, 120_000);

  it("reaches_only_the_allowed_hosts_through_the_proxy", async () => {
    const program = (url: string) =>
      [
        "import urllib.request",
        "try:",
        `    print('status', urllib.request.urlopen('${url}', timeout=20).status)`,
        "except Exception as e:",
        "    print('failed', type(e).__name__, e)",
      ].join("\n");
    const allowed = await sandbox.run({
      language: "python",
      network: { allow: ["pypi.org"] },
      code: program("https://pypi.org/simple/"),
      timeout_ms: 60_000,
    });
    expect(allowed.stdout).toContain("status 200");
    const refused = await sandbox.run({
      language: "python",
      network: { allow: ["pypi.org"] },
      code: program("https://example.com/"),
      timeout_ms: 60_000,
    });
    expect(refused.stdout).toContain("failed");
    // Ignoring the proxy leads nowhere: the network has no route out.
    const direct = await sandbox.run({
      language: "python",
      network: { allow: ["pypi.org"] },
      code: [
        "import socket",
        "try:",
        "    socket.create_connection(('1.1.1.1', 443), timeout=5)",
        "    print('connected')",
        "except Exception as e:",
        "    print('blocked', type(e).__name__)",
      ].join("\n"),
    });
    expect(direct.stdout).toContain("blocked");
  }, 300_000);
});
