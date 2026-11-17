// `host autostart`: the exact command lines, the task and unit files, the name per workspace, and
// the states of on / off / status, all through an injected runner (nothing is registered).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import {
  type AutostartDeps,
  autostartOff,
  autostartOn,
  autostartStatus,
  entryName,
  planAutostart,
  systemdUnit,
  systemdWord,
  windowsArgs,
  workspaceId,
} from "../src/commands/autostart.js";
import { hostTarget } from "../src/commands/host.js";
import type { RunResult } from "../src/stack/system.js";
import { type Output, setOutput } from "../src/ui.js";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");
const SELF = ["C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\王小明\\app\\dist\\main.js"];

let dir: string;
let out: string[];
let restore: () => void;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  dir = mkdtempSync(join(TMP, "auto-"));
  out = [];
  const sink: Output = { out: (t) => out.push(t), err: (t) => out.push(t) };
  restore = setOutput(sink);
});
afterEach(() => {
  restore();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

const text = () => out.join("");

/** A workspace folder with a minimal host.toml; `name` may hold spaces and Chinese characters. */
function workspace(name: string): ReturnType<typeof hostTarget> {
  const root = join(dir, name);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "host.toml"), 'name = "pc"\n');
  writeFileSync(join(root, "miyoria.toml"), "");
  return hostTarget(join(root, "miyoria.toml"));
}

interface Call {
  command: string;
  args: string[];
}

const result = (code: number, extra: Partial<RunResult> = {}): RunResult => ({
  code,
  stdout: "",
  stderr: "",
  missing: false,
  timedOut: false,
  ...extra,
});

/** A system that remembers what was registered: query answers from it, create / delete change it. */
function fakeSystem(registered = false) {
  const calls: Call[] = [];
  const state = { registered };
  const runner: AutostartDeps["runner"] = async (command, args) => {
    calls.push({ command, args });
    const verb = args.find((a) => /^\/(create|delete|query)$/.test(a)) ?? args[1];
    if (command === "schtasks") {
      if (verb === "/query") return result(state.registered ? 0 : 1);
      if (verb === "/create") {
        state.registered = true;
        return result(0);
      }
      if (verb === "/delete") {
        state.registered = false;
        return result(0);
      }
    }
    if (command === "systemctl") {
      if (args.includes("is-enabled")) return result(state.registered ? 0 : 1);
      if (args.includes("enable")) state.registered = true;
      if (args.includes("disable")) state.registered = false;
      return result(0);
    }
    return result(1);
  };
  return { calls, state, runner };
}

function deps(
  platform: NodeJS.Platform,
  system = fakeSystem(),
  extra: Partial<AutostartDeps> = {},
) {
  const value: AutostartDeps = {
    platform,
    runner: system.runner,
    env: {
      SystemRoot: "C:\\Windows",
      PATH: "/usr/bin:/home/王 小明/bin",
      XDG_CONFIG_HOME: join(dir, "xdg"),
    },
    user: () => (platform === "win32" ? "PC\\王小明" : "owen"),
    self: () => (platform === "win32" ? SELF : ["/usr/bin/node", "/opt/miyoria/dist/main.js"]),
    daemonRunning: async () => false,
    confirm: null,
    yes: true,
    unitDir: join(dir, "units"),
    ...extra,
  };
  return { value, system };
}

describe("names", () => {
  it("is_stable_per_workspace_and_differs_between_workspaces", () => {
    const a = workspaceId("C:\\Users\\owenl\\Miyoria A", "win32");
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(workspaceId("c:/users/OWENL/miyoria a/", "win32")).toBe(a);
    expect(workspaceId("C:\\Users\\owenl\\Miyoria B", "win32")).not.toBe(a);
    // Case matters on Linux.
    expect(workspaceId("/home/a/Work", "linux")).not.toBe(workspaceId("/home/a/work", "linux"));
    expect(entryName(a)).toBe(`Miyoria-hostd-${a}`);
  });

  it("quotes_windows_and_systemd_words", () => {
    expect(windowsArgs(["C:\\a b\\x.exe", "王"])).toBe('"C:\\a b\\x.exe" "王"');
    expect(systemdWord('/a b/c%d$e"f\\g')).toBe('"/a b/c%%d$$e\\"f\\\\g"');
  });
});

describe("plan", () => {
  it("windows_runs_a_per_user_logon_task_from_an_xml_file", () => {
    const target = workspace("工作 區 one");
    const { value } = deps("win32");
    const plan = planAutostart(target, join(dir, "run"), value);
    const id = workspaceId(join(dir, "工作 區 one"), "win32");
    expect(plan.name).toBe(`Miyoria-hostd-${id}`);
    expect(plan.register).toEqual([
      {
        command: "schtasks",
        args: ["/create", "/tn", plan.name, "/xml", join(dir, "run", `autostart-${id}.xml`), "/f"],
      },
    ]);
    expect(plan.unregister).toEqual([
      { command: "schtasks", args: ["/delete", "/tn", plan.name, "/f"] },
    ]);
    expect(plan.command).toEqual([
      ...SELF,
      "hostd",
      "-c",
      target.configPath,
      "--host-config",
      target.hostToml,
      "--start",
    ]);

    const xml = (plan.file.content as Buffer).subarray(2).toString("utf16le");
    expect((plan.file.content as Buffer).subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(xml).toContain('encoding="UTF-16"');
    expect(xml).toContain("<LogonTrigger>");
    expect(xml.match(/<UserId>PC\\王小明<\/UserId>/g)).toHaveLength(2);
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).not.toContain("SYSTEM");
    expect(xml).toContain("<Command>C:\\Windows\\System32\\conhost.exe</Command>");
    expect(xml).toContain(
      `<Arguments>--headless &quot;C:\\Program Files\\nodejs\\node.exe&quot; &quot;C:\\Users\\王小明\\app\\dist\\main.js&quot; &quot;hostd&quot;`,
    );
    expect(xml).toContain(`&quot;${target.hostToml}&quot; &quot;--start&quot;</Arguments>`);
    expect(xml).toContain(`<WorkingDirectory>${join(dir, "工作 區 one")}</WorkingDirectory>`);
  });

  it("linux_writes_a_user_unit_that_restarts_on_failure", () => {
    const target = workspace("my work");
    const { value } = deps("linux");
    const plan = planAutostart(target, join(dir, "run"), value);
    const id = workspaceId(join(dir, "my work"), "linux");
    expect(plan.name).toBe(`Miyoria-hostd-${id}.service`);
    expect(plan.file.path).toBe(join(dir, "units", plan.name));
    expect(plan.register).toEqual([
      { command: "systemctl", args: ["--user", "daemon-reload"] },
      { command: "systemctl", args: ["--user", "enable", "--now", plan.name] },
    ]);
    expect(plan.unregister[0]).toEqual({
      command: "systemctl",
      args: ["--user", "disable", "--now", plan.name],
    });
    const unit = String(plan.file.content);
    expect(unit).toContain(`WorkingDirectory=${join(dir, "my work")}`);
    expect(unit).toContain(
      `ExecStart="/usr/bin/node" "/opt/miyoria/dist/main.js" "hostd" "-c" ${systemdWord(target.configPath)} "--host-config" ${systemdWord(target.hostToml)} "--start"`,
    );
    expect(unit).toContain('Environment="PATH=/usr/bin:/home/王 小明/bin"');
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("escapes_percent_signs_in_a_unit", () => {
    const unit = systemdUnit({ workspace: "/w/100%", command: ["/x", "a%b"], path: undefined });
    expect(unit).toContain("WorkingDirectory=/w/100%%");
    expect(unit).toContain('ExecStart="/x" "a%%b"');
  });

  it("macos_is_not_supported", async () => {
    const target = workspace("m");
    const { value } = deps("darwin");
    await expect(autostartOn(target, value)).rejects.toThrow(/macOS/);
  });
});

describe("on / off / status on windows", () => {
  it("registers_after_confirmation_and_prints_what_and_how_to_undo", async () => {
    const target = workspace("w one");
    const system = fakeSystem();
    const { value } = deps("win32", system, { yes: false, confirm: async () => true });
    await autostartOn(target, value);
    const create = system.calls.find((c) => c.args.includes("/create"));
    expect(create?.command).toBe("schtasks");
    expect(create?.args.slice(0, 2)).toEqual(["/create", "/tn"]);
    const xmlFile = create?.args[create.args.indexOf("/xml") + 1] as string;
    expect(existsSync(xmlFile)).toBe(true);
    expect(text()).toContain("schtasks /create /tn");
    expect(text()).toContain("miyoria host autostart off");
    expect(text()).toContain("schtasks /delete /tn");
    expect(text()).toContain("conhost.exe --headless");
  });

  it("changes_nothing_when_the_answer_is_no_or_there_is_no_terminal", async () => {
    const target = workspace("w two");
    const no = fakeSystem();
    await autostartOn(target, deps("win32", no, { yes: false, confirm: async () => false }).value);
    expect(no.calls.every((c) => c.args.includes("/query"))).toBe(true);
    expect(no.state.registered).toBe(false);
    expect(text()).toContain("沒有登錄");

    const none = fakeSystem();
    await expect(
      autostartOn(target, deps("win32", none, { yes: false, confirm: null }).value),
    ).rejects.toThrow(/-y/);
    expect(none.calls.every((c) => c.args.includes("/query"))).toBe(true);
  });

  it("on_twice_updates_the_same_task", async () => {
    const target = workspace("w three");
    const system = fakeSystem();
    const { value } = deps("win32", system);
    await autostartOn(target, value);
    await autostartOn(target, value);
    const creates = system.calls.filter((c) => c.args.includes("/create"));
    expect(creates).toHaveLength(2);
    expect(creates[0]).toEqual(creates[1]);
    expect(creates[0]?.args).toContain("/f");
    expect(text()).toContain("更新已有的登錄");
  });

  it("two_workspaces_get_two_tasks", async () => {
    const a = workspace("a");
    const b = workspace("b");
    const system = fakeSystem();
    const { value } = deps("win32", system);
    await autostartOn(a, value);
    await autostartOn(b, value);
    const names = system.calls.filter((c) => c.args.includes("/create")).map((c) => c.args[2]);
    expect(new Set(names).size).toBe(2);
  });

  it("off_removes_it_and_is_quiet_when_nothing_is_registered", async () => {
    const target = workspace("w four");
    const system = fakeSystem();
    const { value } = deps("win32", system);
    await autostartOff(target, value);
    expect(system.calls).toHaveLength(1);
    expect(system.calls[0]?.args[0]).toBe("/query");
    expect(text()).toContain("沒有要取消的");

    out.length = 0;
    await autostartOn(target, value);
    system.calls.length = 0;
    await autostartOff(target, value);
    expect(system.calls.map((c) => c.args[0])).toEqual(["/query", "/delete"]);
    expect(system.calls[1]?.args.slice(0, 2)).toEqual(["/delete", "/tn"]);
    expect(system.state.registered).toBe(false);
  });

  it("status_in_each_state", async () => {
    const target = workspace("w five");
    const system = fakeSystem();
    await autostartStatus(target, deps("win32", system).value);
    expect(text()).toContain("沒有登錄");
    expect(text()).toContain("沒有在執行");

    out.length = 0;
    await autostartOn(target, deps("win32", system).value);
    out.length = 0;
    await autostartStatus(target, deps("win32", system, { daemonRunning: async () => true }).value);
    expect(text()).toContain("已登錄");
    expect(text()).toContain("--start");
    expect(text()).toContain("執行中");

    // A different Node since it was written.
    out.length = 0;
    const moved = deps("win32", system, { self: () => ["D:\\node\\node.exe", "D:\\app\\main.js"] });
    await autostartStatus(target, moved.value);
    expect(text()).toContain("不一樣");
  });

  it("a_denied_creation_says_what_to_do_and_fails", async () => {
    const target = workspace("w six");
    const system = fakeSystem();
    const runner: AutostartDeps["runner"] = async (command, args) =>
      args.includes("/create")
        ? result(1, { stderr: "ERROR: Access is denied." })
        : system.runner(command, args);
    await expect(autostartOn(target, deps("win32", system, { runner }).value)).rejects.toThrow();
    expect(text()).toContain("系統管理員");
  });
});

describe("on / off / status on linux", () => {
  it("writes_the_unit_and_enables_it", async () => {
    const target = workspace("l one");
    const system = fakeSystem();
    const { value } = deps("linux", system);
    await autostartOn(target, value);
    const unit = join(
      dir,
      "units",
      `${entryName(workspaceId(join(dir, "l one"), "linux"))}.service`,
    );
    expect(readFileSync(unit, "utf8")).toContain("Restart=on-failure");
    expect(system.calls.map((c) => c.args.join(" "))).toEqual([
      expect.stringContaining("is-enabled"),
      "--user daemon-reload",
      expect.stringMatching(/^--user enable --now Miyoria-hostd-[0-9a-f]{8}\.service$/),
    ]);
    expect(text()).toContain("loginctl enable-linger");

    await autostartOff(target, value);
    expect(existsSync(unit)).toBe(false);
    expect(system.state.registered).toBe(false);
  });

  it("does_not_start_the_unit_now_when_a_hostd_is_already_running", async () => {
    const target = workspace("l two");
    const system = fakeSystem();
    await autostartOn(target, deps("linux", system, { daemonRunning: async () => true }).value);
    const enable = system.calls.find((c) => c.args.includes("enable"));
    expect(enable?.args).not.toContain("--now");
  });

  it("off_is_quiet_when_absent", async () => {
    const target = workspace("l three");
    const system = fakeSystem();
    await autostartOff(target, deps("linux", system).value);
    expect(system.calls).toHaveLength(1);
    expect(text()).toContain("沒有要取消的");
  });
});

describe("command line", () => {
  it("parses_the_autostart_commands_and_the_hostd_start_option", () => {
    expect(parseArgs(["host", "autostart", "on", "-y"]).path.map((c) => c.name)).toEqual([
      "miyoria",
      "host",
      "autostart",
      "on",
    ]);
    expect(parseArgs(["host", "autostart", "status"]).path.at(-1)?.name).toBe("status");
    expect(parseArgs(["hostd", "--start"]).ctx.options.start).toBe(true);
    expect(parseArgs(["hostd"]).ctx.options.start).toBeUndefined();
  });
});
