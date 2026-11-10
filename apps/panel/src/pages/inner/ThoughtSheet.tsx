import { Link } from "@tanstack/react-router";
import { ArrowRight, Brain, ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import type { IntentStatus, Thought, ThoughtEffects, ThoughtInput, ThoughtIntent } from "@/api/types";
import { useLlmCalls, useThought } from "@/app/queries";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Bipolar, Meter, StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { contextShort, fmtDateTime, fmtInt, fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Pairs, TextBlock } from "@/pages/llm/CallSheet";
import { fmtCost, fmtMs, moduleLabel, purposeLabel, STATUS_TONE } from "@/pages/llm/labels";
import { DRIVE_LABEL, INTENT_LABEL, INTENT_TONE, STAGE_LABEL, TRIGGER_LABEL } from "./labels";

const DRIVE_KEYS: Record<string, string> = { ...DRIVE_LABEL, boredom: "無聊" };

function Section({ title, aside, children, className }: { title: string; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3", className)}>
      <h3 className="flex items-baseline justify-between gap-3 border-b pb-1.5 text-[13px] font-semibold">
        {title}
        {aside && <span className="text-xs font-normal text-muted-foreground">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;

/** What she saw: her state, the places, people, agenda and the long texts, folded. */
function InputView({ input }: { input: ThoughtInput }) {
  const s = input.self;
  return (
    <div className="grid gap-5">
      <Pairs
        items={[
          ["她的時間", `${input.time}${input.night ? "(安靜時段)" : ""}`],
          ["沒事做", input.idle ? `連續 ${input.idle.thoughts} 次想了沒行動 · 大約 ${input.idle.minutes} 分鐘` : "剛做過事"],
          ["看到的想法", `最近 ${input.recent} 則`],
        ]}
      />
      {s && (
        <div className="grid gap-2">
          <p className="text-xs text-muted-foreground">當時的狀態</p>
          <dl className="grid grid-cols-[6rem_minmax(0,1fr)_3rem] items-center gap-x-3 gap-y-1.5 text-[13px]">
            {s.mood && (
              <>
                <dt className="text-muted-foreground">心情</dt>
                <dd><Bipolar value={s.mood.valence * 100} label={`心情 ${s.mood.valence.toFixed(2)}`} /></dd>
                <dd className="text-right font-mono text-xs">{s.mood.valence.toFixed(2)}</dd>
                <dt className="text-muted-foreground">興奮</dt>
                <dd><Meter value={s.mood.arousal} label={`興奮 ${s.mood.arousal.toFixed(2)}`} /></dd>
                <dd className="text-right font-mono text-xs">{s.mood.arousal.toFixed(2)}</dd>
                <dt className="text-muted-foreground">精神</dt>
                <dd><Meter value={s.mood.energy} tone="brand" label={`精神 ${s.mood.energy.toFixed(2)}`} /></dd>
                <dd className="text-right font-mono text-xs">{s.mood.energy.toFixed(2)}</dd>
              </>
            )}
            <dt className="text-muted-foreground">無聊</dt>
            <dd><Meter value={s.boredom} label={`無聊 ${s.boredom.toFixed(2)}`} /></dd>
            <dd className="text-right font-mono text-xs">{s.boredom.toFixed(2)}</dd>
            {Object.entries(s.drives).map(([k, v]) => (
              <div key={k} className="contents">
                <dt className="text-muted-foreground">{DRIVE_KEYS[k] ?? k}</dt>
                <dd><Meter value={v} tone="brand" label={`${DRIVE_KEYS[k] ?? k} ${v.toFixed(2)}`} /></dd>
                <dd className="text-right font-mono text-xs">{v.toFixed(2)}</dd>
              </div>
            ))}
            <dt className="text-muted-foreground">主動程度</dt>
            <dd><Meter value={s.initiative} tone="brand" label={`主動程度 ${s.initiative.toFixed(2)}`} /></dd>
            <dd className="text-right font-mono text-xs">{s.initiative.toFixed(2)}</dd>
          </dl>
        </div>
      )}
      {input.world.trim() !== "" && (
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">周遭的狀況</p>
          <TextBlock text={input.world} label="周遭的狀況" fold={900} />
        </div>
      )}
      {input.places.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">地點</p>
          <ul className="divide-y divide-line-soft rounded-md border text-[13px]">
            {input.places.map((p) => (
              <li key={p.ref} className="flex gap-3 px-3 py-1.5">
                <code className="w-8 shrink-0 text-xs text-muted-foreground">{p.ref}</code>
                <span className="min-w-0 flex-1">
                  {p.label}
                  {p.here && <Badge variant="brand" className="ml-2">她在這</Badge>}
                </span>
                <span className="text-muted-foreground">{p.note}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {input.people.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">人</p>
          <ul className="divide-y divide-line-soft rounded-md border text-[13px]">
            {input.people.map((p) => (
              <li key={p.ref} className="grid gap-0.5 px-3 py-1.5">
                <span className="flex gap-3">
                  <code className="w-8 shrink-0 text-xs text-muted-foreground">{p.ref}</code>
                  {p.person ? (
                    <Link to="/character" search={{ tab: "people", person: p.person }} className="font-medium hover:underline">
                      {p.name}
                    </Link>
                  ) : (
                    <span className="font-medium">{p.name}</span>
                  )}
                  <span className="text-muted-foreground">{[p.relation, p.doing].filter(Boolean).join(" · ")}</span>
                </span>
                {p.feeling && <span className="pl-11 text-muted-foreground">她的感覺:{p.feeling}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {input.agenda.length > 0 && (
        <div className="grid gap-1.5">
          <p className="text-xs text-muted-foreground">議程</p>
          <ul className="grid gap-1 text-[13px]">
            {input.agenda.map((a) => (
              <li key={a.ref} className="flex gap-3">
                <code className="w-8 shrink-0 text-xs text-muted-foreground">{a.ref}</code>
                <span className="min-w-0 flex-1">
                  {a.text}
                  {a.due && <span className="text-muted-foreground"> · {fmtDateTime(a.due)} 之後</span>}
                  {a.blocked && <span className="text-primary"> · 暫時做不到:{a.blocked}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {(
        [
          ["記憶", input.memories],
          ["她整理的資料", input.documents],
          ["前情提要", input.recap],
          ["更早的想法(整理)", input.digest],
        ] as const
      ).map(([label, text]) =>
        text ? (
          <div key={label} className="grid gap-1.5">
            <p className="text-xs text-muted-foreground">{label}</p>
            <TextBlock text={text} label={label} fold={500} />
          </div>
        ) : null,
      )}
      {(input.lessons.length > 0 || input.unanswered.length > 0 || input.blocked.length > 0) && (
        <div className="grid gap-3 text-[13px]">
          {input.lessons.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">她學到的事</p>
              <ul className="list-disc space-y-0.5 pl-5">{input.lessons.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </div>
          )}
          {input.unanswered.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">提過但沒人接的話題</p>
              <ul className="list-disc space-y-0.5 pl-5">{input.unanswered.map((l, i) => <li key={i}>{l}</li>)}</ul>
            </div>
          )}
          {input.blocked.length > 0 && (
            <div>
              <p className="mb-1 text-xs text-muted-foreground">暫時做不到的事</p>
              <ul className="space-y-0.5">{input.blocked.map((b) => <li key={b.capability}><code className="text-xs">{b.capability}</code> {b.reason}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      <div className="grid gap-1.5">
        <p className="text-xs text-muted-foreground">可以做的事({input.capabilities.length})</p>
        <div className="flex flex-wrap gap-1">
          {input.capabilities.map((c) => (
            <code key={c} className="rounded border px-1.5 py-0.5 text-[11px] text-muted-foreground">{c}</code>
          ))}
        </div>
      </div>
    </div>
  );
}

const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;

function EffectsView({ e, changes }: { e: ThoughtEffects | null | undefined; changes: string[] }) {
  if (!e) {
    return changes.length > 0 ? <ul className="list-disc space-y-0.5 pl-5 text-sm">{changes.map((c) => <li key={c}>{c}</li>)}</ul> : <Quiet>沒有改變什麼</Quiet>;
  }
  const rows: ReactNode[] = [];
  const drives = Object.entries(e.drives);
  if (drives.length > 0) {
    rows.push(
      <li key="drives" className="grid gap-1.5">
        <span className="text-xs text-muted-foreground">慾望</span>
        <span className="flex flex-wrap gap-1.5">
          {drives.map(([k, v]) => (
            <Badge key={k} variant={v > 0 ? "brand" : "outline"}>
              {DRIVE_KEYS[k] ?? k} {signed(v)}
            </Badge>
          ))}
        </span>
      </li>,
    );
  }
  for (const t of e.talkativeness) {
    rows.push(<li key={`t${t.scope}`}><span className="text-muted-foreground">多話程度</span> <code className="text-xs">{t.scope}</code> → <span className="font-medium tabular-nums">{t.level.toFixed(2)}</span>(<span className="tabular-nums">{t.minutes}</span> 分鐘)<span className="text-muted-foreground"> · {t.why}</span></li>);
  }
  if (e.initiative) rows.push(<li key="init"><span className="text-muted-foreground">主動程度</span> → <span className="font-medium tabular-nums">{e.initiative.level.toFixed(2)}</span><span className="text-muted-foreground"> · {e.initiative.why}</span></li>);
  for (const f of e.feelings) {
    rows.push(
      <li key={`f${f.person}`}>
        <span className="text-muted-foreground">對</span>{" "}
        <Link to="/character" search={{ tab: "people", person: f.person }} className="font-medium hover:underline">{f.name}</Link>
        {f.hint && <Badge variant={f.hint === "+" ? "success" : "destructive"} className="mx-1.5">好感 {f.hint}</Badge>}
        {f.note && <span>:{f.note}</span>}
      </li>,
    );
  }
  for (const a of e.agenda_added) rows.push(<li key={`a+${a.text}`}><Badge variant="brand" className="mr-1.5">議程 +</Badge>{a.text}<span className="text-muted-foreground"> · {a.why}</span></li>);
  for (const a of e.agenda_done) rows.push(<li key={`a✓${a}`}><Badge variant="success" className="mr-1.5">完成</Badge>{a}</li>);
  for (const a of e.agenda_dropped) rows.push(<li key={`a✗${a}`}><Badge variant="outline" className="mr-1.5">放棄</Badge>{a}</li>);
  for (const [i, d] of e.documents.entries()) {
    rows.push(<li key={`d${i}`}><Badge variant={d.ok ? "brand" : "destructive"} className="mr-1.5">資料 {d.type}</Badge>{d.title ?? "—"}{!d.ok && <span className="text-primary"> · 沒有成功:{d.error}</span>}</li>);
  }
  return rows.length === 0 ? <Quiet>沒有改變什麼</Quiet> : <ul className="grid gap-2 text-sm">{rows}</ul>;
}

const STEP_TONE: Record<IntentStatus, string> = {
  pending: "bg-muted-foreground/50",
  started: "bg-primary",
  done: "bg-foreground/85",
  denied: "bg-primary",
  dropped: "bg-muted-foreground/40",
  failed: "ring-[1.5px] ring-inset ring-primary",
};

function IntentView({ i }: { i: ThoughtIntent }) {
  const history = i.history ?? [{ at: "", status: i.status, detail: i.detail }];
  return (
    <li className="grid gap-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={INTENT_TONE[i.status]}>{INTENT_LABEL[i.status]}</StatusBadge>
        <code className="text-[13px]">{i.capability}</code>
        {i.context && <span className="text-xs text-muted-foreground">{contextShort(i.context)}</span>}
        <span className="ml-auto text-xs text-muted-foreground">期限 {fmtTime(i.expires_at)}</span>
      </div>
      {i.why && <p className="text-sm">{i.why}</p>}
      {i.opening && <p className="text-[13px] text-muted-foreground">想這樣開場:{i.opening}</p>}
      {i.args !== null && typeof i.args === "object" && Object.keys(i.args as object).length > 0 && (
        <code className="block overflow-x-auto rounded bg-well px-2 py-1 text-[11px] text-muted-foreground">{JSON.stringify(i.args)}</code>
      )}
      <ol className="grid gap-1.5 border-l pl-4" aria-label="經過">
        {history.map((h, k) => (
          <li key={k} className="relative text-[13px]">
            <span aria-hidden className={cn("absolute top-1.5 -left-[1.3rem] size-2 rounded-full ring-2 ring-popover", STEP_TONE[h.status])} />
            <span className="font-medium">{INTENT_LABEL[h.status]}</span>
            {h.at && <span className="ml-2 font-mono text-[11px] text-muted-foreground">{fmtTime(h.at)}</span>}
            {h.detail && <span className="text-muted-foreground"> · {h.detail}</span>}
          </li>
        ))}
      </ol>
      {i.decisions.length > 0 && (
        <ul className="grid gap-1" aria-label="閘門決定">
          {i.decisions.map((d) => (
            <li key={`${d.at}-${d.capability}`} className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge variant={d.allowed ? "success" : "destructive"}>{d.allowed ? "放行" : "擋下"}</Badge>
              <code className="text-xs">{d.capability}</code>
              <span className="text-muted-foreground">{STAGE_LABEL[d.stage] ?? d.stage} · {d.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {i.said && (
        <p className="rounded-md bg-control px-3 py-2 text-sm leading-relaxed">
          <span className="mr-1.5 font-medium text-primary">她說</span>
          {i.said}
        </p>
      )}
    </li>
  );
}

function Calls({ thought }: { thought: Thought }) {
  const calls = useLlmCalls({ thought: thought.id });
  const items = calls.data?.pages.flatMap((p) => p.items) ?? [];
  if (calls.isPending) return <SkeletonRows count={1} />;
  if (items.length === 0) {
    return <Quiet>{(thought.calls?.length ?? 0) > 0 ? "這些呼叫已經不在記憶體裡" : "沒有記錄到呼叫(Core 重新啟動前的想法)"}</Quiet>;
  }
  return (
    <ul className="divide-y divide-line-soft rounded-md border">
      {items.map((c) => (
        <li key={c.id}>
          <Link to="/llm" search={{ tab: "calls", thought: thought.id, call: c.id }} className="flex items-center gap-3 px-3 py-2 text-[13px] outline-none hover:bg-hover focus-visible:bg-hover">
            <span className={cn("size-2 rounded-full", STATUS_TONE[c.status] === "success" ? "bg-foreground/85" : STATUS_TONE[c.status] === "danger" ? "bg-primary" : "ring-[1.5px] ring-inset ring-primary")} />
            <span className="min-w-0 flex-1 truncate">
              {purposeLabel(c.purpose)} · {moduleLabel(c.module)}
              {c.repair !== null && ` · 修正 ${c.repair}`}
              <span className="ml-2 font-mono text-[11px] text-muted-foreground">{c.model}</span>
            </span>
            <span className="tabular-nums text-muted-foreground">{c.usage ? `${fmtInt(c.usage.prompt_tokens)} → ${fmtInt(c.usage.completion_tokens)}` : "—"}</span>
            <span className="tabular-nums">{fmtMs(c.total_ms)}</span>
            <span className="font-mono tabular-nums">{fmtCost(c.cost_usd)}</span>
            <ExternalLink className="size-3.5 text-muted-foreground" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function ThoughtBody({ t }: { t: Thought }) {
  const kinds = [...new Set(t.triggers.map((x) => x.kind))];
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-7">
      <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-5">
        {(
          [
            ["時間", fmtTime(t.at)],
            ["token", t.tokens === null ? "—" : fmtInt(t.tokens)],
            ["花了", fmtMs(t.ms)],
            ["花費", fmtCost(t.cost_usd)],
            ["呼叫", t.attempts && t.attempts > 1 ? `${t.attempts} 次(修正過)` : `${t.calls?.length ?? 1} 次`],
          ] as const
        ).map(([k, v]) => (
          <div key={k}>
            <p className="text-xs text-muted-foreground">{k}</p>
            <p className="text-sm font-medium tabular-nums">{v}</p>
          </div>
        ))}
      </div>

      <Section title="為什麼想" aside={kinds.map((k) => TRIGGER_LABEL[k] ?? k).join("、")}>
        <ul className="grid gap-1.5 text-sm">
          {t.triggers.map((x, k) => (
            <li key={k} className="flex flex-wrap gap-2">
              <Badge variant="outline">{TRIGGER_LABEL[x.kind] ?? x.kind}</Badge>
              <span>{x.detail || "—"}</span>
              {x.context && <span className="text-xs text-muted-foreground">{contextShort(x.context)}</span>}
            </li>
          ))}
          {(t.suggestions ?? []).map((s, k) => (
            <li key={`s${k}`} className="flex flex-wrap gap-2">
              <Badge variant="brand">契機 · {s.source}</Badge>
              <span>{s.hint}</span>
              <code className="text-xs text-muted-foreground">{s.reason}</code>
            </li>
          ))}
        </ul>
        {t.idle && t.idle.thoughts > 0 && (
          <p className="rounded-md bg-control px-3 py-2 text-[13px]">
            想這則之前,她已經連續 <span className="font-medium tabular-nums">{t.idle.thoughts}</span> 次想了沒做事(大約 {t.idle.minutes} 分鐘)
          </p>
        )}
      </Section>

      <Section title="她想的">
        {t.error ? <p className="font-mono text-sm text-primary">{t.error}</p> : <p className="text-[15px] leading-relaxed">{t.thought || "—"}</p>}
      </Section>

      {t.reasoning && (
        <Section title="模型的推理" aside={`${fmtInt(t.reasoning.length)} 字`}>
          <TextBlock text={t.reasoning} label="模型的推理" fold={700} />
        </Section>
      )}

      <Section title="改變">
        <EffectsView e={t.effects} changes={t.changes} />
      </Section>

      <Section title={`意圖(${t.intents.length})`}>
        {t.intents.length === 0 ? <Quiet>沒有打算做什麼</Quiet> : <ul className="grid gap-3">{t.intents.map((i) => <IntentView key={i.id} i={i} />)}</ul>}
      </Section>

      <Section title="她看到的">
        {t.input ? <InputView input={t.input} /> : <Quiet>這則想法比較舊,沒有保留她當時看到的內容(只有最近 40 則有)。</Quiet>}
      </Section>

      <Section title="LLM 呼叫">
        <Calls thought={t} />
      </Section>
    </div>
  );
}

/** One thought in full, by id (from the URL). */
export function ThoughtSheet({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  const q = useThought(id);
  const t = q.data;
  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2 pr-8">
            <Brain className="size-4 text-primary" aria-hidden />
            她的想法
            {t && <span className="font-mono text-sm font-normal text-muted-foreground">{fmtDateTime(t.at)}</span>}
            {t?.intents.some((i) => i.status === "done") && (
              <Badge variant="success" className="ml-auto">
                付諸行動 <ArrowRight className="size-3" />
              </Badge>
            )}
          </SheetTitle>
        </SheetHeader>
        <SheetBody>{q.isPending ? <SkeletonRows count={6} /> : q.isError ? <ErrorLine error={q.error} onRetry={() => void q.refetch()} /> : <ThoughtBody t={q.data} />}</SheetBody>
      </SheetContent>
    </Sheet>
  );
}
