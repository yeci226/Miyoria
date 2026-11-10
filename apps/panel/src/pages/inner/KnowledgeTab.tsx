import type { ReactNode } from "react";
import type { ConversationNote, FieldSource, KnowledgeDoc } from "@/api/types";
import { useConversationNotes, useKnowledge } from "@/app/queries";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { contextShort, fmtDateTime, fmtRelative } from "@/lib/format";

const SUBJECT_KIND: Record<KnowledgeDoc["subject"]["type"], string> = {
  person: "人",
  guild: "伺服器",
  self: "她自己",
  topic: "主題",
};

const SOURCE_KIND: Record<FieldSource["kind"], string> = {
  self: "她",
  inferred: "她推測",
  said: "說的",
  panel: "面板",
};

function When({ at }: { at: string }) {
  return (
    <time dateTime={at} title={fmtDateTime(at)} className="whitespace-nowrap">
      {fmtRelative(at)}
    </time>
  );
}

/** A short note on where a field came from, shown only where it differs from its parent. */
function SourceTag({ source }: { source: FieldSource }) {
  const who = source.kind === "said" && source.name ? `${source.name} 說` : SOURCE_KIND[source.kind];
  const unsure = source.confidence < 0.5;
  return (
    <span
      className="ml-1.5 whitespace-nowrap text-[11px] text-muted-foreground"
      title={`${SOURCE_KIND[source.kind]} · 信心 ${source.confidence.toFixed(2)} · ${fmtDateTime(source.at)}${source.origin ? ` · ${source.origin}` : ""}`}
    >
      ({who}
      {unsure ? "・不確定" : ""})
    </span>
  );
}

const token = (k: string) => k.replaceAll("~", "~0").replaceAll("/", "~1");

/**
 * Any JSON she wrote, readable: objects as label/value rows, lists as bullets, text as text
 * (her Markdown kept as typed, line breaks kept). Sources are shown where they change.
 */
export function JsonTree({
  value,
  path = "",
  sources = {},
  parent,
}: {
  value: unknown;
  path?: string;
  sources?: Record<string, FieldSource>;
  parent?: FieldSource;
}): ReactNode {
  const own = sources[path];
  const here = own ?? parent;
  const tag = own && own !== parent && path !== "" ? <SourceTag source={own} /> : null;
  if (value === null || typeof value !== "object") {
    const text = value === null ? "—" : String(value);
    return (
      <span className="whitespace-pre-wrap break-words leading-relaxed">
        {typeof value === "boolean" ? (value ? "是" : "否") : text}
        {tag}
      </span>
    );
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">(空){tag}</span>;
    const scalars = value.every((v) => v === null || typeof v !== "object");
    return (
      <>
        {tag}
        <ul className={scalars ? "flex flex-wrap gap-1.5" : "grid list-disc gap-1.5 pl-4 marker:text-muted-foreground"}>
          {value.map((v, i) => (
            <li
              key={`${path}/${i}`}
              className={scalars ? "rounded-md border bg-well px-2 py-0.5 text-[13px]" : undefined}
            >
              <JsonTree value={v} path={`${path}/${i}`} sources={sources} parent={here} />
            </li>
          ))}
        </ul>
      </>
    );
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <span className="text-muted-foreground">(空){tag}</span>;
  return (
    <>
      {tag}
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)]">
        {entries.map(([k, v]) => {
          const p = `${path}/${token(k)}`;
          return (
            <div key={p} className="contents">
              <dt className="text-[13px] text-muted-foreground">{k}</dt>
              <dd className="min-w-0 text-sm">
                <JsonTree value={v} path={p} sources={sources} parent={here} />
              </dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}

function DocCard({ doc }: { doc: KnowledgeDoc }) {
  const root = doc.sources[""];
  return (
    <article className="grid gap-3 py-3" aria-label={`${doc.kind}「${doc.title}」`}>
      <header className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <h4 className="font-medium">{doc.title}</h4>
        <Badge variant="outline">{doc.kind}</Badge>
        <code className="font-mono text-xs text-muted-foreground">{doc.short_id}</code>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          v{doc.version} · <When at={doc.updated_at} />
          {root && <SourceTag source={root} />}
        </span>
      </header>
      <JsonTree value={doc.content} sources={doc.sources} parent={root} />
      {doc.history.length > 0 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none hover:text-foreground">改過 {doc.history.length} 次</summary>
          <ol className="mt-2 grid gap-1" aria-label="版本">
            {[...doc.history].reverse().map((h) => (
              <li key={h.version} className="font-mono">
                v{h.version} · {fmtDateTime(h.at)} · {h.name ?? SOURCE_KIND[h.by]}
                {h.why ? ` · ${h.why}` : ""} · {h.ops.join("、")}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  );
}

interface Group {
  key: string;
  label: string;
  kind: string;
  docs: KnowledgeDoc[];
}

function groups(docs: KnowledgeDoc[]): Group[] {
  const out = new Map<string, Group>();
  for (const d of docs) {
    const s = d.subject;
    const key = s.type === "person" ? `p:${s.person}` : s.type === "guild" ? `g:${s.guild}` : s.type === "topic" ? `t:${s.name}` : "self";
    const g = out.get(key) ?? { key, label: d.subject_label, kind: SUBJECT_KIND[s.type], docs: [] };
    g.docs.push(d);
    out.set(key, g);
  }
  // Herself first, then the most recently changed.
  return [...out.values()]
    .map((g) => ({ ...g, docs: [...g.docs].sort((a, b) => a.kind.localeCompare(b.kind, "zh-TW") || b.updated_at.localeCompare(a.updated_at)) }))
    .sort((a, b) => (a.key === "self" ? -1 : b.key === "self" ? 1 : (b.docs[0]?.updated_at ?? "").localeCompare(a.docs[0]?.updated_at ?? "")));
}

function DocumentsCard() {
  const knowledge = useKnowledge();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          她整理的資料
          {knowledge.data && knowledge.data.documents.length > 0 && (
            <span className="font-normal text-muted-foreground tabular-nums">{knowledge.data.documents.length}</span>
          )}
        </CardTitle>
      </CardHeader>
      <QueryView query={knowledge} skeleton={<SkeletonRows count={3} />}>
        {(k) =>
          k.documents.length === 0 ? (
            <EmptyLine>她還沒有整理任何資料</EmptyLine>
          ) : (
            <div className="divide-y divide-line-soft">
              {groups(k.documents).map((g) => (
                <section key={g.key} aria-label={g.label}>
                  <h3 className="flex items-baseline gap-2 pt-3 pb-1 text-[13px] font-medium">
                    {g.label}
                    <span className="text-xs font-normal text-muted-foreground">{g.kind}</span>
                  </h3>
                  <div className="divide-y divide-line-soft">
                    {g.docs.map((d) => (
                      <DocCard key={d.id} doc={d} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )
        }
      </QueryView>
    </Card>
  );
}

function NoteItem({ n }: { n: ConversationNote }) {
  return (
    <li className="grid gap-x-6 gap-y-2 py-3 sm:grid-cols-[10rem_minmax(0,1fr)]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[13px] text-muted-foreground sm:flex-col sm:gap-1">
        <span className="font-medium text-foreground">{n.label ?? contextShort(n.context)}</span>
        <When at={n.updated_at} />
        <span className="tabular-nums">
          {n.lines} 句 · 整理 {n.folds} 次
        </span>
      </div>
      <div className="grid min-w-0 gap-2.5">
        <p className="max-w-[70ch] leading-relaxed">{n.recap}</p>
        {Object.keys(n.notes).length > 0 && <JsonTree value={n.notes} />}
      </div>
    </li>
  );
}

function ConversationsCard() {
  const notes = useConversationNotes();
  return (
    <Card>
      <CardHeader>
        <CardTitle>對話筆記</CardTitle>
      </CardHeader>
      <QueryView query={notes} skeleton={<SkeletonRows count={2} />}>
        {(list) =>
          list.length === 0 ? (
            <EmptyLine>還沒有整理過任何對話</EmptyLine>
          ) : (
            <ol className="divide-y divide-line-soft" aria-label="對話筆記">
              {list.map((n) => (
                <NoteItem key={`${n.context.platform}:${n.context.scope}:${n.context.kind}:${n.context.channel}`} n={n} />
              ))}
            </ol>
          )
        }
      </QueryView>
    </Card>
  );
}

export function KnowledgeTab() {
  return (
    <div className="grid gap-(--stage-gap)">
      <DocumentsCard />
      <ConversationsCard />
    </div>
  );
}
