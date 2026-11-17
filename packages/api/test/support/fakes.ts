// Small stand-ins shared by the API tests: an idle module and a voice sink that records what it
// was asked to say.

import { defineManifest, type Module, type ModuleContext } from "@miyoria/runtime/kernel";
import type { ContextKey, SpeakOutcome, TurnId, VoiceSink } from "@miyoria/types";

/** Idles until stopped. */
export class Idle implements Module {
  readonly manifest;
  constructor(id: string, name = id) {
    this.manifest = defineManifest(id, name);
  }
  async start(ctx: ModuleContext): Promise<void> {
    ctx.spawn("idle", async (signal) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    });
  }
}

export interface Spoken {
  context: ContextKey;
  text: string;
  turn: TurnId | null;
}

/** Records what it was asked to say. */
export class FakeSink implements VoiceSink {
  readonly #spoken: Spoken[] = [];
  readonly #waiters: Array<(s: Spoken) => void> = [];

  async speak(
    context: ContextKey,
    text: string,
    _emotion: string | null,
    turn: TurnId | null,
  ): Promise<SpeakOutcome> {
    const s = { context, text, turn };
    const waiter = this.#waiters.shift();
    if (waiter) waiter(s);
    else this.#spoken.push(s);
    return "completed";
  }

  next(): Promise<Spoken> {
    const s = this.#spoken.shift();
    if (s) return Promise.resolve(s);
    return new Promise((resolve) => this.#waiters.push(resolve));
  }
}
