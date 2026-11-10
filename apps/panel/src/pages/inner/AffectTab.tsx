import type { ReactNode } from "react";
import type { AffectBiases, AffectSnapshot } from "@/api/types";
import { useAffect } from "@/app/queries";
import { EmptyLine, QueryView, SkeletonRows } from "@/components/query-state";
import { Bipolar, Meter, StatusBadge } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtDateTime, fmtRelative } from "@/lib/format";
import { AFFECT_DRIVE_LABEL, AFFECT_DRIVE_ORDER, EMOTION_LABEL, WANT_LABEL } from "./labels";

const n2 = (v: number) => v.toFixed(2);
const signed = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}`;

function Row({ label, value, children }: { label: string; value: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)_3.5rem] items-center gap-3 py-(--row-y)">
      <dt className="text-[13px] text-muted-foreground">{label}</dt>
      <dd className="contents">
        <span className="min-w-0">{children}</span>
        <span className="text-right font-mono text-xs tabular-nums">{value}</span>
      </dd>
    </div>
  );
}

function MoodCard({ affect }: { affect: AffectSnapshot }) {
  const { mood, shown } = affect;
  return (
    <Card>
      <CardHeader>
        <CardTitle>心情</CardTitle>
        {shown && (
          <Badge variant={shown.masked ? "warning" : "brand"} title={shown.style}>
            {shown.masked ? "在掩飾" : "表現出來"} · {shown.tag}
          </Badge>
        )}
      </CardHeader>
      <p className="pb-2 text-base font-medium" aria-label="心情一句話">
        {affect.mood_line || "—"}
      </p>
      <dl className="divide-y divide-line-soft" aria-label="心情數值">
        <Row label="心情" value={n2(mood.valence)}>
          <Bipolar value={mood.valence * 100} label={`心情 ${n2(mood.valence)}`} />
        </Row>
        <Row label="興奮" value={n2(mood.arousal)}>
          <Meter value={mood.arousal} label={`興奮 ${n2(mood.arousal)}`} />
        </Row>
        <Row label="精神" value={n2(mood.energy)}>
          <Meter value={mood.energy} tone="brand" label={`精神 ${n2(mood.energy)}`} />
        </Row>
        <Row label="無聊" value={n2(affect.boredom)}>
          <Meter value={affect.boredom} label={`無聊 ${n2(affect.boredom)}`} />
        </Row>
      </dl>
    </Card>
  );
}

function EmotionsCard({ affect }: { affect: AffectSnapshot }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>最強的情緒</CardTitle>
      </CardHeader>
      {affect.top.length === 0 ? (
        <EmptyLine>現在沒有明顯的情緒</EmptyLine>
      ) : (
        <Table aria-label="情緒">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-20">情緒</TableHead>
              <TableHead className="w-32">強度</TableHead>
              <TableHead>起因</TableHead>
              <TableHead className="w-24">時間</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {affect.top.map((e) => (
              <TableRow key={`${e.name}:${e.person ?? ""}`}>
                <TableCell className="font-medium">{EMOTION_LABEL[e.name] ?? e.name}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Meter value={e.intensity} tone="brand" label={`${EMOTION_LABEL[e.name] ?? e.name} ${n2(e.intensity)}`} />
                    <span className="font-mono text-xs tabular-nums">{n2(e.intensity)}</span>
                  </div>
                </TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{e.cause || "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  <time dateTime={e.at} title={fmtDateTime(e.at)} className="whitespace-nowrap">
                    {fmtRelative(e.at)}
                  </time>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function DrivesCard({ affect }: { affect: AffectSnapshot }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>驅力</CardTitle>
      </CardHeader>
      <dl className="divide-y divide-line-soft" aria-label="驅力">
        {AFFECT_DRIVE_ORDER.map((d) => {
          const v = affect.drives[d as keyof AffectSnapshot["drives"]];
          if (v === undefined) return null;
          return (
            <Row key={d} label={AFFECT_DRIVE_LABEL[d] ?? d} value={n2(v)}>
              <Meter value={v} tone="brand" label={`${AFFECT_DRIVE_LABEL[d] ?? d} ${n2(v)}`} />
            </Row>
          );
        })}
      </dl>
    </Card>
  );
}

/** The table "情緒 → 行為": what her feelings add to her talkativeness, initiative and wishes. */
export function BiasCard({ biases }: { biases: AffectBiases }) {
  const wants = [...biases.wants].sort((a, b) => b.weight - a.weight);
  return (
    <Card>
      <CardHeader>
        <CardTitle>情緒 → 行為</CardTitle>
      </CardHeader>
      <dl className="divide-y divide-line-soft border-b border-line-soft" aria-label="行為偏移">
        <Row label="多話程度" value={signed(biases.talkativeness)}>
          <Bipolar value={biases.talkativeness * 100} label={`多話程度偏移 ${signed(biases.talkativeness)}`} />
        </Row>
        <Row label="主動程度" value={signed(biases.initiative)}>
          <Bipolar value={biases.initiative * 100} label={`主動程度偏移 ${signed(biases.initiative)}`} />
        </Row>
      </dl>
      {wants.length === 0 ? (
        <EmptyLine>現在沒有特別想做的事</EmptyLine>
      ) : (
        <Table aria-label="她想做的事">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-28">想做</TableHead>
              <TableHead className="w-32">強度</TableHead>
              <TableHead className="hidden w-24 sm:table-cell">對象</TableHead>
              <TableHead>為什麼</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {wants.map((w, i) => (
              <TableRow key={`${w.want}:${w.person ?? ""}:${i}`}>
                <TableCell className="font-medium">{WANT_LABEL[w.want] ?? w.want}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Meter value={w.weight} tone="brand" label={`${WANT_LABEL[w.want] ?? w.want} ${n2(w.weight)}`} />
                    <span className="font-mono text-xs tabular-nums">{n2(w.weight)}</span>
                  </div>
                </TableCell>
                <TableCell className="hidden text-muted-foreground sm:table-cell">{w.person ?? "—"}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{w.why || "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </Card>
  );
}

function Loading() {
  return (
    <Card>
      <SkeletonRows count={5} />
    </Card>
  );
}

/** Her feelings now, and what they do to what she does. */
export function AffectTab() {
  const affect = useAffect();
  return (
    <QueryView query={affect} skeleton={<Loading />}>
      {(a) => (
        <div className="grid gap-(--stage-gap)">
          <div className="grid items-start gap-(--stage-gap) lg:grid-cols-2">
            <MoodCard affect={a} />
            <DrivesCard affect={a} />
          </div>
          <EmotionsCard affect={a} />
          <BiasCard biases={a.biases} />
          <p className="text-[13px] text-muted-foreground">
            更新於 <StatusBadge tone="neutral">{fmtRelative(a.at)}</StatusBadge>
          </p>
        </div>
      )}
    </QueryView>
  );
}
