// The public side of the panel (docs/design/v3-architecture.md §17.1): what anyone may see, with no
// login, at `/api/public/*`.
//
// * `GET /api/public/status`: what she is doing and today's aggregate numbers.
// * `GET /api/public/songs`: what is playing, what is coming up, what she just sang.
//
// Every response is built field by field in this file: internal objects are never spread into
// one, so a field added to `SongEntry` or `ActivitySnapshot` stays private until someone names it
// here. Nothing identifies anybody: no ids, no channel, no requester, no raw song query.
//
// Building a response only reads memory, and one body serves everyone for `cache_secs`, so traffic
// reaches neither the store nor the voice path. Nothing here publishes anything or writes where
// she can read it: being looked at changes nothing about her.

import { getLogger, type ModuleContext } from "@miyoria/kernel";
import { SingerKey, type SongEntry } from "@miyoria/sing";
import { knownNames, type SettingsStore } from "@miyoria/store";
import {
  ActivityManagerKey,
  type ActivitySnapshot,
  type Envelope,
  isJsonObject,
  type KnownName,
  ModerationKey,
  parseSongCue,
  SONG_TOPIC,
} from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import type { Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";
import type {
  PublicDay,
  PublicSong,
  PublicSongs,
  PublicState,
  PublicStatus,
  PublicToday,
} from "./types.js";

const log = getLogger("api.public");

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Settings key (profile `_global`) of today's numbers, so a restart does not lose them. */
export const PUBLIC_STATS_KEY = "public:today";
const STORE_PROFILE = "_global";

/** How much of a gap between two samples counts: a stopped Core was not live. */
const MAX_SAMPLE_GAP_MS = 2 * MINUTE_MS;
/** Days of numbers the status carries, today included. */
export const PUBLIC_DAYS = 14;
/** Days kept, so the page can grow to a month without a migration. */
const KEPT_DAYS = 31;
/** How often today's numbers are sampled. */
export const STATS_EVERY_MS = MINUTE_MS;
/** Clients tracked at once; beyond this the oldest are forgotten, `rate_total` still holds. */
const MAX_CLIENTS = 10_000;
/** Texts whose moderation verdict is remembered. */
const MAX_VERDICTS = 2_000;
const MAX_TITLE_CHARS = 120;
/** How long the names of everyone are reused: reading them walks the people table. */
const NAMES_TTL_MS = MINUTE_MS;

/** Logins started per client and minute: each one holds a place among the logins in flight. */
const LOGINS_PER_MINUTE = 20;
/** Requests per member and minute. */
const MEMBER_PER_MINUTE = 60;
/** Exports and forgets per member and hour: both walk every memory. */
const HEAVY_PER_HOUR = 6;
/** Card checks per client and minute, on top of the public limit: serials are not for guessing. */
const CARD_CHECKS_PER_MINUTE = 20;

/**
 * `[modules.api.public]`.
 *
 * ```toml
 * [modules.api.public]
 * enabled = true
 * song_requests = true
 * ```
 */
export const PublicConfigSchema = z.object({
  /** The read-only public view and the member view. Off: only the admin login remains. */
  enabled: z.boolean().default(true),
  /** Members may request songs from the page, through the gate like anyone in chat. */
  song_requests: z.boolean().default(true),
  /** How long one built response serves everyone. */
  cache_secs: z.number().min(1).max(300).default(10),
  /** Public requests per client and minute. */
  rate_per_minute: z.number().int().positive().default(60),
  /** Public requests per minute from everyone together. */
  rate_total_per_minute: z.number().int().positive().default(3000),
  /** Where "today" starts, in minutes from UTC. */
  utc_offset_minutes: z.number().int().min(-840).max(840).default(480),
});
export type PublicConfig = z.output<typeof PublicConfigSchema>;

// ---- rate limits ----------------------------------------------------------------------------

/** Fixed-window counters per key, with a bounded number of keys. */
export class RateWindow {
  readonly #hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = MAX_CLIENTS,
  ) {}

  /** Counts one request of `key`; returns how many ms until it may retry, `null` when allowed. */
  hit(key: string, now: number): number | null {
    const entry = this.#hits.get(key);
    if (entry && now - entry.start < this.windowMs) {
      if (entry.count >= this.limit) return this.windowMs - (now - entry.start);
      entry.count += 1;
      return null;
    }
    this.#hits.delete(key);
    if (this.#hits.size >= this.maxKeys) this.#evict(now);
    this.#hits.set(key, { start: now, count: 1 });
    return null;
  }

  #evict(now: number): void {
    for (const [key, entry] of this.#hits) {
      if (now - entry.start >= this.windowMs) this.#hits.delete(key);
    }
    while (this.#hits.size >= this.maxKeys) {
      const oldest = this.#hits.keys().next().value;
      if (oldest === undefined) break;
      this.#hits.delete(oldest);
    }
  }
}

function isLoopbackPeer(peer: string): boolean {
  return peer === "::1" || peer.startsWith("127.") || peer.startsWith("::ffff:127.");
}

/** IPv6 clients hold a whole /64: counting the address alone would give them billions of tries. */
function network(address: string): string {
  if (!address.includes(":") || address.startsWith("::ffff:")) return address;
  return address.split(":").slice(0, 4).join(":");
}

/**
 * Who a public request comes from. Behind the Cloudflare tunnel every request arrives from
 * `cloudflared` on this machine, so the socket says nothing and `CF-Connecting-IP` is the visitor;
 * Cloudflare overwrites that header, so nobody out there can choose it. From any other peer the
 * header is the client's own word and the socket address counts.
 */
export function clientKey(c: ApiContext): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const peer = env?.incoming?.socket?.remoteAddress ?? null;
  if (peer !== null && !isLoopbackPeer(peer)) return network(peer);
  return network(c.req.header("cf-connecting-ip")?.trim() || "local");
}

/** `429` with how long to wait. */
export function tooMany(waitMs: number): Response {
  return new Response(JSON.stringify({ error: "too many requests" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      "retry-after": String(Math.max(Math.ceil(waitMs / 1000), 1)),
    },
  });
}

// ---- today's numbers ------------------------------------------------------------------------

interface DayTotals {
  songs: number;
  live_ms: number;
  voice_ms: number;
}

const hours = (ms: number) => Math.round(ms / (HOUR_MS / 10)) / 10;

function toToday(t: DayTotals): PublicToday {
  return { songs_sung: t.songs, hours_live: hours(t.live_ms), hours_in_voice: hours(t.voice_ms) };
}

/** `YYYY-MM-DD` of a local day number. */
export function dateOf(day: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The local day number of `ms`, `offsetMinutes` from UTC. */
export function localDay(ms: number, offsetMinutes: number): number {
  return Math.floor((ms + offsetMinutes * MINUTE_MS) / DAY_MS);
}

/**
 * How much she sang and was on today. Sampled rather than added up from transitions, so a day
 * boundary or a restart in the middle of a stream needs no bookkeeping; a minute of precision is
 * plenty for a number shown in tenths of an hour.
 */
export class PublicStats {
  #day: number;
  #songs = 0;
  #liveMs = 0;
  #voiceMs = 0;
  #lastSample: number | null = null;
  #dirty = false;
  /** Days before today, by day number. */
  readonly #past = new Map<number, DayTotals>();

  constructor(
    private readonly offsetMinutes: number,
    now: number,
  ) {
    this.#day = this.#dayOf(now);
  }

  #dayOf(now: number): number {
    return localDay(now, this.offsetMinutes);
  }

  #roll(now: number): void {
    const day = this.#dayOf(now);
    if (day === this.#day) return;
    this.#keep(this.#day, { songs: this.#songs, live_ms: this.#liveMs, voice_ms: this.#voiceMs });
    this.#day = day;
    this.#songs = 0;
    this.#liveMs = 0;
    this.#voiceMs = 0;
    this.#dirty = true;
  }

  /** A bus envelope: a song she sang to the end counts. */
  handle(env: Envelope, now: number): void {
    if (env.event.type !== "custom" || env.event.data.topic !== SONG_TOPIC) return;
    const cue = parseSongCue(env.event.data.payload);
    if (cue?.state !== "ended" || cue.outcome !== "finished") return;
    this.#roll(now);
    this.#songs += 1;
    this.#dirty = true;
  }

  /** One sample: what she has been doing since the last one. */
  sample(now: number, on: { live: boolean; inVoice: boolean }): void {
    this.#roll(now);
    const last = this.#lastSample;
    this.#lastSample = now;
    if (last === null) return;
    const elapsed = Math.min(Math.max(now - last, 0), MAX_SAMPLE_GAP_MS);
    if (on.live) this.#liveMs += elapsed;
    if (on.inVoice) this.#voiceMs += elapsed;
    if (elapsed > 0 && (on.live || on.inVoice)) this.#dirty = true;
  }

  /** Remembers a finished day, forgetting what is older than `KEPT_DAYS`. */
  #keep(day: number, totals: DayTotals): void {
    if (totals.songs > 0 || totals.live_ms > 0 || totals.voice_ms > 0) this.#past.set(day, totals);
    for (const d of this.#past.keys()) if (d <= day - KEPT_DAYS) this.#past.delete(d);
  }

  view(now: number): PublicToday {
    this.#roll(now);
    return toToday({ songs: this.#songs, live_ms: this.#liveMs, voice_ms: this.#voiceMs });
  }

  /** The last `count` local days, oldest first, today last; a day without numbers is zeros. */
  days(now: number, count = PUBLIC_DAYS): PublicDay[] {
    const today = this.view(now);
    const out: PublicDay[] = [];
    for (let day = this.#day - count + 1; day < this.#day; day++) {
      const totals = this.#past.get(day) ?? { songs: 0, live_ms: 0, voice_ms: 0 };
      out.push({ date: dateOf(day), ...toToday(totals) });
    }
    out.push({ date: dateOf(this.#day), ...today });
    return out;
  }

  async load(store: SettingsStore | undefined, now: number): Promise<void> {
    if (!store) return;
    try {
      const value = await store.get(STORE_PROFILE, PUBLIC_STATS_KEY);
      if (!isJsonObject(value)) return;
      const count = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
      const totals = (v: Record<string, unknown>): DayTotals => ({
        songs: count(v.songs),
        live_ms: count(v.live_ms),
        voice_ms: count(v.voice_ms),
      });
      const today = this.#dayOf(now);
      for (const past of Array.isArray(value.past) ? value.past : []) {
        if (isJsonObject(past) && Number.isInteger(past.day) && (past.day as number) < today) {
          this.#keep(past.day as number, totals(past));
        }
      }
      if (!Number.isInteger(value.day)) return;
      const day = value.day as number;
      // A day that ended while the Core was down is history now.
      if (day < today) this.#keep(day, totals(value));
      if (day !== today) return;
      const current = totals(value);
      this.#songs = current.songs;
      this.#liveMs = current.live_ms;
      this.#voiceMs = current.voice_ms;
    } catch (error) {
      log.debug({ error: String(error) }, "cannot read today's numbers");
    }
  }

  async save(store: SettingsStore | undefined): Promise<void> {
    if (!store || !this.#dirty) return;
    this.#dirty = false;
    try {
      await store.set(STORE_PROFILE, PUBLIC_STATS_KEY, {
        day: this.#day,
        songs: this.#songs,
        live_ms: this.#liveMs,
        voice_ms: this.#voiceMs,
        past: [...this.#past].map(([day, t]) => ({ day, ...t })),
      });
    } catch (error) {
      log.debug({ error: String(error) }, "cannot store today's numbers");
    }
  }
}

// ---- running state --------------------------------------------------------------------------

/** The limits, the shared cache and today's numbers of a running `api` module. */
export class PublicSide {
  readonly stats: PublicStats;
  readonly #now: () => number;
  readonly #clients: RateWindow;
  readonly #everyone: RateWindow;
  readonly #logins = new RateWindow(LOGINS_PER_MINUTE, MINUTE_MS);
  readonly #members = new RateWindow(MEMBER_PER_MINUTE, MINUTE_MS);
  readonly #heavy = new RateWindow(HEAVY_PER_HOUR, HOUR_MS);
  readonly #cardChecks = new RateWindow(CARD_CHECKS_PER_MINUTE, MINUTE_MS);
  readonly #bodies = new Map<string, { at: number; body: string }>();
  readonly #verdicts = new Map<string, boolean>();
  #names: { at: number; names: KnownName[] | null } | null = null;

  constructor(
    readonly config: PublicConfig,
    now: () => number,
  ) {
    this.#now = now;
    this.stats = new PublicStats(config.utc_offset_minutes, now());
    this.#clients = new RateWindow(config.rate_per_minute, MINUTE_MS);
    this.#everyone = new RateWindow(config.rate_total_per_minute, MINUTE_MS, 1);
  }

  /** How many ms a public request must wait, `null` when it may go ahead. */
  admit(client: string): number | null {
    const now = this.#now();
    return this.#clients.hit(client, now) ?? this.#everyone.hit("all", now);
  }

  admitLogin(client: string): number | null {
    return this.#logins.hit(client, this.#now());
  }

  admitMember(account: string): number | null {
    return this.#members.hit(account, this.#now());
  }

  admitHeavy(account: string): number | null {
    return this.#heavy.hit(account, this.#now());
  }

  /** A card check: the public limit, then the tighter one of card checks. */
  admitCardCheck(client: string): number | null {
    return this.admit(client) ?? this.#cardChecks.hit(client, this.#now());
  }

  /** The body under `key`, built at most once per `cache_secs`. */
  cached(key: string, build: () => unknown): string {
    const now = this.#now();
    const hit = this.#bodies.get(key);
    if (hit && now - hit.at < this.config.cache_secs * 1000) return hit.body;
    try {
      const body = JSON.stringify(build());
      this.#bodies.set(key, { at: now, body });
      return body;
    } catch (error) {
      log.warn({ error: String(error) }, "cannot build a public response");
      if (hit) return hit.body;
      throw ApiError.unavailable("not available right now");
    }
  }

  /**
   * Whether moderation passes `text`. A text is judged once, not once per visitor, so a blocked
   * title does not repeat its block on the bus every time the cache turns over.
   */
  passes(state: ApiState, text: string): boolean {
    const moderation = state.optional(ModerationKey);
    if (!moderation) return false;
    const seen = this.#verdicts.get(text);
    if (seen !== undefined) return seen;
    const ok = moderation.screen({ path: "other", visible: text }).ok;
    if (this.#verdicts.size >= MAX_VERDICTS) this.#verdicts.clear();
    this.#verdicts.set(text, ok);
    return ok;
  }

  /** Every name she knows people by, `null` when they cannot be read. */
  async names(ctx: ModuleContext): Promise<KnownName[] | null> {
    const now = this.#now();
    if (this.#names && now - this.#names.at < NAMES_TTL_MS) return this.#names.names;
    const names = await knownNames(ctx.services);
    this.#names = { at: now, names };
    return names;
  }
}

// ---- responses ------------------------------------------------------------------------------

/** A song's title or artist, cleaned and screened; it comes from YouTube and is untrusted. */
function songText(state: ApiState, text: string | null | undefined): string | null {
  const flat = [...(text ?? "").replace(/\s+/g, " ").trim()].slice(0, MAX_TITLE_CHARS).join("");
  if (flat === "") return null;
  return state.publicSide.passes(state, flat) ? flat : null;
}

function songLine(state: ApiState, e: SongEntry): PublicSong {
  return {
    title: songText(state, e.song?.title),
    artist: songText(state, e.song?.artist),
    duration_s: e.song?.duration_s ?? null,
  };
}

/** A game id from the config; anything else is not shown. */
function gameName(target: string | null): string | null {
  return target !== null && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(target) ? target : null;
}

function isPlaying(activity: ActivitySnapshot["activity"] | undefined): boolean {
  return (
    activity?.type === "game" && (activity.phase === "starting" || activity.phase === "running")
  );
}

/** `GET /api/public/status`. */
export function publicStatus(state: ApiState): PublicStatus {
  const snapshot = state.optional(ActivityManagerKey)?.snapshot();
  const singer = state.optional(SingerKey);
  const activity = snapshot?.activity;
  const playing = isPlaying(activity);
  const live = snapshot?.broadcast.type === "live";
  const inVoice = snapshot?.presence.type === "in";
  let now: PublicState = "idle";
  if (!snapshot && !singer) now = "offline";
  else if (singer?.playing()) now = "singing";
  else if (playing) now = "playing";
  else if (live) now = "live";
  else if (inVoice) now = "in_voice";
  return {
    state: now,
    live,
    in_voice: inVoice,
    game: playing && activity?.type === "game" ? gameName(activity.target) : null,
    today: state.publicSide.stats.view(state.now()),
    days: state.publicSide.stats.days(state.now()),
  };
}

/** How many songs she just sang are listed. */
const RECENT_SONGS = 5;

/** `GET /api/public/songs`. Who asked for a song and what they typed stay out of it. */
export function publicSongs(state: ApiState): PublicSongs {
  const singer = state.optional(SingerKey);
  if (!singer) return { playing: null, upcoming: [], recent: [] };
  const all = singer.list.all();
  const now = singer.playing();
  return {
    playing: now ? songLine(state, now) : null,
    upcoming: all
      .filter((e) => e.state === "preparing" || e.state === "ready")
      .map((e) => ({ ...songLine(state, e), ready: e.state === "ready" })),
    recent: all
      .filter((e) => e.state === "done")
      .slice(-RECENT_SONGS)
      .reverse()
      .map((e) => songLine(state, e)),
  };
}

function serve(state: ApiState, c: ApiContext, key: string, build: () => unknown): Response {
  const side = state.publicSide;
  const wait = side.admit(clientKey(c));
  if (wait !== null) return tooMany(wait);
  return new Response(side.cached(key, build), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": `public, max-age=${Math.ceil(side.config.cache_secs)}`,
      "x-content-type-options": "nosniff",
    },
  });
}

/** The public routes; none when `[modules.api.public] enabled` is off. */
export function publicViewRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    {
      method: "GET",
      path: "/api/public/status",
      public: true,
      handler: (c) => serve(state, c, "status", () => publicStatus(state)),
    },
    {
      method: "GET",
      path: "/api/public/songs",
      public: true,
      handler: (c) => serve(state, c, "songs", () => publicSongs(state)),
    },
  ];
}
