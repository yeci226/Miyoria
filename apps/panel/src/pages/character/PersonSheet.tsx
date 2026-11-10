import { Ban, Save } from "lucide-react";
import { useId, useState } from "react";
import { isApiError } from "@/api/http";
import type { PersonDetail, RelationshipDelta } from "@/api/types";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { useAdjustPerson, useAdjustWallet, usePerson, usePersonWallet, useUpdatePerson } from "@/app/queries";
import { TimeChart } from "@/components/charts/charts";
import { ConfirmDialog } from "@/components/confirm";
import { Facts } from "@/components/json-view";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Bipolar, Meter } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { accountString, fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";

/** Affinity, trust and familiarity over time on one -100..100 axis. */
export function AffinityChart({ history }: { history: RelationshipDelta[] }) {
  if (history.length < 2) return null;
  const first = history[0];
  const last = history[history.length - 1];
  return (
    <TimeChart
      label={`關係變化:好感從 ${Math.round(first?.affinity ?? 0)} 到 ${Math.round(last?.affinity ?? 0)}`}
      times={history.map((d) => Date.parse(d.at))}
      series={[
        { key: "affinity", label: "好感", color: "var(--chart-1)", values: history.map((d) => d.affinity) },
        { key: "trust", label: "信任", color: "var(--chart-2)", values: history.map((d) => d.trust) },
        { key: "familiarity", label: "熟悉", color: "var(--chart-3)", values: history.map((d) => d.familiarity) },
      ]}
      domain={[-100, 100]}
      zero
      height={150}
      format={(v) => String(Math.round(v))}
    />
  );
}

interface Draft {
  callName: string;
  tags: string;
  notes: string;
}

const fromDetail = (d: PersonDetail): Draft => ({
  callName: d.relationship?.call_name ?? "",
  tags: (d.relationship?.tags ?? []).join(", "),
  notes: d.relationship?.notes ?? "",
});

/**
 * Call name, tags and notes. Shows the server's values until the first keystroke; from then on
 * the user's edits win over refetches (which hand us a new array every time) until saved.
 */
export function RelationshipEditor({ detail }: { detail: PersonDetail }) {
  const update = useUpdatePerson(detail.person.id);
  const id = useId();
  const [edits, setEdits] = useState<Draft | null>(null);
  const shown = edits ?? fromDetail(detail);
  const change = (field: keyof Draft, value: string) => setEdits({ ...shown, [field]: value });

  const save = () =>
    update.mutate(
      {
        call_name: shown.callName.trim() || null,
        tags: shown.tags
          .split(/[,,]/)
          .map((t) => t.trim())
          .filter(Boolean),
        notes: shown.notes,
      },
      {
        onSuccess: () => {
          notify.ok("已更新");
          setEdits(null);
        },
        onError: (e) => notify.error(e, "更新失敗"),
      },
    );

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="稱呼" htmlFor={`${id}-call`}>
          <Input id={`${id}-call`} value={shown.callName} placeholder={detail.person.display_name} onChange={(e) => change("callName", e.target.value)} />
        </Field>
        <Field label="標籤" htmlFor={`${id}-tags`}>
          <Input id={`${id}-tags`} value={shown.tags} placeholder="常客, Minecraft" onChange={(e) => change("tags", e.target.value)} />
        </Field>
      </div>
      <Field label="備註" htmlFor={`${id}-notes`}>
        <Textarea id={`${id}-notes`} rows={4} value={shown.notes} onChange={(e) => change("notes", e.target.value)} />
      </Field>
      <div className="flex items-center gap-2">
        <Button writes type="submit" size="sm" variant="secondary" busy={update.isPending} disabled={edits === null}>
          <Save />
          儲存
        </Button>
        {edits !== null && (
          <Button size="sm" variant="ghost" onClick={() => setEdits(null)} disabled={update.isPending}>
            還原
          </Button>
        )}
      </div>
    </form>
  );
}

const STEPS = [-10, -5, 5, 10] as const;
const MAX_ADJUST = 100_000;
const MAX_NOTE = 100;
const CURRENCY = "魚幣";

/** A signed whole number, or null when the text is not one a hand adjustment may use. */
export function parseAmount(text: string): number | null {
  const t = text.trim();
  if (!/^[+-]?\d+$/.test(t)) return null;
  const n = Number(t);
  return n !== 0 && Math.abs(n) <= MAX_ADJUST ? n : null;
}

const signed = (n: number) => (n > 0 ? `+${n}` : `−${-n}`);

/** Their fish coins: balance, newest rows, and (for those who may) a hand adjustment. */
export function WalletSection({ personId, name }: { personId: string; name: string }) {
  const wallet = usePersonWallet(personId);
  const adjust = useAdjustWallet(personId);
  const canWrite = useCanWrite();
  const id = useId();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [denied, setDenied] = useState(false);

  if (wallet.isPending) return <Section title={CURRENCY}><SkeletonRows count={2} /></Section>;
  if (wallet.isError) {
    // No economy module (or an older Core): nothing to show.
    if (isApiError(wallet.error) && (wallet.error.kind === "unavailable" || wallet.error.kind === "not_provided")) return null;
    return <Section title={CURRENCY}><ErrorLine error={wallet.error} onRetry={() => void wallet.refetch()} /></Section>;
  }

  const n = parseAmount(amount);
  const trimmed = note.trim();
  const noteOk = trimmed.length > 0 && [...trimmed].length <= MAX_NOTE;
  const disabledWhy = !canWrite ? READ_ONLY_HINT : denied ? "你的帳號沒有調整魚幣的權限(需要 admin.economy.adjust)" : undefined;
  const ready = n !== null && noteOk;

  const submit = () => {
    if (n === null) return;
    adjust.mutate(
      { amount: n, note: trimmed, key: crypto.randomUUID() },
      {
        onSuccess: (r) => {
          notify.ok(`${name} 現在有 ${r.balance} ${CURRENCY}`);
          setConfirm(false);
          setAmount("");
          setNote("");
        },
        onError: (e) => {
          if (isApiError(e) && e.status === 403) setDenied(true);
          setConfirm(false);
          notify.error(e, "調整失敗");
        },
      },
    );
  };

  return (
    <Section title={CURRENCY}>
      <p className="font-mono text-2xl tabular-nums">
        {wallet.data.balance}
        <span className="ml-1.5 font-sans text-sm text-muted-foreground">{CURRENCY}</span>
      </p>
      {wallet.data.ledger.length === 0 ? (
        <p className="text-sm text-muted-foreground">還沒有紀錄</p>
      ) : (
        <ul className="divide-y divide-line-soft">
          {wallet.data.ledger.map((l, i) => (
            <li key={`${l.ts}-${i}`} className="flex items-baseline gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{l.label}</span>
              <span className="font-mono text-xs tabular-nums">{signed(l.delta)}</span>
              <time className="w-20 text-right text-[13px] text-muted-foreground" dateTime={l.ts} title={fmtDateTime(l.ts)}>
                {fmtRelative(l.ts)}
              </time>
            </li>
          ))}
        </ul>
      )}
      <form
        className="grid gap-3 sm:grid-cols-[7rem_minmax(0,1fr)_auto] sm:items-end"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready && !disabledWhy) setConfirm(true);
        }}
      >
        <Field label="數量" htmlFor={`${id}-amount`}>
          <Input id={`${id}-amount`} inputMode="numeric" placeholder="+50 或 -20" value={amount} disabled={Boolean(disabledWhy)} title={disabledWhy} onChange={(e) => setAmount(e.target.value)} />
        </Field>
        <Field label="原因" htmlFor={`${id}-note`}>
          <Input id={`${id}-note`} maxLength={MAX_NOTE} value={note} disabled={Boolean(disabledWhy)} title={disabledWhy} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <Button type="submit" size="sm" variant="secondary" disabled={!ready || Boolean(disabledWhy)} title={disabledWhy}>
          調整
        </Button>
      </form>
      {denied && <p className="text-[13px] text-muted-foreground">{disabledWhy}</p>}
      <ConfirmDialog
        open={confirm}
        title={n !== null && n > 0 ? `給 ${name} 加 ${n} ${CURRENCY}` : `從 ${name} 扣 ${n === null ? 0 : -n} ${CURRENCY}`}
        confirmLabel="調整"
        busy={adjust.isPending}
        onClose={() => setConfirm(false)}
        onConfirm={submit}
      >
        原因:{trimmed}
      </ConfirmDialog>
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function PersonBody({ detail }: { detail: PersonDetail }) {
  const r = detail.relationship;
  const update = useUpdatePerson(detail.person.id);
  const adjust = useAdjustPerson(detail.person.id);
  const [confirmBlock, setConfirmBlock] = useState(false);

  const setBlocked = (blocked: boolean) =>
    update.mutate(
      { blocked },
      {
        onSuccess: () => {
          notify.ok(blocked ? "已封鎖" : "已解除封鎖");
          setConfirmBlock(false);
        },
        onError: (e) => notify.error(e),
      },
    );

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex flex-wrap items-center gap-2 text-lg">
          {detail.person.display_name}
          {detail.label && <Badge variant="brand">{detail.label}</Badge>}
          {detail.blocked && <Badge variant="destructive">已封鎖</Badge>}
        </SheetTitle>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            writes
            size="sm"
            variant="outline"
            className={detail.blocked ? undefined : "text-primary hover:text-primary"}
            busy={update.isPending && update.variables?.blocked !== undefined}
            onClick={() => (detail.blocked ? setBlocked(false) : setConfirmBlock(true))}
          >
            <Ban />
            {detail.blocked ? "解除封鎖" : "封鎖"}
          </Button>
        </div>
      </SheetHeader>
      <SheetBody className="grid content-start gap-8">
        <Section title="關係">
          {r ? (
            <div className="grid gap-4">
              <dl className="grid grid-cols-[3rem_minmax(0,1fr)_2.5rem] items-center gap-x-3 gap-y-3 text-sm">
                <dt className="text-muted-foreground">好感</dt>
                <dd>
                  <Bipolar value={r.affinity} label="好感" />
                </dd>
                <dd className="text-right font-mono text-xs tabular-nums">{Math.round(r.affinity)}</dd>
                <dt className="text-muted-foreground">信任</dt>
                <dd>
                  <Meter value={r.trust / 100} tone="brand" label="信任" />
                </dd>
                <dd className="text-right font-mono text-xs tabular-nums">{Math.round(r.trust)}</dd>
                <dt className="text-muted-foreground">熟悉</dt>
                <dd>
                  <Meter value={r.familiarity / 100} label="熟悉" />
                </dd>
                <dd className="text-right font-mono text-xs tabular-nums">{Math.round(r.familiarity)}</dd>
              </dl>
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="調整好感">
                <span className="mr-1 text-[13px] text-muted-foreground">調整好感</span>
                {STEPS.map((n) => (
                  <Button
                    key={n}
                    writes
                    size="sm"
                    variant="outline"
                    className="w-12 font-mono"
                    disabled={adjust.isPending}
                    onClick={() =>
                      adjust.mutate(
                        { affinity: n },
                        { onSuccess: (p) => notify.ok(`好感 ${Math.round(p.relationship?.affinity ?? 0)}`), onError: (e) => notify.error(e) },
                      )
                    }
                  >
                    {n > 0 ? `+${n}` : `−${-n}`}
                  </Button>
                ))}
              </div>
              <AffinityChart history={detail.history} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">還沒有關係紀錄</p>
          )}
        </Section>

        <Section title="她怎麼看這個人">
          <RelationshipEditor key={detail.person.id} detail={detail} />
        </Section>

        <WalletSection personId={detail.person.id} name={detail.person.display_name} />

        <Section title="帳號">
          <ul className="divide-y divide-line-soft rounded-md border">
            {detail.person.accounts.map((a) => (
              <li key={accountString(a.account)} className="flex items-center gap-3 px-3 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{a.display_name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">{a.account.id}</span>
                </span>
                <Badge variant="outline">{a.account.platform}</Badge>
                <time className="w-20 text-right text-[13px] text-muted-foreground" dateTime={a.last_seen} title={fmtDateTime(a.last_seen)}>
                  {fmtRelative(a.last_seen)}
                </time>
              </li>
            ))}
          </ul>
        </Section>

        {detail.history.length > 0 && (
          <Section title="最近的變化">
            <ul className="divide-y divide-line-soft rounded-md border">
              {[...detail.history]
                .reverse()
                .slice(0, 20)
                .map((d, i) => (
                  <li key={`${d.at}-${i}`} className="grid gap-0.5 px-3 py-2.5">
                    <p className="text-sm">{d.reason}</p>
                    <p className="flex justify-between gap-3 font-mono text-xs text-muted-foreground">
                      <span>
                        好感 {Math.round(d.affinity)} · 信任 {Math.round(d.trust)} · 熟悉 {Math.round(d.familiarity)}
                      </span>
                      <time dateTime={d.at}>{fmtRelative(d.at)}</time>
                    </p>
                  </li>
                ))}
            </ul>
          </Section>
        )}

        <Facts
          items={{
            "第一次見面": fmtDateTime(detail.person.created_at),
            "相關記憶": `${detail.memory_count} 則`,
            id: <span className="font-mono text-xs">{detail.person.id}</span>,
          }}
        />
      </SheetBody>
      <ConfirmDialog
        open={confirmBlock}
        title={`封鎖 ${detail.person.display_name}?`}
        confirmLabel="封鎖"
        busy={update.isPending}
        onClose={() => setConfirmBlock(false)}
        onConfirm={() => setBlocked(true)}
      >
        她會完全忽略這個人。
      </ConfirmDialog>
    </>
  );
}

export function PersonSheet({ personId, onClose }: { personId: string | undefined; onClose: () => void }) {
  const person = usePerson(personId);
  return (
    <Sheet open={Boolean(personId)} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="sm:max-w-2xl">
        {person.isPending ? (
          <>
            <SheetHeader>
              <SheetTitle className="sr-only">載入中</SheetTitle>
            </SheetHeader>
            <SkeletonRows count={5} />
          </>
        ) : person.isError ? (
          <>
            <SheetHeader>
              <SheetTitle>找不到這個人</SheetTitle>
            </SheetHeader>
            <ErrorLine error={person.error} onRetry={() => void person.refetch()} />
          </>
        ) : person.data ? (
          <PersonBody detail={person.data} />
        ) : (
          <EmptyLine>找不到這個人</EmptyLine>
        )}
      </SheetContent>
    </Sheet>
  );
}
