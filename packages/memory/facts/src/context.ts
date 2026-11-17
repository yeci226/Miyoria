// Working Context (docs/design/v3-architecture.md §5): what she knows right now, one bucket per
// writer, as a projection of the log.
//
// * `replace-self`: state (game, who is in voice, the broadcast). A new state replaces the old
//   one: it neither piles up nor asks for her to speak. This is the root fix of "石鎬講 25 次":
//   game state is something she knows, not something she has to say.
// * `append-self`: events, capped in entries.
//
// A writer only ever touches its own bucket, and when the module behind it leaves the bucket goes
// with it, so she does not think the game is still open. After a restart what was rebuilt from
// the log is marked `restored` until the writer says it again.

import {
  type BucketMode,
  type BucketWrite,
  type ContextBucket,
  type ContextEntry,
  type ContextKey,
  contextKeyEquals,
  isJsonObject,
  type LogEvent,
  type ModuleId,
  type ObservationBody,
  type Projection,
  type WorkingContext,
} from "@miyoria/types";

export interface WorkingContextOptions {
  /** Entries of an `append-self` bucket that does not say otherwise. Default 20. */
  maxEntries?: number;
  /** Characters of one entry. Default 400. */
  maxChars?: number;
}

function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

/** The body of an `observation` event, or `null`. */
export function observationBody(event: LogEvent): ObservationBody | null {
  if (event.kind !== "observation" || !isJsonObject(event.body)) return null;
  if (!isJsonObject(event.body.observation)) return null;
  return event.body as unknown as ObservationBody;
}

export class WorkingContextView implements WorkingContext, Projection {
  readonly #maxEntries: number;
  readonly #maxChars: number;
  readonly #buckets = new Map<string, ContextBucket>();

  constructor(options: WorkingContextOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 20;
    this.#maxChars = options.maxChars ?? 400;
  }

  #write(
    writer: string,
    owner: ModuleId | null,
    mode: BucketMode,
    entry: ContextEntry,
    maxEntries: number,
  ): void {
    const clipped = { ...entry, text: clip(entry.text, this.#maxChars) };
    const old = this.#buckets.get(writer);
    const entries = mode === "append-self" && old ? [...old.entries, clipped] : [clipped];
    this.#buckets.set(writer, {
      writer,
      mode,
      owner,
      entries: entries.slice(-maxEntries),
      updated_at: entry.at,
    });
  }

  /** The bucket holds this entry and nothing else. */
  replaceSelf(writer: string, owner: ModuleId | null, entry: ContextEntry): void {
    this.#write(writer, owner, "replace-self", entry, 1);
  }

  /** One more entry; the oldest falls out past the cap. */
  appendSelf(
    writer: string,
    owner: ModuleId | null,
    entry: ContextEntry,
    maxEntries = this.#maxEntries,
  ): void {
    this.#write(writer, owner, "append-self", entry, Math.max(maxEntries, 1));
  }

  /** The writer is gone. */
  leave(writer: string): void {
    this.#buckets.delete(writer);
  }

  /** The module is gone: so is every bucket it wrote. */
  leaveOwner(owner: ModuleId): void {
    for (const [writer, bucket] of this.#buckets) {
      if (bucket.owner === owner) this.#buckets.delete(writer);
    }
  }

  /** What is in the buckets now is from before this start. */
  markRestored(): void {
    for (const bucket of this.#buckets.values()) {
      bucket.entries = bucket.entries.map((e) => ({ ...e, restored: true }));
    }
  }

  buckets(context?: ContextKey | null): ContextBucket[] {
    const out: ContextBucket[] = [];
    for (const writer of [...this.#buckets.keys()].sort()) {
      const bucket = this.#buckets.get(writer) as ContextBucket;
      const entries =
        context === undefined
          ? bucket.entries
          : bucket.entries.filter(
              (e) =>
                e.context === null || (context !== null && contextKeyEquals(e.context, context)),
            );
      if (entries.length > 0) out.push(structuredClone({ ...bucket, entries }));
    }
    return out;
  }

  bucket(writer: string): ContextBucket | null {
    const bucket = this.#buckets.get(writer);
    return bucket ? structuredClone(bucket) : null;
  }

  apply(event: LogEvent): void {
    const body = observationBody(event);
    if (body === null) return;
    for (const write of body.buckets ?? []) this.#apply(event, body, write);
  }

  #apply(event: LogEvent, body: ObservationBody, write: BucketWrite): void {
    switch (write.op) {
      case "replace-self":
        this.replaceSelf(write.writer, write.owner, this.#entry(event, body, write.untrusted));
        break;
      case "append-self":
        this.appendSelf(
          write.writer,
          write.owner,
          this.#entry(event, body, write.untrusted),
          write.max_entries,
        );
        break;
      case "leave":
        this.leave(write.writer);
        break;
      case "leave-owner":
        this.leaveOwner(write.owner);
        break;
      case "boot":
        this.markRestored();
        break;
    }
  }

  #entry(event: LogEvent, body: ObservationBody, untrusted: boolean): ContextEntry {
    const o = body.observation;
    return {
      event: event.id,
      at: event.at,
      text: o.summary,
      attention_key: o.attention_key,
      revision: o.revision,
      context: o.context,
      from: o.from,
      untrusted,
      restored: false,
    };
  }
}
