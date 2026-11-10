// Wire types of what V4 added (`packages/api/src/v4-*.ts`). Timestamps are ISO strings.

import type { AccountRef, ContextKey, Timestamp } from "./types";

// --- her life ---------------------------------------------------------------------

export type LifeActivityId = "browse" | "diary" | "code" | "practice" | "game" | "recap" | "business" | "care" | "event" | "sing";

export interface LifeEntry {
  id: string;
  activity: LifeActivityId;
  what: string;
  at: Timestamp;
  /** `null`: a single act (a search, a post). */
  minutes: number | null;
  capability: string | null;
}

/** `GET /api/life/today`. */
export interface LifeDayView {
  today: LifeEntry[];
  /** The last seven days, today included. */
  lately: LifeEntry[];
  summary_today: string | null;
  summary_lately: string | null;
}

export interface ReminderView {
  id: string;
  /** The short key she and the panel use. */
  key: string;
  what: string;
  due: Timestamp;
  daily: boolean;
  context: ContextKey | null;
  person: string | null;
  /** `null`: she set it for herself. */
  for_account: AccountRef | null;
  fired: number;
  created_at: Timestamp;
}

/** `GET /api/life/reminders`. */
export interface RemindersView {
  reminders: ReminderView[];
}

export interface ActivityView {
  id: LifeActivityId;
  label: string;
  does: string;
  leaves: string;
  people: "any" | "someone" | "group";
  hours: [number, number] | null;
  per_day: number | null;
  share: number;
  /** `false`: other desires cover it, it is only listed and logged. */
  generic: boolean;
  capabilities: { id: string; registered: boolean }[];
  capability: string | null;
  available: boolean;
  done_today: number | null;
}

/** `GET /api/life/activities`. */
export interface ActivitiesView {
  activities: ActivityView[];
}

// --- economy 2.0 ----------------------------------------------------------------------

export interface HealthDay {
  day: number;
  date: string;
  issued: number;
  recovered: number;
  ratio: number | null;
}

/** `GET /api/economy2/health`. */
export interface EconomyHealth {
  currency: string;
  /** `false` until a store provides the ledger totals. */
  available: boolean;
  days: HealthDay[];
  week: { issued: number; recovered: number; ratio: number | null };
  warn: string | null;
}

export type CommissionKind = "poem" | "name" | "tool" | "song" | "voice";

export interface CommissionView {
  id: string;
  kind: CommissionKind;
  label: string;
  brief: string;
  price: number;
  status: "open" | "delivered" | "declined" | "expired";
  created_at: string;
  due_at: string;
  result: string | null;
  note: string | null;
}

export interface PredictionView {
  id: string;
  question: string;
  options: { label: string; staked: number; backers: number; multiplier: number | null }[];
  total: number;
  closes_at: string;
  status: "open" | "closed" | "resolved" | "cancelled";
  winner: string | null;
}

export interface RoomItem {
  id: string;
  label: string;
  kind: "furniture" | "outfit" | "background";
  kind_label: string;
  price: number;
  funded: number;
  backers: number;
  placed: boolean;
}

export interface QuestsView {
  currency: string;
  quests: { id: string; label: string; done: boolean }[];
  reward: number;
  bonus: number;
  bonus_done: boolean;
  earned_today: number;
  cap: number;
}

// --- her workspace and skills ----------------------------------------------------------

export interface WorkspaceFile {
  path: string;
  size: number;
}

/** `GET /api/workspace`. */
export interface WorkspaceView {
  files: WorkspaceFile[];
  truncated: boolean;
  usage: { files: number; bytes: number; overflow: boolean };
  limits: { max_bytes: number; max_files: number; max_file_bytes: number };
}

export interface SkillSummary {
  name: string;
  description: string;
}

export interface SkillView extends SkillSummary {
  body: string;
  truncated: boolean;
  files: (WorkspaceFile & { script: "approved" | "unapproved" | null })[];
}

// --- memory -----------------------------------------------------------------------------

export interface NotebookEntry {
  path: string;
  chars: number;
  updated_at: Timestamp;
  about: string | null;
}

export interface NotebookPage extends NotebookEntry {
  body: string;
  created_at: Timestamp;
}

export type JustNowKind = "song" | "game" | "voice" | "stream" | "notice" | "talk" | "asked";

export interface JustNowEntry {
  at: Timestamp;
  kind: JustNowKind;
  place: { kind: "here" | "voice" | "text" | "dm"; label: string; context: ContextKey | null };
  text: string;
  private: boolean;
}

/** `GET /api/recent?context=`. */
export interface RecentView {
  entries: JustNowEntry[];
  /** Lines left out because they came from a DM. */
  private_hidden: number;
}

// --- party games -------------------------------------------------------------------------

export interface PartyPlayerView {
  name: string;
  her: boolean;
  score: number;
  present: boolean;
  active: boolean;
}

export interface PartySessionView {
  id: string;
  game: string;
  title: string;
  context: ContextKey;
  state: "running";
  started_at: Timestamp;
  scored: boolean;
  players: PartyPlayerView[];
}

export interface PartyResultView {
  id: string;
  game: string;
  title: string;
  context: ContextKey;
  /** `done`, `host`, `stop`, `idle`, `empty`, `left`, `away`. */
  reason: string;
  started_at: Timestamp;
  ended_at: Timestamp;
  scored: boolean;
  players: PartyPlayerView[];
}

/** `GET /api/party` (503 when the party module is off). */
export interface PartySnapshot {
  sessions: PartySessionView[];
  recent: PartyResultView[];
}
