// What she is doing right now, in one strip, and the emergency stop. Shared by 總覽 and 直播.

import { Link } from "@tanstack/react-router";
import { OctagonPause, Play } from "lucide-react";
import type { ReactNode } from "react";
import type { EmergencyReport, EmergencyStep, MindView } from "@/api/types";
import { useMind, useMindMutations, useQueue, useSongs, useStage, useVoice, useWorld } from "@/app/queries";
import { Dot, type Tone } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { notify } from "@/lib/notify";

export const HER_NAME = "DeepSeek-chan";

export function mindState(m: MindView): { tone: Tone; label: string } {
  if (m.paused) return { tone: "warning", label: "已緊急停止" };
  if (!m.running) return { tone: "neutral", label: "心智迴圈未啟動" };
  if (m.stats?.idle_reason === "budget exhausted") return { tone: "danger", label: "額度用完" };
  if (!m.accepting) return { tone: "neutral", label: "休息中" };
  return { tone: "success", label: "運作中" };
}

/** What she is doing right now, in a word or two: the sidebar and 總覽's opening line. */
export function useHerNow(): { tone: Tone; label: string; detail?: string } {
  const mind = useMind();
  const world = useWorld();
  const stage = useStage();
  const her = world.data?.her;
  const state = mind.data ? mindState(mind.data) : null;
  if (mind.data?.paused) return state ?? { tone: "warning", label: "已緊急停止" };
  if (her?.singing) return { tone: "brand", label: "唱歌中", detail: her.singing };
  if (her?.game) return { tone: "brand", label: "遊戲中", detail: her.game };
  if (stage.data?.speaking) return { tone: "brand", label: "說話中" };
  if (her?.voice) return { tone: "success", label: "在語音", detail: her.voice_name ?? undefined };
  return state ?? { tone: "neutral", label: "—" };
}

const STEP_LABELS: Record<EmergencyStep["step"], string> = {
  pause: "暫停",
  silence: "閉嘴",
  song: "唱歌",
  stream: "直播",
  voice: "語音",
  game: "遊戲",
  resume: "解除",
};

/** How a press went, for the toast: only what did not work is named. */
function reportEmergency(view: MindView): void {
  const failed = view.emergency?.steps.filter((s) => !s.ok) ?? [];
  if (failed.length > 0) {
    const steps = failed.map((s) => `${STEP_LABELS[s.step]}(${s.detail})`).join("、");
    notify.warn(`${view.paused ? "已緊急停止" : "解除時"},但這些沒有成功:${steps}`);
  } else if (view.paused) {
    notify.ok("已緊急停止:她閉嘴了,直播、語音和遊戲都關了");
  } else {
    notify.ok("已解除緊急停止");
  }
}

/** Each step of the last press and how it went. */
function EmergencySteps({ report }: { report: EmergencyReport }) {
  return (
    <ul className="mt-1 space-y-0.5">
      {report.steps.map((s) => (
        <li key={s.step} className="flex items-baseline gap-1.5">
          <Dot tone={s.ok ? "success" : "danger"} className="size-1.5 [&>span]:size-1.5" />
          <span className="shrink-0 font-medium">{STEP_LABELS[s.step]}</span>
          <span className="min-w-0 text-foreground/80">{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * The one button of §16: she shuts up, the stream ends, she leaves voice and the game stops; or the
 * stop is lifted. One click either way; the Core needs `owner.autonomy.approve`. The Core answers
 * step by step, so what did not work is shown and not just "done".
 */
export function EmergencyStop({ className }: { className?: string }) {
  const mind = useMind();
  const { pause } = useMindMutations();
  const paused = mind.data?.paused ?? false;
  const report = mind.data?.emergency ?? null;
  const toggle = () =>
    pause.mutate(!paused, {
      onSuccess: reportEmergency,
      onError: (e) => notify.error(e, paused ? "解除失敗" : "緊急停止失敗"),
    });
  if (mind.isError) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          writes
          variant={paused ? "default" : "stop"}
          busy={pause.isPending}
          disabled={mind.isPending}
          onClick={toggle}
          className={className}
        >
          {paused ? <Play /> : <OctagonPause />}
          {paused ? "解除停止" : "緊急停止"}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {paused
          ? "解除後她會再開口,語音、直播和遊戲不會自動回來"
          : "她立刻閉嘴、不再回話,直播、語音和遊戲都關掉;指令和面板仍可操作"}
        {paused && report !== null && <EmergencySteps report={report} />}
      </TooltipContent>
    </Tooltip>
  );
}

function Cell({ label, tone, pulse, children }: { label: string; tone?: Tone; pulse?: boolean; children: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <dt className="shrink-0 text-foreground/80">{label}</dt>
      <dd className="flex min-w-0 items-center gap-1.5 font-medium">
        {tone && <Dot tone={tone} pulse={pulse} className="size-1.5 [&>span]:size-1.5" />}
        <span className="min-w-0 truncate">{children}</span>
      </dd>
    </div>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => <span className="font-normal text-foreground/80">{children}</span>;

/** Her live state on the picture: mind, voice, stream, scene, song, game, queue. */
export function NowStrip() {
  const mind = useMind();
  const world = useWorld();
  const stage = useStage();
  const voice = useVoice();
  const songs = useSongs();
  const queue = useQueue();

  const w = world.data;
  const s = stage.data;
  const session = voice.data?.sessions[0];
  const playing = songs.data?.songs.find((x) => x.no === songs.data?.playing) ?? null;
  const preparing = songs.data?.songs.filter((x) => x.state === "preparing").length ?? 0;
  const waiting = queue.data?.items.filter((i) => i.state === "pending").length ?? 0;
  const goLive = w?.her.golive === "live";
  const pending = mind.isPending || world.isPending;
  const ms = mind.data ? mindState(mind.data) : null;
  const approvals = mind.data?.pending_approvals ?? 0;
  // The opening line above already says it when she is doing nothing else.
  const said = useHerNow().label === ms?.label && approvals === 0;

  if (pending) {
    return (
      <div className="flex flex-wrap gap-x-5 gap-y-1" aria-busy="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-24" />
        ))}
      </div>
    );
  }

  return (
    <dl aria-label="她現在" className="flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
      {!said && (
        <Cell label="她" tone={ms?.tone ?? "neutral"}>
          {ms?.label ?? <Quiet>—</Quiet>}
          {approvals > 0 && (
            <Link to="/inner" search={{ tab: "thoughts" }} className="ml-2 font-normal text-primary underline-offset-4 hover:underline">
              {approvals} 件待批准
            </Link>
          )}
        </Cell>
      )}
      <Cell label="語音" tone={session ? "brand" : "neutral"}>
        {session ? (
          <>
            {w?.her.voice_name ?? session.label ?? "語音頻道"} <Quiet>· {session.participants.length} 人</Quiet>
          </>
        ) : (
          <Quiet>不在語音</Quiet>
        )}
      </Cell>
      <Cell label="直播" tone={goLive || s?.streaming ? "brand" : "neutral"} pulse={goLive || s?.streaming}>
        {goLive && s?.streaming ? "Go Live + OBS" : goLive ? "Go Live" : s?.streaming ? "OBS 推流中" : <Quiet>沒有開台</Quiet>}
      </Cell>
      <Cell label="場景" tone={s?.obs.connected ? undefined : "neutral"}>
        {s?.obs.connected ? (s.scene ?? <Quiet>—</Quiet>) : <Quiet>OBS 未連線</Quiet>}
      </Cell>
      <Cell label="唱歌" tone={playing ? "brand" : undefined} pulse={Boolean(playing)}>
        {playing ? (
          (playing.title ?? playing.query)
        ) : songs.isError ? (
          <Quiet>—</Quiet>
        ) : (
          <Quiet>{preparing > 0 ? `準備中 ${preparing} 首` : "沒有在唱"}</Quiet>
        )}
      </Cell>
      <Cell label="遊戲" tone={w?.her.game ? "brand" : undefined}>
        {w?.her.game ?? <Quiet>沒有在玩</Quiet>}
      </Cell>
      <Cell label="佇列" tone={queue.data?.paused ? "warning" : undefined}>
        {queue.data ? (
          <>
            {waiting} <Quiet>則等待{queue.data.paused ? " · 已暫停" : ""}</Quiet>
          </>
        ) : (
          <Quiet>—</Quiet>
        )}
      </Cell>
    </dl>
  );
}
