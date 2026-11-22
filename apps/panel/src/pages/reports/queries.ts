// The problem reports as the page reads them (`/api/reports`, the route table's `reports` group).
// A refusal is the Core's own sentence (`describeError`).

import { type Query, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReportApproveRequest, ReportCommentRequest } from "@miyoria/contracts/api";
import { isApiError, isNotProvided } from "@/api/http";
import { useApi } from "@/app/connection";

export const REPORTS = ["reports"] as const;

/** A stopped module stays stopped and an older Core has no such route: asking again will not help. */
export const isOff = (e: unknown) => isNotProvided(e) || (isApiError(e) && e.kind === "unavailable");

const poll = (query: Query<any, any, any, any>): number | false => (isOff(query.state.error) ? false : 30_000);

export function useReports() {
  const api = useApi();
  return useQuery({
    queryKey: REPORTS,
    queryFn: ({ signal }) => api.rpc.reports.list(undefined, { signal }),
    refetchInterval: poll,
    retry: (n, e) => !isOff(e) && n < 2,
  });
}

export function useReportMutations() {
  const api = useApi();
  const qc = useQueryClient();
  const refresh = () => void qc.invalidateQueries({ queryKey: REPORTS });
  return {
    approve: useMutation({
      mutationFn: ({ id, ...body }: { id: string } & ReportApproveRequest) => api.rpc.reports.approve({ params: { id }, body }),
      onSettled: refresh,
    }),
    comment: useMutation({
      mutationFn: ({ id, ...body }: { id: string } & ReportCommentRequest) => api.rpc.reports.comment({ params: { id }, body }),
      onSettled: refresh,
    }),
    duplicate: useMutation({
      mutationFn: ({ id, issue }: { id: string; issue: number }) => api.rpc.reports.duplicate({ params: { id }, body: { issue } }),
      onSuccess: refresh,
    }),
    mention: useMutation({
      mutationFn: ({ id, on }: { id: string; on: boolean }) => api.rpc.reports.mention({ params: { id }, body: { on } }),
      onSuccess: refresh,
    }),
    reject: useMutation({
      mutationFn: ({ id, reason }: { id: string; reason: string }) => api.rpc.reports.reject({ params: { id }, body: { reason } }),
      onSuccess: refresh,
    }),
  };
}
