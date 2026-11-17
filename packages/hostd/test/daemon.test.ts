import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import {
  HOST_ERROR_CODE,
  HostInfoSchema,
  type HostServiceEvent,
  type HostServiceList,
  type HostServiceStatus,
} from "@miyoria/contracts/host";
import { afterEach, describe, expect, it } from "vitest";
import {
  type Daemon,
  type HostApi,
  HostRpcError,
  isLoopbackUrl,
  LINKS_CHANGED_REASON,
  type LinkHandle,
  pidAlive,
} from "../src/index.js";
import type { CoreLinkOptions } from "../src/link/index.js";
import { cleanup, daemonFor, fake, trackPidFile, until, workspace, writeIn } from "./fakes.js";

afterEach(cleanup);

const OP = { kind: "operator" } as const;
const T = { timeout: 40_000 };

async function list(daemon: Daemon): Promise<HostServiceStatus[]> {
  return ((await daemon.call("service.list", {}, OP)) as HostServiceList).services;
}

async function one(daemon: Daemon, name: string): Promise<HostServiceStatus> {
  const found = (await list(daemon)).find((s) => s.name === name);
  if (found === undefined) throw new Error(`no ${name}`);
  return found;
}

function stateIs(daemon: Daemon, name: string, ...states: string[]) {
  return until(
    async () => {
      const s = await one(daemon, name);
      return states.includes(s.state) ? s : undefined;
    },
    20_000,
    `${name} in ${states.join("/")}`,
  );
}

function listen(
  handler: Parameters<typeof createServer>[1],
): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({ server, port: typeof address === "object" && address !== null ? address.port : 0 });
    });
  });
}

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(() => r(undefined)));
});

describe("what Core may call directly", () => {
  it("knows a cluster address on this machine from one elsewhere", () => {
    expect(isLoopbackUrl("ws://127.0.0.1:7880/cluster-link")).toBe(true);
    expect(isLoopbackUrl("ws://localhost:7880/cluster-link")).toBe(true);
    expect(isLoopbackUrl("ws://[::1]:7880/cluster-link")).toBe(true);
    expect(isLoopbackUrl("wss://core.tailnet:7880/cluster-link")).toBe(false);
    expect(isLoopbackUrl("ws://192.168.1.10:7880/cluster-link")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
    expect(isLoopbackUrl(undefined)).toBe(false);
  });

  it(
    "advertises its own address to a Core on this machine, and none to one elsewhere",
    T,
    async () => {
      const started = async (hostExtra: string) => {
        const daemon = daemonFor(workspace([fake("a", "health.cjs")], hostExtra));
        await daemon.start();
        await daemon.call("service.start", { service: "a" }, OP);
        return stateIs(daemon, "a", "running");
      };
      const cluster = (url: string) => ["[cluster]", `url = "${url}"`, ""].join("\n");
      const near = await started(cluster("ws://127.0.0.1:1/cluster-link"));
      expect(near.advertised).toBe(near.url);

      const far = await started(cluster("wss://core.tailnet:7880/cluster-link"));
      expect(far.url).toBe(`http://127.0.0.1:${far.port}`);
      expect(far.advertised).toBeUndefined();

      const shown = await started(
        [
          cluster("wss://core.tailnet:7880/cluster-link"),
          "[network]",
          'advertise = "gpu-pc.tailnet"',
          "",
        ].join("\n"),
      );
      expect(shown.advertised).toBe(`http://gpu-pc.tailnet:${shown.port}`);
    },
  );
});

describe("start and health", () => {
  it("starts a service, reports it running and healthy, and stops it", T, async () => {
    const ws = workspace([fake("a", "health.cjs")]);
    const daemon = daemonFor(ws);
    await daemon.start();
    expect(await one(daemon, "a")).toMatchObject({ state: "stopped", healthy: false });
    await daemon.call("service.start", { service: "a" }, OP);
    const running = await stateIs(daemon, "a", "running");
    expect(running.healthy).toBe(true);
    expect(running.port).toBeGreaterThan(0);
    expect(running.pid).toBeGreaterThan(0);
    expect(running.url).toBe(`http://127.0.0.1:${running.port}`);
    // No cluster and no advertised address: nothing Core could call directly.
    expect(running.advertised).toBeUndefined();
    const info = HostInfoSchema.parse(await daemon.call("host.info", {}, OP));
    expect(info).toMatchObject({ name: "test-host", version: "test", gpu: null });

    const result = await daemon.call("service.stop", { service: "a" }, OP);
    expect(result).toEqual({ service: "a", state: "stopped" });
    expect(pidAlive(running.pid as number)).toBe(false);
  });

  it("waits for the services in `after` before starting", T, async () => {
    const ws = workspace([
      fake("slow", "health.cjs", { env: { DELAY_MS: "800" }, run: 'pass_env = ["ORDER_FILE"]' }),
      fake("late", "health.cjs", { run: 'after = ["slow"]\npass_env = ["ORDER_FILE"]' }),
    ]);
    const order = ws.file("order.log");
    const daemon = daemonFor(ws, { env: { ...process.env, ORDER_FILE: order } });
    await daemon.start();
    expect(daemon.serviceNames()).toEqual(["slow", "late"]);
    await daemon.startAll();
    await stateIs(daemon, "late", "running");
    const lines = readFileSync(order, "utf8").trim().split("\n");
    const at = (what: string) => {
      const line = lines.find((l) => l.startsWith(what));
      return Number(line?.split(" ")[2]);
    };
    expect(at("late spawn")).toBeGreaterThanOrEqual(at("slow ready"));
  });

  it("restarts with backoff, then gives up", T, async () => {
    const ws = workspace([
      fake("crash", "exit.cjs", {
        port: null,
        tables: "give_up = { failures = 3, window_s = 60 }",
      }),
    ]);
    const daemon = daemonFor(ws);
    const events: HostServiceEvent[] = [];
    daemon.onEvent((e) => events.push(e));
    await daemon.start();
    await daemon.call("service.start", { service: "crash" }, OP);
    const failed = await stateIs(daemon, "crash", "failed");
    expect(failed.restarts).toBe(3);
    expect(failed.reason).toMatch(/3 次/);
    const states = events.filter((e) => e.service === "crash").map((e) => e.state);
    expect(states).toEqual(["starting", "backoff", "starting", "backoff", "starting", "failed"]);
    const last = events.at(-1);
    expect(last?.log_tail?.join("\n")).toContain("bye from exit.cjs");

    // A manual start forgets the failures.
    await daemon.call("service.start", { service: "crash" }, OP);
    expect((await one(daemon, "crash")).restarts).toBe(0);
  });

  it("fails a start that never becomes healthy and counts it", T, async () => {
    const ws = workspace([
      fake("mute", "never.cjs", {
        health: 'http = "/health"\nstartup_s = 0.8',
        tables: 'policy = "never"',
      }),
    ]);
    const daemon = daemonFor(ws);
    await daemon.start();
    await daemon.call("service.start", { service: "mute" }, OP);
    const failed = await stateIs(daemon, "mute", "failed");
    expect(failed.reason).toMatch(/秒內沒有通過健康檢查/);
    expect(failed.pid).toBeUndefined();
  });

  it("restarts a running service that crashes", T, async () => {
    const ws = workspace([fake("flaky", "health.cjs")]);
    const daemon = daemonFor(ws, {
      timing: { pollMs: 100, processSettleMs: 300, failedProbes: 2 },
    });
    const events: HostServiceEvent[] = [];
    daemon.onEvent((e) => events.push(e));
    await daemon.start();
    await daemon.call("service.start", { service: "flaky" }, OP);
    const running = await stateIs(daemon, "flaky", "running");
    // Kill the process behind hostd's back: with `on-failure` the exit is a failure.
    process.kill(running.pid as number, "SIGKILL");
    await until(() => events.some((e) => e.service === "flaky" && e.state === "backoff"));
    const again = await stateIs(daemon, "flaky", "running");
    expect(again.pid).not.toBe(running.pid);
  });
});

describe("stop", () => {
  it("kills the whole process tree", T, async () => {
    const ws = workspace([
      fake("tree", "spawner.cjs", { port: null, env: { PID_FILE: "PLACEHOLDER" } }),
    ]);
    const pidFile = ws.file("grandchild.pid");
    trackPidFile(pidFile);
    // The descriptor's env cannot know the temp path; give it through host.toml.
    writeIn(
      ws,
      "host.toml",
      `name = "t"\n[services.tree]\nenv = { PID_FILE = ${JSON.stringify(pidFile)} }\n`,
    );
    const daemon = daemonFor(ws);
    await daemon.start();
    await daemon.call("service.start", { service: "tree" }, OP);
    const running = await stateIs(daemon, "tree", "running");
    const grandchild = await until(() => {
      try {
        return Number(readFileSync(pidFile, "utf8")) || undefined;
      } catch {
        return undefined;
      }
    });
    expect(pidAlive(grandchild)).toBe(true);
    await daemon.call("service.stop", { service: "tree" }, OP);
    await until(() => !pidAlive(grandchild), 10_000, "grandchild gone");
    expect(pidAlive(running.pid as number)).toBe(false);
  });

  it("kills the tree of a service started through a shim", T, async () => {
    const win = process.platform === "win32";
    const shim = win ? "shim.cmd" : "shim.sh";
    const ws = workspace([
      fake("shimmed", "spawner.cjs", { port: null, command: [`{service}/${shim}`] }),
    ]);
    if (win) {
      writeIn(ws, `workers/shimmed/${shim}`, '@echo off\r\nnode "%~dp0spawner.cjs"\r\n');
    } else {
      writeIn(
        ws,
        `workers/shimmed/${shim}`,
        '#!/bin/sh\nnode "$(dirname "$0")/spawner.cjs"\n',
        0o755,
      );
    }
    const pidFile = ws.file("grandchild.pid");
    trackPidFile(pidFile);
    writeIn(
      ws,
      "host.toml",
      `name = "t"\n[services.shimmed]\nenv = { PID_FILE = ${JSON.stringify(pidFile)} }\n`,
    );
    const daemon = daemonFor(ws);
    await daemon.start();
    await daemon.call("service.start", { service: "shimmed" }, OP);
    await stateIs(daemon, "shimmed", "running");
    const grandchild = await until(() => {
      try {
        return Number(readFileSync(pidFile, "utf8")) || undefined;
      } catch {
        return undefined;
      }
    });
    await daemon.call("service.stop", { service: "shimmed" }, OP);
    await until(() => !pidAlive(grandchild), 10_000, "grandchild gone");
  });

  it("kills a service that ignores the polite stop after the grace period", T, async () => {
    const ws = workspace([fake("stubborn", "health.cjs", { env: { IGNORE_TERM: "1" } })]);
    const daemon = daemonFor(ws);
    await daemon.start();
    await daemon.call("service.start", { service: "stubborn" }, OP);
    const running = await stateIs(daemon, "stubborn", "running");
    const t0 = Date.now();
    await daemon.call("service.stop", { service: "stubborn" }, OP);
    expect(pidAlive(running.pid as number)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(12_000);
  });
});

describe("ports", () => {
  it(
    "reports a healthy program on the preferred port as foreign and leaves it alone",
    T,
    async () => {
      const { server, port } = await listen((_req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end('{"status":"ok"}');
      });
      servers.push(server);
      const ws = workspace([fake("taken", "health.cjs", { port })]);
      const daemon = daemonFor(ws);
      await daemon.start();
      expect(await daemon.call("service.start", { service: "taken" }, OP)).toEqual({
        service: "taken",
        state: "starting",
      });
      const foreign = await stateIs(daemon, "taken", "foreign");
      expect(foreign.reason).toMatch(String(port));
      expect(foreign.pid).toBeUndefined();
      // `down` leaves it alone.
      expect(await daemon.call("service.stop", { service: "taken" }, OP)).toEqual({
        service: "taken",
        state: "foreign",
      });
    },
  );

  it("fails the start when the port is taken by something that does not answer", T, async () => {
    const { server, port } = await listen((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    servers.push(server);
    const ws = workspace([fake("blocked", "health.cjs", { port, tables: 'policy = "never"' })]);
    const daemon = daemonFor(ws);
    await daemon.start();
    await daemon.call("service.start", { service: "blocked" }, OP);
    const failed = await stateIs(daemon, "blocked", "failed");
    expect(failed.reason).toMatch(/in-use/);
  });
});

describe("logs", () => {
  it("writes the service's output to its log file and returns the tail", T, async () => {
    const ws = workspace([fake("talky", "health.cjs")]);
    const daemon = daemonFor(ws);
    const followed: string[] = [];
    await daemon.start();
    daemon.followLogs("talky", (line) => followed.push(line));
    await daemon.call("service.start", { service: "talky" }, OP);
    await stateIs(daemon, "talky", "running");
    await until(() => followed.some((l) => l.includes("hello on stderr")));
    const { lines } = (await daemon.call("service.logs", { service: "talky", lines: 50 }, OP)) as {
      lines: string[];
    };
    expect(lines.some((l) => l.includes("talky listening on"))).toBe(true);
    expect(lines.some((l) => l.includes("hello on stderr"))).toBe(true);
    await daemon.call("service.stop", { service: "talky" }, OP);
    await daemon.stop();
    const file = readFileSync(join(ws.state, "logs", "talky.log"), "utf8");
    expect(file).toContain("talky listening on");
    expect(file).toMatch(/hostd 啟動 talky/);
    expect(readFileSync(join(ws.state, "logs", "hostd.log"), "utf8")).toContain("hostd started");
  });
});

describe("guard", () => {
  it("refuses a guarded stop while the state is active, unless forced", T, async () => {
    const ws = workspace([fake("voice", "health.cjs", { run: 'guard = ["singing"]' })]);
    const daemon = daemonFor(ws);
    await daemon.start();
    daemon.setGuardSource({ states: async () => ["singing"] });
    await daemon.call("service.start", { service: "voice" }, OP);
    await stateIs(daemon, "voice", "running");
    const refused = await daemon
      .call("service.restart", { service: "voice" }, OP)
      .catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(HostRpcError);
    expect((refused as HostRpcError).code).toBe(HOST_ERROR_CODE.Guarded);
    expect((refused as HostRpcError).message).toMatch(/singing/);
    expect((await one(daemon, "voice")).state).toBe("running");

    // Unknown states need force too.
    daemon.setGuardSource({
      states: async () => {
        throw new Error("no link");
      },
    });
    await expect(daemon.call("service.stop", { service: "voice" }, OP)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.Guarded,
    });
    // A state that is not in the guard list does not block.
    daemon.setGuardSource({ states: async () => ["live"] });
    expect(await daemon.call("service.stop", { service: "voice", force: false }, OP)).toEqual({
      service: "voice",
      state: "stopped",
    });
    daemon.setGuardSource({ states: async () => ["singing"] });
    await daemon.call("service.start", { service: "voice" }, OP);
    await stateIs(daemon, "voice", "running");
    expect(await daemon.call("service.stop", { service: "voice", force: true }, OP)).toEqual({
      service: "voice",
      state: "stopped",
    });
  });

  it("asks Core's public status by default when Core runs here", T, async () => {
    const ws = workspace([
      fake("core", "health.cjs", {
        env: { CORE_STATE: "singing", CORE_LIVE: "1" },
        health: 'http = "/api/health"\nstartup_s = 15\ninterval_s = 1',
        run: 'guard = ["singing", "live"]',
      }),
    ]);
    const daemon = daemonFor(ws);
    await daemon.start();
    await daemon.call("service.start", { service: "core" }, OP);
    await stateIs(daemon, "core", "running");
    const refused = (await daemon
      .call("service.stop", { service: "core" }, OP)
      .catch((e: unknown) => e)) as HostRpcError;
    expect(refused.code).toBe(HOST_ERROR_CODE.Guarded);
    expect(refused.data).toEqual({ states: ["singing", "live"] });
    await daemon.call("service.stop", { service: "core", force: true }, OP);
  });
});

describe("node links", () => {
  const LINK_ENV = { LINK_URL: "{link:voice.url}", LINK_TOKEN: "{link:voice.token}" };
  const VOICE = { port: 7879, path: "/voice-link", token: "tok-1" };

  async function envOf(daemon: Daemon, name: string): Promise<Record<string, string>> {
    const s = await stateIs(daemon, name, "running");
    return (await (await fetch(`http://127.0.0.1:${s.port}/env`)).json()) as Record<string, string>;
  }

  it(
    "gives a node Core's link values, restarting it once when they arrive or change",
    T,
    async () => {
      const ws = workspace(
        [fake("node", "health.cjs", { env: LINK_ENV }), fake("plain", "health.cjs")],
        '[cluster]\nurl = "wss://core.tailnet:7880/cluster-link"\n',
      );
      const daemon = daemonFor(ws);
      await daemon.start();
      await daemon.startAll();
      const before = await envOf(daemon, "node");
      expect(before.LINK_URL).toBeUndefined();
      expect(before.LINK_TOKEN).toBeUndefined();
      const firstPid = (await one(daemon, "node")).pid;
      const plainPid = (await stateIs(daemon, "plain", "running")).pid;

      daemon.setLinks({ voice: VOICE });
      const after = await until(async () => {
        const s = await one(daemon, "node");
        if (s.state !== "running" || s.pid === firstPid) return undefined;
        return envOf(daemon, "node");
      });
      expect(after.LINK_URL).toBe("wss://core.tailnet:7879/voice-link");
      expect(after.LINK_TOKEN).toBe("tok-1");
      // A service that uses no link is left alone.
      expect((await one(daemon, "plain")).pid).toBe(plainPid);

      // The same values again: nothing happens.
      const secondPid = (await one(daemon, "node")).pid;
      daemon.setLinks({ voice: VOICE });
      await new Promise((r) => setTimeout(r, 500));
      expect((await one(daemon, "node")).pid).toBe(secondPid);

      // A new token: one more restart.
      daemon.setLinks({ voice: { ...VOICE, token: "tok-2" } });
      const changed = await until(async () => {
        const s = await one(daemon, "node");
        if (s.state !== "running" || s.pid === secondPid) return undefined;
        return envOf(daemon, "node");
      });
      expect(changed.LINK_TOKEN).toBe("tok-2");
    },
  );

  it(
    "does not restart a node while its guard is active; its status says it needs one",
    T,
    async () => {
      const ws = workspace(
        [fake("node", "health.cjs", { env: LINK_ENV, run: 'guard = ["live", "singing"]' })],
        '[cluster]\nurl = "ws://core:7880/cluster-link"\n',
      );
      const daemon = daemonFor(ws);
      await daemon.start();
      daemon.setGuardSource({ states: async () => ["live"] });
      await daemon.startAll();
      const pid = (await stateIs(daemon, "node", "running")).pid;

      daemon.setLinks({ voice: VOICE });
      const noted = await until(async () => {
        const s = await one(daemon, "node");
        return s.reason === LINKS_CHANGED_REASON ? s : undefined;
      });
      expect(noted.state).toBe("running");
      expect(noted.pid).toBe(pid);
      expect((await envOf(daemon, "node")).LINK_URL).toBeUndefined();

      // The operator restarts it (the guard is over): it starts with the values, the note is gone.
      daemon.setGuardSource({ states: async () => [] });
      await daemon.call("service.restart", { service: "node" }, OP);
      const env = await until(async () => {
        const s = await one(daemon, "node");
        if (s.state !== "running" || s.pid === pid) return undefined;
        return envOf(daemon, "node");
      });
      expect(env.LINK_URL).toBe("ws://core:7879/voice-link");
      expect((await one(daemon, "node")).reason).toBeUndefined();

      // Without a guard state active, a change restarts it by itself.
      const now = (await one(daemon, "node")).pid;
      daemon.setLinks({ voice: { ...VOICE, token: "tok-9" } });
      const next = await until(async () => {
        const s = await one(daemon, "node");
        if (s.state !== "running" || s.pid === now) return undefined;
        return envOf(daemon, "node");
      });
      expect(next.LINK_TOKEN).toBe("tok-9");
    },
  );

  it("passes cluster.links from the control link to the daemon", T, async () => {
    const ws = workspace([fake("node", "health.cjs", { env: LINK_ENV })]);
    let api: HostApi | null = null;
    writeIn(ws, "data/host/host.key", JSON.stringify({ id: "h1", key: "k1" }));
    writeIn(
      ws,
      "host.toml",
      `name = "test-host"\n[cluster]\nurl = "ws://core:7880/cluster-link"\n[services.node]\nenabled = true\n`,
    );
    const daemon = daemonFor(ws, {
      linkFactory: (a) => {
        api = a;
        return { state: "connecting", start: () => {}, stop: async () => {} };
      },
    });
    await daemon.start();
    expect(api).toBe(daemon);
    (api as unknown as HostApi).setLinks?.({
      stage: { port: 7882, path: "/stage-link", token: "s" },
    });
    expect(daemon.linkValues()).toEqual({
      "stage.url": "ws://core:7882/stage-link",
      "stage.token": "s",
    });
  });
});

describe("shutdown", () => {
  it("stops every service in reverse start order", T, async () => {
    const ws = workspace([
      fake("first", "health.cjs"),
      fake("second", "health.cjs", { run: 'after = ["first"]' }),
    ]);
    let shutdown = false;
    const daemon = daemonFor(ws, {
      onShutdown: () => {
        shutdown = true;
      },
    });
    await daemon.start();
    await daemon.startAll();
    await stateIs(daemon, "second", "running");
    expect(await daemon.call("host.shutdown", {}, OP)).toEqual({ stopped: ["second", "first"] });
    await until(() => shutdown);
  });

  it("is not Core's to call", T, async () => {
    const ws = workspace([fake("a", "health.cjs")]);
    const daemon = daemonFor(ws);
    await daemon.start();
    await expect(daemon.call("host.shutdown", {}, { kind: "core" })).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
    });
    expect(await daemon.call("service.list", {}, { kind: "core" })).toBeDefined();
  });
});

describe("errors", () => {
  it("names unknown, not installed and invalid calls", T, async () => {
    const ws = workspace([fake("a", "health.cjs")]);
    writeIn(
      ws,
      "workers/other/service.toml",
      'name = "other"\nkind = "worker"\n[run]\ncommand = ["x"]\n',
    );
    const daemon = daemonFor(ws);
    await daemon.start();
    await expect(daemon.call("service.start", { service: "nope" }, OP)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.UnknownService,
    });
    await expect(daemon.call("service.start", { service: "other" }, OP)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotInstalled,
    });
    await expect(daemon.call("service.start", {}, OP)).rejects.toMatchObject({ code: -32602 });
    await expect(daemon.call("gpu.acquire", {}, OP)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
    });
    await expect(daemon.call("gpu.nope", {}, OP)).rejects.toMatchObject({ code: -32601 });
    await expect(daemon.call("nope", {}, OP)).rejects.toMatchObject({ code: -32601 });
  });
});

describe("control link", () => {
  function fakeLinks() {
    const made: Array<{
      options: CoreLinkOptions;
      api: HostApi;
      started: number;
      stopped: number;
    }> = [];
    const factory = (api: HostApi, options: CoreLinkOptions): LinkHandle => {
      const record = { options, api, started: 0, stopped: 0 };
      made.push(record);
      return {
        get state() {
          return record.stopped > 0 ? "stopped" : record.started > 0 ? "connecting" : "stopped";
        },
        start: () => {
          record.started += 1;
        },
        stop: async () => {
          record.stopped += 1;
        },
      };
    };
    return { made, factory };
  }

  it("dials Core only with [cluster] url and a host key, and hangs up on shutdown", T, async () => {
    const ws = workspace(
      [fake("a", "health.cjs")],
      '[cluster]\nurl = "ws://127.0.0.1:1/cluster-link"\n',
    );
    const none = fakeLinks();
    const without = daemonFor(ws, { linkFactory: none.factory });
    await without.start();
    expect(none.made).toEqual([]);
    expect(((await without.call("host.info", {}, OP)) as { link?: string }).link).toBe("none");
    await without.stop();

    writeIn(ws, "data/host/host.key", JSON.stringify({ id: "h1", key: "k1" }));
    const links = fakeLinks();
    const daemon = daemonFor(ws, { linkFactory: links.factory });
    await daemon.start();
    expect(links.made).toHaveLength(1);
    expect(links.made[0]?.options).toMatchObject({
      url: "ws://127.0.0.1:1/cluster-link",
      hostId: "h1",
      key: "k1",
      name: "test-host",
      version: "test",
    });
    expect(links.made[0]?.api).toBe(daemon);
    expect(links.made[0]?.started).toBe(1);
    expect(daemon.report({ withTokens: false }).link).toBe("connecting");
    await daemon.stop();
    expect(links.made[0]?.stopped).toBe(1);
  });

  it("does not dial without [cluster], even with a key", T, async () => {
    const ws = workspace([fake("a", "health.cjs")]);
    writeIn(ws, "data/host/host.key", JSON.stringify({ id: "h1", key: "k1" }));
    const links = fakeLinks();
    const daemon = daemonFor(ws, { linkFactory: links.factory });
    await daemon.start();
    expect(links.made).toEqual([]);
    expect(daemon.linkState).toBe("none");
  });

  it("host.relink hangs up the link and dials again with what the files say now", T, async () => {
    const ws = workspace([fake("a", "health.cjs")]);
    const links = fakeLinks();
    const daemon = daemonFor(ws, { linkFactory: links.factory });
    await daemon.start();
    expect(links.made).toEqual([]);
    expect(await daemon.call("host.relink", {}, OP)).toEqual({ link: "none" });

    // join wrote both files while the daemon ran
    writeIn(ws, "host.toml", 'name = "joined"\n[cluster]\nurl = "ws://127.0.0.1:1/cluster-link"\n');
    writeIn(ws, "data/host/host.key", JSON.stringify({ id: "h9", key: "k9" }));
    expect(await daemon.call("host.relink", {}, OP)).toEqual({ link: "connecting" });
    expect(links.made).toHaveLength(1);
    expect(links.made[0]?.options).toMatchObject({
      url: "ws://127.0.0.1:1/cluster-link",
      hostId: "h9",
      key: "k9",
      name: "joined",
    });
    expect(links.made[0]?.started).toBe(1);

    // a second call replaces the link: the old one is stopped, a new one started
    writeIn(ws, "data/host/host.key", JSON.stringify({ id: "h9", key: "k10" }));
    await daemon.call("host.relink", {}, OP);
    expect(links.made).toHaveLength(2);
    expect(links.made[0]?.stopped).toBe(1);
    expect(links.made[1]?.options.key).toBe("k10");
    expect(links.made[1]?.started).toBe(1);

    // [cluster] removed: the link is hung up and none is made
    writeIn(ws, "host.toml", 'name = "joined"\n');
    expect(await daemon.call("host.relink", {}, OP)).toEqual({ link: "none" });
    expect(links.made[1]?.stopped).toBe(1);
    expect(links.made).toHaveLength(2);

    // an unreadable host.toml leaves the daemon as it was
    writeIn(ws, "host.toml", "name = [");
    await expect(daemon.call("host.relink", {}, OP)).rejects.toMatchObject({ code: -32602 });
  });

  it("host.relink is for the operator only", T, async () => {
    const ws = workspace([fake("a", "health.cjs")]);
    const daemon = daemonFor(ws, { linkFactory: fakeLinks().factory });
    await daemon.start();
    await expect(daemon.call("host.relink", {}, { kind: "core" })).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
    });
  });

  it("accepts and ignores follow in service.logs (the link follows itself)", T, async () => {
    const ws = workspace([fake("a", "health.cjs")]);
    const daemon = daemonFor(ws);
    await daemon.start();
    expect(await daemon.call("service.logs", { service: "a", lines: 5, follow: true }, OP)).toEqual(
      {
        lines: [],
      },
    );
  });
});
