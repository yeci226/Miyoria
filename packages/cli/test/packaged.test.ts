// A machine that installed the `miyoria` package has no repository: the catalog comes from the
// package folder (scripts/build.mjs copies it at the same relative paths), and the voice node,
// which runs from source, is answered with a message instead of "no such service".

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCatalog } from "@miyoria/hostd";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as host from "../src/commands/host.js";
import * as services from "../src/commands/services.js";
import { type Output, setOutput } from "../src/ui.js";

// The simulated package folder, and the folders that are declared to have no source checkout
// above them (the test folders sit inside this repository, whose own workspace file would
// otherwise be found).
const fake = vi.hoisted(() => ({ pkg: "", noSource: [] as string[] }));
vi.mock("../src/assets.js", async (original) => {
  const real = await original<typeof import("../src/assets.js")>();
  // A getter: the folder is made in beforeEach, after this factory has run.
  return {
    ...real,
    get PACKAGE_ROOT() {
      return fake.pkg;
    },
  };
});
vi.mock("../src/stack/config.js", async (original) => {
  const real = await original<typeof import("../src/stack/config.js")>();
  return {
    ...real,
    repoRoot: (configPath: string) =>
      fake.noSource.some((dir) => configPath.startsWith(dir)) ? null : real.repoRoot(configPath),
  };
});

const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");

let base: string;
let pkg: string;
let workspace: string;
let out: string[];
let restore: () => void;

function descriptor(root: string, path: string, name: string, kind = "worker"): void {
  const full = join(root, path, "service.toml");
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(
    full,
    kind === "external"
      ? `name = "${name}"\nkind = "external"\nsummary = "${name}"\n[probe]\nport = 4455\n`
      : `name = "${name}"\nkind = "${kind}"\nprovides = ["${name}"]\nsummary = "${name}"\n[run]\ncommand = ["x"]\n`,
  );
}

/** What scripts/build.mjs puts in the package: no apps/voice-node. */
function packageFolder(root: string): void {
  writeFileSync(join(root, "package.json"), '{"name":"miyoria"}\n');
  descriptor(root, "workers/asr", "asr");
  descriptor(root, "workers/tts", "tts");
  descriptor(root, "workers/mediamtx", "mediamtx");
  descriptor(root, "services/obs", "obs", "external");
  descriptor(root, "packages/core", "core");
  descriptor(root, "packages/stage", "stage", "node");
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  base = mkdtempSync(join(TMP, "packaged-"));
  pkg = join(base, "node_modules", "miyoria");
  workspace = join(base, "my-bot");
  mkdirSync(pkg, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  packageFolder(pkg);
  fake.pkg = pkg;
  fake.noSource = [base];
  out = [];
  restore = setOutput({ out: (t) => out.push(t), err: (t) => out.push(t) } satisfies Output);
});
afterEach(() => {
  restore();
  fake.noSource = [];
  rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe("the catalog of an installed package", () => {
  it("is read from the package folder when no repository is around", () => {
    const hostToml = join(workspace, "host.toml");
    expect(host.catalogRoot(hostToml)).toBe(pkg);
    const catalog = loadCatalog(host.catalogRoot(hostToml));
    expect([...catalog.services.keys()].sort()).toEqual([
      "asr",
      "core",
      "mediamtx",
      "obs",
      "stage",
      "tts",
    ]);
    expect(catalog.problems).toEqual([]);
  });

  it("is the repository when the workspace is inside one", () => {
    writeFileSync(join(workspace, "pnpm-workspace.yaml"), "packages: []\n");
    mkdirSync(join(workspace, "workers"));
    fake.noSource = [];
    expect(host.catalogRoot(join(workspace, "host.toml"))).toBe(workspace);
  });

  it("lets `add` write a service of the package into host.toml", async () => {
    const target = host.hostTarget(join(workspace, "miyoria.toml"));
    await services.add(target, { services: ["asr", "tts"], noInstall: true });
    const written = (await import("node:fs")).readFileSync(target.hostToml, "utf8");
    expect(written).toContain("[services.asr]");
    expect(written).toContain("[services.tts]");
  });
});

describe("the voice node on a package", () => {
  it("is answered with a message that it needs the repository, and nothing is written", async () => {
    const target = host.hostTarget(join(workspace, "miyoria.toml"));
    await expect(
      services.add(target, { services: ["asr", "voice-node"], noInstall: true }),
    ).rejects.toThrow(services.VOICE_NODE_NEEDS_REPOSITORY);
    expect(services.VOICE_NODE_NEEDS_REPOSITORY).toContain("repository");
    expect(existsSync(target.hostToml)).toBe(false);
  });

  it("is added as before when the repository has its descriptor", async () => {
    descriptor(pkg, "apps/voice-node", "voice-node", "node");
    const target = host.hostTarget(join(workspace, "miyoria.toml"));
    await services.add(target, { services: ["voice-node"], noInstall: true });
    expect(existsSync(target.hostToml)).toBe(true);
  });

  it("an unknown name still lists the catalog", async () => {
    const target = host.hostTarget(join(workspace, "miyoria.toml"));
    await expect(services.add(target, { services: ["nope"], noInstall: true })).rejects.toThrow(
      /沒有叫 nope 的服務/,
    );
  });
});
