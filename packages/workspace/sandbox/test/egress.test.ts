// The egress proxy's program runs for real here, as a child `node` on loopback (no Docker); the
// Docker topology around it (`--internal` network, the proxy container) is covered by argument
// tests and by the integration test, which needs Docker.

import { type ChildProcess, spawn } from "node:child_process";
import { createServer, request, type Server } from "node:http";
import { connect, createServer as createTcp, type Server as NetServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRunArgs,
  defaultSandboxConfig,
  EGRESS_ALIAS,
  EGRESS_PROGRAM,
  egressProxyArgs,
  networkCreateArgs,
  proxyEnv,
  SandboxConfigSchema,
} from "../src/index.js";

const children: ChildProcess[] = [];
const servers: Array<Server | NetServer> = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
  for (const server of servers.splice(0)) server.close();
});

async function startProxy(env: Record<string, string>): Promise<number> {
  const child = spawn(process.execPath, ["-e", EGRESS_PROGRAM], {
    env: { PATH: process.env.PATH ?? "", EGRESS_PORT: "0", ...env },
    stdio: ["ignore", "pipe", "inherit"],
  });
  children.push(child);
  return await new Promise<number>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      const match = /listening (\d+)/.exec(chunk.toString());
      if (match) resolve(Number(match[1]));
    });
    child.once("exit", () => reject(new Error("proxy exited")));
  });
}

async function startTarget(): Promise<number> {
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`hello from ${req.headers.host}`);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

/** A plain HTTP request through the proxy, as a client with `HTTP_PROXY` would send it. */
async function viaProxy(proxy: number, url: string): Promise<{ status: number; body: string }> {
  return await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port: proxy, method: "GET", path: url, headers: { host: "x" } },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => {
          body += c.toString();
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

/** `CONNECT host:port`; resolves with the status line the proxy answers. */
function connectThrough(proxy: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxy, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (data) => {
      resolve(data.toString().split("\r\n")[0] ?? "");
      socket.destroy();
    });
    socket.once("error", reject);
  });
}

describe("egress proxy program", () => {
  it("forwards_an_allowed_host_and_refuses_everything_else", async () => {
    const target = await startTarget();
    const proxy = await startProxy({
      EGRESS_ALLOW: "localhost",
      EGRESS_PORTS: String(target),
      EGRESS_ALLOW_PRIVATE: "1",
    });
    const ok = await viaProxy(proxy, `http://localhost:${target}/x`);
    expect(ok.status).toBe(200);
    expect(ok.body).toBe(`hello from localhost:${target}`);
    // A host that is not on the list, even though it resolves to the same place.
    const other = await viaProxy(proxy, `http://127.0.0.1:${target}/x`);
    expect(other.status).toBe(403);
    // A port that is not on the list.
    const port = await viaProxy(proxy, `http://localhost:${target + 1}/x`);
    expect(port.status).toBe(403);
    // Not an absolute URL (a direct request to the proxy).
    const direct = await viaProxy(proxy, "/x");
    expect(direct.status).toBe(400);
  });

  it("tunnels_connect_only_to_allowed_hosts_and_ports", async () => {
    const tcp = createTcp((s) => s.end("up"));
    servers.push(tcp);
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    const port = (tcp.address() as { port: number }).port;
    const proxy = await startProxy({
      EGRESS_ALLOW: "localhost",
      EGRESS_PORTS: String(port),
      EGRESS_ALLOW_PRIVATE: "1",
    });
    expect(await connectThrough(proxy, `localhost:${port}`)).toBe(
      "HTTP/1.1 200 Connection Established",
    );
    expect(await connectThrough(proxy, `evil.example:${port}`)).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, `localhost:${port + 1}`)).toBe("HTTP/1.1 403 Forbidden");
  });

  it("matches_suffix_patterns_on_label_boundaries", async () => {
    const proxy = await startProxy({ EGRESS_ALLOW: "*.pythonhosted.org,pypi.org" });
    // Never resolves (refused before any lookup would matter), so only the 403s are asserted.
    expect(await connectThrough(proxy, "evilpythonhosted.org:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "pythonhosted.org:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "pypi.org.evil.example:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "files.pythonhosted.org.evil.example:443")).toBe(
      "HTTP/1.1 403 Forbidden",
    );
  });

  it("never_reaches_private_loopback_or_metadata_addresses_even_when_named_in_the_list", async () => {
    const target = await startTarget();
    const proxy = await startProxy({
      EGRESS_ALLOW: "localhost,127.0.0.1,169.254.169.254,10.0.0.1,192.168.1.1",
      EGRESS_PORTS: `${target},80,443`,
    });
    // `EGRESS_ALLOW_PRIVATE` is not set: a name on the list that resolves inside is still refused.
    expect((await viaProxy(proxy, `http://localhost:${target}/`)).status).toBe(403);
    expect((await viaProxy(proxy, `http://127.0.0.1:${target}/`)).status).toBe(403);
    expect(await connectThrough(proxy, "169.254.169.254:80")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "10.0.0.1:443")).toBe("HTTP/1.1 403 Forbidden");
    expect(await connectThrough(proxy, "192.168.1.1:443")).toBe("HTTP/1.1 403 Forbidden");
  });
});

describe("egress arguments", () => {
  const instance = "0123456789abcdef";

  it("creates_an_internal_network_and_hardens_the_proxy_container", () => {
    expect(networkCreateArgs("n", instance)).toContain("--internal");
    const config = SandboxConfigSchema.parse({
      network: { allow: ["pypi.org", "*.pythonhosted.org"] },
    });
    const args = egressProxyArgs({
      name: "p",
      instance,
      image: "node:24-slim",
      network: config.network,
    });
    const at = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-d"]);
    expect(at("--cap-drop")).toBe("ALL");
    expect(at("--user")).toBe("65534:65534");
    expect(args).toContain("--read-only");
    expect(at("--security-opt")).toBe("no-new-privileges");
    expect(at("--network")).toBe("bridge");
    expect(args).toContain("EGRESS_ALLOW=pypi.org,*.pythonhosted.org");
    expect(args).not.toContain("--privileged");
    // No bind mounts at all: the proxy sees nothing of the host.
    expect(args).not.toContain("--mount");
    expect(args).not.toContain("-v");
    expect(args.slice(-3)).toEqual(["node", "-e", EGRESS_PROGRAM]);
  });

  it("points_a_run_at_the_proxy_and_never_adds_a_flag_for_a_closed_network", () => {
    const env = proxyEnv(3128);
    expect(env.HTTPS_PROXY).toBe(`http://${EGRESS_ALIAS}:3128`);
    expect(env.https_proxy).toBe(env.HTTPS_PROXY);
    const base = {
      name: "miyoria-sbx-x",
      image: "python:3.12-slim",
      labels: {},
      workDir: "/w",
      codeDir: "/c",
      toolsDir: null,
      user: "65534:65534",
      limits: defaultSandboxConfig().limits,
      command: ["python3"],
      env,
    };
    const closed = buildRunArgs(base);
    expect(closed[closed.indexOf("--network") + 1]).toBe("none");
    const open = buildRunArgs({ ...base, network: "miyoria-sbx-net-0123456789abcdef" });
    expect(open[open.indexOf("--network") + 1]).toBe("miyoria-sbx-net-0123456789abcdef");
    expect(() => buildRunArgs({ ...base, network: "--privileged" })).toThrow();
    for (const bad of ["host", "bridge", "container:abc", "default"]) {
      expect(() => buildRunArgs({ ...base, network: bad }), bad).toThrow();
    }
  });

  it("accepts_only_host_names_in_the_allowlist", () => {
    const parse = (allow: string[]) =>
      SandboxConfigSchema.safeParse({ network: { allow } }).success;
    expect(parse(["pypi.org", "*.pythonhosted.org", "github.com"])).toBe(true);
    expect(parse([])).toBe(true);
    for (const bad of [
      "*",
      "*.com",
      "https://pypi.org",
      "pypi.org:443",
      "pypi.org/x",
      "a b.com",
      "localhost",
      "-x.com",
    ]) {
      expect(parse([bad]), bad).toBe(false);
    }
    expect(defaultSandboxConfig().network.allow).toEqual([]);
  });
});
