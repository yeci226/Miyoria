import { History, Pencil, RotateCcw } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { PersonaOverride, PersonaSectionInfo } from "@/api/types";
import { usePersona, usePersonaHistory, useSetPersona } from "@/app/queries";
import { DiffView } from "@/components/diff-view";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Kbd } from "@/components/ui/misc";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";

export const EDITED_BY = "panel";

/** Edit → review the diff → save, in one dialog. Closing keeps the draft. */
function EditDialog({
  section,
  draft,
  setDraft,
  open,
  onOpenChange,
}: {
  section: PersonaSectionInfo;
  draft: string;
  setDraft: (v: string | undefined) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const save = useSetPersona();
  const [step, setStep] = useState<"edit" | "review">("edit");
  const id = useId();
  const next = draft.trim(); // the server trims before storing
  const current = section.body.trim();
  const dirty = next !== current;

  useEffect(() => {
    if (open) setStep("edit");
  }, [open]);

  const doSave = () =>
    save.mutate(
      { key: section.key, req: { body: next, edited_by: EDITED_BY } },
      {
        onSuccess: (r) => {
          notify.ok(`已儲存「${r.key}」v${r.version}`);
          setDraft(undefined);
          onOpenChange(false);
        },
        onError: (e) => notify.error(e, "儲存失敗"),
      },
    );

  return (
    <Dialog open={open} onOpenChange={(o) => !save.isPending && onOpenChange(o)}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <code className="text-sm">{section.key}</code>
            {step === "review" && <span className="text-muted-foreground">變更</span>}
          </DialogTitle>
        </DialogHeader>
        {step === "edit" ? (
          <>
            <Label htmlFor={`${id}-body`} className="sr-only">
              {section.key} 內容
            </Label>
            <Textarea
              id={`${id}-body`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "s") {
                  e.preventDefault();
                  if (dirty && next) setStep("review");
                }
              }}
              spellCheck={false}
              className="field-sizing-fixed h-[55dvh] resize-none font-mono text-[13px]"
            />
            <DialogFooter className="items-center">
              <Button variant="ghost" className="mr-auto" disabled={!dirty} onClick={() => setDraft(undefined)}>
                捨棄修改
              </Button>
              <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:flex">
                <Kbd>Ctrl</Kbd>
                <Kbd>S</Kbd>
              </span>
              <Button writes disabled={!dirty || !next} onClick={() => setStep("review")}>
                檢視變更
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DiffView before={current} after={next} />
            <DialogFooter>
              <Button variant="outline" disabled={save.isPending} onClick={() => setStep("edit")}>
                繼續編輯
              </Button>
              <Button writes busy={save.isPending} onClick={doSave} autoFocus>
                儲存
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function HistoryCard({ section, onRestore }: { section: PersonaSectionInfo; onRestore: (v: PersonaOverride) => void }) {
  const history = usePersonaHistory(section.key);
  const [comparing, setComparing] = useState<PersonaOverride | null>(null);
  const current = section.body.trim();
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <History className="size-4 text-muted-foreground" />
          版本
        </CardTitle>
      </CardHeader>
      <QueryView
        query={history}
        isEmpty={(d) => d.length === 0}
        empty="沒有修改紀錄"
        skeleton={<SkeletonRows count={2} />}
      >
        {(list) => {
          const sorted = [...list].sort((a, b) => b.version - a.version);
          const latest = sorted[0]?.version;
          return (
            <ul className="divide-y divide-line-soft">
              {sorted.map((v) => {
                const isCurrent = v.version === latest && v.body.trim() === current;
                return (
                  <li key={v.version} className="flex items-center gap-3 py-(--row-y)">
                    <span className="w-10 font-mono text-sm tabular-nums">v{v.version}</span>
                    {isCurrent && <Badge variant="brand">目前</Badge>}
                    <span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
                      <time dateTime={v.edited_at} title={fmtDateTime(v.edited_at)}>
                        {fmtRelative(v.edited_at)}
                      </time>
                      {" · "}
                      {v.edited_by}
                    </span>
                    <Button size="sm" variant="ghost" onClick={() => setComparing(v)}>
                      比較
                    </Button>
                    {!isCurrent && (
                      <Button writes size="sm" variant="outline" onClick={() => onRestore(v)}>
                        <RotateCcw />
                        還原
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          );
        }}
      </QueryView>
      <Dialog open={comparing !== null} onOpenChange={(o) => !o && setComparing(null)}>
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>目前 → v{comparing?.version}</DialogTitle>
          </DialogHeader>
          {comparing && <DiffView before={current} after={comparing.body.trim()} label={`目前 → v${comparing.version}`} />}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export function PersonaTab() {
  const persona = usePersona();
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState(false);

  const sections = persona.data ?? [];
  const current = useMemo(() => sections.find((s) => s.key === selected) ?? sections[0], [sections, selected]);
  const isDirty = (s: PersonaSectionInfo) => drafts[s.key] !== undefined && drafts[s.key]?.trim() !== s.body.trim();

  // Drafts survive switching sections; warn before a reload throws them away.
  const anyDirty = sections.some(isDirty);
  useEffect(() => {
    if (!anyDirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDirty]);

  const setDraft = (key: string, v: string | undefined) =>
    setDrafts((d) => {
      const next = { ...d };
      if (v === undefined) delete next[key];
      else next[key] = v;
      return next;
    });

  return (
    <QueryView query={persona} isEmpty={(d) => d.length === 0} empty="Persona 沒有任何段落">
      {() =>
        current ? (
          <div className="grid items-start gap-(--stage-gap) md:grid-cols-[13rem_minmax(0,1fr)]">
            <nav aria-label="Persona 段落" className="grid gap-0.5 max-md:grid-cols-2">
              {sections.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  aria-current={s.key === current.key ? "true" : undefined}
                  onClick={() => setSelected(s.key)}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-md px-2.5 text-left font-mono text-[13px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
                    s.key === current.key && "bg-accent text-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{s.key}</span>
                  {isDirty(s) && <Dot tone="warning" />}
                </button>
              ))}
            </nav>
            <div className="grid min-w-0 gap-(--stage-gap)">
              <Card>
                <CardHeader>
                  <CardTitle>
                    <code>{current.key}</code>
                  </CardTitle>
                  <CardAction>
                    {isDirty(current) && <Badge variant="warning">草稿</Badge>}
                    <span className="text-[13px] text-muted-foreground tabular-nums">{current.body.length} 字</span>
                    <Button writes size="sm" variant="outline" onClick={() => setEditing(true)}>
                      <Pencil />
                      編輯
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent>
                  {current.body.trim() ? (
                    <pre className="max-h-[50dvh] overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm leading-relaxed text-foreground/90">
                      {current.body}
                    </pre>
                  ) : (
                    <EmptyLine>空白</EmptyLine>
                  )}
                </CardContent>
              </Card>
              <HistoryCard
                key={current.key}
                section={current}
                onRestore={(v) => {
                  setDraft(current.key, v.body);
                  setEditing(true);
                }}
              />
              <EditDialog
                section={current}
                draft={drafts[current.key] ?? current.body}
                setDraft={(v) => setDraft(current.key, v)}
                open={editing}
                onOpenChange={setEditing}
              />
            </div>
          </div>
        ) : null
      }
    </QueryView>
  );
}
