// One subsystem (`/system/$id`, docs/design/v5-settings.md §7.2): its state and card, the settings
// the panel may change (drawn from the descriptor Core sends), and their change log. A save is one
// button, 「儲存並重新啟動 X」: Core writes the next config revision and restarts the module, or
// waits for her to finish singing / the stream to end when the restart would stop what she is
// using, which the button's confirm says first. The form keeps its own draft; it does not check
// values beyond HTML's limits, Core's problems come back under each field.
//
// A field that may differ per server or per channel (docs/design/v5-places.md) can be set for the
// server picked in the header (`?space=`) or for one of its channels: 範圍 switches the form to
// that place's own values, which apply at once, with no restart. The switch is drawn only when it
// means something (more than one server, or a field per channel).

import { getRouteApi, Link } from "@tanstack/react-router";
import { ChevronLeft, Power, PowerOff, RotateCcw, RotateCw } from "lucide-react";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import type { ModuleDetail, ModuleSettings, SettingField, SettingsChange, SettingValue } from "@miyoria/contracts/api";
import type { JsonValue } from "@miyoria/contracts/wire";
import { isApiError } from "@/api/http";
import type { ModuleAction } from "@/api/types";
import { type SettingsPlaceArg, useModuleAction, useModuleDetail, useModuleSettings, usePlaceRooms, useRevertSettings, useSaveSettings, useSettingsHistory } from "@/app/queries";
import { useAdminSpace } from "@/app/space";
import { ConfirmDialog } from "@/components/confirm";
import { Page, PageHeader } from "@/components/page";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { CardActions, Facts, fmtWhen, guardWords, ModuleIcon, NoteLine, StateLine } from "./module-bits";
import { DRAWN_KINDS, RoomPicker, roomIndex, SettingControl, valueText } from "./setting-fields";

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

/**
 * Which values the form changes: the whole install's (`cluster`), the selected server's own, or one
 * of its channels' own. A server's and a channel's take effect at once, with no restart.
 */
type Scope = "cluster" | "space" | "room";

/** Where a place's inherited value comes from, in words. */
function inheritedWords(from: SettingValue["source"]): string {
  if (from === "room") return "上層頻道";
  if (from === "space") return "這個伺服器";
  return "全部";
}

/** The place line under a field of a server's or a channel's values. */
function PlaceLine({ field, saved, scope, resetting, canEdit, onReset, view, rooms }: { field: SettingField; saved: SettingValue | undefined; scope: Scope; resetting: boolean; canEdit: boolean; onReset: () => void; view: ModuleSettings; rooms: ReturnType<typeof roomIndex> }) {
  const place = saved?.place;
  if (!place) return null;
  const here = scope === "room" ? "這個頻道" : "這個伺服器";
  const inherited = valueText(field, place.inherited, view.currency, rooms);
  if (resetting) return <p className="text-[13px] text-muted-foreground">存了之後改回{inheritedWords(place.inherited_from)}的值:{inherited}</p>;
  if (!place.own_set) return <p className="text-[13px] text-muted-foreground">沿用{inheritedWords(place.inherited_from)}的值</p>;
  return (
    <p className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
      <span>
        {here}設的 · 拿掉後是 {inherited}
      </span>
      {canEdit && (
        <button type="button" className="rounded-sm text-foreground underline-offset-4 outline-none hover:underline focus-visible:underline" onClick={onReset}>
          拿掉{here}的值
        </button>
      )}
    </p>
  );
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
  scope,
  guild,
}: {
  field: SettingField;
  view: ModuleSettings;
  draft: Draft;
  problem: string | undefined;
  canEdit: boolean;
  onSet: (path: string, value: JsonValue) => void;
  onReset: (path: string) => void;
  rooms: ReturnType<typeof roomIndex>;
  scope: Scope;
  guild: string | null;
}) {
  const id = useId();
  const saved = view.values[field.path];
  const resetting = draft.reset.includes(field.path);
  const changed = field.path in draft.set;
  const atPlace = scope !== "cluster";
  const resetTo = atPlace ? (saved?.place?.inherited ?? field.default) : saved?.file_set ? saved.file : field.default;
  const value: JsonValue | null = changed ? (draft.set[field.path] as JsonValue) : resetting ? resetTo : (saved?.value ?? field.default);
  const helpId = field.help ? `${id}-help` : undefined;
  const errId = problem ? `${id}-err` : undefined;
  const describedBy = [helpId, errId].filter(Boolean).join(" ") || undefined;
  const fromPanel = !atPlace && saved?.source === "panel" && !resetting;
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
            guild={atPlace ? guild : null}
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
        {atPlace && <PlaceLine field={field} saved={saved} scope={scope} resetting={resetting} canEdit={canEdit} onReset={() => onReset(field.path)} view={view} rooms={rooms} />}
        {resetting && !atPlace && <p className="text-[13px] text-muted-foreground">存了之後改回檔案的值</p>}
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

function SettingsForm({ view, onConflict, scope, place, placeName, guild }: { view: ModuleSettings; onConflict: () => void; scope: Scope; place: SettingsPlaceArg | null; placeName: string; guild: string | null }) {
  const save = useSaveSettings(view.module, place);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);
  const atPlace = scope !== "cluster";
  // A server's or a channel's own values: only the fields that may differ there.
  const fields = scope === "cluster" ? view.fields : view.fields.filter((f) => (scope === "room" ? f.scope === "room" : f.scope !== "cluster"));
  const needsRooms = fields.some((f) => f.kind === "channel");
  const roomsQuery = usePlaceRooms(null, needsRooms);
  const byField = useMemo(() => new Map(view.fields.map((f) => [f.path, roomIndex(f, roomsQuery.data?.rooms ?? [])])), [view.fields, roomsQuery.data]);

  const dirty = Object.keys(draft.set).length + draft.reset.length;
  const canEdit = view.can_edit;
  const dangers = fields.filter((f) => f.danger && f.path in draft.set);
  // A place's values are in effect at once: nothing restarts, so nothing waits for a guard.
  const guard = atPlace ? null : view.guard;

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
          else if (r.applied === "immediate") notify.ok(`已套用到${placeName},不用重新啟動`);
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
    .map((g) => ({ ...g, fields: fields.filter((f) => (f.group ?? "") === g.id || (g.id === "" && f.group !== null && !view.groups.some((x) => x.id === f.group))) }))
    .filter((g) => g.fields.length > 0);
  const buttonLabel = atPlace ? `儲存到${placeName}` : `儲存並重新啟動${view.name}`;
  const elsewhere = view.fields.length - fields.length;

  return (
    <form onSubmit={onSubmit} aria-label={`${view.name}的設定`} className="flex flex-col gap-6">
      {!canEdit && (
        <p className="text-[13px] text-muted-foreground">
          你只能看:改{atPlace ? `${placeName}的` : "這個子系統的"}設定要有 admin.settings.{view.module}
        </p>
      )}
      {atPlace && fields.length === 0 && <EmptyLine>這個子系統沒有能{scope === "room" ? "每個頻道" : "每個伺服器"}不同的設定</EmptyLine>}
      {groups.map((g) => (
        <fieldset key={g.id} className="flex min-w-0 flex-col">
          <legend className="mb-1 text-[13px] font-semibold text-foreground">{g.label}</legend>
          {g.fields.map((f) => (
            <FieldRow key={f.path} field={f} view={view} draft={draft} problem={problems[f.path]} canEdit={canEdit} onSet={onSet} onReset={onReset} rooms={byField.get(f.path) ?? new Map()} scope={scope} guild={guild} />
          ))}
        </fieldset>
      ))}
      {atPlace && elsewhere > 0 && <p className="text-[13px] text-muted-foreground">其他 {elsewhere} 項設定所有地方都一樣,在「全部」裡改</p>}
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

/** Which values the page reads and changes: the whole install's, the selected server's, or a channel's. */
interface ScopeState {
  scope: Scope;
  setScope: (s: Scope) => void;
  /** The scopes worth offering; none (nothing drawn) when only `cluster` makes sense. */
  options: { value: Scope; label: string }[];
  room: string | null;
  setRoom: (room: string | null) => void;
  /** `null`: the whole install, or a channel scope with no channel picked yet. */
  place: SettingsPlaceArg | null;
  /** The server's platform id, for the channel pickers. */
  guild: string | null;
  spaceName: string;
}

/**
 * The scope switch's state. Offered only when it means something: more than one server and fields
 * that may differ per server, or fields that may differ per channel. With one server and no
 * per-channel field the page is the whole install's, as it always was.
 */
function useSettingsScope(fields: readonly SettingField[] | undefined): ScopeState {
  const { space, spaces, multiple } = useAdminSpace();
  const current = spaces.find((s) => s.id === space) ?? null;
  const [picked, setScope] = useState<Scope | null>(null);
  const [room, setRoom] = useState<string | null>(null);
  // Another server: its channels are others.
  useEffect(() => setRoom(null), [space]);
  const perSpace = multiple && (fields?.some((f) => f.scope !== "cluster") ?? false);
  const perRoom = fields?.some((f) => f.scope === "room") ?? false;
  const options: ScopeState["options"] = [];
  if (current !== null && (perSpace || perRoom)) {
    options.push({ value: "cluster", label: multiple ? "全部伺服器" : "全部" });
    if (perSpace) options.push({ value: "space", label: current.name });
    if (perRoom) options.push({ value: "room", label: "一個頻道" });
  }
  const offered = options.map((o) => o.value);
  const scope: Scope = picked !== null && offered.includes(picked) ? picked : perSpace && current !== null ? "space" : "cluster";
  const place: SettingsPlaceArg | null = current === null || scope === "cluster" ? null : scope === "space" ? { space: current.id } : room === null ? null : { space: current.id, room };
  return { scope, setScope, options, room, setRoom, place, guild: current?.external_id ?? null, spaceName: current?.name ?? "" };
}

function ScopeBar({ where }: { where: ScopeState }) {
  const id = useId();
  if (where.options.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <Segmented label="範圍" value={where.scope} options={where.options} onChange={(v) => where.setScope(v as Scope)} />
      {where.scope === "room" && (
        <div className="w-full max-w-sm min-w-56 flex-1">
          <RoomPicker id={id} guild={where.guild} value={where.room} onChange={where.setRoom} />
        </div>
      )}
    </div>
  );
}

function SettingsBlock({ id, where }: { id: string; where: ScopeState }) {
  const cluster = useModuleSettings(id);
  const atPlace = where.scope !== "cluster";
  const placeView = useModuleSettings(id, where.place);
  const settings = atPlace && where.place !== null ? placeView : cluster;
  const view = settings.data;
  const placeName = where.scope === "room" ? (view?.place?.room?.name ? `#${view.place.room.name}` : "這個頻道") : where.spaceName;
  return (
    <Card aria-labelledby="settings-title">
      <CardHeader>
        <CardTitle id="settings-title">設定</CardTitle>
        {view?.updated && !atPlace && (
          <span className="ml-auto text-xs text-muted-foreground tabular-nums">
            第 {view.updated.version} 版 · {view.updated.by_label} · {fmtWhen(view.updated.at)}
          </span>
        )}
      </CardHeader>
      <ScopeBar where={where} />
      {where.scope === "room" && where.place === null ? (
        <EmptyLine>選一個頻道</EmptyLine>
      ) : settings.isPending ? (
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
        // A new revision (another save, a revert) or another place starts the form over from what Core has.
        <SettingsForm
          key={`${view.revision}|${where.scope}|${where.place?.space ?? ""}|${where.place?.room ?? ""}`}
          view={view}
          onConflict={() => void settings.refetch()}
          scope={where.scope}
          place={where.place}
          placeName={placeName}
          guild={where.guild}
        />
      ) : null}
      {view?.pending && <p className="text-[13px] text-muted-foreground">已存的變更{guardWords(view.pending)}後套用</p>}
    </Card>
  );
}

// --- change log -------------------------------------------------------------------------------

function ChangeLog({ id, where }: { id: string; where: ScopeState }) {
  const atPlace = where.scope !== "cluster";
  // A channel scope with no channel picked yet has no log to show.
  const place = where.place;
  const history = useSettingsHistory(id, place);
  const settings = useModuleSettings(id);
  const revert = useRevertSettings(id);
  const rooms = usePlaceRooms(null, settings.data?.fields.some((f) => f.kind === "channel") ?? false);
  const [asking, setAsking] = useState<SettingsChange | null>(null);
  const view = settings.data;
  const items = history.data?.pages.flatMap((p) => p.items) ?? [];
  const fieldOf = (path: string) => view?.fields.find((f) => f.path === path);
  // What a missing value means: the file's for the whole install, what a place inherits for a place.
  const unset = place === null ? "檔案的值" : "繼承的值";

  if (atPlace && place === null) return null;
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
                <span>{place === null ? `${item.by_label} · 第 ${item.version} 版` : item.by_label}</span>
              </div>
              <ul className="flex min-w-0 flex-col gap-0.5 text-[13px]">
                {item.changes.map((c) => {
                  const f = fieldOf(c.path);
                  const index = f ? roomIndex(f, rooms.data?.rooms ?? []) : undefined;
                  return (
                    <li key={c.path} className="min-w-0 break-words">
                      {item.place?.scope === "room" && place?.room == null && <span className="text-muted-foreground">#{item.place.name ?? item.place.room} </span>}
                      <span className="font-medium">{c.label}</span>{" "}
                      <span className="text-muted-foreground">{c.before === null ? unset : valueText(f, c.before, view?.currency ?? "", index)}</span>
                      {" → "}
                      <span>{c.after === null ? unset : valueText(f, c.after, view?.currency ?? "", index)}</span>
                    </li>
                  );
                })}
                {item.note && <li className="text-muted-foreground">{item.note}</li>}
              </ul>
              {view?.can_edit && place === null && (
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
        <ModuleBody m={m} />
      ) : null}
    </Page>
  );
}

function ModuleBody({ m }: { m: ModuleDetail }) {
  const fields = useModuleSettings(m.id).data?.fields;
  const where = useSettingsScope(fields);
  return (
    <>
      <StatusBlock m={m} />
      <SettingsBlock id={m.id} where={where} />
      <ChangeLog id={m.id} where={where} />
    </>
  );
}
