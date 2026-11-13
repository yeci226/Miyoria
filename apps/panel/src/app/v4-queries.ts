// Hooks over the V4 admin routes (`api/v4-endpoints.ts`). Kept apart from `queries.ts` so the two
// files grow independently.

import { type Query, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { isApiError } from "@/api/http";
import type { ContextKey } from "@/api/types";
import { createV4Api } from "@/api/v4-endpoints";
import { useConnection } from "./connection";

export const v4Keys = {
  lifeToday: ["life", "today"] as const,
  reminders: ["life", "reminders"] as const,
  activities: ["life", "activities"] as const,
  economyHealth: ["economy2", "health"] as const,
  commissions: ["economy2", "commissions"] as const,
  predictions: ["economy2", "predictions"] as const,
  room: ["economy2", "room"] as const,
  goals: ["economy", "goals"] as const,
  personQuests: (id: string) => ["people", "quests", id] as const,
  workspace: ["workspace"] as const,
  skills: ["skills"] as const,
  skill: (name: string) => ["skills", name] as const,
  party: ["party"] as const,
  notebook: ["notebook"] as const,
  notebookPage: (path: string) => ["notebook", "page", path] as const,
  recent: (context: ContextKey | null) => ["recent", context] as const,
};

/** Errors that polling cannot fix: the route is missing, the module is off or the token is bad. */
const STOP = new Set(["unauthorized", "not_provided", "not_found", "bad_response", "unavailable"]);

const poll =
  (ms: number) =>
  (query: Query<any, any, any, any>): number | false => {
    const e = query.state.error;
    return isApiError(e) && STOP.has(e.kind) ? false : ms;
  };

export function useV4Api() {
  const { client } = useConnection();
  return useMemo(() => createV4Api(client), [client]);
}

export function useLifeToday() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.lifeToday, queryFn: ({ signal }) => api.lifeToday({ signal }), refetchInterval: poll(30_000), retry: false });
}

export function useReminders() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.reminders, queryFn: ({ signal }) => api.reminders({ signal }), refetchInterval: poll(15_000), retry: false });
}

export function useCancelReminder() {
  const api = useV4Api();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) => api.cancelReminder(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: v4Keys.reminders }),
  });
}

export function useActivities() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.activities, queryFn: ({ signal }) => api.activities({ signal }), refetchInterval: poll(30_000), retry: false });
}

export function useReachedGoals() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.goals, queryFn: ({ signal }) => api.reachedGoals({ signal }), refetchInterval: poll(60_000), retry: false });
}

export function useFulfillGoal() {
  const api = useV4Api();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.fulfillGoal(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: v4Keys.goals }),
  });
}

export function useEconomyHealth() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.economyHealth, queryFn: ({ signal }) => api.economyHealth({ signal }), refetchInterval: poll(60_000), retry: false });
}

export function useCommissions() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.commissions, queryFn: ({ signal }) => api.commissions({ signal }), refetchInterval: poll(30_000), retry: false });
}

export function usePredictions() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.predictions, queryFn: ({ signal }) => api.predictions({ signal }), refetchInterval: poll(30_000), retry: false });
}

export function useRoom() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.room, queryFn: ({ signal }) => api.room({ signal }), refetchInterval: poll(60_000), retry: false });
}

export function usePersonQuests(id: string) {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.personQuests(id), queryFn: ({ signal }) => api.personQuests(id, { signal }), retry: false });
}

export function useWorkspace() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.workspace, queryFn: ({ signal }) => api.workspace({ signal }), refetchInterval: poll(60_000), retry: false });
}

export function useParty() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.party, queryFn: ({ signal }) => api.party({ signal }), refetchInterval: poll(10_000), retry: false });
}

export function useSkills() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.skills, queryFn: ({ signal }) => api.skills({ signal }), refetchInterval: poll(60_000), retry: false });
}

export function useSkill(name: string | null) {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.skill(name ?? ""), queryFn: ({ signal }) => api.skill(name as string, { signal }), enabled: name !== null, retry: false });
}

export function useNotebook() {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.notebook, queryFn: ({ signal }) => api.notebook({ signal }), refetchInterval: poll(60_000), retry: false });
}

export function useNotebookPage(path: string | null) {
  const api = useV4Api();
  return useQuery({ queryKey: v4Keys.notebookPage(path ?? ""), queryFn: ({ signal }) => api.notebookPage(path as string, { signal }), enabled: path !== null, retry: false });
}

export function useRecent(context: ContextKey | null) {
  const api = useV4Api();
  return useQuery({
    queryKey: v4Keys.recent(context),
    queryFn: ({ signal }) => api.recent(context as ContextKey, { signal }),
    enabled: context !== null,
    refetchInterval: poll(30_000),
    retry: false,
  });
}
