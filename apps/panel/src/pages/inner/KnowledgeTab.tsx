import type { ReactNode } from "react";
import type { ConversationNote, FieldSource } from "@miyoria/contracts/api";
import { useConversationNotes } from "@/app/queries";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { contextShort, fmtDateTime, fmtRelative } from "@/lib/format";
import { NotesBrowser } from "./NotesBrowser";

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
      <NotesBrowser />
      <ConversationsCard />
    </div>
  );
}
