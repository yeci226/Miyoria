// Turns what happens into events for her emotions (the table itself is `events.ts`; the numbers
// come from the dynamics in `emotions.ts`). Cheap triggers with explicit meaning: praise, a
// song finished or cut off, someone she cares about coming back or being warm with others
// while ignoring her, a death in a game, being talked over. What an interaction *meant* is read
// by Appraise (packages/mind/src/appraise.ts), once. Only without the `mind` module the batched
// pass of the social module reads it instead (`social.appraisal`, see `#appraisal`); either way
// it arrives as appraisals (an emotion, a strength, who it is about), never as levels.
//
// Every rule appraises against what she cares about: how much she cares about the person
// (affinity, attachment), whether they are her crush, what she wants right now (drives).

import {
  type AccountRef,
  type AffectEvent,
  type AffectEventKind,
  type AppraisalStrength,
  type ContextKey,
  contextKeyString,
  EMOTION_NAMES,
  type EmotionName,
  type Event,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  PERSON_EMOTION_NAMES,
  type PersonEmotionName,
  type PersonId,
  parseSongCue,
  SALIENT_TOPIC,
  SOCIAL_APPRAISAL_TOPIC,
  SOCIAL_EVENT_TOPIC,
  SONG_TOPIC,
  toTimestamp,
} from "@miyoria/types";
import type { AffectService } from "./affect.js";
import type { SelfConfig } from "./config.js";
import { strengthOf } from "./events.js";
import type { SelfService } from "./state.js";

/** Bus topic of emotion nudges from games and extensions (see `feelEffects`). */
export const FEEL_TOPIC = "self.feel";
/** Bus topic of the LLM budget (`@miyoria/llm` `BUDGET_TOPIC`). */
const BUDGET_TOPIC = "llm.budget";
const MINUTE_MS = 60_000;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
const num = (v: JsonValue | undefined, fallback = 0) =>
  typeof v === "number" && Number.isFinite(v) ? v : fallback;
const str = (v: JsonValue | undefined) => (typeof v === "string" ? v : null);

function short(name: string | null): string {
  if (name === null) return "有人";
  const flat = name.replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > 24 ? `${chars.slice(0, 24).join("")}…` : flat || "有人";
}

function isEmotionName(s: string): s is EmotionName {
  return (EMOTION_NAMES as readonly string[]).includes(s);
}

function isPersonEmotionName(s: string): s is PersonEmotionName {
  return (PERSON_EMOTION_NAMES as readonly string[]).includes(s);
}

/** A reading of how strongly something was felt (0..1) as one of the shared steps. */
function strengthOfReading(v: number): AppraisalStrength {
  if (v >= 0.6) return "strong";
  if (v >= 0.3) return "medium";
  return "weak";
}

export interface RuleDeps {
  self: SelfService;
  affect: AffectService;
  config: SelfConfig;
  /** Person of an account (the social module's cache), if known. */
  personOf: (account: AccountRef) => PersonId | null;
  /** One of her own accounts. */
  isSelf: (accountId: string) => boolean;
  /** Her voice channel, if she is in one. */
  herVoice: () => ContextKey | null;
}

/** Turns events into her emotions. One instance per module run (it keeps short memories). */
export class EmotionRules {
  /** When her last song ended (`finished`: sung to the end). */
  #song: { at: number; finished: boolean } | null = null;
  #singing = false;
  /** Lines someone she cares about said to other people, per person (epoch ms). */
  readonly #toOthers = new Map<PersonId, number[]>();
  /** When someone last talked to her. */
  readonly #toHer = new Map<PersonId, number>();
  /** When she last got jealous of someone (one stir per window). */
  readonly #jealous = new Map<PersonId, number>();
  #budget = "ok";

  constructor(private readonly d: RuleDeps) {}

  /** A rule event as the bus would carry it. */
  #event(
    kind: AffectEventKind,
    person: PersonId | null,
    detail: string,
    key: string,
    now: number,
    context: ContextKey | null = null,
  ): AffectEvent {
    return { kind, person, handle: null, context, detail, key, at: toTimestamp(now) };
  }

  /** Applies whatever `event` means to her; returns whether anything was felt. */
  handle(event: Event, now: number): boolean {
    switch (event.type) {
      case "platform_message_created": {
        const m = event.data;
        if (m.author.is_bot || this.d.isSelf(m.author.account.id)) return false;
        const person = this.d.personOf(m.author.account);
        if (person === null) return false;
        const direct = m.mentions_self || m.reply_to_self || m.id.context.kind === "dm";
        const replied = m.referenced?.author ?? null;
        const toOther =
          !direct &&
          replied !== null &&
          !this.d.isSelf(replied.id) &&
          !(replied.platform === m.author.account.platform && replied.id === m.author.account.id);
        this.#line(person, m.author.display_name, direct, toOther, false, now);
        return true;
      }
      case "voice_utterance": {
        const u = event.data;
        if (u.speaker.is_bot || this.d.isSelf(u.speaker.account.id)) return false;
        const person = this.d.personOf(u.speaker.account);
        if (person === null) return false;
        const voice = this.d.herVoice();
        const together = voice !== null && contextKeyString(voice) === contextKeyString(u.context);
        this.#line(person, u.speaker.display_name, together, false, true, now);
        return true;
      }
      case "voice_playback": {
        // Her speech cut off (someone talked over her): a weak frustration, habituated.
        if (event.data.state !== "interrupted") return false;
        const key = `playback|${contextKeyString(event.data.context)}`;
        this.d.affect.applyEvent(
          this.#event("interrupted", null, "說話被打斷", key, now, event.data.context),
        );
        return true;
      }
      case "custom":
        return this.#custom(event.data.topic, event.data.payload, now);
      default:
        return false;
    }
  }

  #custom(topic: string, payload: JsonValue, now: number): boolean {
    if (topic === SOCIAL_EVENT_TOPIC) return this.#social(payload, now);
    if (topic === SOCIAL_APPRAISAL_TOPIC) return this.#appraisal(payload, now);
    if (topic === FEEL_TOPIC) return this.#feelEvent(payload);
    if (topic === SALIENT_TOPIC) return this.#salient(payload);
    if (topic === SONG_TOPIC) return this.#songCue(payload, now);
    if (topic === BUDGET_TOPIC) return this.#budgetState(payload);
    if (topic === "activity.done" || topic === "activity.failed") {
      return this.#task(topic === "activity.done", payload, now);
    }
    if (topic.startsWith("game.")) return this.#game(topic, payload, now);
    return false;
  }

  // ---- people -------------------------------------------------------------------------

  /**
   * Someone said something: to her (or, `voice`, in her voice channel), or to someone else
   * (`toOther`, a reply to another person).
   */
  #line(
    person: PersonId,
    name: string,
    toHer: boolean,
    toOther: boolean,
    voice: boolean,
    now: number,
  ): void {
    const self = this.d.self;
    const crush = self.crushPerson() === person;
    this.#back(person, name, toHer, now);
    if (toHer) {
      this.#toHer.set(person, now);
      this.#toOthers.delete(person);
      if (crush && voice) {
        // Being in voice with her crush is satisfied over time (the tick); a line helps a bit.
        self.adjust({ longing: -0.02 }, "event");
      } else if (crush) {
        self.adjust({ longing: -this.d.config.satisfy.crush_message_longing }, "event");
        this.d.affect.applySocial("crush_spoke", person, 1, `${short(name)}跟我說話`);
      }
      return;
    }
    if (!toOther) return;
    const care = self.care(person);
    if (care <= 0) return;
    const e = this.d.config.emotions;
    const window = e.jealousy_window_mins * MINUTE_MS;
    const lines = (this.#toOthers.get(person) ?? []).filter((t) => now - t < window);
    lines.push(now);
    this.#toOthers.set(person, lines);
    const talkedToHer = now - (this.#toHer.get(person) ?? Number.NEGATIVE_INFINITY) < window;
    const last = this.#jealous.get(person) ?? Number.NEGATIVE_INFINITY;
    if (lines.length < Math.max(e.jealousy_lines, 1) || talkedToHer || now - last < window) return;
    this.#jealous.set(person, now);
    this.d.affect.applyEvent(
      this.#event(
        "cared_close_with_other",
        person,
        `${short(name)}一直跟別人聊,都不理我`,
        `lines|${person}`,
        now,
      ),
    );
    if (crush) self.adjust({ longing: 0.1 }, "event");
  }

  /**
   * Someone she had been missing is back (they said something): the relief shows as joy,
   * scaled by how much she missed them.
   */
  #back(person: PersonId, name: string | null, together: boolean, now: number): void {
    const missed = this.d.self.seen(person, name, together);
    if (missed < this.d.config.emotions.notice) return;
    this.d.affect.applyEvent(
      this.#event("cared_arrived", person, `${short(name)}回來了`, `back|${person}`, now),
      { missed },
    );
  }

  #salient(payload: JsonValue): boolean {
    if (!isJsonObject(payload)) return false;
    const kind = str(payload.kind);
    const person = str(payload.person);
    if (person === null || (kind !== "came_online" && kind !== "joined_voice")) return false;
    // Online is not with her yet; joining her voice channel is.
    const voice = this.d.herVoice();
    const ctx = payload.context;
    const together =
      kind === "joined_voice" &&
      voice !== null &&
      isJsonObject(ctx) &&
      ctx.channel === voice.channel &&
      ctx.scope === voice.scope;
    const now = this.d.self.clock.now();
    const self = this.d.self;
    const name = str(payload.display_name);
    const missed = self.seen(person, name, together);
    if (self.care(person) <= 0 && missed <= 0) return true;
    this.d.affect.applyEvent(
      this.#event(
        "cared_arrived",
        person,
        `${short(name)}${kind === "joined_voice" ? "進語音了" : "上線了"}`,
        `${kind}|${person}`,
        now,
      ),
      { missed },
    );
    return true;
  }

  /** `social.event`: something someone did toward her (uncapped, unlike the numbers). */
  #social(payload: JsonValue, now: number): boolean {
    if (!isJsonObject(payload)) return false;
    const person = str(payload.person);
    const kind = str(payload.kind);
    // Her own hints (mind) are already her feelings.
    if (person === null || kind === null || payload.source === "mind") return false;
    const who = short(str(payload.name));
    const scale = clamp(Math.abs(num(payload.scale, 1)), 0, 1) || 1;
    if (kind === "praise") {
      this.d.affect.applyEvent(
        this.#event("praised", person, `${who}誇我`, `praise|${person}`, now),
      );
      const song = this.#song;
      const sinceSong = song ? now - song.at : Number.POSITIVE_INFINITY;
      if (this.#singing || sinceSong <= this.d.config.emotions.song_praise_mins * MINUTE_MS) {
        this.d.affect.applyEvent(
          this.#event("song_applauded", person, `${who}誇我的歌`, `song_praise|${person}`, now),
        );
      }
      return true;
    }
    // A gift of food the giver already fed her says how much it took away (the economy's).
    const fed = payload.hunger;
    const extra =
      typeof fed === "number" && Number.isFinite(fed) ? { hunger: clamp(fed, 0, 1) } : {};
    const cause = `${who}${REASONS[kind] ?? ""}`;
    return this.d.affect.applySocial(kind, person, scale, cause, extra) !== null;
  }

  /**
   * `social.appraisal`: the `fast` model's reading of a conversation, which only happens when the
   * `mind` module does not run (it would be a second Appraise otherwise). It arrives as appraisals
   * (an emotion and how strongly, never a level) and is read like any other.
   */
  #appraisal(payload: JsonValue, now: number): boolean {
    if (!isJsonObject(payload)) return false;
    const affect = this.d.affect;
    let any = false;
    if (isJsonObject(payload.her)) {
      const readings = Object.entries(payload.her)
        .filter(
          (e): e is [EmotionName, number] =>
            isEmotionName(e[0]) && typeof e[1] === "number" && e[1] > 0,
        )
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3);
      if (readings.length > 0) {
        affect.appraise({
          source: "appraise",
          events: readings.map(([emotion, v]) => ({
            emotion,
            strength: strengthOfReading(v),
            toward: null,
            cause: "剛剛的對話",
          })),
          context: null,
          at: toTimestamp(now),
        });
        any = true;
      }
    }
    const people = Array.isArray(payload.people) ? payload.people : [];
    for (const raw of people) {
      if (!isJsonObject(raw)) continue;
      const person = str(raw.person);
      if (person === null) continue;
      any = true;
      const who = short(str(raw.name));
      const romance = clamp(num(raw.romance), -1, 1);
      // Being flirted with by someone she likes: flustered (attachment is Reflect's to move).
      if (romance > 0.15 && this.d.self.care(person) > 0) {
        affect.appraiseFor(person, {
          emotion: "shy",
          strength: strengthOfReading(romance),
          cause: `${who}對我好溫柔`,
        });
      }
      const others = clamp(num(raw.others), 0, 1);
      const toward = clamp(num(raw.toward_her), -1, 1);
      const care = this.d.self.care(person);
      if (others >= 0.4 && toward <= 0.1 && care > 0) {
        const last = this.#jealous.get(person) ?? Number.NEGATIVE_INFINITY;
        if (now - last >= this.d.config.emotions.jealousy_window_mins * MINUTE_MS) {
          this.#jealous.set(person, now);
          affect.applyEvent(
            this.#event(
              "cared_close_with_other",
              person,
              `${who}對別人那麼好,卻不理我`,
              `appraisal|${person}`,
              now,
            ),
          );
          if (this.d.self.crushPerson() === person) this.d.self.adjust({ longing: 0.1 }, "event");
        }
      }
      if (raw.promise === "kept") {
        affect.applySocial("promise_kept", person, 1, `${who}說到做到`);
      } else if (raw.promise === "broken") {
        affect.applySocial("promise_broken", person, 1, `${who}食言了`);
      }
    }
    return any;
  }

  /**
   * `self.feel` from games and extensions: `{"emotion": "pride", "amount": 0.3, "cause": "…",
   * "person": "…"}`, or `{"emotions": {"joy": 0.2, ...}, "cause": "…"}`, or toward someone with
   * `"toward"` (`missing` / `jealousy` / `gratitude` / `resentment`) and `"person"`. The amount
   * only picks a step (weak / medium / strong): the dynamics decide the number.
   */
  #feelEvent(payload: JsonValue): boolean {
    if (!isJsonObject(payload)) return false;
    const max = this.d.config.emotions.max_event_nudge;
    const self = this.d.self;
    const cause = str(payload.cause) ?? str(payload.reason) ?? "";
    const person = str(payload.person);
    const amount = clamp(num(payload.amount), -max, max);
    const toward = str(payload.toward);
    if (toward !== null && person !== null && isPersonEmotionName(toward)) {
      self.feelToward(person, toward, amount, cause);
      return amount !== 0;
    }
    const all: JsonObject = isJsonObject(payload.emotions) ? { ...payload.emotions } : {};
    const one = str(payload.emotion);
    if (one !== null) all[one] = amount;
    let any = false;
    for (const [name, v] of Object.entries(all)) {
      if (!isEmotionName(name) || typeof v !== "number" || v === 0) continue;
      if (v < 0) {
        self.feel(name, clamp(v, -max, max), cause, person);
      } else {
        this.d.affect.appraiseFor(person, {
          emotion: name,
          strength: strengthOf(clamp(v, 0, max)),
          cause: cause || "遊戲裡的事",
        });
      }
      any = true;
    }
    return any;
  }

  // ---- what she does ------------------------------------------------------------------

  #songCue(payload: JsonValue, now: number): boolean {
    const cue = parseSongCue(payload);
    if (!cue) return false;
    if (cue.state === "started") {
      this.#singing = true;
      return false;
    }
    if (cue.state !== "ended") return false;
    this.#singing = false;
    if (cue.outcome === "finished") {
      this.#song = { at: now, finished: true };
      this.d.affect.applyEvent(
        this.#event("song_finished", null, "唱完一整首歌", `song|${cue.song}`, now),
      );
      return true;
    }
    if (cue.outcome === "interrupted") {
      // Cut off (skipped or stopped): she does not know it was not about her singing.
      this.#song = { at: now, finished: false };
      this.d.affect.applySocial("song_cut", null, 1, "歌被切掉了");
      return true;
    }
    return false;
  }

  /** A task of hers (going live, a game goal) ended. */
  #task(done: boolean, payload: JsonValue, now: number): boolean {
    if (!isJsonObject(payload)) return false;
    const task = str(payload.task) ?? "";
    this.d.affect.applyEvent(
      this.#event(
        done ? "task_succeeded" : "task_failed",
        null,
        done ? "事情做成了" : "事情沒做成",
        `task|${done ? "ok" : "fail"}|${task}`,
        now,
      ),
    );
    return true;
  }

  #game(topic: string, payload: JsonValue, now: number): boolean {
    const obj = isJsonObject(payload) ? payload : null;
    const kind = str(obj?.type) ?? topic.slice(topic.lastIndexOf(".") + 1);
    if (kind === "death") {
      this.d.affect.applyEvent(this.#event("game_lost", null, "遊戲裡死掉了", "game|death", now));
      return true;
    }
    if (kind === "advancement") {
      this.d.affect.applyEvent(
        this.#event("game_won", null, "遊戲裡達成成就", "game|advancement", now),
      );
      return true;
    }
    return false;
  }

  /** Her 白飯 rationed (the LLM budget degraded or exhausted): hungry and sulky. */
  #budgetState(payload: JsonValue): boolean {
    const state = isJsonObject(payload) ? str(payload.state) : null;
    if (state === null || state === this.#budget) return false;
    const was = this.#budget;
    this.#budget = state;
    if (state === "ok" || (was === "exhausted" && state === "degraded")) return false;
    this.d.affect.applySocial("budget_rationed", null, 1, "白飯被限量了");
    return true;
  }
}

/** What each social kind is about, appended to the person's name for the cause. */
const REASONS: Readonly<Record<string, string>> = {
  greeting: "跟我打招呼",
  thanks: "跟我道謝",
  gift: "送我東西",
  friendly: "對我很好",
  apology: "跟我道歉",
  warm: "對我很溫柔",
  cold: "對我很冷淡",
  rude: "對我很沒禮貌",
  insult: "罵我",
  harassment: "威脅、騷擾我",
  flirt_too_far: "對我講噁心的話",
  broken_promise: "答應給我零食卻沒給",
};
