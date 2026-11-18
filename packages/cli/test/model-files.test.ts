// The model files of `[[install.files]]` in `add`, `update` and `doctor`: listed with sizes and
// licences and asked about once, `--yes` without asking, refused without a terminal, verified by
// doctor, fetched by `--fix`, and printed by `--print-hashes`. The downloads come from an in-memory
// fetch; the downloader itself is tested against a local server in @miyoria/hostd.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.js";
import * as doctor from "../src/commands/doctor.js";
import * as host from "../src/commands/host.js";
import * as servicesCmd from "../src/commands/services.js";
import * as update from "../src/commands/update.js";
import type { DeepDeps } from "../src/stack/checks.js";
import type { RunResult } from "../src/stack/system.js";
import { type Output, setOutput } from "../src/ui.js";

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");
const BODY = Buffer.from("model weights ".repeat(300));
const SHA = createHash("sha256").update(BODY).digest("hex");
const URL_ = `https://huggingface.co/o/r/resolve/${"a".repeat(40)}/model.bin`;

let dir: string;
let out: string[];
let restore: () => void;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  dir = mkdtempSync(join(TMP, "mf-"));
  write("pnpm-workspace.yaml", "packages: []\n");
  write("miyoria.toml", "");
  write(
    "workers/m/service.toml",
    `name = "m"
kind = "worker"
summary = "A worker with a model file"
[install]
runtime = "none"
[[install.files]]
path = "m/model.bin"
url = "${URL_}"
sha256 = "${SHA}"
size = ${BODY.length}
what = "測試模型"
licence = "Apache-2.0"
[run]
command = ["{node}", "{service}/server.cjs"]
port = "auto"
port_env = "PORT"
[run.health]
http = "/"
`,
  );
  out = [];
  const sink: Output = { out: (t) => out.push(t), err: (t) => out.push(t) };
  restore = setOutput(sink);
});
afterEach(() => {
  restore();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function write(path: string, text: string | Buffer): string {
  const full = join(dir, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

const text = () => out.join("");
const target = () => host.hostTarget(join(dir, "miyoria.toml"));
const dest = () => join(dir, "data", "host", "models", "m", "model.bin");

/** A fetch that serves `BODY` at `URL_` from memory and remembers what was asked. */
function memoryFetch() {
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url !== URL_) return new Response(null, { status: 404 });
    return new Response(BODY, {
      status: 200,
      headers: { "content-length": String(BODY.length) },
    });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

function deps(
  over: Partial<servicesCmd.ServiceDeps> = {},
  fetchImpl = memoryFetch().fetchImpl,
): servicesCmd.ServiceDeps {
  return {
    install: { fetchImpl, freeBytes: () => 50 * 1024 ** 3, env: { PATH: "" } },
    ...over,
  };
}

/** A confirmation that records its questions and answers `answer`. */
function asker(answer: boolean) {
  const questions: string[] = [];
  return {
    questions,
    confirm: async (q: string) => {
      questions.push(q);
      return answer;
    },
  };
}

const NONE: RunResult = { code: 0, stdout: "", stderr: "", missing: false, timedOut: false };
function deepDeps(): DeepDeps {
  return {
    platform: process.platform,
    run: async () => NONE,
    probe: async () => "free",
    fetchImpl: (async () => {
      throw new Error("offline");
    }) as typeof fetch,
    env: { PATH: "" },
    tmpdir: dir,
    version: "0.1.0",
  };
}

describe("add", () => {
  it("lists the file with its size and licence, asks once, then downloads and verifies it", async () => {
    const net = memoryFetch();
    const ask = asker(true);
    await servicesCmd.add(
      target(),
      { services: ["m"] },
      deps({ confirm: ask.confirm, interactive: true }, net.fetchImpl),
    );
    expect(ask.questions).toHaveLength(1);
    expect(ask.questions[0]).toMatch(/下載這 1 個檔案/);
    expect(text()).toContain("要下載的模型檔");
    expect(text()).toMatch(/m\/model\.bin\s+4\.1 KB\s+授權 Apache-2\.0\s+來自 huggingface\.co/);
    expect(text()).toContain("測試模型");
    expect(text()).toContain("已下載並驗證 m/model.bin");
    expect(readFileSync(dest())).toEqual(BODY);
    expect(net.asked).toEqual([URL_]);

    // Again: nothing to ask, nothing to fetch.
    out.length = 0;
    await servicesCmd.add(
      target(),
      { services: ["m"] },
      deps({ confirm: ask.confirm }, net.fetchImpl),
    );
    expect(ask.questions).toHaveLength(1);
    expect(net.asked).toHaveLength(1);
    expect(text()).not.toContain("要下載的模型檔");
  });

  it("downloads without asking with --yes", async () => {
    const net = memoryFetch();
    const ask = asker(false);
    await servicesCmd.add(
      target(),
      { services: ["m"] },
      deps({ yes: true, confirm: ask.confirm }, net.fetchImpl),
    );
    expect(ask.questions).toHaveLength(0);
    expect(existsSync(dest())).toBe(true);
  });

  it("without a terminal and without --yes prints the list and the command, and downloads nothing", async () => {
    const net = memoryFetch();
    await expect(
      servicesCmd.add(
        target(),
        { services: ["m"] },
        deps({ interactive: false, confirm: async () => true }, net.fetchImpl),
      ),
    ).rejects.toThrow(/miyoria add m --yes/);
    expect(text()).toContain("Apache-2.0");
    expect(net.asked).toEqual([]);
    expect(existsSync(dest())).toBe(false);
  });

  it("installs the rest when the answer is no, and says the file is still missing", async () => {
    const net = memoryFetch();
    await servicesCmd.add(
      target(),
      { services: ["m"] },
      deps({ confirm: asker(false).confirm }, net.fetchImpl),
    );
    expect(net.asked).toEqual([]);
    expect(text()).toContain("不下載模型檔");
    expect(text()).toContain("還沒有 m/model.bin");
    expect(readFileSync(join(dir, "host.toml"), "utf8")).toContain("[services.m]");
  });
});

describe("a file the machine already keeps in the old place (adopt_from)", () => {
  const OLD = "workers/models/m/model.bin";
  beforeEach(() => {
    const path = join(dir, "workers/m/service.toml");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        'what = "測試模型"',
        `what = "測試模型"\nadopt_from = "${OLD}"`,
      ),
    );
    write(OLD, BODY);
  });

  it("add links it in without asking and without downloading", async () => {
    const net = memoryFetch();
    const ask = asker(false);
    await servicesCmd.add(
      target(),
      { services: ["m"] },
      deps({ confirm: ask.confirm, interactive: true }, net.fetchImpl),
    );
    expect(ask.questions).toHaveLength(0);
    expect(net.asked).toEqual([]);
    expect(text()).toContain(`沿用 ${join(dir, OLD)}`);
    expect(text()).toContain("不用下載");
    expect(readFileSync(dest())).toEqual(BODY);
    expect(readFileSync(join(dir, OLD))).toEqual(BODY);
  });

  it("update says it will be reused, and a dry run changes nothing", async () => {
    const net = memoryFetch();
    write("host.toml", 'name = "h"\n\n[services.m]\n');
    out.length = 0;
    await update.updateServices(
      join(dir, "miyoria.toml"),
      { dryRun: true },
      {
        run: async () => NONE,
        confirm: async () => true,
        env: { PATH: "" },
        platform: process.platform,
        now: () => new Date(2026, 10, 18, 12, 0, 0),
        services: deps({}, net.fetchImpl),
      },
      null,
    );
    expect(text()).toContain("不用下載");
    expect(existsSync(dest())).toBe(false);
    expect(net.asked).toEqual([]);
  });
});

describe("update", () => {
  const updateDeps = (services: servicesCmd.ServiceDeps): update.UpdateDeps => ({
    run: async () => NONE,
    confirm: async () => true,
    env: { PATH: "" },
    platform: process.platform,
    now: () => new Date(2026, 10, 18, 12, 0, 0),
    services,
  });
  const config = () => join(dir, "miyoria.toml");

  it("asks about a missing file once and downloads it; dry-run only lists it", async () => {
    await servicesCmd.add(target(), { services: ["m"] }, deps({ confirm: asker(false).confirm }));
    out.length = 0;
    const net = memoryFetch();
    const ask = asker(true);
    await update.updateServices(
      config(),
      { dryRun: true },
      updateDeps(deps({ confirm: ask.confirm }, net.fetchImpl)),
      null,
    );
    expect(text()).toContain("要下載的模型檔");
    expect(ask.questions).toHaveLength(0);
    expect(net.asked).toEqual([]);

    const failures = await update.updateServices(
      config(),
      {},
      updateDeps(deps({ confirm: ask.confirm }, net.fetchImpl)),
      null,
    );
    expect(failures).toBe(0);
    expect(ask.questions).toHaveLength(1);
    expect(readFileSync(dest())).toEqual(BODY);
  });

  it("without a terminal counts a failure and names `miyoria update --yes`", async () => {
    await servicesCmd.add(target(), { services: ["m"] }, deps({ confirm: asker(false).confirm }));
    out.length = 0;
    const net = memoryFetch();
    const failures = await update.updateServices(
      config(),
      {},
      updateDeps(deps({ interactive: false }, net.fetchImpl)),
      null,
    );
    expect(failures).toBe(1);
    expect(text()).toContain("miyoria update --yes");
    expect(net.asked).toEqual([]);
  });
});

describe("doctor", () => {
  const run = (options: doctor.DoctorOptions) =>
    doctor.run(join(dir, "miyoria.toml"), { deps: deepDeps(), ...options });

  it("fails for a missing required file, fixes it with --fix after asking, then verifies it", async () => {
    await servicesCmd.add(target(), { services: ["m"] }, deps({ confirm: asker(false).confirm }));
    out.length = 0;
    await expect(run({})).rejects.toThrow(/項檢查失敗/);
    expect(text()).toMatch(/✗ m\s+檔案 m\/model\.bin\s+缺 測試模型/);
    expect(text()).toContain("hostd 不會啟動");

    out.length = 0;
    const ask = asker(true);
    await run({ fix: true, services: deps({ confirm: ask.confirm }) });
    expect(ask.questions).toHaveLength(1);
    expect(text()).toContain("已下載並驗證 m/model.bin");
    expect(text()).toMatch(/✓ m\s+檔案 m\/model\.bin\s+已驗證/);
  });

  it("finds a wrong file with --deep after its hash was remembered", async () => {
    await servicesCmd.add(target(), { services: ["m"] }, deps({ yes: true }));
    out.length = 0;
    await run({});
    expect(text()).toMatch(/✓ m\s+檔案 m\/model\.bin\s+已驗證/);
    // Other bytes, same size and time: the remembered hash still says it is fine...
    const when = 1_700_000_000;
    utimesSync(dest(), when, when);
    out.length = 0;
    await run({});
    writeFileSync(dest(), Buffer.alloc(BODY.length, 1));
    utimesSync(dest(), when, when);
    out.length = 0;
    await run({});
    expect(text()).toMatch(/✓ m\s+檔案 m\/model\.bin/);
    // ...until --deep reads it.
    out.length = 0;
    await doctor
      .run(join(dir, "miyoria.toml"), { deps: deepDeps(), deep: true })
      .catch(() => undefined);
    expect(text()).toMatch(/✗ m\s+檔案 m\/model\.bin\s+不對:SHA-256/);
  });

  it("--print-hashes prints the files of a service in service.toml syntax", async () => {
    await servicesCmd.add(target(), { services: ["m"] }, deps({ yes: true }));
    out.length = 0;
    await run({ printHashes: "m" });
    expect(text()).toContain('path = "m/model.bin"');
    expect(text()).toContain(`sha256 = "${SHA}"`);
    expect(text()).toContain(`size = ${BODY.length}`);
    expect(text()).toContain("workers/m/service.toml");
    await expect(run({ printHashes: "nope" })).rejects.toThrow(/nope/);
  });

  it("parses --print-hashes", () => {
    expect(parseArgs(["doctor", "--print-hashes", "sing"]).ctx.options["print-hashes"]).toBe(
      "sing",
    );
  });
});
