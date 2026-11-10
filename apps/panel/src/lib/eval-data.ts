// What the north-star measures (docs/design/v3-architecture.md §18.1) are computed from: the
// EventLog and the delivery ledger, read over `/api/facts/*`. Nothing here is estimated; a source
// that could not be read back to the start of the window says from where it can be trusted.

import type { Api } from "@/api/endpoints";
import type { Delivery, LogEvent, LogEventKind } from "@/api/types";
import { ulidTime } from "@/lib/turn-events";

/** One page, the most the Core returns. */
export const PAGE = 500;
/** Pages read per source; past this the window is cut and `from` says where. */
const MAX_PAGES = 4;

/** A source read for a window. Nothing older than `from` (ms) is in `items`, and nothing in it is missing. */
export interface Loaded<T> {
  items: T[];
  from: number;
}

export interface EvalData {
  /** When it was read, ms. */
  now: number;
  /** The start of the window asked for, ms. */
  since: number;
  /** Her `agent.focus` decisions: which turn was for whom and why. */
  focus: Loaded<LogEvent>;
  /** The Floor's holds: who took the mic, and under which claim. */
  floor: Loaded<LogEvent>;
  /** Every line she opened (`utterance`). */
  utterances: Loaded<LogEvent>;
  /** `voice.latency` results: one reply measured, speech end to first audio. */
  latency: Loaded<LogEvent>;
  /** Every change of a promise she made. */
  commitments: Loaded<LogEvent>;
  /** Lines that reached someone, from the ledger, oldest first. */
  deliveries: Loaded<Delivery>;
  /** When the Core started, ms, oldest first. */
  boots: number[];
}

/** An EventLog source, newest first, paged back to `since`. */
async function pages(
  api: Pick<Api, "factEvents">,
  q: { kind: LogEventKind[]; source?: string[] },
  since: number,
  signal?: AbortSignal,
): Promise<Loaded<LogEvent>> {
  const items: LogEvent[] = [];
  let before: string | undefined;
  let cut = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const got = await api.factEvents(
      { ...q, since: new Date(since).toISOString(), order: "desc", limit: PAGE, ...(before ? { before } : {}) },
      { signal },
    );
    items.push(...got);
    const last = got[got.length - 1];
    if (got.length < PAGE || last === undefined) {
      cut = false;
      break;
    }
    before = last.id;
    cut = true;
  }
  items.reverse();
  const oldest = items[0];
  const from = cut && oldest !== undefined ? (Date.parse(oldest.at) || ulidTime(oldest.id) || since) : since;
  return { items, from: Math.max(since, from) };
}

/** The sources of §18.1 over `[now - windowMs, now]`. */
export async function loadEvalData(
  api: Pick<Api, "factEvents" | "factDeliveries">,
  now: number,
  windowMs: number,
  signal?: AbortSignal,
): Promise<EvalData> {
  const since = Math.floor((now - windowMs) / 60_000) * 60_000;
  const [focus, floor, utterances, latency, commitments, boots, deliveries] = await Promise.all([
    pages(api, { kind: ["decision"], source: ["agent.focus"] }, since, signal),
    pages(api, { kind: ["decision"], source: ["floor"] }, since, signal),
    pages(api, { kind: ["utterance"] }, since, signal),
    pages(api, { kind: ["result"], source: ["voice.latency"] }, since, signal),
    pages(api, { kind: ["decision"], source: ["mainline.commitment"] }, since, signal),
    pages(api, { kind: ["observation"], source: ["core.lifecycle"] }, since, signal),
    api.factDeliveries(PAGE, { signal }),
  ]);
  // The ledger answers newest first and only the newest `PAGE`.
  const ledger = [...deliveries].reverse();
  const oldest = ledger[0];
  const full = deliveries.length >= PAGE;
  return {
    now,
    since,
    focus,
    floor,
    utterances,
    latency,
    commitments,
    deliveries: {
      items: ledger,
      from: full && oldest !== undefined ? Math.max(since, Date.parse(oldest.delivered_at) || since) : since,
    },
    boots: bootTimes(boots.items),
  };
}

/** The `core.lifecycle` lines that say the Core started. */
export function bootTimes(events: LogEvent[]): number[] {
  const out: number[] = [];
  for (const e of events) {
    const body = e.body;
    if (body === null || typeof body !== "object") continue;
    const o = (body as { observation?: { attention_key?: unknown } }).observation;
    if (o?.attention_key === "system:boot") out.push(Date.parse(e.at));
  }
  return out.filter(Number.isFinite).sort((a, b) => a - b);
}
