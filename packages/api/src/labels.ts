// Human names of contexts (`"Miyoria / 雜談"`) for the panel, asked of the platform's sink and
// cached: the panel polls `GET /api/voice` every few seconds.

import { getLogger } from "@miyoria/runtime/kernel";
import { type ContextKey, contextKeyString, type PlatformSinks } from "@miyoria/types";

const log = getLogger("api.labels");

/** How long a name is kept. */
export const LABEL_TTL_MS = 10 * 60_000;
/** How long a failed or empty lookup is kept before asking again. */
export const LABEL_MISS_TTL_MS = 60_000;
/** One lookup waits at most this long; the request then answers without a name. */
export const LABEL_TIMEOUT_MS = 1_500;

interface Entry {
  label: string | null;
  until: number;
  pending: Promise<string | null> | null;
}

export class ContextLabels {
  readonly #cache = new Map<string, Entry>();
  readonly #now: () => number;
  readonly #timeoutMs: number;

  constructor(now: () => number, timeoutMs = LABEL_TIMEOUT_MS) {
    this.#now = now;
    this.#timeoutMs = timeoutMs;
  }

  /** The context's name, or `null` (unknown, the platform cannot say, or it took too long). */
  async label(sinks: PlatformSinks | undefined, context: ContextKey): Promise<string | null> {
    const key = contextKeyString(context);
    const now = this.#now();
    const cached = this.#cache.get(key);
    if (cached && cached.until > now) return cached.label;
    const inflight = cached?.pending ?? null;
    if (inflight !== null) return this.#bounded(inflight, cached?.label ?? null);

    const sink = sinks?.get(context.platform);
    if (!sink?.describe) return null;
    const signal = AbortSignal.timeout(this.#timeoutMs * 4);
    const pending = sink
      .describe(context, signal)
      .catch((error: unknown) => {
        log.debug({ context: key, error: String(error) }, "cannot name the context");
        return null;
      })
      .then((label) => {
        const value = label?.trim() ? label.trim() : null;
        this.#cache.set(key, {
          label: value ?? cached?.label ?? null,
          until: this.#now() + (value === null ? LABEL_MISS_TTL_MS : LABEL_TTL_MS),
          pending: null,
        });
        return value ?? cached?.label ?? null;
      });
    this.#cache.set(key, { label: cached?.label ?? null, until: 0, pending });
    return this.#bounded(pending, cached?.label ?? null);
  }

  /** Waits for `pending` at most the timeout; the lookup keeps going and fills the cache. */
  #bounded(pending: Promise<string | null>, fallback: string | null): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), this.#timeoutMs);
      void pending.then((label) => {
        clearTimeout(timer);
        resolve(label);
      });
    });
  }
}
