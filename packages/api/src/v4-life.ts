// Her own life (docs/design/v4-plan.md §8), read-only except for cancelling a timer:
//
// * `GET /api/life/today`: what she did today and in the last days (the life log) and what the
//   prompt says of it.
// * `GET /api/life/reminders`: the timers she set, soonest first. `DELETE /api/life/reminders/{key}`
//   cancels one (`key` is its short key or its id); audited, needs a writing account.
// * `GET /api/life/activities`: the §8.1 table, with for each row the capabilities that do it
//   and which of them are registered. A row none of whose capabilities is registered is not
//   suggested to her (she cannot do it), which is the thing to see here.
//
// The module providing these is `mind`; they are looked up per request, so a stopped module is
// a 503 that names it.

import { ActuatorRegistryKey } from "@miyoria/actions";
import {
  type AccountRef,
  type ContextKey,
  type LifeActivityId,
  type LifeEntry,
  LifeLogKey,
  ReminderDeskKey,
  type Timestamp,
} from "@miyoria/types";
import { ApiError } from "./errors.js";
import { json, param, type Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";

const DAY_MS = 86_400_000;
/** "Lately" in the day view. */
export const LATELY_DAYS = 7;
/** Most entries one answer carries per list (the log keeps a few days, this only bounds it). */
const MAX_ENTRIES = 500;

/**
 * The rows of `LIFE_ACTIVITIES` in `@miyoria/mind`, as far as this view needs them. `mind` is not
 * a dependency of the API, so the table is kept here and `test/v4-life.test.ts` fails when the two
 * differ.
 */
export interface ActivityRow {
  id: LifeActivityId;
  label: string;
  does: string;
  leaves: string;
  capabilities: readonly string[];
  people: "any" | "someone" | "group";
  hours: readonly [number, number] | null;
  per_day: number | null;
  share: number;
  /** `false`: other desires cover it; it is only listed and logged. */
  generic: boolean;
}

export const ACTIVITY_ROWS: readonly ActivityRow[] = [
  {
    id: "browse",
    label: "逛網路",
    does: "查有興趣的東西、看新聞、追動畫和遊戲消息",
    leaves: "筆記;之後聊天的話題",
    capabilities: ["web.search", "web.read"],
    people: "any",
    hours: null,
    per_day: null,
    share: 0.3,
    generic: true,
  },
  {
    id: "diary",
    label: "寫日記",
    does: "寫今天的日記,偶爾寫週記",
    leaves: "日記頻道;「今天的她」",
    capabilities: ["diary.write"],
    people: "any",
    hours: [20, 3],
    per_day: 1,
    share: 0.2,
    generic: true,
  },
  {
    id: "code",
    label: "寫程式",
    does: "在沙箱做小專案:伺服器用的小工具、遊戲題庫、自己的腳本",
    leaves: "她自己的 repo;做好會炫耀",
    capabilities: ["workspace.write", "skill.run", "code.run"],
    people: "any",
    hours: [9, 1],
    per_day: null,
    share: 0.3,
    generic: true,
  },
  {
    id: "practice",
    label: "練歌",
    does: "自己選一首歌先準備好",
    leaves: "新歌預告;歌單",
    capabilities: ["sing.request"],
    people: "any",
    hours: [9, 24],
    per_day: 3,
    share: 0.2,
    generic: true,
  },
  {
    id: "game",
    label: "玩遊戲",
    does: "Minecraft,之後的 osu 和其他",
    leaves: "精華片段;遊戲裡的進度",
    capabilities: ["game.start"],
    people: "any",
    hours: null,
    per_day: null,
    share: 0.35,
    generic: true,
  },
  {
    id: "recap",
    label: "整理回憶",
    does: "把精華和好笑的對話整理成週報",
    leaves: "每週一則回顧",
    capabilities: ["notebook.write"],
    people: "any",
    hours: [14, 2],
    per_day: 1,
    share: 0.15,
    generic: true,
  },
  {
    id: "business",
    label: "經營",
    does: "開懸賞、辦募資、進貨小店",
    leaves: "公告",
    capabilities: ["economy.post_bounty", "economy.propose_goal"],
    people: "someone",
    hours: [10, 24],
    per_day: 2,
    share: 0.15,
    generic: true,
  },
  {
    id: "care",
    label: "關心人",
    does: "追問之前的事、生日、取得同意的私訊",
    leaves: "對話",
    capabilities: ["chat.start", "chat.dm"],
    people: "someone",
    hours: [9, 1],
    per_day: null,
    share: 1,
    generic: false,
  },
  {
    id: "event",
    label: "辦活動",
    does: "約時間、公告、主持派對遊戲",
    leaves: "活動",
    capabilities: ["party.start"],
    people: "group",
    hours: [12, 1],
    per_day: 2,
    share: 0.3,
    generic: true,
  },
  {
    id: "sing",
    label: "唱歌",
    does: "唱歌給大家聽",
    leaves: "歌單",
    capabilities: ["sing.play"],
    people: "any",
    hours: null,
    per_day: null,
    share: 1,
    generic: false,
  },
];

export interface LifeEntryView {
  id: string;
  activity: LifeActivityId;
  what: string;
  at: Timestamp;
  minutes: number | null;
  capability: string | null;
}

export interface LifeDayView {
  /** Today's entries (her local day), oldest first. */
  today: LifeEntryView[];
  /** The last `LATELY_DAYS` days, today included, oldest first. */
  lately: LifeEntryView[];
  /** What her prompt says of today / of the last days; `null`: nothing. */
  summary_today: string | null;
  summary_lately: string | null;
}

export interface ReminderView {
  id: string;
  key: string;
  what: string;
  due: Timestamp;
  daily: boolean;
  context: ContextKey | null;
  person: string | null;
  for_account: AccountRef | null;
  fired: number;
  created_at: Timestamp;
}

export interface ActivityView {
  id: LifeActivityId;
  label: string;
  does: string;
  leaves: string;
  people: ActivityRow["people"];
  hours: [number, number] | null;
  per_day: number | null;
  share: number;
  generic: boolean;
  capabilities: { id: string; registered: boolean }[];
  /** The capability she would use: the first registered one; `null`: none is registered. */
  capability: string | null;
  /** At least one of its capabilities is registered. */
  available: boolean;
  /** How many times she did it today, `null` when the life log is not running. */
  done_today: number | null;
}

const entryView = (e: LifeEntry): LifeEntryView => ({
  id: e.id,
  activity: e.activity,
  what: e.what,
  at: e.at,
  minutes: e.minutes,
  capability: e.capability,
});

function life(state: ApiState): Response {
  const log = state.service(LifeLogKey, "mind module (her life log)");
  const since = state.now() - LATELY_DAYS * DAY_MS;
  const view: LifeDayView = {
    today: log.today().slice(-MAX_ENTRIES).map(entryView),
    lately: log.entries(since).slice(-MAX_ENTRIES).map(entryView),
    summary_today: log.summary("today"),
    summary_lately: log.summary("lately"),
  };
  return json(view);
}

function reminders(state: ApiState): Response {
  const desk = state.service(ReminderDeskKey, "mind module (her timers)");
  const list: ReminderView[] = desk.list().map((r) => ({
    id: r.id,
    key: r.key,
    what: r.what,
    due: r.due,
    daily: r.daily,
    context: r.context,
    person: r.person,
    for_account: r.for_account,
    fired: r.fired,
    created_at: r.created_at,
  }));
  return json({ reminders: list });
}

async function cancel(state: ApiState, c: ApiContext): Promise<Response> {
  const key = param(c, "key");
  const desk = state.service(ReminderDeskKey, "mind module (her timers)");
  const known = desk.cancel(key);
  await state.audit(c, "life.reminder.cancel", key, {}, known);
  if (!known) throw ApiError.notFound(`no open timer \`${key}\` (it came due, or was cancelled)`);
  return json({ cancelled: true, key });
}

function activities(state: ApiState): Response {
  const registry = state.service(ActuatorRegistryKey, "actuator registry");
  const log = state.optional(LifeLogKey);
  const done = new Map<LifeActivityId, number>();
  for (const e of log?.today() ?? []) done.set(e.activity, (done.get(e.activity) ?? 0) + 1);
  const rows: ActivityView[] = ACTIVITY_ROWS.map((row) => {
    const capabilities = row.capabilities.map((id) => ({
      id,
      registered: registry.get(id) !== undefined,
    }));
    const first = capabilities.find((c) => c.registered)?.id ?? null;
    return {
      id: row.id,
      label: row.label,
      does: row.does,
      leaves: row.leaves,
      people: row.people,
      hours: row.hours === null ? null : [row.hours[0], row.hours[1]],
      per_day: row.per_day,
      share: row.share,
      generic: row.generic,
      capabilities,
      capability: first,
      available: first !== null,
      done_today: log ? (done.get(row.id) ?? 0) : null,
    };
  });
  return json({ activities: rows });
}

export function lifeRoutes(state: ApiState): Route[] {
  return [
    { method: "GET", path: "/api/life/today", handler: () => life(state) },
    { method: "GET", path: "/api/life/reminders", handler: () => reminders(state) },
    { method: "DELETE", path: "/api/life/reminders/:key", handler: (c) => cancel(state, c) },
    { method: "GET", path: "/api/life/activities", handler: () => activities(state) },
  ];
}
