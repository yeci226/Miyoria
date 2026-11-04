import type { JsonObject, JsonValue } from "@miyoria/types";
import type { VoiceLink } from "@miyoria/voice";
import type { WatchSource, WatchTarget } from "./source.js";
import { SNAPSHOT_TIMEOUT_MS } from "./watcher.js";

/** How long a watch may take to go live. */
export const LIVE_WAIT_MS = 15_000;

const text = (value: JsonValue | undefined): string | null =>
  typeof value === "string" && value !== "" ? value : null;

const noop = (): void => {};

/** A friend's Discord Go Live, through the voice link. One instance is one watch. */
export class DiscordSource implements WatchSource {
  readonly #link: VoiceLink;
  readonly #liveWaitMs: number;
  /** Closes the audio subscription. */
  readonly #stopping = new AbortController();
  readonly #ended: Promise<string>;
  #markEnded: (reason: string) => void = noop;
  #target: WatchTarget | null = null;
  /** The start waiting for `live`. */
  #waiting: { resolve(): void; reject(error: unknown): void } | null = null;
  /** The node has nothing to stop any more. */
  #over = false;

  constructor(link: VoiceLink, liveWaitMs = LIVE_WAIT_MS) {
    this.#link = link;
    this.#liveWaitMs = liveWaitMs;
    this.#ended = new Promise((resolve) => {
      this.#markEnded = resolve;
    });
  }

  async start(target: WatchTarget, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    this.#target = target;
    const live = new Promise<void>((resolve, reject) => {
      this.#waiting = { resolve, reject };
    });
    const onAbort = (): void => this.#waiting?.reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => this.#waiting?.reject(new Error("the stream did not go live in time")),
      this.#liveWaitMs,
    );
    try {
      await Promise.all([this.#link.watchStart(target.guild, target.account.id), live]);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      this.#waiting = null;
    }
  }

  /** The payload of a `voice.watch` event; anything about another stream is ignored. */
  onStatus(data: JsonObject): void {
    const target = this.#target;
    if (
      target === null ||
      data.platform !== target.account.platform ||
      data.guild !== target.guild ||
      data.user_id !== target.account.id
    ) {
      return;
    }
    if (data.state === "live") this.#waiting?.resolve();
    else if (data.state === "failed") this.#end(text(data.error) ?? "the stream failed");
    else if (data.state === "stopped") this.#end(text(data.reason) ?? "the stream stopped");
  }

  #end(reason: string): void {
    this.#over = true;
    this.#waiting?.reject(new Error(reason));
    this.#stopping.abort();
    this.#markEnded(reason);
  }

  async stop(): Promise<void> {
    this.#stopping.abort();
    this.#markEnded("stopped");
    const target = this.#target;
    if (target === null || this.#over) return;
    this.#over = true;
    // No node, nothing to stop: a failed start ends up here too.
    await this.#link.watchStop(target.guild).catch(noop);
  }

  snapshot(signal: AbortSignal): Promise<Buffer> {
    const target = this.#target;
    if (target === null) return Promise.reject(new Error("no stream started"));
    return this.#link.snapshot(target.guild, SNAPSHOT_TIMEOUT_MS, signal);
  }

  audio(): AsyncIterable<Int16Array> {
    return this.#link.subscribeWatchAudio(this.#stopping.signal);
  }

  ended(): Promise<string> {
    return this.#ended;
  }
}
