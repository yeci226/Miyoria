// Prometheus metrics of the agent (served by the `api` module at `GET /metrics`).

import { metrics } from "@miyoria/kernel";
import type { CorrectionCounts, CorrectionKind } from "@miyoria/types";

/** `agent_decision`s by outcome (`responded` / `ignored`). */
export const agentTurns = metrics.counter("miyoria_agent_turns_total", {
  help: "Attention decisions of the agent; decision is responded or ignored.",
  labels: ["decision"],
});

/**
 * The after-the-fact corrections of her output (docs/design/v4-patches.md), by kind and by where
 * she was (voice or text). Only that one fired: never what she said.
 */
export const agentCorrections = metrics.counter("miyoria_agent_corrections_total", {
  help: "Corrections of her output after the model wrote it, by kind and channel (voice or text).",
  labels: ["kind", "channel"],
});

/**
 * The corrections of one turn: counted into `agentCorrections` as they fire, and kept for the
 * turn's outcome (`CountedOutcome.corrections`) so the per-day metrics can add them up.
 */
export class CorrectionTally {
  readonly #counts: CorrectionCounts = {};
  readonly #channel: "voice" | "text";

  constructor(voice: boolean) {
    this.#channel = voice ? "voice" : "text";
  }

  count(kind: CorrectionKind, n = 1): void {
    if (n <= 0) return;
    this.#counts[kind] = (this.#counts[kind] ?? 0) + n;
    agentCorrections.inc({ kind, channel: this.#channel }, n);
  }

  /** How often `kind` fired in this turn. */
  of(kind: CorrectionKind): number {
    return this.#counts[kind] ?? 0;
  }

  counts(): CorrectionCounts {
    return { ...this.#counts };
  }
}
