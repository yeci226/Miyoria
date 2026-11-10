import { useMemo } from "react";
import { type DiffLine, diffLines, diffStats } from "@/lib/diff";
import { cn } from "@/lib/utils";

type Chunk = { kind: "lines"; lines: DiffLine[] } | { kind: "fold"; count: number };

/** Collapses unchanged runs longer than `2 * context` lines. */
export function foldDiff(lines: DiffLine[], context = 3): Chunk[] {
  const out: Chunk[] = [];
  let buf: DiffLine[] = [];
  const flush = () => {
    if (buf.length) out.push({ kind: "lines", lines: buf });
    buf = [];
  };
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.op !== "same") {
      buf.push(lines[i] as DiffLine);
      i++;
      continue;
    }
    let j = i;
    while (j < lines.length && lines[j]?.op === "same") j++;
    const run = lines.slice(i, j);
    const keepHead = i === 0 ? 0 : context;
    const keepTail = j === lines.length ? 0 : context;
    if (run.length > keepHead + keepTail + 1) {
      buf.push(...run.slice(0, keepHead));
      flush();
      out.push({ kind: "fold", count: run.length - keepHead - keepTail });
      buf.push(...run.slice(run.length - keepTail));
    } else {
      buf.push(...run);
    }
    i = j;
  }
  flush();
  return out;
}

export function DiffView({ before, after, label = "變更" }: { before: string; after: string; label?: string }) {
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const stats = diffStats(lines);
  const chunks = useMemo(() => foldDiff(lines), [lines]);

  if (stats.added === 0 && stats.removed === 0) {
    return <p className="text-sm text-muted-foreground">內容相同</p>;
  }

  return (
    <div className="grid gap-2">
      <p className="flex items-center gap-2 font-mono text-xs">
        <span className="text-secondary-line">+{stats.added}</span>
        <span className="text-primary">−{stats.removed}</span>
      </p>
      <div
        className="max-h-[55dvh] overflow-auto rounded-md border bg-well font-mono text-[12.5px] leading-6"
        role="table"
        aria-label={label}
        tabIndex={0}
      >
        {chunks.map((c, ci) =>
          c.kind === "fold" ? (
            <div key={`f${ci}`} role="row" className="border-y border-dashed bg-hover px-3 text-muted-foreground">
              <span role="cell">⋯ {c.count} 行未變更</span>
            </div>
          ) : (
            c.lines.map((l, li) => (
              <div
                key={`${ci}-${li}`}
                role="row"
                className={cn(
                  "grid grid-cols-[2.5rem_2.5rem_1.25rem_1fr] whitespace-pre-wrap",
                  l.op === "add" && "bg-secondary/20",
                  l.op === "del" && "bg-primary/12",
                )}
              >
                <span role="cell" className="select-none pr-2 text-right text-muted-foreground/70">
                  {l.oldNo ?? ""}
                </span>
                <span role="cell" className="select-none pr-2 text-right text-muted-foreground/70">
                  {l.newNo ?? ""}
                </span>
                <span
                  role="cell"
                  className={cn("select-none text-center", l.op === "add" ? "text-secondary-line" : "text-primary")}
                  aria-label={l.op === "add" ? "新增" : l.op === "del" ? "刪除" : undefined}
                >
                  {l.op === "add" ? "+" : l.op === "del" ? "−" : ""}
                </span>
                <span role="cell" className="break-words pr-3">
                  {l.text || " "}
                </span>
              </div>
            ))
          ),
        )}
      </div>
    </div>
  );
}
