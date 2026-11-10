// Builders for the affect tests: an engine, the self service and the affect service on a manual
// clock, without a bus or a store.

import {
  type Attitude,
  type Clock,
  type Handle,
  type Mood,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";
import { AffectService } from "../src/affect.js";
import { type SelfConfig, selfConfig } from "../src/config.js";
import { type TemperamentInput, temperament } from "../src/emotions.js";
import { IDLE, SelfEngine } from "../src/engine.js";
import { FeelingsBook } from "../src/feelings.js";
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
  feelings: FeelingsBook;
  config: SelfConfig;
  /** Attitudes the fake social module answers with (by person). */
  attitudes: Map<PersonId, Partial<Attitude>>;
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
  const feelings = new FeelingsBook(null, "p", config.max_feeling_chars);
  const attitudes = new Map<PersonId, Partial<Attitude>>();
  const handles = new Map<PersonId, Handle>();
  const published: Rig["published"] = [];
  const self: SelfService = new SelfService({
    engine,
    feelings,
    clock,
    config,
    circumstances: () => IDLE,
    mood: () => null,
    attitudeOf: (person) => {
      const a = attitudes.get(person);
      if (!a) return null;
      return {
        person,
        affinity: 0,
        trust: 10,
        familiarity: 0,
        blocked: false,
        label: "陌生人",
        call_name: null,
        ...a,
      };
    },
    changed: () => undefined,
  });
  const affect = new AffectService({
    self,
    baseline: options.mood ?? BASELINE,
    handleOf: (person) => handles.get(person) ?? null,
    personOfHandle: (handle) => [...handles].find(([, h]) => h === handle)?.[0] ?? null,
    publish: (topic, payload) => published.push({ topic, payload }),
  });
  return {
    clock,
    engine,
    self,
    affect,
    feelings,
    config,
    attitudes,
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
