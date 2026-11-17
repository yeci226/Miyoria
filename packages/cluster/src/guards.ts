// The guarded states of the cluster (docs/design/v5-hostd.md §4, §5): a voluntary restart on a
// host waits while one is active. Modules add a source each (Core adds `singing` and `live`);
// `cluster.guard` answers with the states that are active now.

import type { HostGuardState } from "@miyoria/contracts/host";

/** Says whether its state is active: the state, or `null` when it is not. */
export type GuardSourceFn = () => HostGuardState | null | Promise<HostGuardState | null>;

export class GuardRegistry {
  readonly #sources = new Set<GuardSourceFn>();

  /** Adds a source. Returns what removes it again. */
  add(source: GuardSourceFn): () => void {
    this.#sources.add(source);
    return () => {
      this.#sources.delete(source);
    };
  }

  get size(): number {
    return this.#sources.size;
  }

  /**
   * The active states, each once, in the order the sources were added. A source that throws is
   * left out; `onError` hears about it.
   */
  async active(onError?: (error: unknown) => void): Promise<HostGuardState[]> {
    const results = await Promise.allSettled([...this.#sources].map(async (source) => source()));
    const states: HostGuardState[] = [];
    for (const result of results) {
      if (result.status === "rejected") {
        onError?.(result.reason);
        continue;
      }
      if (result.value !== null && !states.includes(result.value)) states.push(result.value);
    }
    return states;
  }
}
