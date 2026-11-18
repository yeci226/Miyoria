// Danmaku (docs/design/v5-play.md §11.6): a member pays a few coins for one short line that
// crosses the stream overlay while she is live.
//
// * The money follows the market wallet's "charge recorded, settled later": before the charge a
//   `danmaku` document is written (`charging`), the ledger row `danmaku` is keyed on the request
//   (`danmaku:<key>`, so a retry is the same row), and the document becomes `sent` before the line
//   is published. The stage answers each line once (`stage.danmaku`): `shown` keeps the coins,
//   anything else gives them back as one `danmaku_refund` row keyed on the charge. A sweep settles
//   what a restart left in the middle: a `charging` document whose charge exists is given back (the
//   line was never published), a `sent` one without an answer long after its wait is given back
//   too. A line is published once, when it is charged, and never again, so a restart cannot show
//   it twice; when it is unclear whether it was seen, the member gets the coins back.
// * Coins never buy anything of her: no bond, no board, no share for her purse. She is not asked
//   about each line: at most one note per `danmaku_note_s` tells her a few of the lines that were
//   shown, like stream chat (`ambient`, nothing addressed to her, no word of who paid what).
// * The text is cleaned (one line, no invisible or control characters) and refused when it has a
//   mention or a link, then passes the same moderation as the screen message. A refused line, and
//   every refusal before the charge, costs nothing.
// * Someone the owner tagged `no_danmaku` (`/admin person tag`) cannot send one; nothing else of
//   theirs changes.

import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  ActivityManagerKey,
  type BusEvent,
  EventLogKey,
  Events,
  escapeData,
  HeartKey,
  is,
  type JsonObject,
  newId,
  safeName,
  toTimestamp,
} from "@miyoria/types";
import { type EconomyService, type Member, plainName, STRANGER } from "./economy.js";
import type { CoinEntry, EconomyDoc } from "./records.js";
import {
  DANMAKU_REASON,
  DANMAKU_REFUND_REASON,
  type DanmakuView,
  EconomyError,
  type SpendResult,
} from "./types.js";

/** Ledger reasons: the charge, and the charge given back when the line was not shown. */
export { DANMAKU_REASON, DANMAKU_REFUND_REASON };
/** The economy document of one line, keyed by the line's id. */
export const DANMAKU_KIND = "danmaku";
/** The heart tag that keeps someone's danmaku off the stream. */
export const NO_DANMAKU_TAG = "no_danmaku";

export const DANMAKU_OFF = "現在沒有開放彈幕";
export const DANMAKU_NOT_LIVE = "她現在沒有開台,彈幕發不出去";
export const DANMAKU_NO_STAGE = "直播畫面現在接不上,等一下再試";
export const DANMAKU_MUTED = "你現在不能發彈幕";
export const DANMAKU_REFUSED = "這則彈幕沒辦法上螢幕";
export const DANMAKU_NO_LINKS = "彈幕不能有連結或提及別人";
export const DANMAKU_SENT = "彈幕送出了,沒顯示出來的會自動退回";
const UNSENT = "這則彈幕沒送出去,已經退回";

/** How a line ended on the stage (`stage.danmaku`). */
export type DanmakuOutcome =
  | "shown"
  | "no_overlay"
  | "queue_full"
  | "too_late"
  | "cleared"
  | "lost";

/** A `charging` document older than this is settled by the sweep (the request died midway). */
export const CHARGING_GRACE_MS = 60_000;
/** On top of the longest wait: how long an answer may take before a line counts as lost. */
export const ANSWER_GRACE_MS = 90_000;
/** Documents one sweep looks at. */
const SWEEP_ROWS = 500;
/** Rows read for a day's count; a day of one person is far less. */
const MAX_ROWS = 2_000;
/** Lines one note to her quotes, and lines kept for it at most. */
const NOTE_LINES = 3;
const NOTE_KEEP = 50;
/** Her working-context bucket of the notes, and how many it keeps. */
const NOTE_WRITER = "danmaku";
const NOTE_ENTRIES = 3;
export const NOTE_SOURCE = "economy.danmaku";
export const NOTE_KEY = "economy:danmaku";

/** `[from-to]` code point ranges as a character class (keeps invisible characters out of the source). */
function charClass(ranges: readonly [number, number][]): RegExp {
  const ch = (c: number) => `\\u{${c.toString(16)}}`;
  return new RegExp(`[${ranges.map(([a, b]) => `${ch(a)}-${ch(b)}`).join("")}]`, "gu");
}

/**
 * Invisible characters, removed: the soft hyphen, combining grapheme joiner, Arabic letter mark,
 * Hangul and Khmer fillers, Mongolian selectors, zero-width characters and joiners, bidirectional
 * controls, word joiners and invisible operators, the BOM, variation selectors and tags.
 */
const INVISIBLE = charClass([
  [0xad, 0xad],
  [0x34f, 0x34f],
  [0x61c, 0x61c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180b, 0x180f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
]);
/** C0 and C1 controls and the line and paragraph separators, made spaces. */
const CONTROL = charClass([
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x2028, 0x2029],
]);
/** `@someone`, `<@123>`, `<#123>`, `<@&123>`, `@everyone`. */
const MENTION = /@\S|<[@#][!&]?\d/;
/** `https://`, `www.`, `discord.gg/`, or a bare domain of a common top-level domain. */
const LINK =
  /:\/\/|\bwww\.|discord(?:app)?\.(?:gg|com)\b|\b[a-z0-9-]+\.(?:com|net|org|tw|io|gg|me|xyz|cc|co|tv|app|dev|link|ly|to|jp|cn|ru|top|site|info|biz|live|shop)\b/i;

/** A line as it goes on the screen, or why it cannot. */
export type CleanLine = { ok: true; text: string } | { ok: false; why: string };

/**
 * `raw` as one danmaku line: invisible and control characters removed, on one line, at most
 * `maxChars` characters; refused with a mention or a link (nothing is cut out of a line, so what
 * shows is what they wrote).
 */
export function danmakuText(raw: string, maxChars: number): CleanLine {
  const text = raw
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim();
  const length = [...text].length;
  if (length < 1 || length > maxChars) return { ok: false, why: `彈幕要 1 到 ${maxChars} 個字` };
  if (MENTION.test(text) || LINK.test(text)) return { ok: false, why: DANMAKU_NO_LINKS };
  return { ok: true, text };
}

/**
 * How many ms are left before this person may send another line: from their `danmaku` rows that
 * were not given back, `0` when none is within `cooldownMs`. `rows` holds the `danmaku` and
 * `danmaku_refund` rows of that window.
 */
export function danmakuWait(rows: readonly CoinEntry[], cooldownMs: number, now: number): number {
  const back = new Set(rows.filter((r) => r.reason === DANMAKU_REFUND_REASON).map((r) => r.ref));
  let wait = 0;
  for (const r of rows) {
    if (r.reason !== DANMAKU_REASON || r.delta >= 0 || back.has(r.id)) continue;
    wait = Math.max(wait, Date.parse(r.ts) + cooldownMs - now);
  }
  return wait;
}

/** Lines of `rows` that were charged and not given back. */
export function danmakuKept(rows: readonly CoinEntry[]): number {
  const back = new Set(rows.filter((r) => r.reason === DANMAKU_REFUND_REASON).map((r) => r.ref));
  return rows.filter((r) => r.reason === DANMAKU_REASON && r.delta < 0 && !back.has(r.id)).length;
}

/** What a line's document keeps. */
interface LineData {
  /** The ledger key of the charge (`danmaku:<key>`). */
  idem: string;
  /** The display name it went out with (`null`: names hidden). */
  name: string | null;
  /** Who sent it, for her note (untrusted). */
  sender: string;
  text: string;
  price: number;
  /** The charge's ledger row, once charged. */
  charge: string | null;
  outcome: DanmakuOutcome | null;
}

function lineData(doc: EconomyDoc): LineData {
  const d = doc.data as Partial<Record<keyof LineData, unknown>>;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    idem: str(d.idem) ?? "",
    name: str(d.name),
    sender: str(d.sender) ?? "",
    text: str(d.text) ?? "",
    price: typeof d.price === "number" ? d.price : 0,
    charge: str(d.charge),
    outcome: (str(d.outcome) as DanmakuOutcome | null) ?? null,
  };
}

/** A line she may hear about in the next note. */
interface Heard {
  sender: string;
  text: string;
}

export class DanmakuDesk {
  /** From `stage.status`: the node is connected (`null`: not heard yet). */
  #stage: boolean | null = null;
  /** From `stage.status`: OBS streams (used when there is no ActivityManager). */
  #streaming = false;
  #wasLive: boolean | null = null;
  #heard: Heard[] = [];
  #heardCount = 0;
  #lastNote = 0;
  #revision = 0;

  constructor(private readonly e: EconomyService) {}

  // ---- being live ------------------------------------------------------------------------

  /** She is live and a line can reach the overlay. */
  live(): boolean {
    if (!this.e.stageUp() || this.#stage === false) return false;
    const manager = this.e.services.get(ActivityManagerKey);
    if (!manager) return this.#streaming;
    try {
      return manager.snapshot().broadcast.type === "live";
    } catch {
      return false;
    }
  }

  /**
   * Bus events: the stage's answers, its status, and her broadcast. When the stream ends, the
   * lines still waiting on the overlay are cleared (and so given back).
   */
  async onEvent(event: BusEvent): Promise<void> {
    if (is(Events.StageDanmaku, event)) {
      await this.settle(event.data.id, event.data.outcome);
      return;
    }
    if (is(Events.StageStatus, event)) {
      const data = event.data;
      this.#stage = data.connected;
      this.#streaming = data.connected && data.streaming;
    }
    if (is(Events.StageStatus, event) || is(Events.ActivityChanged, event)) {
      const live = this.live();
      if (this.#wasLive === true && !live) this.clear();
      this.#wasLive = live;
    }
  }

  /** Takes every line off the overlay; the ones still waiting are given back. */
  clear(): void {
    this.e.publish(Events.EconomyDanmakuClear, {});
  }

  // ---- reading -----------------------------------------------------------------------------

  #muted(who: Member): boolean {
    try {
      return (
        this.e.services.get(HeartKey)?.view(who.person.id)?.tags.includes(NO_DANMAKU_TAG) ?? false
      );
    } catch {
      return false;
    }
  }

  async #window(who: Member, since: number): Promise<CoinEntry[]> {
    return this.e.ledger().entries(this.e.profile, who.wallet, {
      reasons: [DANMAKU_REASON, DANMAKU_REFUND_REASON],
      since: toTimestamp(since),
      limit: MAX_ROWS,
    });
  }

  async #sentToday(who: Member): Promise<number> {
    return danmakuKept(await this.#window(who, Date.parse(this.e.todayStart())));
  }

  async #wait(who: Member, now: number): Promise<number> {
    const cooldown = this.e.config.danmaku_cooldown_s * 1000;
    if (cooldown <= 0) return 0;
    return danmakuWait(await this.#window(who, now - cooldown), cooldown, now);
  }

  #waitText(ms: number): string {
    return `每 ${this.e.config.danmaku_cooldown_s} 秒只能發一則,還要等 ${Math.max(Math.ceil(ms / 1000), 1)} 秒`;
  }

  #capText(): string {
    return `今天最多 ${this.e.config.danmaku_per_day} 則`;
  }

  /** What a line costs this person now, and why they cannot send one (if so). */
  async view(account: AccountRef): Promise<DanmakuView> {
    const c = this.e.config;
    const live = this.live();
    const base = {
      open: c.danmaku_on,
      live,
      currency: c.currency,
      price: c.danmaku,
      max_chars: c.danmaku_max_chars,
      cooldown_s: c.danmaku_cooldown_s,
      per_day: c.danmaku_per_day,
    };
    const who = await this.e.member(account);
    if (!who) return { ...base, sent_today: 0, wait_s: 0, balance: 0, why: STRANGER };
    const now = this.e.now();
    const [sent, wait, balance] = await Promise.all([
      this.#sentToday(who),
      this.#wait(who, now),
      this.e.ledger().balance(this.e.profile, who.wallet),
    ]);
    const why = !c.danmaku_on
      ? DANMAKU_OFF
      : this.#muted(who)
        ? DANMAKU_MUTED
        : !live
          ? this.#stage === false && this.e.stageUp()
            ? DANMAKU_NO_STAGE
            : DANMAKU_NOT_LIVE
          : sent >= c.danmaku_per_day
            ? this.#capText()
            : wait > 0
              ? this.#waitText(wait)
              : balance < c.danmaku
                ? `${c.currency}不夠`
                : null;
    return { ...base, sent_today: sent, wait_s: Math.ceil(wait / 1000), balance, why };
  }

  // ---- sending -----------------------------------------------------------------------------

  /**
   * Charges one line and puts it on the overlay. `EconomyError`: 400 empty, too long or with a link
   * or mention, 402 short, 403 a stranger, 409 off, muted or not live, 429 the cooldown or the day's
   * limit. Moderation's refusal is `accepted: false`. The same key twice answers what the first
   * did and publishes nothing.
   */
  async send(account: AccountRef, raw: string, key: string): Promise<SpendResult> {
    const c = this.e.config;
    if (!c.danmaku_on) throw new EconomyError(409, DANMAKU_OFF);
    const clean = danmakuText(raw, c.danmaku_max_chars);
    if (!clean.ok) throw new EconomyError(400, clean.why);
    const who = await this.e.member(account);
    if (!who) throw new EconomyError(403, STRANGER);
    const idem = `${DANMAKU_REASON}:${key}`;
    const out = await this.e.serial(
      async (): Promise<
        | { first: CoinEntry }
        | { refused: SpendResult }
        | { id: string; entry: CoinEntry; balance: number }
      > => {
        const first = await this.e.byKey(who, idem);
        if (first) return { first };
        if (this.#muted(who)) throw new EconomyError(409, DANMAKU_MUTED);
        const now = this.e.now();
        const wait = await this.#wait(who, now);
        if (wait > 0) throw new EconomyError(429, this.#waitText(wait));
        if (!this.live()) {
          const why =
            this.#stage === false && this.e.stageUp() ? DANMAKU_NO_STAGE : DANMAKU_NOT_LIVE;
          throw new EconomyError(409, why);
        }
        if (!this.e.passes(who, clean.text)) {
          const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
          return { refused: { accepted: false, charged: 0, balance, message: DANMAKU_REFUSED } };
        }
        if ((await this.#sentToday(who)) >= c.danmaku_per_day) {
          throw new EconomyError(429, this.#capText());
        }
        return this.#charge(who, idem, clean.text, now);
      },
    );
    if ("refused" in out) return out.refused;
    if ("first" in out) return this.#again(who, out.first);
    const name = c.danmaku_show_names ? plainName(who.name) : null;
    this.e.publish(Events.EconomyDanmaku, {
      id: out.id,
      name,
      text: clean.text,
      max_on_screen: c.danmaku_max_on_screen,
      queue_max: c.danmaku_queue_max,
      max_wait_ms: c.danmaku_max_wait_s * 1000,
    });
    this.e.record(who, "economy.danmaku", { charged: c.danmaku, chars: [...clean.text].length });
    return { accepted: true, charged: c.danmaku, balance: out.balance, message: DANMAKU_SENT };
  }

  /** The document first, then the charge, then `sent`: each step is one a restart can finish. */
  async #charge(
    who: Member,
    idem: string,
    text: string,
    now: number,
  ): Promise<{ id: string; entry: CoinEntry; balance: number }> {
    const c = this.e.config;
    const docs = this.e.docs();
    const id = newId();
    const at = toTimestamp(now);
    const data: LineData = {
      idem,
      name: c.danmaku_show_names ? plainName(who.name) : null,
      sender: who.name,
      text,
      price: c.danmaku,
      charge: null,
      outcome: null,
    };
    const created = await docs.create({
      id,
      kind: DANMAKU_KIND,
      owner: who.account,
      status: "charging",
      version: 1,
      data: data as unknown as JsonObject,
      created_at: at,
      updated_at: at,
    });
    if (!created) throw new EconomyError(503, UNSENT);
    let spent: Awaited<ReturnType<EconomyService["spend"]>>;
    try {
      spent = await this.e.spend(who, c.danmaku, DANMAKU_REASON, id, idem);
    } catch (error) {
      await this.#mark(id, 1, "void", data).catch(() => false);
      throw error;
    }
    const sent = await this.#mark(id, 1, "sent", { ...data, charge: spent.entry.id }).catch(
      (error: unknown) => {
        this.e.log.warn({ err: errorMessage(error), line: id }, "danmaku: cannot mark a line sent");
        return false;
      },
    );
    if (!sent) {
      // Not published: give it back now (the sweep would, later).
      await this.#giveBack(who, spent.entry).catch(() => false);
      throw new EconomyError(503, UNSENT);
    }
    return { id, entry: spent.entry, balance: spent.balance };
  }

  /** A retried key: the first answer, without publishing again. */
  async #again(who: Member, first: CoinEntry): Promise<SpendResult> {
    const balance = await this.e.ledger().balance(this.e.profile, who.wallet);
    const back = await this.e.byKey(who, `${DANMAKU_REFUND_REASON}:${first.id}`);
    return back !== null
      ? { accepted: true, charged: 0, balance, message: UNSENT }
      : { accepted: true, charged: -first.delta, balance, message: DANMAKU_SENT };
  }

  async #mark(id: string, version: number, status: string, data: LineData): Promise<boolean> {
    return this.e.docs().update(this.e.profile, DANMAKU_KIND, id, version, {
      status,
      data: data as unknown as JsonObject,
      at: toTimestamp(this.e.now()),
    });
  }

  /** One `danmaku_refund` row keyed on the charge; `true` when it is (now or already) given back. */
  async #giveBack(who: Member, charge: CoinEntry): Promise<boolean> {
    const post = await this.e
      .ledger()
      .post(
        this.e.entryFor(
          who,
          -charge.delta,
          DANMAKU_REFUND_REASON,
          charge.id,
          `${DANMAKU_REFUND_REASON}:${charge.id}`,
        ),
      );
    if (post.status === "posted" || post.status === "duplicate") return true;
    this.e.log.warn({ charge: charge.id, status: post.status }, "danmaku: a refund was not posted");
    return false;
  }

  // ---- settling ----------------------------------------------------------------------------

  /** The stage's answer for line `id`: shown keeps the coins, anything else gives them back. */
  async settle(id: string, outcome: DanmakuOutcome): Promise<void> {
    try {
      await this.e.serial(async () => {
        const doc = await this.e.docs().get(this.e.profile, DANMAKU_KIND, id);
        if (doc?.status !== "sent") return;
        const data = lineData(doc);
        if (outcome === "shown") {
          if (await this.#mark(id, doc.version, "shown", { ...data, outcome })) {
            this.#hear({ sender: data.sender, text: data.text });
          }
          return;
        }
        await this.#refundDoc(doc, outcome);
      });
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error), line: id }, "danmaku: cannot settle a line");
    }
  }

  /** Gives a line's charge back and marks it; one with no charge is void. */
  async #refundDoc(doc: EconomyDoc, outcome: DanmakuOutcome): Promise<void> {
    const data = lineData(doc);
    const owner = doc.owner;
    if (owner === null) return;
    let who: Member;
    try {
      who = await this.e.holder(owner);
    } catch {
      // Nobody to give it to any more (forgotten): nothing is owed to anyone.
      await this.#mark(doc.id, doc.version, "void", { ...data, outcome });
      return;
    }
    const charge = await this.e.byKey(who, data.idem);
    if (charge === null || charge.delta >= 0) {
      await this.#mark(doc.id, doc.version, "void", { ...data, outcome });
      return;
    }
    if (await this.#giveBack(who, charge)) {
      await this.#mark(doc.id, doc.version, "refunded", { ...data, charge: charge.id, outcome });
    }
  }

  /**
   * Finishes what a restart (or a lost answer) left: a `charging` line older than a minute was
   * never published, a `sent` one without an answer long after its wait was not seen as far as
   * anyone knows. Both are given back.
   */
  async sweep(now: number): Promise<void> {
    const c = this.e.config;
    const docs = await this.e.docs().list(this.e.profile, DANMAKU_KIND, {
      statuses: ["charging", "sent"],
      limit: SWEEP_ROWS,
    });
    const answerBy = c.danmaku_max_wait_s * 1000 + ANSWER_GRACE_MS;
    for (const listed of docs) {
      const age = now - Date.parse(listed.created_at);
      const due = listed.status === "charging" ? age > CHARGING_GRACE_MS : age > answerBy;
      if (!due) continue;
      try {
        await this.e.serial(async () => {
          const doc = await this.e.docs().get(this.e.profile, DANMAKU_KIND, listed.id);
          if (!doc || doc.status !== listed.status) return;
          await this.#refundDoc(doc, "lost");
        });
      } catch (error) {
        this.e.log.warn({ err: errorMessage(error), line: listed.id }, "danmaku: sweep failed");
      }
    }
  }

  // ---- her side ------------------------------------------------------------------------------

  #hear(line: Heard): void {
    this.#heardCount += 1;
    this.#heard.push(line);
    if (this.#heard.length > NOTE_KEEP) this.#heard.shift();
  }

  /**
   * At most once per `danmaku_note_s`: one ambient note with a few of the lines shown since the
   * last one (none when nothing came). `true` when a note was written.
   */
  note(now: number): boolean {
    if (now - this.#lastNote < this.e.config.danmaku_note_s * 1000) return false;
    if (this.#heardCount === 0) return false;
    const count = this.#heardCount;
    const pool = this.#heard;
    this.#heard = [];
    this.#heardCount = 0;
    this.#lastNote = now;
    const picked: Heard[] = [];
    const left = [...pool];
    while (picked.length < NOTE_LINES && left.length > 0) {
      const i = Math.min(Math.floor(this.e.random() * left.length), left.length - 1);
      picked.push(...left.splice(i, 1));
    }
    const quoted = picked
      .map((l) => `${safeName(l.sender || "有人")}:「${escapeData(l.text)}」`)
      .join("、");
    const summary =
      count > picked.length
        ? `直播畫面上這段時間飄過 ${count} 則觀眾的彈幕,其中幾則:${quoted}。`
        : `直播畫面上這段時間飄過 ${count} 則觀眾的彈幕:${quoted}。`;
    const log = this.e.services.get(EventLogKey);
    if (!log) return false;
    // Seconds since the epoch: it only goes up, across restarts too.
    this.#revision = Math.max(Math.floor(now / 1000), this.#revision + 1);
    try {
      log.observe(
        {
          source: NOTE_SOURCE,
          silent: true,
          salience: "ambient",
          attention_key: NOTE_KEY,
          revision: this.#revision,
          summary,
          // Like stream chat: nobody waits for an answer.
          addressed_to_her: false,
          from: null,
          context: null,
        },
        {
          buckets: [
            {
              op: "append-self",
              writer: NOTE_WRITER,
              owner: "economy",
              untrusted: true,
              max_entries: NOTE_ENTRIES,
            },
          ],
          person: null,
        },
      );
      return true;
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error) }, "danmaku: cannot write her note");
      return false;
    }
  }

  // ---- the owner's card ----------------------------------------------------------------------

  /** Lines shown today and the coins they took (given-back ones are neither). */
  async today(): Promise<{ lines: number; coins: number }> {
    const since = this.e.todayStart();
    const docs = await this.e.docs().list(this.e.profile, DANMAKU_KIND, {
      statuses: ["shown"],
      limit: MAX_ROWS,
    });
    let lines = 0;
    let coins = 0;
    for (const doc of docs) {
      if (doc.created_at < since) continue;
      lines += 1;
      coins += lineData(doc).price;
    }
    return { lines, coins };
  }
}
