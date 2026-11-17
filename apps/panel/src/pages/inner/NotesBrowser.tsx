import { useState } from "react";
import type { NoteAuthor, NoteDocumentEntry, NoteKind, NoteLineView, NoteProvenance, NoteVersion } from "@miyoria/contracts/api";
import { useNoteDocument, useNoteDocuments, useNoteHistory, useRevertNote } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { ModuleQuery } from "@/components/module-query";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { fmtDateTime, fmtInt, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

const KINDS: NoteKind[] = ["person", "place", "topic", "self"];

const KIND_LABEL: Record<NoteKind, string> = {
  person: "人物",
  place: "地點",
  topic: "主題",
  self: "她自己",
};

const PROVENANCE: Record<NoteProvenance, string> = {
  told_by_subject: "本人說的",
  told_by_other: "別人說的",
  observed: "她看到的",
  concluded: "她推論的",
};

const AUTHOR: Record<NoteAuthor, string> = {
  segment: "整理對話",
  reflect: "每日反思",
  tool: "她的工具",
  import: "匯入",
  panel: "面板",
  system: "系統",
};

const OP: Record<NoteVersion["changes"][number]["op"], string> = {
  add: "新增",
  outdate: "作廢",
  restore: "恢復",
  redact: "抹除",
};

/** `新增 2、作廢 1`: what a change set did, by kind. */
export function summarize(changes: NoteVersion["changes"]): string {
  const counts = new Map<string, number>();
  for (const c of changes) counts.set(c.op, (counts.get(c.op) ?? 0) + 1);
  return [...counts].map(([op, n]) => `${OP[op as keyof typeof OP]} ${n}`).join("、");
}

function Line({ line }: { line: NoteLineView }) {
  const old = line.outdated_at !== null;
  const told = line.told_by_name ? `${PROVENANCE[line.provenance]}(${line.told_by_name})` : PROVENANCE[line.provenance];
  return (
    <li className={cn("grid gap-1 py-2", old && "text-muted-foreground")} data-outdated={old ? "true" : undefined}>
      <p className={cn("max-w-[70ch] whitespace-pre-wrap break-words leading-relaxed", old && "line-through decoration-muted-foreground/60")}>{line.text === "" ? "(已抹除)" : line.text}</p>
      <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
        <span>{told}</span>
        <span>{line.scope.label}</span>
        <span>{AUTHOR[line.author]}</span>
        {line.confidence < 0.5 && <span>不太確定</span>}
        <time dateTime={line.created_at} title={fmtDateTime(line.created_at)} className="tabular-nums">
          {fmtRelative(line.created_at)}
        </time>
        {old && (
          <span>
            過時於 {fmtDateTime(line.outdated_at as string)}
            {line.outdated_reason ? ` · ${line.outdated_reason}` : ""}
          </span>
        )}
      </p>
      {line.evidence.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">原話 {line.evidence.length}</summary>
          <ul className="mt-1 grid gap-1">
            {line.evidence.map((e, i) => (
              <li key={`${e.at}-${i}`} className="break-words">
                {e.redacted || e.quote === "" ? "(已抹除)" : `「${e.quote}」`}
                {e.person_name ? ` · ${e.person_name}` : ""} · {fmtDateTime(e.at)}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  );
}

function History({ doc }: { doc: NoteDocumentEntry }) {
  const q = useNoteHistory(doc.id);
  const revert = useRevertNote();
  const [target, setTarget] = useState<NoteVersion | null>(null);
  return (
    <>
      <QueryView query={q} skeleton={<SkeletonRows count={2} />} isEmpty={(h) => h.versions.length === 0} empty={<EmptyLine>還沒有改過</EmptyLine>}>
        {(h) => (
          <ol className="grid" aria-label="版本">
            {[...h.versions].reverse().map((v) => (
              <li key={v.version} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line-soft py-2 text-xs last:border-0">
                <span className="font-mono">v{v.version}</span>
                <time dateTime={v.at} className="text-muted-foreground tabular-nums">
                  {fmtDateTime(v.at)}
                </time>
                <span className="text-muted-foreground">{AUTHOR[v.author]}</span>
                <span className="min-w-0 text-muted-foreground break-words">
                  {summarize(v.changes)}
                  {v.reason ? ` · ${v.reason}` : ""}
                </span>
                {v.version !== doc.version && (
                  <Button size="sm" variant="outline" writes className="ml-auto" aria-label={`還原到 v${v.version}`} onClick={() => setTarget(v)}>
                    還原到這版
                  </Button>
                )}
              </li>
            ))}
          </ol>
        )}
      </QueryView>
      <ConfirmDialog
        open={target !== null}
        title={`還原「${doc.label}」到 v${target?.version ?? ""}?`}
        confirmLabel="還原"
        busy={revert.isPending}
        onClose={() => setTarget(null)}
        onConfirm={() =>
          target &&
          revert.mutate(
            { id: doc.id, version: target.version },
            {
              onSuccess: (r) => {
                notify.ok(r.version === null ? "內容本來就是這一版" : `已還原,存成 v${r.version}`);
                setTarget(null);
              },
              onError: (e) => notify.error(e, "還原失敗"),
            },
          )
        }
      >
        <div className="grid gap-2">
          <p>現在用著的內容會換成 v{target?.version} 當時的樣子,另存成新的一版。舊的版本都還在,隨時能再還原。</p>
          {doc.kind === "self" && <p className="text-foreground">這是她自己的文件。她改寫它不需要你同意,還原會直接取代她現在的樣子。</p>}
        </div>
      </ConfirmDialog>
    </>
  );
}

function DocumentView({ id }: { id: string }) {
  const [outdated, setOutdated] = useState(false);
  const [history, setHistory] = useState(false);
  const q = useNoteDocument(id, outdated);
  return (
    <ModuleQuery query={q} module="筆記">
      {(d) => (
        <article aria-label={`文件 ${d.document.label}`} className="grid min-w-0 content-start gap-3">
          <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="text-sm font-semibold break-words">{d.document.label}</h3>
            <code className="font-mono text-xs text-muted-foreground">{d.document.short_id}</code>
            <span className="ml-auto text-xs text-muted-foreground tabular-nums">
              v{d.document.version} · {fmtInt(d.document.lines)} 行 · 改於 <time dateTime={d.document.updated_at}>{fmtRelative(d.document.updated_at)}</time>
            </span>
          </header>
          {d.outdated > 0 && (
            <div className="flex items-center gap-2">
              <Switch id={`outdated-${id}`} checked={outdated} onCheckedChange={setOutdated} />
              <Label htmlFor={`outdated-${id}`} className="font-normal text-muted-foreground">
                含過時的行 {d.outdated}
              </Label>
            </div>
          )}
          {d.sections.length === 0 ? (
            <EmptyLine>這份文件現在沒有內容</EmptyLine>
          ) : (
            d.sections.map((s) => (
              <section key={s.key} aria-label={s.label}>
                <h4 className="pb-1 text-[13px] font-medium">{s.label}</h4>
                <ul className="divide-y divide-line-soft">
                  {s.lines.map((l) => (
                    <Line key={l.id} line={l} />
                  ))}
                </ul>
              </section>
            ))
          )}
          <details className="text-[13px]" onToggle={(e) => setHistory(e.currentTarget.open)}>
            <summary className="cursor-pointer select-none text-muted-foreground hover:text-foreground">歷史</summary>
            {history && <History doc={d.document} />}
          </details>
        </article>
      )}
    </ModuleQuery>
  );
}

/** Her documents by kind: who and what she keeps notes on, line by line, and a way back to an earlier version. */
export function NotesBrowser() {
  const q = useNoteDocuments();
  const [kind, setKind] = useState<NoteKind>("person");
  const [picked, setPicked] = useState<string | null>(null);
  return (
    <Card>
      <CardHeader>
        <CardTitle>她的筆記</CardTitle>
        {q.data && (
          <Segmented
            label="文件種類"
            value={kind}
            onChange={(k) => {
              setKind(k);
              setPicked(null);
            }}
            options={KINDS.map((k) => ({ value: k, label: `${KIND_LABEL[k]} ${q.data.counts.find((c) => c.kind === k)?.documents ?? 0}` }))}
          />
        )}
      </CardHeader>
      <ModuleQuery query={q} module="筆記" isEmpty={(d) => d.documents.length === 0} empty="她還沒有寫下任何筆記">
        {(d) => {
          const docs = d.documents.filter((e) => e.kind === kind);
          if (docs.length === 0) return <EmptyLine>這一類還沒有文件</EmptyLine>;
          const current = docs.find((e) => e.id === picked)?.id ?? docs[0]?.id ?? null;
          return (
            <div className="grid gap-6 lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
              <ul aria-label="文件索引" className="grid content-start">
                {docs.map((e) => (
                  <li key={e.id} className="border-b border-line-soft last:border-0">
                    <button
                      type="button"
                      aria-current={e.id === current ? "true" : undefined}
                      onClick={() => setPicked(e.id)}
                      className={cn("grid w-full gap-0.5 py-(--row-y) text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", e.id === current ? "text-foreground" : "text-muted-foreground hover:text-foreground")}
                    >
                      <span className={cn("text-[13px] break-words", e.id === current && "font-semibold text-primary")}>{e.label}</span>
                      <span className="text-xs tabular-nums">
                        {fmtInt(e.lines)} 行 · <time dateTime={e.updated_at}>{fmtRelative(e.updated_at)}</time>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              {current && <DocumentView key={current} id={current} />}
            </div>
          );
        }}
      </ModuleQuery>
    </Card>
  );
}
