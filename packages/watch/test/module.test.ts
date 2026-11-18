import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import { Supervisor } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type ContextKey,
  claimOf,
  Events,
  type Impulse,
  type MessageRef,
  PlatformSinks,
  PlatformSinksKey,
  Principals,
  PromptContributors,
  PromptContributorsKey,
  type PromptRequest,
  toTimestamp,
  VoiceFloorKey,
  type VoiceMember,
  type WorldSnapshot,
  WorldStateKey,
} from "@miyoria/types";
import {
  type StreamHearing,
  StreamHearingKey,
  VoiceLinkError,
  VoiceLinkKey,
} from "@miyoria/voice/voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchModule } from "../src/module.js";

const G = "g1";
const voice = (channel: string, guild = G): ContextKey => ({
  platform: "discord",
  scope: guild,
  channel,
  kind: "voice",
});
const text: ContextKey = { platform: "discord", scope: G, channel: "text", kind: "channel" };
const account = (id: string): AccountRef => ({ platform: "discord", id });

const member = (id: string, name: string, streaming = true): VoiceMember => ({
  account: account(id),
  person: null,
  display_name: name,
  is_self: false,
  muted: false,
  deafened: false,
  video: false,
  streaming,
  since: toTimestamp(0),
});

class Rig {
  readonly sup = new Supervisor();
  readonly registry: ActuatorRegistry;
  readonly prompts = new PromptContributors();
  readonly sinks = new PlatformSinks();
  /** Every impulse of hers the module published. */
  readonly impulses: Impulse[] = [];
  channel: string | null = "c1";
  members: VoiceMember[] = [member("u1", "小明"), member("u2", "阿華")];
  worth = false;
  modelCalls = 0;
  floor: string | null = null;
  /** Moves the action gate's clock, past its cooldown. */
  skew = 0;
  readonly watchStart = vi.fn(async (_guild: string, user: string) => this.status(user, "live"));
  readonly watchStop = vi.fn(async (_guild: string) => {});
  readonly send = vi.fn(async (context: ContextKey) => ({ context, id: "m" }) as MessageRef);

  constructor(withLink = true) {
    const s = this.sup.services;
    this.registry = new ActuatorRegistry({
      services: s,
      builtins: false,
      clock: { now: () => Date.now() + this.skew } as never,
    });
    s.provide("app", ActuatorRegistryKey, this.registry);
    s.provide("app", PromptContributorsKey, this.prompts);
    s.provide("app", PlatformSinksKey, this.sinks);
    this.sinks.register({ platform: "discord", send: this.send } as never);
    s.provide("llm", LlmRouterKey, {
      budgetState: () => "ok",
      takesImages: () => true,
      complete: async () => {
        this.modelCalls++;
        const n = this.modelCalls;
        return {
          text: JSON.stringify({ note: `note ${n}`, worth_saying: this.worth, topic: `t${n}` }),
          reasoning: "",
          tool_calls: [],
          finish_reason: "stop",
          usage: null,
        };
      },
    } as never);
    s.provide("world", WorldStateKey, {
      snapshot: () =>
        ({
          her: { voice: this.channel === null ? null : voice(this.channel) },
          voice_channels: [
            { platform: "discord", guild: G, channel: "c1", name: null, members: this.members },
          ],
        }) as unknown as WorldSnapshot,
      person: () => null,
      personById: () => null,
      summary: () => "",
    });
    s.provide("sing", VoiceFloorKey, { holder: () => this.floor });
    if (withLink) this.provideLink();
    void this.collect(this.sup.bus.subscribe(Events.ArbiterImpulse.type));
  }

  async collect(events: AsyncIterable<{ data: unknown }>): Promise<void> {
    for await (const env of events) this.impulses.push(env.data as Impulse);
  }

  status(
    user: string,
    state: "starting" | "live" | "stopped" | "failed",
    reason = null as string | null,
  ) {
    this.sup.bus.publish("test", Events.VoiceWatch, {
      platform: "discord",
      guild: G,
      user_id: user,
      state,
      error: null,
      reason,
    });
  }

  provideLink({ watchStart, watchStop } = this as Pick<Rig, "watchStart" | "watchStop">): void {
    this.sup.services.provide("voice.link", VoiceLinkKey, {
      channel: (guild: string) => (guild === G ? this.channel : null),
      isStreaming: () => false,
      canWatch: () => true,
      isSelf: (a: AccountRef) => a.id === "her",
      watchStart,
      watchStop,
      snapshot: async () => Buffer.from([1]),
      subscribeWatchAudio: () => (async function* () {})(),
    } as never);
  }

  async start(config: object = {}, enabled = true): Promise<void> {
    await this.sup.register(
      new WatchModule({ persona: () => "鯨魚娘" }),
      { snapshot_secs: 0.01, speak_min_secs: 0, quiet_secs: 0, ...config },
      enabled,
    );
    await this.sup.startAll();
  }

  invoke(capability: string, args: object = {}, principal = Principals.self(voice("c1"))) {
    return this.registry.invoke({
      principal,
      capability,
      args: args as never,
      why: null,
      turn: null,
    });
  }

  watch(user = "小明") {
    return this.invoke("watch.start", { user });
  }

  prompt(context: ContextKey): Promise<{ title: string; body: string; order: number }[]> {
    const request = { context } as PromptRequest;
    const [contributor] = this.prompts.all();
    if (!contributor) throw new Error("no contributor");
    return contributor.contribute(request);
  }

  async rounds(n: number): Promise<void> {
    const until = this.modelCalls + n;
    await expect.poll(() => this.modelCalls >= until).toBe(true);
  }

  /** Something happened in voice that the module listens to. */
  left(context: ContextKey): void {
    this.sup.bus.publish("test", Events.VoiceLeft, { context, reason: "kicked" });
  }

  joined(context: ContextKey): void {
    this.sup.bus.publish("test", Events.VoiceJoined, { context, participants: [] });
  }

  speaking(who: AccountRef, speaking: boolean): void {
    this.sup.bus.publish("test", Events.VoiceSpeaking, {
      context: voice("c1"),
      account: who,
      speaking,
    });
  }

  playback(state: "started" | "finished" | "interrupted" | "failed"): void {
    this.sup.bus.publish("test", Events.VoicePlaybackEvent, {
      context: voice("c1"),
      turn: null,
      state,
      text: "嗨",
    });
  }
}

const reason = (outcome: Awaited<ReturnType<Rig["invoke"]>>): string =>
  outcome.status === "denied"
    ? outcome.decision.reason
    : outcome.status === "failed"
      ? outcome.error
      : outcome.result.text;

describe("WatchModule", () => {
  let rig: Rig;
  afterEach(async () => {
    await rig.sup.stopAll();
  });

  it("registers_its_capabilities_and_prompt", async () => {
    rig = new Rig();
    await rig.start();
    expect(WatchModule.ID).toBe("watch");
    expect(rig.registry.names().sort()).toEqual(["watch.look", "watch.start", "watch.stop"]);
    expect(rig.prompts.all().map((c) => c.key)).toEqual(["watch"]);
  });

  it("disabled_registers_nothing", async () => {
    rig = new Rig();
    await rig.start({}, false);
    expect(rig.registry.names()).toEqual([]);
    expect(rig.prompts.all()).toEqual([]);
    expect(rig.watchStart).not.toHaveBeenCalled();
  });

  it("no_voice_link_the_tools_say_there_is_no_voice_node", async () => {
    rig = new Rig(false);
    await rig.start();
    expect(rig.registry.names().sort()).toEqual(["watch.look", "watch.start", "watch.stop"]);
    const start = await rig.watch();
    expect(start.status).toBe("denied");
    expect(reason(start)).toContain("語音節點");
    // Nothing to stop or look at, and it says so rather than failing.
    expect(reason(await rig.invoke("watch.stop"))).toBe("你現在沒有在看直播。");
    const look = await rig.invoke("watch.look", { question: "他在做什麼" });
    expect(look.status).toBe("done");
    expect(reason(look)).toBe("你現在沒有在看直播,沒辦法看畫面。");
    expect(await rig.prompt(voice("c1"))).toEqual([]);
  });

  it("a_node_that_cannot_watch_says_so_and_nobody_is_left_watching", async () => {
    rig = new Rig();
    await rig.start();
    rig.watchStart.mockRejectedValueOnce(
      new VoiceLinkError("this voice node cannot watch streams"),
    );
    const outcome = await rig.watch();
    expect(outcome.status).toBe("failed");
    expect(reason(outcome)).toContain("還不能看直播");
    expect(reason(outcome)).not.toMatch(/[A-Za-z]{3}/);
    expect(reason(await rig.invoke("watch.stop"))).toBe("你現在沒有在看直播。");
  });

  it("prompt_says_who_she_watches", async () => {
    rig = new Rig();
    await rig.start();
    expect((await rig.watch()).status).toBe("done");
    await rig.rounds(1);

    const [section] = await rig.prompt(voice("c1"));
    expect(section?.order).toBe(47);
    expect(section?.body).toContain("小明");
    expect(section?.body).toContain("note 1");

    expect(await rig.prompt(text)).toEqual([]);
    expect(await rig.prompt(voice("c9"))).toEqual([]);
    // The text chat of the voice channel has the channel's own id.
    expect(await rig.prompt({ ...voice("c1"), kind: "channel" })).toEqual([]);
  });

  it("prompt_stays_short", async () => {
    rig = new Rig();
    await rig.start({ notes_keep: 100 });
    rig.members = [member("u1", "小明".repeat(40))];
    expect((await rig.invoke("watch.start")).status).toBe("done");
    await rig.rounds(30);
    const [section] = await rig.prompt(voice("c1"));
    expect([...(section?.body ?? "")].length).toBeLessThanOrEqual(2000);
    expect(section?.body).not.toContain("note 1\n");
  });

  it("prompt_lists_who_streams_in_her_channel_without_those_who_opted_out", async () => {
    rig = new Rig();
    await rig.start();
    await rig.registry.privacy.set(account("u2"), { watch: false });
    const [section] = await rig.prompt(voice("c1"));
    expect(section?.body).toContain("小明");
    expect(section?.body).not.toContain("阿華");
    expect(await rig.prompt(voice("c9"))).toEqual([]);
    expect(await rig.prompt({ ...voice("c1"), kind: "channel" })).toEqual([]);

    await rig.registry.privacy.set(account("u1"), { watch: false });
    expect(await rig.prompt(voice("c1"))).toEqual([]);
  });

  it("who_the_prompt_hid_does_not_make_her_choice_ambiguous", async () => {
    rig = new Rig();
    await rig.start();
    await rig.registry.privacy.set(account("u2"), { watch: false });
    await rig.prompt(voice("c1"));
    expect((await rig.invoke("watch.start")).status).toBe("done");
    expect(rig.watchStart).toHaveBeenCalledWith(G, "u1");
  });

  it("turning_watch_back_on_shows_them_again", async () => {
    rig = new Rig();
    await rig.start();
    await rig.registry.privacy.set(account("u1"), { watch: false });
    await rig.prompt(voice("c1"));
    await rig.registry.privacy.set(account("u1"), { watch: true });
    await rig.prompt(voice("c1"));
    expect((await rig.invoke("watch.start")).status).toBe("denied"); // two people again
  });

  it("prompt_counts_a_failed_privacy_read_as_not_allowed", async () => {
    rig = new Rig();
    await rig.start();
    vi.spyOn(rig.registry.privacy, "get").mockRejectedValue(new Error("store down"));
    expect(await rig.prompt(voice("c1"))).toEqual([]);
  });

  it("the_look_tool_is_always_there_and_answers_what_the_stream_shows", async () => {
    rig = new Rig();
    await rig.start();
    // Before any watch it answers why not.
    const before = await rig.invoke("watch.look", { question: "他在做什麼" });
    expect(before.status).toBe("done");
    expect(reason(before)).toContain("沒有在看直播");

    await rig.watch();
    await rig.rounds(1);
    const looked = await rig.invoke("watch.look", { question: "他在做什麼" });
    expect(looked.status).toBe("done");
    expect(reason(looked)).toContain("<data");
    expect(rig.registry.get("watch.look")).toBeDefined();

    // The stream ending takes the watch, not the tool.
    rig.status("u1", "stopped", "stream ended");
    await expect
      .poll(async () => reason(await rig.invoke("watch.look", { question: "?" })))
      .toContain("沒有在看直播");
    expect(rig.registry.get("watch.look")).toBeDefined();
  });

  it("switching_goes_through_start_and_the_old_streams_late_end_is_ignored", async () => {
    rig = new Rig();
    await rig.start({ min_watch_secs: 0 });
    await rig.watch("小明");
    rig.skew += 30_000;
    expect((await rig.watch("阿華")).status).toBe("done");
    expect(rig.watchStart).toHaveBeenLastCalledWith(G, "u2");

    rig.status("u1", "stopped", "the old stream closing late");
    await rig.rounds(2);
    const looked = await rig.invoke("watch.look", { question: "?" });
    expect(reason(looked)).toContain("<data");

    rig.status("u2", "stopped", "stream ended");
    await expect
      .poll(async () => reason(await rig.invoke("watch.look", { question: "?" })))
      .toContain("沒有在看直播");
  });

  it("a_watch_off_streamer_who_asks_herself_is_told_how_to_turn_it_on", async () => {
    rig = new Rig();
    await rig.start();
    await rig.registry.privacy.set(account("u1"), { watch: false });
    rig.members = [member("u1", "小明")];
    const asked = Principals.user(account("u1"), voice("c1"));
    const outcome = await rig.invoke("watch.start", {}, asked);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error).toContain("/me privacy");
    expect(rig.send).not.toHaveBeenCalled();
    expect(rig.watchStart).not.toHaveBeenCalled();
  });

  it("the_gate_keeps_opted_out_people_from_her_own_choice", async () => {
    rig = new Rig();
    await rig.start();
    rig.members = [member("u1", "小明")];
    await rig.registry.privacy.set(account("u1"), { watch: false });
    const outcome = await rig.invoke("watch.start", { user: "小明" });
    expect(outcome.status).toBe("denied");
    expect(rig.watchStart).not.toHaveBeenCalled();
  });

  it("turning_watch_off_mid_stream_ends_it", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    await rig.registry.privacy.set(account("u1"), { watch: false });
    await expect.poll(() => rig.watchStop.mock.calls.length).toBeGreaterThan(0);
    expect(rig.watchStop).toHaveBeenCalledWith(G);
    expect(reason(await rig.invoke("watch.stop"))).toBe("你現在沒有在看直播。");
    const before = rig.modelCalls;
    await new Promise((r) => setTimeout(r, 30));
    expect(rig.modelCalls).toBe(before);
  });

  it("leaving_voice_reaches_a_start_on_its_way", async () => {
    rig = new Rig();
    await rig.start();
    rig.send.mockImplementationOnce(() => new Promise<MessageRef>(() => {}));
    const running = rig.watch();
    await vi.waitFor(() => expect(rig.send).toHaveBeenCalled());
    rig.left(voice("c1"));
    expect((await running).status).toBe("failed");
    expect(rig.watchStart).not.toHaveBeenCalled();
  });

  it("a_start_the_tool_gave_up_on_does_not_begin_late", async () => {
    rig = new Rig();
    await rig.start();
    rig.watchStart.mockImplementationOnce(async () => {}); // `live` is slow
    const ctl = new AbortController();
    const running = rig.registry
      .invoke(
        {
          principal: Principals.self(voice("c1")),
          capability: "watch.start",
          args: { user: "小明" } as never,
          why: null,
          turn: null,
        },
        { signal: ctl.signal },
      )
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(rig.watchStart).toHaveBeenCalled());
    ctl.abort(new Error("timed out"));
    await running;
    await vi.waitFor(() => expect(rig.watchStop).toHaveBeenCalledWith(G));

    rig.status("u1", "live");
    await new Promise((r) => setTimeout(r, 30));
    expect(rig.modelCalls).toBe(0);
  });

  it("a_restarted_voice_link_is_used_by_the_next_watch", async () => {
    rig = new Rig();
    await rig.start();
    expect((await rig.watch()).status).toBe("done");
    expect(rig.watchStart).toHaveBeenCalledOnce();

    // `optional` does not restart this module with `voice.link`.
    const services = rig.sup.services;
    const old = { watchStart: rig.watchStart, watchStop: rig.watchStop };
    services.removeOwnedBy("voice.link");
    const fresh = {
      watchStart: vi.fn(async (_guild: string, user: string) => rig.status(user, "live")),
      watchStop: vi.fn(async (_guild: string) => {}),
    };
    rig.provideLink(fresh);

    // The stream that is on was started through the old link and is stopped through it.
    await rig.invoke("watch.stop");
    expect(old.watchStop).toHaveBeenCalledWith(G);
    expect(fresh.watchStop).not.toHaveBeenCalled();

    rig.skew += 30_000;
    expect((await rig.watch()).status).toBe("done");
    expect(old.watchStart).toHaveBeenCalledOnce();
    expect(fresh.watchStart).toHaveBeenCalledWith(G, "u1");
    await rig.rounds(1);
    await rig.invoke("watch.stop");
    expect(fresh.watchStop).toHaveBeenCalledWith(G);
  });

  it("a_voice_link_that_is_gone_refuses_the_start_and_comes_back", async () => {
    rig = new Rig();
    await rig.start();
    rig.sup.services.removeOwnedBy("voice.link");
    const gone = await rig.watch();
    expect(gone.status).toBe("denied");
    expect(await rig.prompt(voice("c1"))).toEqual([]);

    rig.provideLink();
    rig.skew += 30_000;
    expect((await rig.watch()).status).toBe("done");
  });

  it("hearing_is_looked_up_for_each_use", async () => {
    rig = new Rig();
    await rig.start();
    const hearing: StreamHearing = {
      allowed: vi.fn(async () => true),
      transcribe: vi.fn(async () => null),
    };
    rig.sup.services.provide("voice", StreamHearingKey, hearing);
    expect((await rig.watch()).status).toBe("done");
    await vi.waitFor(() => expect(hearing.allowed).toHaveBeenCalled());
  });

  it("a_watch_that_fails_to_start_says_so_in_her_words", async () => {
    rig = new Rig();
    await rig.start();
    rig.watchStart.mockImplementationOnce(async (_guild, user) => rig.status(user, "failed", null));
    const outcome = await rig.watch();
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error).not.toMatch(/[A-Za-z]{3}/);
    expect(reason(await rig.invoke("watch.stop"))).toBe("你現在沒有在看直播。");
  });

  it("watch_stop_ends_the_watch", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    expect(reason(await rig.invoke("watch.stop"))).toBe("不看直播了");
    expect(rig.watchStop).toHaveBeenCalledWith(G);
    expect(reason(await rig.invoke("watch.stop"))).toBe("你現在沒有在看直播。");
  });

  it("voice_left_stops_watching", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    rig.left(voice("c1"));
    await expect.poll(() => rig.watchStop.mock.calls.length).toBeGreaterThan(0);
  });

  it("leaving_another_server_keeps_the_watch", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    rig.left(voice("c9", "g9"));
    await rig.rounds(2);
    expect(rig.watchStop).not.toHaveBeenCalled();
  });

  it("being_moved_stops_watching", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    rig.joined(voice("c1"));
    await rig.rounds(2);
    expect(rig.watchStop).not.toHaveBeenCalled();
    rig.joined(voice("c2"));
    await expect.poll(() => rig.watchStop.mock.calls.length).toBeGreaterThan(0);
  });

  it("a_line_worth_saying_becomes_one_watch_impulse_for_the_voice_room", async () => {
    rig = new Rig();
    rig.worth = true;
    await rig.start({ speak_min_secs: 1000 });
    await rig.watch();
    await expect.poll(() => rig.impulses.length).toBeGreaterThan(0);
    // The gate lets one through and holds the next ones back for `speak_min_secs`.
    await rig.rounds(4);
    expect(rig.impulses).toHaveLength(1);
    const [impulse] = rig.impulses as [Impulse];
    expect(impulse.source).toBe("watch");
    expect(impulse.kind).toBe("speak");
    expect(impulse.target.context).toEqual(voice("c1"));
    expect(impulse.hint).toContain("小明");
    expect(impulse.hint).toContain("<data");
    expect(impulse.hint).toContain("note 1");
    expect(impulse.attention?.key).toContain("watch:");
    expect(impulse.coalesce_key).toContain("watch:");
    // Not an urgent line: it is noticed, and loses to what is more pressing.
    expect(claimOf(impulse)).toBe("notable");
    // A line about an old picture is not worth saying: it lives for two looks.
    expect(Date.parse(impulse.expires_at) - Date.parse(impulse.created_at)).toBe(20);
    // Her words are the turn's, never this module's.
    expect(rig.impulses.every((i) => i.capability === null)).toBe(true);
  });

  it("nothing_worth_saying_publishes_nothing", async () => {
    rig = new Rig();
    rig.worth = false;
    await rig.start();
    await rig.watch();
    await rig.rounds(4);
    expect(rig.impulses).toEqual([]);
  });

  it("other_peoples_speech_counts_as_voice_activity", async () => {
    rig = new Rig();
    rig.worth = true;
    await rig.start({ quiet_secs: 1000 });
    rig.speaking(account("u2"), true);
    await new Promise((r) => setTimeout(r, 20));
    await rig.watch();
    await rig.rounds(3);
    expect(rig.impulses).toEqual([]);
  });

  it("her_own_speech_does_not", async () => {
    rig = new Rig();
    rig.worth = true;
    await rig.start({ quiet_secs: 1000 });
    rig.speaking(account("her"), true);
    rig.speaking(account("u2"), false);
    await new Promise((r) => setTimeout(r, 20));
    await rig.watch();
    await expect.poll(() => rig.impulses.length).toBeGreaterThan(0);
  });

  it("her_own_playback_counts_as_busy", async () => {
    rig = new Rig();
    await rig.start();
    rig.playback("started");
    await new Promise((r) => setTimeout(r, 20));
    rig.worth = true;
    await rig.watch();
    await rig.rounds(3);
    expect(rig.impulses).toEqual([]);
    rig.playback("interrupted");
    await expect.poll(() => rig.impulses.length).toBeGreaterThan(0);
  });

  it("a_finished_line_counts_as_her_speaking", async () => {
    rig = new Rig();
    rig.worth = true;
    await rig.start({ speak_min_secs: 1000 });
    rig.playback("finished");
    await new Promise((r) => setTimeout(r, 20));
    await rig.watch();
    await rig.rounds(3);
    expect(rig.impulses).toEqual([]);
  });

  it("a_song_counts_as_busy", async () => {
    rig = new Rig();
    rig.worth = true;
    rig.floor = "song";
    await rig.start();
    await rig.watch();
    await rig.rounds(3);
    expect(rig.impulses).toEqual([]);
    rig.floor = null;
    await expect.poll(() => rig.impulses.length).toBeGreaterThan(0);
  });

  it("module_stop_ends_the_watch_and_unregisters_everything", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    await rig.sup.stopAll();
    expect(rig.watchStop).toHaveBeenCalledWith(G);
    expect(rig.registry.names()).toEqual([]);
    expect(rig.prompts.all()).toEqual([]);
  });
});
