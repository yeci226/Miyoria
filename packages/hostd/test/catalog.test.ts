import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  isKnownPlaceholder,
  LINK_PLACEHOLDERS,
  loadCatalog,
  PLACEHOLDERS,
  placeholdersIn,
} from "../src/index.js";

// Temporary folders live inside the package, not in the system temp folder.
const TMP = join(dirname(fileURLToPath(import.meta.url)), "..", ".tmp-test");
const made: string[] = [];

function workspace(files: Record<string, string>): string {
  mkdirSync(TMP, { recursive: true });
  const root = mkdtempSync(join(TMP, "ws-"));
  made.push(root);
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const valid = (name: string, extra = "") => `
name = "${name}"
kind = "worker"
provides = ["${name}"]

[run]
command = ["{python}", "server.py"]
port = 9000
${extra}
`;

describe("loadCatalog", () => {
  it("loads a valid descriptor", () => {
    const root = workspace({ "workers/a/service.toml": valid("a") });
    const catalog = loadCatalog(root);
    expect(catalog.problems).toEqual([]);
    const entry = catalog.services.get("a");
    expect(entry?.dir).toBe(join(root, "workers", "a"));
    expect(entry?.file).toBe(join(root, "workers", "a", "service.toml"));
    expect(entry?.descriptor.run?.port).toBe(9000);
  });

  it("treats a missing root folder as nothing to load", () => {
    expect(loadCatalog(workspace({}))).toEqual({ services: new Map(), problems: [] });
  });

  it("reports invalid TOML without throwing", () => {
    const root = workspace({ "workers/a/service.toml": "name = = nope" });
    const catalog = loadCatalog(root);
    expect(catalog.services.size).toBe(0);
    expect(catalog.problems).toHaveLength(1);
    expect(catalog.problems[0]?.message).toMatch(/TOML/);
  });

  it("reports a schema error with its path", () => {
    const root = workspace({ "workers/a/service.toml": valid("a").replace("9000", '"x"') });
    const catalog = loadCatalog(root);
    expect(catalog.services.size).toBe(0);
    expect(catalog.problems.map((p) => p.message).join("\n")).toMatch(/run\.port/);
  });

  it("reports a typo key", () => {
    const root = workspace({ "workers/a/service.toml": valid("a", "pas_env = []") });
    expect(loadCatalog(root).problems).toHaveLength(1);
  });

  it("reports a duplicate name and keeps the first", () => {
    const root = workspace({
      "workers/a/service.toml": valid("same"),
      "apps/b/service.toml": valid("same"),
    });
    const catalog = loadCatalog(root);
    expect(catalog.services.size).toBe(1);
    expect(catalog.problems).toHaveLength(1);
    expect(catalog.problems[0]?.message).toMatch(/already used/);
  });

  it("reports an unknown placeholder", () => {
    const root = workspace({
      "workers/a/service.toml": valid("a", 'env = { X = "{nope}/{port}" }'),
    });
    const catalog = loadCatalog(root);
    expect(catalog.services.size).toBe(0);
    expect(catalog.problems).toHaveLength(1);
    expect(catalog.problems[0]?.message).toContain("{nope}");
  });

  it("reports a descriptor that lacks what its kind needs", () => {
    const root = workspace({
      "services/x/service.toml": 'name = "x"\nkind = "external"\n',
      "workers/y/service.toml": 'name = "y"\nkind = "worker"\n',
    });
    expect(loadCatalog(root).problems).toHaveLength(2);
  });

  it("does not walk deeper than one level", () => {
    const root = workspace({ "workers/a/nested/service.toml": valid("a") });
    expect(loadCatalog(root).services.size).toBe(0);
  });
});

describe("placeholdersIn", () => {
  it("finds names and ignores other braces", () => {
    expect(placeholdersIn("{python} {service}/x {}  {1} {a b}")).toEqual(["python", "service"]);
  });

  it("knows the ten placeholders of the design, {workspace} and {offload_urls}", () => {
    expect([...PLACEHOLDERS]).toHaveLength(12);
    expect(PLACEHOLDERS).toContain("workspace");
    expect(PLACEHOLDERS).toContain("offload_urls");
  });

  it("allows {env:NAME} and nothing else with a colon", () => {
    expect(placeholdersIn("{env:MIYORIA_HLS_SECRET} {other:X}")).toEqual([
      "env:MIYORIA_HLS_SECRET",
      "other:X",
    ]);
    expect(isKnownPlaceholder("env:MIYORIA_HLS_SECRET")).toBe(true);
    expect(isKnownPlaceholder("other:X")).toBe(false);
    expect(isKnownPlaceholder("env:")).toBe(false);
  });

  it("knows the four {link:...} placeholders, and only in run.env", () => {
    expect(placeholdersIn("{link:voice.url}/{link:stage.token}")).toEqual([
      "link:voice.url",
      "link:stage.token",
    ]);
    for (const name of LINK_PLACEHOLDERS) expect(isKnownPlaceholder(`link:${name}`)).toBe(true);
    expect(isKnownPlaceholder("link:voice.port")).toBe(false);
    expect(isKnownPlaceholder("link:")).toBe(false);

    const node = (name: string, run: string) => `name = "${name}"\nkind = "node"\n[run]\n${run}\n`;
    const root = workspace({
      "apps/ok/service.toml": node(
        "ok",
        'command = ["x"]\nenv = { U = "{link:voice.url}", T = "{link:voice.token}" }',
      ),
      "apps/in-command/service.toml": node("in-command", 'command = ["x", "{link:voice.url}"]'),
      "apps/unknown/service.toml": node(
        "unknown",
        'command = ["x"]\nenv = { U = "{link:voice.port}" }',
      ),
    });
    const catalog = loadCatalog(root);
    expect(catalog.services.has("ok")).toBe(true);
    expect(catalog.problems.map((p) => p.message).sort()).toEqual([
      "run.command[1]: {link:voice.url} may only be used in run.env",
      "run.env.U: unknown placeholder {link:voice.port}",
    ]);
  });
});

describe("[routing] (v5-hostd §15)", () => {
  const nl = (...lines: string[]) => `${lines.join("\n")}\n`;

  it("has no routing without the table: the old behaviour", () => {
    const catalog = loadCatalog(workspace({ "workers/a/service.toml": valid("a") }));
    expect(catalog.services.get("a")?.descriptor.routing).toBeUndefined();
  });

  it("reads the table from service.toml, with its defaults", () => {
    const root = workspace({
      "workers/a/service.toml": valid("a", nl("[routing]", 'class = "job"')),
    });
    const catalog = loadCatalog(root);
    expect(catalog.problems).toEqual([]);
    expect(catalog.services.get("a")?.descriptor.routing).toEqual({
      class: "job",
      latency: "interactive",
      concurrency: 1,
      queue: false,
      needs: { files: [] },
      yields_to: [],
    });
  });

  it("reads routing.toml beside service.toml, which an older hostd never opens", () => {
    const root = workspace({
      "workers/a/service.toml": valid("a", nl("[run.health]", 'http = "/health"')),
      "workers/a/routing.toml": nl(
        'class = "job"',
        "queue = true",
        'yields_to = ["tts"]',
        "[needs]",
        "vram_gb = 8",
        "[variant]",
        'env = ["X"]',
      ),
    });
    const catalog = loadCatalog(root);
    expect(catalog.problems).toEqual([]);
    const routing = catalog.services.get("a")?.descriptor.routing;
    expect(routing?.queue).toBe(true);
    expect(routing?.needs.vram_gb).toBe(8);
    expect(routing?.variant).toEqual({ files: [], env: ["X"] });
  });

  it("refuses the table in both files, an unknown class, a typo and the rules it cannot type", () => {
    const both = workspace({
      "workers/a/service.toml": valid("a", nl("[routing]", 'class = "job"')),
      "workers/a/routing.toml": nl('class = "job"'),
    });
    expect(loadCatalog(both).problems.map((p) => p.message)).toEqual([
      "[routing] is in service.toml and in routing.toml; keep one",
    ]);
    const bad = (...lines: string[]) =>
      loadCatalog(
        workspace({ "workers/a/service.toml": valid("a"), "workers/a/routing.toml": nl(...lines) }),
      ).problems.map((p) => p.message);
    expect(bad('class = "pool"').join()).toMatch(/routing\.class/);
    expect(bad('class = "job"', "concurency = 2").join()).toMatch(/concurency/);
    expect(bad('class = "job"', 'latency = "realtime"')).toEqual([
      'routing: a realtime service keeps its sessions on one host; use class = "session"',
    ]);
    expect(bad('class = "job"', "queue = true")).toEqual([
      "routing.queue: the load is read from [run.health] http, which this service has none of",
    ]);
    expect(bad('class = "job"', "[needs]", 'files = ["{python}/x"]')).toEqual([
      "routing.needs.files[0]: unknown placeholder {python}",
    ]);
    expect(bad('class = "job"', 'yields_to = ["a"]')).toEqual([
      "routing.yields_to: a service does not yield to itself",
    ]);
    // A broken routing.toml disables the service like a broken descriptor.
    expect(bad("class = = ").join()).toMatch(/TOML/);
  });
});

describe("the descriptors of this repository", () => {
  it("declare the routing class of each service", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const catalog = loadCatalog(root);
    const classes = Object.fromEntries(
      [...catalog.services.values()].map((e) => [e.name, e.descriptor.routing?.class]),
    );
    expect(classes).toEqual({
      asr: "session",
      comfyui: "job",
      core: "single",
      lyrics: "job",
      mediamtx: "single",
      obs: "single",
      sing: "job",
      stage: "single",
      tts: "session",
      turn: "session",
      "vtube-studio": "single",
      "voice-node": "single",
    });
    const sing = catalog.services.get("sing")?.descriptor.routing;
    expect(sing?.yields_to).toEqual(["tts", "asr"]);
    expect(sing?.queue).toBe(true);
    expect(catalog.services.get("tts")?.descriptor.routing?.variant?.files.length).toBe(2);
  });

  it("all load, and they are the twelve of the design", () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
    const catalog = loadCatalog(root);
    expect(catalog.problems).toEqual([]);
    expect([...catalog.services.keys()].sort()).toEqual(
      [
        "asr",
        "comfyui",
        "core",
        "lyrics",
        "mediamtx",
        "obs",
        "sing",
        "stage",
        "tts",
        "turn",
        "vtube-studio",
        "voice-node",
      ].sort(),
    );
  });
});
