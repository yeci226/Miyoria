// Impulse producers folded in from the old initiative engine: greeting friends on their first
// message of the day and when they join her voice channel (source `world`), and bringing up a
// memory followup when the person is around (source `followup`). They only notice; whether
// and when she speaks is the Arbiter's (no caps or quiet hours here).
//
// The old idle-channel nudge is gone: "a channel went quiet" is one signal now, the world
// module's `world.salient` `channel_quiet` (text and voice), which wakes her Plan; she decides
// whether to raise something (source `plan`).
//
// Pure: feed it events with an explicit `now` (epoch ms); it returns impulses to submit.

import {
  type AccountRef,
  type Attitude,
  type ContextKey,
  contextKeyString,
  type Event,
  type Followup,
  type Handle,
  type Impulse,
  newImpulse,
  type SocialSignals,
  type VoiceParticipant,
} from "@miyoria/types";
import { z } from "zod";
import type { ArbiterConfig } from "./config.js";
import { dayIndex } from "./time.js";

const GREETING_HINT = "跟他打招呼";
const VOICE_JOIN_HINT = "他剛進語音頻道,跟他打個招呼";
const VOICE_JOIN_MANY_HINT = "他們剛進語音頻道,跟大家打個招呼";

const DAY_MS = 86_400_000;

function accId(a: AccountRef): string {
  return `${a.platform}\u0000${a.id}`;
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface Person {
  account: AccountRef;
  lastAt: number;
  context: ContextKey;
}

/** Persisted: who was already seen today (greetings happen once a day). */
export const ProducerSnapshotSchema = z.object({
  seen: z
    .array(z.tuple([z.object({ platform: z.string(), id: z.string() }), z.number()]))
    .default([]),
});
export type ProducerSnapshot = z.output<typeof ProducerSnapshotSchema>;

export class Producers {
  readonly #cfg: ArbiterConfig;
  readonly #selfAccounts = new Set<string>();
  readonly #people = new Map<string, Person>();
  /** Non-self participants of the voice channels she is in. */
  readonly #voice = new Map<string, { context: ContextKey; members: Map<string, AccountRef> }>();
  readonly #voiceGreeted = new Map<string, number>();
  /** Day index of each person's first message seen. */
  readonly #seenDay = new Map<string, { account: AccountRef; day: number }>();
  /** Last human message per context. */
  readonly #lastHuman = new Map<string, number>();
  #dirty = false;

  constructor(config: ArbiterConfig) {
    this.#cfg = config;
  }

  isSelf(account: AccountRef): boolean {
    return this.#selfAccounts.has(accId(account));
  }

  /** Digests one bus event; returns greetings to submit. */
  observe(now: number, event: Event, social: SocialSignals | null): Impulse[] {
    switch (event.type) {
      case "platform_ready":
        this.#selfAccounts.add(accId(event.data.self_account));
        return [];
      case "platform_message_created": {
        const m = event.data;
        return this.#onMessage(now, m.id.context, m.author.account, m.author.is_bot, social);
      }
      case "voice_utterance": {
        const u = event.data;
        return this.#onMessage(now, u.context, u.speaker.account, u.speaker.is_bot, social);
      }
      case "voice_joined": {
        const { context, participants } = event.data;
        this.#voice.set(contextKeyString(context), {
          context,
          members: this.#nonSelf(participants),
        });
        return [];
      }
      case "voice_left":
        this.#voice.delete(contextKeyString(event.data.context));
        return [];
      case "voice_participants":
        return this.#onVoiceParticipants(now, event.data.context, event.data.participants, social);
      default:
        return [];
    }
  }

  #nonSelf(participants: readonly VoiceParticipant[]): Map<string, AccountRef> {
    const out = new Map<string, AccountRef>();
    for (const p of participants) {
      if (p.is_self) {
        this.#selfAccounts.add(accId(p.account));
        continue;
      }
      if (!this.#selfAccounts.has(accId(p.account))) out.set(accId(p.account), p.account);
    }
    return out;
  }

  #onMessage(
    now: number,
    context: ContextKey,
    account: AccountRef,
    isBot: boolean,
    social: SocialSignals | null,
  ): Impulse[] {
    if (isBot || this.isSelf(account)) return [];
    this.#lastHuman.set(contextKeyString(context), now);
    this.#people.set(accId(account), { account, lastAt: now, context });
    const day = dayIndex(now, this.#cfg);
    const key = accId(account);
    const previous = this.#seenDay.get(key);
    this.#seenDay.set(key, { account, day });
    if (previous?.day === day) return [];
    this.#dirty = true;
    if (!this.#cfg.greeting) return [];
    const attitude = social?.attitude(account) ?? null;
    if (!attitude || attitude.blocked || !this.#isFriend(attitude)) return [];
    return [this.#impulse(now, context, "greeting", GREETING_HINT, [account], `greeting:${key}`)];
  }

  #isFriend(a: Attitude): boolean {
    return this.#cfg.friend_labels.includes(a.label);
  }

  #onVoiceParticipants(
    now: number,
    context: ContextKey,
    participants: readonly VoiceParticipant[],
    social: SocialSignals | null,
  ): Impulse[] {
    const members = this.#nonSelf(participants);
    const id = contextKeyString(context);
    const previous = this.#voice.get(id);
    this.#voice.set(id, { context, members });
    // We never saw her join: this is just the baseline.
    if (!previous) return [];
    const day = dayIndex(now, this.#cfg);
    const joiners = [...members.entries()]
      .filter(([k]) => !previous.members.has(k))
      .map(([, a]) => a)
      .sort((a, b) => cmpStr(a.id, b.id));
    for (const j of joiners) {
      const prev = this.#seenDay.get(accId(j));
      this.#seenDay.set(accId(j), { account: j, day });
      if (prev?.day !== day) this.#dirty = true;
    }
    if (!this.#cfg.voice_join) return [];
    const cooldown = this.#cfg.voice_join_cooldown_secs * 1000;
    const eligible = joiners.filter((j) => {
      const greeted = this.#voiceGreeted.get(accId(j));
      if (greeted !== undefined && now - greeted < cooldown) return false;
      const a = social?.attitude(j);
      return (
        !!a && !a.blocked && (a.affinity >= this.#cfg.voice_join_min_affinity || this.#isFriend(a))
      );
    });
    if (eligible.length === 0) return [];
    for (const j of eligible) this.#voiceGreeted.set(accId(j), now);
    const hint = eligible.length === 1 ? VOICE_JOIN_HINT : VOICE_JOIN_MANY_HINT;
    return [this.#impulse(now, context, "voice_join", hint, eligible, `voice_join:${id}`)];
  }

  #impulse(
    now: number,
    context: ContextKey,
    reason: string,
    hint: string,
    about: AccountRef[],
    key: string,
  ): Impulse {
    return newImpulse(
      {
        source: "world",
        context,
        account: about.length === 1 ? (about[0] as AccountRef) : null,
        ttlMs: this.#cfg.impulse_ttl_secs * 1000,
        why: hint,
        hint,
        about,
        coalesce_key: key,
        reason,
      },
      now,
    );
  }

  /**
   * Where a due followup can be brought up now (the person is around, or the place it belongs
   * to had people talking lately), as an impulse; `null` when not now. `person`: the handle of
   * the person it is about, so it is one wish with whatever else holds the same topic about them
   * (wishes.ts): said once, not again by another store.
   */
  followup(
    now: number,
    followup: Followup,
    social: SocialSignals | null,
    person: Handle | null = null,
  ): Impulse | null {
    if (!this.#cfg.followup) return null;
    const active = this.#cfg.followup_active_secs * 1000;
    const cands: [ContextKey, AccountRef | null, number][] = [];
    if (followup.person !== null) {
      if (!social) return null;
      const isThem = (a: AccountRef): boolean => {
        const att = social.attitude(a);
        return !!att && att.person === followup.person && !att.blocked;
      };
      for (const p of this.#people.values()) {
        if (now - p.lastAt <= active && isThem(p.account))
          cands.push([p.context, p.account, p.lastAt]);
      }
      for (const v of this.#voice.values()) {
        for (const acc of v.members.values()) if (isThem(acc)) cands.push([v.context, acc, now]);
      }
    } else {
      const ctx = followup.context;
      if (!ctx) return null;
      const last = this.#lastHuman.get(contextKeyString(ctx)) ?? null;
      if (last !== null && now - last <= active) cands.push([ctx, null, last]);
    }
    const own = followup.context ? contextKeyString(followup.context) : null;
    cands.sort((a, b) => {
      const pa = own !== null && contextKeyString(a[0]) === own ? 1 : 0;
      const pb = own !== null && contextKeyString(b[0]) === own ? 1 : 0;
      return pb - pa || b[2] - a[2] || cmpStr(contextKeyString(a[0]), contextKeyString(b[0]));
    });
    const best = cands[0];
    if (!best) return null;
    const [context, account] = best;
    return newImpulse(
      {
        source: "followup",
        context,
        account,
        person,
        ttlMs: this.#cfg.impulse_ttl_secs * 1000,
        why: "之前說好要問的",
        hint: followup.about,
        about: account ? [account] : [],
        coalesce_key: `followup:${followup.id}`,
        reason: "followup",
      },
      now,
    );
  }

  /** Forgets people and greetings older than a day. */
  prune(now: number): void {
    const day = dayIndex(now, this.#cfg);
    for (const [k, s] of this.#seenDay) {
      if (s.day < day - 1) {
        this.#seenDay.delete(k);
        this.#dirty = true;
      }
    }
    for (const [k, p] of this.#people) if (now - p.lastAt >= DAY_MS) this.#people.delete(k);
    for (const [k, at] of this.#voiceGreeted) if (now - at >= DAY_MS) this.#voiceGreeted.delete(k);
    for (const [k, at] of this.#lastHuman) if (now - at >= DAY_MS) this.#lastHuman.delete(k);
  }

  /** Something changed since the last `snapshot`. */
  get dirty(): boolean {
    return this.#dirty;
  }

  snapshot(): ProducerSnapshot {
    this.#dirty = false;
    return {
      seen: [...this.#seenDay.values()].map((s): [AccountRef, number] => [s.account, s.day]),
    };
  }

  restore(snapshot: ProducerSnapshot): void {
    for (const [account, day] of snapshot.seen) this.#seenDay.set(accId(account), { account, day });
  }
}
