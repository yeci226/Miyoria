import { CommandRegistryKey, CommandsModule, Invocation, splitPath } from "@miyoria/commands";
import { Supervisor } from "@miyoria/runtime/kernel";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import { type ContextKey, type JsonValue, mergePrivacy, PresencePrivacyKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  ActionsModule,
  ActuatorRegistry,
  ActuatorRegistryKey,
  APPROVE_ROUTE,
  DENY_ROUTE,
  PAUSED_KEY,
  PRIVACY_PROFILE,
  PRIVACY_ROUTES,
} from "../src/index.js";

const GUILD: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const DM: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };

async function boot(config: JsonValue = {}, paused: boolean | null = null) {
  const sup = new Supervisor();
  const settings = new MemorySettingsStore();
  if (paused !== null) await settings.set(PRIVACY_PROFILE, PAUSED_KEY, paused);
  sup.services.provide("kernel", SettingsStoreKey, settings);
  const registry = new ActuatorRegistry({ services: sup.services });
  sup.services.provide("kernel", ActuatorRegistryKey, registry);
  await sup.register(new CommandsModule({ owners: ["discord:1"] }), {}, true);
  await sup.register(new ActionsModule("DeepSeek-chan"), config, true);
  await sup.startAll();
  const commands = sup.services.require(CommandRegistryKey);
  const run = (path: string, who: string, args: Record<string, string> = {}, at = GUILD) =>
    commands.dispatch(
      new Invocation({
        path: splitPath(path),
        args,
        invoker: { platform: "discord", id: who },
        invoker_display_name: who,
        context: at,
        invoker_is_guild_admin: false,
      }),
    );
  const click = (customId: string, who: string) =>
    commands.dispatchComponent({
      custom_id: customId,
      invoker: { platform: "discord", id: who },
      invoker_display_name: who,
      context: DM,
      invoker_is_guild_admin: false,
    });
  return { sup, settings, registry, run, click };
}

describe("actions module", () => {
  it("applies the config and restores the pause switch", async () => {
    const a = await boot({ forbidden: ["message.dm"], paused: true });
    expect(a.registry.config.forbidden).toEqual(["message.dm"]);
    expect(a.registry.paused).toBe(true);
    await a.sup.stopAll();

    // The runtime choice wins over the config.
    const b = await boot({ paused: true }, false);
    expect(b.registry.paused).toBe(false);
    await b.sup.stopAll();
  });

  it("pause and resume are admin commands", async () => {
    const a = await boot();
    const refused = await a.run("admin autonomy pause", "5");
    expect(refused.text).toContain("admin.autonomy.toggle");
    expect(a.registry.paused).toBe(false);

    // Without the ActivityManager the broadcast can not be confirmed over: it says so.
    const paused = await a.run("admin autonomy pause", "1");
    expect(paused.tone).toBe("warn");
    expect(paused.text).toContain("✗ 直播：活動管理沒有啟用");
    expect(paused.text).toContain("✓ 閉嘴");
    expect(a.registry.paused).toBe(true);
    expect(await a.settings.get(PRIVACY_PROFILE, PAUSED_KEY)).toBe(true);
    expect((await a.run("admin autonomy status", "1")).text).toContain("已緊急停止");
    await a.run("admin autonomy resume", "1");
    expect(a.registry.paused).toBe(false);
    await a.sup.stopAll();
  });

  it("me privacy sets one's own opt-outs", async () => {
    const a = await boot();
    const me = { platform: "discord", id: "5" };
    expect((await a.run("me privacy", "5", {}, DM)).text).toContain("私訊你：可以");
    const set = await a.run("me privacy", "5", { dm: "off" }, DM);
    expect(set.text).toContain("私訊你：不可以");
    expect(await a.registry.privacy.get(me)).toEqual({ dm: false, approach: true, watch: true });
    await a.run("me privacy", "5", { approach: "off", dm: "on" });
    expect(await a.registry.privacy.get(me)).toEqual({ dm: true, approach: false, watch: true });
    // Without the world module there is no presence opt-out to set.
    expect((await a.run("me privacy", "5", { presence: "off" }, DM)).text).toContain("沒有啟用");
    await a.sup.stopAll();
  });

  it("me_privacy_sets_watch", async () => {
    const a = await boot();
    const me = { platform: "discord", id: "5" };
    const set = await a.run("me privacy", "5", { watch: "off" }, DM);
    expect(set.text).toContain("看你的直播：不可以");
    expect(await a.registry.privacy.get(me)).toEqual({ dm: true, approach: true, watch: false });
    expect((await a.run("me privacy", "5", {}, DM)).text).toContain("看你的直播：不可以");
    await a.sup.stopAll();
  });

  it("the_watch_buttons_set_the_presser's_own_opt_out", async () => {
    const a = await boot();
    const me = { platform: "discord", id: "5" };
    const off = await a.click(`mi:${PRIVACY_ROUTES.watchOff}`, "5");
    expect(off?.result.type === "reply" && off.result.reply.text).toContain("看你的直播：不可以");
    expect(off?.ephemeral).toBe(true);
    expect(await a.registry.privacy.get(me)).toEqual({ dm: true, approach: true, watch: false });
    expect((await a.registry.privacy.get({ platform: "discord", id: "6" })).watch).toBe(true);
    await a.click(`mi:${PRIVACY_ROUTES.watchOn}`, "5");
    expect((await a.registry.privacy.get(me)).watch).toBe(true);
    // The toggle turns it the other way each time.
    const toggled = await a.click(`mi:${PRIVACY_ROUTES.watchToggle}`, "5");
    expect(toggled?.result.type === "reply" && toggled.result.reply.text).toContain(
      "看你的直播：不可以",
    );
    expect((await a.registry.privacy.get(me)).watch).toBe(false);
    await a.click(`mi:${PRIVACY_ROUTES.watchToggle}`, "5");
    expect((await a.registry.privacy.get(me)).watch).toBe(true);
    await a.sup.stopAll();
  });

  it("me privacy presence goes to the world module and keeps the shared record", async () => {
    const a = await boot();
    const seen = new Map<string, boolean>();
    a.sup.services.provide("world", PresencePrivacyKey, {
      loaded: true,
      presenceAllowed: (acc) => seen.get(acc.id) ?? true,
      async setPresence(acc, allowed) {
        seen.set(acc.id, allowed);
        const prev = await a.settings.get("_global", `privacy:${acc.platform}:${acc.id}`);
        await a.settings.set(
          "_global",
          `privacy:${acc.platform}:${acc.id}`,
          mergePrivacy(prev, { presence: allowed }),
        );
      },
    });
    const off = await a.run("me privacy", "5", { presence: "off" }, DM);
    expect(off.text).toContain("看你在 Discord 上的狀態（在線、遊戲、音樂、自訂狀態）：不可以");
    await a.run("me privacy", "5", { dm: "off" }, DM);
    expect(await a.settings.get("_global", "privacy:discord:5")).toEqual({
      presence: false,
      dm: false,
    });
    await a.sup.stopAll();
  });

  it("the approval buttons answer a pending request, owners only", async () => {
    const a = await boot();
    const answer = a.registry.escalations.wait("01JC0000000000000000000001", "t.high", 60_000);
    const stranger = await a.click(`mi:${APPROVE_ROUTE}:01JC0000000000000000000001`, "5");
    expect(stranger?.result.type).toBe("reply");
    expect(a.registry.escalations.isPending("01JC0000000000000000000001")).toBe(true);

    const owner = await a.click(`mi:${DENY_ROUTE}:01JC0000000000000000000001`, "1");
    expect(owner?.result.type).toBe("update");
    expect((await answer).approved).toBe(false);
    // Answering again: already handled.
    const again = await a.click(`mi:${APPROVE_ROUTE}:01JC0000000000000000000001`, "1");
    expect(again?.result.type === "update" && again.result.reply.text).toContain("已經處理過");
    await a.sup.stopAll();
  });
});
