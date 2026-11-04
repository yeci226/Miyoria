import type { AccountRef, ContextKey } from "@miyoria/types";

export interface WatchTarget {
  guild: string;
  channel: string;
  context: ContextKey;
  account: AccountRef;
  name: string;
}

/** Where a stream comes from; the first one is Discord Go Live through the voice link. */
export interface WatchSource {
  start(target: WatchTarget, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  /** One JPEG. */
  snapshot(signal: AbortSignal): Promise<Buffer>;
  /** 16 kHz mono. */
  audio(): AsyncIterable<Int16Array>;
  /** Resolves with the reason the stream ended. */
  ended(): Promise<string>;
}
