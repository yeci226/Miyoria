// One function per admin route of what V4 added (`packages/api/src/v4-*.ts`).

import { type ApiClient, type RequestOptions, seg } from "./http";
import type { ContextKey } from "./types";
import type {
  ActivitiesView,
  CommissionView,
  EconomyHealth,
  LifeDayView,
  NotebookEntry,
  NotebookPage,
  PartySnapshot,
  PredictionView,
  QuestsView,
  RecentView,
  RemindersView,
  RoomItem,
  SkillSummary,
  SkillView,
  WorkspaceView,
} from "./v4-types";

type Opts = Pick<RequestOptions, "signal">;

export function createV4Api(client: ApiClient) {
  return {
    lifeToday: (o?: Opts) => client.get<LifeDayView>("/api/life/today", o),
    reminders: (o?: Opts) => client.get<RemindersView>("/api/life/reminders", o),
    cancelReminder: (key: string) => client.delete<{ cancelled: true; key: string }>(`/api/life/reminders/${seg(key)}`),
    activities: (o?: Opts) => client.get<ActivitiesView>("/api/life/activities", o),

    economyHealth: (o?: Opts) => client.get<EconomyHealth>("/api/economy2/health", o),
    commissions: (o?: Opts) => client.get<{ currency: string; commissions: CommissionView[] }>("/api/economy2/commissions", o),
    predictions: (o?: Opts) => client.get<{ currency: string; predictions: PredictionView[] }>("/api/economy2/predictions", o),
    room: (o?: Opts) => client.get<{ currency: string; room: RoomItem[] }>("/api/economy2/room", o),
    personQuests: (id: string, o?: Opts) => client.get<QuestsView>(`/api/people/${seg(id)}/quests`, o),

    workspace: (o?: Opts) => client.get<WorkspaceView>("/api/workspace", o),
    skills: (o?: Opts) => client.get<{ skills: SkillSummary[] }>("/api/skills", o),
    skill: (name: string, o?: Opts) => client.get<SkillView>(`/api/skills/${seg(name)}`, o),

    party: (o?: Opts) => client.get<PartySnapshot>("/api/party", o),

    notebook: (o?: Opts) => client.get<{ pages: NotebookEntry[] }>("/api/notebook", o),
    notebookPage: (path: string, o?: Opts) => client.get<NotebookPage>("/api/notebook/page", { ...o, query: { path } }),
    recent: (context: ContextKey, o?: Opts) => client.get<RecentView>("/api/recent", { ...o, query: { context: JSON.stringify(context) } }),
  };
}

export type V4Api = ReturnType<typeof createV4Api>;
