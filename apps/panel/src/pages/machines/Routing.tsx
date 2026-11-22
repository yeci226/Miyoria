import { type FormEvent, useState } from "react";
import type { ApiOutputs } from "@miyoria/contracts/api";
import { type ClusterRoutingControlBody, useClusterMutations } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { EmptyLine } from "@/components/query-state";
import { Dot, type Tone } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { fmtMsAsSeconds, fmtSeconds, loadWords, ROUTING_CLASS, ROUTING_LATENCY, SPEECH_MODE } from "./labels";

// Job dispatch as Core sees it (v5-hostd §15): per host its round trip, weight, drain and routes
// (§16: each way Core reaches it, which one is in use, what was measured); per
// capability its class, its endpoints with their scores or why they take no new work, the last
// decisions and open sessions; and the owner's controls, which Core alone allows or refuses.

export type ClusterRouting = ApiOutputs["cluster"]["routing"];
type CapabilityRouting = ClusterRouting["capabilities"][number];
type EndpointRouting = CapabilityRouting["endpoints"][number];
type HostRouting = ClusterRouting["hosts"][number];
type HostRoute = NonNullable<HostRouting["routes"]>[number];
type PanelControl = ClusterRouting["panel"][number];
type Decision = CapabilityRouting["decisions"][number];

const VIA = { direct: "直連", link: "經連線" } as const;

/** The ways Core reaches a host (v5-hostd §16). */
const ROUTE_KIND: Record<HostRoute["kind"], string> = { tailnet: "Tailnet", direct: "直連", tunnel: "Tunnel", relay: "經控制連線" };
const ROUTE_WORK: Record<HostRoute["in_use"][number], string> = { realtime: "即時", interactive: "一般", bulk: "大檔" };
const ROUTE_STATE: Record<HostRoute["state"], { tone: Tone; words: string }> = {
  up: { tone: "success", words: "通" },
  unknown: { tone: "neutral", words: "還沒量過" },
  down: { tone: "warning", words: "上次失敗,會再試" },
  resting: { tone: "warning", words: "剛剛失敗,先休息一下" },
  invalid: { tone: "warning", words: "不能用" },
};

/** Decisions shown per capability, newest first. */
const DECISIONS_SHOWN = 5;

const endpointKey = (e: { host: string; service: string }) => `${e.host}/${e.service}`;

/** Short form of a variant hash, the way a commit is shown. */
const shortVariant = (v: string) => v.slice(0, 8);

/** Where her voice is, as the speech-host rule sees it. */
export function activityWords(a: ClusterRouting["activity"]): string {
  const words: string[] = [];
  if (a.in_voice) words.push("在語音");
  if (a.live) words.push("直播中");
  if (words.length === 0) words.push(a.idle ? "閒置" : "剛說過話");
  return words.join(" · ");
}

/** The one a new unit (or session) would go to now, by the same rule Core uses. */
function chosenOf(cap: CapabilityRouting): string | null {
  if (cap.class === "single" && cap.conflict) return cap.conflict.used;
  const open = cap.endpoints.filter((e) => e.eligible && e.healthy && !e.resting);
  if (cap.class === "job") {
    const scored = open.filter((e) => e.score_s !== null).sort((a, b) => (a.score_s as number) - (b.score_s as number));
    const best = scored[0] ?? open[0];
    return best ? endpointKey(best) : null;
  }
  return open[0] ? endpointKey(open[0]) : null;
}

const findPanel = (panel: PanelControl[], kind: PanelControl["kind"], host: string, capability = "") =>
  panel.find((p) => p.kind === kind && p.host === host && p.capability === capability);

/** Who set a control from the panel, and when. */
function SetBy({ row }: { row: PanelControl }) {
  return (
    <span className="text-xs text-muted-foreground">
      面板 · <span className="font-mono">{row.by}</span> ·{" "}
      <time dateTime={row.at} title={fmtDateTime(row.at)}>
        {fmtRelative(row.at)}
      </time>
    </span>
  );
}

function FromConfig() {
  return <Badge variant="outline">設定檔</Badge>;
}

type Send = (body: ClusterRoutingControlBody, done: string, after?: () => void) => void;

type Confirm = { kind: "pin"; host: string; capability: string } | { kind: "drain"; host: string };

// --- hosts -------------------------------------------------------------------------

function WeightField({ host, weight, row, fromConfig, busy, send }: { host: HostRouting; weight: number; row?: PanelControl; fromConfig: boolean; busy: boolean; send: Send }) {
  const [value, setValue] = useState(String(weight));
  const n = Number(value);
  const valid = value.trim() !== "" && Number.isFinite(n) && n >= 0.1 && n <= 100;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (valid && n !== weight) send({ action: "set", kind: "weight", host: host.host, value: n }, `${host.host} 的權重改成 ${n}`);
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-1.5">
      <span aria-hidden className="text-muted-foreground">
        權重
      </span>
      <Input
        type="number"
        inputMode="decimal"
        min={0.1}
        max={100}
        step={0.1}
        value={value}
        aria-invalid={!valid || undefined}
        aria-label={`${host.host} 的權重`}
        onChange={(e) => setValue(e.target.value)}
        className="h-7 w-[4.5rem] font-mono tabular-nums"
      />
      <Button writes type="submit" size="sm" variant="outline" disabled={!valid || n === weight || busy}>
        套用
      </Button>
      {row && (
        <Button
          writes
          type="button"
          size="sm"
          variant="ghost"
          aria-label={`還原 ${host.host} 的權重`}
          disabled={busy}
          onClick={() => send({ action: "clear", kind: "weight", host: host.host }, `${host.host} 的權重已還原`)}
        >
          還原
        </Button>
      )}
      {row ? <SetBy row={row} /> : fromConfig && <FromConfig />}
    </form>
  );
}

function HostRow({ host, data, busy, send, onConfirm }: { host: HostRouting; data: ClusterRouting; busy: boolean; send: Send; onConfirm: (c: Confirm) => void }) {
  const drainRow = findPanel(data.panel, "drain", host.host);
  const weightRow = findPanel(data.panel, "weight", host.host);
  const drainedByConfig = data.config.drain.includes(host.host);
  return (
    <li data-routing-host={host.host} className="grid gap-x-6 gap-y-1.5 border-b border-line-soft py-3 last:border-0 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <span className="font-mono text-[13px] font-medium">{host.host}</span>
      <div className="grid gap-1.5 text-[13px]">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {host.local === true && <span>這台是 Core</span>}
          {host.rtt_ms !== null && <span className="tabular-nums text-muted-foreground">來回 <span className="font-mono text-foreground">{Math.round(host.rtt_ms)} ms</span></span>}
          <WeightField key={host.weight} host={host} weight={host.weight} row={weightRow} fromConfig={data.config.weights[host.host] !== undefined} busy={busy} send={send} />
          <span className="ml-auto flex flex-wrap items-center gap-1.5">
            {drainRow ? (
              <>
                <SetBy row={drainRow} />
                <Button writes size="sm" variant="outline" aria-label={`恢復 ${host.host}`} disabled={busy} onClick={() => send({ action: "clear", kind: "drain", host: host.host }, `${host.host} 恢復接工作`)}>
                  恢復
                </Button>
              </>
            ) : drainedByConfig ? (
              <FromConfig />
            ) : (
              <Button writes size="sm" variant="outline" aria-label={`清空 ${host.host}`} disabled={busy} onClick={() => onConfirm({ kind: "drain", host: host.host })}>
                清空
              </Button>
            )}
          </span>
        </div>
        {host.drained && <p className="text-xs text-primary">{host.drained}</p>}
        {host.routes && host.routes.length > 0 && <RouteList host={host.host} routes={host.routes} />}
      </div>
    </li>
  );
}

function RouteList({ host, routes }: { host: string; routes: HostRoute[] }) {
  return (
    <ul aria-label={`${host} 的連線路徑`} className="grid gap-1">
      {routes.map((r) => {
        const state = ROUTE_STATE[r.state];
        const measured = [r.rtt_ms !== null ? `${Math.round(r.rtt_ms)} ms` : null, r.mb_s !== null ? `${r.mb_s.toFixed(1)} MB/s` : null, r.max_body_mb !== null ? `每次最多 ${r.max_body_mb} MB` : null].filter(Boolean);
        return (
          <li key={r.name} data-route={r.name} className={cn("grid gap-0.5 text-xs", r.state === "invalid" && "text-muted-foreground")}>
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="inline-flex items-center gap-1.5">
                <Dot tone={state.tone} />
                <span className="font-mono text-[13px] text-foreground">{r.name}</span>
              </span>
              <Badge variant="outline">{ROUTE_KIND[r.kind]}</Badge>
              {r.in_use.length > 0 && <Badge variant="brand">使用中 · {r.in_use.map((w) => ROUTE_WORK[w]).join("、")}</Badge>}
              {measured.length > 0 && <span className="font-mono tabular-nums text-foreground">{measured.join(" · ")}</span>}
              {r.url && <span className="min-w-0 truncate font-mono text-muted-foreground">{r.url}</span>}
            </span>
            <span className="pl-[18px] text-muted-foreground">
              <span className={r.state === "up" || r.state === "unknown" ? undefined : "text-primary"}>{state.words}</span>
              {r.reason && <span> · {r.reason}</span>}
              {r.probed_at && (
                <span>
                  {" "}
                  · 量於{" "}
                  <time dateTime={r.probed_at} title={fmtDateTime(r.probed_at)}>
                    {fmtRelative(r.probed_at)}
                  </time>
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// --- one capability ----------------------------------------------------------------

function ScoreParts({ parts }: { parts: NonNullable<EndpointRouting["parts"]> }) {
  const items = [`等待 ${fmtMsAsSeconds(parts.wait_ms)}`, `執行 ${fmtMsAsSeconds(parts.run_ms)}`, `傳回 ${fmtMsAsSeconds(parts.transfer_ms)}`, `加權 ${parts.weight}`];
  if (parts.penalties.length > 0) items.push(parts.penalty_ms > 0 ? `${parts.penalties.join("、")} +${fmtMsAsSeconds(parts.penalty_ms)}` : parts.penalties.join("、"));
  else if (parts.penalty_ms > 0) items.push(`另加 ${fmtMsAsSeconds(parts.penalty_ms)}`);
  return (
    <span data-testid="score-parts" className="text-xs tabular-nums text-muted-foreground">
      {items.join(" · ")}
    </span>
  );
}

function Estimates({ e }: { e: EndpointRouting["estimate"] }) {
  const parts: string[] = [];
  if (e.unit_s !== null) parts.push(`每個工作約 ${fmtSeconds(e.unit_s)}(${e.units} 次)`);
  if (e.rate_mb_s !== null) parts.push(`傳回 ${e.rate_mb_s.toFixed(1)} MB/s(${e.transfers} 次)`);
  if (parts.length === 0) return null;
  return <span className="text-xs tabular-nums text-muted-foreground">{parts.join(" · ")}</span>;
}

function EndpointRow({
  cap,
  e,
  chosen,
  data,
  busy,
  send,
  onConfirm,
}: {
  cap: CapabilityRouting;
  e: EndpointRouting;
  chosen: boolean;
  data: ClusterRouting;
  busy: boolean;
  send: Send;
  onConfirm: (c: Confirm) => void;
}) {
  const capability = cap.capability;
  const pinRow = data.panel.find((p) => p.kind === "pin" && p.capability === capability);
  const excludeRow = findPanel(data.panel, "exclude", e.host, capability);
  const excludedByConfig = data.config.capabilities[capability]?.exclude.includes(e.host) ?? false;
  const tone: Tone = !e.healthy ? "warning" : e.eligible ? "success" : "neutral";
  const load = e.load ? loadWords(e.load, e.pending) : e.pending > 0 ? `剛送出 ${e.pending}` : null;
  return (
    <li data-endpoint={endpointKey(e)} className={cn("grid gap-1 text-[13px]", !e.eligible && "text-muted-foreground")}>
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <Dot tone={tone} />
          <span className="font-mono text-foreground">
            {e.host} / {e.service}
          </span>
        </span>
        <Badge variant="outline">{VIA[e.via]}</Badge>
        {e.score_s !== null && <span className="font-mono tabular-nums text-foreground">{fmtSeconds(e.score_s)}</span>}
        {chosen && <Badge variant="brand">{cap.class === "job" || cap.class === "session" ? "下一個" : "使用中"}</Badge>}
        <span className="ml-auto flex flex-wrap items-center gap-1">
          {!pinRow && data.config.capabilities[capability]?.pin === e.host ? null : pinRow?.host === e.host ? (
            <Button writes size="sm" variant="ghost" aria-label={`取消釘選 ${e.host} 的 ${capability}`} disabled={busy} onClick={() => send({ action: "clear", kind: "pin", host: e.host, capability }, `${capability} 不再只用 ${e.host}`)}>
              取消釘選
            </Button>
          ) : (
            <Button writes size="sm" variant="ghost" aria-label={`只用 ${e.host} 做 ${capability}`} disabled={busy} onClick={() => onConfirm({ kind: "pin", host: e.host, capability })}>
              只用這台
            </Button>
          )}
          {excludeRow ? (
            <Button writes size="sm" variant="ghost" aria-label={`取消排除 ${e.host} 的 ${capability}`} disabled={busy} onClick={() => send({ action: "clear", kind: "exclude", host: e.host, capability }, `${e.host} 又可以做 ${capability}`)}>
              取消排除
            </Button>
          ) : excludedByConfig ? (
            <span className="inline-flex items-center gap-1.5 text-xs">
              <FromConfig />
              排除
            </span>
          ) : (
            <Button writes size="sm" variant="ghost" aria-label={`排除 ${e.host} 的 ${capability}`} disabled={busy} onClick={() => send({ action: "set", kind: "exclude", host: e.host, capability }, `${e.host} 不再做 ${capability}`)}>
              排除
            </Button>
          )}
        </span>
      </div>
      <div className="grid gap-0.5 pl-[18px]">
        <span className="text-xs">
          {!e.healthy ? (
            <span className="text-primary">不健康</span>
          ) : e.resting ? (
            <span className="text-primary">剛剛失敗,先休息一下</span>
          ) : (
            <span>{e.eligible ? "接新工作" : "不接新工作"}</span>
          )}
          {e.reason && <span className="text-muted-foreground"> · {e.reason}</span>}
        </span>
        {e.parts && <ScoreParts parts={e.parts} />}
        {(load || e.load?.outside) && (
          <span className="text-xs tabular-nums text-muted-foreground">{[load, e.load?.outside].filter(Boolean).join(" · ")}</span>
        )}
        <Estimates e={e.estimate} />
        {excludeRow && <SetBy row={excludeRow} />}
        {e.speech && <span className="text-xs text-primary">她的語音在這台</span>}
      </div>
    </li>
  );
}

function DecisionLine({ d }: { d: Decision }) {
  const scores = d.scores.map((s) => (s.score_s !== null ? `${s.host} ${fmtSeconds(s.score_s)}` : `${s.host} 不接${s.reason ? `(${s.reason})` : ""}`));
  return (
    <li className="text-xs text-muted-foreground">
      <time dateTime={d.at} title={fmtDateTime(d.at)} className="tabular-nums">
        {fmtRelative(d.at)}
      </time>
      {d.what && <span className="text-foreground"> · {d.what}</span>}
      <span>
        {" "}
        → <span className="font-mono text-foreground">{d.host}</span>
      </span>
      {scores.length > 0 && <span className="tabular-nums"> · {scores.join(" / ")}</span>}
    </li>
  );
}

function CapabilityRow({ cap, data, busy, send, onConfirm }: { cap: CapabilityRouting; data: ClusterRouting; busy: boolean; send: Send; onConfirm: (c: Confirm) => void }) {
  const chosen = chosenOf(cap);
  const configured = data.config.capabilities[cap.capability];
  const pinRow = data.panel.find((p) => p.kind === "pin" && p.capability === cap.capability);
  const pinned = pinRow?.host ?? configured?.pin ?? null;
  const otherVariant = cap.variant === null ? [] : cap.endpoints.filter((e) => e.routing?.variant !== undefined && e.routing.variant !== cap.variant);
  const speechMatters = cap.yields_to.length > 0 || cap.endpoints.some((e) => e.speech);
  const anyOpen = cap.endpoints.some((e) => e.eligible);
  return (
    <li data-capability={cap.capability} className="grid gap-x-6 gap-y-1.5 border-b border-line-soft py-3 last:border-0 sm:grid-cols-[8rem_minmax(0,1fr)]">
      <div className="grid content-start gap-0.5">
        <span className="font-mono text-[13px] font-medium">{cap.capability}</span>
        <span className="text-xs text-muted-foreground">
          {cap.class ? [ROUTING_CLASS[cap.class], cap.latency ? ROUTING_LATENCY[cap.latency] : null].filter(Boolean).join(" · ") : "照順序"}
        </span>
      </div>
      <div className="grid min-w-0 gap-2">
        {(cap.variant !== null || speechMatters || pinned !== null) && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {cap.variant !== null && (
              <span>
                版本 <span className="font-mono text-foreground" title={cap.variant}>{shortVariant(cap.variant)}</span>
              </span>
            )}
            {speechMatters && (
              <span>
                她語音所在的電腦 <span className="text-foreground">{SPEECH_MODE[cap.speech_mode]}</span> · 她現在<span className="text-foreground">{activityWords(data.activity)}</span>
              </span>
            )}
            {pinned !== null && (
              <span className="inline-flex flex-wrap items-center gap-1.5">
                <span>
                  只用 <span className="font-mono text-foreground">{pinned}</span>
                </span>
                {pinRow ? <SetBy row={pinRow} /> : <FromConfig />}
              </span>
            )}
          </div>
        )}
        {cap.class === null && <p className="text-xs text-muted-foreground">沒有電腦說明怎麼分派,用第一個健康的</p>}
        {cap.class_conflict && cap.class_conflict.length > 0 && (
          <p className="text-xs text-primary">各台說的分派方式不同({cap.class_conflict.join("、")}),用最嚴的那種</p>
        )}
        {cap.conflict && (
          <p role="alert" className="text-[13px] text-primary">
            只能有一個:用 <span className="font-mono">{cap.conflict.used}</span>,不用 <span className="font-mono">{cap.conflict.others.join("、")}</span>
          </p>
        )}
        {otherVariant.map((e) => (
          <p key={endpointKey(e)} className="text-xs text-primary">
            <span className="font-mono">
              {e.host} / {e.service}
            </span>{" "}
            的版本 <span className="font-mono">{shortVariant(e.routing?.variant ?? "")}</span> 和其他台不同,不會用到
          </p>
        ))}
        {cap.endpoints.length === 0 ? (
          <p role="status" className="text-[13px] text-primary">
            沒有任何服務提供
          </p>
        ) : (
          !anyOpen && (
            <p role="status" className="text-[13px] text-primary">
              沒有能接新工作的服務
            </p>
          )
        )}
        {cap.endpoints.length > 0 && (
          <ol aria-label={`${cap.capability} 的服務`} className="grid gap-2.5">
            {cap.endpoints.map((e) => (
              <EndpointRow key={endpointKey(e)} cap={cap} e={e} chosen={endpointKey(e) === chosen} data={data} busy={busy} send={send} onConfirm={onConfirm} />
            ))}
          </ol>
        )}
        {cap.decisions.length > 0 && (
          <div className="grid gap-1">
            <span className="text-xs font-medium">最近的分派</span>
            <ol aria-label={`${cap.capability} 最近的分派`} className="grid gap-0.5">
              {cap.decisions.slice(0, DECISIONS_SHOWN).map((d) => (
                <DecisionLine key={`${d.at}${endpointKey(d)}${d.what ?? ""}`} d={d} />
              ))}
            </ol>
          </div>
        )}
        {cap.sessions.length > 0 && (
          <div className="grid gap-1">
            <span className="text-xs font-medium">進行中的工作階段</span>
            <ul aria-label={`${cap.capability} 進行中的工作階段`} className="grid gap-0.5">
              {cap.sessions.map((s) => (
                <li key={s.key} className="text-xs text-muted-foreground">
                  <span className="font-mono text-foreground">{s.key}</span> ·{" "}
                  <span className="font-mono">
                    {s.host} / {s.service}
                  </span>{" "}
                  ·{" "}
                  <time dateTime={s.since} title={fmtDateTime(s.since)}>
                    {fmtRelative(s.since)}
                  </time>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </li>
  );
}

// --- the whole view ----------------------------------------------------------------

export function RoutingView({ data }: { data: ClusterRouting }) {
  const { routingControl } = useClusterMutations();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const busy = routingControl.isPending;
  const send: Send = (body, done, after) =>
    routingControl.mutate(body, {
      onSuccess: () => {
        notify.ok(done);
        after?.();
      },
      onError: (e) => notify.error(e, "調整分派失敗"),
    });
  const run = (c: Confirm) =>
    c.kind === "pin"
      ? send({ action: "set", kind: "pin", host: c.host, capability: c.capability }, `${c.capability} 只用 ${c.host}`, () => setConfirm(null))
      : send({ action: "set", kind: "drain", host: c.host }, `已清空 ${c.host}`, () => setConfirm(null));

  return (
    <div className="grid gap-5">
      {data.hosts.length > 0 && (
        <section aria-labelledby="routing-hosts" className="grid gap-1">
          <h3 id="routing-hosts" className="text-[13px] font-semibold">
            每台電腦
          </h3>
          <ul aria-label="每台電腦的分派">
            {data.hosts.map((h) => (
              <HostRow key={h.host} host={h} data={data} busy={busy} send={send} onConfirm={setConfirm} />
            ))}
          </ul>
        </section>
      )}
      <section aria-labelledby="routing-capabilities" className="grid gap-1">
        <h3 id="routing-capabilities" className="text-[13px] font-semibold">
          每個能力
        </h3>
        {data.capabilities.length === 0 ? (
          <EmptyLine>還沒有任何能力</EmptyLine>
        ) : (
          <ul aria-label="誰負責什麼">
            {data.capabilities.map((c) => (
              <CapabilityRow key={c.capability} cap={c} data={data} busy={busy} send={send} onConfirm={setConfirm} />
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === "pin" ? `只用 ${confirm.host} 做 ${confirm.capability}?` : confirm ? `清空 ${confirm.host}?` : ""}
        confirmLabel={confirm?.kind === "pin" ? "只用這台" : "清空"}
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={() => confirm && run(confirm)}
      >
        {confirm?.kind === "pin"
          ? `其他電腦不會再收到 ${confirm.capability} 的新工作,直到取消釘選。`
          : "做完手上的工作,不再接新的,直到恢復。"}
      </ConfirmDialog>
    </div>
  );
}
