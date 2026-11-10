// `miyoria install`: what it offers to install, the one question, resumable downloads.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as install from "../src/commands/install.js";
import { downloadFile, MODEL_FILES } from "../src/stack/downloads.js";
import type { Runner, RunResult } from "../src/stack/system.js";
import { type Output, setOutput } from "../src/ui.js";

const OK: RunResult = { code: 0, stdout: "", stderr: "", missing: false, timedOut: false };
const MISSING: RunResult = { code: null, stdout: "", stderr: "", missing: true, timedOut: false };

let dir: string;
let out: string[];
let restore: () => void;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-install-"));
  out = [];
  restore = setOutput({ out: (t) => out.push(t), err: (t) => out.push(t) } satisfies Output);
});
afterEach(() => {
  restore();
  rmSync(dir, { recursive: true, force: true });
});

function repo(toml: string): string {
  writeFileSync(join(dir, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(dir, "workers"), { recursive: true });
  const p = join(dir, "miyoria.toml");
  writeFileSync(p, toml);
  return p;
}

describe("download", () => {
  const body = (text: string) =>
    new Response(text, { headers: { "content-length": String(text.length) } });

  it("downloads_to_the_expected_path_and_never_overwrites", async () => {
    const dest = join(dir, "m", "a.onnx");
    const url = MODEL_FILES[0]?.url as string;
    expect(await downloadFile(url, dest, (async () => body("hello")) as never)).toBe("downloaded");
    expect(readFileSync(dest, "utf8")).toBe("hello");
    expect(await downloadFile(url, dest, (async () => body("other")) as never)).toBe("exists");
    expect(readFileSync(dest, "utf8")).toBe("hello");
  });

  it("resumes_a_part_file_with_a_range_request", async () => {
    const dest = join(dir, "m", "b.onnx");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(`${dest}.part`, "hel");
    let range = "";
    const f = (async (_u: string, init?: RequestInit) => {
      range = String((init?.headers as Record<string, string> | undefined)?.range);
      return new Response("lo", { status: 206, headers: { "content-length": "2" } });
    }) as never;
    await downloadFile(MODEL_FILES[0]?.url as string, dest, f);
    expect(range).toBe("bytes=3-");
    expect(readFileSync(dest, "utf8")).toBe("hello");
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("refuses_a_host_that_is_not_listed_and_keeps_a_short_download_as_part", async () => {
    await expect(
      downloadFile("https://evil.example/x.onnx", join(dir, "x"), (async () => body("x")) as never),
    ).rejects.toThrow(/不在允許/);
    const dest = join(dir, "c.onnx");
    const short = (async () => new Response("ab", { headers: { "content-length": "5" } })) as never;
    await expect(downloadFile(MODEL_FILES[0]?.url as string, dest, short)).rejects.toThrow(
      /不完整/,
    );
    expect(existsSync(`${dest}.part`)).toBe(true);
    expect(existsSync(dest)).toBe(false);
  });

  it("only_lists_official_hosts", () => {
    for (const m of MODEL_FILES)
      expect(["huggingface.co", "raw.githubusercontent.com"]).toContain(new URL(m.url).hostname);
  });
});

describe("install plan", () => {
  function harness(opts: { pnpm?: boolean; python?: boolean; ffmpeg?: boolean } = {}) {
    const calls: string[] = [];
    const run: Runner = async (c, a) => {
      calls.push([c, ...a].join(" "));
      if (c === "pnpm" && a[0] === "--version")
        return opts.pnpm === false ? MISSING : { ...OK, stdout: "9.15.0" };
      if ((c === "py" || c === "python3" || c === "python") && a.includes("--version"))
        return opts.python === false ? MISSING : { ...OK, stdout: "Python 3.12.4" };
      if (c === "ffmpeg") return opts.ffmpeg === false ? MISSING : OK;
      if (c === "nvidia-smi") return MISSING;
      return OK;
    };
    return { calls, run };
  }

  it("lists_sizes_and_runs_nothing_until_the_single_question_is_answered", async () => {
    const configPath = repo(`[machine]\nroles = ["inference"]\n`);
    const { calls, run } = harness();
    let asked = 0;
    await install.run(
      configPath,
      { targets: [] },
      {
        run,
        platform: "win32",
        confirm: async () => {
          asked++;
          return false;
        },
      },
    );
    expect(asked).toBe(1);
    expect(out.join("\n")).toContain("約 3 GB");
    expect(out.join("\n")).toContain("沒有安裝任何東西");
    expect(calls.some((c) => c.includes("-m venv") || c.includes("pip install"))).toBe(false);
  });

  it("creates_the_venv_and_pip_installs_after_a_yes", async () => {
    const configPath = repo(`[machine]\nservices = ["turn"]\n`);
    const { calls, run } = harness();
    await install
      .run(
        configPath,
        { targets: [] },
        {
          run,
          platform: "win32",
          confirm: async () => true,
          fetchImpl: (async () =>
            new Response("x", { headers: { "content-length": "1" } })) as never,
        },
      )
      .catch(() => undefined);
    expect(calls.some((c) => c.startsWith("py -3.12 -m venv"))).toBe(true);
    expect(existsSync(join(dir, "workers", "models", "silero-vad", "silero_vad.onnx"))).toBe(true);
  });

  it("offers_pnpm_python_and_ffmpeg_when_missing_and_never_runs_sudo_on_linux", async () => {
    const configPath = repo(`[machine]\nservices = ["core", "sing"]\n`);
    const win = harness({ pnpm: false, python: false, ffmpeg: false });
    await install.run(
      configPath,
      { targets: [], dryRun: true },
      { run: win.run, platform: "win32", confirm: async () => true },
    );
    const text = out.join("\n");
    expect(text).toContain("corepack enable");
    expect(text).toContain("winget");
    expect(text).toContain("ffmpeg");
    out.length = 0;
    const lin = harness({ pnpm: false, python: false, ffmpeg: false });
    await install.run(
      configPath,
      { targets: [], dryRun: true },
      { run: lin.run, platform: "linux", confirm: async () => true },
    );
    expect(out.join("\n")).toContain("sudo apt install");
    expect(
      lin.calls.some((c) => c.startsWith("sudo") || c.startsWith("winget") || c.startsWith("apt")),
    ).toBe(false);
  });

  it("maps_packages_per_platform", () => {
    expect(install.installCommand(install.PKG.ffmpeg, "win32")?.[0]).toBe("winget");
    expect(install.installCommand(install.PKG.ffmpeg, "darwin")?.[0]).toBe("brew");
    expect(install.installCommand(install.PKG.ffmpeg, "linux")).toBeNull();
  });
});
