// Who becomes a member of a server without writing there (docs/design/v5-places.md §1): whoever
// uses a command, a control or a modal there, or is seen in one of its voice channels. Against a
// fake discord.js client (an EventEmitter) and identity's real `Places` on an in-memory store.

import { EventEmitter } from "node:events";
import { CommandRegistry, CommandReply, commandSpec } from "@miyoria/commands";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  Supervisor,
} from "@miyoria/runtime/kernel";
import { type Identity, SpacePlaces } from "@miyoria/store";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { type PersonId, PlacesKey } from "@miyoria/types";
import { ChannelType, type Client, Events } from "discord.js";
import { afterEach, describe, expect, test } from "vitest";
import { DiscordConfigSchema } from "../src/config.js";
import { GatewayBridge, Shared } from "../src/handler.js";

class Probe implements Module {
  readonly manifest = defineManifest("probe", "Probe");
  ctx: ModuleContext | undefined;

  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }
}

const GUILD = "300";
/** One of her own accounts (`self_account_ids`). */
const HER = "7";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function rig() {
  const t: TestDb = openTestDb({ identity: true });
  const identity = t.identity as Identity;
  const places = new SpacePlaces(t.db, identity);
  const sup = new Supervisor();
  cleanups.push(
    () => sup.stopAll(),
    () => t.close(),
  );
  sup.services.provide("app", PlacesKey, places);
  const probe = new Probe();
  await sup.register(probe, null, true);
  await sup.startAll();
  const registry = new CommandRegistry();
  const config = DiscordConfigSchema.parse({ token: "t", command_guilds: [GUILD] });
  const shared = new Shared(config, [HER], registry, null);
  const client = new EventEmitter();
  new GatewayBridge(probe.ctx as ModuleContext, shared).attach(client as unknown as Client);
  const space = places.seen("discord", GUILD, "伺服器");
  const person = (id: string) => identity.personOf({ platform: "discord", id })?.id ?? null;
  const isMember = (id: string, where = space) => {
    const p = person(id);
    return p !== null && places.isMember(p as PersonId, where);
  };
  const memberRows = () => Number(t.db.get("SELECT COUNT(*) AS n FROM space_members")?.n);
  return { t, client, registry, places, identity, space, person, isMember, memberRows };
}

const no = () => false;
const yes = () => true;

/** A user as discord.js gives one. */
const user = (id: string, bot = false) => ({ id, username: `user${id}`, globalName: null, bot });

/** The interaction fields every kind has; `kind` is which `is*()` answers yes. */
function interaction(
  kind: "chat" | "button" | "select" | "modal" | "autocomplete",
  who: ReturnType<typeof user>,
  overrides: Record<string, unknown> = {},
) {
  const sent: unknown[] = [];
  const base = {
    isChatInputCommand: kind === "chat" ? yes : no,
    isContextMenuCommand: no,
    isAutocomplete: kind === "autocomplete" ? yes : no,
    isButton: kind === "button" ? yes : no,
    isStringSelectMenu: kind === "select" ? yes : no,
    isModalSubmit: kind === "modal" ? yes : no,
    user: who,
    guildId: GUILD,
    channelId: "200",
    channel: { type: ChannelType.GuildText },
    member: { nickname: `nick${who.id}`, roles: [] },
    replied: false,
    deferred: false,
    responded: false,
    commandName: "ping",
    customId: "someone-else:1",
    values: [],
    message: { id: "m" },
    options: { data: [], getFocused: () => ({ name: "x", value: "" }) },
    reply: async (o: unknown) => {
      sent.push(o);
      return { resource: { message: { id: "r" } } };
    },
    respond: async (o: unknown) => {
      sent.push(o);
    },
    update: async (o: unknown) => {
      sent.push(o);
      return null;
    },
    deferUpdate: async () => undefined,
    deferReply: async () => undefined,
    editReply: async () => null,
    followUp: async () => null,
    deleteReply: async () => undefined,
    ...overrides,
  };
  return { interaction: base, sent };
}

/** A voice state as discord.js gives one. */
function voice(id: string, channelId: string | null, extra: Record<string, unknown> = {}) {
  return {
    id,
    guild: { id: GUILD },
    channelId,
    channel: channelId === null ? null : { name: "語音" },
    member: { nickname: null, user: user(id) },
    selfMute: false,
    ...extra,
  };
}

/** Lets the bridge's fire-and-forget listeners run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("acting in a server makes a member", () => {
  test("a_slash_command_makes_the_invoker_a_member_before_the_command_runs", async () => {
    const r = await rig();
    let seenByCommand: boolean | null = null;
    r.registry.register(commandSpec("ping", "Ping"), (inv) => {
      seenByCommand = r.isMember(inv.invoker.id);
      return CommandReply.public("pong");
    });
    const { interaction: i, sent } = interaction("chat", user("42"));
    r.client.emit(Events.InteractionCreate, i);
    await settle();
    expect(sent).toHaveLength(1);
    expect(seenByCommand).toBe(true);
    expect(r.isMember("42")).toBe(true);
    // Named as the server shows them.
    expect(r.identity.personOf({ platform: "discord", id: "42" })?.name).toBe("nick42");
  });

  test("a_button_a_select_and_a_modal_make_members_and_autocomplete_does_not", async () => {
    const r = await rig();
    r.client.emit(Events.InteractionCreate, interaction("button", user("43")).interaction);
    r.client.emit(Events.InteractionCreate, interaction("select", user("44")).interaction);
    r.client.emit(Events.InteractionCreate, interaction("modal", user("45")).interaction);
    r.client.emit(Events.InteractionCreate, interaction("autocomplete", user("46")).interaction);
    await settle();
    expect(["43", "44", "45"].map((id) => r.isMember(id))).toEqual([true, true, true]);
    expect(r.person("46")).toBeNull();
    expect(r.memberRows()).toBe(3);
  });

  test("a_command_in_a_dm_makes_no_member", async () => {
    const r = await rig();
    r.registry.register(commandSpec("ping", "Ping"), () => CommandReply.public("pong"));
    const dm = interaction("chat", user("42"), { guildId: null, channel: null, member: null });
    r.client.emit(Events.InteractionCreate, dm.interaction);
    await settle();
    expect(dm.sent).toHaveLength(1);
    expect(r.memberRows()).toBe(0);
  });

  test("a_server_not_recorded_yet_is_recorded_with_its_member", async () => {
    const r = await rig();
    r.client.emit(
      Events.InteractionCreate,
      interaction("button", user("43"), { guildId: "999" }).interaction,
    );
    await settle();
    const other = r.places.ofGuild("discord", "999");
    expect(other).not.toBeNull();
    expect(r.isMember("43", other?.id)).toBe(true);
    expect(r.isMember("43")).toBe(false);
  });

  test("joining_or_moving_into_a_voice_channel_makes_a_member_and_a_mute_writes_nothing", async () => {
    const r = await rig();
    r.client.emit(Events.VoiceStateUpdate, voice("50", null), voice("50", "v1"));
    await settle();
    expect(r.isMember("50")).toBe(true);
    expect(r.identity.personOf({ platform: "discord", id: "50" })?.name).toBe("user50");

    // Left the server; a mute in the same channel is not acting again.
    r.places.memberLeft(r.space, { platform: "discord", id: "50" });
    r.client.emit(
      Events.VoiceStateUpdate,
      voice("50", "v1"),
      voice("50", "v1", { selfMute: true }),
    );
    // Leaving the channel neither.
    r.client.emit(Events.VoiceStateUpdate, voice("50", "v1"), voice("50", null));
    await settle();
    expect(r.isMember("50")).toBe(false);
    // Moving into another channel is.
    r.client.emit(Events.VoiceStateUpdate, voice("50", "v1"), voice("50", "v2"));
    await settle();
    expect(r.isMember("50")).toBe(true);
  });

  test("bots_and_her_own_accounts_never_become_members", async () => {
    const r = await rig();
    r.client.emit(Events.InteractionCreate, interaction("button", user("60", true)).interaction);
    r.client.emit(Events.InteractionCreate, interaction("button", user(HER)).interaction);
    const bot = voice("61", "v1", { member: { nickname: null, user: user("61", true) } });
    r.client.emit(Events.VoiceStateUpdate, voice("61", null), bot);
    r.client.emit(Events.VoiceStateUpdate, voice(HER, null), voice(HER, "v1"));
    // A voice state without its member: whether it is a bot is unknown, so nobody is made one.
    r.client.emit(Events.VoiceStateUpdate, null, voice("62", "v1", { member: null }));
    await settle();
    expect(r.memberRows()).toBe(0);
    for (const id of ["60", HER, "61", "62"]) expect(r.person(id)).toBeNull();
  });

  test("people_in_voice_when_she_connects_are_members", async () => {
    const r = await rig();
    const guild = {
      id: GUILD,
      name: "伺服器",
      members: { fetch: async () => undefined, cache: { values: () => [].values() } },
      presences: { cache: { values: () => [].values() } },
      voiceStates: { cache: { values: () => [voice("70", "v1"), voice("71", null)].values() } },
    };
    r.client.emit(Events.GuildCreate, guild);
    await settle();
    expect(r.isMember("70")).toBe(true);
    expect(r.person("71")).toBeNull();
  });
});
