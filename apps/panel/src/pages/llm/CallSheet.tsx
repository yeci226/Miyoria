import { Link } from "@tanstack/react-router";
import { Brain, Check, ChevronDown, Copy, Wrench } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { LlmCallDetail, LlmCallRecord } from "@/api/types";
import { useLlmCall } from "@/app/queries";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { fmtDateTime, fmtInt } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  costLines,
  ERROR_LABEL,
  FINISH_LABEL,
  fmtCost,
  fmtMs,
  fmtPerMtok,
  hitRate,
  moduleLabel,
  purposeLabel,
  STATUS_LABEL,
  STATUS_TONE,
} from "./labels";

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
      <h3 className="flex items-baseline justify-between gap-3 text-[13px] font-medium text-muted-foreground">
        {title}
        {aside && <span className="font-normal">{aside}</span>}
      </h3>
      {children}
    </section>
  );
}

/** Label / value pairs in two columns. */
export function Pairs({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(0,8rem)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      size="icon-sm"
      variant="ghost"
      className="size-7 text-muted-foreground"
      aria-label={done ? "已複製" : label}
      title={label}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        })
      }
    >
      {done ? <Check /> : <Copy />}
    </Button>
  );
}

const ROLE_LABEL: Record<string, string> = { system: "system", user: "user", assistant: "assistant", tool: "tool" };

/** A long text, folded past `fold` characters until opened. */
export function TextBlock({ text, fold = 1600, open: initial = false, mono = false, label }: { text: string; fold?: number; open?: boolean; mono?: boolean; label: string }) {
  const [open, setOpen] = useState(initial || text.length <= fold);
  return (
    <div className="grid gap-1.5">
      <pre
        aria-label={label}
        className={cn(
          "max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md border bg-well px-3 py-2.5 text-[13px] leading-relaxed",
          mono ? "font-mono text-[12px]" : "font-sans",
          !open && "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_70%,transparent)]",
        )}
      >
        {text || "(空的)"}
      </pre>
      {text.length > fold && (
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 justify-self-start rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
          {open ? "收起" : `展開全部(${fmtInt(text.length)} 字)`}
        </button>
      )}
    </div>
  );
}

function Messages({ detail }: { detail: LlmCallDetail }) {
  return (
    <ol className="grid gap-3" aria-label="送出的訊息">
      {detail.messages.map((m, i) => (
        <li key={i} className="grid gap-1.5">
          <div className="flex items-center gap-2 text-xs">
            <Badge variant={m.role === "system" ? "secondary" : m.role === "assistant" ? "brand" : "outline"} className="font-mono">
              {ROLE_LABEL[m.role] ?? m.role}
            </Badge>
            {m.name && <span className="text-muted-foreground">{m.name}</span>}
            {m.tool_call_id && <span className="font-mono text-muted-foreground">↩ {m.tool_call_id}</span>}
            <span className="ml-auto text-muted-foreground tabular-nums">
              {fmtInt(m.content.length)} 字{m.cut > 0 && ` · 中間省略 ${fmtInt(m.cut)} 字`}
            </span>
            <CopyButton text={m.content} label={`複製第 ${i + 1} 則訊息`} />
          </div>
          <TextBlock text={m.content} label={`第 ${i + 1} 則訊息(${m.role})`} fold={m.role === "system" ? 600 : 1600} />
          {m.tool_calls.map((c) => (
            <TextBlock key={c.id} mono label={`工具呼叫 ${c.name}`} text={`${c.name}(${c.arguments})`} />
          ))}
        </li>
      ))}
    </ol>
  );
}

function CallBody({ call, detail }: { call: LlmCallRecord; detail: LlmCallDetail | null }) {
  const u = call.usage;
  const lines = costLines(call);
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-7">
      <Pairs
        items={[
          ["時間", <span key="t" className="font-mono text-[13px]">{fmtDateTime(call.at)}</span>],
          ["用途", <span key="p">{purposeLabel(call.purpose)} <code className="ml-1 text-xs text-muted-foreground">{call.purpose}{call.chain !== call.purpose && ` → ${call.chain} 的模型鏈`}</code></span>],
          ["模型", call.model ? <code key="m" className="text-[13px]">{call.model}</code> : "—"],
          ["誰呼叫的", <span key="w">{moduleLabel(call.module)}{call.label && <span className="text-muted-foreground"> · {call.label}</span>}{call.repair !== null && <Badge variant="warning" className="ml-2">修正第 {call.repair} 次</Badge>}</span>],
          [
            "屬於",
            call.thought || call.turn ? (
              <span key="b" className="flex flex-wrap gap-x-3 gap-y-1">
                {call.thought && (
                  <Link to="/inner" search={{ tab: "thoughts", thought: call.thought }} className="text-primary underline-offset-4 hover:underline">
                    她的想法 <code className="text-xs">{call.thought.slice(-8)}</code>
                  </Link>
                )}
                {call.turn && (
                  <Link to="/llm" search={{ tab: "calls", turn: call.turn }} className="text-primary underline-offset-4 hover:underline">
                    這一輪對話的呼叫 <code className="text-xs">{call.turn.slice(-8)}</code>
                  </Link>
                )}
              </span>
            ) : (
              "—"
            ),
          ],
          ["設定", <span key="s" className="flex flex-wrap gap-1.5">{call.thinking && <Badge variant="brand">思考</Badge>}{call.json_mode && <Badge variant="outline">JSON</Badge>}{call.tools.length > 0 && <Badge variant="outline">{call.tools.length} 個工具</Badge>}{call.images > 0 && <Badge variant="outline">{call.images} 張圖</Badge>}{call.max_tokens !== null && <Badge variant="outline">max {call.max_tokens}</Badge>}{call.temperature !== null && <Badge variant="outline">溫度 {call.temperature}</Badge>}</span>],
        ]}
      />

      <Section title="時間與用量">
        <div className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
          {(
            [
              ["首字", fmtMs(call.first_token_ms)],
              ["總時間", fmtMs(call.total_ms)],
              ["輸入", u ? fmtInt(u.prompt_tokens) : "—"],
              ["快取命中", u ? `${fmtInt(u.cached_prompt_tokens)} · ${Math.round(hitRate(u.prompt_tokens, u.cached_prompt_tokens) * 100)}%` : "—"],
              ["輸出", u ? fmtInt(u.completion_tokens) : "—"],
              ["推理", u?.reasoning_tokens != null ? fmtInt(u.reasoning_tokens) : "—"],
              ["花費", fmtCost(call.cost_usd)],
              ["結束", call.finish_reason ? (FINISH_LABEL[call.finish_reason] ?? call.finish_reason) : "—"],
            ] as const
          ).map(([k, v]) => (
            <div key={k}>
              <p className="text-xs text-muted-foreground">{k}</p>
              <p className="text-sm font-medium tabular-nums">{v}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section title="價格" aside={call.pricing ? "每百萬 token,用 [llm.pricing] 計算" : undefined}>
        {lines ? (
          <table className="w-full text-sm tabular-nums">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="pb-1.5 text-left font-normal">項目</th>
                <th className="pb-1.5 text-right font-normal">token</th>
                <th className="pb-1.5 text-right font-normal">單價</th>
                <th className="pb-1.5 text-right font-normal">小計</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.label} className="border-t">
                  <td className="py-1.5">{l.label}</td>
                  <td className="py-1.5 text-right">{fmtInt(l.tokens)}</td>
                  <td className="py-1.5 text-right font-mono text-[13px]">{fmtPerMtok(l.price)}</td>
                  <td className="py-1.5 text-right font-mono text-[13px]">{fmtCost(l.usd)}</td>
                </tr>
              ))}
              <tr className="border-t font-medium">
                <td className="py-1.5">合計</td>
                <td />
                <td />
                <td className="py-1.5 text-right font-mono text-[13px]">{fmtCost(call.cost_usd)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted-foreground">{call.model ? `${call.model} 沒有設定價格,算作 $0` : "沒有回報用量"}</p>
        )}
      </Section>

      {(call.status === "error" || call.status === "aborted" || call.fallbacks.length > 0 || call.retries.length > 0) && (
        <Section title="錯誤與重試">
          <ul className="grid gap-2 text-sm">
            {call.fallbacks.map((f, i) => (
              <li key={i} className="rounded-md bg-control px-3 py-2">
                <span className="font-medium">換下一個模型</span> · <code className="text-xs">{f.model}</code> {ERROR_LABEL[f.kind] ?? f.kind}
                <p className="mt-1 font-mono text-xs text-muted-foreground">{f.error}</p>
              </li>
            ))}
            {call.retries.map((r, i) => (
              <li key={`r${i}`} className="rounded-md border px-3 py-2">
                <span className="font-medium">重送第 {i + 1} 次</span> · <span className="font-mono text-xs text-muted-foreground">{r}</span>
              </li>
            ))}
            {call.error && (
              <li className="rounded-md border border-primary/50 px-3 py-2">
                <span className="font-medium">{call.error_kind ? (ERROR_LABEL[call.error_kind] ?? call.error_kind) : "錯誤"}</span>
                <p className="mt-1 font-mono text-xs text-primary">{call.error}</p>
              </li>
            )}
          </ul>
        </Section>
      )}

      {detail === null ? (
        <p className="rounded-md border px-3 py-3 text-sm text-muted-foreground">這次呼叫太舊,請求和回覆的內容已經不在記憶體裡(只保留最近的 200 次)。</p>
      ) : (
        <>
          {detail.response.reasoning && (
            <Section title="模型的思考" aside={`${fmtInt(call.reasoning_chars)} 字`}>
              <TextBlock text={detail.response.reasoning} label="模型的思考" />
            </Section>
          )}
          <Section title="回覆" aside={detail.response.cut > 0 ? `中間省略 ${fmtInt(detail.response.cut)} 字` : `${fmtInt(call.text_chars)} 字`}>
            <TextBlock text={detail.response.text} label="回覆" open mono={call.json_mode} />
            {detail.response.tool_calls.map((c) => (
              <div key={c.id} className="grid gap-1">
                <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Wrench className="size-3.5" /> {c.name}
                </span>
                <TextBlock text={c.arguments} mono label={`工具 ${c.name} 的參數`} />
              </div>
            ))}
          </Section>
          <Section title={`送出的訊息(${detail.messages.length})`} aside={detail.tools.length > 0 ? `工具:${detail.tools.join("、")}` : undefined}>
            <Messages detail={detail} />
          </Section>
        </>
      )}
    </div>
  );
}

/** One LLM call in full, by id (from the URL). */
export function CallSheet({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  const q = useLlmCall(id);
  const call = q.data?.call;
  return (
    <Sheet open={Boolean(id)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-3xl">
        <SheetHeader>
          <SheetTitle className="flex flex-wrap items-center gap-2 pr-8">
            {call ? (
              <>
                <StatusBadge tone={STATUS_TONE[call.status]} pulse={call.status === "streaming"}>
                  {STATUS_LABEL[call.status]}
                </StatusBadge>
                {purposeLabel(call.purpose)}
                {call.thinking && <Brain aria-label="思考" className="size-4 text-primary" />}
                <span className="ml-auto font-mono text-sm font-normal text-muted-foreground">{fmtCost(call.cost_usd)}</span>
                {q.data && <CopyButton text={JSON.stringify(q.data, null, 2)} label="複製整個呼叫(JSON)" />}
              </>
            ) : (
              "LLM 呼叫"
            )}
          </SheetTitle>
        </SheetHeader>
        <SheetBody>
          {q.isPending ? <SkeletonRows count={6} /> : q.isError ? <ErrorLine error={q.error} onRetry={() => void q.refetch()} /> : <CallBody call={q.data.call} detail={q.data.detail} />}
        </SheetBody>
      </SheetContent>
    </Sheet>
  );
}
