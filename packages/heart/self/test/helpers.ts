// Builders for the affect tests: an engine, the self service and the affect service on a manual
// clock, without a bus or a store.

import {
  CARES_THRESHOLD,
  type Clock,
  type Handle,
  type HeartPeople,
  type HeartView,
  type JsonValue,
  type Mood,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";
import { AffectService } from "../src/affect.js";
import { type SelfConfig, selfConfig } from "../src/config.js";
import { type TemperamentInput, temperament } from "../src/emotions.js";
import { IDLE, SelfEngine } from "../src/engine.js";
import { SelfService } from "../src/state.js";

export const T0 = Date.parse("2026-11-02T04:00:00.000Z");
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export class ManualClock implements Clock {
  constructor(public at = T0) {}
  now(): number {
    return this.at;
  }
}

export const BASELINE: Mood = { valence: 0.1, arousal: 0.5, energy: 0.8 };

export interface Rig {
  clock: ManualClock;
  engine: SelfEngine;
  self: SelfService;
  affect: AffectService;
  config: SelfConfig;
  /** How much she cares about each person (the fake heart's 在意, 0..1). */
  cares: Map<PersonId, number>;
  /** How much she misses each person (the fake heart's longing, 0..1). */
  longing: Map<PersonId, number>;
  /** Handles the fake directory answers with (by person). */
  handles: Map<PersonId, Handle>;
  published: { topic: string; payload: unknown }[];
  advance(ms: number): void;
}

export function rig(
  options: {
    temperament?: TemperamentInput;
    config?: Partial<SelfConfig["emotions"]> & { budget?: number };
    mood?: Mood;
    /** Replaces the fake heart (`HeartKey`) built from `cares` and `longing`. */
    heart?: HeartPeople;
  } = {},
): Rig {
  const clock = new ManualClock();
  const base = selfConfig();
  const config: SelfConfig = {
    ...base,
    emotions: { ...base.emotions, ...options.config },
  };
  if (options.config?.budget !== undefined) {
    config.emotions.budget_per_10min = options.config.budget;
  }
  const engine = new SelfEngine(config, clock.now(), temperament(options.temperament).temperament);
  const cares = new Map<PersonId, number>();
  const longing = new Map<PersonId, number>();
  const handles = new Map<PersonId, Handle>();
  const published: Rig["published"] = [];
  const heart = options.heart ?? fakeHeart(cares, longing);
  const self: SelfService = new SelfService({
    engine,
    clock,
    config,
    circumstances: () => IDLE,
    mood: () => null,
    heart: () => heart,
    nameOf: (person) => handles.get(person) ?? null,
    changed: () => undefined,
  });
  const affect = new AffectService({
    self,
    baseline: options.mood ?? BASELINE,
    handleOf: (person) => handles.get(person) ?? null,
    personOfHandle: (handle) => [...handles].find(([, h]) => h === handle)?.[0] ?? null,
    publish: (definition, payload, ..._meta) => {
      published.push({ topic: definition.type, payload: payload as JsonValue });
    },
    heart: () => heart,
  });
  return {
    clock,
    engine,
    self,
    affect,
    config,
    cares,
    longing,
    handles,
    published,
    advance(ms) {
      clock.at += ms;
    },
  };
}

export const ev = (
  kind: Parameters<AffectService["applyEvent"]>[0]["kind"],
  at: number,
  extra: Partial<Parameters<AffectService["applyEvent"]>[0]> = {},
): Parameters<AffectService["applyEvent"]>[0] => ({
  kind,
  person: null,
  handle: null,
  context: null,
  detail: "",
  key: kind,
  at: toTimestamp(at),
  ...extra,
});

export const level = (r: Rig, name: string): number =>
  r.self.emotions(0).find((e) => e.name === name)?.intensity ?? 0;

/** A heart that answers 在意 and longing from the maps (the parts `self` reads). */
export function fakeHeart(
  cares: Map<PersonId, number>,
  longing: Map<PersonId, number>,
): HeartPeople {
  const cared = () =>
    [...cares]
      .filter(([, c]) => c >= CARES_THRESHOLD)
      .sort((a, b) => b[1] - a[1])
      .map(([person, c]) => ({ person, cares: c }));
  return {
    feel: () => 0,
    seen: () => undefined,
    view: (person) =>
      cares.has(person) || longing.has(person)
        ? ({ person, longing: longing.get(person) ?? 0, blocked: false } as HeartView)
        : null,
    cares: (person) => cares.get(person) ?? 0,
    mostCared: () => cared()[0] ?? null,
    caredAbout: (max) => cared().slice(0, max),
  };
}
