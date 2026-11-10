import { Check, Copy, Radio, Square } from "lucide-react";
import { useState } from "react";
import type { StageLink, StageState } from "@/api/types";
import { useStage, useStageMutations } from "@/app/queries";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { ConfirmDialog } from "@/components/confirm";
import { QueryView, SkeletonRows } from "@/components/query-state";
import { Dot, StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

function LinkBadge({ name, link }: { name: string; link: StageLink }) {
  const badge = <StatusBadge tone={link.connected ? "success" : "neutral"}>{name}</StatusBadge>;
  if (link.connected || !link.error) return badge;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {badge}
        </span>
      </TooltipTrigger>
      <TooltipContent>{link.error}</TooltipContent>
    </Tooltip>
  );
}

/** A labelled block inside the card: label left on wide screens, above on narrow ones. */
function Part({ label, id, children }: { label: string; id: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-labelledby={id} className="grid gap-2.5 sm:grid-cols-[6rem_minmax(0,1fr)] sm:gap-4">
      <h3 id={id} className="pt-1.5 text-[13px] text-muted-foreground">
        {label}
      </h3>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function OverlayRow({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-3">
      <div className="flex min-w-0 items-center gap-1">
        <code className="truncate text-[13px] text-foreground/90">{url}</code>
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={copied ? "已複製" : "複製 overlay 網址"}
          onClick={() =>
            void navigator.clipboard?.writeText(url).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <iframe
        className="aspect-video w-full rounded-md border bg-[repeating-conic-gradient(rgba(255,255,255,0.06)_0_25%,transparent_0_50%)] bg-[length:16px_16px]"
        src={url}
        title="Overlay 預覽"
        sandbox="allow-scripts allow-same-origin"
      />
    </div>
  );
}

function StageBody({ s }: { s: StageState }) {
  const m = useStageMutations();
  const canWrite = useCanWrite();
  const [confirmStream, setConfirmStream] = useState<"start" | "stop" | null>(null);

  const sceneHint = !canWrite ? READ_ONLY_HINT : !s.obs.connected ? (s.obs.error ?? "OBS 未連線") : undefined;
  const exprHint = !canWrite ? READ_ONLY_HINT : !s.vts.connected ? (s.vts.error ?? "VTube Studio 未連線") : undefined;

  return (
    <CardContent className="grid gap-5">
      <Part label="OBS 推流" id="stage-stream">
        <div className="flex flex-wrap items-center gap-3">
          <span className={cn("flex items-center gap-2 text-sm font-medium", !s.streaming && "text-muted-foreground")}>
            <Dot tone={s.streaming ? "brand" : "neutral"} pulse={s.streaming} />
            {s.streaming ? "推流中" : "沒有推流"}
          </span>
          <Button
            writes
            size="sm"
            variant="secondary"
            disabled={!s.obs.connected}
            title={!s.obs.connected ? (s.obs.error ?? "OBS 未連線") : undefined}
            onClick={() => setConfirmStream(s.streaming ? "stop" : "start")}
            className="ml-auto"
          >
            {s.streaming ? <Square /> : <Radio />}
            {s.streaming ? "結束推流" : "開始推流"}
          </Button>
        </div>
      </Part>

      <Part label="場景" id="stage-scenes">
        {s.scenes.length === 0 ? (
          <p className="pt-1.5 text-sm text-muted-foreground">{s.obs.connected ? "OBS 沒有回報場景" : "OBS 未連線"}</p>
        ) : (
          <div role="radiogroup" aria-labelledby="stage-scenes" className="glass-well grid grid-cols-2 gap-0.5 rounded-lg p-0.5 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]">
            {s.scenes.map((name) => {
              const on = s.scene === name;
              const busy = m.scene.isPending && m.scene.variables === name;
              return (
                <button
                  key={name}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  disabled={!canWrite || !s.obs.connected || m.scene.isPending}
                  title={sceneHint}
                  onClick={() =>
                    !on &&
                    m.scene.mutate(name, {
                      onSuccess: () => notify.ok(`已切到「${name}」`),
                      onError: (e) => notify.error(e, "切換場景失敗"),
                    })
                  }
                  className={cn(
                    "group flex h-10 min-w-0 items-center gap-2 rounded-md px-3 text-left text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
                    on
                      ? "bg-primary text-primary-foreground [text-shadow:none]"
                      : "hover:bg-hover disabled:hover:bg-transparent",
                    busy && "animate-pulse",
                  )}
                >
                  <span className="truncate">{name}</span>
                </button>
              );
            })}
          </div>
        )}
      </Part>

      <Part label="表情" id="stage-expr">
        {s.expressions.length === 0 ? (
          <p className="pt-1.5 text-sm text-muted-foreground">{s.vts.connected ? "VTube Studio 沒有熱鍵" : "VTube Studio 未連線"}</p>
        ) : (
          <div className="flex flex-wrap gap-1.5" title={exprHint}>
            {s.expressions.map((name) => (
              <Button
                key={name}
                writes
                size="sm"
                variant="outline"
                disabled={!s.vts.connected || m.expression.isPending}
                busy={m.expression.isPending && m.expression.variables === name}
                aria-pressed={s.expression === name}
                className={cn("font-normal", s.expression === name && "bg-secondary text-secondary-foreground hover:bg-secondary-hover")}
                onClick={() => m.expression.mutate(name, { onError: (e) => notify.error(e, "觸發表情失敗") })}
              >
                {name}
              </Button>
            ))}
          </div>
        )}
      </Part>

      {s.overlay_url && (
        <Part label="Overlay" id="stage-overlay">
          <OverlayRow url={s.overlay_url} />
        </Part>
      )}

      <ConfirmDialog
        open={confirmStream !== null}
        title={confirmStream === "start" ? "開始 OBS 推流?" : "結束 OBS 推流?"}
        confirmLabel={confirmStream === "start" ? "開始推流" : "結束推流"}
        busy={m.stream.isPending}
        onClose={() => setConfirmStream(null)}
        onConfirm={() =>
          confirmStream &&
          m.stream.mutate(confirmStream, {
            onSuccess: (st) => {
              notify.ok(st.streaming ? "OBS 推流中" : "已結束推流");
              setConfirmStream(null);
            },
            onError: (e) => notify.error(e),
          })
        }
      >
        {confirmStream === "start" ? "OBS 會開始推流。" : "OBS 會停止推流,觀眾會看到直播結束。"}
      </ConfirmDialog>
    </CardContent>
  );
}

export function StageCard() {
  const stage = useStage();
  const s = stage.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>畫面</CardTitle>
        {s && (
          <CardAction>
            <LinkBadge name="VTube Studio" link={s.vts} />
            <LinkBadge name="OBS" link={s.obs} />
          </CardAction>
        )}
      </CardHeader>
      <QueryView query={stage} skeleton={<SkeletonRows count={3} />}>
        {(data) => <StageBody s={data} />}
      </QueryView>
    </Card>
  );
}
