// The moderation service: output screening (local rules, then optional providers that can only
// tighten) and the input defence, behind `ModerationService`.

import { createHmac, randomBytes } from "node:crypto";
import {
  type Clock,
  type ContextKey,
  type InputCheck,
  type InputVerdict,
  type InputVerdictRecord,
  MODERATION_CATEGORIES,
  type ModerationBlock,
  type ModerationBlockRecord,
  type ModerationCategory,
  type ModerationProvider,
  type ModerationService,
  type OutputCheck,
  type OutputField,
  type OutputPath,
  type OutputVerdict,
  systemClock,
  type TurnId,
} from "@miyoria/types";
import type { ModerationConfig } from "./config.js";
import { InputGuard } from "./input.js";
import { Forms } from "./normalize.js";
import { type Hit, OutputGuard } from "./output.js";

export interface ModerationOptions {
  config: ModerationConfig;
  clock?: Clock;
  /** Called for every block, with a record that holds no text. */
  onBlock?: (record: ModerationBlockRecord) => void;
  /** Called for every input that was not a plain `pass`. */
  onInput?: (record: InputVerdictRecord) => void;
  /** A provider that failed or timed out (for the log; it holds no text). */
  onProviderFailure?: (provider: string, reason: string) => void;
}

/** Message ids whose verdict is kept: far more than can be in flight on the bus. */
const VERDICTS_REMEMBERED = 2_000;

const VOICE_TAG = /<voice>([\s\S]*?)(?:<\/voice>|$)/giu;

function isCategory(value: unknown): value is ModerationCategory {
  return typeof value === "string" && (MODERATION_CATEGORIES as readonly string[]).includes(value);
}

export class Moderation implements ModerationService {
  readonly filteredLine: string;
  readonly filteredVoiceLine: string;
  readonly #cfg: ModerationConfig;
  readonly #clock: Clock;
  readonly #output: OutputGuard;
  readonly #input: InputGuard;
  readonly #providers = new Set<ModerationProvider>();
  readonly #recent: ModerationBlockRecord[] = [];
  /** Verdicts by message id: a message is judged once, however many places read it. */
  readonly #verdicts = new Map<string, InputVerdict>();
  /** Changes on every start: a fingerprint in a log cannot be looked up later. */
  readonly #key = randomBytes(16);
  readonly #onBlock: ((record: ModerationBlockRecord) => void) | undefined;
  readonly #onProviderFailure: ((provider: string, reason: string) => void) | undefined;

  constructor(options: ModerationOptions) {
    this.#cfg = options.config;
    this.#clock = options.clock ?? systemClock;
    this.filteredLine = options.config.filtered_line;
    this.filteredVoiceLine =
      options.config.filtered_voice_line === ""
        ? options.config.filtered_line
        : options.config.filtered_voice_line;
    this.#onBlock = options.onBlock;
    this.#onProviderFailure = options.onProviderFailure;
    this.#output = new OutputGuard(options.config);
    this.#input = new InputGuard({
      config: options.config.input,
      wouldBlock: (text) => this.#output.check(text),
      now: () => this.#clock.now(),
      ...(options.onInput ? { onVerdict: options.onInput } : {}),
    });
  }

  /** Rules or patterns that could not be compiled (the module logs them). */
  get problems(): readonly string[] {
    return [...this.#output.problems, ...this.#input.problems];
  }

  /** Number of active rules, for the log line at start. */
  get ruleCount(): number {
    return this.#output.rules.length;
  }

  screen(check: OutputCheck): OutputVerdict {
    const blocked: ModerationBlock[] = [];
    const visible = this.#local(check, "visible", check.visible ?? null, blocked);
    const voice = this.#local(check, "voice", check.voice ?? null, blocked);
    return { ok: blocked.length === 0, visible, voice, blocked };
  }

  async screenAsync(check: OutputCheck, signal?: AbortSignal): Promise<OutputVerdict> {
    const local = this.screen(check);
    if (this.#providers.size === 0) return local;
    const blocked = [...local.blocked];
    const settled = new Set(blocked.map((b) => b.field));
    // A provider only sees what the local rules passed (so a secret never leaves the process).
    const jobs: Promise<void>[] = [];
    const providers = [...this.#providers];
    for (const field of ["visible", "voice"] as const) {
      const original = field === "visible" ? check.visible : check.voice;
      if (settled.has(field) || original == null || original.trim() === "") continue;
      for (const provider of providers) {
        jobs.push(
          this.#ask(provider, original, field, check.path, signal).then((hit) => {
            if (hit !== null) blocked.push({ field, ...hit, layer: "provider" });
          }),
        );
      }
    }
    await Promise.all(jobs);
    if (blocked.length === local.blocked.length) return local;

    const verdict: OutputVerdict = {
      ok: false,
      visible: local.visible,
      voice: local.voice,
      blocked,
    };
    for (const block of blocked.slice(local.blocked.length)) {
      const text = (block.field === "visible" ? check.visible : check.voice) ?? "";
      if (block.field === "visible") verdict.visible = this.filteredLine;
      else verdict.voice = this.filteredVoiceLine;
      this.#record(check, block, text);
    }
    return verdict;
  }

  screenReply(
    path: OutputPath,
    raw: string,
    meta: { context?: ContextKey | null; turn?: TurnId | null } = {},
  ): { text: string; verdict: OutputVerdict } {
    const texts: string[] = [];
    const voices: string[] = [];
    let last = 0;
    for (const m of raw.matchAll(VOICE_TAG)) {
      texts.push(raw.slice(last, m.index));
      voices.push(m[1] ?? "");
      last = m.index + m[0].length;
    }
    texts.push(raw.slice(last));
    const ctx = { path, context: meta.context ?? null, turn: meta.turn ?? null };
    const visible = this.screen({ ...ctx, visible: texts.join("") });
    const blocked = [...visible.blocked];
    const outVoices = voices.map((voice) => {
      const v = this.screen({ ...ctx, voice });
      blocked.push(...v.blocked);
      return v.voice ?? voice;
    });
    const hasVisibleBlock = visible.blocked.length > 0;
    let text = "";
    texts.forEach((part, i) => {
      text += hasVisibleBlock ? (i === 0 ? this.filteredLine : "") : part;
      const voice = outVoices[i];
      if (voice !== undefined) text += `<voice>${voice}</voice>`;
    });
    return {
      text,
      verdict: {
        ok: blocked.length === 0,
        visible: visible.visible,
        voice: voices.length === 0 ? null : outVoices.join("\n"),
        blocked,
      },
    };
  }

  inspect(input: InputCheck): InputVerdict {
    const id = input.id ?? null;
    if (id === null) return this.#input.inspect(input);
    const seen = this.#verdicts.get(id);
    if (seen !== undefined) return seen;
    const verdict = this.#input.inspect(input);
    this.#verdicts.set(id, verdict);
    while (this.#verdicts.size > VERDICTS_REMEMBERED) {
      const oldest = this.#verdicts.keys().next().value;
      if (oldest === undefined) break;
      this.#verdicts.delete(oldest);
    }
    return verdict;
  }

  addProvider(provider: ModerationProvider): () => void {
    this.#providers.add(provider);
    return () => {
      this.#providers.delete(provider);
    };
  }

  protect(secret: string): () => void {
    return this.#output.protect(secret);
  }

  recent(limit = this.#cfg.recent_blocks): ModerationBlockRecord[] {
    return this.#recent.slice(-Math.max(limit, 0));
  }

  #local(
    check: OutputCheck,
    field: OutputField,
    text: string | null,
    blocked: ModerationBlock[],
  ): string | null {
    if (text === null) return null;
    const hit = this.#output.check(text);
    if (hit === null) return text;
    const block: ModerationBlock = { field, ...hit, layer: "rules" };
    blocked.push(block);
    this.#record(check, block, text);
    return field === "visible" ? this.filteredLine : this.filteredVoiceLine;
  }

  /** One provider, with a timeout. A failure never loosens anything. */
  async #ask(
    provider: ModerationProvider,
    text: string,
    field: OutputField,
    path: OutputPath,
    signal: AbortSignal | undefined,
  ): Promise<Hit | null> {
    const control = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => control.abort(signal?.reason);
    try {
      signal?.throwIfAborted();
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          control.abort();
          reject(new Error(`timed out after ${this.#cfg.provider_timeout_ms} ms`));
        }, this.#cfg.provider_timeout_ms);
      });
      const call = Promise.resolve().then(() =>
        provider.check({ text, field, path }, control.signal),
      );
      // A provider that answers after the timeout must not surface as an unhandled rejection.
      call.catch(() => undefined);
      const result = await Promise.race([call, timeout]);
      // Only an explicit `flagged: true` counts; anything else cannot loosen the local verdict.
      if (result?.flagged === true) {
        const category = isCategory(result.category) ? result.category : "custom";
        return { category, rule: `${provider.id}:${category}` };
      }
      return null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#onProviderFailure?.(provider.id, reason);
      if (this.#cfg.provider_on_failure === "block") {
        return { category: "custom", rule: `${provider.id}:unavailable` };
      }
      return null;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #record(check: OutputCheck, block: ModerationBlock, text: string): void {
    const norm = new Forms(text).norm;
    const record: ModerationBlockRecord = {
      ...block,
      at: new Date(this.#clock.now()).toISOString(),
      path: check.path,
      chars: [...text].length,
      fingerprint: createHmac("sha256", this.#key)
        .update(norm.replace(/\s+/g, " ").trim())
        .digest("hex")
        .slice(0, 8),
      context: check.context ?? null,
      turn: check.turn ?? null,
    };
    this.#recent.push(record);
    if (this.#recent.length > this.#cfg.recent_blocks) this.#recent.shift();
    this.#onBlock?.(record);
  }
}
