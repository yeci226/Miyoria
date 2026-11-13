import { Link } from "@tanstack/react-router";
import type { PersonCard } from "@/api/types";
import { useAffectPeople } from "@/app/queries";
import { Bipolar, Meter, StatusBadge, type Tone } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { EMOTION_LABEL } from "./labels";

const LABEL_TONE: Record<string, Tone> = {
  很討厭: "danger",
  討厭: "danger",
  陌生人: "neutral",
  認識: "neutral",
  朋友: "success",
  好朋友: "success",
  摯友: "brand",
};

/**
 * Her stance toward them, with the level it was written at when that is not the level now (she
 * rewrites it every 5 levels, at her daily reflection): `嘴硬但會照顧他(Lv.30 時寫的)`.
 */
export function stanceText(card: PersonCard): string | null {
  const stance = card.stance?.trim();
  if (!stance) return null;
  const at = card.stance_level;
  const stale = typeof at === "number" && typeof card.level === "number" && at !== card.level;
  return stale ? `${stance}(Lv.${at} 時寫的)` : stance;
}

/** The active emotions toward one person, strongest first: `想念 0.60 · 感激 0.20`. */
export function emotionsText(card: PersonCard): string {
  return Object.entries(card.emotions)
    .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([name, v]) => `${EMOTION_LABEL[name] ?? name} ${v.toFixed(2)}`)
    .join(" · ");
}

function Gauge({ children, label, value }: { children: string; label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <Meter value={value} tone="brand" label={label} />
      <span className="font-mono text-xs tabular-nums">{children}</span>
    </div>
  );
}

/**
 * One card per person: how she feels about them (the numbers, the label and level, the emotions
 * toward them, her words and how she acts with them). Nothing is shown on a Core without the
 * affect module.
 */
export function PersonCards() {
  const cards = useAffectPeople();
  if (cards.isPending || cards.isError) return null;
  const list = cards.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>人物卡</CardTitle>
        <span className="text-sm text-muted-foreground tabular-nums">{list.length}</span>
      </CardHeader>
      {list.length === 0 ? (
        <p className="py-3 text-[13px] text-muted-foreground">還沒有任何人物卡</p>
      ) : (
        <Table aria-label="人物卡">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-36">人</TableHead>
              <TableHead className="hidden w-28 md:table-cell">好感</TableHead>
              <TableHead className="hidden w-24 lg:table-cell">信任</TableHead>
              <TableHead className="hidden w-24 lg:table-cell">熟悉</TableHead>
              <TableHead className="hidden w-24 sm:table-cell">在意</TableHead>
              <TableHead>她的感覺</TableHead>
              <TableHead className="w-24">最後見到</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((c) => {
              const emotions = emotionsText(c);
              const stance = stanceText(c);
              return (
                <TableRow key={c.person}>
                  <TableCell className="align-top">
                    <span className="grid gap-1">
                      <Link
                        to="/character"
                        search={{ tab: "people", person: c.person }}
                        className="w-fit rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {c.call_name ?? c.handle}
                      </Link>
                      <span className="flex flex-wrap items-center gap-1">
                        <StatusBadge tone={LABEL_TONE[c.label] ?? "neutral"}>{c.label}</StatusBadge>
                        {typeof c.level === "number" && (
                          <Badge variant="outline" className="font-mono tabular-nums" title="好感等級(每 1 點一級)">
                            Lv.{c.level}
                          </Badge>
                        )}
                        {c.owner && <Badge variant="brand">主人</Badge>}
                        {c.blocked && <Badge variant="destructive">封鎖</Badge>}
                      </span>
                    </span>
                  </TableCell>
                  <TableCell className="hidden align-top md:table-cell">
                    <div className="flex items-center gap-2">
                      <Bipolar value={c.affinity} label={`${c.handle} 好感 ${c.affinity}`} />
                      <span className="w-8 text-right font-mono text-xs tabular-nums">{Math.round(c.affinity)}</span>
                    </div>
                  </TableCell>
                  <TableCell className="hidden align-top lg:table-cell">
                    <Gauge label={`${c.handle} 信任 ${Math.round(c.trust)}`} value={c.trust / 100}>
                      {String(Math.round(c.trust))}
                    </Gauge>
                  </TableCell>
                  <TableCell className="hidden align-top lg:table-cell">
                    <Gauge label={`${c.handle} 熟悉 ${Math.round(c.familiarity)}`} value={c.familiarity / 100}>
                      {String(Math.round(c.familiarity))}
                    </Gauge>
                  </TableCell>
                  <TableCell className="hidden align-top sm:table-cell">
                    <Gauge label={`${c.handle} 在意 ${c.attachment.toFixed(2)}`} value={c.attachment}>
                      {c.attachment.toFixed(2)}
                    </Gauge>
                  </TableCell>
                  <TableCell className="max-w-[48ch] align-top whitespace-pre-wrap leading-relaxed">
                    {c.feeling || <span className="text-muted-foreground">—</span>}
                    {stance && (
                      <span className="mt-1 block text-[13px]">
                        <span className="text-muted-foreground">相處方式:</span>
                        {stance}
                      </span>
                    )}
                    {emotions && <span className="mt-1 block text-[13px] text-muted-foreground">{emotions}</span>}
                  </TableCell>
                  <TableCell className="align-top text-muted-foreground">
                    {c.last_seen ? (
                      <time dateTime={c.last_seen} title={fmtDateTime(c.last_seen)} className="whitespace-nowrap">
                        {fmtRelative(c.last_seen)}
                      </time>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}
