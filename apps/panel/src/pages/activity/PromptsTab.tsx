import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { PromptSummary, TurnOutcomeKind, TurnOutcomeRecord } from "@/api/types";
import { useDecisions, usePrompts, useTurnOutcomes } from "@/app/queries";
import { Toolbar } from "@/components/page";
import { EmptyLine, QueryView } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { contextShort, fmtDateTime, fmtInt, fmtRelative } from "@/lib/format";
import { OUTCOME_KIND_LABEL, OUTCOME_KINDS, OUTCOME_TONE, outcomeText } from "./labels";
import { TurnDetail } from "./TurnDetail";

const route = getRouteApi("/activity");
const ALL = "__all";

/** One turn in a sheet: the decision trace, how it ended and the prompt it was given. */
export function TurnSheet({ turn, onClose }: { turn: string | null; onClose: () => void }) {
  const decisions = useDecisions({ limit: 200 });
  const trace = turn ? (decisions.data?.find((d) => d.trace.turn === turn)?.trace ?? null) : null;
  return (
    <Sheet open={turn !== null} onOpenChange={(o) => !o && onClose()}>
      <SheetContent>
        {turn && (
          <>
            <SheetHeader>
              <SheetTitle className="flex items-center gap-2">
                <span>回合</span>
                <span className="font-mono text-xs text-muted-foreground">{turn}</span>
              </SheetTitle>
            </SheetHeader>
            <SheetBody className="grid content-start gap-6">
              {trace && (
                <section className="grid gap-2" aria-label="決策">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    決策
                    <Badge variant={trace.respond ? "brand" : "outline"}>{trace.respond ? "回應" : "略過"}</Badge>
                  </h3>
                  {trace.reasons.length > 0 && (
                    <ol className="grid list-decimal gap-1.5 pl-5 text-sm marker:text-muted-foreground">
                      {trace.reasons.map((r, i) => (
                        <li key={i}>{r}</li>
                      ))}
                    </ol>
                  )}
                </section>
              )}
              <TurnDetail turn={turn} />
            </SheetBody>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function Row({ prompt, outcome, onOpen }: { prompt: PromptSummary; outcome: TurnOutcomeRecord | undefined; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="flex w-full items-center gap-3 py-(--row-y) text-left text-sm outline-none hover:bg-hover focus-visible:bg-hover"
      >
        {outcome ? (
          <span className="w-24 shrink-0">
            <StatusBadge tone={OUTCOME_TONE[outcome.outcome.type]}>{OUTCOME_KIND_LABEL[outcome.outcome.type]}</StatusBadge>
          </span>
        ) : (
          <span className="w-24 shrink-0 text-[13px] text-muted-foreground">—</span>
        )}
        <span className="min-w-0 flex-1 truncate">
          {outcome ? outcomeText(outcome.outcome) : <span className="text-muted-foreground">沒有結果紀錄</span>}
        </span>
        <span className="hidden w-28 truncate text-[13px] text-muted-foreground sm:block">{contextShort(prompt.context)}</span>
        <span className="hidden w-24 text-right font-mono text-xs tabular-nums text-muted-foreground md:block">
          {prompt.prompt_tokens === null ? `${fmtInt(prompt.chars)} 字` : `${fmtInt(prompt.prompt_tokens)} tok`}
        </span>
        <time dateTime={prompt.at} title={fmtDateTime(prompt.at)} className="w-20 text-right text-[13px] text-muted-foreground">
          {fmtRelative(prompt.at)}
        </time>
      </button>
    </li>
  );
}

/** The saved prompt of each recent turn, with how the turn ended. */
export function PromptsTab() {
  const search = route.useSearch();
  const navigate = useNavigate();
  const [kind, setKind] = useState<string>(ALL);
  const prompts = usePrompts(60);
  const outcomes = useTurnOutcomes({ limit: 500 });

  const byTurn = useMemo(() => new Map((outcomes.data ?? []).map((o) => [o.turn, o])), [outcomes.data]);
  const visible = useMemo(
    () =>
      (prompts.data ?? []).filter((p) => {
        if (kind === ALL) return true;
        return byTurn.get(p.turn)?.outcome.type === (kind as TurnOutcomeKind);
      }),
    [prompts.data, byTurn, kind],
  );

  const open = (turn: string | undefined) =>
    void navigate({ to: "/activity", search: { tab: "prompts", turn }, replace: turn === undefined });

  return (
    <div className="grid gap-4">
      <Toolbar>
        <Select value={kind} onValueChange={setKind}>
          <SelectTrigger aria-label="結果" className="w-36">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>所有結果</SelectItem>
            {OUTCOME_KINDS.map((k) => (
              <SelectItem key={k} value={k}>
                {OUTCOME_KIND_LABEL[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="ml-auto text-[13px] text-muted-foreground">每個回合只留一份壓縮過的提示詞</span>
      </Toolbar>
      <Card>
        <QueryView query={prompts} isEmpty={(d) => d.length === 0} empty="還沒有留下的提示詞">
          {() =>
            visible.length === 0 ? (
              <EmptyLine>沒有符合的回合</EmptyLine>
            ) : (
              <ul className="divide-y divide-line-soft" aria-label="提示詞列表">
                {visible.map((p) => (
                  <Row key={p.turn} prompt={p} outcome={byTurn.get(p.turn)} onOpen={() => open(p.turn)} />
                ))}
              </ul>
            )
          }
        </QueryView>
      </Card>
      <TurnSheet turn={search.turn ?? null} onClose={() => open(undefined)} />
    </div>
  );
}
