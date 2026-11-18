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
  heard,
  type KaraokeMode,
  karaokeMode,
  lobbyMembers,
  lobbyStatus,
  lyricsFor,
  memberSwatch,
  memberTag,
  resultTail,
  roundsLeftText,
  songProgress,
} from "./karaoke.js";
import { KaraokePlayer } from "./karaoke-player.js";
import { present, reflow } from "./motion.js";
import { SongClock } from "./song-clock.js";

/** Lobby members listed before 「還有 N 人」. */
const LOBBY_SHOWN = 8;

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

// ---- the layer ---------------------------------------------------------------------------------

export class KaraokeLayer {
  readonly #back: HTMLElement;
  readonly #lobby: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #titleMeta: HTMLElement;
  readonly #titleSong: HTMLElement;
  readonly #titleBy: HTMLElement;
  readonly #titleFoot: HTMLElement;
  readonly #titleFill: HTMLElement;
  readonly #titleTime: HTMLElement;
  readonly #count: HTMLElement;
  readonly #countN: HTMLElement;
  readonly #lyricsView: LyricsView;
  readonly #board: HTMLElement;
  readonly #boardList: HTMLOListElement;
  readonly #boardEmpty: HTMLElement;
  readonly #air: HTMLElement;
  readonly #results: HTMLElement;
  readonly #video: VideoBack;
  readonly #clock = new SongClock();
  readonly #player: KaraokePlayer;
  readonly #hint: HTMLElement;
  readonly #rows = new Map<string, HTMLElement>();
  #ranks = new Map<string, number | null>();
  #scene: KaraokeScene | null = null;
  #lyrics: KaraokeLyrics | null = null;
  #mode: KaraokeMode = "none";
  #lobbyKey = "";
  #titleKey = "";
  #resultsKey = "";
  #shownLeft: number | null = null;
  #shownTime = "";
  #shownFill = -1;

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
    const title = el("header", "k-title k-plate", this.#stage);
    this.#titleMeta = el("div", "k-title__meta", title);
    this.#titleSong = el("div", "k-title__song", title);
    this.#titleBy = el("div", "k-title__by", title);
    this.#titleFoot = el("div", "k-title__foot", title);
    const bar = el("div", "k-title__bar", this.#titleFoot);
    this.#titleFill = el("span", "k-title__fill", bar);
    this.#titleTime = el("span", "k-title__time", this.#titleFoot);

    this.#count = block("div", "k-count", this.#stage);
    this.#count.setAttribute("role", "timer");
    this.#countN = el("span", "k-count__n", this.#count);
    el("span", "k-count__label", this.#count, "秒後開始");

    this.#lyricsView = new LyricsView(this.#stage);

    this.#board = block("aside", "k-board k-plate", this.#stage);
    const head = el("div", "k-board__head", this.#board);
    el("h2", "k-board__title", head, "即時排名");
    this.#boardList = el("ol", "k-board__list", this.#board);
    this.#boardEmpty = el("p", "k-board__empty", this.#board, "開始唱之後會出現");
    this.#air = el("p", "k-air", this.#board);

    this.#results = block("section", "k-results k-plate", this.#stage);

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
    }
    this.#setMode(karaokeMode(scene, true));
    this.#render();
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
    // The words run while the round counts down and is sung; the results hold still.
    if (scene.state !== "results") this.#lyricsView.frame((ms ?? Number.NEGATIVE_INFINITY) / 1000, reduced);
    const left = scene.state === "countdown" ? countdownLeft(ms) : null;
    if (left !== this.#shownLeft) {
      this.#shownLeft = left;
      if (left !== null) this.#countN.textContent = String(left);
      present(this.#count, left !== null);
    }
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
    const state = this.#scene?.state;
    if (mode === "none") {
      delete root.dataset.karaoke;
      delete root.dataset.karaokeState;
    } else {
      root.dataset.karaoke = mode;
      if (state) root.dataset.karaokeState = state;
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
    const words = lyricsFor(scene, this.#lyrics);
    const live = scene.state === "countdown" || scene.state === "singing";
    // The round's sound plays while it counts down and is sung; the results are quiet.
    this.#player.air(scene.air);
    this.#player.play(live ? `${scene.room}-${scene.round}` : null);
    if (live) this.#player.backing(words?.backing ?? null);
    this.#lyricsView.set(words?.lyrics ?? null, this.ruby);
    present(this.#lyricsView.el, live);
    this.#video.set(live ? (words?.video ?? null) : null, () => {
      const ms = this.#songMs(performance.now());
      const s = this.#scene;
      return { time: (ms ?? 0) / 1000, playing: s?.state === "singing" && ms !== null };
    });
    this.#renderTitle(scene, words?.lyrics ?? null);
    // How far the song is, only while it is on.
    this.#titleFoot.hidden = !live;
    present(this.#board, live);
    if (live) this.#renderBoard(scene);
    present(this.#results, scene.state === "results");
    if (scene.state === "results") this.#renderResults(scene);
  }

  #renderLobby(scene: KaraokeScene): void {
    const key = JSON.stringify([scene.room, scene.song?.title, scene.song?.artist, scene.members, scene.roundsLeft]);
    if (key === this.#lobbyKey) return;
    this.#lobbyKey = key;
    const box = this.#lobby;
    box.replaceChildren();
    const head = el("div", "k-lobby__head", box);
    el("span", "k-lobby__label", head, "唱 K 房間");
    el("span", "k-lobby__join", head, "在會員頁輸入房號加入");
    el("div", "k-lobby__code", box, scene.room);
    const song = el("div", "k-lobby__song", box);
    if (scene.song === null) el("span", "k-lobby__dim", song, "開房的人選歌中");
    else {
      el("span", "k-lobby__title", song, scene.song.title);
      if (scene.song.artist) el("span", "k-lobby__artist", song, scene.song.artist);
      if (scene.shift !== 0) el("span", "k-lobby__key", song, `調 ${keyLabel(scene.shift)}`);
    }
    const people = lobbyMembers(scene.members);
    if (people.length > 0) {
      const ul = el("ul", "k-lobby__people", box);
      for (const m of people.slice(0, LOBBY_SHOWN)) {
        const li = el("li", "k-person", ul);
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
    el("span", "k-lobby__dim", foot, roundsLeftText(scene.roundsLeft));
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
    const rows = boardRows(scene.board, this.#ranks);
    this.#ranks = boardRanks(rows);
    this.#boardEmpty.hidden = rows.length > 0;
    const air = airText(scene.air);
    this.#air.textContent = air ?? "";
    this.#air.hidden = air === null;
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

  #renderResults(scene: KaraokeScene): void {
    const key = JSON.stringify([scene.room, scene.round, scene.board, scene.note, scene.roundsLeft, scene.currency]);
    if (key === this.#resultsKey) return;
    this.#resultsKey = key;
    const box = this.#results;
    box.replaceChildren();
    const head = el("div", "k-results__head", box);
    el("h2", "k-results__title", head, scene.round > 0 ? `第 ${scene.round} 首結果` : "結果");
    if (scene.song) el("span", "k-results__song", head, scene.song.title);
    const rows = boardRows(scene.board, new Map());
    if (rows.length === 0) el("p", "k-results__empty", box, "這一首沒有人唱完");
    else {
      const ol = el("ol", "k-results__list", box);
      for (const row of rows) {
        const li = el("li", `k-result${row.winner ? " is-winner" : ""}${row.finished ? "" : " is-unfinished"}`, ol);
        el("span", "k-result__rank", li, row.rank === null ? "—" : String(row.rank));
        swatch(row.color, li);
        el("span", "k-result__name", li, row.name);
        if (row.winner) el("span", "k-tag k-tag--win", li, "第一名");
        if (row.estimate) el("span", "k-tag", li, "預估");
        el("span", "k-result__score", li, row.score);
        el("span", `k-result__tail${row.coins > 0 ? " is-coins" : ""}`, li, resultTail(row, scene.currency));
      }
    }
    if (scene.note) el("p", "k-results__note", box, scene.note);
    el("p", "k-results__left", box, roundsLeftText(scene.roundsLeft));
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
  if (score) score.textContent = row.score;
  if (move) {
    move.textContent = row.move === "up" ? "↑" : row.move === "down" ? "↓" : "";
    move.dataset.move = row.move;
  }
  li.classList.toggle("is-first", row.rank === 1);
}
