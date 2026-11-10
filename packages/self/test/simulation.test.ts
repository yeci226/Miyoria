// The acceptance metric of stage 4 (docs/design/v2-architecture.md §4): "time with any emotion
// above 0.8 is under 10%". A day of synthetic events, drawn from rates that follow a streamer's
// day (quiet night, busy evening, songs, games, praise and the odd insult), through the same
// paths the module uses: rule events, social events, appraisals and the drives.

import {
  type AppraisalStrength,
  EMOTION_NAMES,
  type EmotionName,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { ev, MINUTE, type Rig, rig, T0 } from "./helpers.js";

/** A small deterministic generator (mulberry32). */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Her local hour (UTC+8) of a minute of the day starting at T0 (12:00 local). */
const localHour = (minute: number) => (12 + minute / 60) % 24;

/** Events per hour by local hour: quiet at night, busy in the evening. */
function activity(hour: number): number {
  if (hour < 2) return 0.7;
  if (hour < 10) return 0.05;
  if (hour < 17) return 0.5;
  if (hour < 19) return 0.8;
  if (hour < 24) return 1.6;
  return 0.7;
}

const SOFT: EmotionName[] = ["joy", "shy", "pride", "gratitude", "surprise"];
const HARD: EmotionName[] = [
  "anger",
  "sorrow",
  "fear",
  "disgust",
  "guilt",
  "frustration",
  "jealousy",
];
const STRENGTHS: AppraisalStrength[] = ["weak", "weak", "medium", "medium", "strong"];

interface DayResult {
  /** Share of minutes with any emotion above 0.8. */
  over: number;
  /** Share of minutes with any emotion at or above the level she shows (0.2). */
  noticeable: number;
  peak: Record<string, number>;
}

function day(r: Rig, seed: number, hard = 1): DayResult {
  const random = prng(seed);
  const poisson = (perHour: number) => random() < 1 - Math.exp(-perHour / 60);
  const people = ["p1", "p2", "p3"];
  for (const p of people) r.attitudes.set(p, { affinity: p === "p1" ? 85 : 50, familiarity: 30 });
  r.engine.hearts.attach("p1", 0.4, r.clock.at);

  const minutes = 24 * 60;
  let over = 0;
  let noticeable = 0;
  const peak: Record<string, number> = {};
  for (let m = 0; m < minutes; m++) {
    r.clock.at = T0 + m * MINUTE;
    const now = r.clock.at;
    const rate = activity(localHour(m)) * hard;
    const person = people[Math.floor(random() * people.length)] ?? "p1";
    const key = (kind: string) => `${kind}|${person}`;

    // She talks with people: that satisfies her wish for company (and she answers).
    if (poisson(8 * activity(localHour(m)))) {
      r.self.adjust({ social: -0.06, attention: -0.04, boredom: -0.1 } as never, "turn");
    }
    if (poisson(rate * 0.8))
      r.affect.applyEvent(ev("praised", now, { person, key: key("praise") }));
    if (poisson(rate * 0.25)) r.affect.applySocial("thanks", person, 1, "道謝");
    if (poisson(rate * 0.12))
      r.affect.applySocial(random() < 0.5 ? "insult" : "rude", person, 1, "罵我");
    if (poisson(rate * 0.1))
      r.affect.applyEvent(ev("cared_arrived", now, { person, key: key("arrive") }));
    if (poisson(rate * 0.5)) r.affect.applyEvent(ev("topic_ignored", now, { key: "topic" }));
    if (poisson(rate * 0.4)) r.affect.applyEvent(ev("interrupted", now, { key: "voice" }));
    if (poisson(rate * 0.2))
      r.affect.applyEvent(ev("cared_close_with_other", now, { person, key: key("close") }));
    // Songs in the evening; some are applauded.
    if (localHour(m) >= 19 && poisson(2)) {
      r.affect.applyEvent(ev("song_finished", now, { key: "song" }));
      if (random() < 0.4)
        r.affect.applyEvent(ev("song_applauded", now, { person, key: key("applause") }));
    }
    // A game in the evening.
    if (localHour(m) >= 20 && localHour(m) < 23) {
      if (poisson(2 * hard)) r.affect.applyEvent(ev("game_lost", now, { key: "death" }));
      if (poisson(0.5)) r.affect.applyEvent(ev("game_won", now, { key: "advancement" }));
    }
    // Appraise after an interaction: up to three assessments of what it meant.
    if (poisson(rate * 2)) {
      const events = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, i) => {
        const pool = random() < 0.5 ? SOFT : HARD;
        const emotion = pool[Math.floor(random() * pool.length)] ?? "joy";
        return {
          emotion,
          strength: STRENGTHS[Math.floor(random() * STRENGTHS.length)] ?? "weak",
          toward: null,
          cause: `事件 ${m}-${i} ${emotion}`,
        };
      });
      r.affect.appraise({ source: "appraise", events, context: null, at: toTimestamp(now) });
    }

    const felt = r.self.emotions(0);
    const top = felt[0]?.intensity ?? 0;
    if (top > 0.8) over++;
    if (top >= 0.2) noticeable++;
    for (const e of felt) peak[e.name] = Math.max(peak[e.name] ?? 0, e.intensity);
  }
  return { over: over / minutes, noticeable: noticeable / minutes, peak };
}

describe("a day of synthetic events (acceptance: any emotion above 0.8 under 10% of the time)", () => {
  for (const display of ["open", "tsundere"] as const) {
    it(`${display}: well under 10%, and she still feels things`, () => {
      for (const seed of [1, 2, 3, 4, 5]) {
        const r = rig({ temperament: { display } });
        const result = day(r, seed);
        expect(result.over, `seed ${seed}: ${JSON.stringify(result.peak)}`).toBeLessThan(0.1);
        // Not numb either: something is noticeable for a good part of the day.
        expect(result.noticeable, `seed ${seed}`).toBeGreaterThan(0.2);
        for (const name of EMOTION_NAMES) expect(result.peak[name] ?? 0).toBeLessThanOrEqual(1);
      }
    });
  }

  it("a hard day (three times the events) still stays under 10%", () => {
    for (const seed of [11, 12, 13]) {
      const result = day(rig({ temperament: { display: "tsundere" } }), seed, 3);
      expect(result.over, `seed ${seed}: ${JSON.stringify(result.peak)}`).toBeLessThan(0.1);
    }
  });

  it("loneliness follows the long quiet of the night and eases when people come back", () => {
    const r = rig();
    r.attitudes.set("p1", { affinity: 85, familiarity: 30 });
    r.engine.adjust({ social: 0.7, attention: 0.7 });
    for (let h = 1; h <= 10; h++) {
      r.clock.at = T0 + h * 60 * MINUTE;
      r.self.now();
    }
    const lonely = r.self.emotions(0).find((e) => e.name === "lonely")?.intensity ?? 0;
    expect(lonely).toBeGreaterThan(0.4);
    expect(lonely).toBeLessThanOrEqual(0.8);
    // Company: the drive falls, and so does 寂寞 (nobody drips it back up).
    r.self.adjust({ social: -0.9, attention: -0.9 }, "turn");
    expect(r.self.emotions(0).find((e) => e.name === "lonely")?.intensity ?? 0).toBeLessThan(0.05);
  });
});
