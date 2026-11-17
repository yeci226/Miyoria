#!/usr/bin/env node
// Turns a window of the database (read-only) into a trace, so a fixture that has no code to run
// (harness `trace`) can be judged again on a fresh recording of the same case:
//
//   node scripts/window-trace.mjs --from 2026-11-09T21:00:00+08:00 --to 2026-11-09T21:10:00+08:00 > t.json
//   pnpm eval --trace t.json stage-stream-failure-unseen
//
// Same anonymising as the fixtures. The owner's lines are kept (the rule checks need them);
// other people's text is dropped. Game steps are not part of it: those fixtures have code to run.

import {
  Anon,
  audit,
  db,
  events,
  gateEvents,
  messages,
  OWNER,
  opt,
  round,
  saidOf,
  us,
} from "./lib.mjs";

const from = us(opt("--from", ""));
const to = us(opt("--to", ""));
if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
  process.stderr.write("usage: window-trace.mjs --from ISO --to ISO [--db FILE] [--owner-id ID]\n");
  process.exit(2);
}

const bounds = db
  .prepare("select min(seq) as lo, max(seq) as hi from log_events where at between ? and ?")
  .get(from, to);
if (bounds.lo === null) {
  process.stderr.write("no events in that window\n");
  process.exit(1);
}
const anon = new Anon();
const rows = events(bounds.lo, bounds.hi);
const trace = [];

const utterances = rows.filter((e) => e.kind === "utterance" && e.source === "mainline");
for (const u of utterances) for (const a of u.body.audience ?? []) anon.add(a);
const said = saidOf(utterances, from, anon);
trace.push(...said);

// A tool she wrote as text is a call that was not made; the hands log has the ones that were.
for (const [i, u] of utterances.entries()) {
  for (const m of u.body.said.matchAll(/<\/?([a-z]+_[a-z0-9_]+)/g)) {
    trace.push({ type: "call", t: said[i].t, tool: m[1], native: false });
  }
}
for (const e of rows.filter((r) => r.kind === "action" && r.source === "mainline.hands")) {
  trace.push({ type: "call", t: round((e.at - from) / 1e6), tool: e.body.tool, native: true });
}

const PROHIBIT = /(不要|別|不准|先不要)(再)?(玩|打|開|唱|直播)/;
const RELEASE = /(可以|去)(玩|打)了/;
const lo = db.prepare("select min(seq) as s from message_log where ts >= ?").get(from).s;
const hi = db.prepare("select max(seq) as s from message_log where ts <= ?").get(to).s;
if (lo !== null && hi !== null) {
  for (const m of messages(lo, hi)) {
    if (m.is_self) continue;
    const who = anon.who(m.author_id, m.author_name);
    const owner = m.author_id === OWNER;
    const intent =
      owner && PROHIBIT.test(m.text)
        ? "prohibition"
        : owner && RELEASE.test(m.text)
          ? "release"
          : undefined;
    trace.push({
      type: "heard",
      t: round((m.ts - from) / 1e6),
      who,
      ...(owner ? { text: anon.text(m.text) } : {}),
      ...(intent ? { intent } : {}),
    });
  }
}

trace.push(...gateEvents(audit(from, to, "gate.%"), from));

for (const e of rows.filter((r) => r.kind === "observation" && r.source === "stage")) {
  const text = e.body.observation.summary;
  trace.push({
    type: "observe",
    t: round((e.at - from) / 1e6),
    source: "stage",
    text,
    ...(/出錯|失敗|沒有連上/.test(text) ? { error: true } : {}),
  });
}

trace.sort((a, b) => a.t - b.t);
process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
