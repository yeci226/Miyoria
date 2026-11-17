// The tools a session has found so far. A turn offers the always-on tools and then these, in
// this order: a name is only ever added at the end and never removed or moved, so the tool list
// of a session keeps its prefix (and the provider's prefix cache keeps hitting).

import { z } from "zod";

/** `LoadedTools` as JSON: session id to its names, in the order they were loaded. */
export const LoadedToolsSchema = z.record(z.string(), z.array(z.string()));
export type LoadedToolsJson = z.output<typeof LoadedToolsSchema>;

export class LoadedTools {
  readonly #sessions = new Map<string, string[]>();

  /** The names loaded in `session`, oldest first. */
  loaded(session: string): readonly string[] {
    return this.#sessions.get(session) ?? [];
  }

  /** Adds `names` at the end of `session`'s list, skipping what it has; returns the new ones. */
  load(session: string, names: readonly string[]): string[] {
    const list = this.#sessions.get(session) ?? [];
    const added: string[] = [];
    for (const name of names) {
      if (list.includes(name)) continue;
      list.push(name);
      added.push(name);
    }
    if (added.length > 0) this.#sessions.set(session, list);
    return added;
  }

  /** Forgets a session that ended; its list is never changed while it lives. */
  end(session: string): void {
    this.#sessions.delete(session);
  }

  toJSON(): LoadedToolsJson {
    return Object.fromEntries([...this.#sessions].map(([session, names]) => [session, [...names]]));
  }

  /** The lists `toJSON` wrote. Throws a `ZodError` for anything else. */
  static parse(value: unknown): LoadedTools {
    const loaded = new LoadedTools();
    for (const [session, names] of Object.entries(LoadedToolsSchema.parse(value))) {
      loaded.load(session, names);
    }
    return loaded;
  }
}
