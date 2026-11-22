// `watch.start`, `watch.stop` and `watch.look`: she watches a friend's Go Live, because she wants
// to or because someone asked. The gate keeps consent and the cooldown; what it has no notion of
// (a stream in the room, an hourly limit, a watch that just began) is checked here.
//
// The tools are always offered. What cannot be done right now (she is not in voice, nobody
// streams, the model takes no pictures) comes back as the reason, in her words: from `check` for
// a start (before the gate's consent stage, which needs a person and would say something else),
// as the result's text for a stop or a look.

import { type CommandReply, cardReply, componentId, type ReplySink } from "@miyoria/commands";
import {
  type Capability,
  CapabilityError,
  defineCapability,
  PRIVACY_ROUTES,
} from "@miyoria/gate/actions";
import {
  type AccountRef,
  dataBlock,
  isAutonomous,
  type PlatformId,
  type PlatformSink,
  type Principal,
  safeName,
  sameAccount,
  type VoiceChannelState,
  type VoiceMember,
  type WorldState,
} from "@miyoria/types";
import { CONSENT_ROUTES, type VoiceLink, VoiceLinkError, voiceContext } from "@miyoria/voice/voice";
import { z } from "zod";
import type { WatchConfig } from "./config.js";
import type { WatchTarget } from "./source.js";
import { notWatchable, untilAborted, type Watcher, WatchRefused } from "./watcher.js";

const HOUR_MS = 3_600_000;

const NO_NODE = "你現在連不上語音節點,沒辦法看直播。";
const NOT_IN_VOICE = "你現在不在語音頻道裡,要先進語音(voice_join)才能看直播。";
const ELSEWHERE = "你在別的語音頻道,對方那邊的直播你看不到。要先換過去才能看。";
const NOBODY_LIVE = "那個語音頻道現在沒有人在開播。";
const CANNOT_SEE = "你現在沒辦法看圖片(模型不收圖片,或這陣子的預算用完了),所以先不看直播。";
const GO_LIVE = "你自己正在 Go Live,開台的時候不能看別人的直播。";
const TOO_MANY = "這一小時已經看太多場了,先休息一下再看。";
const NO_NOTICE = "在語音頻道的文字區發不出通知,所以不能看直播。";
const NODE_CANNOT = "你的語音節點還不能看直播,所以沒看成。";
const STOPPED = "看直播被停掉了,沒有開始看。";
const STARTING = "已經在準備看一場直播了,等一下。";
const NO_STREAM = "連不上這場直播,這次沒看成。";
const ENDED = "直播已經結束了。";
const NOT_SEEN = "這次沒看清楚畫面,等一下再試。";
const NOT_HERE = "你看的直播在別的地方,在這裡不能看。";
const NOT_WATCHING = "你現在沒有在看直播。";

/** People streaming in `room`, not counting her. */
export function streamers(room: VoiceChannelState): VoiceMember[] {
  return room.members.filter((m) => m.streaming && !m.is_self);
}

/** The notice as plain text: where no card can be sent, and the card's fallback text. */
export function noticeText(name: string): string {
  return `她現在在看 ${safeName(name)} 的直播,畫面和說話內容都會送到模型讓她看懂。不想被看:/me privacy watch:off;不想被聽:/voice consent off`;
}

/** The plain-text notice as a message: never a ping. */
function notice(name: string) {
  const message = { text: noticeText(name), reply_to: null, mentions: false };
  return message;
}

/** Display names come from people: no Markdown in them. */
const md = (text: string): string => text.replace(/[\\*_`~|>#[\]()<@]/g, (c) => `\\${c}`);

/** The notice as a card in the voice channel's text chat (Components V2 on Discord, no embed). */
export function noticeCard(name: string): CommandReply {
  const card = cardReply(
    [
      {
        type: "text",
        text: `她現在在看 **${md(safeName(name))}** 的直播,畫面和說話內容都會送到模型讓她看懂。`,
      },
      {
        type: "buttons",
        buttons: [
          {
            id: componentId(PRIVACY_ROUTES.watchToggle),
            label: "看我直播:開/關",
            style: "secondary",
          },
          { id: componentId(CONSENT_ROUTES.toggle), label: "聽我說話:開/關", style: "secondary" },
        ],
      },
      {
        type: "muted",
        text: "按一下切換你自己的設定(只有你看得到結果),再按一次切回來。",
      },
    ],
    { accent: "neutral", title: "看直播" },
  );
  return { ...card, ephemeral: false };
}

const noticeKey = (account: AccountRef): string => `${account.platform}:${account.id}`;

/** Who was told lately. In memory: a restart at worst repeats a notice. */
export class NoticeBook {
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #sentAt = new Map<string, number>();

  constructor(hours: number, now: () => number) {
    this.#windowMs = hours * HOUR_MS;
    this.#now = now;
  }

  due(account: AccountRef): boolean {
    const at = this.#sentAt.get(noticeKey(account));
    return at === undefined || this.#now() - at >= this.#windowMs;
  }

  mark(account: AccountRef): void {
    const now = this.#now();
    for (const [key, at] of this.#sentAt) {
      if (now - at >= this.#windowMs) this.#sentAt.delete(key);
    }
    this.#sentAt.set(noticeKey(account), now);
  }
}

/** Starts within the last hour that did something public; the gate has no hourly limit. */
export class StartLog {
  readonly #limit: number;
  readonly #now: () => number;
  #at: number[] = [];

  constructor(limit: number, now: () => number) {
    this.#limit = limit;
    this.#now = now;
  }

  full(): boolean {
    const now = this.#now();
    this.#at = this.#at.filter((at) => now - at < HOUR_MS);
    return this.#at.length >= this.#limit;
  }

  add(): void {
    this.#at.push(this.#now());
  }
}

/**
 * The one start between the gate and the watcher. `Watcher.stop` only reaches starts the watcher
 * has, so a stop during the join or the notice has to come through here.
 */
export class PendingStart {
  #claim: { guild: string; channel: string; ctl: AbortController } | null = null;

  where(): { guild: string; channel: string } | null {
    return this.#claim;
  }

  /** Aborts on `cancel`; `null` while another start is on its way. */
  claim(guild: string, channel: string): AbortSignal | null {
    if (this.#claim !== null) return null;
    const ctl = new AbortController();
    this.#claim = { guild, channel, ctl };
    return ctl.signal;
  }

  release(): void {
    this.#claim = null;
  }

  cancel(reason: string): void {
    this.#claim?.ctl.abort(new Error(reason));
  }
}

export interface WatchActionDeps {
  cfg: WatchConfig;
  /** Looked up at each use; `null`: no voice node is connected. */
  link(): Pick<VoiceLink, "channel" | "isStreaming" | "canWatch"> | null;
  watcher: Pick<Watcher, "view" | "start" | "stop">;
  notices: NoticeBook;
  starts: StartLog;
  pending: PendingStart;
  world(): WorldState | undefined;
  sink(platform: PlatformId): PlatformSink | undefined;
  /** Where a card goes (`ReplySinkKey`); without one the notice is plain text through `sink`. */
  cards?(): Pick<ReplySink, "platform" | "sendCard"> | undefined;
  canLook(): boolean;
  watchAllowed(account: AccountRef): Promise<boolean>;
  /**
   * `watch` was off the last time the prompt looked. `check` is synchronous and cannot read the
   * store, so this only narrows what she chooses from; the gate still asks about who she picks.
   */
  hidden(account: AccountRef): boolean;
  now(): number;
  warn(message: string, error?: unknown): void;
}

/** Stops whatever is going on: a start on its way and the watch. */
export async function halt(
  deps: Pick<WatchActionDeps, "pending" | "watcher">,
  reason: string,
): Promise<void> {
  deps.pending.cancel(reason);
  await deps.watcher.stop(reason);
}

const StartArgs = z.object({ user: z.string().trim().min(1).max(64).nullish() });
type StartArgs = z.output<typeof StartArgs>;
const StopArgs = z.object({}).loose();
const LookArgs = z.object({ question: z.string().trim().min(1).max(500) });

interface Stream {
  guild: string;
  channel: string;
  platform: PlatformId;
  member: VoiceMember;
}

const sameName = (a: string, b: string): boolean =>
  safeName(a).toLowerCase() === safeName(b).toLowerCase();

const roster = (members: readonly VoiceMember[]): string =>
  members.map((m) => `${safeName(m.display_name)}(${m.account.id})`).join("、");

/**
 * Who `wanted` is among the people streaming in the room, or why it cannot be told. Nobody named
 * while she watches someone means someone else: that is how she switches.
 */
function pick(
  live: readonly VoiceMember[],
  wanted: string | null,
  watching: AccountRef | null,
): VoiceMember | string {
  if (live.length === 0) return NOBODY_LIVE;
  const others = live.filter((m) => watching === null || !sameAccount(m.account, watching));
  const hits =
    wanted === null
      ? others.length > 0
        ? others
        : live
      : live.filter((m) => m.account.id === wanted || sameName(m.display_name, wanted));
  const [only] = hits;
  if (only !== undefined && hits.length === 1) return only;
  if (hits.length === 0) return `${safeName(wanted ?? "")} 現在沒有在這裡開播。`;
  return `現在有好幾個人在開播,要用 user 指定看誰:${roster(hits)}`;
}

/** `watch.start` (also switching) and `watch.stop`. */
export function watchCapabilities(deps: WatchActionDeps): Capability[] {
  const { watcher } = deps;

  const tooSoon = (): boolean => {
    const view = watcher.view();
    return view !== null && deps.now() - view.startedAt < deps.cfg.min_watch_secs * 1000;
  };

  /** The stream `args` mean for `principal`, or why there is none. */
  function find(args: StartArgs, principal: Principal): Stream | string {
    const link = deps.link();
    if (link === null) return NO_NODE;
    const world = deps.world();
    if (world === undefined) return NOBODY_LIVE;
    const snapshot = world.snapshot();
    const asker = isAutonomous(principal) ? null : principal.requester;
    const spot = asker === null ? null : (world.person(asker)?.voice ?? null);
    const guild = principal.context?.scope ?? spot?.guild ?? snapshot.her.voice?.scope ?? null;
    if (guild === null) return NOT_IN_VOICE;
    const channel = link.channel(guild);
    if (channel === null) {
      // In voice on another server: that room is the one she could watch in.
      return snapshot.her.voice === null ? NOT_IN_VOICE : ELSEWHERE;
    }
    // Whoever asked sits in another room of this server: their stream is not hers to see.
    if (spot?.guild === guild && spot.channel !== channel) return ELSEWHERE;
    const room = snapshot.voice_channels.find((c) => c.guild === guild && c.channel === channel);
    if (room === undefined) return NOBODY_LIVE;
    const seen = streamers(room).filter((m) => asker !== null || !deps.hidden(m.account));
    const member = pick(seen, args.user ?? null, watcher.view()?.target.account ?? null);
    if (typeof member === "string") return member;
    return { guild, channel, platform: room.platform, member };
  }

  /** Why `stream` may not begin now. */
  function refusal(stream: Stream, principal: Principal): string | null {
    const { guild, member } = stream;
    const watching = watcher.view()?.target.account ?? null;
    if (watching !== null && sameAccount(watching, member.account)) {
      return `你已經在看 ${safeName(member.display_name)} 的直播了。`;
    }
    if (!deps.canLook()) return CANNOT_SEE;
    if (deps.link()?.isStreaming(guild) === true) return GO_LIVE;
    // Before the notice in the channel: a notice about a watch that cannot happen is a false one.
    if (deps.link()?.canWatch(guild) === false) return NODE_CANNOT;
    if (isAutonomous(principal) && tooSoon()) {
      return `這場才剛開始看,至少看滿 ${deps.cfg.min_watch_secs} 秒才換人。`;
    }
    if (deps.starts.full()) return TOO_MANY;
    return null;
  }

  function check(args: StartArgs, principal: Principal): string | null {
    const stream = find(args, principal);
    return typeof stream === "string" ? stream : refusal(stream, principal);
  }

  const asFound = (args: StartArgs, principal: Principal): Stream | null => {
    const stream = find(args, principal);
    return typeof stream === "string" ? null : stream;
  };

  /**
   * Tells the channel, when due. `true` when a notice went out. The card is spent and counts as a
   * start the moment it lands, whatever becomes of the watch: everyone has seen it by then.
   */
  async function notify(target: WatchTarget, signal: AbortSignal): Promise<boolean> {
    if (!deps.notices.due(target.account)) return false;
    const cards = deps.cards?.();
    const card = cards?.sendCard && cards.platform === target.context.platform ? cards : undefined;
    const sink = card === undefined ? deps.sink(target.context.platform) : undefined;
    if (card === undefined && sink === undefined) throw new CapabilityError(NO_NOTICE);
    // On Discord a voice channel's text chat has the channel's own id.
    const chat = { ...target.context, kind: "channel" as const };
    try {
      const posted =
        card?.sendCard !== undefined
          ? card.sendCard(chat, noticeCard(target.name), signal)
          : (sink as PlatformSink).send(chat, notice(target.name), signal);
      const sent = posted.then(() => {
        deps.notices.mark(target.account);
        deps.starts.add();
      });
      await untilAborted(sent, signal);
    } catch (error) {
      if (signal.aborted) throw new CapabilityError(STOPPED);
      deps.warn("cannot send the watch notice", error);
      throw new CapabilityError(NO_NOTICE);
    }
    return true;
  }

  async function begin(
    stream: Stream,
    ctx: { signal: AbortSignal },
    claim: AbortSignal,
  ): Promise<WatchTarget> {
    const { member } = stream;
    const signal = AbortSignal.any([claim, ctx.signal]);
    // Before anything public: a notice about a watch that cannot happen would be a false one.
    if (!(await deps.watchAllowed(member.account))) {
      throw new CapabilityError(notWatchable(member.display_name));
    }
    const target: WatchTarget = {
      guild: stream.guild,
      channel: stream.channel,
      context: voiceContext(stream.platform, stream.guild, stream.channel),
      account: member.account,
      name: member.display_name,
    };
    const noticed = await notify(target, signal);
    if (signal.aborted) throw new CapabilityError(STOPPED);
    await watcher.start(target, signal);
    if (!noticed) deps.starts.add();
    return target;
  }

  const start = defineCapability<StartArgs>({
    name: "watch.start",
    summary: "看朋友的直播",
    risk: "medium",
    consent: "watch",
    args: StartArgs,
    permission: null,
    limits: { cooldown_ms: 20_000 },
    tool: {
      name: "watch_start",
      // Always offered (`core`): she decides herself, and the tool says why when it cannot be done.
      meta: { effect: "act", speed: "long", group: "watch", core: true },
      description:
        "看朋友在你所在的語音頻道開的直播(Go Live):定時看畫面、聽聲音、記筆記,有值得講的才開口,像一起看的朋友。" +
        "要不要看、看誰、什麼時候換人,都是你自己決定:頻道裡有人開播而你有興趣、或有人請你看,都可以用;不想看就不用。" +
        "這不是開你自己的台,開台是 stream_start。正在看別人時再叫一次就是換人。" +
        "你得先在語音頻道裡、頻道裡得有人在開播;現在沒辦法看的時候,工具會告訴你原因。",
      properties: {
        user: { type: "string", description: "開播者的名字或 id(只有一個人開播時可以省略)" },
      },
    },
    scope: (args, principal) => asFound(args, principal)?.guild ?? null,
    target: (args, principal) => asFound(args, principal)?.member.account ?? null,
    check,
    async execute(args, ctx) {
      const stream = find(args, ctx.principal);
      if (typeof stream === "string") throw new CapabilityError(stream);
      const why = refusal(stream, ctx.principal);
      if (why !== null) throw new CapabilityError(why);
      const claim = deps.pending.claim(stream.guild, stream.channel);
      if (claim === null) throw new CapabilityError(STARTING);
      try {
        const target = await begin(stream, ctx, claim);
        return `開始看 ${safeName(target.name)} 的直播了`;
      } catch (error) {
        if (error instanceof CapabilityError) throw error;
        if (error instanceof WatchRefused) throw new CapabilityError(error.message);
        if (error instanceof VoiceLinkError && error.message.includes("cannot watch")) {
          throw new CapabilityError(NODE_CANNOT);
        }
        deps.warn("cannot start a watch", error);
        throw new CapabilityError(NO_STREAM);
      } finally {
        deps.pending.release();
      }
    },
  });

  const stop = defineCapability<z.output<typeof StopArgs>>({
    name: "watch.stop",
    summary: "不看直播了",
    risk: "low",
    args: StopArgs,
    permission: null,
    tool: {
      name: "watch_stop",
      meta: { effect: "act", speed: "instant", group: "watch", core: true },
      description:
        "不看現在看的朋友的直播了(不是關你自己的台,那是 stream_stop)。" +
        "看夠了、對方不想被看、想專心聊天時,你自己決定;沒有在看直播時用它只會告訴你沒在看。",
      properties: {},
    },
    async execute() {
      if (watcher.view() === null && deps.pending.where() === null) {
        return { text: NOT_WATCHING, data: { stopped: false } };
      }
      await halt(deps, "she stopped watching");
      return { text: "不看直播了", data: { stopped: true } };
    },
  });

  return [start, stop] as Capability[];
}

/**
 * `watch.look`, offered like the other two. The answer comes from a model that read the stream, so
 * it goes back to her as data, and it stays in the server the stream is in. When it cannot be done
 * (she is not watching, the stream ended, no picture) the result says why.
 */
export function watchLookCapability(
  watcher: Pick<Watcher, "view" | "look">,
  signal: () => AbortSignal,
): Capability<z.output<typeof LookArgs>> {
  const nothing = (text: string) => ({ text, data: { looked: false } });
  return defineCapability<z.output<typeof LookArgs>>({
    name: "watch.look",
    summary: "仔細看一眼正在看的直播",
    risk: "low",
    args: LookArgs,
    permission: null,
    tool: {
      name: "watch_look",
      meta: { effect: "read", speed: "instant", group: "watch", core: true },
      framed: true,
      description:
        "仔細看一眼你正在看的直播畫面,回答一個問題(例如「他現在在玩什麼」)。要等幾秒。" +
        "有人問起直播裡的事、你自己想確認畫面上的東西時用;沒有在看直播時會告訴你看不了。",
      properties: { question: { type: "string", description: "你想從畫面上看出什麼" } },
      required: ["question"],
    },
    check(_args, principal) {
      const view = watcher.view();
      return view === null || principal.context?.scope === view.target.guild ? null : NOT_HERE;
    },
    async execute(args, ctx) {
      const scope = AbortSignal.any([signal(), ctx.signal]);
      try {
        const text = await watcher.look(args.question, scope);
        return {
          text: dataBlock("watch", "你在直播畫面上看到的", text),
          data: { looked: true },
        };
      } catch (error) {
        if (error instanceof WatchRefused) return nothing(error.message);
        return nothing(scope.aborted || watcher.view() === null ? ENDED : NOT_SEEN);
      }
    },
  });
}
