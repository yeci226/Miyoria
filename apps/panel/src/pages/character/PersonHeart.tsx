import { BondRing } from "@miyoria/card-face";
import { useId, useState } from "react";
import type { FieldLedger, PersonProfile } from "@miyoria/contracts/api";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { useAdjustPerson } from "@/app/queries";
import { Facts } from "@/components/json-view";
import { Bipolar, Meter } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtPct } from "@/lib/format";
import { notify } from "@/lib/notify";
import { FIELD, FIELDS, fmtDelta, fmtValue, type HeartField, tierText, VALUES } from "./heart";

/** A section of the person sheet: a 14 px title, then its content. */
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3" aria-label={title}>
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

const STEPS = [-10, -5, 5, 10] as const;

/** The eight numbers beside the bond: a meter each, from a centre line for -1..1. */
function Values({ profile }: { profile: PersonProfile }) {
  return (
    <dl className="grid grid-cols-[3rem_minmax(0,1fr)_3rem] items-center gap-x-3 gap-y-3 text-sm">
      {VALUES.map((f) => {
        const { label, scale } = FIELD[f];
        const v = profile[f];
        const text = fmtValue(f, v);
        return (
          <div key={f} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd>
              {scale === "signed" ? (
                <Bipolar value={v * 100} label={`${label} ${text}`} />
              ) : (
                <Meter value={scale === "hundred" ? v / 100 : v} tone={f === "trust" ? "brand" : "neutral"} label={`${label} ${text}`} />
              )}
            </dd>
            <dd className="text-right font-mono text-xs tabular-nums">{text}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** An amount of a cap, in the field's own precision. */
const amount = (field: HeartField, n: number) => fmtDelta(field, n).replace(/^[+−]/, "");

/** How much of today's caps each number moved today has used. */
function Caps({ ledger }: { ledger: FieldLedger[] }) {
  const used = ledger.filter((l) => l.used_up > 0 || l.used_down > 0 || l.proposed_up > 0 || l.proposed_down > 0);
  if (used.length === 0) return null;
  return (
    <div className="grid gap-2">
      <h4 className="text-[13px] text-muted-foreground">今天的額度</h4>
      <dl className="grid grid-cols-[3rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2.5 text-sm">
        {used.map((l) => {
          const { label } = FIELD[l.field];
          const up = `${amount(l.field, l.used_up)} / ${amount(l.field, l.cap_up)}`;
          const down = `${amount(l.field, l.used_down)} / ${amount(l.field, l.cap_down)}`;
          return (
            <div key={l.field} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>
                <Meter value={l.cap_up > 0 ? l.used_up / l.cap_up : 0} label={`${label} 今天往上 ${up}`} />
              </dd>
              <dd className="text-right font-mono text-xs tabular-nums">
                +{up}
                {l.used_down > 0 && <span className="text-muted-foreground"> · −{down}</span>}
              </dd>
            </div>
          );
        })}
      </dl>
    </div>
  );
}

/** A number typed for `field`, or null when it is not one inside the field's range. */
export function parseValue(field: HeartField, text: string): number | null {
  const t = text.trim().replace("−", "-");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return null;
  const n = Number(t);
  const { min, max } = FIELD[field];
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

/** Sets any number to a value, and moves the bond by a quick step. */
function Adjust({ profile }: { profile: PersonProfile }) {
  const adjust = useAdjustPerson(profile.person.id);
  const canWrite = useCanWrite();
  const id = useId();
  const [field, setField] = useState<HeartField>("bond");
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(Number(profile[field].toFixed(FIELD[field].scale === "unit" || FIELD[field].scale === "signed" ? 2 : 1)));
  const value = parseValue(field, shown);
  const { label, min, max } = FIELD[field];
  const why = canWrite ? undefined : READ_ONLY_HINT;

  const set = () => {
    if (value === null) return;
    adjust.mutate(
      { field, value },
      {
        onSuccess: (row) => {
          notify.ok(`${label} ${fmtValue(field, row[field])}`);
          setDraft(null);
        },
        onError: (e) => notify.error(e, "調整失敗"),
      },
    );
  };

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="調整羈絆">
        <span className="mr-1 w-14 text-[13px] text-muted-foreground">調整羈絆</span>
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
                { field: "bond", delta: n },
                { onSuccess: (row) => notify.ok(`羈絆 ${fmtValue("bond", row.bond)}`), onError: (e) => notify.error(e, "調整失敗") },
              )
            }
          >
            {n > 0 ? `+${n}` : `−${-n}`}
          </Button>
        ))}
      </div>
      <form
        className="flex flex-wrap items-center gap-1.5"
        aria-label="設定數值"
        onSubmit={(e) => {
          e.preventDefault();
          if (canWrite) set();
        }}
      >
        <span className="mr-1 w-14 text-[13px] text-muted-foreground">設定數值</span>
        <Select
          value={field}
          disabled={!canWrite}
          onValueChange={(v) => {
            setField(v as HeartField);
            setDraft(null);
          }}
        >
          <SelectTrigger size="sm" className="w-24" aria-label="數值" title={why}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FIELDS.map((f) => (
              <SelectItem key={f} value={f}>
                {FIELD[f].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          id={`${id}-v`}
          aria-label={`${label}的新值`}
          inputMode="decimal"
          className="h-7 w-24 font-mono"
          value={shown}
          placeholder={`${min} 到 ${max}`}
          aria-invalid={value === null}
          disabled={!canWrite}
          title={why ?? `${min} 到 ${max}`}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button writes type="submit" size="sm" variant="outline" busy={adjust.isPending && adjust.variables?.value !== undefined} disabled={value === null || adjust.isPending}>
          設定
        </Button>
      </form>
    </div>
  );
}

/** The ring with the bond on the heart, where the tier stands, the eight numbers, the controls and today's caps. */
export function HeartSection({ profile }: { profile: PersonProfile }) {
  if (!profile.has_row) {
    return (
      <Section title="關係">
        <p className="text-sm text-muted-foreground">還沒有關係紀錄</p>
      </Section>
    );
  }
  const tier = tierText(profile);
  const next = profile.next_label ?? profile.next_tier;
  return (
    <Section title="關係">
      <div className="grid gap-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          <div className="size-32 shrink-0 [&>svg]:size-full">
            <BondRing {...profile.ring} value={profile.bond} title={tier} />
          </div>
          <div className="min-w-0 flex-1">
            <Facts
              items={{
                分級: tier,
                下一步: next ?? "—",
                ...(profile.next_tier
                  ? {
                      到下一級: (
                        <span className="flex items-center gap-2">
                          <Meter value={profile.tier_progress} tone="brand" label={`到「${profile.next_tier}」${fmtPct(profile.tier_progress)}`} />
                          <span className="w-10 shrink-0 text-right font-mono text-xs tabular-nums">{fmtPct(profile.tier_progress)}</span>
                        </span>
                      ),
                    }
                  : {}),
                在意: <span className="font-mono text-xs tabular-nums">{profile.cares.toFixed(2)}</span>,
              }}
            />
          </div>
        </div>
        {profile.held && <p className="text-[13px] text-muted-foreground">還沒有「{profile.held.label}」的共同記憶,停在門檻前</p>}
        <Values profile={profile} />
        <Adjust profile={profile} />
        <Caps ledger={profile.ledger} />
      </div>
    </Section>
  );
}
