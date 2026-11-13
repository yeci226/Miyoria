import { useNavigate } from "@tanstack/react-router";
import { Brain, ChevronDown, Maximize2, Wrench } from "lucide-react";
import { useDeferredValue, useState } from "react";
import type { LlmCallKind, LlmThinking, LlmThinkingQuery } from "@/api/types";
import { useLlmThinking } from "@/app/queries";
import type { LlmSearch } from "@/app/router";
import { SearchInput } from "@/components/controls";
import { Toolbar } from "@/components/page";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { fmtCompact, fmtDateTime, fmtInt, fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { TextBlock } from "./CallSheet";
import { fmtMs, KIND_LABEL, moduleLabel, STATUS_LABEL, STATUS_TONE } from "./labels";

const ALL = "__all";
const SINCE = [
  { value: ALL, label: "全部保留的", minutes: null },
  { value: "15", label: "15 分鐘", minutes: 15 },
  { value: "60", label: "1 小時", minutes: 60 },
  { value: "360", label: "6 小時", minutes: 360 },
  { value: "1440", label: "24 小時", minutes: 1440 },
] as const;

/** The answer under the reasoning, folded until asked for. */
function Answer({ t }: { t: LlmThinking }) {
  const [open, setOpen] = useState(false);
  const answer = t.answer ?? "";
  if (!answer && t.tool_calls.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex items-center gap-1 justify-self-start rounded-sm text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        {open ? "收起回覆" : "看回覆"}
        {answer && <span className="tabular-nums">· {fmtInt(t.call.text_chars)} 字</span>}
        {t.tool_calls.length > 0 && (
          <span className="inline-flex items-center gap-1">
            · <Wrench className="size-3" /> {t.tool_calls.join("、")}
          </span>
        )}
      </button>
      {open && answer && <TextBlock text={answer} label="回覆" open mono={t.call.json_mode} />}
    </div>
  );
}

function ThinkingItem({ t, showKind, onOpen }: { t: LlmThinking; showKind: boolean; onOpen: () => void }) {
  const c = t.call;
  const u = c.usage;
  return (
    <li className="grid min-w-0 gap-2.5 border-b py-4 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-[13px]">
        <span className="font-mono text-[12px] text-muted-foreground" title={fmtDateTime(c.at)}>
          {fmtTime(c.at)}
        </span>
        <Dot tone={STATUS_TONE[c.status]} pulse={c.status === "streaming"} />
        <span className="sr-only">{STATUS_LABEL[c.status]}</span>
        {showKind && <Badge variant="brand">{KIND_LABEL[c.kind]}</Badge>}
        <span className="truncate font-medium">
          {moduleLabel(c.module)}
          {c.label && <span className="font-normal text-muted-foreground"> · {c.label}</span>}
        </span>
        <span className="hidden truncate font-mono text-[12px] text-muted-foreground md:inline" title={c.model ?? undefined}>
          {c.model ?? "—"}
        </span>
        <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground tabular-nums">
          {u?.reasoning_tokens ? <span>推理 {fmtCompact(u.reasoning_tokens)} tok</span> : null}
          <span>{fmtMs(c.total_ms)}</span>
          <Button size="sm" variant="ghost" className="h-6 px-1.5" onClick={onOpen} aria-label="看完整呼叫" title="看完整呼叫">
            <Maximize2 className="size-3.5" />
          </Button>
        </span>
      </div>
      {t.reasoning ? (
        <TextBlock text={t.reasoning} label="模型的思考" fold={900} />
      ) : c.status === "streaming" ? (
        <p className="text-sm text-muted-foreground">還在想…</p>
      ) : c.reasoning_chars > 0 ? (
        <p className="text-sm text-muted-foreground">這次的思考太舊,已經不在記憶體裡。</p>
      ) : (
        <p className="text-sm text-muted-foreground">這次沒有思考({c.thinking ? "模型沒有回傳思考內容" : "推理關閉"})。</p>
      )}
      {t.cut > 0 && <p className="text-xs text-muted-foreground">中間省略 {fmtInt(t.cut)} 字</p>}
      {c.status === "error" && c.error && <p className="text-xs text-primary">{c.error}</p>}
      <Answer t={t} />
    </li>
  );
}

/** Her chain of thought, call by call, by kind of call: inner thoughts, text chat, voice, ... */
export function ThinkingTab({ search }: { search: LlmSearch }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const q = useDeferredValue(text.trim());
  const [since, setSince] = useState<string>(ALL);
  const [reasoned, setReasoned] = useState(true);
  const kind = search.kind ?? null;
  const setKind = (k: LlmCallKind | undefined) =>
    void navigate({ to: "/llm", search: (s: LlmSearch) => ({ ...s, kind: k, tab: "thinking" }), replace: true });

  const minutes = SINCE.find((s) => s.value === since)?.minutes ?? null;
  const query: LlmThinkingQuery = {
    kind: kind ?? undefined,
    reasoned: reasoned || undefined,
    q: q || undefined,
    since: minutes === null ? undefined : new Date(Math.floor((Date.now() - minutes * 60_000) / 60_000) * 60_000).toISOString(),
  };
  const thinking = useLlmThinking(query);
  const items = thinking.data?.pages.flatMap((p) => p.items) ?? [];
  const first = thinking.data?.pages[0];
  const kinds = first?.by_kind ?? [];
  const count = (k: { calls: number; reasoned: number }) => (reasoned ? k.reasoned : k.calls);
  const total = kinds.reduce((n, k) => n + count(k), 0);
  const open = (id: string) => void navigate({ to: "/llm", search: (prev: LlmSearch) => ({ ...prev, call: id }) });

  const options = [
    { value: ALL, label: <>全部 <span className="tabular-nums opacity-70">{total}</span></> },
    ...kinds.map((k) => ({
      value: k.kind as string,
      label: (
        <>
          {KIND_LABEL[k.kind]} <span className="tabular-nums opacity-70">{count(k)}</span>
        </>
      ),
      disabled: count(k) === 0 && kind !== k.kind,
    })),
  ];
  // A kind picked from the URL that has no calls yet still shows as picked.
  if (kind && !kinds.some((k) => k.kind === kind)) options.push({ value: kind, label: <>{KIND_LABEL[kind]} 0</>, disabled: false });

  return (
    <div className="grid gap-4">
      <Toolbar>
        <Segmented
          label="呼叫種類"
          value={kind ?? ALL}
          onChange={(v) => setKind(v === ALL ? undefined : (v as LlmCallKind))}
          options={options}
        />
      </Toolbar>
      <Toolbar>
        <SearchInput value={text} onChange={setText} placeholder="搜尋思考、回覆" label="搜尋思路" className="sm:w-64" />
        <Select value={since} onValueChange={setSince}>
          <SelectTrigger aria-label="時間範圍" className="w-32" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SINCE.map((x) => (
              <SelectItem key={x.value} value={x.value}>
                {x.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch id="llm-reasoned" checked={reasoned} onCheckedChange={setReasoned} />
          <Label htmlFor="llm-reasoned" className="font-normal text-muted-foreground">
            只看有思考的
          </Label>
        </div>
      </Toolbar>
      <Card>
        <div className="flex items-center justify-between gap-3 pb-1 text-[13px] text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Brain className="size-3.5" />
            {first ? (
              <>
                符合 <span className="font-medium text-foreground tabular-nums">{first.matched}</span> 次 · 思考內容保留最近 2000 次呼叫
              </>
            ) : (
              "—"
            )}
          </span>
          {thinking.isFetching && !thinking.isPending && <span className="text-xs">更新中…</span>}
        </div>
        {thinking.isPending ? (
          <SkeletonRows count={6} />
        ) : thinking.isError ? (
          <ErrorLine error={thinking.error} onRetry={() => void thinking.refetch()} />
        ) : items.length === 0 ? (
          <EmptyLine>{reasoned ? "沒有符合、而且有思考內容的呼叫" : "沒有符合的呼叫"}</EmptyLine>
        ) : (
          <ol aria-label="思路" className="grid">
            {items.map((t) => (
              <ThinkingItem key={t.call.id} t={t} showKind={kind === null} onOpen={() => open(t.call.id)} />
            ))}
          </ol>
        )}
        {thinking.hasNextPage && (
          <div className="pt-3 text-center">
            <Button size="sm" variant="outline" busy={thinking.isFetchingNextPage} onClick={() => void thinking.fetchNextPage()}>
              載入更多
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
