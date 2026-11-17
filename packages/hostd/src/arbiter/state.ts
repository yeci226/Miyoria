// What the arbiter knows besides a reading of the card: who listens (Core's `cluster.context`),
// whether the speech services are loaded (their `/health`), and what was learned about the card.
// Ports of gpu.py `Audience`, `Speech` and the per-card half of `Profile`.

import type { Limits } from "./limits.js";
import { pyRound } from "./num.js";
import { headroom } from "./rules.js";

/** Seconds, as the recorded table counts them. */
export interface Clock {
  now(): number;
}

/** `cluster.context`: who would notice her going quiet, and which songs are needed now. */
export interface AudienceContext {
  in_voice: boolean;
  listeners: number;
  live: boolean;
  urgent: readonly string[];
}

/** Core's last word. Never told, or told longer than the TTL ago, is unknown: it counts as people. */
export class Audience {
  inVoice = false;
  listeners = 0;
  live = false;
  urgent: ReadonlySet<string> = new Set();
  at: number | null = null;

  constructor(private readonly clock: Clock) {}

  update(context: AudienceContext): void {
    this.inVoice = context.in_voice;
    this.listeners = context.listeners;
    this.live = context.live;
    this.urgent = new Set(context.urgent);
    this.at = this.clock.now();
  }

  /** `null` is unknown. A job nobody will be told about (`coreExpected` false) counts as nobody. */
  people(ttlS: number, coreExpected: boolean): boolean | null {
    if (this.at === null) return coreExpected ? null : false;
    if (this.clock.now() - this.at > ttlS) return null;
    return this.live || (this.inVoice && this.listeners > 0);
  }

  /** What `gpu.state` shows. `fresh` compares the age rounded to 0.1 s, as gpu.py does. */
  public(ttlS: number): {
    in_voice: boolean;
    listeners: number;
    live: boolean;
    age_s: number | null;
    fresh: boolean;
  } {
    const age = this.at === null ? null : pyRound(this.clock.now() - this.at, 1);
    return {
      in_voice: this.inVoice,
      listeners: this.listeners,
      live: this.live,
      age_s: age,
      fresh: age !== null && age <= ttlS,
    };
  }
}

/** An evictable service: what is asked of it, at which URLs. */
export interface Tenant {
  name: string;
  /** Base URL, no trailing slash: what errors and lists name it by. */
  url: string;
  offload: string;
  reload: string;
  busy: string;
  health: string;
}

/**
 * The HTTP calls to the speech services. A call that fails throws; a reply is the JSON object
 * the service answered. Timeouts are seconds.
 */
export interface PeerClient {
  offload(
    tenant: Tenant,
    body: { reason: string; max_s: number },
    timeoutS: number,
  ): Promise<Record<string, unknown>>;
  reload(tenant: Tenant, timeoutS: number): Promise<Record<string, unknown>>;
  busy(tenant: Tenant, timeoutS: number): Promise<Record<string, unknown>>;
  health(tenant: Tenant, timeoutS: number): Promise<Record<string, unknown>>;
}

/** Python's truthiness of a JSON value. */
export function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v).length > 0;
  return true;
}

export interface SpeechState {
  loaded: boolean;
  /** What their last offload gave back, as the device measured it. */
  released_mb: number | null;
}

export const SPEECH_READ_EVERY_S = 2.0;
export const SPEECH_READ_TIMEOUT_S = 0.5;

/**
 * Whether the speech services are on the card, from their `/health`, read at most every 2 s.
 * One that does not answer counts as loaded.
 */
export class SpeechReader {
  #read: SpeechState | null = null;
  #at = 0;

  constructor(
    private readonly tenants: readonly Tenant[],
    private readonly peers: PeerClient,
    private readonly clock: Clock,
    readonly everyS = SPEECH_READ_EVERY_S,
    readonly timeoutS = SPEECH_READ_TIMEOUT_S,
  ) {}

  forget(): void {
    this.#read = null;
  }

  async read(): Promise<SpeechState> {
    const now = this.clock.now();
    if (this.#read !== null && now - this.#at < this.everyS) return this.#read;
    let loaded = false;
    let released = 0;
    let known = false;
    for (const t of this.tenants) {
      let h: Record<string, unknown>;
      try {
        h = await this.peers.health(t, this.timeoutS);
      } catch {
        loaded = true;
        continue;
      }
      if (!truthy(h.offloaded)) loaded = true;
      if (typeof h.released_mb === "number") {
        released += Math.trunc(h.released_mb);
        known = true;
      }
    }
    this.#read = { loaded, released_mb: known ? released : null };
    this.#at = now;
    return this.#read;
  }
}

/** Where the learned values of a card are kept between runs. */
export interface ProfileStore {
  load(): unknown;
  save(data: CardProfileData): void;
}

export interface CardRecord {
  headroom_mb?: number;
  freed_mb?: number;
  reload_s?: number;
  spills?: {
    at: string;
    stage: string;
    free_mb: number | null;
    step_s: number | null;
    baseline_s: number | null;
  }[];
}

export interface CardProfileData {
  version: 1;
  devices: Record<string, CardRecord>;
}

export const RELOAD_PRIOR_S = 30.0;
export const SPILL_MARGIN_MB = 256;
export const RECENT_SPILLS = 10;

/**
 * What was learned about one card (gpu.py `Profile`, the per-card half): the headroom a spill
 * taught, what offloading frees, how long a reload takes. A different card starts over. The
 * per-stage half (peaks, step times, rates) stays with the song worker.
 */
export class CardProfile {
  #key = "unknown";
  #data: CardProfileData = { version: 1, devices: {} };

  constructor(
    private readonly store: ProfileStore | null = null,
    private readonly wallClock: () => string = () => new Date().toISOString(),
  ) {
    const raw = store?.load();
    if (isProfile(raw)) this.#data = raw;
  }

  use(name: string, totalMb: number | null): void {
    this.#key = totalMb ? `${name}/${totalMb}` : name;
  }

  get key(): string {
    return this.#key;
  }

  #known(): CardRecord {
    return this.#data.devices[this.#key] ?? {};
  }

  #device(): CardRecord {
    this.#data.devices[this.#key] ??= {};
    return this.#data.devices[this.#key] as CardRecord;
  }

  save(): void {
    this.store?.save(this.#data);
  }

  headroom(totalMb: number | null, limits: Limits): number {
    return headroom(totalMb, limits.headroom_pct, this.#known().headroom_mb ?? null);
  }

  /** The learned headroom itself (`null` until a spill taught one). */
  learnedHeadroom(): number | null {
    return this.#known().headroom_mb ?? null;
  }

  freedMb(): number | null {
    return this.#known().freed_mb ?? null;
  }

  reloadS(): number {
    return this.#known().reload_s ?? RELOAD_PRIOR_S;
  }

  learnedReloadS(): number | null {
    return this.#known().reload_s ?? null;
  }

  noteOffload(freedMb: number | null, reloadS: number | null): void {
    const d = this.#device();
    if (freedMb !== null) d.freed_mb = Math.trunc(freedMb);
    if (reloadS !== null) d.reload_s = pyRound(reloadS, 1);
  }

  /** A spill with `freeMb` free: keep at least that much more, at most a quarter of the card. */
  noteSpill(
    stage: string,
    freeMb: number | null,
    stepS: number | null,
    baselineS: number | null,
    totalMb: number | null,
  ): void {
    const d = this.#device();
    if (freeMb !== null) {
      const top = totalMb ? Math.floor(totalMb / 4) : freeMb + SPILL_MARGIN_MB;
      d.headroom_mb = Math.max(
        Math.trunc(d.headroom_mb ?? 0),
        Math.min(freeMb + SPILL_MARGIN_MB, top),
      );
    }
    const spills = d.spills ?? [];
    d.spills = [
      ...spills.slice(Math.max(0, spills.length - (RECENT_SPILLS - 1))),
      { at: this.wallClock(), stage, free_mb: freeMb, step_s: stepS, baseline_s: baselineS },
    ];
  }

  /** A clean run with less free than the learned headroom: the headroom was too careful. */
  noteHealthy(freeMinMb: number | null): void {
    const d = this.#device();
    if (freeMinMb !== null && d.headroom_mb && freeMinMb < d.headroom_mb)
      d.headroom_mb = Math.trunc(freeMinMb);
  }

  public(): {
    device: string;
    headroom_mb: number | null;
    freed_mb: number | null;
    reload_s: number | null;
    spills: number;
  } {
    const d = this.#known();
    return {
      device: this.#key,
      headroom_mb: d.headroom_mb ?? null,
      freed_mb: d.freed_mb ?? null,
      reload_s: d.reload_s ?? null,
      spills: (d.spills ?? []).length,
    };
  }
}

function isProfile(raw: unknown): raw is CardProfileData {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { version?: unknown }).version === 1 &&
    typeof (raw as { devices?: unknown }).devices === "object" &&
    (raw as { devices?: unknown }).devices !== null
  );
}
