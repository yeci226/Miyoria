// One subsystem (`/system/$id`, docs/design/v5-settings.md §7.2): its state and card, the settings
// the panel may change (drawn from the descriptor Core sends), and their change log. A save is one
// button, 「儲存並重新啟動 X」: Core writes the next config revision and restarts the module, or
// waits for her to finish singing / the stream to end when the restart would stop what she is
// using, which the button's confirm says first. The form keeps its own draft; it does not check
// values beyond HTML's limits, Core's problems come back under each field.

import { getRouteApi, Link } from "@tanstack/react-router";
import { ChevronLeft, Power, PowerOff, RotateCcw, RotateCw } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import type { ModuleDetail, ModuleSettings, SettingField, SettingsChange } from "@miyoria/contracts/api";
import type { JsonValue } from "@miyoria/contracts/wire";
import { isApiError } from "@/api/http";
import type { ModuleAction } from "@/api/types";
import { useModuleAction, useModuleDetail, useModuleSettings, usePlaceRooms, useRevertSettings, useSaveSettings, useSettingsHistory } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { Page, PageHeader } from "@/components/page";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { CardActions, Facts, fmtWhen, guardWords, ModuleIcon, NoteLine, StateLine } from "./module-bits";
import { DRAWN_KINDS, roomIndex, SettingControl, valueText } from "./setting-fields";

const route = getRouteApi("/system/$id");

const VERB: Record<ModuleAction, string> = { enable: "啟用", disable: "停用", restart: "重新啟動" };

/** The API module refuses to stop itself. */
const SELF_ID = "api";

// --- state ------------------------------------------------------------------------------------

function ModuleActions({ m }: { m: ModuleDetail }) {
  const action = useModuleAction();
  const [pending, setPending] = useState<ModuleAction | null>(null);
  if (m.id === SELF_ID) return null;
  const offered: ModuleAction[] = m.enabled ? (m.required ? ["restart"] : ["restart", "disable"]) : ["enable"];
  const Icon = { enable: Power, disable: PowerOff, restart: RotateCw } as const;
  return (
    <>
      {offered.map((a) => {
        const I = Icon[a];
        return (
          <Button key={a} size="sm" variant="outline" writes onClick={() => setPending(a)}>
            <I />
            {VERB[a]}
          </Button>
        );
      })}
      <ConfirmDialog
        open={pending !== null}
        title={pending ? `${VERB[pending]}「${m.name}」?` : ""}
        confirmLabel={pending ? VERB[pending] : ""}
        busy={action.isPending}
        onClose={() => setPending(null)}
        onConfirm={() =>
          pending &&
          action.mutate(
            { id: m.id, action: pending },
            {
              onSuccess: () => {
                notify.ok(`已${VERB[pending]} ${m.name}`);
                setPending(null);
              },
              onError: (e) => notify.error(e, `${VERB[pending]}失敗`),
            },
          )
        }
      >
        {pending === "disable"
          ? m.dependents.length > 0
            ? `依賴它的 ${m.dependents.join("、")} 會跟著停止。`
            : "它會停止,直到再次啟用。"
          : pending === "restart"
            ? "進行中的工作可能中斷。"
            : null}
      </ConfirmDialog>
    </>
  );
}

function StatusBlock({ m }: { m: ModuleDetail }) {
  const card = m.card ?? null;
  return (
    <section aria-label="狀態" className="flex flex-col gap-4">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <Link
          to="/system"
          className="-ml-1.5 inline-flex items-center rounded-sm p-1 text-muted-foreground outline-none hover:text-foreground focus-visible:text-foreground"
          aria-label="回到系統"
        >
          <ChevronLeft className="size-4" />
        </Link>
        <ModuleIcon name={m.icon} />
        <h2 className="min-w-0 truncate text-[15px] font-semibold tracking-[-0.01em]">{m.name}</h2>
        <StateLine state={m.state} />
        <span className="font-mono text-xs text-muted-foreground">{m.id}</span>
      </div>
      {(m.requires.length > 0 || m.dependents.length > 0 || m.recent_restarts > 0) && (
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[13px]">
          {m.requires.length > 0 && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">依賴</dt>
              <dd className="font-mono text-xs leading-5">{m.requires.join("、")}</dd>
            </div>
          )}
          {m.dependents.length > 0 && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">重新啟動時一起</dt>
              <dd className="font-mono text-xs leading-5">{m.dependents.join("、")}</dd>
            </div>
          )}
          {m.recent_restarts > 0 && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">最近自動重啟</dt>
              <dd className="tabular-nums">{m.recent_restarts} 次</dd>
            </div>
          )}
        </dl>
      )}
      {card && card.facts.length > 0 && <Facts facts={card.facts} className="max-w-3xl sm:grid-cols-4" />}
      <NoteLine module={m} />
      {card?.actions && card.actions.length > 0 && m.enabled && (
        <div className="flex flex-wrap gap-2">
          <CardActions id={m.id} actions={card.actions} />
        </div>
      )}
    </section>
  );
}

// --- settings ---------------------------------------------------------------------------------

interface Draft {
  set: Record<string, JsonValue>;
  reset: string[];
}
const EMPTY: Draft = { set: {}, reset: [] };

function problemsOf(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.status !== 400) return {};
  const body = error.body as { problems?: { path: string; message: string }[] } | null;
  const out: Record<string, string> = {};
  for (const p of body?.problems ?? []) out[p.path] = out[p.path] ? `${out[p.path]};${p.message}` : p.message;
  return out;
}

function FieldRow({
  field,
  view,
  draft,
  problem,
  canEdit,
  onSet,
  onReset,
  rooms,
}: {
  field: SettingField;
  view: ModuleSettings;
  draft: Draft;
  problem: string | undefined;
  canEdit: boolean;
  onSet: (path: string, value: JsonValue) => void;
  onReset: (path: string) => void;
  rooms: ReturnType<typeof roomIndex>;
}) {
  const id = useId();
  const saved = view.values[field.path];
  const resetting = draft.reset.includes(field.path);
  const changed = field.path in draft.set;
  const value: JsonValue | null = changed ? (draft.set[field.path] as JsonValue) : resetting ? (saved?.file_set ? saved.file : field.default) : (saved?.value ?? field.default);
  const helpId = field.help ? `${id}-help` : undefined;
  const errId = problem ? `${id}-err` : undefined;
  const describedBy = [helpId, errId].filter(Boolean).join(" ") || undefined;
  const fromPanel = saved?.source === "panel" && !resetting;
  const drawn = DRAWN_KINDS.has(field.kind) && !field.secret;
  const isSwitch = field.kind === "switch";

  return (
    <div className="grid gap-x-6 gap-y-1.5 border-b border-line-soft py-(--row-y) last:border-0 md:grid-cols-[12rem_minmax(0,1fr)]">
      <div className={cn("flex items-center gap-2 self-start md:min-h-8", isSwitch && "md:min-h-6")}>
        <Label htmlFor={id} className="font-normal leading-snug text-foreground/90">
          {field.label}
        </Label>
        {(changed || resetting) && <span className="size-1.5 shrink-0 rounded-full bg-primary" role="img" aria-label="沒存" />}
      </div>
      <div className="flex min-w-0 flex-col gap-1.5">
        {field.secret ? (
          <p className="text-[13px] text-muted-foreground">{saved?.set ? "已設定" : "沒設"} · 只能在 miyoria.toml 或 .env 改</p>
        ) : drawn ? (
          <SettingControl
            field={field}
            id={id}
            value={value}
            onChange={(v) => onSet(field.path, v)}
            disabled={!canEdit}
            invalid={problem !== undefined}
            describedBy={describedBy}
            currency={view.currency}
          />
        ) : (
          <SettingControl field={field} id={id} value={value} onChange={() => undefined} disabled invalid={false} describedBy={undefined} currency={view.currency} />
        )}
        {field.help && (
          <p id={helpId} className="text-[13px] text-muted-foreground">
            {field.help}
          </p>
        )}
        {fromPanel && (
          <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
            <span>
              面板改過 · 檔案:{valueText(field, saved?.file_set ? saved.file : null, view.currency, rooms)}
            </span>
            {canEdit && (
              <button type="button" className="rounded-sm text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline" onClick={() => onReset(field.path)}>
                還原成檔案的值
              </button>
            )}
          </p>
        )}
        {resetting && <p className="text-[13px] text-muted-foreground">存了之後改回檔案的值</p>}
        {saved?.invalid && !changed && (
          <p className="text-[13px] text-primary" role="alert">
            面板存的值不再有效,現在用的是檔案或預設值:{saved.invalid}
          </p>
        )}
        {field.apply === "core" && <p className="text-[13px] text-muted-foreground">改了要重新啟動 Core 才生效</p>}
        {field.danger && <p className="text-[13px] text-primary">{field.danger}</p>}
        {problem && (
          <p id={errId} role="alert" className="text-[13px] text-primary">
            {problem}
          </p>
        )}
      </div>
    </div>
  );
}

function SettingsForm({ view, onConflict }: { view: ModuleSettings; onConflict: () => void }) {
  const save = useSaveSettings(view.module);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const needsRooms = view.fields.some((f) => f.kind === "channel");
  const roomsQuery = usePlaceRooms(null, needsRooms);
  const byField = useMemo(() => new Map(view.fields.map((f) => [f.path, roomIndex(f, roomsQuery.data?.rooms ?? [])])), [view.fields, roomsQuery.data]);

  const dirty = Object.keys(draft.set).length + draft.reset.length;
  const canEdit = view.can_edit;
  const dangers = view.fields.filter((f) => f.danger && f.path in draft.set);
  const guard = view.guard;

  const onSet = (path: string, value: JsonValue) => {
    setDraft((d) => ({ set: { ...d.set, [path]: value }, reset: d.reset.filter((p) => p !== path) }));
    setProblems(({ [path]: _, ...rest }) => rest);
  };
  const onReset = (path: string) => {
    setDraft((d) => {
      const { [path]: _, ...set } = d.set;
      return { set, reset: d.reset.includes(path) ? d.reset : [...d.reset, path] };
    });
  };
  const cancel = () => {
    setDraft(EMPTY);
    setProblems({});
  };

  const submit = () =>
    save.mutate(
      { expected: view.revision, set: draft.set, reset: draft.reset },
      {
        onSuccess: (r) => {
          setConfirming(false);
          setDraft(EMPTY);
          setProblems({});
          if (r.applied === "unchanged") notify.ok("沒有變更");
          else if (r.applied === "deferred") notify.ok(`已儲存,${guardWords(guard ?? "")}後重新啟動${view.name}`);
          else if (r.applied === "stored") notify.ok(`已儲存,${view.name}啟用時套用`);
          else if (r.state === "running") notify.ok(`已儲存,${view.name}重新啟動了`);
          else notify.error(new Error(r.reason ?? "沒有起來"), `已儲存,但${view.name}沒有起來`);
        },
        onError: (e) => {
          setConfirming(false);
          const found = problemsOf(e);
          if (Object.keys(found).length > 0) {
            setProblems(found);
            notify.error(new Error(`${Object.keys(found).length} 項的值不對,改好再存`), "沒有儲存");
          } else if (isApiError(e) && e.status === 409) {
            notify.error(e, "沒有儲存");
            onConflict();
          } else notify.error(e, "儲存失敗");
        },
      },
    );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (dirty === 0 || !canEdit) return;
    if (guard !== null || dangers.length > 0) setConfirming(true);
    else submit();
  };

  // Leaving the page with unsaved changes asks the browser's question.
  useEffect(() => {
    if (dirty === 0) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const groups = [...view.groups, { id: "", label: "其他" }]
    .map((g) => ({ ...g, fields: view.fields.filter((f) => (f.group ?? "") === g.id || (g.id === "" && f.group !== null && !view.groups.some((x) => x.id === f.group))) }))
    .filter((g) => g.fields.length > 0);
  const buttonLabel = `儲存並重新啟動${view.name}`;

  return (
    <form onSubmit={onSubmit} aria-label={`${view.name}的設定`} className="flex flex-col gap-6">
      {!canEdit && <p className="text-[13px] text-muted-foreground">你只能看:改這個子系統的設定要有 admin.settings.{view.module}</p>}
      {groups.map((g) => (
        <fieldset key={g.id} className="flex min-w-0 flex-col">
          <legend className="mb-1 text-[13px] font-semibold text-foreground">{g.label}</legend>
          {g.fields.map((f) => (
            <FieldRow key={f.path} field={f} view={view} draft={draft} problem={problems[f.path]} canEdit={canEdit} onSet={onSet} onReset={onReset} rooms={byField.get(f.path) ?? new Map()} />
          ))}
        </fieldset>
      ))}
      {dirty > 0 && (
        <div
          role="region"
          aria-label="沒存的變更"
          className="sticky bottom-3 z-10 -mx-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-line-strong bg-[rgba(8,9,14,0.82)] px-4 py-3 backdrop-blur-md [text-shadow:none] sm:mx-0"
        >
          <span className="text-[13px]">
            有 <span className="tabular-nums">{dirty}</span> 項沒存
            {guard && <span className="text-muted-foreground"> · {guardWords(guard)}後才會重新啟動</span>}
          </span>
          <span className="flex-1" />
          <Button type="button" variant="outline" onClick={cancel} disabled={save.isPending}>
            取消
          </Button>
          <Button type="submit" writes busy={save.isPending && !confirming}>
            {buttonLabel}
          </Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={guard ? `現在存,${guardWords(guard)}後才重新啟動${view.name}` : `${buttonLabel}?`}
        confirmLabel={guard ? "儲存,之後套用" : buttonLabel}
        busy={save.isPending}
        onClose={() => setConfirming(false)}
        onConfirm={submit}
      >
        <div className="flex flex-col gap-2">
          {guard && <p>現在重新啟動會打斷她。設定會先存起來,{guardWords(guard)}再自動重新啟動{view.name}套用。</p>}
          {dangers.map((f) => (
            <p key={f.path}>
              {f.label}:{f.danger}
            </p>
          ))}
        </div>
      </ConfirmDialog>
    </form>
  );
}

function SettingsBlock({ id }: { id: string }) {
  const settings = useModuleSettings(id);
  const view = settings.data;
  return (
    <Card aria-labelledby="settings-title">
      <CardHeader>
        <CardTitle id="settings-title">設定</CardTitle>
        {view?.updated && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            第 {view.updated.version} 版 · {view.updated.by_label} · {fmtWhen(view.updated.at)}
          </span>
        )}
      </CardHeader>
      {settings.isPending ? (
        <SkeletonRows count={5} />
      ) : settings.isError ? (
        isApiError(settings.error) && settings.error.status === 403 ? (
          <EmptyLine>你沒有權限看這個子系統的設定</EmptyLine>
        ) : (
          <ErrorLine error={settings.error} onRetry={() => void settings.refetch()} />
        )
      ) : view && view.fields.length === 0 ? (
        <EmptyLine>這個子系統沒有能在面板上改的設定</EmptyLine>
      ) : view ? (
        // A new revision (another save, a revert) starts the form over from what Core has.
        <SettingsForm key={view.revision} view={view} onConflict={() => void settings.refetch()} />
      ) : null}
      {view?.pending && <p className="text-[13px] text-muted-foreground">已存的變更{guardWords(view.pending)}後套用</p>}
    </Card>
  );
}

// --- change log -------------------------------------------------------------------------------

function ChangeLog({ id }: { id: string }) {
  const history = useSettingsHistory(id);
  const settings = useModuleSettings(id);
  const revert = useRevertSettings(id);
  const rooms = usePlaceRooms(null, settings.data?.fields.some((f) => f.kind === "channel") ?? false);
  const [asking, setAsking] = useState<SettingsChange | null>(null);
  const view = settings.data;
  const items = history.data?.pages.flatMap((p) => p.items) ?? [];
  const fieldOf = (path: string) => view?.fields.find((f) => f.path === path);

  if (view && view.fields.length === 0 && items.length === 0) return null;
  return (
    <Card aria-labelledby="log-title">
      <CardHeader>
        <CardTitle id="log-title">變更紀錄</CardTitle>
      </CardHeader>
      {history.isPending ? (
        <SkeletonRows count={3} />
      ) : history.isError ? (
        <ErrorLine error={history.error} onRetry={() => void history.refetch()} />
      ) : items.length === 0 ? (
        <EmptyLine>還沒有在面板上改過</EmptyLine>
      ) : (
        <ol className="flex flex-col">
          {items.map((item, i) => (
            <li key={item.version} className="grid gap-x-6 gap-y-1 border-b border-line-soft py-(--row-y) last:border-0 md:grid-cols-[12rem_minmax(0,1fr)_auto]">
              <div className="flex flex-wrap gap-x-2 text-[13px] text-muted-foreground md:flex-col md:gap-0">
                <span className="tabular-nums text-foreground">{fmtWhen(item.at)}</span>
                <span>
                  {item.by_label} · 第 {item.version} 版
                </span>
              </div>
              <ul className="flex min-w-0 flex-col gap-0.5 text-[13px]">
                {item.changes.map((c) => {
                  const f = fieldOf(c.path);
                  const index = f ? roomIndex(f, rooms.data?.rooms ?? []) : undefined;
                  return (
                    <li key={c.path} className="min-w-0 break-words">
                      <span className="font-medium">{c.label}</span>{" "}
                      <span className="text-muted-foreground">{c.before === null ? "檔案的值" : valueText(f, c.before, view?.currency ?? "", index)}</span>
                      {" → "}
                      <span>{c.after === null ? "檔案的值" : valueText(f, c.after, view?.currency ?? "", index)}</span>
                    </li>
                  );
                })}
                {item.note && <li className="text-muted-foreground">{item.note}</li>}
              </ul>
              {view?.can_edit && (
                <Button size="sm" variant="ghost" writes className="justify-self-start md:justify-self-end" onClick={() => setAsking(item)}>
                  <RotateCcw />
                  {i === 0 ? "復原這次" : "回到這次之前"}
                </Button>
              )}
            </li>
          ))}
        </ol>
      )}
      {history.hasNextPage && (
        <Button variant="outline" size="sm" className="self-start" busy={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
          載入更多
        </Button>
      )}
      <ConfirmDialog
        open={asking !== null}
        title={asking ? `把${view?.name ?? ""}的設定回到第 ${asking.version} 版之前?` : ""}
        confirmLabel={`還原並重新啟動${view?.name ?? ""}`}
        busy={revert.isPending}
        onClose={() => setAsking(null)}
        onConfirm={() =>
          asking &&
          view &&
          revert.mutate(
            { version: asking.version - 1, expected: view.revision },
            {
              onSuccess: () => {
                notify.ok("已還原");
                setAsking(null);
              },
              onError: (e) => notify.error(e, "還原失敗"),
            },
          )
        }
      >
        {asking && asking !== items[0] ? "這次和之後在面板上的變更都會拿掉。" : "這次的變更會拿掉。"}
        {view?.guard ? ` ${guardWords(view.guard)}後才會重新啟動。` : ""}
      </ConfirmDialog>
    </Card>
  );
}

// --- page -------------------------------------------------------------------------------------

export function ModulePage() {
  const { id } = route.useParams();
  const detail = useModuleDetail(id);
  const m = detail.data;
  return (
    <Page className="pb-24">
      <PageHeader title={m?.name ?? id} actions={m ? <ModuleActions m={m} /> : undefined} />
      {detail.isPending ? (
        <SkeletonRows count={3} />
      ) : detail.isError ? (
        isApiError(detail.error) && detail.error.kind === "not_found" ? (
          <div className="flex flex-col items-start gap-2">
            <EmptyLine>沒有「{id}」這個子系統</EmptyLine>
            <Button asChild variant="outline" size="sm">
              <Link to="/system">回到系統</Link>
            </Button>
          </div>
        ) : (
          <ErrorLine error={detail.error} onRetry={() => void detail.refetch()} />
        )
      ) : m ? (
        <>
          <StatusBlock m={m} />
          <SettingsBlock id={id} />
          <ChangeLog id={id} />
        </>
      ) : null}
    </Page>
  );
}
