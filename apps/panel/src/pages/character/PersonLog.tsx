import { Plus, Trash2 } from "lucide-react";
import { useId, useMemo, useState } from "react";
import type { HeartHistoryEntry, PersonAnchor, PersonProfile } from "@miyoria/contracts/api";
import { useAnchorMutations, usePersonHistory } from "@/app/queries";
import { TimeChart } from "@/components/charts/charts";
import { ConfirmDialog } from "@/components/confirm";
import { RowActions } from "@/components/controls";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { notify } from "@/lib/notify";
import { anchorTiers, CAUSE, EVIDENCE, FIELD, fmtDelta, levels } from "./heart";
import { Section } from "./PersonHeart";

/** The bond, trust and familiarity over the changes loaded, on one axis (the bond runs past 100). */
export function AffinityChart({ changes, now }: { changes: HeartHistoryEntry[]; now: PersonProfile }) {
  const { times, values } = useMemo(
    () => levels(changes, ["bond", "trust", "familiarity"], { bond: now.bond, trust: now.trust, familiarity: now.familiarity }),
    [changes, now.bond, now.trust, now.familiarity],
  );
  if (times.length < 2) return null;
  const bond = values.bond;
  return (
    <TimeChart
      label={`關係變化:羈絆從 ${Math.round(bond[0] ?? 0)} 到 ${Math.round(bond[bond.length - 1] ?? 0)}`}
      times={times}
      series={[
        { key: "bond", label: "羈絆", color: "var(--chart-1)", values: bond },
        { key: "trust", label: "信任", color: "var(--chart-2)", values: values.trust },
        { key: "familiarity", label: "熟悉", color: "var(--chart-3)", values: values.familiarity },
      ]}
      domain={[-100, Math.ceil(Math.max(100, ...bond) / 100) * 100]}
      zero
      height={150}
      format={(v) => String(Math.round(v))}
    />
  );
}

const outlined = "divide-y divide-line-soft rounded-md border";

function Change({ c }: { c: HeartHistoryEntry }) {
  const quote = c.reason_quote.trim();
  const capped = c.delta === 0 && c.proposed !== null && c.proposed !== 0;
  return (
    <li className="grid gap-0.5 px-3 py-2.5">
      <p className="flex items-baseline gap-2 text-sm">
        <span className="font-medium">{FIELD[c.field].label}</span>
        <span className="font-mono text-xs tabular-nums">{fmtDelta(c.field, c.delta)}</span>
        {capped && <span className="text-[13px] text-muted-foreground">已達上限</span>}
        <span className="text-[13px] text-muted-foreground">{CAUSE[c.cause] ?? c.cause}</span>
        <time className="ml-auto shrink-0 text-[13px] text-muted-foreground" dateTime={c.at} title={fmtDateTime(c.at)}>
          {fmtRelative(c.at)}
        </time>
      </p>
      {quote !== "" && <q className="text-sm">{quote}</q>}
    </li>
  );
}

/** Every change, newest first, a page at a time, with a chart of the ones loaded. */
export function HistorySection({ profile }: { profile: PersonProfile }) {
  const first = profile.history;
  const more = usePersonHistory(profile.person.id, first.next_before ?? "");
  const changes = useMemo(() => {
    const seen = new Set<string>();
    return [...first.items, ...(more.data?.pages.flatMap((p) => p.items) ?? [])].filter((c) => !seen.has(c.id) && Boolean(seen.add(c.id)));
  }, [first.items, more.data]);
  const canMore = more.data ? more.hasNextPage : first.next_before !== null;
  if (changes.length === 0) return null;
  return (
    <Section title="最近的變化">
      <AffinityChart changes={changes} now={profile} />
      <ul className={outlined}>
        {changes.map((c) => (
          <Change key={c.id} c={c} />
        ))}
      </ul>
      {canMore && (
        <div>
          <Button size="sm" variant="outline" busy={more.isFetching} onClick={() => void more.fetchNextPage()}>
            載入更多
          </Button>
        </div>
      )}
    </Section>
  );
}

/** What happened between them lately. */
export function EvidenceSection({ profile }: { profile: PersonProfile }) {
  if (profile.evidence.length === 0) return null;
  return (
    <Section title="證據">
      <ul className={outlined}>
        {profile.evidence.map((e) => (
          <li key={e.id} className="flex items-baseline gap-3 px-3 py-2.5 text-sm">
            <span className="w-20 shrink-0 text-muted-foreground">{EVIDENCE[e.kind] ?? e.kind}</span>
            <span className="min-w-0 flex-1">{e.detail}</span>
            <time className="shrink-0 text-[13px] text-muted-foreground" dateTime={e.at} title={fmtDateTime(e.at)}>
              {fmtRelative(e.at)}
            </time>
          </li>
        ))}
      </ul>
    </Section>
  );
}

const MAX_QUOTE = 500;

function AddAnchor({ profile, onClose }: { profile: PersonProfile; onClose: () => void }) {
  const { set } = useAnchorMutations(profile.person.id);
  const id = useId();
  const tiers = anchorTiers(profile);
  const [tier, setTier] = useState(String(tiers.find((t) => !profile.anchors.some((a) => a.tier === t.tier))?.tier ?? tiers[0]?.tier ?? ""));
  const [quote, setQuote] = useState("");
  const q = quote.trim();
  const ok = q.length > 0 && [...q].length <= MAX_QUOTE && tier !== "";
  const save = () =>
    set.mutate(
      { tier: Number(tier), quote: q },
      {
        onSuccess: () => {
          notify.ok("已記下共同記憶");
          onClose();
        },
        onError: (e) => notify.error(e, "儲存失敗"),
      },
    );
  return (
    <Dialog open onOpenChange={(o) => !o && !set.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增共同記憶</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (ok) save();
          }}
        >
          <Field label="分級" htmlFor={`${id}-t`}>
            <Select value={tier} onValueChange={setTier}>
              <SelectTrigger id={`${id}-t`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {tiers.map((t) => (
                  <SelectItem key={t.tier} value={String(t.tier)}>
                    {t.name}
                    {profile.anchors.some((a) => a.tier === t.tier) ? "(取代現有的)" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="記憶" htmlFor={`${id}-q`}>
            <Textarea id={`${id}-q`} rows={3} maxLength={MAX_QUOTE} value={quote} onChange={(e) => setQuote(e.target.value)} autoFocus />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={set.isPending}>
              取消
            </Button>
            <Button writes type="submit" busy={set.isPending} disabled={!ok}>
              新增
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const ANCHOR_BY: Record<PersonAnchor["by"], string> = { reflect: "她選的", admin: "手動", migrate: "舊紀錄" };

/** The shared memory each tier from 知心 up rests on. */
export function AnchorsSection({ profile }: { profile: PersonProfile }) {
  const { remove } = useAnchorMutations(profile.person.id);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<PersonAnchor | null>(null);
  if (!profile.has_row) return null;
  const canAdd = anchorTiers(profile).length > 0;
  const anchors = [...profile.anchors].sort((a, b) => b.tier - a.tier);
  return (
    <Section title="分級的共同記憶">
      {anchors.length === 0 ? (
        <p className="text-sm text-muted-foreground">還沒有共同記憶</p>
      ) : (
        <ul className={outlined}>
          {anchors.map((a) => (
            <li key={a.tier} className="flex items-start gap-3 px-3 py-2.5 text-sm">
              <span className="w-20 shrink-0 text-muted-foreground">{a.tier_name}</span>
              <span className="grid min-w-0 flex-1 gap-0.5">
                {a.quote ? <q>{a.quote}</q> : <span className="text-muted-foreground">—</span>}
                <span className="text-[13px] text-muted-foreground">
                  <time dateTime={a.at} title={fmtDateTime(a.at)}>
                    {fmtDateTime(a.at).slice(0, 10)}
                  </time>{" "}
                  · {ANCHOR_BY[a.by] ?? a.by}
                </span>
              </span>
              <RowActions label={`「${a.tier_name}」的共同記憶的動作`}>
                <DropdownMenuItem variant="destructive" onSelect={() => setRemoving(a)}>
                  <Trash2 />
                  拿掉
                </DropdownMenuItem>
              </RowActions>
            </li>
          ))}
        </ul>
      )}
      {canAdd && (
        <div>
          <Button writes size="sm" variant="outline" onClick={() => setAdding(true)}>
            <Plus />
            新增共同記憶
          </Button>
        </div>
      )}
      {adding && <AddAnchor profile={profile} onClose={() => setAdding(false)} />}
      <ConfirmDialog
        open={removing !== null}
        title={`拿掉「${removing?.tier_name ?? ""}」的共同記憶?`}
        confirmLabel="拿掉"
        busy={remove.isPending}
        onClose={() => setRemoving(null)}
        onConfirm={() =>
          removing &&
          remove.mutate(removing.tier, {
            onSuccess: () => {
              notify.ok("已拿掉");
              setRemoving(null);
            },
            onError: (e) => notify.error(e, "拿掉失敗"),
          })
        }
      >
        羈絆不會變。
      </ConfirmDialog>
    </Section>
  );
}
