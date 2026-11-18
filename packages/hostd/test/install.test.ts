// The installer against a fake `uv` (an injected runner) and local servers: nothing is downloaded
// from the internet and no real environment is built.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommandRunner,
  environmentState,
  execaRunner,
  extrasOf,
  INSTALL_RECORD_FILE,
  type InstallDeps,
  inspectService,
  installSectionHash,
  installService,
  type LoadedHostConfig,
  loadCatalog,
  loadHostConfig,
  lockHash,
  managedEnvDir,
  pythonIn,
  type RunSpec,
  readInstallRecord,
  removeService,
  uvInstallHint,
} from "../src/index.js";
import { TMP } from "./fakes.js";

let root: string;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  root = mkdtempSync(join(TMP, "inst-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function write(path: string, text: string): string {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

const ASR = `name = "asr"
kind = "worker"
[install]
runtime = "python"
project = "."
extras = ["qwen3"]
system = ["ffmpeg"]
[[install.models]]
repo = "Qwen/Qwen3-ASR-0.6B"
[[install.manual]]
path = "workers/voices/{voice}/ref.wav"
what = "voice sample"
[run]
command = ["{python}", "server.py"]
env = { TTS_DEFAULT_VOICE = "alice" }
`;

function workspace(hostToml: string, services: Record<string, string> = { asr: ASR }) {
  for (const [name, toml] of Object.entries(services)) {
    write(`workers/${name}/service.toml`, toml);
    write(`workers/${name}/pyproject.toml`, '[project]\nname = "x"\n');
    write(`workers/${name}/uv.lock`, `lock of ${name}\n`);
  }
  write("host.toml", hostToml);
  const host = loadHostConfig(join(root, "host.toml"));
  const catalog = loadCatalog(root);
  return { host, catalog };
}

interface Call {
  spec: RunSpec;
}

/** Plays `uv sync`: creates the interpreter where UV_PROJECT_ENVIRONMENT points. */
function fakeUv(options: { code?: number; missing?: boolean; lines?: string[] } = {}) {
  const calls: Call[] = [];
  const runner: CommandRunner = async (spec, hooks) => {
    calls.push({ spec });
    if (options.missing) return { code: null, missing: true, tail: [] };
    for (const line of options.lines ?? ["Resolved 3 packages", "Installed 3 packages"]) {
      hooks?.onLine?.(line);
    }
    if ((options.code ?? 0) === 0) {
      const dir = spec.env.UV_PROJECT_ENVIRONMENT as string;
      const python = pythonIn(dir, "linux");
      mkdirSync(dirname(python), { recursive: true });
      writeFileSync(python, "");
    }
    return { code: options.code ?? 0, missing: false, tail: ["last line of uv"] };
  };
  return { runner, calls };
}

function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  return {
    root,
    platform: "linux",
    env: { PATH: bin, SECRET_KEY: "no", UV_CACHE_DIR: "/cache", HOME: "/home/x" },
    now: () => new Date("2026-01-02T03:04:05Z"),
    ...over,
  };
}

function entryOf(catalog: ReturnType<typeof loadCatalog>, name: string) {
  const entry = catalog.services.get(name);
  if (entry === undefined) throw new Error(`no ${name}`);
  return entry;
}

describe("uv sync", () => {
  it("runs uv sync --frozen in the project folder with the extras and the environment uv needs", async () => {
    const { host, catalog } = workspace(
      'name = "h"\n[paths]\nca_bundle = "certs/ca.pem"\n[services.asr]\n',
    );
    const uv = fakeUv();
    const lines: string[] = [];
    const result = await installService(
      entryOf(catalog, "asr"),
      host,
      deps({ runner: uv.runner }),
      { onLine: (l) => lines.push(l) },
    );
    expect(result.runtime).toMatchObject({
      state: "synced",
      dir: join(host.state.root, "envs", "asr"),
      extras: ["qwen3"],
    });
    expect(lines).toEqual(["Resolved 3 packages", "Installed 3 packages"]);
    expect(uv.calls).toHaveLength(1);
    const { spec } = uv.calls[0] as Call;
    expect(spec.file).toBe("uv");
    expect(spec.args).toEqual(["sync", "--frozen", "--extra", "qwen3"]);
    expect(spec.cwd).toBe(join(root, "workers", "asr"));
    expect(spec.env).toMatchObject({
      UV_PROJECT_ENVIRONMENT: join(host.state.root, "envs", "asr"),
      UV_NATIVE_TLS: "1",
      UV_CACHE_DIR: "/cache",
      SSL_CERT_FILE: join(root, "certs", "ca.pem"),
      REQUESTS_CA_BUNDLE: join(root, "certs", "ca.pem"),
      TMP: join(host.state.root, "tmp"),
      TEMP: join(host.state.root, "tmp"),
      HOME: "/home/x",
    });
    expect(spec.env.SECRET_KEY).toBeUndefined();
    expect(existsSync(join(host.state.root, "tmp"))).toBe(true);
  });

  it("takes the extras from the option, else host.toml, else the descriptor", async () => {
    const { host, catalog } = workspace('name = "h"\n[services.asr]\nextras = ["sensevoice"]\n');
    const entry = entryOf(catalog, "asr");
    expect(extrasOf(entry, host)).toEqual(["sensevoice"]);
    const uv = fakeUv();
    await installService(entry, host, deps({ runner: uv.runner }));
    expect((uv.calls[0] as Call).spec.args).toEqual(["sync", "--frozen", "--extra", "sensevoice"]);
    await installService(entry, host, deps({ runner: uv.runner }), { extras: ["a", "b"] });
    expect((uv.calls[1] as Call).spec.args).toEqual([
      "sync",
      "--frozen",
      "--extra",
      "a",
      "--extra",
      "b",
    ]);
    const plain = workspace('name = "h"\n[services.asr]\n').host;
    expect(extrasOf(entry, plain)).toEqual(["qwen3"]);
  });

  it("writes the install record, and notices what changes after it", async () => {
    const { host, catalog } = workspace('name = "h"\n[services.asr]\n');
    const entry = entryOf(catalog, "asr");
    const uv = fakeUv();
    await installService(entry, host, deps({ runner: uv.runner }));
    const dir = managedEnvDir(host, "asr");
    const record = readInstallRecord(dir);
    expect(record).toEqual({
      lock_sha256: lockHash(join(root, "workers", "asr")),
      extras: ["qwen3"],
      install_sha256: installSectionHash(entry.descriptor.install),
      installed_at: "2026-01-02T03:04:05.000Z",
    });
    expect(existsSync(join(dir, INSTALL_RECORD_FILE))).toBe(true);
    const wanted = {
      envDir: dir,
      projectDir: join(root, "workers", "asr"),
      extras: ["qwen3"],
      install: entry.descriptor.install,
      platform: "linux" as const,
    };
    expect(environmentState(wanted)).toEqual({ state: "ready", reasons: [] });

    write("workers/asr/uv.lock", "a newer lock\n");
    expect(environmentState(wanted).reasons).toEqual(["uv.lock changed"]);
    write("workers/asr/uv.lock", "lock of asr\n");
    expect(environmentState({ ...wanted, extras: ["sensevoice"] }).state).toBe("stale");
    expect(
      environmentState({
        ...wanted,
        install: { ...wanted.install, system: ["ffmpeg", "sox"] },
      }).reasons,
    ).toEqual(["the descriptor's [install] section changed"]);

    rmSync(pythonIn(dir, "linux"));
    expect(environmentState(wanted).state).toBe("missing");
  });

  it("with only_stale leaves a current environment alone and syncs a stale one", async () => {
    const { host, catalog } = workspace('name = "h"\n[services.asr]\n');
    const entry = entryOf(catalog, "asr");
    const uv = fakeUv();
    await installService(entry, host, deps({ runner: uv.runner }));
    const again = await installService(entry, host, deps({ runner: uv.runner }), {
      onlyStale: true,
    });
    expect(again.runtime.state).toBe("current");
    expect(uv.calls).toHaveLength(1);
    write("workers/asr/uv.lock", "changed\n");
    const stale = await installService(entry, host, deps({ runner: uv.runner }), {
      onlyStale: true,
    });
    expect(stale.runtime.state).toBe("synced");
    expect(uv.calls).toHaveLength(2);
  });

  it("never syncs an environment host.toml names", async () => {
    const own = join(root, "my-venv");
    const python = pythonIn(own, "linux");
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "");
    const { host, catalog } = workspace('name = "h"\n[services.asr]\npython = "my-venv"\n');
    const uv = fakeUv();
    const result = await installService(entryOf(catalog, "asr"), host, deps({ runner: uv.runner }));
    expect(uv.calls).toHaveLength(0);
    expect(result.runtime).toMatchObject({ state: "user-managed", dir: own });
    expect(result.ok).toBe(true);
    expect(existsSync(join(host.state.root, "envs", "asr"))).toBe(false);
  });

  it("says how to install uv when it is missing, and that a failed sync failed", async () => {
    const { host, catalog } = workspace('name = "h"\n[services.asr]\n');
    const entry = entryOf(catalog, "asr");
    const missing = await installService(
      entry,
      host,
      deps({ runner: fakeUv({ missing: true }).runner }),
    );
    expect(missing.ok).toBe(false);
    expect(missing.runtime.state).toBe("uv-missing");
    expect(missing.runtime.detail).toContain(uvInstallHint("linux"));
    expect(uvInstallHint("win32")).toBe("winget install --id=astral-sh.uv -e");
    expect(uvInstallHint("linux")).toContain("astral.sh/uv/install.sh");

    const failed = await installService(entry, host, deps({ runner: fakeUv({ code: 2 }).runner }));
    expect(failed.ok).toBe(false);
    expect(failed.runtime.state).toBe("failed");
    expect(failed.runtime.detail).toContain("last line of uv");
    expect(readInstallRecord(managedEnvDir(host, "asr"))).toBeNull();
  });

  it("refuses a platform the descriptor does not list", async () => {
    const { host, catalog } = workspace('name = "h"\n[services.win]\n', {
      win: 'name = "win"\nkind = "worker"\nplatforms = ["win32"]\n[install]\nruntime = "python"\nproject = "."\n[run]\ncommand = ["x"]\n',
    });
    const uv = fakeUv();
    const result = await installService(entryOf(catalog, "win"), host, deps({ runner: uv.runner }));
    expect(result.runtime.state).toBe("unsupported");
    expect(result.ok).toBe(false);
    expect(uv.calls).toHaveLength(0);
  });

  it("builds nothing for node, binary and none, and only checks the rest", async () => {
    const { host, catalog } = workspace('name = "h"\n[services.n]\n', {
      n: 'name = "n"\nkind = "node"\n[install]\nruntime = "node"\nsystem = ["ffmpeg", "nothere"]\n[[install.manual]]\npath = "apps/n/.env"\nwhat = "a token"\n[run]\ncommand = ["x"]\n',
    });
    write("bin/ffmpeg", "");
    const uv = fakeUv();
    const result = await installService(entryOf(catalog, "n"), host, deps({ runner: uv.runner }));
    expect(uv.calls).toHaveLength(0);
    expect(result.runtime.state).toBe("none");
    expect(result.ok).toBe(true);
    expect(result.system).toEqual([
      { program: "ffmpeg", found: true },
      { program: "nothere", found: false },
    ]);
    expect(result.manual).toEqual([
      { path: join(root, "apps", "n", ".env"), what: "a token", present: false },
    ]);
    write("apps/n/.env", "X=1");
    expect(inspectService(entryOf(catalog, "n"), host, deps()).manual[0]?.present).toBe(true);
  });

  it("gives a missing ffmpeg the install command of the platform, nothing is installed", () => {
    const { host, catalog } = workspace('name = "h"\n[services.asr]\n');
    const entry = entryOf(catalog, "asr");
    const win = inspectService(entry, host, deps({ platform: "win32" }));
    expect(win.system).toEqual([
      { program: "ffmpeg", found: false, hint: "winget install --id=Gyan.FFmpeg -e" },
    ]);
    expect(inspectService(entry, host, deps()).system[0]?.hint).toContain("apt install ffmpeg");
  });

  it("reports manual items with {voice} from host.toml, else the descriptor, and the models", () => {
    const { host, catalog } = workspace(
      'name = "h"\n[services.asr]\nenv = { TTS_DEFAULT_VOICE = "bob" }\n',
    );
    const entry = entryOf(catalog, "asr");
    write("workers/voices/bob/ref.wav", "x");
    const seen = inspectService(entry, host, deps());
    expect(seen.manual).toEqual([
      {
        path: join(root, "workers", "voices", "bob", "ref.wav"),
        what: "voice sample",
        present: true,
      },
    ]);
    expect(seen.models).toEqual([{ repo: "Qwen/Qwen3-ASR-0.6B", present: false }]);
    mkdirSync(join(host.state.models, "hf", "models--Qwen--Qwen3-ASR-0.6B", "snapshots", "abc"), {
      recursive: true,
    });
    expect(inspectService(entry, host, deps()).models[0]?.present).toBe(true);
  });

  it("looks for a model in the cache the service itself reads", () => {
    // A machine that kept its models where they were: host.toml points the service at them.
    const { host, catalog } = workspace(
      'name = "h"\n[services.asr]\nenv = { HF_HUB_CACHE = "data/models/hf" }\n',
    );
    const entry = entryOf(catalog, "asr");
    expect(inspectService(entry, host, deps()).models[0]?.present).toBe(false);
    mkdirSync(
      join(root, "data", "models", "hf", "models--Qwen--Qwen3-ASR-0.6B", "snapshots", "abc"),
      {
        recursive: true,
      },
    );
    expect(inspectService(entry, host, deps()).models[0]?.present).toBe(true);
  });
});

// ---- remove ------------------------------------------------------------------------------------

describe("removeService", () => {
  function managed(host: LoadedHostConfig, name: string): string {
    const python = pythonIn(managedEnvDir(host, name), process.platform);
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "");
    return managedEnvDir(host, name);
  }

  it("deletes the managed environment and nothing else", () => {
    const { host } = workspace('name = "h"\n[services.asr]\n');
    const dir = managed(host, "asr");
    mkdirSync(host.state.models, { recursive: true });
    writeFileSync(join(host.state.models, "keep.bin"), "model");
    const other = managed(host, "tts");
    expect(removeService(host, "asr")).toEqual({ deletedEnv: dir });
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(join(host.state.models, "keep.bin"))).toBe(true);
    expect(removeService(host, "asr")).toEqual({});
  });

  it("keeps the environment with keepEnv, and never touches the user's own", () => {
    const own = join(root, "venv");
    mkdirSync(own, { recursive: true });
    const { host } = workspace('name = "h"\n[services.asr]\npython = "venv"\n[services.tts]\n');
    expect(removeService(host, "asr").deletedEnv).toBeUndefined();
    expect(existsSync(own)).toBe(true);
    const dir = managed(host, "tts");
    expect(removeService(host, "tts", { keepEnv: true }).deletedEnv).toBeUndefined();
    expect(existsSync(dir)).toBe(true);
  });
});

// ---- the real runner ---------------------------------------------------------------------------

describe("execaRunner", () => {
  it("passes the output as lines, progress bars included, and the exit code", async () => {
    const lines: string[] = [];
    const outcome = await execaRunner(
      {
        file: process.execPath,
        args: ["-e", 'process.stdout.write("one\\ntwo 10%\\rtwo 90%\\r\\nthree"); process.exit(3)'],
        env: { PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "" },
      },
      { onLine: (l) => lines.push(l) },
    );
    expect(outcome.code).toBe(3);
    expect(outcome.missing).toBe(false);
    expect(lines).toEqual(["one", "two 10%", "two 90%", "three"]);
    expect(outcome.tail).toEqual(lines);
  });

  it("reports a program that does not exist as missing", async () => {
    const outcome = await execaRunner({
      file: `no-such-program-${process.pid}`,
      args: [],
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(outcome.missing).toBe(true);
    expect(outcome.code).toBeNull();
  });
});
