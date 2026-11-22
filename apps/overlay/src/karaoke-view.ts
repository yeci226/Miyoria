// The karaoke room on the stream: the DOM for what src/karaoke.ts decides. Two layers: the round's
// screen (its video, dimmed, or grey-black glass) under everything else on the page, and the plates
// and lyrics above the danmaku lane like every other plate. The lyrics are the member page's,
// karaoke-box style (two lines low on the screen, the line being sung over the next one, white with
// a dark outline, wiped in the primary colour piece by piece as it is sung, readings above the
// words) from the module both pages share (`@miyoria/play/karaoke/lyrics`).
//
// The scene is also the round's player (src/karaoke-player.ts): the backing and the relayed voice
// the stream carries come out of this page. The song runs on this page's clock (src/song-clock.ts),
// set again by every `karaoke` frame, and on the audio clock while the sound runs. The video
// follows that clock with the member page's sync logic and never holds anything up: an error
// or a stall drops it for the glass. Under reduced motion there is no video and the wipe steps.
//
// Between the phases (lobby, countdown, singing, settling, results) every piece enters and leaves
// with the overlay's one motion (`present`: a fade and a small move); the pitch lanes are their own
// canvases (src/lanes-view.ts), the join QR code an SVG made here from src/qr.ts.
//
// Spectating (「卡拉 OK 第二次實測留下的」): the countdown is the round's intro (which song, who
// sings it, one by one); while it is sung every singer has a lane with their notes judged, the board
// counts each score up to the next and slides rows to their new places, a line at the screen's top
// right says who came in or left, who took the lead and who sang a line clean, cheers float up from
// the singer they are for, and under the board is the song that comes next. The results come in
// from the last place up, each total counting up, the winner last. Only transforms and opacity
// move; under reduced motion nothing moves but the numbers.
// Names and titles are untrusted: they only ever go in as text.

import type { WorkersKaraokeLineV2, WorkersKaraokeLyricsV2 } from "@miyoria/contracts/workers";
import {
  COUNTDOWN_DOTS,
  countdown,
  fillClip,
  isDoubtful,
  keyLabel,
  lineProgress,
  type ReadingMode,
  readingModes,
  rubyOf,
  StallWatch,
  stageLines,
  stepped,
  sungEnd,
  VIDEO_CHECK_MS,
  videoStep,
} from "@miyoria/play/karaoke/lyrics";
import type { KaraokeLyrics, KaraokeScene, KaraokeVoice } from "./feed.js";
import {
  airText,
  type BoardRow,
  boardRanks,
  boardRows,
  clockText,
  countdownLeft,
  countUp,
  freshCheers,
  happenings,
  happeningText,
  heard,
  initialOf,
  type KaraokeHappening,
  type KaraokeMode,
  karaokeBlocks,
  karaokeMode,
  karaokePhase,
  lobbyMembers,
  lobbyStatus,
  lineKey,
  lineup,
  lyricsFor,
  memberSwatch,
  memberTag,
  nextUp,
  phraseNames,
  PARTS,
  qrPixels,
  qrPlace,
  queueRows,
  resultRows,
  resultsDensity,
  resultsTitle,
  roundsLeftText,
  scoreText,
  settlingText,
  songProgress,
} from "./karaoke.js";
import { KaraokePlayer } from "./karaoke-player.js";
import { laneSingers } from "./lanes.js";
import { LanesView } from "./lanes-view.js";
import { present, reflow, remPx, removeAfterExit } from "./motion.js";
import { qrMatrix, qrSvgPath } from "./qr.js";
import { SongClock } from "./song-clock.js";

/** Lobby members listed before 「還有 N 人」. */
const LOBBY_SHOWN = 8;
/** Lines the feed shows at once, and how long each stays (ms). */
const FEED_SHOWN = 4;
const FEED_MS = 4_200;
/** A score on the board counts up to a new one over this long (ms). */
const BOARD_COUNT_MS = 700;
/** The results: a row comes in this long after the one below it, its total counts up this long (ms). */
const RESULT_STEP_MS = 140;
const RESULT_COUNT_MS = 900;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  parent?: Element,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

/** A block that fades in and out with the overlay's motion; created hidden. */
function block<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, parent: Element): HTMLElementTagNameMap[K] {
  const e = el(tag, `${className} is-out`, parent);
  e.hidden = true;
  return e;
}

/** A member's colour mark: filled for the first five, a ring for the three after. */
function swatch(color: number, parent: Element): HTMLElement {
  const { slot, hollow } = memberSwatch(color);
  const s = el("i", `k-swatch k-swatch--${slot}${hollow ? " is-hollow" : ""}`, parent);
  s.setAttribute("aria-hidden", "true");
  return s;
}

/** A singer's mark: the first letter of their name in their colour (a ring for colours six to eight). */
function avatar(color: number, name: string, parent: Element): HTMLElement {
  const { slot, hollow } = memberSwatch(color);
  const a = el("span", `k-avatar k-avatar--${slot}${hollow ? " is-hollow" : ""}`, parent, initialOf(name));
  a.setAttribute("aria-hidden", "true");
  return a;
}

function prefersReduced(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ---- lyrics ------------------------------------------------------------------------------------

/** The two lines and the counting-in dots; the line being sung is wiped every frame. */
class LyricsView {
  readonly el: HTMLElement;
  readonly #dots: HTMLElement;
  readonly #main: HTMLElement;
  readonly #next: HTMLElement;
  #lyrics: WorkersKaraokeLyricsV2 | null = null;
  #timed: { start: number; end: number | null }[] = [];
  #mode: ReadingMode = "off";
  /** Indices shown (`undefined`: nothing built yet). */
  #mainAt: number | null | undefined;
  #nextAt: number | null | undefined;
  /** The lit copy of each piece of the main line, and the clip each has now. */
  #lit: HTMLElement[] = [];
  #clips: string[] = [];
  #left: number | null | undefined;

  constructor(parent: Element) {
    this.el = el("div", "k-lyrics", parent);
    this.#dots = el("div", "k-dots", this.el);
    this.#dots.setAttribute("aria-hidden", "true");
    for (let n = COUNTDOWN_DOTS; n >= 1; n--) el("i", "k-dot", this.#dots).dataset.n = String(n);
    this.#main = el("p", "k-line k-line--main", this.el);
    this.#next = el("p", "k-line k-line--next", this.el);
  }

  /** The round's lyrics and the readings wanted on stream (shown only when the song has them). */
  set(lyrics: WorkersKaraokeLyricsV2 | null, mode: ReadingMode): void {
    const shown: ReadingMode = readingModes(lyrics).includes(mode) ? mode : "off";
    if (lyrics === this.#lyrics && shown === this.#mode) return;
    this.#lyrics = lyrics;
    this.#mode = shown;
    this.#timed = (lyrics?.lines ?? []).map((l) => ({ start: l.start, end: sungEnd(l) }));
    this.#mainAt = undefined;
    this.#nextAt = undefined;
    this.#left = undefined;
    this.el.classList.toggle("has-ruby", shown !== "off");
  }

  /** Readings show above the words (the lines take more room). */
  get ruby(): boolean {
    return this.#mode !== "off";
  }

  /** At song time `t` (seconds). */
  frame(t: number, reduced: boolean): void {
    const lines = this.#lyrics?.lines ?? [];
    const { main, second } = lines.length === 0 ? { main: null, second: null } : stageLines(this.#timed, t);
    if (main !== this.#mainAt) {
      this.#mainAt = main;
      const built = this.#line(this.#main, main === null ? null : (lines[main] ?? null), true);
      this.#lit = built;
      this.#clips = built.map(() => "");
    }
    if (second !== this.#nextAt) {
      this.#nextAt = second;
      this.#line(this.#next, second === null ? null : (lines[second] ?? null), false);
    }
    const line = main === null ? null : lines[main];
    const progress = line ? lineProgress(line, t) : null;
    if (progress !== null) {
      for (let i = 0; i < this.#lit.length; i++) {
        const raw = progress[i] ?? 0;
        const clip = fillClip(reduced ? stepped(raw) : raw);
        if (clip === this.#clips[i]) continue;
        this.#clips[i] = clip;
        (this.#lit[i] as HTMLElement).style.clipPath = clip;
      }
    }
    const left = lines.length === 0 ? null : countdown(this.#timed, t);
    if (left !== this.#left) {
      this.#left = left;
      this.#dots.classList.toggle("is-on", left !== null);
      for (const dot of this.#dots.children) {
        (dot as HTMLElement).classList.toggle("is-lit", left !== null && Number((dot as HTMLElement).dataset.n) <= left);
      }
    }
  }

  /** Builds one line into `p`; `lit` gives each piece a copy to wipe. Returns those copies. */
  #line(p: HTMLElement, line: WorkersKaraokeLineV2 | null, lit: boolean): HTMLElement[] {
    p.replaceChildren();
    p.classList.toggle("is-doubtful", line !== null && isDoubtful(line));
    if (line === null) return [];
    const pieces = line.pieces;
    if (pieces === null || (lit && !line.aligned)) {
      p.textContent = line.text;
      return [];
    }
    const out: HTMLElement[] = [];
    for (const piece of pieces) {
      let body: Node;
      if (lit) {
        const box = el("span", "k-piece");
        el("span", "k-piece__ink", box, piece.text);
        const copy = el("span", "k-piece__lit", box, piece.text);
        copy.setAttribute("aria-hidden", "true");
        copy.style.clipPath = fillClip(0);
        out.push(copy);
        body = box;
      } else {
        body = el("span", "k-piece", undefined, piece.text);
      }
      const ruby = piece.sung ? rubyOf(piece, this.#mode) : null;
      if (ruby === null) {
        p.append(body);
      } else {
        const r = el("ruby", "k-ruby", p);
        r.append(body);
        el("rt", "", r, ruby);
      }
    }
    return out;
  }
}

// ---- what happens ------------------------------------------------------------------------------

/** The scene's running line of what happens (top right of the screen): a few at a time, each a while. */
class Feed {
  readonly el: HTMLElement;

  constructor(parent: Element) {
    this.el = el("ol", "k-feed", parent);
    this.el.setAttribute("aria-label", "房間裡發生的事");
  }

  add(h: KaraokeHappening): void {
    const li = el("li", `k-feed__item k-plate is-${h.kind} is-out`, this.el);
    avatar(h.color, h.name, li);
    // Names are untrusted: text only.
    el("span", "k-feed__name", li, h.name);
    el("span", "k-feed__what", li, happeningText(h));
    reflow(li);
    li.classList.remove("is-out");
    while (this.el.children.length > FEED_SHOWN) this.el.firstElementChild?.remove();
    setTimeout(() => {
      li.classList.add("is-out");
      removeAfterExit(li);
    }, FEED_MS);
  }

  clear(): void {
    this.el.replaceChildren();
  }
}

/** A number on the page counting up to its latest value. */
interface Count {
  el: HTMLElement;
  from: number;
  to: number | null;
  since: number;
  ms: number;
}

// ---- the round's video -------------------------------------------------------------------------

/**
 * The background video: muted, inline, no controls, on the song clock (`video-sync`). It shows once
 * a frame is there; an error, a stall or reduced motion leaves the glass.
 */
class VideoBack {
  readonly #screen: HTMLElement;
  #video: HTMLVideoElement | null = null;
  #url: string | null = null;
  #timer: ReturnType<typeof setInterval> | undefined;
  readonly #watch = new StallWatch();

  constructor(screen: HTMLElement) {
    this.#screen = screen;
  }

  /** The video for the round (or none); `song` is read on every check. */
  set(url: string | null, song: () => { time: number; playing: boolean }): void {
    if (url === this.#url) return;
    this.#drop();
    this.#url = url;
    if (url === null || prefersReduced()) return;
    const v = document.createElement("video");
    v.className = "k-video";
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.preload = "auto";
    v.disablePictureInPicture = true;
    v.disableRemotePlayback = true;
    v.controls = false;
    v.setAttribute("aria-hidden", "true");
    v.addEventListener("loadeddata", () => v.classList.add("is-shown"), { once: true });
    v.addEventListener("error", () => this.#drop(), { once: true });
    v.src = url;
    this.#screen.prepend(v);
    this.#video = v;
    const check = (): void => {
      const s = song();
      const step = videoStep(
        { time: v.currentTime, paused: v.paused, rate: v.playbackRate, duration: v.duration, seeking: v.seeking },
        s,
      );
      const now = performance.now() / 1000;
      if (step.seek !== undefined) {
        v.currentTime = step.seek;
        this.#watch.reset(now);
      }
      if (step.rate !== undefined) v.playbackRate = step.rate;
      if (step.pause) v.pause();
      if (step.play) {
        try {
          void v.play()?.catch(() => undefined);
        } catch {
          // Not playable here: the stall check gives it up.
        }
      }
      const shouldPlay = s.playing && s.time >= 0 && !(v.duration > 0 && s.time >= v.duration);
      if (this.#watch.check(now, v.currentTime, shouldPlay)) this.#drop();
    };
    this.#timer = setInterval(check, VIDEO_CHECK_MS);
    check();
  }

  #drop(): void {
    clearInterval(this.#timer);
    this.#timer = undefined;
    const v = this.#video;
    this.#video = null;
    if (v === null) return;
    v.pause();
    v.classList.remove("is-shown");
    v.removeAttribute("src");
    // Fades out, then lets go of the file.
    setTimeout(() => {
      v.remove();
      v.load();
    }, 400);
  }
}

// ---- the join QR code --------------------------------------------------------------------------

/** The QR code's side at 1080p: big in the lobby (about 200 px), small in a corner (about 120 px), in rem. */
const QR_LOBBY_REM = 12.5;
const QR_CORNER_REM = 7.5;
const SVG = "http://www.w3.org/2000/svg";

/**
 * The QR code of `url` as an SVG: dark square modules on a light plate with the four-module quiet
 * zone, whole pixels per module, edges kept crisp. `null` when the link does not fit a code.
 */
function qrSvg(url: string, targetPx: number): SVGSVGElement | null {
  const matrix = qrMatrix(url);
  if (matrix === null) return null;
  const { size, d } = qrSvgPath(matrix);
  const px = qrPixels(size, targetPx);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "k-qr__code");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", String(px));
  svg.setAttribute("height", String(px));
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "加入房間的 QR code");
  const plate = document.createElementNS(SVG, "rect");
  plate.setAttribute("width", String(size));
  plate.setAttribute("height", String(size));
  plate.setAttribute("fill", "#fff");
  const dark = document.createElementNS(SVG, "path");
  dark.setAttribute("d", d);
  dark.setAttribute("fill", "#000");
  svg.append(plate, dark);
  return svg;
}

// ---- the layer ---------------------------------------------------------------------------------

/** The song a round sang, for its results (the scene's `song` is the next one by then). */
interface Sung {
  room: string;
  round: number;
  title: string;
  artist: string | null;
}

export class KaraokeLayer {
  readonly #back: HTMLElement;
  readonly #lobby: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #title: HTMLElement;
  readonly #titleMeta: HTMLElement;
  readonly #titleSong: HTMLElement;
  readonly #titleBy: HTMLElement;
  readonly #titleFoot: HTMLElement;
  readonly #titleFill: HTMLElement;
  readonly #titleTime: HTMLElement;
  readonly #count: HTMLElement;
  readonly #introHead: HTMLElement;
  readonly #countN: HTMLElement;
  readonly #feed: Feed;
  readonly #next: HTMLElement;
  readonly #lyricsView: LyricsView;
  readonly #lanes: LanesView;
  readonly #board: HTMLElement;
  readonly #boardList: HTMLOListElement;
  readonly #boardEmpty: HTMLElement;
  readonly #air: HTMLElement;
  readonly #settling: HTMLElement;
  readonly #settlingDetail: HTMLElement;
  readonly #results: HTMLElement;
  readonly #corner: HTMLElement;
  readonly #video: VideoBack;
  readonly #clock = new SongClock();
  readonly #player: KaraokePlayer;
  readonly #hint: HTMLElement;
  readonly #rows = new Map<string, HTMLElement>();
  #ranks = new Map<string, number | null>();
  #scene: KaraokeScene | null = null;
  #lyrics: KaraokeLyrics | null = null;
  #mode: KaraokeMode = "none";
  #sung: Sung | null = null;
  #lobbyKey = "";
  #titleKey = "";
  #resultsKey = "";
  #cornerKey = "";
  #shownLeft: number | null = null;
  #shownTime = "";
  #shownFill = -1;
  #introKey = "";
  /** Singers who just sang a line clean (called out together a moment later). */
  #cleanLine: { name: string; color: number }[] = [];
  #boardKey = "";
  /** Cheers already shown (by id), for this room. */
  #cheersSeen = new Set<string>();
  /** The numbers counting up now (board scores, result totals). */
  readonly #counts = new Map<string, Count>();
  /** The lobby's people last drawn (a new one comes in). */
  #lobbyPeople = new Set<string>();
  #phrasesOf: { lyrics: WorkersKaraokeLyricsV2 | null; spans: { start: number; end: number }[] } = { lyrics: null, spans: [] };

  /**
   * `under`: where the screen goes (under every other piece of the page); `over`: the plates.
   * `hint`: say 「按一下開聲音」 when the browser holds the sound back (the demo, `debug`; never on air).
   */
  constructor(
    under: HTMLElement,
    over: HTMLElement,
    private readonly ruby: ReadingMode,
    hint = false,
  ) {
    this.#player = new KaraokePlayer(
      () => this.#clock.at(performance.now()),
      (held) => {
        if (hint) present(this.#hint, held);
      },
    );
    this.#back = block("div", "k-back", under);
    this.#back.setAttribute("aria-hidden", "true");
    const screen = el("div", "k-screen", this.#back);
    el("div", "k-shade", screen);
    this.#video = new VideoBack(screen);

    const front = el("section", "karaoke", over);
    this.#lobby = block("div", "k-lobby k-plate", front);
    this.#lobby.setAttribute("role", "status");

    this.#stage = block("div", "k-stage", front);
    this.#title = block("header", "k-title k-plate", this.#stage);
    this.#titleMeta = el("div", "k-title__meta", this.#title);
    this.#titleSong = el("div", "k-title__song", this.#title);
    this.#titleBy = el("div", "k-title__by", this.#title);
    this.#titleFoot = el("div", "k-title__foot", this.#title);
    const bar = el("div", "k-title__bar", this.#titleFoot);
    this.#titleFill = el("span", "k-title__fill", bar);
    this.#titleTime = el("span", "k-title__time", this.#titleFoot);

    // The pitch lanes, under the countdown and the words.
    this.#lanes = new LanesView(this.#stage);

    // The countdown is the round's intro: which song, who sings it, and the seconds.
    this.#count = block("div", "k-count k-intro", this.#stage);
    this.#count.setAttribute("role", "timer");
    const card = el("div", "k-intro__card k-plate", this.#count);
    this.#introHead = el("div", "k-intro__head", card);
    this.#countN = el("span", "k-count__n", card);
    el("span", "k-count__label", card, "秒後開始");

    this.#lyricsView = new LyricsView(this.#stage);
    this.#lyricsView.el.classList.add("is-out");
    this.#lyricsView.el.hidden = true;

    this.#board = block("aside", "k-board k-plate", this.#stage);
    const head = el("div", "k-board__head", this.#board);
    el("h2", "k-board__title", head, "即時排名");
    this.#boardList = el("ol", "k-board__list", this.#board);
    this.#boardEmpty = el("p", "k-board__empty", this.#board, "開始唱之後會出現");
    this.#air = el("p", "k-air", this.#board);
    this.#next = el("p", "k-next", this.#board);
    this.#next.hidden = true;
    this.#feed = new Feed(this.#stage);
    // Everyone who sang the same line clean is called out once, together.
    this.#lanes.onPhrase = (who) => {
      this.#cleanLine.push(who);
      if (this.#cleanLine.length === 1) {
        setTimeout(() => {
          const names = this.#cleanLine.map((w) => w.name);
          const first = this.#cleanLine[0];
          this.#cleanLine = [];
          if (first !== undefined) this.#feed.add({ kind: "phrase", name: phraseNames(names), color: first.color });
        }, 400);
      }
    };

    this.#settling = block("div", "k-settling k-plate", this.#stage);
    this.#settling.setAttribute("role", "status");
    el("div", "k-settling__title", this.#settling, "結算中…");
    this.#settlingDetail = el("div", "k-settling__detail", this.#settling);
    el("div", "k-settling__bar", this.#settling).setAttribute("aria-hidden", "true");

    this.#results = block("section", "k-results k-plate", this.#stage);
    this.#corner = block("div", "k-qr k-qr--corner k-plate", this.#stage);

    this.#hint = block("div", "k-hint k-plate", front);
    this.#hint.textContent = "按一下開聲音";
  }

  /** The song time now (ms): the audio clock while the round's sound runs, else the song clock. */
  #songMs(now: number): number | null {
    return this.#player.songMs() ?? this.#clock.at(now);
  }

  /** A piece of the relayed singer's voice: played at its place, then forgotten. */
  voice(piece: KaraokeVoice): void {
    if (this.#mode === "stage") this.#player.voice(piece);
  }

  /** She started or stopped speaking (the round's sound dips under her lines). */
  speaking(on: boolean): void {
    this.#player.speaking(on);
  }

  /** A `karaoke` frame (`null`: the scene ended, or nobody drives it), received at `now` (ms). */
  scene(scene: KaraokeScene | null, now: number): void {
    const before = this.#scene;
    this.#scene = scene;
    const sameRound = before !== null && scene !== null && before.room === scene.room && before.round === scene.round;
    if (scene?.positionMs != null && (scene.state === "countdown" || scene.state === "singing")) {
      if (!sameRound) this.#clock.reset();
      this.#clock.update(scene.positionMs, now);
    } else {
      this.#clock.reset();
    }
    if (!sameRound) {
      this.#ranks = new Map();
      this.#resultsKey = "";
      this.#boardKey = "";
      this.#lanes.clear();
    }
    if (before?.room !== scene?.room) {
      this.#cheersSeen = new Set();
      this.#feed.clear();
    }
    if (scene?.state === "singing") this.#lanes.take(scene.board);
    // Who came, left, took the lead (only what changed in this room, on the round's screen).
    if (scene !== null && karaokeMode(scene, true) === "stage") {
      for (const h of happenings(before, scene)) this.#feed.add(h);
    }
    // Remember what the round sings: by its results the scene names the next song.
    if (scene !== null && scene.song !== null && (scene.state === "countdown" || scene.state === "singing")) {
      this.#sung = { room: scene.room, round: scene.round, title: scene.song.title, artist: scene.song.artist };
    }
    this.#setMode(karaokeMode(scene, true));
    this.#render();
    // Cheers float up from the singer they are for, each once.
    if (scene !== null && (scene.state === "countdown" || scene.state === "singing")) {
      const reduced = prefersReduced();
      for (const c of freshCheers(this.#cheersSeen, scene.cheers)) this.#lanes.cheer(c, reduced);
    }
    this.#player.sync();
  }

  /** A `karaoke_lyrics` frame. */
  lyrics(lyrics: KaraokeLyrics): void {
    this.#lyrics = lyrics;
    this.#render();
  }

  /** Once per animation frame. */
  frame(now: number): void {
    if (this.#mode !== "stage" || this.#scene === null) return;
    const ms = this.#songMs(now);
    const scene = this.#scene;
    const reduced = prefersReduced();
    const phase = karaokePhase(scene);
    // The words and the lanes run while the round counts down and is sung.
    if (phase === "countdown" || phase === "singing") {
      this.#lyricsView.frame((ms ?? Number.NEGATIVE_INFINITY) / 1000, reduced);
      if (ms !== null) this.#lanes.frame(ms / 1000, reduced);
    }
    const left = phase === "countdown" ? countdownLeft(ms) : null;
    if (left !== this.#shownLeft) {
      this.#shownLeft = left;
      if (left !== null) {
        this.#countN.textContent = String(left);
        if (!reduced) {
          this.#countN.animate([{ opacity: 0.25, transform: "scale(1.18)" }, { opacity: 1, transform: "none" }], {
            duration: 420,
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
          });
        }
      }
      present(this.#count, left !== null);
    }
    this.#tickCounts(now, reduced);
    const duration = scene.song?.durationMs ?? null;
    const fill = Math.round(songProgress(ms, duration) * 1000) / 1000;
    if (fill !== this.#shownFill) {
      this.#shownFill = fill;
      this.#titleFill.style.transform = `scaleX(${fill})`;
    }
    const time = ms === null ? "" : `${clockText(ms)} / ${clockText(duration)}`;
    if (time !== this.#shownTime) {
      this.#shownTime = time;
      this.#titleTime.textContent = time;
    }
  }

  #setMode(mode: KaraokeMode): void {
    const root = document.documentElement;
    const scene = this.#scene;
    if (mode === "none" || scene === null) {
      delete root.dataset.karaoke;
      delete root.dataset.karaokeState;
      delete root.dataset.karaokePhase;
    } else {
      root.dataset.karaoke = mode;
      root.dataset.karaokeState = scene.state;
      root.dataset.karaokePhase = karaokePhase(scene);
    }
    if (mode === this.#mode) return;
    this.#mode = mode;
    present(this.#lobby, mode === "lobby");
    present(this.#stage, mode === "stage");
    present(this.#back, mode === "stage");
  }

  #render(): void {
    const scene = this.#scene;
    if (scene === null || this.#mode === "none") {
      this.#video.set(null, () => ({ time: 0, playing: false }));
      this.#player.play(null);
      return;
    }
    if (this.#mode === "lobby") {
      this.#video.set(null, () => ({ time: 0, playing: false }));
      this.#player.play(null);
      this.#renderLobby(scene);
      return;
    }
    const show = karaokeBlocks(scene, true);
    const words = lyricsFor(scene, this.#lyrics);
    const live = scene.state === "countdown" || scene.state === "singing";
    // The round's sound plays while it counts down and is sung (and settles); the results are quiet.
    this.#player.air(scene.air);
    this.#player.play(live ? `${scene.room}-${scene.round}` : null);
    if (live) this.#player.backing(words?.backing ?? null);
    this.#lyricsView.set(words?.lyrics ?? null, this.ruby);
    present(this.#lyricsView.el, show.lyrics);
    // A lane per singer while the round counts down and is sung.
    const singers = show.lanes ? laneSingers(scene.members, scene.board) : [];
    if (show.lanes) this.#lanes.set(singers, words?.notes ?? [], this.#lyricsView.ruby, this.#phrases(words?.lyrics ?? null));
    present(this.#lanes.el, singers.length > 0);
    if (scene.state === "countdown") this.#renderIntro(scene);
    this.#video.set(live ? (words?.video ?? null) : null, () => {
      const ms = this.#songMs(performance.now());
      const s = this.#scene;
      return { time: (ms ?? 0) / 1000, playing: s?.state === "singing" && ms !== null };
    });
    present(this.#title, show.title);
    if (show.title) this.#renderTitle(scene, words?.lyrics ?? null);
    // How far the song is, only while it is on.
    this.#titleFoot.hidden = !show.lyrics;
    present(this.#board, show.board);
    if (show.board) this.#renderBoard(scene);
    present(this.#settling, show.settling);
    if (scene.settling !== null) this.#settlingDetail.textContent = settlingText(scene.settling);
    present(this.#results, show.results);
    if (show.results) this.#renderResults(scene, show.qr === "corner");
    this.#renderCorner(scene, show.qr === "corner");
  }

  /** The lyric lines' spans of a round's words (for judging whole phrases), kept per words. */
  #phrases(lyrics: WorkersKaraokeLyricsV2 | null): { start: number; end: number }[] {
    if (lyrics !== this.#phrasesOf.lyrics) {
      this.#phrasesOf = {
        lyrics,
        spans: (lyrics?.lines ?? []).map((l) => ({ start: l.start, end: sungEnd(l) ?? l.end ?? l.start + 8 })),
      };
    }
    return this.#phrasesOf.spans;
  }

  /** The intro while the round counts down: the round, its song, and who sings it, one after another. */
  #renderIntro(scene: KaraokeScene): void {
    const people = lineup(scene);
    const key = JSON.stringify([scene.room, scene.round, scene.song?.title, scene.song?.artist, people]);
    if (key === this.#introKey) return;
    this.#introKey = key;
    const head = this.#introHead;
    head.replaceChildren();
    el("div", "k-intro__kicker", head, `第 ${scene.round} 首 · 房間 ${scene.room}`);
    el("div", "k-intro__song", head, scene.song?.title ?? "—");
    if (scene.song?.artist) el("div", "k-intro__artist", head, scene.song.artist);
    if (people.length > 0) {
      const ul = el("ul", "k-lineup", head);
      people.forEach((p, i) => {
        const li = el("li", "k-lineup__who", ul);
        li.style.setProperty("--i", String(i));
        avatar(p.color, p.name, li);
        el("span", "k-lineup__name", li, p.name);
      });
    }
  }

  /** `key`'s number counts up to `to` from what it shows now (`ms` long, after `delay`). */
  #countTo(key: string, node: HTMLElement, to: number | null, ms: number, delay = 0, from?: number): void {
    const now = performance.now();
    const c = this.#counts.get(key);
    if (c !== undefined && c.el === node && c.to === to) return;
    const shown = c?.el === node && c.to !== null ? countUp(c.from, c.to, (now - c.since) / c.ms) : null;
    this.#counts.set(key, { el: node, from: from ?? shown ?? to ?? 0, to, since: now + delay, ms });
    if (to === null) node.textContent = scoreText(null);
  }

  /** Every number on its way, one step (the last one lands exactly on its value). */
  #tickCounts(now: number, reduced: boolean): void {
    for (const [key, c] of this.#counts) {
      if (!c.el.isConnected) {
        this.#counts.delete(key);
        continue;
      }
      if (c.to === null) continue;
      const k = reduced ? 1 : (now - c.since) / c.ms;
      const text = scoreText(k >= 1 ? c.to : countUp(c.from, c.to, Math.max(0, k)));
      if (c.el.textContent !== text) c.el.textContent = text;
    }
  }

  /** The small QR code in the screen's top right corner, with the room code beside its caption. */
  #renderCorner(scene: KaraokeScene, on: boolean): void {
    const url = on ? scene.joinUrl : null;
    const key = JSON.stringify([url, scene.room, remPx()]);
    if (key !== this.#cornerKey) {
      this.#cornerKey = key;
      const code = url === null ? null : qrSvg(url, QR_CORNER_REM * remPx());
      if (code !== null) {
        this.#corner.replaceChildren(code);
        const caption = el("div", "k-qr__caption", this.#corner, "掃描加入");
        el("span", "k-qr__room", caption, scene.room);
      }
      present(this.#corner, code !== null);
      // The feed makes room for the corner's code.
      this.#feed.el.classList.toggle("is-beside-qr", code !== null);
    }
  }

  #renderLobby(scene: KaraokeScene): void {
    const place = qrPlace(scene);
    const key = JSON.stringify([
      scene.room,
      scene.song?.title,
      scene.song?.artist,
      scene.shift,
      scene.queue,
      scene.members,
      scene.roundsLeft,
      place === "lobby" ? scene.joinUrl : null,
      remPx(),
    ]);
    if (key === this.#lobbyKey) return;
    this.#lobbyKey = key;
    const box = this.#lobby;
    box.replaceChildren();
    const head = el("div", "k-lobby__head", box);
    el("span", "k-lobby__label", head, "唱 K 房間");
    el("span", "k-lobby__dim", head, roundsLeftText(scene.roundsLeft));

    // The code to join with, and the QR code of the link beside it.
    const join = el("div", "k-lobby__join", box);
    const code = el("div", "k-lobby__code-box", join);
    el("div", "k-lobby__code", code, scene.room);
    el("div", "k-lobby__how", code, "在會員頁輸入房號加入");
    const qr = place === "lobby" && scene.joinUrl !== null ? qrSvg(scene.joinUrl, QR_LOBBY_REM * remPx()) : null;
    box.classList.toggle("has-qr", qr !== null);
    if (qr !== null) {
      const fig = el("figure", "k-qr k-qr--lobby", join);
      fig.append(qr);
      el("figcaption", "k-qr__caption", fig, "掃描加入");
    }

    // 「下一首」: the chosen song, then the queue after it.
    const next = el("div", "k-lobby__next", box);
    el("div", "k-lobby__section", next, "下一首");
    const rows = queueRows(scene);
    if (rows.length === 0) el("p", "k-lobby__none", next, "還沒有人點歌");
    else {
      const ol = el("ol", "k-queue", next);
      rows.forEach((row, i) => {
        const li = el("li", `k-queue__row is-${row.state}${i === 0 && scene.song !== null ? " is-next" : ""}`, ol);
        const what = el("span", "k-queue__what", li);
        el("span", "k-queue__title", what, row.title);
        if (row.artist) el("span", "k-queue__artist", what, row.artist);
        if (i === 0 && scene.song !== null && scene.shift !== 0) el("span", "k-queue__key", what, `調 ${keyLabel(scene.shift)}`);
        if (row.mark !== null) el("span", `k-queue__mark is-${row.state}`, li, row.mark);
        if (row.by !== null) el("span", "k-queue__by", li, row.by);
      });
    }

    const people = lobbyMembers(scene.members);
    const before = this.#lobbyPeople;
    this.#lobbyPeople = new Set(people.map((m) => lineKey(m)));
    const fresh = (m: (typeof people)[number]) => before.size > 0 && !before.has(lineKey(m));
    if (people.length > 0) {
      const ul = el("ul", "k-lobby__people", box);
      for (const m of people.slice(0, LOBBY_SHOWN)) {
        const li = el("li", `k-person${fresh(m) ? " is-new" : ""}`, ul);
        swatch(m.color, li);
        el("span", "k-person__name", li, m.name);
        el("span", "k-person__tag", li, memberTag(m));
        if (m.role === "singer") {
          const ready = el("span", `k-person__ready${m.ready ? " is-ready" : ""}`, li, m.ready ? "準備好了" : "還沒好");
          ready.setAttribute("aria-label", m.ready ? "準備好了" : "還沒準備好");
        }
      }
      if (people.length > LOBBY_SHOWN) el("li", "k-person k-person--more", ul, `還有 ${people.length - LOBBY_SHOWN} 人`);
    }
    const foot = el("div", "k-lobby__foot", box);
    el("span", "", foot, lobbyStatus(scene));
  }

  #renderTitle(scene: KaraokeScene, lyrics: WorkersKaraokeLyricsV2 | null): void {
    const key = JSON.stringify([scene.room, scene.round, scene.song, scene.shift, heard(lyrics)]);
    if (key === this.#titleKey) return;
    this.#titleKey = key;
    this.#titleMeta.replaceChildren();
    el("span", "k-tag", this.#titleMeta, "唱 K");
    if (scene.round > 0) el("span", "", this.#titleMeta, `第 ${scene.round} 首`);
    el("span", "", this.#titleMeta, `房間 ${scene.room}`);
    if (heard(lyrics)) {
      const tag = el("span", "k-tag", this.#titleMeta, "聽寫");
      tag.title = "歌詞是聽出來的,可能有錯";
    }
    this.#titleSong.textContent = scene.song?.title ?? "—";
    const by = [scene.song?.artist ?? null, scene.shift === 0 ? null : `調 ${keyLabel(scene.shift)}`].filter(
      (s): s is string => s !== null,
    );
    this.#titleBy.textContent = by.join(" · ");
    this.#titleBy.hidden = by.length === 0;
  }

  /** The live board: rows keyed by singer, sliding to their new places (FLIP) when ranks change. */
  #renderBoard(scene: KaraokeScene): void {
    const next = nextUp(scene);
    const nextText = next === null ? "" : next.by === null ? next.title : `${next.title} · ${next.by}`;
    if (this.#next.dataset.text !== nextText) {
      this.#next.dataset.text = nextText;
      this.#next.replaceChildren();
      if (next !== null) {
        el("span", "k-next__label", this.#next, "下一首");
        el("span", "k-next__title", this.#next, next.title);
        if (next.by !== null) el("span", "k-next__by", this.#next, next.by);
      }
      this.#next.hidden = next === null;
    }
    const air = airText(scene.air);
    this.#air.textContent = air ?? "";
    this.#air.hidden = air === null;
    // The pitch moves a few times a second; the rows only when a rank or a score does.
    const rows = boardRows(scene.board, this.#ranks);
    const key = JSON.stringify(rows.map(({ moved: _, ...r }) => r));
    if (key === this.#boardKey) return;
    this.#boardKey = key;
    this.#ranks = boardRanks(rows);
    this.#boardEmpty.hidden = rows.length > 0;
    const list = this.#boardList;
    const before = new Map<HTMLElement, number>();
    for (const li of this.#rows.values()) before.set(li, li.getBoundingClientRect().top);
    const wanted = new Set(rows.map((r) => r.key));
    for (const [key, li] of this.#rows) {
      if (wanted.has(key)) continue;
      this.#rows.delete(key);
      before.delete(li);
      li.remove();
    }
    const flash: HTMLElement[] = [];
    let prev: Element | null = null;
    for (const row of rows) {
      let li = this.#rows.get(row.key);
      if (!li) {
        li = boardRow(row);
        this.#rows.set(row.key, li);
      }
      updateRow(li, row);
      const score = li.querySelector<HTMLElement>(".k-row__score");
      if (score !== null) this.#countTo(`board:${row.key}`, score, row.total, BOARD_COUNT_MS);
      if (row.moved) flash.push(li);
      const at: ChildNode | null = prev ? prev.nextSibling : list.firstChild;
      if (at !== li) list.insertBefore(li, at);
      prev = li;
    }
    const moved: HTMLElement[] = [];
    for (const [li, top] of before) {
      const dy = top - li.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) continue;
      li.classList.add("no-motion");
      li.style.transform = `translateY(${dy}px)`;
      moved.push(li);
    }
    if (moved.length > 0 || flash.length > 0) reflow(list);
    for (const li of moved) {
      li.classList.remove("no-motion");
      li.style.transform = "";
    }
    for (const li of flash) li.classList.add("is-flash");
  }

  /**
   * The final ranking over the whole screen: the round and its song, a row per singer (place,
   * colour, name, the four parts with their bars, the total, the coins or 「沒唱完」), the winner
   * lit, then why no prize was paid, the next song and how many the room may still sing.
   */
  #renderResults(scene: KaraokeScene, corner: boolean): void {
    const sung = this.#sung !== null && this.#sung.room === scene.room && this.#sung.round === scene.round ? this.#sung : null;
    const key = JSON.stringify([scene.room, scene.round, scene.board, scene.note, scene.roundsLeft, scene.currency, scene.song?.title, sung, corner]);
    if (key === this.#resultsKey) return;
    this.#resultsKey = key;
    const box = this.#results;
    box.replaceChildren();
    box.classList.toggle("has-corner", corner);
    const head = el("header", "k-results__head", box);
    el("div", "k-results__kicker", head, `${resultsTitle(scene.round)} · 房間 ${scene.room}`);
    if (sung !== null) {
      el("h2", "k-results__song", head, sung.title);
      if (sung.artist) el("div", "k-results__artist", head, sung.artist);
    } else {
      el("h2", "k-results__song", head, resultsTitle(scene.round));
    }

    const rows = resultRows(scene.board, scene.currency);
    if (rows.length === 0) el("p", "k-results__empty", box, "這一首沒有人唱完");
    else {
      const table = el("div", `k-results__table is-${resultsDensity(rows.length)}`, box);
      const cols = el("div", "k-results__cols", table);
      cols.setAttribute("aria-hidden", "true");
      el("span", "", cols);
      el("span", "", cols, "名字");
      for (const p of PARTS) {
        const c = el("span", "k-results__col", cols, p.label);
        el("small", "", c, `/${p.max}`);
      }
      el("span", "k-results__col", cols, "總分");
      el("span", "k-results__col", cols, scene.currency || "獎勵");
      const ol = el("ol", "k-results__list", table);
      const reduced = prefersReduced();
      rows.forEach((row, i) => {
        const li = el("li", `k-result${row.winner ? " is-winner" : ""}${row.finished ? "" : " is-unfinished"}`, ol);
        // From the last place up: the winner comes in last.
        const order = rows.length - 1 - i;
        li.style.setProperty("--i", String(order));
        el("span", "k-result__rank", li, row.rank === null ? "—" : String(row.rank));
        const who = el("span", "k-result__who", li);
        swatch(row.color, who);
        el("span", "k-result__name", who, row.name);
        if (row.winner) el("span", "k-tag k-tag--win", who, "第一名");
        if (row.estimate) el("span", "k-tag", who, "預估");
        for (const part of row.parts ?? PARTS.map(() => null)) {
          const cell = el("span", "k-part", li);
          el("span", "k-part__n", cell, part === null ? "" : part.text);
          if (part !== null) {
            const bar = el("span", "k-part__bar", cell);
            bar.setAttribute("aria-hidden", "true");
            el("i", "", bar).style.transform = `scaleX(${part.share})`;
          }
        }
        const score = el("span", "k-result__score", li, reduced || row.total === null ? row.score : scoreText(0));
        if (!reduced && row.total !== null) {
          this.#countTo(`result:${row.key}`, score, row.total, RESULT_COUNT_MS, order * RESULT_STEP_MS, 0);
        }
        el("span", `k-result__tail${row.coins > 0 ? " is-coins" : ""}`, li, row.tail);
      });
    }
    const foot = el("footer", "k-results__foot", box);
    if (scene.note) el("p", "k-results__note", foot, scene.note);
    const after = el("p", "k-results__after", foot);
    if (scene.song !== null) {
      el("span", "k-results__next-label", after, "下一首");
      el("span", "k-results__next", after, scene.song.title);
    }
    el("span", "k-results__left", after, roundsLeftText(scene.roundsLeft));
  }
}

/** A new board row (its parts filled by `updateRow`). */
function boardRow(row: BoardRow): HTMLElement {
  const li = el("li", "k-row");
  el("span", "k-row__rank", li);
  swatch(row.color, li);
  el("span", "k-row__name", li, row.name);
  // Whose voice the stream plays now: a small wave mark and 「播出中」.
  const air = el("span", "k-tag k-tag--air k-row__air", li);
  air.insertAdjacentHTML(
    "afterbegin",
    '<svg class="k-air-mark" viewBox="0 0 12 12" aria-hidden="true"><path d="M2 5v2M4.5 3.5v5M7 2v8M9.5 4v4"/></svg>',
  );
  air.append("播出中");
  el("span", "k-tag k-row__estimate", li, "預估");
  el("span", "k-row__score", li);
  el("span", "k-row__move", li).setAttribute("aria-hidden", "true");
  // The row's own flash is the longer one; its arrow's ends first and must not cut it short.
  li.addEventListener("animationend", (e) => {
    if (e.target === li) li.classList.remove("is-flash");
  });
  return li;
}

function updateRow(li: HTMLElement, row: BoardRow): void {
  const [rank, , , air, estimate, score, move] = [...li.children] as HTMLElement[];
  if (rank) rank.textContent = row.rank === null ? "—" : String(row.rank);
  if (air) air.hidden = !row.onAir;
  if (estimate) estimate.hidden = !row.estimate;
  // The score itself counts up to `row.total` (the layer's counts).
  if (score && score.textContent === "") score.textContent = row.score;
  if (move) {
    move.textContent = row.move === "up" ? "↑" : row.move === "down" ? "↓" : "";
    move.dataset.move = row.move;
  }
  li.classList.toggle("is-first", row.rank === 1);
}
