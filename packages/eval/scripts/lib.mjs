// Shared by the extraction scripts: the database (read-only), the owner's id, anonymising and the
// conversions from rows to trace events.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const root = resolve(here, "..", "..", "..");
export const args = process.argv.slice(2);
export const opt = (name, fallback) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : fallback;
};
export const dbPath = resolve(process.cwd(), opt("--db", join(root, "data", "miyoria.db")));

function ownerId() {
  const given = opt("--owner-id", process.env.MIYORIA_OWNER_ID);
  if (given) return given;
  const envFile = join(root, ".env");
  if (existsSync(envFile)) {
    const m = /^MIYORIA_OWNER_ID=["']?(\d+)/m.exec(readFileSync(envFile, "utf8"));
    if (m) return m[1];
  }
  throw new Error("owner id unknown: pass --owner-id or set MIYORIA_OWNER_ID");
}
export const OWNER = ownerId();

// `mode=ro` through the URI: the Core keeps writing to this file, and so must not we.
export const db = new DatabaseSync(`file:${dbPath.replaceAll("\\", "/")}?mode=ro`, {
  readOnly: true,
});

// ---- rows -------------------------------------------------------------------------------------

const EVENTS = db.prepare(
  "select seq, at, kind, source, body from log_events where seq between ? and ? order by seq",
);
export function events(lo, hi, filter = () => true) {
  return EVENTS.all(lo, hi)
    .map((r) => ({ ...r, body: JSON.parse(r.body) }))
    .filter(filter);
}
const MESSAGES = db.prepare(
  "select seq, ts, context_key, author_id, author_name, is_self, text from message_log where seq between ? and ? order by seq",
);
export const messages = (lo, hi) => MESSAGES.all(lo, hi);
const AUDIT = db.prepare(
  "select at, action, detail from audit_log where at between ? and ? and action like ? order by at",
);
export const audit = (fromUs, toUs, like) =>
  AUDIT.all(fromUs, toUs, like).map((r) => ({ ...r, detail: JSON.parse(r.detail) }));

export const us = (iso) => Date.parse(iso) * 1000;

export function need(rows, what) {
  if (rows.length === 0) {
    throw new Error(`${what}: no rows, is this the database of 2026-11-07/08? (${dbPath})`);
  }
  return rows;
}

// ---- anonymising ------------------------------------------------------------------------------

/** Display names of everyone the database knows (3+ characters), except her own names. */
const KNOWN_NAMES = [
  ...db.prepare("select display_name as n from people").all(),
  ...db.prepare("select distinct author_name as n from message_log where is_self = 0").all(),
]
  .map((r) => (r.n ?? "").trim())
  .filter((n) => [...n].length >= 3 && !/miyo|米優/i.test(n));

/** People become `owner` and `viewer-N` (stable within one fixture, in order of appearance). */
export class Anon {
  constructor() {
    this.names = new Map();
  }
  add(name) {
    const n = (name ?? "").trim();
    if (n.length < 2 || this.names.has(n)) return;
    this.names.set(n, `viewer-${this.names.size + 1}`);
  }
  who(id, name) {
    if (id === OWNER) return "owner";
    this.add(name);
    return this.names.get((name ?? "").trim()) ?? "viewer-0";
  }
  text(s) {
    let out = s
      .replace(/<@!?&?\d+>/g, "@someone")
      .replace(/\b\d{15,20}\b/g, "<id>")
      .replace(/https?:\/\/\S+/g, "<url>");
    const owner = db
      .prepare("select author_name from message_log where author_id = ? order by seq desc limit 1")
      .get(OWNER);
    // Any known person named in the text is a viewer, even one who never wrote in this window.
    for (const known of KNOWN_NAMES)
      if (out.toLowerCase().includes(known.toLowerCase())) this.add(known);
    const names = [...this.names.keys()];
    if (owner?.author_name) names.push(owner.author_name);
    for (const n of names.sort((a, b) => b.length - a.length)) {
      const label = n === owner?.author_name ? "owner" : this.names.get(n);
      out = out.replaceAll(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), label);
    }
    return out;
  }
}

// ---- trace helpers ----------------------------------------------------------------------------

export const round = (n) => Math.round(n * 10) / 10;
export const iso = (us0) => {
  const d = new Date(us0 / 1000 + 8 * 3600_000);
  return `${d.toISOString().slice(0, 19)}+08:00`;
};

/** The lines of the turn that said the line at `seq` (log_events, source mainline). */
export function turnLines(seq) {
  const row = need(
    events(seq, seq, (e) => e.kind === "utterance"),
    `utterance ${seq}`,
  )[0];
  const lines = events(
    seq - 60,
    seq + 60,
    (e) => e.kind === "utterance" && e.source === "mainline",
  );
  return lines.filter((e) => e.body.turn === row.body.turn);
}

export const saidOf = (rows, t0, anon) =>
  rows.map((e) => ({
    type: "said",
    t: round((e.at - t0) / 1e6),
    channel: e.body.channel === "voice" ? "voice" : "text",
    text: anon.text(e.body.said),
  }));

export const MARKUP = /<\/?[a-z][a-z0-9_:-]*(?:[\s"'][^<>]*)?\/?>|<\/?｜｜DSML｜｜[^>]*>?/gi;
export const withoutMarkup = (s) =>
  s
    .replace(MARKUP, "")
    .replace(/\n{2,}/g, "\n")
    .trim();

export function gateEvents(rows, t0) {
  return rows.map((r) => {
    const d = r.detail;
    const kind = d.principal?.kind ?? "?";
    const requester = d.principal?.requester?.id;
    const principal = requester === OWNER ? "owner" : kind === "user" ? "viewer" : kind;
    const args = d.args && typeof d.args === "object" ? d.args : undefined;
    const keep = args && "game" in args ? { game: String(args.game) } : undefined;
    return {
      type: "gate",
      t: round((r.at - t0) / 1e6),
      capability: d.capability,
      principal,
      allowed: d.allowed === true,
      ...(keep ? { args: keep } : {}),
    };
  });
}
