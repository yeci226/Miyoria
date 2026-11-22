import { Ban, Save } from "lucide-react";
import { useId, useState } from "react";
import { isApiError } from "@/api/http";
import type { PersonProfile } from "@miyoria/contracts/api";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { useAdjustWallet, usePerson, usePersonWallet, useUpdatePerson } from "@/app/queries";
import { ConfirmDialog } from "@/components/confirm";
import { Facts } from "@/components/json-view";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Sheet, SheetBody, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { accountString, fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { WORLD } from "@/lib/world";
import { CardsSection } from "./CardsSection";
import { tierText } from "./heart";
import { HeartSection, Section } from "./PersonHeart";
import { AnchorsSection, EvidenceSection, HistorySection } from "./PersonLog";
import { QuestsSection } from "./QuestsSection";

/** Her words about them, as the editor holds them. */
interface Draft {
  callName: string;
  tags: string;
  impression: string;
  stance: string;
  unfinished: string;
  jokes: string;
  dislikes: string;
  publicFeeling: string;
}

const fromProfile = (p: PersonProfile): Draft => ({
  callName: p.call_name ?? "",
  tags: p.tags.filter((t) => t !== "blocked").join(", "),
  impression: p.impression,
  stance: p.stance,
  unfinished: p.unfinished,
  jokes: p.jokes,
  dislikes: p.dislikes,
  publicFeeling: p.public_feeling ?? "",
});

/** The text fields after the call name and tags: label and how tall. */
const TEXTS: { key: Exclude<keyof Draft, "callName" | "tags">; label: string; rows: number }[] = [
  { key: "impression", label: "印象", rows: 4 },
  { key: "stance", label: "相處方式", rows: 2 },
  { key: "unfinished", label: "還沒聊完的事", rows: 2 },
  { key: "jokes", label: "共同的梗", rows: 2 },
  { key: "dislikes", label: "不喜歡的地方", rows: 2 },
  { key: "publicFeeling", label: "會員頁上的話", rows: 2 },
];

/**
 * Her words about them: call name, tags, impression, how she acts with them, what is unfinished,
 * their jokes, what she dislikes and the line on their member page. Shows the server's values
 * until the first keystroke; from then on the user's edits win over refetches (which hand us a new
 * array every time) until saved.
 */
export function RelationshipEditor({ profile }: { profile: PersonProfile }) {
  const update = useUpdatePerson(profile.person.id);
  const id = useId();
  const [edits, setEdits] = useState<Draft | null>(null);
  const shown = edits ?? fromProfile(profile);
  const change = (field: keyof Draft, value: string) => setEdits({ ...shown, [field]: value });

  const save = () =>
    update.mutate(
      {
        call_name: shown.callName.trim() || null,
        tags: shown.tags
          .split(/[,,]/)
          .map((t) => t.trim())
          .filter(Boolean),
        impression: shown.impression,
        stance: shown.stance,
        unfinished: shown.unfinished,
        jokes: shown.jokes,
        dislikes: shown.dislikes,
        public_feeling: shown.publicFeeling.trim() || null,
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
          <Input id={`${id}-call`} value={shown.callName} placeholder={profile.person.display_name} onChange={(e) => change("callName", e.target.value)} />
        </Field>
        <Field label="標籤" htmlFor={`${id}-tags`}>
          <Input id={`${id}-tags`} value={shown.tags} placeholder="常客, Minecraft" onChange={(e) => change("tags", e.target.value)} />
        </Field>
      </div>
      {TEXTS.map((t) => (
        <Field key={t.key} label={t.label} htmlFor={`${id}-${t.key}`}>
          <Textarea id={`${id}-${t.key}`} rows={t.rows} value={shown[t.key]} onChange={(e) => change(t.key, e.target.value)} />
        </Field>
      ))}
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

const MAX_ADJUST = 100_000;
const MAX_NOTE = 100;
const CURRENCY = WORLD.currency;

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
  const disabledWhy = !canWrite ? READ_ONLY_HINT : denied ? `你的帳號沒有調整${CURRENCY}的權限(需要 admin.economy.adjust)` : undefined;
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

function PersonBody({ profile }: { profile: PersonProfile }) {
  const update = useUpdatePerson(profile.person.id);
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
          {profile.person.display_name}
          {profile.has_row && <Badge variant="brand">{tierText(profile)}</Badge>}
          {profile.blocked && <Badge variant="destructive">已封鎖</Badge>}
        </SheetTitle>
        <div className="flex flex-wrap gap-2 pt-1">
          <Button
            writes
            size="sm"
            variant="outline"
            className={profile.blocked ? undefined : "text-primary hover:text-primary"}
            busy={update.isPending && update.variables?.blocked !== undefined}
            onClick={() => (profile.blocked ? setBlocked(false) : setConfirmBlock(true))}
          >
            <Ban />
            {profile.blocked ? "解除封鎖" : "封鎖"}
          </Button>
        </div>
      </SheetHeader>
      <SheetBody className="grid content-start gap-8">
        <HeartSection profile={profile} />

        <HistorySection profile={profile} />

        <EvidenceSection profile={profile} />

        <AnchorsSection profile={profile} />

        <Section title="她怎麼看這個人">
          <RelationshipEditor key={profile.person.id} profile={profile} />
        </Section>

        <WalletSection personId={profile.person.id} name={profile.person.display_name} />

        <QuestsSection personId={profile.person.id} />

        <CardsSection personId={profile.person.id} />

        <Section title="帳號">
          <ul className="divide-y divide-line-soft rounded-md border">
            {profile.person.accounts.map((a) => (
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

        <Facts
          items={{
            "第一次見面": fmtDateTime(profile.person.created_at),
            "相關記憶": `${profile.memory_count} 則`,
            id: <span className="font-mono text-xs">{profile.person.id}</span>,
          }}
        />
      </SheetBody>
      <ConfirmDialog
        open={confirmBlock}
        title={`封鎖 ${profile.person.display_name}?`}
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
          <PersonBody profile={person.data} />
        ) : (
          <EmptyLine>找不到這個人</EmptyLine>
        )}
      </SheetContent>
    </Sheet>
  );
}
