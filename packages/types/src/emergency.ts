// The emergency stop (docs/design/v3-architecture.md §16): one button makes her shut up, end the
// stream and stop the game. The panel, `POST /api/mind/pause`, `/admin autonomy pause` and the
// `/miyo` button all run the same steps, and each answers how its steps went: a failing step does
// not stop the ones after it, and whoever pressed the button sees which ones did not work.

import type { EmergencyReportData } from "@miyoria/contracts/events";
import { serviceKey } from "./service-key.js";

/** The steps, in the order they run. */
export const EMERGENCY_STEPS = [
  /** The pause flag: the gate closes, every output path is muted. */
  "pause",
  /** Turns in flight, queued lines and the speech playing right now. */
  "silence",
  /** A song playing, and the songs waiting. */
  "song",
  /** The broadcast. */
  "stream",
  /** The voice channel. */
  "voice",
  /** The game. */
  "game",
  /** Lifting the stop. */
  "resume",
] as const;

export type EmergencyStepName = (typeof EMERGENCY_STEPS)[number];

export interface EmergencyStep {
  step: EmergencyStepName;
  ok: boolean;
  /** What happened, for whoever pressed the button. */
  detail: string;
}

/** The report of one stop or resume (contract: `EmergencyReportSchema` in @miyoria/contracts/events). */
export type EmergencyReport = EmergencyReportData;

/** Provided by the agent: what stops her turns. */
export interface TurnSilencer {
  /**
   * Turns in flight end now, what waits for a turn is dropped and nothing she was holding back
   * goes out later. Messages that arrive while she is stopped are only remembered.
   */
  silence(why: string): void;
}

export const TurnSilencerKey = serviceKey<TurnSilencer>("TurnSilencer");
