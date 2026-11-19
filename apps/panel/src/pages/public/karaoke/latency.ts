// The device's latency (docs/design/karaoke.md §6.3): how late the singer's voice reaches the
// pitch track behind the backing they hear, output plus input. Measured once per device with a
// click track (eight beeps; a clap or a 「啦」 on each), kept in this browser only; Core gets the
// number. Until it is measured the browser's own estimate stands in, and rhythm is not scored.

/** Beeps in the click track, and the seconds between them. */
export const BEEPS = 8;
export const BEEP_EVERY = 0.75;
/** Silence before the first beep, to hear the room. */
export const QUIET_S = 1.2;
/** Above this the output is most likely Bluetooth. */
export const BLUETOOTH_MS = 250;
/** What the manual control allows. */
export const LATENCY_MIN = -200;
export const LATENCY_MAX = 800;
/** The browser does not say how late the microphone is; this is a typical wired one. */
export const INPUT_GUESS_MS = 20;

/** One RMS reading: context time and level. */
export interface Level {
  t: number;
  rms: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * The room's level: the lower quartile of the levels heard, never quite zero. A room's noise hardly
 * moves from one 10 ms reading to the next, so any percentile of a silence is about the same; the
 * stretch measured is not always silent, though (the singing screen listens while the song loads,
 * when a room's singer may be talking to her), and the 90th percentile of a stretch with a few
 * words in it was the voice itself: twice that is the voiced gate, so the singing that followed at
 * the same level was dropped as the room. The quartile holds while three readings in four are quiet.
 */
export function noiseFloor(levels: readonly number[]): number {
  if (levels.length === 0) return 0.002;
  const s = [...levels].sort((a, b) => a - b);
  const at = Math.min(s.length - 1, Math.floor(0.25 * (s.length - 1)));
  return Math.max(0.0005, s[at] as number);
}

/**
 * Where the level rises out of the floor: it crosses `ratio` times the floor (12 dB) after having
 * been below half of that, at least `gap` seconds after the last onset.
 */
export function detectOnsets(
  series: readonly Level[],
  floor: number,
  { ratio = 4, gap = 0.25, least = 0.004 }: { ratio?: number; gap?: number; least?: number } = {},
): number[] {
  const high = Math.max(floor * ratio, least);
  const low = high / 2;
  const out: number[] = [];
  let armed = true;
  for (const { t, rms } of series) {
    if (armed && rms >= high && (out.length === 0 || t - (out.at(-1) as number) >= gap)) {
      out.push(t);
      armed = false;
    } else if (!armed && rms < low) {
      armed = true;
    }
  }
  return out;
}

/** Each beep's answer: the first onset from a little before it to `late` seconds after. */
export function matchOnsets(beeps: readonly number[], onsets: readonly number[], late = 0.6): number[] {
  const out: number[] = [];
  for (const b of beeps) {
    const hit = onsets.find((o) => o >= b - 0.1 && o <= b + late);
    if (hit !== undefined) out.push(hit - b);
  }
  return out;
}

export interface Measurement {
  latency_ms: number;
  /** Beeps answered. */
  matched: number;
  /** Half the range of the middle answers: how steady the claps were. */
  spread_ms: number;
}

/** The median delay over the answered beeps; `null` with fewer than half of them answered. */
export function measureLatency(beeps: readonly number[], onsets: readonly number[]): Measurement | null {
  const delays = matchOnsets(beeps, onsets);
  if (delays.length < Math.ceil(beeps.length / 2)) return null;
  const mid = median(delays) as number;
  const sorted = [...delays].sort((a, b) => a - b);
  const q1 = sorted[Math.floor((sorted.length - 1) / 4)] as number;
  const q3 = sorted[Math.ceil(((sorted.length - 1) * 3) / 4)] as number;
  return {
    latency_ms: Math.round(mid * 1000),
    matched: delays.length,
    spread_ms: Math.round(((q3 - q1) / 2) * 1000),
  };
}

/** Whether to suggest wired headphones. */
export function likelyBluetooth(latencyMs: number): boolean {
  return latencyMs > BLUETOOTH_MS;
}

/** The browser's guess before measuring: base plus output latency, and a typical input. */
export function estimateLatency(ctx: { baseLatency?: number; outputLatency?: number }): number {
  const out = (ctx.baseLatency ?? 0) + (ctx.outputLatency ?? 0);
  return Math.round(out * 1000 + INPUT_GUESS_MS);
}

export function clampLatency(ms: number): number {
  return Math.round(Math.min(LATENCY_MAX, Math.max(LATENCY_MIN, ms)));
}

// ---------------------------------------------------------------------------
// kept per device

const PREFIX = "miyoria.karaoke.latency";
/** The key of the device last used, so the song list can say what it has. */
export const LAST_DEVICE = "miyoria.karaoke.device";

/** The microphone (its group, else its id) with the default output. */
export function deviceKey(mic: { deviceId?: string; groupId?: string } | null): string {
  const id = mic?.groupId || mic?.deviceId || "default";
  return `${PREFIX}:${id}|default`;
}

export interface StoredLatency {
  latency_ms: number;
  /** Measured on this device (the manual control keeps it so). */
  measured: boolean;
  /** The room's level when it was measured. */
  floor: number | null;
  at: string;
}

type StorageGetter = () => Pick<Storage, "getItem" | "setItem">;
const local: StorageGetter = () => window.localStorage;

export function loadLatency(key: string, storage: StorageGetter = local): StoredLatency | null {
  try {
    const raw = storage().getItem(key);
    if (raw === null) return null;
    const v = JSON.parse(raw) as Partial<StoredLatency>;
    if (typeof v.latency_ms !== "number" || !Number.isFinite(v.latency_ms)) return null;
    return {
      latency_ms: clampLatency(v.latency_ms),
      measured: v.measured === true,
      floor: typeof v.floor === "number" && v.floor > 0 ? v.floor : null,
      at: typeof v.at === "string" ? v.at : "",
    };
  } catch {
    return null;
  }
}

export function saveLatency(key: string, value: StoredLatency, storage: StorageGetter = local): void {
  try {
    storage().setItem(key, JSON.stringify(value));
    storage().setItem(LAST_DEVICE, key);
  } catch {
    // Not kept: this visit still uses it.
  }
}

export function lastDevice(storage: StorageGetter = local): string | null {
  try {
    return storage().getItem(LAST_DEVICE);
  } catch {
    return null;
  }
}

/** What is sent with a singing: the kept value, else the estimate (not calibrated). */
export function latencyFor(
  stored: StoredLatency | null,
  estimate: number,
): { latency_ms: number; calibrated: boolean } {
  if (stored === null) return { latency_ms: clampLatency(estimate), calibrated: false };
  return { latency_ms: stored.latency_ms, calibrated: stored.measured };
}
