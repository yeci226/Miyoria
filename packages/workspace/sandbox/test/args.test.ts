import { describe, expect, it } from "vitest";
import {
  buildRunArgs,
  CONTAINER_ENV,
  type ContainerSpec,
  defaultSandboxConfig,
  dockerCliEnv,
  entryCommand,
  InvalidSpecError,
  killArgs,
  listArgs,
  mountArg,
  ProcessDockerRunner,
  resolveUser,
  SandboxConfigSchema,
} from "../src/index.js";

function spec(over: Partial<ContainerSpec> = {}): ContainerSpec {
  return {
    name: "miyoria-sbx-01abc",
    image: "python:3.12-slim",
    labels: { "miyoria.sandbox": "1", "miyoria.sandbox.instance": "abc" },
    workDir: "C:\\data\\sandbox\\runs\\01ABC\\work",
    codeDir: "C:\\data\\sandbox\\runs\\01ABC\\code",
    toolsDir: null,
    user: "65534:65534",
    limits: defaultSandboxConfig().limits,
    command: entryCommand("python"),
    env: CONTAINER_ENV,
    ...over,
  };
}

/** Value following `flag`, for every occurrence. */
function values(args: string[], flag: string): string[] {
  const out: string[] = [];
  args.forEach((a, i) => {
    if (a === flag) out.push(args[i + 1] as string);
  });
  return out;
}

describe("buildRunArgs", () => {
  it("contains_every_hardening_flag", () => {
    const args = buildRunArgs(spec());
    expect(args.slice(0, 3)).toEqual(["run", "--rm", "-i"]);
    expect(values(args, "--name")).toEqual(["miyoria-sbx-01abc"]);
    expect(values(args, "--network")).toEqual(["none"]);
    expect(args).toContain("--read-only");
    expect(values(args, "--tmpfs")).toEqual(["/tmp:rw,noexec,nosuid,nodev,size=64m"]);
    expect(values(args, "--user")).toEqual(["65534:65534"]);
    expect(values(args, "--cap-drop")).toEqual(["ALL"]);
    expect(values(args, "--security-opt")).toEqual(["no-new-privileges"]);
    expect(values(args, "--pids-limit")).toEqual(["128"]);
    expect(values(args, "--memory")).toEqual(["256m"]);
    expect(values(args, "--memory-swap")).toEqual(["256m"]);
    expect(values(args, "--cpus")).toEqual(["1"]);
    expect(values(args, "--ipc")).toEqual(["none"]);
    expect(values(args, "--pull")).toEqual(["never"]);
    expect(values(args, "--log-driver")).toEqual(["none"]);
    expect(values(args, "--ulimit")).toEqual([`fsize=${16 * 1024 * 1024}`, "nofile=256:256"]);
    expect(args).toContain("--init");
    expect(values(args, "--workdir")).toEqual(["/work"]);
    expect(values(args, "--label")).toEqual(["miyoria.sandbox=1", "miyoria.sandbox.instance=abc"]);
  });

  it("mounts_only_work_read_write", () => {
    const args = buildRunArgs(spec({ toolsDir: "C:\\data\\tools" }));
    expect(values(args, "--mount")).toEqual([
      "type=bind,source=C:\\data\\sandbox\\runs\\01ABC\\work,target=/work",
      "type=bind,source=C:\\data\\sandbox\\runs\\01ABC\\code,target=/code,readonly",
      "type=bind,source=C:\\data\\tools,target=/tools,readonly",
    ]);
    // No other way of sharing host state.
    for (const flag of ["-v", "--volume", "--volumes-from", "--privileged", "--device", "--pid"]) {
      expect(args).not.toContain(flag);
    }
    expect(args.some((a) => a.startsWith("--network=") || a === "host")).toBe(false);
  });

  it("passes_only_explicit_env_and_runs_the_interpreter_without_a_shell", () => {
    const args = buildRunArgs(spec());
    expect(values(args, "--env")).toEqual(["HOME=/tmp", "TMPDIR=/tmp", "LANG=C.UTF-8"]);
    expect(args).not.toContain("--env-file");
    expect(args).not.toContain("-e");
    const image = args.indexOf("python:3.12-slim");
    expect(args.slice(image)).toEqual([
      "python:3.12-slim",
      "python3",
      "-I",
      "-B",
      "-u",
      "/code/main.py",
    ]);
    expect(args).not.toContain("sh");
    expect(args).not.toContain("-c");
    expect(entryCommand("node")).toEqual(["node", "/code/main.mjs"]);
  });

  it("quotes_mount_fields_that_could_add_options", () => {
    expect(mountArg(["type=bind", "source=C:\\a,readonly=false", "target=/work"])).toBe(
      'type=bind,"source=C:\\a,readonly=false",target=/work',
    );
    expect(mountArg(['source=a"b'])).toBe('"source=a""b"');
    const args = buildRunArgs(spec({ workDir: "/srv/x,target=/etc" }));
    expect(values(args, "--mount")[0]).toBe('type=bind,"source=/srv/x,target=/etc",target=/work');
  });

  it("rejects_values_that_could_be_flags", () => {
    expect(() => buildRunArgs(spec({ image: "--privileged" }))).toThrow(InvalidSpecError);
    expect(() => buildRunArgs(spec({ name: "-x" }))).toThrow(InvalidSpecError);
    expect(() => buildRunArgs(spec({ user: "0" }))).toThrow(InvalidSpecError);
    expect(() => buildRunArgs(spec({ user: "root" }))).toThrow(InvalidSpecError);
    expect(() => buildRunArgs(spec({ user: "0:0" }))).toThrow(InvalidSpecError);
    expect(() => buildRunArgs(spec({ env: { "A B": "1" } }))).toThrow(InvalidSpecError);
    expect(() => buildRunArgs(spec({ env: { OK: "a\nb" } }))).toThrow(InvalidSpecError);
    expect(() => buildRunArgs(spec({ command: [] }))).toThrow(InvalidSpecError);
    expect(() => SandboxConfigSchema.parse({ images: { python: "-v" } })).toThrow();
    expect(() => SandboxConfigSchema.parse({ user: "0:0" })).toThrow();
    expect(() => SandboxConfigSchema.parse({ user: "root" })).toThrow();
  });

  it("control_commands", () => {
    expect(killArgs("n")).toEqual(["kill", "--signal", "KILL", "n"]);
    expect(listArgs("abc")).toEqual([
      "ps",
      "-a",
      "-q",
      "--filter",
      "label=miyoria.sandbox=1",
      "--filter",
      "label=miyoria.sandbox.instance=abc",
    ]);
  });

  it("resolves_the_container_user", () => {
    expect(resolveUser("auto", null)).toBe("65534:65534");
    expect(resolveUser("auto", { uid: 0, gid: 0 })).toBe("65534:65534");
    expect(resolveUser("auto", { uid: 1000, gid: 1000 })).toBe("1000:1000");
    expect(resolveUser("1234:1234", { uid: 1000, gid: 1000 })).toBe("1234:1234");
  });
});

describe("dockerCliEnv", () => {
  it("keeps_only_what_the_cli_needs", () => {
    const env = dockerCliEnv({
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      DOCKER_HOST: "npipe:////./pipe/docker_engine",
      LLM_API_KEY: "sk-secret",
      DISCORD_BOT_TOKEN: "secret",
      MIYORIA_API_TOKEN: "secret",
      AWS_SECRET_ACCESS_KEY: "secret",
      EMPTY: undefined,
    });
    expect(env).toEqual({
      Path: "C:\\Windows",
      SystemRoot: "C:\\Windows",
      DOCKER_HOST: "npipe:////./pipe/docker_engine",
    });
  });
});

describe("ProcessDockerRunner", () => {
  // `node` stands in for the Docker CLI: same spawn path, no Docker needed.
  const node = (env: Record<string, string> = {}) =>
    new ProcessDockerRunner(process.execPath, { ...process.env, ...env });

  it("spawns_without_a_shell_and_without_secrets", async () => {
    const result = await node({ LLM_API_KEY: "sk-secret" }).exec(
      [
        "-e",
        "process.stdout.write(JSON.stringify([process.argv[1], process.env.LLM_API_KEY ?? null]))",
        "; echo pwned && $(whoami)",
      ],
      { maxOutputBytes: 1024 },
    );
    expect(result.exit_code).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual(["; echo pwned && $(whoami)", null]);
  });

  it("pipes_stdin_and_caps_output", async () => {
    let exceeded = 0;
    const result = await node().exec(
      [
        "-e",
        "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{process.stdout.write(s.repeat(1000));process.stderr.write('e')})",
      ],
      {
        stdin: "abcd",
        maxOutputBytes: 100,
        outputLimit: { bytes: 2000, onExceeded: () => exceeded++ },
      },
    );
    expect(result.stdout.toString()).toBe("abcd".repeat(25));
    expect(result.stdout_bytes).toBe(4000);
    expect(result.stderr.toString()).toBe("e");
    expect(exceeded).toBe(1);
  });

  it("reports_spawn_failures_and_aborts", async () => {
    const missing = await new ProcessDockerRunner("definitely-not-docker-xyz").exec(["version"], {
      maxOutputBytes: 10,
    });
    expect(missing.exit_code).toBeNull();
    expect(missing.error).toMatch(/ENOENT/);

    const controller = new AbortController();
    const pending = node().exec(["-e", "setTimeout(() => {}, 60000)"], {
      signal: controller.signal,
      maxOutputBytes: 10,
    });
    controller.abort();
    const aborted = await pending;
    expect(aborted.exit_code).not.toBe(0);
  });
});
