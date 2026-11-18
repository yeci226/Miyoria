// Core with the real module catalog: `watch` is off unless its section says `enabled = true`, and
// when it is on her tools and prompt section are there even with no voice node to watch through.

import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ActuatorRegistryKey } from "@miyoria/gate/actions";
import { Config } from "@miyoria/runtime/kernel";
import { openStore } from "@miyoria/store";
import { Principals, PromptContributorsKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { buildCoreWith, type Core } from "../src/boot.js";
import { defaultCatalog } from "../src/modules.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const BASE = join(ROOT, ".tmp-test-b2", "watch-boot");

const config = (extra: string): Config =>
  Config.fromToml(`
[core]
profiles_dir = '${join(ROOT, "profiles")}'
profile = "deepseek-chan"
[modules.cluster]
enabled = false
${extra}
`);

let core: Core | undefined;

async function boot(extra: string): Promise<Core> {
  mkdirSync(BASE, { recursive: true });
  core = await buildCoreWith(
    { ...defaultCatalog, discoverExtensions: async () => ({ skipped: [], modules: [] }) },
    config(extra),
    { discord: false, api: false, baseDir: BASE, store: await openStore("memory://") },
  );
  await core.start();
  return core;
}

afterEach(async () => {
  await core?.stop();
  core = undefined;
  rmSync(BASE, { recursive: true, force: true });
});

const state = (c: Core) => c.supervisor.list().find((m) => m.id === "watch")?.state;
const watchNames = (c: Core) =>
  c.services
    .require(ActuatorRegistryKey)
    .names()
    .filter((n) => n.startsWith("watch."))
    .sort();

describe("the watch module in Core", () => {
  it("is_not_running_without_its_section", async () => {
    const c = await boot("");
    expect(state(c)).toBe("disabled");
    expect(watchNames(c)).toEqual([]);
    expect(
      c.services
        .require(PromptContributorsKey)
        .all()
        .map((p) => p.key),
    ).not.toContain("watch");
  });

  it("is_not_running_with_a_section_that_leaves_enabled_out", async () => {
    const c = await boot("[modules.watch]\nsnapshot_secs = 10");
    expect(state(c)).toBe("disabled");
    expect(watchNames(c)).toEqual([]);
  });

  it("runs_with_enabled_true_and_offers_its_tools", async () => {
    const c = await boot("[modules.watch]\nenabled = true");
    expect(state(c)).toBe("running");
    expect(watchNames(c)).toEqual(["watch.look", "watch.start", "watch.stop"]);
    expect(
      c.services
        .require(PromptContributorsKey)
        .all()
        .map((p) => p.key),
    ).toContain("watch");
    // No voice node in this Core: she is told so, nothing throws.
    const outcome = await c.services.require(ActuatorRegistryKey).invoke({
      principal: Principals.self(null),
      capability: "watch.start",
      args: {},
      why: null,
      turn: null,
    });
    expect(outcome.status).toBe("denied");
    expect(outcome.status === "denied" && outcome.decision.reason).toContain("語音節點");
  }, 60_000);
});
