// What Core has measured of each host (docs/design/v5-hostd.md §15.4): per host and capability, how
// long a unit takes there and how fast its results come back, and per capability how large a
// unit's results are. Each is a decayed average (the newest sample weighs `ALPHA`), kept in the
// `cluster_estimates` table so a restart of Core does not forget them.

/** How much the newest sample weighs in a decayed average. */
export const ALPHA = 0.3;

/** The host name of a row that holds a capability's own numbers (a unit's result size). */
export const ANY_HOST = "*";

/** One row of `cluster_estimates`. */
export interface EstimateRow {
  host: string;
  capability: string;
  /** A unit's run time, ms; `null` before the first sample. */
  unit_ms: number | null;
  unit_n: number;
  /** Bytes per second of results coming back; `null` before the first sample. */
  rate_bps: number | null;
  rate_n: number;
  /** A unit's result bytes (the `ANY_HOST` row); `null` before the first sample. */
  size_bytes: number | null;
  size_n: number;
  /** Epoch ms of the last sample. */
  updated_at: number;
}

/** Where the rows are kept; the cluster module gives one over its table, tests a map. */
export interface EstimateStore {
  load(): EstimateRow[];
  save(row: EstimateRow): void;
}

function decay(old: number | null, sample: number): number {
  return old === null ? sample : old + ALPHA * (sample - old);
}

function key(host: string, capability: string): string {
  return `${host}\u0000${capability}`;
}

/** The decayed averages, in memory, written through to a store. */
export class Estimates {
  readonly #rows = new Map<string, EstimateRow>();
  readonly #store: EstimateStore | null;
  readonly #now: () => number;
  readonly #onError: (error: unknown) => void;

  constructor(options: {
    store?: EstimateStore | null;
    now: () => number;
    onError?: (error: unknown) => void;
  }) {
    this.#store = options.store ?? null;
    this.#now = options.now;
    this.#onError = options.onError ?? (() => {});
    try {
      for (const row of this.#store?.load() ?? []) {
        this.#rows.set(key(row.host, row.capability), { ...row });
      }
    } catch (error) {
      this.#onError(error);
    }
  }

  get(host: string, capability: string): EstimateRow | null {
    return this.#rows.get(key(host, capability)) ?? null;
  }

  /** Every row, sorted by host and capability. */
  all(): EstimateRow[] {
    return [...this.#rows.values()].sort(
      (a, b) => a.host.localeCompare(b.host) || a.capability.localeCompare(b.capability),
    );
  }

  unit(host: string, capability: string, ms: number): void {
    if (!(ms > 0) || !Number.isFinite(ms)) return;
    this.#update(host, capability, (row) => {
      row.unit_ms = decay(row.unit_ms, ms);
      row.unit_n += 1;
    });
  }

  rate(host: string, capability: string, bytesPerSecond: number): void {
    if (!(bytesPerSecond > 0) || !Number.isFinite(bytesPerSecond)) return;
    this.#update(host, capability, (row) => {
      row.rate_bps = decay(row.rate_bps, bytesPerSecond);
      row.rate_n += 1;
    });
  }

  size(capability: string, bytes: number): void {
    if (!(bytes > 0) || !Number.isFinite(bytes)) return;
    this.#update(ANY_HOST, capability, (row) => {
      row.size_bytes = decay(row.size_bytes, bytes);
      row.size_n += 1;
    });
  }

  #update(host: string, capability: string, change: (row: EstimateRow) => void): void {
    const k = key(host, capability);
    const row = this.#rows.get(k) ?? {
      host,
      capability,
      unit_ms: null,
      unit_n: 0,
      rate_bps: null,
      rate_n: 0,
      size_bytes: null,
      size_n: 0,
      updated_at: 0,
    };
    change(row);
    row.updated_at = this.#now();
    this.#rows.set(k, row);
    try {
      this.#store?.save({ ...row });
    } catch (error) {
      this.#onError(error);
    }
  }
}

/** A store in memory (tests, and Core without the cluster module's table). */
export function memoryEstimateStore(rows: EstimateRow[] = []): EstimateStore & {
  rows: EstimateRow[];
} {
  const store = {
    rows,
    load: () => rows.map((r) => ({ ...r })),
    save: (row: EstimateRow) => {
      const i = rows.findIndex((r) => r.host === row.host && r.capability === row.capability);
      if (i >= 0) rows[i] = row;
      else rows.push(row);
    },
  };
  return store;
}
