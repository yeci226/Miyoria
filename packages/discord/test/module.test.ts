import { CommandsModule } from "@miyoria/commands";
import { EventBus, manifestJson, ServiceRegistry, Supervisor } from "@miyoria/runtime/kernel";
import { Events, is } from "@miyoria/types";
import { GatewayIntentBits } from "discord.js";
import { describe, expect, test } from "vitest";
import { DiscordBotModule, intents } from "../src/index.js";

describe("DiscordBotModule", () => {
  test("manifest", () => {
    const module = new DiscordBotModule();
    expect(module.manifest.id).toBe("platform.discord.bot");
    expect(module.manifest.requires).toEqual([CommandsModule.ID]);
    const json = manifestJson(module.manifest);
    expect(JSON.stringify(json.config_schema)).toContain("self_account_ids");
    expect(JSON.stringify(json.config_schema)).toContain("command_guilds");
  });

  test("intents_include_message_content_typing_and_voice_states", () => {
    const bits = intents();
    for (const intent of [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageTyping,
      GatewayIntentBits.DirectMessageTyping,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.DirectMessageReactions,
    ]) {
      expect(bits & intent, String(intent)).toBe(intent);
    }
    // Presences and members are privileged: only with `presence_intents`.
    expect(bits & GatewayIntentBits.GuildPresences).toBe(0);
    expect(bits & GatewayIntentBits.GuildMembers).toBe(0);
    const presence = intents({ presence: true });
    expect(presence & GatewayIntentBits.GuildPresences).toBe(GatewayIntentBits.GuildPresences);
    expect(presence & GatewayIntentBits.GuildMembers).toBe(GatewayIntentBits.GuildMembers);
    expect(presence & bits).toBe(bits);
  });

  async function failureReason(config: unknown): Promise<string> {
    const bus = new EventBus();
    const states = bus.subscribe("system.module.state");
    const sup = new Supervisor({ bus, services: new ServiceRegistry() });
    await sup.register(new CommandsModule(), null, true);
    await sup.register(new DiscordBotModule(), config as never, true);
    await sup.startAll();
    try {
      for (;;) {
        const env = await states.recv();
        if (env !== null && is(Events.SystemModuleState, env) && env.data.state === "failed") {
          return env.data.reason ?? "";
        }
      }
    } finally {
      await sup.stopAll();
    }
  }

  test("a_missing_token_fails_the_start_without_connecting", async () => {
    expect(await failureReason({})).toContain("token");
  });

  test("an_empty_token_or_bad_self_account_fails_the_start", async () => {
    expect(await failureReason({ token: " " })).toContain("`token` is empty");
    expect(await failureReason({ token: "secret-value", self_account_ids: ["nope"] })).toContain(
      "invalid Discord user id `nope`",
    );
  });

  test("errors_do_not_leak_the_token", async () => {
    const reason = await failureReason({ token: "super-secret-token", command_guilds: [0] });
    expect(reason).toContain("`command_guilds` contains 0");
    expect(reason).not.toContain("super-secret-token");
  });

  test("health_reports_not_running_before_start", async () => {
    expect(await new DiscordBotModule().health()).toEqual({
      status: "unhealthy",
      reason: "not running",
    });
  });
});
