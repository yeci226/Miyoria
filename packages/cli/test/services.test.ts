// add, remove and models against a fake `uv` (an injected runner): no program is run, nothing is
// downloaded and no real environment is built. A real daemon runs in this process for the update
// tests, with a copy of Node standing in for the environment's Python.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { HostServiceList } from "@miyoria/contracts/host";
import {
  type CommandRunner,
  Daemon,
  HostdClient,
  hfCacheName,
  pythonIn,
  type RunSpec,
  readInstallRecord,
} from "@miyoria/hostd";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import * as host from "../src/commands/host.js";
import * as modelsCmd from "../src/commands/models.js";
import * as servicesCmd from "../src/commands/services.js";
import * as update from "../src/commands/update.js";
import { type Output, setOutput } from "../src/ui.js";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");

let dir: string;
let out: string[];
let restore: () => void;
const daemons: Daemon[] = [];

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  dir = mkdtempSync(join(TMP, "svc-"));
  // A checkout of its own, so nothing above it is taken for the source folder.
  write("pnpm-workspace.yaml", "packages: []\n");
  out = [];
  const sink: Output = { out: (t) => out.push(t), err: (t) => out.push(t) };
  restore = setOutput(sink);
});
afterEach(async () => {
  restore();
  for (const d of daemons.splice(0)) await d.stop();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function write(path: string, text: string): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

const text = () => out.join("");

const HEALTH = `
const http = require("node:http");
http.createServer((req, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"status":"ok"}'); })
  .listen(Number(process.env.PORT), "127.0.0.1", () => console.log("fake ready on " + process.env.PORT));
`;

/** `py`: a Python service with extras and one model; `plain`: a worker without an environment. */
function catalog(): void {
  write(
    "workers/py/service.toml",
    `name = "py"
kind = "worker"
summary = "A fake Python worker"
provides = ["py"]
[install]
runtime = "python"
project = "."
extras = ["x"]
[[install.models]]
repo = "Org/Name"
revision = "r1"
[run]
command = ["{python}", "{service}/server.cjs"]
port = "auto"
host_env = "HOST"
port_env = "PORT"
guard = ["singing"]
[run.health]
http = "/"
startup_s = 20
interval_s = 0.3
[run.stop]
grace_s = 1
`,
  );
  write("workers/py/server.cjs", HEALTH);
  write("workers/py/pyproject.toml", '[project]\nname = "py"\n');
  write("workers/py/uv.lock", "lock one\n");
  write(
    "workers/plain/service.toml",
    `name = "plain"
kind = "worker"
summary = "A worker with no environment"
[run]
command = ["{node}", "{service}/server.cjs"]
port = "auto"
port_env = "PORT"
[run.health]
http = "/"
`,
  );
  write("workers/plain/server.cjs", HEALTH);
}

interface Fake {
  runner: CommandRunner;
  calls: RunSpec[];
}

/** Plays `uv sync`: a file where the environment's Python goes (a copy of Node when `node`). */
function fakeUv(
  options: { node?: boolean; missing?: boolean; platform?: NodeJS.Platform } = {},
): Fake {
  const calls: RunSpec[] = [];
  const runner: CommandRunner = async (spec, hooks) => {
    calls.push(spec);
    if (options.missing) return { code: null, missing: true, tail: [] };
    hooks?.onLine?.("Installed 1 package");
    const python = pythonIn(
      spec.env.UV_PROJECT_ENVIRONMENT as string,
      options.platform ?? process.platform,
    );
    mkdirSync(dirname(python), { recursive: true });
    if (!existsSync(python)) {
      if (options.node) copyFileSync(process.execPath, python);
      else writeFileSync(python, "");
    }
    return { code: 0, missing: false, tail: [] };
  };
  return { runner, calls };
}

function deps(uv: Fake, platform?: NodeJS.Platform): servicesCmd.ServiceDeps {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  return {
    install: {
      runner: uv.runner,
      ...(platform !== undefined ? { platform } : {}),
      env: { PATH: bin },
    },
  };
}

const target = () => host.hostTarget(join(dir, "miyoria.toml"));
const hostToml = () => readFileSync(join(dir, "host.toml"), "utf8");
const envPython = (platform: NodeJS.Platform = process.platform) =>
  pythonIn(join(dir, "data", "host", "envs", "py"), platform);

describe("command line", () => {
  it("parses_add_remove_models_update_and_doctor_options", () => {
    const add = parseArgs(["add", "asr", "tts", "--no-install", "--extra", "sensevoice"]);
    expect(add.path.at(-1)?.name).toBe("add");
    expect(add.ctx.args).toEqual(["asr", "tts"]);
    expect(add.ctx.options).toMatchObject({ "no-install": true, extra: "sensevoice" });
    expect(parseArgs(["add"]).ctx.args).toEqual([]);

    const remove = parseArgs(["remove", "asr", "--keep-env", "--force", "--host-config", "h.toml"]);
    expect(remove.ctx.args).toEqual(["asr"]);
    expect(remove.ctx.options).toMatchObject({
      "keep-env": true,
      force: true,
      "host-config": "h.toml",
    });

    expect(parseArgs(["models", "pull", "asr", "tts"]).path.map((c) => c.name)).toEqual([
      "miyoria",
      "models",
      "pull",
    ]);
    expect(parseArgs(["models", "pull", "asr", "tts"]).ctx.args).toEqual(["asr", "tts"]);
    expect(parseArgs(["models", "ls"]).path.at(-1)?.name).toBe("ls");
    const gc = parseArgs(["models", "gc", "-y"]);
    expect(gc.path.at(-1)?.name).toBe("gc");
    expect(gc.ctx.yes).toBe(true);

    expect(parseArgs(["update", "--no-restart"]).ctx.options["no-restart"]).toBe(true);
    expect(parseArgs(["doctor", "--deep", "--fix"]).ctx.options).toMatchObject({
      deep: true,
      fix: true,
    });
  });

  it("has_no_install_command_any_more", () => {
    expect(parseArgs(["install"]).path.map((c) => c.name)).toEqual(["miyoria"]);
  });
});

describe("miyoria add", () => {
  it("creates_host_toml_with_the_machine_name_builds_the_environment_and_names_the_next_step", async () => {
    catalog();
    const uv = fakeUv();
    await servicesCmd.add(target(), { services: ["py"] }, deps(uv));
    const written = hostToml();
    expect(written).toMatch(/^name = "[^"]+"/);
    expect(written).toContain("[services.py]");
    expect(written).toContain("enabled = true");
    expect(uv.calls).toHaveLength(1);
    expect((uv.calls[0] as RunSpec).args).toEqual(["sync", "--frozen", "--extra", "x"]);
    expect(existsSync(envPython())).toBe(true);
    expect(readInstallRecord(join(dir, "data", "host", "envs", "py"))?.extras).toEqual(["x"]);
    expect(text()).toContain("miyoria up py");
    // The model is not downloaded by `add`: it is listed as still missing.
    expect(text()).toContain("Org/Name");
  });

  it("keeps_the_comments_and_the_other_tables_of_an_existing_host_toml", async () => {
    catalog();
    write(
      "host.toml",
      '# my machine\nname = "main-pc"\n\n# keep room for OBS\n[gpu]\nreserve_mb = 2000\n',
    );
    await servicesCmd.add(target(), { services: ["py"], noInstall: true }, deps(fakeUv()));
    const written = hostToml();
    expect(written).toContain("# my machine");
    expect(written).toContain("# keep room for OBS");
    expect(written).toContain('name = "main-pc"');
    expect(written).toContain("reserve_mb = 2000");
    expect(written).toContain("[services.py]");
  });

  it("lists_the_known_services_with_their_summaries_for_an_unknown_name", async () => {
    catalog();
    const uv = fakeUv();
    await expect(servicesCmd.add(target(), { services: ["nope"] }, deps(uv))).rejects.toThrow(
      /沒有叫 nope[\s\S]*py[\s\S]*A fake Python worker/,
    );
    expect(existsSync(join(dir, "host.toml"))).toBe(false);
    expect(uv.calls).toHaveLength(0);
  });

  it("only_edits_host_toml_with_no_install", async () => {
    catalog();
    const uv = fakeUv();
    await servicesCmd.add(target(), { services: ["py"], noInstall: true }, deps(uv));
    expect(uv.calls).toHaveLength(0);
    expect(hostToml()).toContain("[services.py]");
    expect(existsSync(envPython())).toBe(false);
    expect(text()).toContain("--no-install");
  });

  it("writes_extras_to_host_toml_and_syncs_them", async () => {
    catalog();
    const uv = fakeUv();
    await servicesCmd.add(target(), { services: ["py"], extras: ["y", "z"] }, deps(uv));
    expect(hostToml()).toMatch(/extras = \["y", "z"\]/);
    expect((uv.calls[0] as RunSpec).args).toEqual([
      "sync",
      "--frozen",
      "--extra",
      "y",
      "--extra",
      "z",
    ]);
    await expect(
      servicesCmd.add(target(), { services: ["py", "plain"], extras: ["y"] }, deps(uv)),
    ).rejects.toThrow(/--extra/);
  });

  it("lists_the_catalog_without_names", async () => {
    catalog();
    await servicesCmd.add(target(), { services: [] }, deps(fakeUv()));
    expect(text()).toContain("py");
    expect(text()).toContain("A fake Python worker");
    expect(text()).toContain("A worker with no environment");
    expect(existsSync(join(dir, "host.toml"))).toBe(false);
  });

  it("says_how_to_install_uv_when_it_is_missing_and_still_adds_the_service", async () => {
    catalog();
    await expect(
      servicesCmd.add(target(), { services: ["py"] }, deps(fakeUv({ missing: true }))),
    ).rejects.toThrow(/沒有裝好/);
    expect(text()).toMatch(/winget install|astral\.sh/);
    expect(hostToml()).toContain("[services.py]");
  });

  it("refuses_a_service_that_does_not_run_on_this_platform", async () => {
    catalog();
    await expect(
      servicesCmd.add(target(), { services: ["py"] }, deps(fakeUv(), "darwin")),
    ).rejects.toThrow(/只支援/);
  });
});

describe("miyoria remove", () => {
  it("deletes_the_environment_and_the_host_toml_table_and_keeps_the_models", async () => {
    catalog();
    const uv = fakeUv();
    await servicesCmd
      .add(target(), { services: ["py", "plain"], noInstall: false }, deps(uv))
      .catch(() => undefined);
    write("data/host/models/hf/models--Org--Name/snapshots/r1/w.bin", "weights");
    expect(existsSync(envPython())).toBe(true);
    await servicesCmd.remove(target(), { services: ["py"] }, deps(uv));
    expect(existsSync(join(dir, "data", "host", "envs", "py"))).toBe(false);
    expect(hostToml()).not.toContain("[services.py]");
    expect(hostToml()).toContain("[services.plain]");
    expect(existsSync(join(dir, "data/host/models/hf", hfCacheName("Org/Name")))).toBe(true);
  });

  it("keeps_the_environment_with_keep_env", async () => {
    catalog();
    const uv = fakeUv();
    await servicesCmd.add(target(), { services: ["py"] }, deps(uv));
    await servicesCmd.remove(target(), { services: ["py"], keepEnv: true }, deps(uv));
    expect(existsSync(envPython())).toBe(true);
    expect(hostToml()).not.toContain("[services.py]");
  });

  it("skips_a_service_that_is_not_in_host_toml_with_a_warning", async () => {
    catalog();
    write("host.toml", 'name = "pc"\n');
    await servicesCmd.remove(target(), { services: ["py"] }, deps(fakeUv()));
    expect(text()).toContain("[services.py]");
  });
});

describe("miyoria models", () => {
  it("lists_the_folder_with_sizes_and_who_uses_each_item", async () => {
    catalog();
    write("host.toml", 'name = "pc"\n[services.py]\n');
    write("data/host/models/hf/models--Org--Name/snapshots/r1/w.bin", "x".repeat(2048));
    write("data/host/models/hf/models--Other--Thing/snapshots/r2/w.bin", "x".repeat(1024));
    await modelsCmd.ls(target());
    expect(text()).toContain("Org/Name");
    expect(text()).toContain("py");
    expect(text()).toContain("Other/Thing");
    expect(text()).toContain("沒有服務用到");
  });

  it("gc_lists_what_no_enabled_service_uses_and_deletes_it_only_with_yes_or_a_confirmation", async () => {
    catalog();
    write("host.toml", 'name = "pc"\n[services.py]\n');
    const orphan = join(dir, "data/host/models/hf", hfCacheName("Other/Thing"));
    const kept = join(dir, "data/host/models/hf", hfCacheName("Org/Name"));
    write("data/host/models/hf/models--Org--Name/snapshots/r1/w.bin", "x");
    write("data/host/models/hf/models--Other--Thing/snapshots/r2/w.bin", "x");

    // No terminal and no --yes: nothing is deleted.
    await modelsCmd.gc(target(), {}, {});
    expect(existsSync(orphan)).toBe(true);
    // The user says no.
    await modelsCmd.gc(target(), {}, { confirm: async () => false });
    expect(existsSync(orphan)).toBe(true);
    await modelsCmd.gc(target(), { yes: true }, {});
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(kept)).toBe(true);
  });

  it("pull_runs_the_download_with_the_environment_python_and_names_a_missing_environment", async () => {
    catalog();
    write("host.toml", 'name = "pc"\n[services.py]\n');
    const calls: RunSpec[] = [];
    const runner: CommandRunner = async (spec) => {
      calls.push(spec);
      return { code: 0, missing: false, tail: ["/cache/snapshots/r1"] };
    };
    const pullDeps: modelsCmd.ModelDeps = {
      pull: { runner, platform: "linux", env: { PATH: "/bin" } },
    };
    // No environment yet: reported, not run.
    await expect(modelsCmd.pull(target(), { services: ["py"] }, pullDeps)).rejects.toThrow();
    expect(calls).toHaveLength(0);
    expect(text()).toContain("miyoria add py");

    const python = pythonIn(join(dir, "data", "host", "envs", "py"), "linux");
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "");
    out.length = 0;
    await modelsCmd.pull(target(), { services: ["py"] }, pullDeps);
    expect(calls).toHaveLength(1);
    expect((calls[0] as RunSpec).file).toBe(python);
    expect((calls[0] as RunSpec).args.slice(2)).toEqual(["Org/Name", "r1"]);
    expect((calls[0] as RunSpec).env.HF_HUB_CACHE).toBe(join(dir, "data", "host", "models", "hf"));
    expect(text()).toContain("Org/Name");
  });
});

describe("update: which services are touched", () => {
  const entry = (name: string, dirName: string, runtime: "python" | "none" = "python") =>
    ({
      name,
      dir: join("/r", "workers", dirName),
      file: "",
      descriptor: { install: { runtime } },
    }) as never;

  it("maps_changed_files_to_service_folders_and_shared_worker_modules_to_every_python_service", () => {
    const entries = [
      entry("asr", "asr"),
      entry("tts", "tts"),
      entry("stage", "../packages/stage", "none"),
    ];
    expect([...update.servicesChangedBy(["workers/asr/server.py"], entries, "/r")]).toEqual([
      "asr",
    ]);
    expect([...update.servicesChangedBy(["README.md"], entries, "/r")]).toEqual([]);
    expect([...update.servicesChangedBy(["workers/common.py"], entries, "/r")].sort()).toEqual([
      "asr",
      "tts",
    ]);
    expect([...update.servicesChangedBy(["packages/stage/src/a.ts"], entries, "/r")]).toEqual([
      "stage",
    ]);
  });

  it("plans_a_sync_for_a_stopped_stale_service_stop_sync_start_for_a_running_one_and_a_restart_for_a_changed_one", () => {
    const plan = update.planServiceUpdate({
      services: [
        { name: "a", stale: true, running: false, changed: false },
        { name: "b", stale: true, running: true, changed: true },
        { name: "c", stale: false, running: true, changed: true },
        { name: "d", stale: false, running: true, changed: false },
        { name: "e", stale: false, running: false, changed: true },
      ],
    });
    expect(plan).toEqual({ syncStopped: ["a"], syncAndRestart: ["b"], restart: ["c"] });
  });
});

describe("update: the services part", () => {
  const updateDeps = (uv: Fake, platform?: NodeJS.Platform): update.UpdateDeps => ({
    run: async () => ({ code: 0, stdout: "", stderr: "", missing: false, timedOut: false }),
    confirm: async () => true,
    env: { PATH: "/bin" },
    platform: process.platform,
    now: () => new Date(2026, 10, 16, 12, 0, 0),
    services: deps(uv, platform),
  });
  const config = () => join(dir, "miyoria.toml");

  async function installed(uv: Fake): Promise<void> {
    catalog();
    await servicesCmd.add(target(), { services: ["py"] }, deps(uv));
    uv.calls.length = 0;
    out.length = 0;
  }

  it("does_nothing_when_the_environment_matches_the_lock", async () => {
    const uv = fakeUv();
    await installed(uv);
    const failures = await update.updateServices(config(), {}, updateDeps(uv), null);
    expect(failures).toBe(0);
    expect(uv.calls).toHaveLength(0);
    expect(text()).toContain("一致");
  });

  it("syncs_a_stale_service_that_is_not_running_and_leaves_the_rest", async () => {
    const uv = fakeUv();
    await installed(uv);
    write("workers/py/uv.lock", "lock two\n");
    const failures = await update.updateServices(config(), {}, updateDeps(uv), null);
    expect(failures).toBe(0);
    expect(uv.calls).toHaveLength(1);
    expect((uv.calls[0] as RunSpec).args.slice(0, 2)).toEqual(["sync", "--frozen"]);
    expect(readInstallRecord(join(dir, "data", "host", "envs", "py"))?.lock_sha256).toBeDefined();
    out.length = 0;
    await update.updateServices(config(), {}, updateDeps(uv), null);
    expect(uv.calls).toHaveLength(1);
  });

  it("dry_run_says_what_it_would_do_and_runs_nothing", async () => {
    const uv = fakeUv();
    await installed(uv);
    write("workers/py/uv.lock", "lock two\n");
    await update.updateServices(config(), { dryRun: true }, updateDeps(uv), null);
    expect(uv.calls).toHaveLength(0);
    expect(text()).toContain("py");
    expect(text()).toContain("同步");
  });

  it("skips_the_part_without_a_host_toml", async () => {
    const uv = fakeUv();
    catalog();
    const failures = await update.updateServices(config(), {}, updateDeps(uv), null);
    expect(failures).toBe(0);
    expect(text()).toContain("host.toml");
  });

  describe("with a daemon", () => {
    async function running(uv: Fake) {
      await installed(uv);
      const t = target();
      const daemon = new Daemon({
        hostConfig: t.hostToml,
        catalogRoot: dir,
        configPath: t.configPath,
        miyoria: [process.execPath],
        version: "test",
        readGpu: async () => null,
        timing: { pollMs: 100 },
        onShutdown: () => {},
        installDeps: { runner: uv.runner },
      });
      daemons.push(daemon);
      await daemon.start();
      await host.up(t, { services: [] });
      const client = (await HostdClient.connect(join(dir, "data", "host"))) as HostdClient;
      const pid = async () =>
        (await client.call<HostServiceList>("service.list")).services.find((s) => s.name === "py")
          ?.pid;
      out.length = 0;
      return { daemon, client, pid };
    }

    it("restarts_a_running_service_whose_folder_changed_and_leaves_a_busy_one", {
      timeout: 90_000,
    }, async () => {
      const uv = fakeUv({ node: true });
      const { daemon, pid } = await running(uv);
      const before = await pid();
      expect(before).toBeDefined();
      const pulled = { root: dir, files: ["workers/py/server.cjs"] };

      // She is singing: reported, left running, with the command to restart it later.
      daemon.setGuardSource({ states: async () => ["singing"] });
      expect(await update.updateServices(config(), {}, updateDeps(uv), pulled)).toBe(0);
      expect(await pid()).toBe(before);
      expect(text()).toContain("miyoria restart py");

      // Not singing any more: it restarts.
      daemon.setGuardSource({ states: async () => [] });
      out.length = 0;
      expect(await update.updateServices(config(), {}, updateDeps(uv), pulled)).toBe(0);
      const after = await pid();
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
      expect(uv.calls).toHaveLength(0);
    });

    it("stops_syncs_and_starts_a_running_stale_service_one_at_a_time", {
      timeout: 90_000,
    }, async () => {
      const uv = fakeUv({ node: true });
      const { daemon, pid } = await running(uv);
      daemon.setGuardSource({ states: async () => [] });
      const before = await pid();
      write("workers/py/uv.lock", "lock two\n");
      const failures = await update.updateServices(config(), {}, updateDeps(uv), null);
      expect(failures).toBe(0);
      expect(uv.calls).toHaveLength(1);
      const after = await pid();
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
    });

    it("no_restart_syncs_but_leaves_every_service_running", { timeout: 90_000 }, async () => {
      const uv = fakeUv({ node: true });
      const { pid } = await running(uv);
      const before = await pid();
      write("workers/py/uv.lock", "lock two\n");
      const pulled = { root: dir, files: ["workers/py/server.cjs"] };
      expect(
        await update.updateServices(config(), { noRestart: true }, updateDeps(uv), pulled),
      ).toBe(0);
      expect(await pid()).toBe(before);
      expect(text()).toContain("--no-restart");
      expect(text()).toContain("miyoria restart py");
    });
  });
});
