import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { ActivitySnapshot, ActivityTask } from "@/api/types";
import { useActivity, useActivityTasks } from "@/app/queries";
import { EmptyLine, QueryView } from "@/components/query-state";
import { StatusBadge, type Tone } from "@/components/status";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import {
  ACTIVITY_TYPE_LABEL,
  BROADCAST_STATE_LABEL,
  FAILURE_LABEL,
  PHASE_LABEL,
  PHASE_TONE,
  PRESENCE_STATE_LABEL,
  requestLabel,
  RESOURCE_LABEL,
  TASK_STATUS_LABEL,
  TASK_STATUS_TONE,
} from "./labels";

function Since({ at }: { at: string }) {
  return (
    <time dateTime={at} title={fmtDateTime(at)} className="whitespace-nowrap">
      {fmtRelative(at)}
    </time>
  );
}

function Cell({ label, tone, pulse, children, sub }: { label: string; tone: Tone; pulse?: boolean; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="grid min-w-0 gap-1">
        <span>
          <StatusBadge tone={tone} pulse={pulse}>
            {children}
          </StatusBadge>
        </span>
        {sub && <span className="min-w-0 truncate text-[13px] text-muted-foreground">{sub}</span>}
      </dd>
    </div>
  );
}

/** Presence, broadcast, activity and scene: the four things the ActivityManager owns. */
export function BodyState({ snapshot }: { snapshot: ActivitySnapshot }) {
  const { presence, broadcast, activity, override } = snapshot;
  const inVoice = presence.type !== "none";
  const live = broadcast.type === "live";
  const busy = broadcast.type !== "off";
  const idle = activity.type === "idle";
  const failed = !idle && activity.phase === "failed";
  return (
    <dl
      aria-label="她現在的狀態"
      className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2 xl:grid-cols-4"
    >
      <Cell
        label="語音"
        tone={presence.type === "in" ? "success" : inVoice ? "warning" : "neutral"}
        sub={inVoice ? contextShort(presence.channel) : undefined}
      >
        {PRESENCE_STATE_LABEL[presence.type]}
      </Cell>
      <Cell
        label="直播"
        tone={live ? "brand" : busy ? "warning" : "neutral"}
        pulse={live}
        sub={
          busy
            ? `${broadcast.golive ? "Go Live" : "Go Live 未開"} · ${broadcast.obs ? "OBS" : "OBS 未開"}`
            : undefined
        }
      >
        {BROADCAST_STATE_LABEL[broadcast.type]}
      </Cell>
      <Cell
        label="活動"
        tone={idle ? "neutral" : PHASE_TONE[activity.phase]}
        sub={
          idle ? undefined : failed && activity.failure ? (
            `${FAILURE_LABEL[activity.failure.code] ?? activity.failure.code}:${activity.failure.detail}`
          ) : (
            `${PHASE_LABEL[activity.phase]}${activity.target ? ` · ${activity.target}` : ""}`
          )
        }
      >
        {ACTIVITY_TYPE_LABEL[activity.type]}
      </Cell>
      <Cell
        label="場景"
        tone={snapshot.scene ? "brand" : "neutral"}
        sub={override ? `暫時切換到 ${fmtDateTime(override.until)}(${override.by})` : undefined}
      >
        {snapshot.scene ?? "沒有場景"}
      </Cell>
    </dl>
  );
}

function TaskWhat({ task }: { task: ActivityTask }) {
  return (
    <span className="grid gap-0.5">
      <span>{requestLabel(task.request)}</span>
      {task.failure ? (
        <span className="text-[13px] text-primary">
          {FAILURE_LABEL[task.failure.code] ?? task.failure.code}:{task.failure.detail}
        </span>
      ) : (
        task.detail && <span className="text-[13px] text-muted-foreground">{task.detail}</span>
      )}
    </span>
  );
}

export function TasksCard({ tasks }: { tasks: ActivityTask[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>最近的任務</CardTitle>
      </CardHeader>
      {tasks.length === 0 ? (
        <EmptyLine>還沒有任何任務</EmptyLine>
      ) : (
        <Table aria-label="活動任務">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>內容</TableHead>
              <TableHead className="hidden w-16 sm:table-cell">類別</TableHead>
              <TableHead className="hidden w-28 md:table-cell">誰要的</TableHead>
              <TableHead className="w-20">狀態</TableHead>
              <TableHead className="w-24">時間</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tasks.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="min-w-48 whitespace-normal">
                  <TaskWhat task={t} />
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{RESOURCE_LABEL[t.resource]}</TableCell>
                <TableCell className="hidden text-muted-foreground md:table-cell">
                  <span className="grid gap-0.5">
                    <span className="truncate">{t.by}</span>
                    {t.turn && (
                      <Link
                        to="/activity"
                        search={{ tab: "prompts", turn: t.turn }}
                        className="w-fit text-xs underline-offset-4 hover:underline"
                      >
                        那回合的提示詞
                      </Link>
                    )}
                  </span>
                </TableCell>
                <TableCell>
                  <StatusBadge tone={TASK_STATUS_TONE[t.status]} pulse={t.status === "running"}>
                    {TASK_STATUS_LABEL[t.status]}
                  </StatusBadge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  <Since at={t.ended_at ?? t.created_at} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

export function BodyTab() {
  const activity = useActivity();
  const tasks = useActivityTasks();
  return (
    <div className="grid gap-(--stage-gap)">
      <QueryView query={activity}>{(s) => <BodyState snapshot={s} />}</QueryView>
      {tasks.isError && activity.isError ? null : (
        <QueryView query={tasks}>{(list) => <TasksCard tasks={list} />}</QueryView>
      )}
    </div>
  );
}
