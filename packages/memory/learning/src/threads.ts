// Which parts of her conversation notes are still alive. Her notes are free-form JSON, so the
// unit of "a thread" is structural: a top-level scalar, one item of a top-level list or one
// member of a top-level object. Each fold records when every unit was last touched (its content
// appeared or changed); a unit nobody touched for `stale_thread_mins` is stale: turns no longer
// see it (so an old open question does not keep resurfacing) and the next fold is asked to drop
// it if it is over.

import type { JsonObject, JsonValue, Timestamp } from "@miyoria/types";

/** One thread of her notes: where it is (JSON Pointer), its parent's pointer and identity. */
export interface NoteUnit {
  pointer: string;
  /** Pointer of the top-level member it belongs to (itself for a top-level scalar). */
  parent: string;
  /** Path plus a hash of the content: the same text keeps the same id across folds. */
  id: string;
  /** The slot it sits in, without the content: the same key, or the same list. */
  slot: string;
  /** Its content as text (for telling a rewrite from a new thread). */
  text: string;
}

const token = (key: string) => key.replaceAll("~", "~0").replaceAll("/", "~1");

/** FNV-1a, base 36: short and stable, only for telling contents apart. */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

const isObject = (v: JsonValue): v is JsonObject =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const asText = (v: JsonValue): string => (typeof v === "string" ? v : JSON.stringify(v));

export function noteUnits(notes: JsonObject): NoteUnit[] {
  const out: NoteUnit[] = [];
  for (const [key, value] of Object.entries(notes)) {
    const parent = `/${token(key)}`;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        out.push({
          pointer: `${parent}/${i}`,
          parent,
          id: `${key}[]${hash(JSON.stringify(item))}`,
          slot: `${key}[]`,
          text: asText(item),
        });
      });
    } else if (isObject(value)) {
      for (const [child, v] of Object.entries(value)) {
        out.push({
          pointer: `${parent}/${token(child)}`,
          parent,
          id: `${key}/${child}=${hash(JSON.stringify(v))}`,
          slot: `${key}/${child}`,
          text: asText(v),
        });
      }
    } else {
      out.push({
        pointer: parent,
        parent,
        id: `${key}=${hash(JSON.stringify(value))}`,
        slot: key,
        text: asText(value),
      });
    }
  }
  return out;
}

/** Character bigrams of `text` without spaces and punctuation. */
function bigrams(text: string): Map<string, number> {
  const chars = [...text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "")];
  const out = new Map<string, number>();
  if (chars.length < 2) {
    if (chars.length === 1) out.set(chars[0] as string, 1);
    return out;
  }
  for (let i = 0; i + 1 < chars.length; i++) {
    const g = `${chars[i]}${chars[i + 1]}`;
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
}

/** Dice coefficient of the character bigrams of two texts, 0..1. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const x = bigrams(a);
  const y = bigrams(b);
  let total = 0;
  for (const n of x.values()) total += n;
  for (const n of y.values()) total += n;
  if (total === 0) return 0;
  let shared = 0;
  for (const [g, n] of x) shared += Math.min(n, y.get(g) ?? 0);
  return (2 * shared) / total;
}

/** A rewrite keeping at least this much of a thread's text is the same thread. */
const SAME_THREAD = 0.5;

/**
 * When each unit of `notes` was last touched. Unchanged units keep their time. A unit the fold
 * only reworded (the same slot or list item, mostly the same text) keeps the time of what it
 * replaces: she rewrites her notes on every fold, and that must not make an old thread look
 * fresh. Only genuinely new threads get `now`. Old states without a record count their
 * unchanged units as touched at `fallback` (the previous update).
 */
export function touchUnits(
  previous: { notes: JsonObject; touched?: Record<string, Timestamp> | undefined } | null,
  notes: JsonObject,
  now: Timestamp,
  fallback: Timestamp | null,
): Record<string, Timestamp> {
  const before = previous?.touched;
  const old = previous === null ? [] : noteUnits(previous.notes);
  const timeOf = (u: NoteUnit): Timestamp => before?.[u.id] ?? fallback ?? now;
  const byId = new Map(old.map((u) => [u.id, u]));
  const claimed = new Set<string>();
  const units = noteUnits(notes);
  const out: Record<string, Timestamp> = {};
  const pending: NoteUnit[] = [];
  // Unchanged ones first, so a reworded unit cannot take the place of an identical one.
  for (const unit of units) {
    const same = byId.get(unit.id);
    if (same && !claimed.has(same.id)) {
      claimed.add(same.id);
      out[unit.id] = timeOf(same);
    } else if (out[unit.id] === undefined) pending.push(unit);
  }
  for (const unit of pending) {
    let best: NoteUnit | null = null;
    let bestScore = SAME_THREAD;
    for (const candidate of old) {
      if (claimed.has(candidate.id) || candidate.slot !== unit.slot) continue;
      const score = similarity(candidate.text, unit.text);
      if (score >= bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (best) claimed.add(best.id);
    out[unit.id] = best ? timeOf(best) : now;
  }
  return out;
}

export interface Staleness {
  /** Pointers of stale units. */
  stale: Set<string>;
  /** What a prompt hides: stale units, and top-level members with nothing else left. */
  hidden: Set<string>;
}

/** The units of `notes` untouched for `staleMs` (none when `staleMs` is 0). */
export function staleness(
  notes: JsonObject,
  touched: Record<string, Timestamp> | undefined,
  fallback: Timestamp,
  now: number,
  staleMs: number,
): Staleness {
  const stale = new Set<string>();
  const hidden = new Set<string>();
  if (staleMs <= 0) return { stale, hidden };
  const units = noteUnits(notes);
  const live = new Set<string>();
  for (const unit of units) {
    const at = Date.parse(touched?.[unit.id] ?? fallback);
    const old = !Number.isNaN(at) && now - at >= staleMs;
    if (old) {
      stale.add(unit.pointer);
      hidden.add(unit.pointer);
    } else {
      live.add(unit.parent);
    }
  }
  for (const unit of units) if (!live.has(unit.parent)) hidden.add(unit.parent);
  return { stale, hidden };
}

/**
 * `notes` without the units untouched for `dropMs` (none when `dropMs` is 0), and how many
 * went. Threads nobody mentions for hours are over; asking the model to delete them was never
 * reliable.
 */
export function dropStale(
  notes: JsonObject,
  touched: Record<string, Timestamp> | undefined,
  fallback: Timestamp,
  now: number,
  dropMs: number,
): { notes: JsonObject; dropped: number } {
  if (dropMs <= 0) return { notes, dropped: 0 };
  const dead = new Set<string>();
  for (const unit of noteUnits(notes)) {
    const at = Date.parse(touched?.[unit.id] ?? fallback);
    if (!Number.isNaN(at) && now - at >= dropMs) dead.add(unit.pointer);
  }
  if (dead.size === 0) return { notes, dropped: 0 };
  const out: JsonObject = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(notes)) {
    const parent = `/${token(key)}`;
    if (Array.isArray(value)) {
      const kept = value.filter((_, i) => !dead.has(`${parent}/${i}`));
      dropped += value.length - kept.length;
      if (kept.length > 0) out[key] = kept;
    } else if (isObject(value)) {
      const kept = Object.entries(value).filter(
        ([child]) => !dead.has(`${parent}/${token(child)}`),
      );
      dropped += Object.keys(value).length - kept.length;
      if (kept.length > 0) out[key] = Object.fromEntries(kept);
    } else if (dead.has(parent)) {
      dropped += 1;
    } else out[key] = value;
  }
  return { notes: out, dropped };
}
