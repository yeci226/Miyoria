// The machines are the install's whichever profile runs (docs/design/v5-profiles.md §7): the
// install that existed before profiles is untouched, a profile with a database of its own sees
// the same paired hosts and pairs into the same tables, and its character's tables never reach
// the machines' database.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ClusterKey, ClusterModule, clusterTables } from "@miyoria/cluster";
import { Config, defineManifest, type Module, type ModuleContext } from "@miyoria/runtime/kernel";
import { openPluginDatabase, openStore, SqliteStore } from "@miyoria/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildCoreWith, type Core, type ModuleCatalog, type ModuleDeps } from "../src/boot.js";
import { openMachines } from "../src/machines.js";
import {
  machineSource,
  peekConfig,
  type ResolvedProfile,
  resolveProfile,
} from "../src/profiles.js";

const PROFILES = join(fileURLToPath(new URL("../../..", import.meta.url)), "profiles");

let root: string;
let core: Core | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miyoria-machines-"));
});

afterEach(async () => {
  await core?.stop();
  core = undefined;
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string): string {
  const file = join(root, path);
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
  return file;
}

const noEnv = () => undefined;

function profileAt(env: (name: string) => string | undefined = noEnv): ResolvedProfile {
  const install = join(root, "miyoria.toml");
  return resolveProfile(install, peekConfig(install, env), env);
}

/** An install running `deepseek-chan` on its own config, and a character `kuro` of its own. */
function install(installToml = ""): void {
  write("miyoria.toml", `[core]\nprofile = "deepseek-chan"\n${installToml}`);
  write("profiles/deepseek-chan/profile.toml", 'id = "deepseek-chan"\n');
  write("profiles/kuro/profile.toml", 'id = "kuro"\n');
  write(
    "profiles/kuro/miyoria.toml",
    '[core]\nprofile = "kuro"\nprofiles_dir = ".."\ndatabase_url = "sqlite:data/miyoria.db"\n',
  );
}

const INSTALL_DB = () => join(root, "data", "miyoria.db");
const KURO_DB = () => join(root, "profiles", "kuro", "data", "miyoria.db");

/** sha256 of every file in a folder, by name; `{}` when there is none. */
function snapshot(dir: string): Record<string, string> {
  if (!existsSync(dir)) return {};
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    out[name] = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
  }
  return out;
}

function tablesOf(path: string): string[] {
  const db = openPluginDatabase(path, []);
  try {
    return db
      .all(
        "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .map((r) => String(r.name));
  } finally {
    db.close();
  }
}

/** The install's own character pairs a host, as it does today; returns the host's id and key. */
async function pairOnInstall(name: string): Promise<{ id: string; key: string }> {
  const store = await SqliteStore.open(INSTALL_DB(), { plugins: [clusterTables] });
  try {
    const made = store
      .plugin(clusterTables)
      .hosts.create({ name, approved: true, capabilities: ["asr"] });
    return { id: made.host.id, key: made.key };
  } finally {
    await store.close();
  }
}

describe("where the machines are", () => {
  it("a profile on the install's config has no machine source: its store is the install's", () => {
    install();
    expect(machineSource(profileAt(), noEnv)).toBeNull();
  });

  it("a profile of its own gets the install's database and [modules.cluster], read as the install sees them", () => {
    install(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${VAR} references in the file
      'database_url = "${DATABASE_URL:-sqlite:data/miyoria.db}"\n[modules.cluster]\nbind = "0.0.0.0:7880"\n',
    );
    write(".env", "DATABASE_URL=sqlite:data/core.db\n");
    // Her own `.env` names her database: it never points the machines there.
    write("profiles/kuro/.env", "DATABASE_URL=sqlite:data/miyoria.db\n");
    const env = (name: string) =>
      name === "MIYORIA_PROFILE"
        ? "kuro"
        : name === "DATABASE_URL"
          ? "sqlite:data/miyoria.db"
          : undefined;
    const source = machineSource(profileAt(env), env);
    expect(source).toEqual({
      databaseUrl: `sqlite:${join(root, "data", "core.db")}`,
      cluster: { enabled: true, config: { bind: "0.0.0.0:7880" } },
    });
    // A real variable that is not her `.env`'s wins, as it does for the install's own Core.
    const real = (name: string) =>
      name === "MIYORIA_PROFILE"
        ? "kuro"
        : name === "DATABASE_URL"
          ? "sqlite:/srv/m.db"
          : undefined;
    expect(machineSource(profileAt(real), real)?.databaseUrl).toBe("sqlite:/srv/m.db");
  });

  it("an install on memory:// leaves the machines in the profile's own store", async () => {
    install('database_url = "memory://"\n');
    const env = (name: string) => (name === "MIYORIA_PROFILE" ? "kuro" : undefined);
    const source = machineSource(profileAt(env), env);
    expect(source?.databaseUrl).toBeNull();
    const store = await openStore("memory://");
    try {
      const machines = openMachines(store, source);
      expect(machines.path).toBeNull();
      expect(machines.tables).toBe(store.plugin(clusterTables));
    } finally {
      await store.close();
    }
  });
});

describe("the install that existed before profiles", () => {
  it("keeps its pairing in its store and nothing is created, copied or changed on disk", async () => {
    install();
    const host = await pairOnInstall("main-pc");
    const store = await SqliteStore.open(INSTALL_DB(), { plugins: [clusterTables] });
    try {
      const before = snapshot(join(root, "data"));
      const machines = openMachines(store, machineSource(profileAt(), noEnv), {
        storeUrl: `sqlite:${INSTALL_DB()}`,
      });
      expect(machines.path).toBeNull();
      expect(machines.tables).toBe(store.plugin(clusterTables));
      expect(machines.tables.hosts.verify(host.id, host.key)).toBe(true);
      machines.close();
      expect(snapshot(join(root, "data"))).toEqual(before);
      expect(existsSync(join(root, "profiles", "deepseek-chan", "data"))).toBe(false);
    } finally {
      await store.close();
    }
  });
});

describe("a profile with a database of its own", () => {
  const kuro = (name: string) => (name === "MIYORIA_PROFILE" ? "kuro" : undefined);

  it("sees the hosts paired before, and pairs into the install's tables", async () => {
    install();
    const paired = await pairOnInstall("main-pc");
    const tablesBefore = tablesOf(INSTALL_DB());

    const store = await SqliteStore.open(KURO_DB(), { plugins: [clusterTables] });
    const machines = openMachines(store, machineSource(profileAt(kuro), kuro), {
      storeUrl: `sqlite:${KURO_DB()}`,
    });
    let friend: { id: string; key: string };
    try {
      expect(machines.path).toBe(INSTALL_DB());
      // No re-pairing: the same key works.
      expect(machines.tables.hosts.list().map((h) => h.name)).toEqual(["main-pc"]);
      expect(machines.tables.hosts.verify(paired.id, paired.key)).toBe(true);
      // A friend's machine joins while she runs.
      const made = machines.tables.hosts.create({ name: "friend-pc" });
      machines.tables.hosts.approve("friend-pc", ["sing"]);
      friend = { id: made.host.id, key: made.key };
      // Her own store's tables stay empty.
      expect(store.plugin(clusterTables).hosts.list()).toEqual([]);
    } finally {
      machines.close();
      await store.close();
    }
    // The install's character sees the friend's machine when it runs again.
    const back = await SqliteStore.open(INSTALL_DB(), { plugins: [clusterTables] });
    try {
      const hosts = back.plugin(clusterTables).hosts;
      expect(hosts.list().map((h) => [h.name, h.status, h.capabilities])).toEqual([
        ["friend-pc", "approved", ["sing"]],
        ["main-pc", "approved", ["asr"]],
      ]);
      expect(hosts.verify(friend.id, friend.key)).toBe(true);
    } finally {
      await back.close();
    }
    // Opening the install's database for the machines added no table to it.
    expect(tablesOf(INSTALL_DB())).toEqual(tablesBefore);
  });

  it("on a new install the machines' database holds the machines' tables and nothing of her", async () => {
    install();
    const store = await SqliteStore.open(KURO_DB(), { plugins: [clusterTables] });
    const machines = openMachines(store, machineSource(profileAt(kuro), kuro), {
      storeUrl: `sqlite:${KURO_DB()}`,
    });
    try {
      machines.tables.hosts.create({ name: "main-pc", approved: true, capabilities: ["asr"] });
      // Her character writes a setting of hers.
      await store.settings.set("kuro", "demo.mood", "calm");
    } finally {
      machines.close();
      await store.close();
    }
    expect(tablesOf(INSTALL_DB())).toEqual([
      "_migrations",
      "cluster_controls",
      "cluster_estimates",
      "cluster_hosts",
      "cluster_invites",
    ]);
    expect(tablesOf(KURO_DB())).toEqual(
      expect.arrayContaining(["events", "persons", "plugin_state"]),
    );
  });
});

class Fake implements Module {
  readonly manifest;
  constructor(id: string) {
    this.manifest = defineManifest(id, id);
  }
  async start(_ctx: ModuleContext): Promise<void> {}
}

describe("Core", () => {
  it("runs the cluster module on the install's machines and its [modules.cluster]", async () => {
    install();
    const paired = await pairOnInstall("main-pc");
    const seen: { deps?: ModuleDeps } = {};
    const catalog: ModuleCatalog = {
      openStore: (url) => openStore(url),
      coreModules: async (deps) => {
        seen.deps = deps;
        return [new ClusterModule({ ...(deps.machines ? { machines: deps.machines } : {}) })];
      },
      discord: () => new Fake("platform.discord.bot"),
      api: () => new Fake("api"),
      discoverExtensions: async () => ({ skipped: [], modules: [] }),
    };
    // Her own section would not even bind: the install's is the one that runs.
    const config = Config.fromToml(
      `[core]\nprofiles_dir = '${PROFILES}'\nprofile = "deepseek-chan"\ndatabase_url = 'sqlite:${KURO_DB()}'\n[modules.cluster]\nbind = "nowhere"\n`,
    );
    core = await buildCoreWith(catalog, config, {
      discord: false,
      api: false,
      ownProfile: true,
      machines: {
        databaseUrl: `sqlite:${INSTALL_DB()}`,
        cluster: { enabled: true, config: { bind: "127.0.0.1:0" } },
      },
    });
    await core.start();
    const cluster = core.services.require(ClusterKey);
    expect(cluster.address.address).toBe("127.0.0.1");
    expect(cluster.hosts.list().map((h) => h.name)).toEqual(["main-pc"]);
    expect(seen.deps?.machines?.hosts.verify(paired.id, paired.key)).toBe(true);
    expect(seen.deps?.machines).not.toBe(core.store.plugin(clusterTables));
  });

  it("without a machine source runs on the store's tables and the config's own section", async () => {
    const seen: { deps?: ModuleDeps } = {};
    const store = await openStore("memory://");
    core = await buildCoreWith(
      {
        openStore: () => openStore("memory://"),
        coreModules: async (deps) => {
          seen.deps = deps;
          return [];
        },
        discord: () => new Fake("platform.discord.bot"),
        api: () => new Fake("api"),
        discoverExtensions: async () => ({ skipped: [], modules: [] }),
      },
      Config.fromToml(`[core]\nprofiles_dir = '${PROFILES}'\nprofile = "deepseek-chan"\n`),
      { store, discord: false, api: false },
    );
    expect(seen.deps?.machines).toBe(store.plugin(clusterTables));
    expect(core.machines).toBeNull();
  });
});
