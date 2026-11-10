// 意識軸: four lanes on one timeline, a thin line for every `cause`, the selected chain in the
// primary colour. Every point is a button; arrow keys walk them in time order (left, right) or
// across lanes (up, down), Enter selects, Escape clears.

import { type KeyboardEvent, useMemo, useRef, useState } from "react";
import { fmtTime } from "@/lib/format";
import { type AxisModel, type AxisNode, axisTicks, LANES } from "@/lib/consciousness";
import { cn } from "@/lib/utils";
import { linear } from "./scale";

const W = 860;
const LEFT = 44;
const RIGHT = 12;
const TOP = 10;
const ROW = 48;
const HEIGHT = TOP + ROW * 4 + 22;
/** A label of this many characters, drawn at 12px, is about this wide. */
const CHAR_PX = 12;

const clip = (s: string, n = 16) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface ConsciousnessAxisProps {
  model: AxisModel;
  t0: number;
  t1: number;
  /** Ids of the selected chain; empty when nothing is selected. */
  chain: ReadonlySet<string>;
  selected: string | null;
  onSelect: (id: string | null) => void;
}

export function ConsciousnessAxis({ model, t0, t1, chain, selected, onSelect }: ConsciousnessAxisProps) {
  const x = useMemo(() => linear([t0, t1], [LEFT, W - RIGHT]), [t0, t1]);
  const y = (lane: number) => TOP + ROW * lane + ROW / 2;
  const refs = useRef(new Map<string, SVGGElement>());
  const [roving, setRoving] = useState<string | null>(null);
  const { nodes, links } = model;
  const byId = useMemo(() => new Map(nodes.map((n) => [n.event.id, n])), [nodes]);
  const active = chain.size > 0;
  const stop = (roving !== null && byId.has(roving) ? roving : null) ?? (selected !== null && byId.has(selected) ? selected : null) ?? nodes[nodes.length - 1]?.event.id ?? null;

  // Labels: every point's while nothing is selected, else the chain's and the focused point's.
  // Left to right, a label that would run into the previous one on its lane is left out (the steps below say it).
  const labelled = useMemo(() => {
    const out = new Set<string>();
    const reach = new Map<number, number>();
    for (const n of nodes) {
      const mine = chain.has(n.event.id) || n.event.id === roving;
      if (!mine && active) continue;
      const px = x(n.t);
      const width = Math.min(n.title.length, 16) * CHAR_PX;
      const right = px > W - 170;
      const from = right ? px - 10 - width : px + 10;
      if (n.event.id !== roving && from < (reach.get(n.lane) ?? Number.NEGATIVE_INFINITY)) continue;
      out.add(n.event.id);
      reach.set(n.lane, Math.max(reach.get(n.lane) ?? 0, right ? px : from + width));
    }
    return out;
  }, [nodes, chain, roving, active, x]);

  const move = (to: AxisNode | undefined) => {
    if (!to) return;
    setRoving(to.event.id);
    refs.current.get(to.event.id)?.focus();
  };

  const onKey = (e: KeyboardEvent<SVGGElement>, node: AxisNode, i: number) => {
    switch (e.key) {
      case "Enter":
      case " ":
        e.preventDefault();
        onSelect(node.event.id);
        return;
      case "Escape":
        onSelect(null);
        return;
      case "ArrowRight":
        e.preventDefault();
        move(nodes[i + 1]);
        return;
      case "ArrowLeft":
        e.preventDefault();
        move(nodes[i - 1]);
        return;
      case "Home":
        e.preventDefault();
        move(nodes[0]);
        return;
      case "End":
        e.preventDefault();
        move(nodes[nodes.length - 1]);
        return;
      case "ArrowDown":
      case "ArrowUp": {
        e.preventDefault();
        const lane = node.lane + (e.key === "ArrowDown" ? 1 : -1);
        const there = nodes.filter((n) => n.lane === lane);
        let best: AxisNode | undefined;
        for (const n of there) if (!best || Math.abs(n.t - node.t) < Math.abs(best.t - node.t)) best = n;
        move(best);
      }
    }
  };

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${W} ${HEIGHT}`}
        role="group"
        aria-label="聽到、想、說、做的時間線"
        className="block h-auto w-full min-w-[720px]"
      >
        {LANES.map((name, i) => (
          <g key={name}>
            <line x1={LEFT} x2={W - RIGHT} y1={y(i)} y2={y(i)} stroke="var(--chart-grid)" />
            <text x={0} y={y(i) + 4} fontSize={12} fontWeight={500} fill="var(--muted-foreground)">
              {name}
            </text>
          </g>
        ))}
        {axisTicks(t0, t1).map((tick, i, all) => (
          <text
            key={tick.t}
            x={x(tick.t)}
            y={HEIGHT - 4}
            fontSize={11}
            textAnchor={i === all.length - 1 && x(tick.t) > W - 40 ? "end" : "middle"}
            fill="var(--muted-foreground)"
            className="font-mono"
          >
            {tick.label}
          </text>
        ))}
        {links.map((l) => {
          const a = byId.get(l.from);
          const b = byId.get(l.to);
          if (!a || !b) return null;
          const on = chain.has(l.from) && chain.has(l.to);
          const mx = (x(a.t) + x(b.t)) / 2;
          return (
            <path
              key={`${l.from}>${l.to}`}
              d={`M${x(a.t)} ${y(a.lane)}C${mx} ${y(a.lane)} ${mx} ${y(b.lane)} ${x(b.t)} ${y(b.lane)}`}
              fill="none"
              stroke={on ? "var(--primary)" : "var(--chart-axis)"}
              strokeWidth={on ? 2 : 1}
              opacity={active && !on ? 0.5 : 1}
            />
          );
        })}
        {nodes.map((n, i) => {
          const id = n.event.id;
          const px = x(n.t);
          const py = y(n.lane);
          const on = chain.has(id);
          const right = px > W - 170;
          return (
            <g
              key={id}
              ref={(el) => {
                if (el) refs.current.set(id, el);
                else refs.current.delete(id);
              }}
              role="button"
              tabIndex={id === stop ? 0 : -1}
              aria-pressed={on}
              aria-label={`${LANES[n.lane]} ${fmtTime(n.event.at)} ${n.title}`}
              data-id={id}
              data-chain={on ? "on" : undefined}
              onClick={() => {
                setRoving(id);
                onSelect(id);
              }}
              onFocus={() => setRoving(id)}
              onKeyDown={(e) => onKey(e, n, i)}
              className="group cursor-pointer outline-none"
            >
              <title>{`${fmtTime(n.event.at)} ${n.title}`}</title>
              <circle cx={px} cy={py} r={11} fill="transparent" />
              <circle
                cx={px}
                cy={py}
                r={9}
                fill="none"
                stroke="var(--ring)"
                strokeWidth={2}
                className="opacity-0 group-focus-visible:opacity-100"
              />
              <circle
                cx={px}
                cy={py}
                r={on ? 5 : 4.5}
                strokeWidth={1.5}
                fill={on ? "var(--primary)" : "var(--chart-surface)"}
                stroke={on ? "var(--primary)" : "var(--muted-foreground)"}
                opacity={active && !on ? 0.55 : 1}
              />
              {labelled.has(id) && (
                <text
                  x={px + (right ? -10 : 10)}
                  y={py + (n.lane === 3 || right ? 18 : -9)}
                  textAnchor={right ? "end" : "start"}
                  fontSize={12}
                  fontWeight={on ? 600 : 400}
                  fill={on ? "var(--foreground)" : "var(--muted-foreground)"}
                  className={cn("pointer-events-none select-none")}
                >
                  {clip(n.title)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
