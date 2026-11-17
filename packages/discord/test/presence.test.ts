// Presence / voice state / member mapping and the bridge's privacy filter, against plain objects
// and a fake client: no live Discord.

import { EventEmitter } from "node:events";
import { CommandRegistry } from "@miyoria/commands";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  Supervisor,
} from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type JsonValue,
  PlatformSinks,
  type PresencePrivacy,
  PresencePrivacyKey,
} from "@miyoria/types";
import { ActivityType, type Client, Events } from "discord.js";
import { afterEach, describe, expect, test } from "vitest";
import { DiscordConfigSchema } from "../src/config.js";
import { GatewayBridge, type GuildLike, Shared } from "../src/handler.js";
import {
  activity,
  cleanText,
  memberUpdate,
  type PresenceLike,
  presenceStatus,
  presenceUpdate,
  type VoiceStateLike,
  voiceStateUpdate,
} from "../src/presence.js";

const user = { id: "42", username: "alice_w", globalName: "Alice", bot: false };

function presenceOf(extra: Partial<PresenceLike> = {}): PresenceLike {
  return {
    userId: "42",
    guild: { id: "300" },
    status: "online",
    activities: [],
    user,
    member: { nickname: "Ali", user },
    ...extra,
  };
}

function voiceOf(extra: Partial<VoiceStateLike> = {}): VoiceStateLike {
  return {
    id: "42",
    guild: { id: "300" },
    channelId: "500",
    channel: { name: "雜談" },
    selfMute: true,
    selfDeaf: false,
    serverMute: false,
    serverDeaf: null,
    selfVideo: false,
    streaming: true,
    member: { nickname: null, user },
    ...extra,
  };
}

describe("presence mapping", () => {
  test("maps_games_spotify_streams_and_custom_status", () => {
    const start = new Date("2026-11-02T10:00:00.000Z");
    const p = presenceUpdate(
      presenceOf({
        status: "dnd",
        activities: [
          {
            name: "Minecraft",
            type: ActivityType.Playing,
            details: "Survival",
            timestamps: { start },
          },
          { name: "Spotify", type: ActivityType.Listening, details: "Song", state: "Artist A; B" },
          {
            name: "Twitch",
            type: ActivityType.Streaming,
            details: "Stream",
            url: "https://twitch.tv/x",
          },
          {
            name: "Custom Status",
            type: ActivityType.Custom,
            state: "考試中",
            emoji: { name: "📚" },
          },
        ],
      }),
      false,
    );
    expect(p).toEqual({
      platform: "discord",
      guild: "300",
      account: { platform: "discord", id: "42" },
      display_name: "Ali",
      is_bot: false,
      status: "dnd",
      initial: false,
      activities: [
        {
          type: "playing",
          name: "Minecraft",
          details: "Survival",
          state: null,
          started_at: "2026-11-02T10:00:00.000Z",
          url: null,
        },
        {
          type: "listening",
          name: "Spotify",
          details: "Song",
          state: "Artist A; B",
          started_at: null,
          url: null,
        },
        {
          type: "streaming",
          name: "Twitch",
          details: "Stream",
          state: null,
          started_at: null,
          url: "https://twitch.tv/x",
        },
        { type: "custom", name: "考試中", details: "📚", state: null, started_at: null, url: null },
      ],
    });
  });

  test("statuses_names_and_untrusted_text", () => {
    expect(presenceStatus("invisible")).toBe("offline");
    expect(presenceStatus("idle")).toBe("idle");
    expect(presenceUpdate(presenceOf({ guild: null }), false)).toBeNull();
    // Without member data: the global name, then the id.
    expect(presenceUpdate(presenceOf({ member: null }), true)?.display_name).toBe("Alice");
    expect(presenceUpdate(presenceOf({ member: null, user: null }), true)?.display_name).toBe("42");
    expect(cleanText(" a\nb\u0007c ")).toBe("a b c");
    expect(cleanText("   ")).toBeNull();
    expect([...(cleanText("x".repeat(500)) ?? "")].length).toBe(129);
    expect(activity({ name: "x", type: 99 as ActivityType })).toBeNull();
  });

  test("maps_voice_states_and_members", () => {
    expect(voiceStateUpdate(voiceOf(), true)).toEqual({
      platform: "discord",
      guild: "300",
      account: { platform: "discord", id: "42" },
      display_name: "Alice",
      is_bot: false,
      channel: "500",
      channel_name: "雜談",
      self_mute: true,
      self_deaf: false,
      server_mute: false,
      server_deaf: false,
      video: false,
      streaming: true,
      initial: true,
    });
    const left = voiceStateUpdate(voiceOf({ channelId: null, channel: null }), false);
    expect(left).toMatchObject({ channel: null, channel_name: null });
    expect(memberUpdate({ id: "42", guild: { id: "300" }, nickname: "Ali", user }, true)).toEqual({
      platform: "discord",
      guild: "300",
      account: { platform: "discord", id: "42" },
      display_name: "Ali",
      is_bot: false,
      left: true,
    });
  });
});

class Probe implements Module {
  readonly manifest = defineManifest("probe", "Probe");
  ctx: ModuleContext | undefined;
  async start(ctx: ModuleContext): Promise<void> {
    this.ctx = ctx;
  }
}

class Privacy implements PresencePrivacy {
  readonly denied = new Set<string>();
  readonly loaded = true;
  presenceAllowed(account: AccountRef): boolean {
    return !this.denied.has(account.id);
  }
  async setPresence(account: AccountRef, allowed: boolean): Promise<void> {
    if (allowed) this.denied.delete(account.id);
    else this.denied.add(account.id);
  }
}

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const sup of sups.splice(0)) await sup.stopAll();
});

async function rig(privacy: Privacy | null, presenceIntents = true) {
  const sup = new Supervisor();
  sups.push(sup);
  if (privacy) sup.services.provide("app", PresencePrivacyKey, privacy);
  const probe = new Probe();
  await sup.register(probe, null, true);
  await sup.startAll();
  const config = DiscordConfigSchema.parse({ token: "t", presence_intents: presenceIntents });
  const shared = new Shared(config, ["7"], new CommandRegistry(), new PlatformSinks());
  const bridge = new GatewayBridge(probe.ctx as ModuleContext, shared);
  const client = new EventEmitter();
  bridge.attach(client as unknown as Client);
  const events = sup.bus.subscribe("platform.*");
  const drain = async () => {
    await new Promise((r) => setTimeout(r, 10));
    const out: { topic: string; payload: JsonValue }[] = [];
    for (let e = events.tryRecv(); e; e = events.tryRecv()) {
      out.push({ topic: e.type, payload: e.data as JsonValue });
    }
    return out;
  };
  return { bridge, client, drain };
}

describe("bridge presence", () => {
  test("publishes_presence_only_for_people_who_allow_it", async () => {
    const privacy = new Privacy();
    privacy.denied.add("43");
    const r = await rig(privacy);
    r.client.emit(Events.PresenceUpdate, null, presenceOf());
    r.client.emit(Events.PresenceUpdate, null, presenceOf({ userId: "43" }));
    // Her own accounts are never published.
    r.client.emit(Events.PresenceUpdate, null, presenceOf({ userId: "7" }));
    r.client.emit(Events.VoiceStateUpdate, null, voiceOf({ id: "43" }));
    r.client.emit(Events.GuildMemberRemove, { id: "44", guild: { id: "300" }, user: null });
    const out = await r.drain();
    expect(
      out.map((e) => [e.topic, (e.payload as unknown as { account: AccountRef }).account.id]),
    ).toEqual([
      ["platform.presence", "42"],
      ["platform.voice_state", "43"],
      ["platform.member", "44"],
    ]);
  });

  test("fails_closed_without_the_privacy_service", async () => {
    const r = await rig(null);
    r.client.emit(Events.PresenceUpdate, null, presenceOf());
    expect(await r.drain()).toEqual([]);
  });

  test("snapshots_a_guild_as_initial_updates", async () => {
    const r = await rig(new Privacy());
    let fetched = 0;
    const guild: GuildLike = {
      id: "300",
      members: {
        fetch: async () => {
          fetched++;
        },
        cache: { values: () => [{ id: "42", guild: { id: "300" }, user }].values() },
      },
      presences: { cache: { values: () => [presenceOf()].values() } },
      voiceStates: { cache: { values: () => [voiceOf()].values() } },
    };
    await r.bridge.snapshotGuild(guild);
    const out = await r.drain();
    expect(fetched).toBe(1);
    expect(
      out.map((e) => [e.topic, (e.payload as unknown as { initial?: boolean }).initial]),
    ).toEqual([
      ["platform.member", undefined],
      ["platform.presence", true],
      ["platform.voice_state", true],
    ]);

    // Without the privileged intents only voice states are known.
    const plain = await rig(new Privacy(), false);
    await plain.bridge.snapshotGuild(guild);
    expect((await plain.drain()).map((e) => e.topic)).toEqual(["platform.voice_state"]);
    expect(fetched).toBe(1);
  });
});
