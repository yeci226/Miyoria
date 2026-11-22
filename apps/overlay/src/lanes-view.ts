// The karaoke scene's pitch lanes on the page: a column of lanes over the round's screen, one per
// singer (src/lanes.ts decides who and where), each a canvas with the reference notes going past the
// now line and the singer's line in their colour (dashed for colours six to eight), and beside it
// who they are: their mark (the name's first letter in their colour), name, place, running score
// (counting up to each new one), the notes they hit in a row, and the cheers they got.
//
// Spectating (「卡拉 OK 第二次實測留下的」): every note the song goes past is judged for each singer
// with the score's own frame credit (`NoteJudge`, `@miyoria/play/karaoke/score`): a hit note fills
// in their colour, a near one half, a missed one stays an outline, and at the moment of judging a
// ring opens at the note's end with a word over it. A cleanly sung lyric line lights the lane once
// and is called out (`onPhrase`). A cheer floats up from the singer's name. The leader's lane has
// the primary hairline. Under reduced motion there are no rings, words or floats: the fills, the
// numbers and the marks only. Redrawn every animation frame on the scene's song clock; nothing
// here reads layout outside a resize.

import { NoteJudge, type Verdict } from "@miyoria/play/karaoke/score";
import type { KaraokeCheer, KaraokeLine, KaraokeNote } from "./feed.js";
import { CHEER_WORDS, comboText, countUp, initialOf, memberSwatch, scoreText, VERDICT_WORDS } from "./karaoke.js";
import {
  LANE_HZ,
  type LaneSinger,
  LaneTracks,
  laneHeight,
  laneRange,
  laneWindow,
  laneX,
  laneY,
  notesIn,
  strokes,
} from "./lanes.js";

/** The column's height and the gap between lanes (rem), as style.css has them. */
const COLUMN_REM = 34;
const COLUMN_RUBY_REM = 29;
const GAP_REM = 0.5;
/** A point this recent (s) gets a dot at the tip of the line. */
const TIP_S = 0.4;
/** A burst at a judged note: how long it lasts (ms). */
const BURST_MS = 650;
/** A score counts up to a new one over this long (ms). */
const COUNT_MS = 700;
/** A cheer floats this long (ms), and at most this many at once on a lane. */
const CHEER_MS = 2_600;
const CHEERS_AT_ONCE = 4;

const NOTE = "rgba(240, 238, 244, 0.62)";
const NOTE_NOW = "#ffffff";
const NOTE_PAST = "rgba(240, 238, 244, 0.22)";
const OCTAVE = "rgba(255, 255, 255, 0.10)";
const NOW = "rgba(255, 255, 255, 0.55)";

interface Burst {
  at: number;
  t: number;
  midi: number;
  verdict: Verdict;
}

interface Lane {
  singer: LaneSinger;
  el: HTMLElement;
  rank: HTMLElement;
  score: HTMLElement;
  combo: HTMLElement;
  cheers: HTMLElement;
  flash: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  width: number;
  height: number;
  judge: NoteJudge;
  verdicts: Map<KaraokeNote, Verdict>;
  bursts: Burst[];
  /** The score shown now and where it is going (counting up from `from` since `since`). */
  shown: number | null;
  from: number;
  to: number | null;
  since: number;
  comboShown: string | null;
  floating: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent?: Element, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

/** The lyric lines' spans (song seconds), for judging whole phrases. */
export type Phrases = readonly { start: number; end: number }[];

export class LanesView {
  readonly el: HTMLElement;
  readonly #tracks = new LaneTracks();
  #lanes: Lane[] = [];
  #key = "";
  #notes: readonly KaraokeNote[] = [];
  #phrases: Phrases = [];
  #range = laneRange([]);
  #ruby = false;
  #measured = false;
  /** The members' colours as the canvas takes them (from style.css), read once. */
  #colors: string[] | null = null;
  /** The page's font for the canvas words, read with the sizes. */
  #font = "sans-serif";
  /** A singer sang a lyric line clean (their name and colour). */
  onPhrase: (who: { name: string; color: number }) => void = () => {};

  constructor(parent: Element) {
    this.el = el("div", "k-lanes is-out", parent);
    this.el.hidden = true;
    this.el.setAttribute("aria-hidden", "true");
    addEventListener("resize", () => {
      this.#measured = false;
    });
  }

  /** The singers with a lane now (their order, places and scores), the round's notes and its lines. */
  set(singers: readonly LaneSinger[], notes: readonly KaraokeNote[], ruby: boolean, phrases: Phrases = []): void {
    const notesChanged = notes !== this.#notes || phrases !== this.#phrases;
    if (notesChanged) {
      this.#notes = notes;
      this.#phrases = phrases;
      this.#range = laneRange(notes);
    }
    const key = JSON.stringify([singers.map((s) => s.key), ruby]);
    if (key !== this.#key) {
      this.#key = key;
      this.#ruby = ruby;
      this.#build(singers);
    } else if (notesChanged) {
      for (const lane of this.#lanes) this.#rejudge(lane);
    }
    const now = performance.now();
    const many = singers.length > 1;
    singers.forEach((s, i) => {
      const lane = this.#lanes[i];
      if (lane === undefined) return;
      lane.singer = s;
      if (s.total !== lane.to) {
        lane.from = lane.shown ?? s.total ?? 0;
        lane.to = s.total;
        lane.since = now;
      }
      const rank = many && s.rank !== null ? `#${s.rank}` : "";
      if (lane.rank.textContent !== rank) lane.rank.textContent = rank;
      lane.el.classList.toggle("is-lead", many && s.rank === 1);
      const cheers = s.cheers > 0 ? `應援 ${s.cheers}` : "";
      if (lane.cheers.textContent !== cheers) lane.cheers.textContent = cheers;
    });
  }

  /** A board's pitch pieces (a few times a second while sung). */
  take(board: readonly KaraokeLine[]): void {
    this.#tracks.take(board);
  }

  /** A new round: no pitch is kept, nothing judged. */
  clear(): void {
    this.#tracks.clear();
    for (const lane of this.#lanes) this.#rejudge(lane);
  }

  /** Someone cheered `cheer.to`: their words float up from that singer's name. */
  cheer(cheer: KaraokeCheer, reduced: boolean): void {
    const lane = this.#lanes.find((l) => l.singer.name === cheer.to.name && l.singer.color === cheer.to.color);
    if (lane === undefined || lane.floating >= CHEERS_AT_ONCE) return;
    const pill = el("span", `k-cheer${reduced ? " is-still" : ""}`, lane.el);
    const { slot, hollow } = memberSwatch(cheer.by.color);
    el("i", `k-swatch k-swatch--${slot}${hollow ? " is-hollow" : ""}`, pill);
    // Names are untrusted: text only.
    el("span", "k-cheer__by", pill, cheer.by.name);
    el("span", "k-cheer__word", pill, CHEER_WORDS[cheer.kind]);
    pill.style.setProperty("--k-cheer-x", `${(lane.floating % 2) * 1.2}rem`);
    lane.floating++;
    setTimeout(() => {
      pill.remove();
      lane.floating--;
    }, CHEER_MS);
  }

  #rejudge(lane: Lane): void {
    lane.judge = new NoteJudge(this.#notes, { hz: LANE_HZ, phrases: this.#phrases });
    lane.verdicts = new Map();
    lane.bursts = [];
  }

  #build(singers: readonly LaneSinger[]): void {
    this.el.replaceChildren();
    const height = laneHeight(singers.length, this.#ruby ? COLUMN_RUBY_REM : COLUMN_REM, GAP_REM);
    this.el.classList.toggle("is-compact", height < 5);
    this.el.classList.toggle("has-ruby", this.#ruby);
    this.#lanes = singers.map((singer, i) => {
      const row = el("div", "k-lane", this.el);
      row.style.height = `${height}rem`;
      row.style.setProperty("--i", String(i));
      const who = el("div", "k-lane__who", row);
      const { slot, hollow } = memberSwatch(singer.color);
      el("span", `k-avatar k-avatar--${slot}${hollow ? " is-hollow" : ""}`, who, initialOf(singer.name));
      const text = el("div", "k-lane__id", who);
      const line = el("div", "k-lane__name", text);
      // Names are untrusted: text only.
      el("span", "k-lane__text", line, singer.name);
      const rank = el("span", "k-lane__rank", line);
      const nums = el("div", "k-lane__nums", text);
      const score = el("span", "k-lane__score", nums, scoreText(singer.total));
      const combo = el("span", "k-lane__combo", nums);
      const cheers = el("span", "k-lane__cheers", nums);
      const track = el("div", "k-lane__track", row);
      const canvas = el("canvas", "k-lane__canvas", track);
      const flash = el("div", "k-lane__flash", track);
      const lane: Lane = {
        singer,
        el: row,
        rank,
        score,
        combo,
        cheers,
        flash,
        canvas,
        ctx: canvas.getContext("2d"),
        width: 0,
        height: 0,
        judge: new NoteJudge(this.#notes, { hz: LANE_HZ, phrases: this.#phrases }),
        verdicts: new Map(),
        bursts: [],
        shown: singer.total,
        from: singer.total ?? 0,
        to: singer.total,
        since: 0,
        comboShown: null,
        floating: 0,
      };
      return lane;
    });
    this.#measured = false;
  }

  #measure(): void {
    this.#font = getComputedStyle(this.el).fontFamily || "sans-serif";
    const dpr = Math.min(2, devicePixelRatio || 1);
    for (const lane of this.#lanes) {
      lane.width = lane.canvas.clientWidth;
      lane.height = lane.canvas.clientHeight;
      lane.canvas.width = Math.round(lane.width * dpr);
      lane.canvas.height = Math.round(lane.height * dpr);
      lane.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.#measured = this.#lanes.every((l) => l.width > 0);
  }

  #color(n: number): string {
    if (this.#colors === null) {
      const css = getComputedStyle(document.documentElement);
      this.#colors = [1, 2, 3, 4, 5].map((i) => css.getPropertyValue(`--k-c${i}`).trim() || "#f29dc4");
    }
    return this.#colors[memberSwatch(n).slot - 1] ?? "#f29dc4";
  }

  /** Draws every lane at song time `t` (seconds); `now` is the page's clock (ms). */
  frame(t: number, reduced: boolean, now = performance.now()): void {
    if (this.el.hidden || this.#lanes.length === 0) return;
    if (!this.#measured) this.#measure();
    const win = laneWindow(t, reduced);
    const notes = notesIn(this.#notes, win.from, win.to);
    for (const lane of this.#lanes) {
      this.#judge(lane, t, now, reduced);
      this.#numbers(lane, now);
      this.#draw(lane, t, win, notes, now, reduced);
    }
  }

  /** The notes the song went past since the last frame, judged. */
  #judge(lane: Lane, t: number, now: number, reduced: boolean): void {
    const key = lane.singer.key;
    const got = lane.judge.advance(t, (i) => this.#tracks.frame(key, i));
    for (const j of got) {
      const note = this.#notes[j.note];
      if (note === undefined) continue;
      lane.verdicts.set(note, j.verdict);
      if (!reduced) lane.bursts.push({ at: now, t: note.end, midi: note.midi, verdict: j.verdict });
      if (j.phrase?.perfect) {
        this.onPhrase({ name: lane.singer.name, color: lane.singer.color });
        if (!reduced) {
          lane.flash.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], {
            duration: 900,
            easing: "ease-out",
          });
        }
      }
    }
    if (got.length > 0) {
      const combo = comboText(lane.judge.combo);
      if (combo !== lane.comboShown) {
        const grew = combo !== null;
        lane.comboShown = combo;
        lane.combo.textContent = combo ?? "";
        if (grew && !reduced) {
          lane.combo.animate([{ transform: "translateY(0.25rem) scale(1.15)", opacity: 0.4 }, { transform: "none", opacity: 1 }], {
            duration: 260,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          });
        }
      }
    }
    lane.bursts = lane.bursts.filter((b) => now - b.at < BURST_MS);
  }

  /** The running score, counting up to the latest one. */
  #numbers(lane: Lane, now: number): void {
    if (lane.to === null) {
      if (lane.shown !== null) {
        lane.shown = null;
        lane.score.textContent = scoreText(null);
      }
      return;
    }
    const k = (now - lane.since) / COUNT_MS;
    const v = k >= 1 ? lane.to : countUp(lane.from, lane.to, k);
    const text = scoreText(v);
    lane.shown = v;
    if (lane.score.textContent !== text) lane.score.textContent = text;
  }

  #draw(
    lane: Lane,
    t: number,
    win: { from: number; to: number; nowAt: number },
    notes: readonly KaraokeNote[],
    now: number,
    reduced: boolean,
  ): void {
    const { ctx, width: w, height: h } = lane;
    if (ctx === null || w <= 0 || h <= 0) return;
    const range = this.#range;
    const pad = Math.min(6, h / 8);
    ctx.clearRect(0, 0, w, h);

    // A hairline at every C.
    ctx.lineWidth = 1;
    ctx.strokeStyle = OCTAVE;
    for (let m = Math.ceil(range.lo / 12) * 12; m <= range.hi; m += 12) {
      const y = Math.round(laneY(m, range, h, pad)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }

    // The reference notes: bright ahead, brightest while sung; once judged, filled in the singer's
    // colour when hit (half when near), an outline when missed; dim when passed unjudged.
    const color = this.#color(lane.singer.color);
    const semitone = (h - 2 * pad) / (range.hi - range.lo);
    const barH = Math.max(3, Math.min(10, semitone * 0.8));
    for (const n of notes) {
      const x0 = laneX(n.start, win, w);
      const x1 = laneX(n.end, win, w);
      const y = laneY(n.midi, range, h, pad);
      const bw = Math.max(2, x1 - x0);
      const r = Math.min(3, bw / 2, barH / 2);
      const verdict = lane.verdicts.get(n);
      ctx.beginPath();
      ctx.roundRect(x0, y - barH / 2, bw, barH, r);
      if (verdict === "perfect" || verdict === "good") {
        ctx.globalAlpha = verdict === "perfect" ? 0.95 : 0.55;
        ctx.fillStyle = color;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else if (verdict === "miss") {
        ctx.strokeStyle = NOTE_PAST;
        ctx.lineWidth = 1;
        ctx.stroke();
      } else {
        ctx.fillStyle = n.end <= t ? NOTE_PAST : n.start <= t ? NOTE_NOW : NOTE;
        ctx.fill();
      }
    }

    // The singer's line up to now, in their colour.
    const dashed = memberSwatch(lane.singer.color).hollow;
    const points = this.#tracks.line(lane.singer.key, win.from, t, this.#notes);
    ctx.strokeStyle = color;
    ctx.lineWidth = h < 80 ? 2.5 : 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.setLineDash(dashed ? [6, 5] : []);
    for (const run of strokes(points)) {
      ctx.beginPath();
      run.forEach((p, i) => {
        const x = laneX(p.t, win, w);
        const y = laneY(p.midi as number, range, h, pad);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      // A lone point is a dot (a round cap on a line of no length).
      const [only] = run;
      if (run.length === 1 && only !== undefined) ctx.lineTo(laneX(only.t, win, w), laneY(only.midi as number, range, h, pad));
      ctx.stroke();
    }
    ctx.setLineDash([]);
    const tip = points.findLast((p) => p.midi !== null);
    if (tip !== undefined && tip.midi !== null && t - tip.t < TIP_S) {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(laneX(tip.t, win, w), laneY(tip.midi, range, h, pad), h < 80 ? 3.5 : 4.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Now.
    const nowX = Math.round(win.nowAt * w) + 0.5;
    ctx.strokeStyle = NOW;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(nowX, 0);
    ctx.lineTo(nowX, h);
    ctx.stroke();

    // Each note just judged: a ring opening at its end and its word rising (not under reduced motion).
    if (reduced) return;
    const big = h >= 80;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.font = `600 ${big ? 15 : 12}px ${this.#font}`;
    for (const b of lane.bursts) {
      const k = Math.min(1, (now - b.at) / BURST_MS);
      const x = laneX(b.t, win, w);
      const y = laneY(b.midi, range, h, pad);
      const fade = 1 - k;
      if (b.verdict !== "miss") {
        ctx.globalAlpha = fade * (b.verdict === "perfect" ? 0.9 : 0.6);
        ctx.strokeStyle = b.verdict === "perfect" ? "#ffffff" : color;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, (big ? 6 : 4) + k * (big ? 18 : 11), 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = fade * (b.verdict === "miss" ? 0.55 : 0.95);
      ctx.fillStyle = b.verdict === "miss" ? NOTE_PAST : b.verdict === "perfect" ? "#ffffff" : color;
      ctx.fillText(VERDICT_WORDS[b.verdict], x, Math.max(big ? 18 : 14, y - (big ? 10 : 6) - k * (big ? 14 : 8)));
    }
    ctx.globalAlpha = 1;
  }
}
