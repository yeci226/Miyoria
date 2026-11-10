import type { CompiledBlock, SavedPrompt, TurnOutcomeRecord } from "@/api/types";
import { isApiError } from "@/api/http";
import { usePrompt, useTurnOutcomes } from "@/app/queries";
import { Facts } from "@/components/json-view";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { contextShort, fmtDateTime, fmtInt } from "@/lib/format";
import { OUTCOME_KIND_LABEL, OUTCOME_TONE, outcomeText, TURN_REASON_LABEL } from "./labels";

const FATE_LABEL: Record<CompiledBlock["fate"], string> = {
  kept: "完整",
  summarized: "摘要",
  truncated: "截斷",
  dropped: "捨棄",
};

const AUTHORITY_LABEL: Record<string, string> = { self: "她自己的狀態", data: "資料(不可信)" };

const ROLE_LABEL = { system: "system", user: "user", assistant: "assistant" } as const;

/** How the turn ended (`agent.turn.outcome`). */
export function OutcomeFacts({ record }: { record: TurnOutcomeRecord }) {
  const o = record.outcome;
  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={OUTCOME_TONE[o.type]}>{OUTCOME_KIND_LABEL[o.type]}</StatusBadge>
        <span className="text-sm">{outcomeText(o)}</span>
      </div>
      <Facts
        items={{
          "原因": TURN_REASON_LABEL[record.reason] ?? record.reason,
          "叫到她的人": record.addressed_by.length > 0 ? record.addressed_by.join("、") : "—",
          "重來次數": record.restarts,
          "思考": record.reasoning ?? "—",
          "延遲": record.latency_ms === null ? "—" : `${fmtInt(record.latency_ms)} ms`,
          "時間": fmtDateTime(record.at),
        }}
      />
    </div>
  );
}

function BlocksTable({ blocks }: { blocks: CompiledBlock[] }) {
  return (
    <Table aria-label="提示詞區塊">
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead>區塊</TableHead>
          <TableHead className="hidden w-16 sm:table-cell">來源</TableHead>
          <TableHead className="w-24 text-right">字數</TableHead>
          <TableHead className="w-16">處理</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {blocks.map((b, i) => (
          <TableRow key={`${b.key}:${i}`}>
            <TableCell>
              <span className="grid gap-0.5">
                <span className="font-mono text-xs">{b.key}</span>
                <span className="text-xs text-muted-foreground">{AUTHORITY_LABEL[b.authority] ?? b.authority}</span>
              </span>
            </TableCell>
            <TableCell className="hidden text-muted-foreground sm:table-cell">{b.source}</TableCell>
            <TableCell className="text-right font-mono text-xs tabular-nums">
              {fmtInt(b.chars_out)}
              <span className="text-muted-foreground"> / {fmtInt(b.chars_in)}</span>
            </TableCell>
            <TableCell>
              <Badge variant={b.fate === "kept" ? "outline" : b.fate === "dropped" ? "destructive" : "warning"}>
                {FATE_LABEL[b.fate]}
              </Badge>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export function PromptView({ prompt }: { prompt: SavedPrompt }) {
  return (
    <div className="grid gap-4">
      <Facts
        items={{
          "情境": contextShort(prompt.context),
          "用途": prompt.purpose,
          "思考": prompt.reasoning,
          "輸入 token": prompt.prompt_tokens === null ? "—" : fmtInt(prompt.prompt_tokens),
          "時間": fmtDateTime(prompt.at),
        }}
      />
      {prompt.blocks.length > 0 && (
        <div className="overflow-hidden rounded-md border">
          <BlocksTable blocks={prompt.blocks} />
        </div>
      )}
      <ol className="grid gap-2" aria-label="送出的訊息">
        {prompt.messages.map((m, i) => (
          <li key={i} className="rounded-md border">
            <details open={i === prompt.messages.length - 1 || m.role !== "assistant"}>
              <summary className="cursor-pointer px-3 py-1.5 font-mono text-xs text-muted-foreground">
                {ROLE_LABEL[m.role]} · {fmtInt(m.text.length)} 字
              </summary>
              <pre className="max-h-[40dvh] overflow-auto border-t px-3 py-2 font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap">
                {m.text}
              </pre>
            </details>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The prompt of one turn; an older Core, a turn too old to keep or an unsaved prompt say so. */
export function PromptSection({ turn }: { turn: string }) {
  const prompt = usePrompt(turn);
  return (
    <section className="grid gap-3" aria-label="這回合的提示詞">
      <h3 className="text-sm font-medium">提示詞</h3>
      {prompt.isPending ? (
        <SkeletonRows count={3} />
      ) : prompt.isError ? (
        isApiError(prompt.error) && prompt.error.kind === "not_found" ? (
          <EmptyLine>這回合的提示詞沒有留下(太舊,或沒有存)</EmptyLine>
        ) : isApiError(prompt.error) && prompt.error.kind === "not_provided" ? (
          <EmptyLine>這個 Core 還沒有提供提示詞</EmptyLine>
        ) : (
          <ErrorLine error={prompt.error} onRetry={() => void prompt.refetch()} />
        )
      ) : (
        <PromptView prompt={prompt.data} />
      )}
    </section>
  );
}

/**
 * One turn: how it ended and the prompt it was given, next to each other. Either half may be
 * missing (an older Core, a turn too old to keep, a prompt that was not saved).
 */
export function TurnDetail({ turn }: { turn: string }) {
  const outcomes = useTurnOutcomes({ limit: 500 });
  const record = outcomes.data?.find((r) => r.turn === turn) ?? null;
  return (
    <div className="grid gap-6">
      <section className="grid gap-3" aria-label="這回合的結果">
        <h3 className="text-sm font-medium">結果</h3>
        {record ? (
          <OutcomeFacts record={record} />
        ) : outcomes.isPending ? (
          <SkeletonRows count={2} />
        ) : (
          <p className="text-sm text-muted-foreground">沒有這回合的結果紀錄</p>
        )}
      </section>
      <PromptSection turn={turn} />
    </div>
  );
}
