// The party table: one game at a time per voice channel, who plays, scores, timers, and how a
// game ends (it is done, she ends it, someone says stop, nobody plays for a while, everyone
// left, she left or went off to do something else).
//
// Everything here is synchronous and deterministic: the clock, the randomness and the timers are
// injected, and input is handled in the order it arrives, so two calls at once (two starts, two
// right answers) are decided by which came first. Nothing here speaks (v4-plan §15): what she
// should know or may react to leaves as a `PartyNote`, which the module turns into an
// Observation for the main line.

import {
  type AccountRef,
  accountRefString,
  type Clock,
  type ContextKey,
  contextKeyString,
  newId,
  PARTY_RECENT_MAX,
  type PartyPlayerView,
  type PartyResultView,
  type PartyRewardRequest,
  type PartyRewards,
  type PartySnapshot,
  type SongClips,
  safeName,
  type VoiceParticipant,
} from "@miyoria/types";
import type { PartyConfig } from "./config.js";
import {
  type EndReason,
  GAME_TITLES,
  type Game,
  type GameId,
  type Host,
  type NoteOptions,
  PartyError,
  type Player,
  SELF_KEY,
  type StartOptions,
} from "./game.js";
import { ChainGame } from "./games/chain.js";
import { QuizGame } from "./games/quiz.js";
import { SongGame } from "./games/song.js";
import { SoupGame } from "./games/soup.js";
import type { SoupJudge } from "./judge.js";
import { asksToStop } from "./match.js";

/** Something she should know (and, with `speak`, may react to). */
export interface PartyNote {
  session: string;
  game: GameId;
  context: ContextKey;
  /**
   * `party:<session>:<what>`: the same thing always has the same key. A note she may react to
   * that a person's line caused (the verdict on an answer, the end it brought) carries the key
   * of that line instead (`answers`), so what answers it is one thing, not two.
   */
  key: string;
  revision: number;
  /** The key of the line this note is the game's answer to (the same as `key`), else `null`. */
  answers: string | null;
  summary: string;
  speak: boolean;
  untrusted: boolean;
  person: AccountRef | null;
}

/** A session that ended. */
export interface PartyEnded {
  session: string;
  game: GameId;
  context: ContextKey;
  reason: EndReason;
}

export interface PartyOutput {
  note(note: PartyNote): void;
  ended(info: PartyEnded): void;
}

export interface Timers {
  set(fn: () => void, ms: number): unknown;
  clear(handle: unknown): void;
}

export const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface TableDeps {
  config: PartyConfig;
  clock: Clock;
  random: () => number;
  timers?: Timers;
  output: PartyOutput;
  rewards?: () => PartyRewards | null;
  clips?: () => SongClips | null;
  judge?: () => SoupJudge | null;
  warn?: (message: string, detail?: unknown) => void;
}

/** Who wrote or said something. */
export interface Speaker {
  account: AccountRef;
  name: string;
}

const END_TEXT: Readonly<Record<EndReason, string>> = {
  done: "玩完了",
  host: "你結束了遊戲",
  stop: "有人說不玩了",
  idle: "很久沒有人玩",
  empty: "大家都離開語音了",
  left: "你離開了語音頻道",
  away: "你去忙別的事了",
  shutdown: "系統關閉",
};

/** Framework timers are prefixed so a game's own names never collide with them. */
const IDLE_TIMER = "_idle";
const EMPTY_TIMER = "_empty";

function viewPlayers(players: readonly Player[]): PartyPlayerView[] {
  return players.map((p) => ({
    name: p.her ? "你" : safeName(p.name, 24),
    her: p.her,
    score: p.score,
    present: p.present,
    active: p.active,
  }));
}

function createGame(id: GameId, host: Host, options: StartOptions): Game {
  switch (id) {
    case "quiz":
      return new QuizGame(host, options);
    case "song":
      return new SongGame(host, options);
    case "chain":
      return new ChainGame(host, options);
    case "soup":
      return new SoupGame(host, options);
  }
}

/** One game in one voice channel. */
export class Session implements Host {
  readonly id: string;
  readonly context: ContextKey;
  readonly game: Game;
  readonly startedAt: number;
  readonly #table: Table;
  readonly #players = new Map<string, Player>();
  readonly #timers = new Map<string, unknown>();
  readonly #revisions = new Map<string, number>();
  readonly #controller = new AbortController();
  #ended: EndReason | null = null;
  /** The attention key of the line being handled right now, while its game is working on it. */
  #answering: string | null = null;
  /** What `begin` said, for the tool that started it. */
  opening = "";

  constructor(table: Table, id: GameId, context: ContextKey, options: StartOptions) {
    this.#table = table;
    this.id = newId();
    this.context = context;
    this.startedAt = table.clock.now();
    this.#players.set(SELF_KEY, {
      key: SELF_KEY,
      account: null,
      name: "你",
      score: 0,
      present: true,
      her: true,
      active: false,
    });
    this.game = createGame(id, this, options);
  }

  get cfg(): PartyConfig {
    return this.#table.config;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get ended(): EndReason | null {
    return this.#ended;
  }

  now(): number {
    return this.#table.clock.now();
  }

  random(): number {
    return this.#table.random();
  }

  players(): Player[] {
    return [...this.#players.values()];
  }

  humans(): Player[] {
    return this.players().filter((p) => !p.her);
  }

  her(): Player {
    return this.#players.get(SELF_KEY) as Player;
  }

  find(name: string): Player | null {
    const wanted = name.trim();
    if (wanted === "") return null;
    if (wanted === "你" || wanted === "自己") return this.her();
    const all = this.humans();
    const exact = all.find((p) => p.name === wanted || safeName(p.name, 24) === wanted);
    if (exact) return exact;
    const partial = all.filter((p) => p.name.includes(wanted) || wanted.includes(p.name));
    return partial.length === 1 ? (partial[0] ?? null) : null;
  }

  /** The player for `speaker`, added when new (someone who joined or typed in the chat). */
  player(speaker: Speaker, present = true): Player {
    const key = accountRefString(speaker.account);
    const known = this.#players.get(key);
    if (known) {
      known.name = speaker.name;
      if (present) known.present = true;
      return known;
    }
    const player: Player = {
      key,
      account: speaker.account,
      name: speaker.name,
      score: 0,
      present,
      her: false,
      active: false,
    };
    this.#players.set(key, player);
    return player;
  }

  score(player: Player, points: number): void {
    player.score = Math.max(0, player.score + points);
    if (points > 0) player.active = true;
  }

  note(key: string, summary: string, options: NoteOptions = {}): void {
    if (this.#ended !== null && key !== "end") return;
    const speak = options.speak ?? true;
    // Her reply to a spoken answer is a turn of the main line already (it answers whoever
    // spoke just after her). The verdict about that answer shares the answer's key, so the
    // delivery ledger sees one thing: once she answered the line, the verdict is not claimed
    // again (and she is not made to say it twice).
    const answers = speak ? this.#answering : null;
    const revision = answers === null ? (this.#revisions.get(key) ?? 0) + 1 : 1;
    if (answers === null) this.#revisions.set(key, revision);
    this.#table.output.note({
      session: this.id,
      game: this.game.id,
      context: this.context,
      key: answers ?? `party:${this.id}:${key}`,
      answers,
      revision,
      summary,
      speak,
      untrusted: options.untrusted ?? false,
      person: options.person?.account ?? null,
    });
  }

  /** Runs `fn` with every note it makes answering the line whose key is `key`. */
  answering<T>(key: string | null, fn: () => T): T {
    const before = this.#answering;
    this.#answering = key;
    try {
      return fn();
    } finally {
      this.#answering = before;
    }
  }

  setTimer(name: string, ms: number): void {
    this.clearTimer(name);
    if (this.#ended !== null) return;
    const handle = this.#table.timers.set(() => {
      this.#timers.delete(name);
      if (this.#ended !== null) return;
      if (name === IDLE_TIMER) this.end("idle");
      else if (name === EMPTY_TIMER) this.end("empty");
      else this.game.timer(name);
    }, ms);
    this.#timers.set(name, handle);
  }

  clearTimer(name: string): void {
    const handle = this.#timers.get(name);
    if (handle === undefined) return;
    this.#table.timers.clear(handle);
    this.#timers.delete(name);
  }

  /** Someone did something for the game: it is not idle. */
  touch(): void {
    this.setTimer(IDLE_TIMER, this.cfg.idle_mins * 60_000);
  }

  end(reason: EndReason, quiet = false): void {
    if (this.#ended !== null) return;
    this.#ended = reason;
    for (const handle of this.#timers.values()) this.#table.timers.clear(handle);
    this.#timers.clear();
    this.#controller.abort();
    this.#table.closed(this, reason, quiet);
  }

  /** The end note: why, the final scores and what the game still has to say. */
  finish(reason: EndReason): string {
    const lines = [`「${this.game.title}」結束了(${END_TEXT[reason]})。`];
    if (this.game.scored) lines.push(`最後分數:${this.standings()}`);
    lines.push(...this.game.finish(reason));
    return lines.join("\n");
  }

  standings(): string {
    const ranked = this.players()
      .filter((p) => p.her || p.active || p.score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length === 0) return "還沒有人得分";
    return ranked.map((p) => `${p.her ? "你" : safeName(p.name, 24)} ${p.score}`).join("、");
  }

  clips(): SongClips | null {
    return this.#table.clips();
  }

  judge(): SoupJudge | null {
    return this.#table.judge();
  }

  /** Presence from the channel's member list. */
  members(members: readonly VoiceParticipant[], self: (a: AccountRef) => boolean): void {
    const here = new Set<string>();
    for (const m of members) {
      if (m.is_self || self(m.account)) continue;
      here.add(accountRefString(m.account));
      this.player({ account: m.account, name: m.display_name }, true);
    }
    for (const p of this.humans()) p.present = here.has(p.key);
    if (here.size === 0) {
      if (!this.#timers.has(EMPTY_TIMER)) {
        this.setTimer(EMPTY_TIMER, this.cfg.empty_grace_secs * 1000);
      }
    } else this.clearTimer(EMPTY_TIMER);
  }
}

/** Every game going on, one per voice channel. */
export class Table {
  readonly config: PartyConfig;
  readonly clock: Clock;
  readonly random: () => number;
  readonly timers: Timers;
  readonly output: PartyOutput;
  readonly #rewards: () => PartyRewards | null;
  readonly #clips: () => SongClips | null;
  readonly #judge: () => SoupJudge | null;
  readonly #warn: (message: string, detail?: unknown) => void;
  readonly #sessions = new Map<string, Session>();
  /** Who is in each voice channel she is in. */
  readonly #rooms = new Map<string, { context: ContextKey; members: VoiceParticipant[] }>();
  readonly #self = new Set<string>();
  /** Games that ended, newest first; in memory only. */
  #recent: PartyResultView[] = [];

  constructor(deps: TableDeps) {
    this.config = deps.config;
    this.clock = deps.clock;
    this.random = deps.random;
    this.timers = deps.timers ?? realTimers;
    this.output = deps.output;
    this.#rewards = deps.rewards ?? (() => null);
    this.#clips = deps.clips ?? (() => null);
    this.#judge = deps.judge ?? (() => null);
    this.#warn = deps.warn ?? (() => {});
  }

  clips(): SongClips | null {
    return this.#clips();
  }

  judge(): SoupJudge | null {
    return this.#judge();
  }

  // ---- her voice channels -----------------------------------------------------------------

  /** One of her own accounts: never a player. */
  self(account: AccountRef): void {
    this.#self.add(accountRefString(account));
  }

  isSelf(account: AccountRef): boolean {
    return this.#self.has(accountRefString(account));
  }

  /** She is in `context` with `members` (joined, or the member list changed). */
  members(context: ContextKey, members: readonly VoiceParticipant[]): void {
    for (const m of members) if (m.is_self) this.self(m.account);
    this.#rooms.set(contextKeyString(context), { context, members: [...members] });
    const session = this.#sessions.get(contextKeyString(context));
    session?.members(members, (a) => this.isSelf(a));
  }

  /** She left `context`: its game ends. */
  left(context: ContextKey): void {
    this.#rooms.delete(contextKeyString(context));
    this.#sessions.get(contextKeyString(context))?.end("left");
  }

  /** The voice channel she is in on `guild`, if any. */
  room(platform: string, guild: string | null): ContextKey | null {
    for (const { context } of this.#rooms.values()) {
      if (context.platform === platform && context.scope === guild) return context;
    }
    return null;
  }

  /** People (not her) in the voice channel `context`. */
  listeners(context: ContextKey): number {
    const room = this.#rooms.get(contextKeyString(context));
    if (!room) return 0;
    return room.members.filter((m) => !m.is_self && !this.isSelf(m.account) && !m.deafened).length;
  }

  // ---- games ------------------------------------------------------------------------------

  /**
   * What the admin panel shows: who plays what and the scores, and how the last games ended. Never
   * what the game keeps hidden (`Game.view` is hers alone and is not read here).
   */
  snapshot(): PartySnapshot {
    const iso = (ms: number) => new Date(ms).toISOString();
    const sessions = this.sessions()
      .filter((s) => s.ended === null)
      .map((s) => ({
        id: s.id,
        game: s.game.id,
        title: s.game.title,
        context: s.context,
        state: "running" as const,
        started_at: iso(s.startedAt),
        scored: s.game.scored,
        players: viewPlayers(s.players().filter((p) => p.her || p.present || p.score > 0)),
      }));
    return { sessions, recent: this.#recent.map((r) => ({ ...r, players: [...r.players] })) };
  }

  /** The game in `context`: the voice channel itself, or its text chat (same channel id). */
  session(context: ContextKey): Session | null {
    if (context.kind === "voice") return this.#sessions.get(contextKeyString(context)) ?? null;
    if (context.kind !== "channel" || context.scope === null) return null;
    return this.#sessions.get(contextKeyString({ ...context, kind: "voice" })) ?? null;
  }

  sessions(): Session[] {
    return [...this.#sessions.values()];
  }

  /**
   * Starts `game` in the voice channel `context`. Returns what she should know to open it. One
   * game per channel: a second start while one runs is refused, whoever asked first wins.
   */
  start(context: ContextKey, game: GameId, options: StartOptions = {}): Session {
    const id = contextKeyString(context);
    const running = this.#sessions.get(id);
    if (running) {
      throw new PartyError(`這裡已經在玩「${running.game.title}」了,要換遊戲先結束它。`);
    }
    const room = this.#rooms.get(id);
    if (!room) throw new PartyError("你不在這個語音頻道裡。");
    const session = new Session(this, game, context, options);
    this.#sessions.set(id, session);
    try {
      session.members(room.members, (a) => this.isSelf(a));
      session.touch();
      session.opening = session.game.begin();
    } catch (error) {
      this.#sessions.delete(id);
      session.end("shutdown");
      throw error;
    }
    return session;
  }

  /**
   * A player's line in `context` (speech, or the voice channel's chat). Someone asking to stop
   * ends the game; anything else goes to the game. `origin`: the attention key the main line
   * answers that line under (`voice:utterance:<id>`, `msg:<platform>:<id>`), when known.
   */
  input(context: ContextKey, speaker: Speaker, text: string, origin: string | null = null): void {
    if (this.isSelf(speaker.account)) return;
    const session = this.session(context);
    if (!session || session.ended !== null) return;
    const player = session.player(speaker, true);
    session.touch();
    session.answering(origin, () => {
      if (asksToStop(text)) {
        session.note("stop", `${safeName(player.name, 24)} 說不想玩了,遊戲先結束。`, {
          person: player,
          speak: false,
        });
        session.end("stop");
        return;
      }
      if (session.game.input(player, text)) player.active = true;
    });
  }

  /** Ends the game in `context`; `false` when there is none. */
  end(context: ContextKey, reason: EndReason): boolean {
    const session = this.session(context);
    if (!session) return false;
    session.end(reason);
    return true;
  }

  /** She went off to do something else: every game ends. */
  away(): void {
    for (const s of this.sessions()) s.end("away");
  }

  /** The module stops: every game ends without a word. */
  close(): void {
    for (const s of this.sessions()) s.end("shutdown");
  }

  /** @internal A session ended: the last note, rewards, and the channel is free again. */
  closed(session: Session, reason: EndReason, quiet: boolean): void {
    const id = contextKeyString(session.context);
    if (this.#sessions.get(id) === session) this.#sessions.delete(id);
    if (reason === "shutdown") return;
    this.#recent.unshift({
      id: session.id,
      game: session.game.id,
      title: session.game.title,
      context: session.context,
      reason,
      started_at: new Date(session.startedAt).toISOString(),
      ended_at: new Date(this.clock.now()).toISOString(),
      scored: session.game.scored,
      players: viewPlayers(
        session
          .players()
          .filter((p) => p.her || p.active || p.score > 0)
          .sort((a, b) => b.score - a.score),
      ),
    });
    if (this.#recent.length > PARTY_RECENT_MAX) this.#recent.length = PARTY_RECENT_MAX;
    session.note("end", session.finish(reason), {
      // Only an end she did not see coming is worth a line: she ended it herself, left, or
      // nobody is there to hear it.
      speak: !quiet && (reason === "done" || reason === "stop" || reason === "idle"),
      untrusted: session.game.id === "chain",
    });
    this.output.ended({
      session: session.id,
      game: session.game.id,
      context: session.context,
      reason,
    });
    this.#reward(session);
  }

  /** Coins for the people who played a scored game, through whoever provides rewards. */
  #reward(session: Session): void {
    const cfg = this.config.rewards;
    const rewards = this.#rewards();
    if (!cfg.enabled || !session.game.scored || rewards === null) return;
    const took = session.humans().filter((p) => p.active);
    if (took.length < cfg.min_players) return;
    const awards = took.flatMap((p) => {
      const coins = Math.min(p.score * cfg.coins_per_point, cfg.max_coins);
      return p.account !== null && coins > 0 ? [{ account: p.account, name: p.name, coins }] : [];
    });
    if (awards.length === 0) return;
    const request: PartyRewardRequest = {
      id: `party:${session.id}`,
      game: session.game.id,
      title: GAME_TITLES[session.game.id],
      context: session.context,
      awards,
    };
    const paid = awards.map((a) => `${safeName(a.name, 24)} ${a.coins}`).join("、");
    void rewards.award(request).then(
      () =>
        this.output.note({
          session: session.id,
          game: session.game.id,
          context: session.context,
          key: `party:${session.id}:rewards`,
          answers: null,
          revision: 1,
          summary: `「${session.game.title}」的魚幣發好了:${paid}。`,
          speak: false,
          untrusted: false,
          person: null,
        }),
      (error: unknown) => this.#warn("party rewards failed", error),
    );
  }
}
