import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
import { Supervisor } from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import {
  type AccountRef,
  type ContextKey,
  customEvent,
  type Envelope,
  type Event,
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
import { VoiceLinkKey } from "@miyoria/voice";
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
  readonly seen: Event[] = [];
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

  constructor() {
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
    this.provideLink();
    void this.collect(this.sup.bus.subscribe("agent.initiative"));
  }

  async collect(events: AsyncIterable<Envelope>): Promise<void> {
    for await (const env of events) this.seen.push(env.event);
  }

  publish(event: Event): void {
    this.sup.bus.publish("test", event);
  }

  status(user: string, state: string, reason: string | null = null): void {
    this.publish(
      customEvent("voice.watch", {
        platform: "discord",
        guild: G,
        user_id: user,
        state,
        error: null,
        reason,
      }),
    );
  }

  provideLink(): void {
    this.sup.services.provide("voice.link", VoiceLinkKey, {
      channel: (guild: string) => (guild === G ? this.channel : null),
      isStreaming: () => false,
      isSelf: (a: AccountRef) => a.id === "her",
      watchStart: this.watchStart,
      watchStop: this.watchStop,
      snapshot: async () => Buffer.from([1]),
      subscribeWatchAudio: () => (async function* () {})(),
    } as never);
  }

  async start(config: object = {}): Promise<void> {
    await this.sup.register(
      new WatchModule({ persona: () => "鯨魚娘" }),
      { snapshot_secs: 0.01, speak_min_secs: 0, quiet_secs: 0, ...config },
      true,
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
}

describe("WatchModule", () => {
  let rig: Rig;
  afterEach(async () => {
    await rig.sup.stopAll();
  });

  it("registers_its_capabilities_and_prompt", async () => {
    rig = new Rig();
    await rig.start();
    expect(WatchModule.ID).toBe("watch");
    expect(rig.registry.names()).toEqual(["watch.start", "watch.stop"]);
    expect(rig.prompts.all().map((c) => c.key)).toEqual(["watch"]);
  });

  it("no_voice_link_no_capabilities", async () => {
    rig = bareRig();
    await rig.start();
    expect(rig.registry.names()).toEqual([]);
    expect(rig.prompts.all()).toEqual([]);
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

  it("prompt_lists_streams_without_those_who_opted_out", async () => {
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

  it("look_tool_exists_only_while_watching", async () => {
    rig = new Rig();
    await rig.start();
    expect(rig.registry.get("watch.look")).toBeUndefined();
    await rig.watch();
    expect(rig.registry.get("watch.look")).toBeDefined();

    rig.status("u1", "stopped", "stream ended");
    await expect.poll(() => rig.registry.get("watch.look")).toBeUndefined();
  });

  it("look_tool_survives_a_switch_and_goes_with_the_last_watch", async () => {
    rig = new Rig();
    await rig.start({ min_watch_secs: 0 });
    await rig.watch("小明");
    rig.skew += 30_000;
    expect((await rig.watch("阿華")).status).toBe("done");
    expect(rig.watchStart).toHaveBeenLastCalledWith(G, "u2");
    expect(rig.registry.get("watch.look")).toBeDefined();

    rig.status("u1", "stopped", "the old stream closing late");
    await rig.rounds(2);
    expect(rig.registry.get("watch.look")).toBeDefined();

    rig.status("u2", "stopped", "stream ended");
    await expect.poll(() => rig.registry.get("watch.look")).toBeUndefined();
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

  it("turning_watch_off_mid_stream_ends_it", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    await rig.registry.privacy.set(account("u1"), { watch: false });
    await expect.poll(() => rig.registry.get("watch.look")).toBeUndefined();
    expect(rig.watchStop).toHaveBeenCalledWith(G);
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
    rig.publish({ type: "voice_left", data: { context: voice("c1"), reason: "kicked" } });
    expect((await running).status).toBe("failed");
    expect(rig.watchStart).not.toHaveBeenCalled();
    expect(rig.registry.get("watch.look")).toBeUndefined();
  });

  it("a_watch_that_fails_to_start_leaves_no_look_tool", async () => {
    rig = new Rig();
    await rig.start();
    rig.watchStart.mockImplementationOnce(async (_guild, user) => rig.status(user, "failed", null));
    const outcome = await rig.watch();
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error).not.toMatch(/[A-Za-z]{3}/);
    expect(rig.registry.get("watch.look")).toBeUndefined();
  });

  it("watch_stop_removes_the_look_tool", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    expect((await rig.invoke("watch.stop")).status).toBe("done");
    await expect.poll(() => rig.registry.get("watch.look")).toBeUndefined();
    expect(rig.watchStop).toHaveBeenCalledWith(G);
  });

  it("voice_left_stops_watching", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    rig.publish({ type: "voice_left", data: { context: voice("c1"), reason: "kicked" } });
    await expect.poll(() => rig.registry.get("watch.look")).toBeUndefined();
    expect(rig.watchStop).toHaveBeenCalled();
  });

  it("leaving_another_server_keeps_the_watch", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    rig.publish({ type: "voice_left", data: { context: voice("c9", "g9"), reason: null } });
    await rig.rounds(2);
    expect(rig.registry.get("watch.look")).toBeDefined();
  });

  it("being_moved_stops_watching", async () => {
    rig = new Rig();
    await rig.start();
    await rig.watch();
    rig.publish({ type: "voice_joined", data: { context: voice("c1"), participants: [] } });
    await rig.rounds(2);
    expect(rig.registry.get("watch.look")).toBeDefined();
    rig.publish({ type: "voice_joined", data: { context: voice("c2"), participants: [] } });
    await expect.poll(() => rig.registry.get("watch.look")).toBeUndefined();
  });

  it("speaks_through_an_initiative", async () => {
    rig = new Rig();
    rig.worth = true;
    await rig.start();
    await rig.watch();
    await expect.poll(() => rig.seen.length > 0).toBe(true);
    expect(rig.seen[0]).toMatchObject({
      type: "agent_initiative",
      data: { context: voice("c1"), reason: "watch", about: [] },
    });
  });

  it("other_peoples_speech_counts_as_voice_activity", async () => {
    rig = new Rig();
    rig.worth = true;
    await rig.start({ quiet_secs: 1000 });
    rig.publish({
      type: "voice_speaking",
      data: { context: voice("c1"), account: account("u2"), speaking: true },
    });
    await new Promise((r) => setTimeout(r, 20));
    await rig.watch();
    await rig.rounds(3);
    expect(rig.seen).toEqual([]);
  });

  it("her_own_speech_does_not", async () => {
    rig = new Rig();
    rig.worth = true;
    await rig.start({ quiet_secs: 1000 });
    rig.publish({
      type: "voice_speaking",
      data: { context: voice("c1"), account: account("her"), speaking: true },
    });
    rig.publish({
      type: "voice_speaking",
      data: { context: voice("c1"), account: account("u2"), speaking: false },
    });
    await new Promise((r) => setTimeout(r, 20));
    await rig.watch();
    await expect.poll(() => rig.seen.length > 0).toBe(true);
  });

  it("her_own_playback_counts_as_busy", async () => {
    rig = new Rig();
    await rig.start();
    const playback = (state: "started" | "finished" | "interrupted" | "failed") =>
      rig.publish({
        type: "voice_playback",
        data: { context: voice("c1"), turn: null, state, text: "嗨" },
      });
    playback("started");
    await new Promise((r) => setTimeout(r, 20));
    rig.worth = true;
    await rig.watch();
    await rig.rounds(3);
    expect(rig.seen).toEqual([]);
    playback("interrupted");
    await expect.poll(() => rig.seen.length > 0).toBe(true);
  });

  it("a_finished_line_counts_as_her_speaking", async () => {
    rig = new Rig();
    rig.worth = true;
    await rig.start({ speak_min_secs: 1000 });
    rig.publish({
      type: "voice_playback",
      data: { context: voice("c1"), turn: null, state: "finished", text: "嗨" },
    });
    await new Promise((r) => setTimeout(r, 20));
    await rig.watch();
    await rig.rounds(3);
    expect(rig.seen).toEqual([]);
  });

  it("a_song_counts_as_busy", async () => {
    rig = new Rig();
    rig.worth = true;
    rig.floor = "song";
    await rig.start();
    await rig.watch();
    await rig.rounds(3);
    expect(rig.seen).toEqual([]);
    rig.floor = null;
    await expect.poll(() => rig.seen.length > 0).toBe(true);
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

/** A rig whose voice link never came up. */
function bareRig(): Rig {
  const original = Rig.prototype.provideLink;
  Rig.prototype.provideLink = () => {};
  try {
    return new Rig();
  } finally {
    Rig.prototype.provideLink = original;
  }
}
