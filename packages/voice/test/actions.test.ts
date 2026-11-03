// The voice capabilities as her tools: each calls the voice link through the gate.

import { ActuatorRegistry } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import { type ToolContext, ToolRegistry } from "@miyoria/tools";
import {
  type AccountRef,
  AuthorizerKey,
  BaseAuthorizer,
  type ContextKey,
  type Event,
  PlatformSinks,
  PlatformSinksKey,
  Principals,
  type StreamCurtain,
  StreamCurtainKey,
  type Subject,
  type VoiceFloor,
  type WorldState,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { joinTarget, STAY_AFTER_INVITE_MS, voiceCapabilities } from "../src/actions.js";
import type { VoiceLink } from "../src/index.js";

const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OWEN: AccountRef = { platform: "discord", id: "7" };

class Grants extends BaseAuthorizer {
  constructor(readonly nodes: Set<string>) {
    super();
  }

  allowsSubject(_subject: Subject, node: string): boolean {
    return this.nodes.has(node);
  }
}

class FakeLink {
  readonly calls: string[] = [];
  connected = true;
  inVoice: string | null = null;
  streaming = false;

  isConnected() {
    return this.connected;
  }

  channel() {
    return this.inVoice;
  }

  isStreaming() {
    return this.streaming;
  }

  async join(guild: string, channel: string | null, user: string | null) {
    this.calls.push(`join ${guild} ${channel} ${user}`);
    this.inVoice = channel ?? "vc-of-user";
    return this.inVoice;
  }

  async leave(guild: string) {
    this.calls.push(`leave ${guild}`);
    this.inVoice = null;
  }

  async goliveStart(req: { guild: string; source: string }) {
    this.calls.push(`golive ${req.guild} ${req.source}`);
    this.streaming = true;
  }

  async goliveStop(guild: string) {
    this.calls.push(`golive_stop ${guild}`);
    this.streaming = false;
  }
}

interface SetupOptions {
  /** Songs still to sing, and whether one is playing. */
  songs?: { playing: boolean; pending: number };
  /** People (other than her) in the voice channel she is in. */
  others?: number;
  now?: () => number;
}

function setup(nodes: string[], options: SetupOptions = {}) {
  const link = new FakeLink();
  const world = {
    snapshot: () => ({
      voice_channels: [
        {
          guild: "g1",
          channel: link.inVoice ?? "",
          members: [
            { is_self: true },
            ...Array.from({ length: options.others ?? 0 }, () => ({ is_self: false })),
          ],
        },
      ],
    }),
    person: () => null,
  } as unknown as WorldState;
  const songs = options.songs;
  const floor: VoiceFloor | undefined = songs
    ? { holder: () => (songs.playing ? "song" : null), pending: () => songs.pending }
    : undefined;
  const services = new ServiceRegistry();
  services.provide("test", AuthorizerKey, new Grants(new Set(nodes)));
  const tools = new ToolRegistry();
  const events: Event[] = [];
  const registry = new ActuatorRegistry({
    services,
    tools,
    builtins: false,
    publish: (e) => events.push(e),
  });
  for (const c of voiceCapabilities(
    link as unknown as VoiceLink,
    () => "rtmp://obs/live",
    () => world,
    () => floor,
    options.now,
  )) {
    registry.register(c);
  }
  const ctx: ToolContext = {
    turn: "01JC0000000000000000000000",
    context: CTX,
    account: OWEN,
    principal: Principals.user(OWEN, CTX),
    message: { context: CTX, id: "m" },
    priority: "direct",
    signal: new AbortController().signal,
  };
  return { link, tools, registry, ctx, events, services };
}

/** She asks to leave on her own (her mind), in the server's text channel. */
async function leaveOnHerOwn(s: ReturnType<typeof setup>) {
  return s.registry.invoke({
    principal: Principals.self(CTX),
    capability: "voice.leave",
    args: {},
    why: "喉嚨乾,想休息",
    turn: null,
  });
}

describe("leaving on her own", () => {
  it("is refused while a song plays or songs are still to sing; a person can still send her away", async () => {
    const songs = { playing: true, pending: 2 };
    const s = setup(["voice.leave"], { songs });
    s.link.inVoice = "vc1";
    const playing = await leaveOnHerOwn(s);
    expect(playing.status).toBe("denied");
    expect(playing.decision.reason).toMatch(/正在唱歌/);
    songs.playing = false;
    const queued = await leaveOnHerOwn(s);
    expect(queued.decision.reason).toMatch(/還有 2 首歌/);
    expect(s.link.calls).toEqual([]);
    // Someone asking her to leave is not her own idea.
    expect(await s.tools.get("voice_leave")?.call(s.ctx, {})).toBe("left the voice channel");
    expect(s.link.calls).toEqual(["leave g1"]);
  });

  it("is refused for a while after someone brought her in, while people are still there", async () => {
    let t = 1_000_000;
    const s = setup(["voice.join", "voice.leave"], { others: 3, now: () => t });
    await s.tools.get("voice_join")?.call(s.ctx, {});
    t += 5 * 60_000;
    const early = await leaveOnHerOwn(s);
    expect(early.status).toBe("denied");
    expect(early.decision.reason).toMatch(/5 分鐘前有人叫你進語音,大家\(3 人\)還在/);
    t += STAY_AFTER_INVITE_MS;
    expect((await leaveOnHerOwn(s)).status).toBe("done");
    expect(s.link.calls).toEqual(["join g1 null 7", "leave g1"]);
  });

  it("may leave an empty channel, or one she joined on her own", async () => {
    const t = 1_000_000;
    const empty = setup(["voice.join", "voice.leave"], { others: 0, now: () => t });
    await empty.tools.get("voice_join")?.call(empty.ctx, {});
    expect((await leaveOnHerOwn(empty)).status).toBe("done");

    const own = setup(["voice.join", "voice.leave"], { others: 2, now: () => t });
    await own.registry.invoke({
      principal: Principals.self(CTX),
      capability: "voice.join",
      args: { channel: "vc9" },
      why: "想陪大家",
      turn: null,
    });
    expect((await leaveOnHerOwn(own)).status).toBe("done");
  });
});

describe("voice status", () => {
  function withSink(s: ReturnType<typeof setup>) {
    const set: [ContextKey, string][] = [];
    const sinks = new PlatformSinks();
    sinks.register({
      platform: "discord",
      send: async (context) => ({ context, id: "1" }),
      react: async () => {},
      typing: async () => {},
      setVoiceStatus: async (context, status) => {
        set.push([context, status]);
      },
    });
    s.services.provide("test", PlatformSinksKey, sinks);
    return set;
  }

  const onHerOwn = (s: ReturnType<typeof setup>, status: string) =>
    s.registry.invoke({
      principal: Principals.self(CTX),
      capability: "voice.status",
      args: { status },
      why: "想讓大家知道在幹嘛",
      turn: null,
    });

  it("she sets and clears the status of the voice channel she is in", async () => {
    const s = setup([]);
    const set = withSink(s);
    s.link.inVoice = "vc1";
    expect((await onHerOwn(s, "🎤 在唱歌")).status).toBe("done");
    expect((await onHerOwn(s, "")).status).toBe("done");
    const vc: ContextKey = { platform: "discord", scope: "g1", channel: "vc1", kind: "voice" };
    expect(set).toEqual([
      [vc, "🎤 在唱歌"],
      [vc, ""],
    ]);
  });

  it("fails when she is not in voice; people need voice.status to ask", async () => {
    const s = setup([]);
    const set = withSink(s);
    const out = await onHerOwn(s, "聊天中");
    expect(out).toMatchObject({ status: "failed", error: expect.stringMatching(/not in a voice/) });
    s.link.inVoice = "vc1";
    await expect(s.tools.get("voice_status")?.call(s.ctx, { status: "x" })).rejects.toThrow(
      /not allowed/,
    );
    expect(set).toEqual([]);
  });
});

describe("voice capabilities", () => {
  it("voice_join follows the requester; leave, go live and stop go through the gate", async () => {
    const s = setup(["voice.join", "voice.leave", "voice.golive"]);
    expect(s.tools.names()).toEqual([
      "stream_start",
      "stream_stop",
      "voice_join",
      "voice_leave",
      "voice_status",
    ]);
    expect(await s.tools.get("voice_join")?.call(s.ctx, { why: "Owen 叫我" })).toContain(
      "joined voice channel",
    );
    expect(await s.tools.get("stream_start")?.call(s.ctx, {})).toBe("Go Live started");
    expect(await s.tools.get("stream_stop")?.call(s.ctx, {})).toBe("Go Live stopped");
    expect(await s.tools.get("voice_leave")?.call(s.ctx, {})).toBe("left the voice channel");
    expect(s.link.calls).toEqual([
      "join g1 null 7",
      "golive g1 rtmp://obs/live",
      "golive_stop g1",
      "leave g1",
    ]);
    const decisions = s.events.flatMap((e) =>
      e.type === "custom" && e.data.topic === "gate.decision"
        ? [e.data.payload as Record<string, unknown>]
        : [],
    );
    expect(decisions.map((d) => d.capability)).toEqual([
      "voice.join",
      "stream.start",
      "stream.stop",
      "voice.leave",
    ]);
    expect(decisions[0]).toMatchObject({ why: "Owen 叫我", principal: { kind: "user" } });
  });

  it("a request she may not take is refused before the link is touched", async () => {
    const s = setup([]);
    await expect(s.tools.get("stream_start")?.call(s.ctx, {})).rejects.toThrow(/not allowed/);
    expect(s.link.calls).toEqual([]);
    // Going live joins the requester first when she is not in voice yet.
    expect(await s.tools.get("stream_start")?.call(s.ctx, { on_own: true })).toBe(
      "Go Live started",
    );
    expect(s.link.calls).toEqual(["join g1 null 7", "golive g1 rtmp://obs/live"]);
  });

  it("stream_stop lets the stage show the ending scene first", async () => {
    const s = setup(["voice.golive"]);
    s.link.streaming = true;
    s.link.inVoice = "vc1";
    const curtain: StreamCurtain = {
      close: async () => {
        s.link.calls.push("curtain");
      },
    };
    s.services.provide("stage.link", StreamCurtainKey, curtain);
    expect(await s.tools.get("stream_stop")?.call(s.ctx, {})).toBe("Go Live stopped");
    expect(s.link.calls).toEqual(["curtain", "golive_stop g1"]);
  });

  it("another server is off limits for her and chat requests", async () => {
    const s = setup(["voice.join"]);
    await expect(s.tools.get("voice_join")?.call(s.ctx, { guild: "g2" })).rejects.toThrow(
      /not across servers/,
    );
    expect(s.link.calls).toEqual([]);
  });
});

describe("joinTarget", () => {
  const requester = { platform: "discord", id: "u1" };
  const principal = { kind: "user", requester, context: null } as never;
  const worldWith = (voice: { guild: string; channel: string } | null) =>
    ({
      person: () =>
        voice === null
          ? null
          : { voice: { platform: "discord", guild: voice.guild, channel: voice.channel } },
    }) as never;

  it("uses the requester's channel from the bot's world view", () => {
    expect(joinTarget("g1", principal, worldWith({ guild: "g1", channel: "vc9" }))).toEqual({
      channel: "vc9",
      follow: null,
    });
  });

  it("falls back to asking the voice node when the world doesn't know", () => {
    expect(joinTarget("g1", principal, undefined)).toEqual({ channel: null, follow: "u1" });
    expect(joinTarget("g1", principal, worldWith(null))).toEqual({ channel: null, follow: "u1" });
    // In voice, but on another server.
    expect(joinTarget("g1", principal, worldWith({ guild: "g2", channel: "vc9" }))).toEqual({
      channel: null,
      follow: "u1",
    });
  });

  it("on her own idea joins the busiest voice channel of the server", () => {
    const self = { kind: "self", requester: null } as never;
    expect(joinTarget("g1", self, undefined)).toEqual({ channel: null, follow: null });
    const member = (self: boolean) => ({ is_self: self });
    const world = {
      snapshot: () => ({
        voice_channels: [
          { guild: "g1", channel: "quiet", members: [member(true)] },
          { guild: "g1", channel: "two", members: [member(false), member(false)] },
          { guild: "g1", channel: "one", members: [member(false)] },
          {
            guild: "g2",
            channel: "elsewhere",
            members: [member(false), member(false), member(false)],
          },
        ],
      }),
    } as never;
    expect(joinTarget("g1", self, world)).toEqual({ channel: "two", follow: null });
  });
});
