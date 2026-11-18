// `models ls | pull | gc` on a fake folder tree and a fake Python.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CommandRunner,
  gcModels,
  hfCacheHas,
  hfCacheName,
  hfRepoOf,
  listModels,
  loadCatalog,
  loadHostConfig,
  pullModels,
  pythonIn,
  type RunSpec,
} from "../src/index.js";
import { TMP } from "./fakes.js";

let root: string;

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  root = mkdtempSync(join(TMP, "models-"));
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

function setup(hostToml: string) {
  write(
    "workers/asr/service.toml",
    `name = "asr"
kind = "worker"
[install]
runtime = "python"
project = "."
[[install.models]]
repo = "Qwen/Qwen3-ASR-0.6B"
revision = "rev1"
[[install.models]]
repo = "Org/Unpinned"
[run]
command = ["x"]
`,
  );
  write(
    "workers/turn/service.toml",
    `name = "turn"
kind = "worker"
[install]
runtime = "none"
[[install.files]]
hf = "x/y"
file = "y.onnx"
revision = "${"a".repeat(40)}"
sha256 = "${"0".repeat(64)}"
size = 200
what = "a model"
licence = "MIT"
path = "smart/model.onnx"
[run]
command = ["x"]
`,
  );
  write("host.toml", hostToml);
  return { host: loadHostConfig(join(root, "host.toml")), catalog: loadCatalog(root) };
}

function hfSnapshot(models: string, repo: string, revision: string, size: number): void {
  const base = join(models, "hf", hfCacheName(repo));
  mkdirSync(join(base, "snapshots", revision), { recursive: true });
  mkdirSync(join(base, "blobs"), { recursive: true });
  writeFileSync(join(base, "blobs", "b1"), Buffer.alloc(size));
}

describe("models ls", () => {
  it("lists repositories and files with sizes and the services that name them", () => {
    const { host, catalog } = setup(
      'name = "h"\n[services.asr]\n[services.turn]\nenabled = false\n',
    );
    const models = host.state.models;
    hfSnapshot(models, "Qwen/Qwen3-ASR-0.6B", "rev1", 1000);
    hfSnapshot(models, "Old/Gone", "r", 50);
    mkdirSync(join(models, "hf", ".locks"), { recursive: true });
    mkdirSync(join(models, "smart"), { recursive: true });
    writeFileSync(join(models, "smart", "model.onnx"), Buffer.alloc(200));
    writeFileSync(join(models, "stray.bin"), Buffer.alloc(7));

    const found = listModels(catalog, host);
    expect(found.map((m) => [m.id, m.kind, m.bytes, m.usedBy, m.enabledBy])).toEqual([
      ["Old/Gone", "hf", 50, [], []],
      ["Qwen/Qwen3-ASR-0.6B", "hf", 1000, ["asr"], ["asr"]],
      ["smart/model.onnx", "file", 200, ["turn"], []],
      ["stray.bin", "file", 7, [], []],
    ]);
    expect(found[1]?.revisions).toEqual(["rev1"]);
  });

  it("knows a revision by its commit or by a branch in refs/", () => {
    const { host } = setup('name = "h"\n');
    const models = host.state.models;
    hfSnapshot(models, "Org/Name", "abc123", 1);
    expect(hfCacheHas(models, "Org/Name")).toBe(true);
    expect(hfCacheHas(models, "Org/Name", "abc123")).toBe(true);
    expect(hfCacheHas(models, "Org/Name", "other")).toBe(false);
    write("data/host/models/hf/models--Org--Name/refs/main", "abc123");
    expect(hfCacheHas(models, "Org/Name", "main")).toBe(true);
    expect(hfRepoOf("models--Org--Name")).toBe("Org/Name");
    expect(hfRepoOf(".locks")).toBeNull();
  });
});

describe("models gc", () => {
  it("lists what no enabled service names and deletes only what is confirmed", async () => {
    const { host, catalog } = setup(
      'name = "h"\n[services.asr]\n[services.turn]\nenabled = false\n',
    );
    const models = host.state.models;
    hfSnapshot(models, "Qwen/Qwen3-ASR-0.6B", "rev1", 10);
    hfSnapshot(models, "Old/Gone", "r", 50);
    write("data/host/models/hf/.locks/models--Old--Gone/lock", "");
    write("data/host/models/smart/model.onnx", "x".repeat(20));
    write("data/host/models/smart/model.onnx.part", "x");

    const dry = await gcModels(catalog, host);
    expect(dry.candidates.map((c) => c.id)).toEqual([
      "Old/Gone",
      "smart/model.onnx",
      "smart/model.onnx.part",
    ]);
    expect(dry.deleted).toEqual([]);
    expect(existsSync(join(models, "hf", "models--Old--Gone"))).toBe(true);

    const none = await gcModels(catalog, host, () => false);
    expect(none.deleted).toEqual([]);

    // Only part of the list is confirmed, and an entry that was not offered is ignored.
    const result = await gcModels(catalog, host, (offered) => [
      ...offered.filter((o) => o.id === "Old/Gone"),
      {
        id: "Qwen/Qwen3-ASR-0.6B",
        kind: "hf",
        path: join(models, "hf", hfCacheName("Qwen/Qwen3-ASR-0.6B")),
        bytes: 0,
        revisions: [],
        usedBy: [],
        enabledBy: [],
      },
    ]);
    expect(result.deleted.map((d) => d.id)).toEqual(["Old/Gone"]);
    expect(result.freedBytes).toBe(50);
    expect(existsSync(join(models, "hf", "models--Old--Gone"))).toBe(false);
    expect(existsSync(join(models, "hf", ".locks", "models--Old--Gone"))).toBe(false);
    expect(existsSync(join(models, "hf", hfCacheName("Qwen/Qwen3-ASR-0.6B")))).toBe(true);
    expect(existsSync(join(models, "smart", "model.onnx"))).toBe(true);

    const rest = await gcModels(catalog, host, () => true);
    expect(rest.deleted.map((d) => d.id)).toEqual(["smart/model.onnx", "smart/model.onnx.part"]);
    // The emptied folder goes too; the model folder itself stays.
    expect(existsSync(join(models, "smart"))).toBe(false);
    expect(existsSync(models)).toBe(true);
  });
});

describe("models pull", () => {
  function fakePython(over: { code?: number } = {}) {
    const calls: RunSpec[] = [];
    const runner: CommandRunner = async (spec) => {
      calls.push(spec);
      return {
        code: over.code ?? 0,
        missing: false,
        tail: over.code ? ["boom"] : ["Fetching 4 files", "/cache/snapshots/abc"],
      };
    };
    return { runner, calls };
  }

  it("runs the environment's Python with HF_HUB_CACHE in the model folder", async () => {
    const { host, catalog } = setup('name = "h"\n[services.asr]\n');
    const python = pythonIn(join(host.state.root, "envs", "asr"), "linux");
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "");
    const fake = fakePython();
    const results = await pullModels(catalog.services.get("asr") as never, host, {
      runner: fake.runner,
      platform: "linux",
      env: { PATH: "/bin", SECRET: "x" },
    });
    expect(results).toEqual([
      {
        service: "asr",
        repo: "Qwen/Qwen3-ASR-0.6B",
        revision: "rev1",
        state: "pulled",
        path: "/cache/snapshots/abc",
        unpinned: false,
      },
      {
        service: "asr",
        repo: "Org/Unpinned",
        state: "pulled",
        path: "/cache/snapshots/abc",
        unpinned: true,
      },
    ]);
    const first = fake.calls[0] as RunSpec;
    expect(first.file).toBe(python);
    expect(first.args.slice(0, 1)).toEqual(["-c"]);
    expect(first.args[1]).toContain("snapshot_download");
    expect(first.args.slice(2)).toEqual(["Qwen/Qwen3-ASR-0.6B", "rev1"]);
    expect((fake.calls[1] as RunSpec).args.slice(2)).toEqual(["Org/Unpinned", ""]);
    expect(first.env.HF_HUB_CACHE).toBe(join(host.state.models, "hf"));
    expect(first.env.SECRET).toBeUndefined();
  });

  it("says that add comes first when there is no environment, and reports a failure", async () => {
    const { host, catalog } = setup('name = "h"\n[services.asr]\n');
    const fake = fakePython();
    const before = await pullModels(catalog.services.get("asr") as never, host, {
      runner: fake.runner,
      platform: "linux",
    });
    expect(before.map((r) => r.state)).toEqual(["no-environment", "no-environment"]);
    expect(before[0]?.detail).toContain("miyoria add asr");
    expect(fake.calls).toHaveLength(0);

    const python = pythonIn(join(host.state.root, "envs", "asr"), "linux");
    mkdirSync(dirname(python), { recursive: true });
    writeFileSync(python, "");
    const failing = await pullModels(catalog.services.get("asr") as never, host, {
      runner: fakePython({ code: 1 }).runner,
      platform: "linux",
    });
    expect(failing[0]).toMatchObject({ state: "failed" });
    expect(failing[0]?.detail).toContain("boom");
  });
});
