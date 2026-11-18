// service.install, service.remove and host.update inside a running daemon, with a fake `uv` that
// puts a copy of Node where the environment's Python goes, so the installed service really starts.

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  HOST_ERROR_CODE,
  type HostServiceInstallResult,
  type HostServiceList,
  type HostServiceRemoveResult,
  type HostUpdateResult,
} from "@miyoria/contracts/host";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandRunner,
  HostdClient,
  HostRpcError,
  pythonIn,
  type RunSpec,
  readInstallRecord,
} from "../src/index.js";
import {
  cleanup,
  daemonFor,
  fake,
  type TestWorkspace,
  until,
  workspace,
  writeIn,
} from "./fakes.js";

afterEach(cleanup);

const OP = { kind: "operator" } as const;
const T = { timeout: 60_000 };

const PYTHON_SERVICE = {
  port: "auto" as const,
  command: ["{python}", "{service}/health.cjs"],
  tables: '[install]\nruntime = "python"\nproject = "."\nextras = ["x"]',
};

/** A workspace with one installable service `py` that is in host.toml but has no environment. */
function installable(extra = ""): TestWorkspace {
  const ws = workspace([fake("py", "health.cjs", PYTHON_SERVICE)], extra);
  writeIn(ws, "workers/py/pyproject.toml", '[project]\nname = "py"\n');
  writeIn(ws, "workers/py/uv.lock", "lock one\n");
  return ws;
}

/** `uv sync` that copies Node to the interpreter of the environment. */
function fakeUv(): { runner: CommandRunner; calls: RunSpec[]; lines: string[] } {
  const calls: RunSpec[] = [];
  const lines = ["Resolved 1 package", "Installed 1 package"];
  const runner: CommandRunner = async (spec, hooks) => {
    calls.push(spec);
    for (const line of lines) hooks?.onLine?.(line);
    const python = pythonIn(spec.env.UV_PROJECT_ENVIRONMENT as string, process.platform);
    mkdirSync(dirname(python), { recursive: true });
    // A running Python cannot be overwritten on Windows, as with a real sync.
    if (!existsSync(python)) copyFileSync(process.execPath, python);
    return { code: 0, missing: false, tail: [] };
  };
  return { runner, calls, lines };
}

async function states(client: HostdClient): Promise<Record<string, string>> {
  const { services } = await client.call<HostServiceList>("service.list");
  return Object.fromEntries(services.map((s) => [s.name, s.state]));
}

describe("service.install", () => {
  it(
    "makes a service added while the daemon runs startable, with the output streamed to the caller",
    T,
    async () => {
      const ws = installable();
      const uv = fakeUv();
      const daemon = daemonFor(ws, { installDeps: { runner: uv.runner } });
      await daemon.start();
      const client = (await HostdClient.connect(ws.state)) as HostdClient;
      expect(await states(client)).toEqual({ py: "disabled" });
      await expect(client.call("service.start", { service: "py" })).resolves.toMatchObject({
        state: "disabled",
      });

      const seen: string[] = [];
      const result = await client.call<HostServiceInstallResult>(
        "service.install",
        { service: "py" },
        { onLine: (l) => seen.push(l) },
      );
      expect(result.ok).toBe(true);
      expect(result.runtime.state).toBe("synced");
      expect(seen).toEqual(uv.lines);
      expect((uv.calls[0] as RunSpec).args).toEqual(["sync", "--frozen", "--extra", "x"]);
      expect(readInstallRecord(join(ws.state, "envs", "py"))?.extras).toEqual(["x"]);

      // No restart of the daemon: the service has its new plan.
      expect(await states(client)).toEqual({ py: "stopped" });
      await client.call("service.start", { service: "py" });
      await until(async () => (await states(client)).py === "running", 20_000, "py running");
    },
  );

  it("adds a service that was not in host.toml when the daemon started", T, async () => {
    const ws = workspace([fake("a", "health.cjs"), fake("py", "health.cjs", PYTHON_SERVICE)]);
    writeIn(ws, "workers/py/pyproject.toml", '[project]\nname = "py"\n');
    writeIn(ws, "workers/py/uv.lock", "lock one\n");
    // host.toml starts with `a` only.
    writeIn(ws, "host.toml", 'name = "test-host"\n[services.a]\n');
    const uv = fakeUv();
    const daemon = daemonFor(ws, { installDeps: { runner: uv.runner } });
    await daemon.start();
    expect(daemon.serviceNames()).toEqual(["a"]);

    // Not in host.toml yet: refused.
    await expect(daemon.call("service.install", { service: "py" }, OP)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotInstalled,
    });
    await expect(daemon.call("service.install", { service: "ghost" }, OP)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.UnknownService,
    });

    writeIn(ws, "host.toml", 'name = "test-host"\n[services.a]\n[services.py]\n');
    const result = (await daemon.call(
      "service.install",
      { service: "py" },
      OP,
    )) as HostServiceInstallResult;
    expect(result.ok).toBe(true);
    expect(daemon.serviceNames()).toEqual(["a", "py"]);
    const started = await daemon.call("service.start", { service: "py" }, OP);
    expect(started).toMatchObject({ service: "py" });
    await until(
      async () =>
        ((await daemon.call("service.list", {}, OP)) as HostServiceList).services.find(
          (s) => s.name === "py",
        )?.state === "running",
      20_000,
      "py running",
    );
  });

  it("is for the operator only", T, async () => {
    const ws = installable();
    const daemon = daemonFor(ws, { installDeps: { runner: fakeUv().runner } });
    await daemon.start();
    for (const method of ["service.install", "service.remove", "host.update"]) {
      await expect(daemon.call(method, { service: "py" }, { kind: "core" })).rejects.toMatchObject({
        code: HOST_ERROR_CODE.NotAllowed,
      });
      await expect(
        daemon.call(method, { service: "py" }, { kind: "service", service: "py" }),
      ).rejects.toBeInstanceOf(HostRpcError);
    }
  });
});

describe("service.remove", () => {
  it("stops the service, deletes its environment and forgets it", T, async () => {
    const ws = installable();
    const daemon = daemonFor(ws, { installDeps: { runner: fakeUv().runner } });
    await daemon.start();
    await daemon.call("service.install", { service: "py" }, OP);
    await daemon.call("service.start", { service: "py" }, OP);
    await until(
      async () =>
        ((await daemon.call("service.list", {}, OP)) as HostServiceList).services.find(
          (s) => s.name === "py",
        )?.state === "running",
      20_000,
      "py running",
    );
    const env = join(ws.state, "envs", "py");
    expect(existsSync(env)).toBe(true);

    const result = (await daemon.call(
      "service.remove",
      { service: "py" },
      OP,
    )) as HostServiceRemoveResult;
    expect(result).toEqual({ service: "py", stopped: true, deleted_env: env });
    expect(existsSync(env)).toBe(false);
    expect(daemon.serviceNames()).toEqual([]);
  });

  it(
    "keeps the environment with keep_env, and a guard stops a removal of a busy service",
    T,
    async () => {
      const ws = workspace(
        [
          fake("py", "health.cjs", {
            ...PYTHON_SERVICE,
            run: 'guard = ["singing"]',
          }),
        ],
        "",
      );
      writeIn(ws, "workers/py/pyproject.toml", '[project]\nname = "py"\n');
      writeIn(ws, "workers/py/uv.lock", "lock one\n");
      const daemon = daemonFor(ws, { installDeps: { runner: fakeUv().runner } });
      await daemon.start();
      daemon.setGuardSource({ states: async () => ["singing"] });
      await daemon.call("service.install", { service: "py" }, OP);
      await daemon.call("service.start", { service: "py" }, OP);
      await until(
        async () =>
          ((await daemon.call("service.list", {}, OP)) as HostServiceList).services.find(
            (s) => s.name === "py",
          )?.state === "running",
        20_000,
        "py running",
      );
      await expect(daemon.call("service.remove", { service: "py" }, OP)).rejects.toMatchObject({
        code: HOST_ERROR_CODE.Guarded,
      });
      const env = join(ws.state, "envs", "py");
      expect(existsSync(env)).toBe(true);
      const done = (await daemon.call(
        "service.remove",
        { service: "py", force: true, keep_env: true },
        OP,
      )) as HostServiceRemoveResult;
      expect(done).toEqual({ service: "py", stopped: true });
      expect(existsSync(env)).toBe(true);
    },
  );
});

describe("host.update", () => {
  it(
    "syncs only the stale environments and picks up a changed descriptor on restart",
    T,
    async () => {
      const ws = installable();
      const uv = fakeUv();
      const daemon = daemonFor(ws, { installDeps: { runner: uv.runner } });
      await daemon.start();
      await daemon.call("service.install", { service: "py" }, OP);
      await daemon.call("service.start", { service: "py" }, OP);
      await until(
        async () =>
          ((await daemon.call("service.list", {}, OP)) as HostServiceList).services.find(
            (s) => s.name === "py",
          )?.state === "running",
        20_000,
        "py running",
      );
      expect(uv.calls).toHaveLength(1);

      const current = (await daemon.call("host.update", {}, OP)) as HostUpdateResult;
      expect(current.services.map((s) => [s.service, s.runtime.state])).toEqual([
        ["py", "current"],
      ]);
      expect(uv.calls).toHaveLength(1);

      writeIn(ws, "workers/py/uv.lock", "lock two\n");
      const stale = (await daemon.call("host.update", {}, OP)) as HostUpdateResult;
      expect(stale.services.map((s) => s.runtime.state)).toEqual(["synced"]);
      expect(uv.calls).toHaveLength(2);

      // The pull changed the descriptor; the restart uses the new one.
      const toml = ws.read("workers/py/service.toml");
      writeIn(
        ws,
        "workers/py/service.toml",
        toml.replace('FAKE_NAME = "py"', 'FAKE_NAME = "py", FROM_NEW_DESCRIPTOR = "yes"'),
      );
      await daemon.call("service.restart", { service: "py" }, OP);
      const port = await until(
        async () => {
          const s = ((await daemon.call("service.list", {}, OP)) as HostServiceList).services.find(
            (x) => x.name === "py",
          );
          return s?.state === "running" ? s.port : undefined;
        },
        20_000,
        "py running again",
      );
      const env = (await (await fetch(`http://127.0.0.1:${port}/env`)).json()) as Record<
        string,
        string
      >;
      expect(env.FROM_NEW_DESCRIPTOR).toBe("yes");
    },
  );

  it("leaves a user-managed environment alone", T, async () => {
    const ws = installable("");
    writeIn(
      ws,
      "host.toml",
      'name = "test-host"\n[services.py]\nenabled = true\npython = "own-env"\n',
    );
    const own = pythonIn(join(ws.root, "own-env"), process.platform);
    mkdirSync(dirname(own), { recursive: true });
    writeFileSync(own, "");
    const uv = fakeUv();
    const daemon = daemonFor(ws, { installDeps: { runner: uv.runner } });
    await daemon.start();
    const result = (await daemon.call("host.update", {}, OP)) as HostUpdateResult;
    expect(result.services[0]?.runtime.state).toBe("user-managed");
    expect(uv.calls).toHaveLength(0);
    rmSync(join(ws.root, "own-env"), { recursive: true, force: true });
  });
});

describe("install.files and starting", () => {
  const FILE = [
    "[[install.files]]",
    'path = "m/model.bin"',
    `url = "https://huggingface.co/o/r/resolve/${"a".repeat(40)}/model.bin"`,
    `sha256 = "${"0".repeat(64)}"`,
    "size = 4",
    'what = "a model"',
    'licence = "MIT"',
  ].join("\n");

  it("does not start a service whose file is missing, and says which", T, async () => {
    const ws = workspace([fake("a", "health.cjs", { tables: FILE })]);
    const daemon = daemonFor(ws);
    await daemon.start();
    const client = (await HostdClient.connect(ws.state)) as HostdClient;
    const { services } = await client.call<HostServiceList>("service.list");
    expect(services[0]).toMatchObject({
      state: "disabled",
      reason: expect.stringContaining("缺少必要的檔案:m/model.bin"),
    });
    await expect(client.call("service.start", { service: "a" })).resolves.toMatchObject({
      state: "disabled",
    });

    writeIn(ws, "data/host/models/m/model.bin", "abcd");
    await client.call("service.start", { service: "a" });
    await until(async () => (await states(client)).a === "running", 20_000, "a running");

    // The file goes while it is stopped: the next start is refused.
    await client.call("service.stop", { service: "a" });
    rmSync(ws.file("data/host/models/m/model.bin"));
    await expect(client.call("service.start", { service: "a" })).resolves.toMatchObject({
      state: "disabled",
    });
  });

  it("host.update downloads no files; service.install does", T, async () => {
    const ws = installable();
    writeIn(
      ws,
      "workers/py/service.toml",
      `${ws.read("workers/py/service.toml")}\n${FILE.replace('"m/model.bin"', '"m/py.bin"')}\n`,
    );
    const uv = fakeUv();
    const asked: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      asked.push(String(input));
      return new Response("abcd", { status: 200, headers: { "content-length": "4" } });
    }) as typeof fetch;
    const daemon = daemonFor(ws, {
      installDeps: { runner: uv.runner, fetchImpl, freeBytes: () => 10 * 1024 ** 3 },
    });
    await daemon.start();
    const updated = (await daemon.call("host.update", {}, OP)) as HostUpdateResult;
    expect(updated.services[0]?.files).toEqual([{ path: "m/py.bin", state: "missing" }]);
    expect(asked).toEqual([]);
    const installed = (await daemon.call(
      "service.install",
      { service: "py", only_stale: true },
      OP,
    )) as HostServiceInstallResult;
    // The checksum in FILE is not the one of "abcd": fetched, refused, not kept.
    expect(installed.files[0]).toMatchObject({ path: "m/py.bin", state: "failed" });
    expect(asked).toHaveLength(1);
    expect(existsSync(join(ws.state, "models", "m", "py.bin"))).toBe(false);
  });
});
