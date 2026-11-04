import {
  type ActionRequest,
  ActuatorRegistry,
  ActuatorRegistryKey,
  CapabilityError,
  defineCapability,
} from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import {
  type AccountRef,
  AuthorizerKey,
  type ContextKey,
  type MessageRef,
  type PersonPresence,
  type Principal,
  Principals,
  toTimestamp,
  type VoiceMember,
  type WorldSnapshot,
  type WorldState,
} from "@miyoria/types";
import type { VoiceLink } from "@miyoria/voice";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  NoticeBook,
  noticeText,
  PendingStart,
  StartLog,
  type WatchActionDeps,
  watchCapabilities,
  watchLookCapability,
} from "../src/actions.js";
import { type WatchConfig, WatchConfigSchema } from "../src/config.js";
import type { WatchTarget } from "../src/source.js";
import type { WatchView } from "../src/watcher.js";
import { WatchRefused } from "../src/watcher.js";

const HOUR = 3_600_000;
const G = "g1";
const voiceCtx = (channel: string): ContextKey => ({
  platform: "discord",
  scope: G,
  channel,
  kind: "voice",
});
const textCtx: ContextKey = { platform: "discord", scope: G, channel: "text", kind: "channel" };
const account = (id: string): AccountRef => ({ platform: "discord", id });
const asker = account("asker");

function member(id: string, name: string, over: Partial<VoiceMember> = {}): VoiceMember {
  return {
    account: account(id),
    person: null,
    display_name: name,
    is_self: false,
    muted: false,
    deafened: false,
    video: false,
    streaming: true,
    since: toTimestamp(0),
    ...over,
  };
}

function viewOf(target: WatchTarget, startedAt: number): WatchView {
  return { target, startedAt, notes: [], transcript: [] };
}

class Rig {
  clock = { t: 10 * HOUR };
  here: string | null = "c1";
  live = false;
  rooms: Record<string, VoiceMember[]> = {
    c1: [member("her", "她", { is_self: true, streaming: false }), member("u1", "小明")],
    c2: [member("u2", "阿華"), member("u3", "小美", { streaming: false })],
  };
  spots: Record<string, string> = {};
  /** Where she is in voice as far as the world knows, when not `here`. */
  otherServer: ContextKey | null = null;
  view: WatchView | null = null;
  hidden = new Set<string>();
  mayJoin = true;
  joinPrincipals: Principal[] = [];
  cfg: WatchConfig = WatchConfigSchema.parse({});
  canLook = true;
  sinkMissing = false;
  sent: { context: ContextKey; text: string; mentions: boolean | undefined }[] = [];
  order: string[] = [];
  send = vi.fn(async (context: ContextKey, message: { text: string; mentions?: boolean }) => {
    this.order.push("notice");
    this.sent.push({ context, text: message.text, mentions: message.mentions });
    return { context, id: "m" } as MessageRef;
  });
  join = vi.fn(async (_guild: string, _channel: string | null, _user: string | null) => {
    this.order.push("join");
    this.here = this.spots[asker.id] ?? "c1";
    return this.here;
  });
  start = vi.fn(async (target: WatchTarget, _signal?: AbortSignal) => {
    this.order.push("start");
    this.view = viewOf(target, this.clock.t);
  });
  stop = vi.fn(async (_reason: string) => {
    this.view = null;
  });
  allowed = vi.fn(async (_account: AccountRef) => true);
  started = vi.fn();
  warn = vi.fn();
  link = {
    channel: (_guild: string) => this.here,
    isStreaming: (_guild: string) => this.live,
  } as unknown as VoiceLink;
  world: WorldState = {
    snapshot: () =>
      ({
        her: { voice: this.otherServer ?? (this.here === null ? null : voiceCtx(this.here)) },
        voice_channels: Object.entries(this.rooms).map(([channel, members]) => ({
          platform: "discord",
          guild: G,
          channel,
          name: null,
          members,
        })),
      }) as unknown as WorldSnapshot,
    person: (a: AccountRef) => {
      const channel = this.spots[a.id];
      return (
        channel === undefined
          ? null
          : { voice: { platform: "discord", guild: G, channel, channel_name: null } }
      ) as PersonPresence | null;
    },
    personById: () => null,
    summary: () => "",
  };
  notices = new NoticeBook(24, () => this.clock.t);
  starts = new StartLog(6, () => this.clock.t);
  pending = new PendingStart();
  deps: WatchActionDeps = {
    cfg: this.cfg,
    link: this.link,
    watcher: {
      view: () => this.view,
      start: this.start,
      stop: this.stop,
    },
    notices: this.notices,
    starts: this.starts,
    pending: this.pending,
    world: () => this.world,
    sink: () =>
      this.sinkMissing ? undefined : ({ platform: "discord", send: this.send } as never),
    canLook: () => this.canLook,
    watchAllowed: this.allowed,
    hidden: (a) => this.hidden.has(a.id),
    now: () => this.clock.t,
    onStarted: this.started,
    warn: this.warn,
  };
  services = new ServiceRegistry();
  registry = new ActuatorRegistry({
    services: this.services,
    builtins: false,
    clock: { now: () => this.clock.t } as never,
  });

  constructor() {
    this.services.provide("app", ActuatorRegistryKey, this.registry);
    this.services.provide("app", AuthorizerKey, {
      allows: (_account, node) => node === "voice.join" && this.mayJoin,
      allowsSubject: () => false,
    });
    for (const capability of watchCapabilities(this.deps)) this.registry.register(capability);
    // Same gate as the real one: a permission, medium risk and the tier's 20 s cooldown.
    this.registry.register(
      defineCapability({
        name: "voice.join",
        summary: "加入語音頻道",
        risk: "medium",
        args: z.object({ guild: z.string().nullish() }),
        permission: "voice.join",
        execute: async (args, ctx) => {
          this.joinPrincipals.push(ctx.principal);
          const asker = ctx.principal.requester?.id ?? null;
          const channel = await this.join(args.guild ?? G, null, asker);
          return { text: "joined", data: { channel } };
        },
      }),
    );
  }

  request(capability: string, args: object, principal: Principal): ActionRequest {
    return { principal, capability, args: args as never, why: null, turn: null };
  }

  /** Past the action gate's cooldown. */
  later(ms = 30_000): void {
    this.clock.t += ms;
  }

  invoke(args: object, principal: Principal, signal?: AbortSignal) {
    return this.registry.invoke(
      this.request("watch.start", args, principal),
      signal ? { signal } : {},
    );
  }

  ask(args: object = {}, who: AccountRef = asker) {
    return this.invoke(args, Principals.user(who, textCtx));
  }

  own(args: object = {}) {
    return this.invoke(args, Principals.self(voiceCtx("c1")));
  }

  watch(id: string, name: string, startedAt = this.clock.t): void {
    this.view = viewOf(
      {
        guild: G,
        channel: "c1",
        context: voiceCtx("c1"),
        account: account(id),
        name,
      },
      startedAt,
    );
  }
}

const reason = (outcome: Awaited<ReturnType<Rig["invoke"]>>): string =>
  outcome.status === "denied"
    ? outcome.decision.reason
    : outcome.status === "failed"
      ? outcome.error
      : "";

describe("the watch capabilities", () => {
  let rig: Rig;
  beforeEach(() => {
    rig = new Rig();
  });

  it("are declared the way the gate needs them", () => {
    const start = rig.registry.get("watch.start");
    expect(start?.risk).toBe("medium");
    expect(start?.consent).toBe("watch");
    expect(start?.permission).toBeNull();
    expect(start?.limits).toEqual({ cooldown_ms: 20_000 });
    expect(start?.tool?.name).toBe("watch_start");
    expect(start?.tool?.description).toContain("stream_start");
    const stop = rig.registry.get("watch.stop");
    expect(stop?.risk).toBe("low");
    expect(stop?.tool?.name).toBe("watch_stop");
  });

  it("start_begins_a_watch", async () => {
    const outcome = await rig.own();
    expect(outcome.status).toBe("done");
    expect(rig.start.mock.calls[0]?.[0]).toEqual({
      guild: G,
      channel: "c1",
      context: voiceCtx("c1"),
      account: account("u1"),
      name: "小明",
    });
    expect(rig.started).toHaveBeenCalledOnce();
  });

  it("a_tool_timeout_reaches_the_watcher", async () => {
    const ctl = new AbortController();
    rig.start.mockImplementationOnce(
      (_target, signal) =>
        new Promise<void>((_, reject) => {
          signal?.addEventListener("abort", () => reject(new WatchRefused("沒有開始看。")));
        }),
    );
    const running = rig
      .invoke({}, Principals.self(voiceCtx("c1")), ctl.signal)
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(rig.start).toHaveBeenCalled());
    ctl.abort(new Error("timed out"));
    await running;
    expect(rig.started).not.toHaveBeenCalled();
    expect(rig.view).toBeNull();
    expect(rig.deps.pending.where()).toBeNull();
  });

  it("on_own_only_in_her_channel", async () => {
    const outcome = await rig.own({ user: "阿華" });
    expect(outcome.status).toBe("denied");
    expect(reason(outcome)).toContain("阿華");
    expect(rig.start).not.toHaveBeenCalled();

    rig.here = null;
    expect((await rig.own({ user: "小明" })).status).toBe("denied");
    expect(rig.join).not.toHaveBeenCalled();
  });

  it("on_own_respects_min_watch_secs", async () => {
    rig.rooms.c1?.push(member("u4", "阿德"));
    rig.watch("u1", "小明", rig.clock.t - 179_000);
    const check = rig.registry.get("watch.start")?.check;
    const self = Principals.self(voiceCtx("c1"));
    expect(check?.({ user: "阿德" }, self)).toContain("180");
    expect(check?.({ user: "阿德" }, Principals.user(asker, textCtx))).toBeNull();
    expect(rig.registry.get("watch.start")?.available?.()).toBe(false);

    rig.later(1_000);
    expect(check?.({ user: "阿德" }, self)).toBeNull();
    expect(rig.registry.get("watch.start")?.available?.()).toBe(true);
  });

  it("is_offered_only_when_someone_else_streams_where_she_is", () => {
    const available = () => rig.registry.get("watch.start")?.available?.();
    expect(available()).toBe(true);
    rig.watch("u1", "小明", rig.clock.t - 200_000);
    expect(available()).toBe(false); // the only stream, and she is on it
    rig.view = null;
    rig.rooms.c1 = [member("her", "她", { is_self: true, streaming: true })];
    expect(available()).toBe(false);
    rig.rooms.c1 = [member("u1", "小明")];
    rig.here = null;
    expect(available()).toBe(false);
    rig.here = "c1";
    rig.canLook = false;
    expect(available()).toBe(false);
  });

  it("starts_per_hour_limits_everyone", async () => {
    for (let i = 0; i < 6; i++) {
      expect((await rig.ask()).status).toBe("done");
      rig.view = null;
      rig.later(60_000);
    }
    const self = await rig.own();
    expect(self.status).toBe("denied");
    expect(reason(self)).toContain("一小時");
    const person = await rig.ask();
    expect(person.status).toBe("denied");
    expect(rig.start).toHaveBeenCalledTimes(6);

    rig.later(HOUR);
    expect((await rig.ask()).status).toBe("done");
  });

  it("a_start_that_failed_does_not_count", async () => {
    rig.deps.starts = new StartLog(1, () => rig.clock.t);
    rig.send.mockRejectedValueOnce(new Error("nope"));
    expect((await rig.own()).status).toBe("failed");
    expect(rig.start).not.toHaveBeenCalled();

    rig.later();
    expect((await rig.own()).status).toBe("done");

    rig.view = null;
    rig.later();
    const spent = await rig.own();
    expect(spent.status).toBe("denied");
    expect(reason(spent)).toContain("一小時");
  });

  it("a_start_that_failed_after_the_notice_counts", async () => {
    rig.deps.starts = new StartLog(2, () => rig.clock.t);
    rig.start.mockRejectedValueOnce(new Error("nope"));
    expect((await rig.own()).status).toBe("failed");
    expect(rig.send).toHaveBeenCalledOnce();

    // No card this time, so nothing public happened.
    rig.later();
    rig.start.mockRejectedValueOnce(new Error("nope"));
    expect((await rig.own()).status).toBe("failed");
    expect(rig.send).toHaveBeenCalledOnce();

    rig.later();
    expect((await rig.own()).status).toBe("done");
    rig.view = null;
    rig.later();
    const spent = await rig.own();
    expect(spent.status).toBe("denied");
    expect(reason(spent)).toContain("一小時");
  });

  it("someone_asking_brings_her_to_their_channel", async () => {
    rig.here = null;
    rig.spots[asker.id] = "c2";
    const outcome = await rig.ask();
    expect(outcome.status).toBe("done");
    expect(rig.join).toHaveBeenCalledWith(G, null, asker.id);
    expect(rig.joinPrincipals).toEqual([Principals.user(asker, textCtx)]);
    expect(rig.order).toEqual(["join", "notice", "start"]);
    expect(rig.start.mock.calls[0]?.[0]).toMatchObject({
      channel: "c2",
      account: account("u2"),
    });
  });

  it("someone_who_may_not_call_her_in_gets_no_watch", async () => {
    rig.here = null;
    rig.spots[asker.id] = "c2";
    rig.mayJoin = false;
    const outcome = await rig.ask();
    expect(outcome.status).toBe("failed");
    expect(reason(outcome)).not.toMatch(/[A-Za-z]{3}/);
    expect(reason(outcome)).toContain("沒有權限");
    expect(rig.join).not.toHaveBeenCalled();
    expect(rig.send).not.toHaveBeenCalled();
    expect(rig.start).not.toHaveBeenCalled();
  });

  it("a_forbidden_join_stays_forbidden", async () => {
    rig.here = null;
    rig.spots[asker.id] = "c2";
    rig.registry.configure({ ...rig.registry.config, forbidden: ["voice.join"] });
    expect((await rig.ask()).status).toBe("failed");
    expect(rig.join).not.toHaveBeenCalled();
    expect(rig.send).not.toHaveBeenCalled();
  });

  it("a_join_inside_its_cooldown_is_refused_and_does_not_spend_the_start", async () => {
    rig.deps.starts = new StartLog(1, () => rig.clock.t);
    rig.here = null;
    rig.spots[asker.id] = "c2";
    rig.registry.rate.record("voice.join", null, rig.clock.t); // someone just called her in
    rig.clock.t += 1_000;
    const cooling = await rig.ask();
    expect(cooling.status).toBe("failed");
    expect(reason(cooling)).toContain("太頻繁");
    expect(rig.send).not.toHaveBeenCalled();
    expect(rig.start).not.toHaveBeenCalled();
    expect(rig.deps.starts.full()).toBe(false);

    rig.later();
    expect((await rig.ask()).status).toBe("done");
  });

  it("a_join_that_lands_elsewhere_is_no_watch", async () => {
    rig.here = null;
    rig.spots[asker.id] = "c2";
    rig.join.mockImplementationOnce(async () => "c9");
    expect((await rig.ask()).status).toBe("failed");
    expect(rig.send).not.toHaveBeenCalled();
  });

  it("a_failed_join_says_so_in_her_words", async () => {
    rig.here = null;
    rig.spots[asker.id] = "c2";
    rig.join.mockRejectedValueOnce(new Error("voice node did not answer the join in time"));
    const outcome = await rig.ask();
    expect(outcome.status).toBe("failed");
    expect(reason(outcome)).not.toMatch(/[A-Za-z]{3}/);
    expect(rig.warn).toHaveBeenCalled();
    expect(rig.send).not.toHaveBeenCalled();
    expect(rig.start).not.toHaveBeenCalled();
  });

  it("someone_asking_from_another_channel_is_refused", async () => {
    rig.spots[asker.id] = "c2";
    const outcome = await rig.ask({ user: "阿華" });
    expect(outcome.status).toBe("denied");
    expect(reason(outcome)).toContain("別的語音頻道");
    expect(rig.join).not.toHaveBeenCalled();
    expect(rig.start).not.toHaveBeenCalled();
  });

  it("someone_asking_from_another_server_is_refused", async () => {
    rig.here = null; // nothing in this server
    rig.otherServer = { ...voiceCtx("c9"), scope: "g2" };
    rig.spots[asker.id] = "c2";
    const outcome = await rig.ask();
    expect(outcome.status).toBe("denied");
    expect(reason(outcome)).toContain("別的語音頻道");
    expect(rig.join).not.toHaveBeenCalled();
    expect(rig.start).not.toHaveBeenCalled();
  });

  it("being_in_voice_on_two_servers_does_not_refuse_the_one_asked_about", async () => {
    rig.otherServer = { ...voiceCtx("c9"), scope: "g2" }; // she is in c1 here as well
    expect((await rig.ask()).status).toBe("done");
    expect(rig.join).not.toHaveBeenCalled();
  });

  it("someone_asking_from_text_watches_in_her_channel", async () => {
    expect((await rig.ask()).status).toBe("done");
    expect(rig.join).not.toHaveBeenCalled();
  });

  it("nobody_in_voice_means_nothing_to_watch", async () => {
    rig.here = null;
    expect((await rig.ask()).status).toBe("denied");
    expect(rig.join).not.toHaveBeenCalled();
  });

  it("user_may_be_left_out_when_one_person_streams", async () => {
    expect((await rig.ask()).status).toBe("done");
    expect(rig.start.mock.calls[0]?.[0].account).toEqual(account("u1"));

    rig.view = null;
    rig.later();
    rig.rooms.c1?.push(member("u4", "阿德"));
    const outcome = await rig.ask();
    expect(outcome.status).toBe("denied");
    expect(reason(outcome)).toContain("小明");
    expect(reason(outcome)).toContain("阿德");

    expect((await rig.ask({ user: "阿德" })).status).toBe("done");
    expect(rig.start.mock.calls.at(-1)?.[0].account).toEqual(account("u4"));
    rig.view = null;
    rig.later();
    expect((await rig.ask({ user: "u1" })).status).toBe("done");
    expect(rig.start.mock.calls.at(-1)?.[0].account).toEqual(account("u1"));
  });

  it("a_name_as_she_saw_it_finds_the_person", async () => {
    rig.rooms.c1?.push(member("u4", "A: B"));
    expect((await rig.ask({ user: "a∶ b" })).status).toBe("done");
    expect(rig.start.mock.calls[0]?.[0].account).toEqual(account("u4"));
  });

  it("two_people_with_one_name_need_an_id", async () => {
    rig.rooms.c1?.push(member("u4", "小明"));
    const outcome = await rig.ask({ user: "小明" });
    expect(outcome.status).toBe("denied");
    expect(reason(outcome)).toContain("u4");
  });

  it("refuses_during_her_own_go_live", async () => {
    rig.live = true;
    for (const outcome of [await rig.own(), await rig.ask()]) {
      expect(outcome.status).toBe("denied");
      expect(reason(outcome)).toContain("Go Live");
    }
    expect(rig.start).not.toHaveBeenCalled();
  });

  it("refuses_when_the_model_takes_no_images", async () => {
    rig.canLook = false;
    expect((await rig.ask()).status).toBe("denied");
    expect(rig.send).not.toHaveBeenCalled();
  });

  it("leaving_out_user_while_watching_means_the_other_one", async () => {
    rig.rooms.c1?.push(member("u4", "阿德"));
    rig.watch("u1", "小明", rig.clock.t - 200_000);
    expect((await rig.own()).status).toBe("done");
    expect(rig.start.mock.calls[0]?.[0].account).toEqual(account("u4"));

    rig.later();
    rig.watch("u1", "小明", rig.clock.t - 200_000);
    expect((await rig.ask()).status).toBe("done");
    expect(rig.start.mock.calls[1]?.[0].account).toEqual(account("u4"));
  });

  it("three_streamers_still_need_a_name_while_watching_one", async () => {
    rig.rooms.c1?.push(member("u4", "阿德"), member("u5", "阿花"));
    rig.watch("u1", "小明", rig.clock.t - 200_000);
    const outcome = await rig.own();
    expect(outcome.status).toBe("denied");
    expect(reason(outcome)).toContain("阿德");
    expect(reason(outcome)).toContain("阿花");
    expect(reason(outcome)).not.toContain("小明");
  });

  it("people_she_cannot_see_do_not_make_it_ambiguous_for_her", async () => {
    rig.rooms.c1?.push(member("u4", "阿德"));
    rig.hidden.add("u1");
    expect((await rig.own()).status).toBe("done");
    expect(rig.start.mock.calls[0]?.[0].account).toEqual(account("u4"));
  });

  it("people_she_cannot_see_are_not_named_to_her", async () => {
    rig.rooms.c1?.push(member("u4", "阿德"), member("u5", "阿花"));
    rig.hidden.add("u1");
    const outcome = await rig.own();
    expect(outcome.status).toBe("denied");
    expect(reason(outcome)).not.toContain("小明");
    expect((await rig.own({ user: "小明" })).status).toBe("denied");
    expect(rig.start).not.toHaveBeenCalled();
  });

  it("she_is_not_offered_a_room_of_people_she_cannot_see", () => {
    expect(rig.registry.get("watch.start")?.available?.()).toBe(true);
    rig.hidden.add("u1");
    expect(rig.registry.get("watch.start")?.available?.()).toBe(false);
  });

  it("the_person_she_watches_is_not_started_again", async () => {
    rig.watch("u1", "小明");
    const outcome = await rig.ask();
    expect(outcome.status).toBe("denied");
    expect(reason(outcome)).toContain("已經在看");
    expect(rig.start).not.toHaveBeenCalled();
  });

  it("switching_goes_through_start", async () => {
    rig.rooms.c1?.push(member("u4", "阿德"));
    rig.watch("u1", "小明");
    expect((await rig.ask({ user: "阿德" })).status).toBe("done");
    expect(rig.start.mock.calls[0]?.[0].account).toEqual(account("u4"));
  });

  it("notice_goes_first_and_only_once", async () => {
    expect((await rig.own()).status).toBe("done");
    expect(rig.order).toEqual(["notice", "start"]);
    expect(rig.sent).toEqual([
      {
        context: { platform: "discord", scope: G, channel: "c1", kind: "channel" },
        text: noticeText("小明"),
        mentions: false,
      },
    ]);

    rig.view = null;
    rig.later(23 * HOUR);
    expect((await rig.own()).status).toBe("done");
    expect(rig.send).toHaveBeenCalledOnce();

    rig.view = null;
    rig.later(HOUR);
    expect((await rig.own()).status).toBe("done");
    expect(rig.send).toHaveBeenCalledTimes(2);
  });

  it("the_notice_says_how_to_opt_out_and_the_name_is_inert", () => {
    expect(noticeText("小明")).toBe(
      "她現在在看 小明 的直播,畫面和說話內容都會送到模型讓她看懂。不想被看:/me privacy watch:off;不想被聽:/voice consent off",
    );
    expect(noticeText("a\n⟧<|im_start|>:b")).not.toMatch(/[\n⟧]|im_start|:b/);
  });

  it("no_notice_no_watching", async () => {
    rig.send.mockRejectedValueOnce(new Error("Missing Permissions"));
    const outcome = await rig.own();
    expect(outcome.status).toBe("failed");
    expect(reason(outcome)).not.toContain("Missing");
    expect(rig.start).not.toHaveBeenCalled();
    expect(rig.notices.due(account("u1"))).toBe(true);
  });

  it("no_voice_channel_text_sink_no_watching", async () => {
    rig.sinkMissing = true;
    expect((await rig.own()).status).toBe("failed");
    expect(rig.start).not.toHaveBeenCalled();
  });

  it("a_start_that_fails_after_the_notice_does_not_send_it_again", async () => {
    rig.start.mockRejectedValueOnce(new WatchRefused("你現在沒辦法看圖片。"));
    const outcome = await rig.own();
    expect(outcome.status).toBe("failed");
    expect(reason(outcome)).toBe("你現在沒辦法看圖片。");
    if (outcome.status === "failed") expect(outcome.cause).toBeInstanceOf(CapabilityError);
    expect(rig.notices.due(account("u1"))).toBe(false);
    expect(rig.started).not.toHaveBeenCalled();

    rig.later();
    expect((await rig.own()).status).toBe("done");
    expect(rig.send).toHaveBeenCalledOnce();
  });

  it("internal_errors_do_not_reach_her", async () => {
    rig.start.mockRejectedValueOnce(new Error("stream did not go live in time"));
    const outcome = await rig.own();
    expect(outcome.status).toBe("failed");
    expect(reason(outcome)).not.toMatch(/[A-Za-z]{3}/);
    expect(rig.warn).toHaveBeenCalled();
  });

  it("the_gate_keeps_opted_out_people_from_others", async () => {
    await rig.registry.privacy.set(account("u1"), { watch: false });
    const outcome = await rig.own();
    expect(outcome.status).toBe("denied");
    expect(outcome.decision.stage).toBe("consent");
  });

  it("opted_out_streamer_asking_himself_gets_no_notice", async () => {
    rig.allowed.mockResolvedValue(false);
    const outcome = await rig.ask({}, account("u1"));
    expect(outcome.status).toBe("failed");
    expect(reason(outcome)).toContain("/me privacy");
    expect(rig.send).not.toHaveBeenCalled();
    expect(rig.join).not.toHaveBeenCalled();
    expect(rig.start).not.toHaveBeenCalled();
  });

  it("a_stop_reaches_a_start_on_its_way", async () => {
    rig.deps.starts = new StartLog(1, () => rig.clock.t);
    let release = (): void => {};
    rig.send.mockImplementationOnce(async (context) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { context, id: "m" } as MessageRef;
    });
    const running = rig.own();
    await vi.waitFor(() => expect(rig.send).toHaveBeenCalled());
    const stopped = rig.registry.invoke(
      rig.request("watch.stop", {}, Principals.user(asker, textCtx)),
    );
    expect((await stopped).status).toBe("done");
    expect((await running).status).toBe("failed");
    expect(rig.start).not.toHaveBeenCalled();
    expect(rig.deps.starts.full()).toBe(false);

    // The card landed after all: it is out, like any other.
    release();
    await vi.waitFor(() => expect(rig.deps.starts.full()).toBe(true));
    expect(rig.notices.due(account("u1"))).toBe(false);
  });

  it("one_start_at_a_time", async () => {
    let release = (): void => {};
    rig.send.mockImplementationOnce(async (context) => {
      await new Promise<void>((r) => {
        release = r;
      });
      return { context, id: "m" } as MessageRef;
    });
    const first = rig.own();
    await vi.waitFor(() => expect(rig.send).toHaveBeenCalled());
    const second = rig.deps.pending.claim(G, "c1");
    expect(second).toBeNull();
    release();
    expect((await first).status).toBe("done");
    expect(rig.deps.pending.claim(G, "c1")).not.toBeNull();
  });

  it("watch_stop_is_always_allowed", async () => {
    rig.watch("u1", "小明");
    const principals = [
      Principals.self(voiceCtx("c1")),
      Principals.user(asker, textCtx),
      Principals.user(account("u1"), textCtx),
    ];
    for (const principal of principals) {
      rig.watch("u1", "小明");
      const outcome = await rig.registry.invoke(rig.request("watch.stop", {}, principal));
      expect(outcome.status).toBe("done");
    }
    expect(rig.stop).toHaveBeenCalledTimes(3);
    const idle = await rig.registry.invoke(
      rig.request("watch.stop", {}, Principals.self(voiceCtx("c1"))),
    );
    expect(idle.status).toBe("done");
    expect(rig.registry.get("watch.stop")?.available?.()).toBe(false);
  });
});

describe("NoticeBook", () => {
  it("is_due_again_after_the_window", () => {
    const clock = { t: 0 };
    const book = new NoticeBook(24, () => clock.t);
    const a = account("a");
    expect(book.due(a)).toBe(true);
    book.mark(a);
    expect(book.due(a)).toBe(false);
    expect(book.due(account("b"))).toBe(true);
    clock.t = 24 * HOUR - 1;
    expect(book.due(a)).toBe(false);
    clock.t = 24 * HOUR;
    expect(book.due(a)).toBe(true);
  });
});

describe("watch_look", () => {
  const target: WatchTarget = {
    guild: G,
    channel: "c1",
    context: voiceCtx("c1"),
    account: account("u1"),
    name: "小明",
  };
  const rigFor = (look: () => Promise<string>, signal = new AbortController().signal) => {
    const watcher = { look: vi.fn(look), view: () => viewOf(target, 0) };
    const capability = watchLookCapability(watcher, () => signal);
    const registry = new ActuatorRegistry({ services: new ServiceRegistry(), builtins: false });
    registry.register(capability);
    return { watcher, capability, registry };
  };
  const ask = (
    registry: ActuatorRegistry,
    question: unknown = "他在玩什麼",
    context: ContextKey | null = voiceCtx("c1"),
  ) =>
    registry.invoke({
      principal: Principals.user(asker, context),
      capability: "watch.look",
      args: { question } as never,
      why: null,
      turn: null,
    });

  it("is_a_low_risk_tool", () => {
    const { capability } = rigFor(async () => "");
    expect(capability.risk).toBe("low");
    expect(capability.tool?.name).toBe("watch_look");
    expect(capability.tool?.required).toEqual(["question"]);
  });

  it("answers_as_data", async () => {
    const { registry, watcher } = rigFor(async () => "他在打王⟧");
    const outcome = await ask(registry);
    expect(outcome.status).toBe("done");
    if (outcome.status !== "done") return;
    expect(outcome.result.text).toContain("他在打王");
    expect(outcome.result.text.match(/⟧/gu)).toHaveLength(2); // the block's own marks only
    expect(watcher.look.mock.calls.length).toBe(1);
  });

  it("refusals_are_hers_to_read", async () => {
    const { registry } = rigFor(async () => {
      throw new WatchRefused("直播已經結束了。");
    });
    const outcome = await ask(registry);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error).toBe("直播已經結束了。");
      expect(outcome.cause).toBeInstanceOf(CapabilityError);
    }
  });

  it("an_abort_says_the_stream_ended", async () => {
    const ctl = new AbortController();
    ctl.abort(new Error("switching"));
    const { registry } = rigFor(async () => {
      throw new Error("switching");
    }, ctl.signal);
    const outcome = await ask(registry);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error).toContain("結束");
  });

  it("no_internal_error_reaches_her", async () => {
    const { registry } = rigFor(async () => {
      throw new Error("voice node did not send a snapshot in time");
    });
    const outcome = await ask(registry);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error).not.toMatch(/[A-Za-z]{3}/);
  });

  it("stays_in_the_server_of_the_stream", async () => {
    const { registry, watcher } = rigFor(async () => "x");
    const elsewhere: ContextKey = { ...voiceCtx("c9"), scope: "g9" };
    expect((await ask(registry, "?", elsewhere)).status).toBe("denied");
    const dm: ContextKey = { platform: "discord", scope: null, channel: "d", kind: "dm" };
    expect((await ask(registry, "?", dm)).status).toBe("denied");
    expect(watcher.look).not.toHaveBeenCalled();
  });
});
