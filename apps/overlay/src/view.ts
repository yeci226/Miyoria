// DOM for the overlay. Holds the reducer state plus the time-based bits the reducer must not know about
// (typewriter position, linger timers) and paints them from one animation-frame loop. Everything that
// appears, disappears or changes goes through motion.ts, so nothing pops.
import { ActivityCapsule } from "./activity.js";
import type { OverlayConfig } from "./config.js";
import {
  type Action,
  initialState,
  type OverlayState,
  type QueueItem,
  reduce,
  type ScreenCard,
  shownActivity,
} from "./feed.js";
import { emotionColor } from "./emotion.js";
import { isPresent, present, reflow, removeAfterExit, Swap } from "./motion.js";
import {
  advance,
  cpLength,
  lingerMs,
  reconcile,
  splitAt,
  STALE_PARTIAL_MS,
} from "./typewriter.js";
import { MAX_TOUCHES, type Touch, TouchSet } from "./touch.js";
import { Wave } from "./wave.js";

const QUEUE_SHOWN = 5;
/** How long one paid message / dedication stays up before the next one comes. */
export const SCREEN_SHOW_MS = 12_000;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  parent?: Element,
  text?: string,
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  parent?.append(e);
  return e;
}

/**
 * A block that folds open and shut (its height through a 0fr → 1fr grid row, plus a fade), so the
 * panel around it resizes smoothly. Content goes into `body`. Starts folded.
 */
function fold(className: string, parent: Element): { el: HTMLElement; body: HTMLElement } {
  const e = el("div", `fold ${className} is-out`, parent);
  e.hidden = true;
  return { el: e, body: el("div", "fold__in", e) };
}

export class Overlay {
  private state: OverlayState = initialState();

  // subtitle timing (ms on the rAF clock)
  private text = "";
  private turn = "";
  private final = false;
  private shown = 0; // code points revealed (fractional while stepping)
  private paintedShown = -1;
  private seenSeq = 0;
  private lastFrame = 0;
  private lastUpdateAt = 0;
  private completeAt: number | null = null;
  private quietSince = 0; // when her voice last stopped (or the subtitle last changed while silent)
  private visible = false;
  private clearTimer: ReturnType<typeof setTimeout> | undefined;

  private readonly subtitle: HTMLElement;
  private readonly shownEl: HTMLElement;
  private readonly restEl: HTMLElement;
  private readonly panel: HTMLElement;
  /** The panel's sections, top to bottom (the first one shown has no hairline above it). */
  private readonly sections: HTMLElement[];
  private readonly emotionRow: HTMLElement;
  private readonly emotionDot: HTMLElement;
  private readonly emotionName: Swap;
  private readonly statusBox: HTMLElement;
  private readonly liveRow: HTMLElement;
  private readonly sceneRow: HTMLElement;
  private readonly sceneName: Swap;
  private readonly chips: Record<"core" | "vts" | "obs", HTMLElement>;
  private readonly queueBox: HTMLElement;
  private readonly queueList: QueueList;
  private readonly queueMore: HTMLElement;
  private readonly queueMoreText: Swap;
  private readonly offline: HTMLElement;
  private readonly wave: Wave;
  private readonly activity: ActivityCapsule;
  private readonly gift: HTMLElement;
  private readonly giftText: Swap;
  private readonly screen: HTMLElement;
  private readonly screenBody: Swap;
  private readonly touchLayer: HTMLElement;
  private readonly touches = new TouchSet();
  private readonly touchEls = new Map<number, HTMLElement>();
  /** The card whose time is running, and its timer. */
  private screenShown: number | null = null;
  private screenTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    root: HTMLElement,
    private readonly cfg: OverlayConfig,
  ) {
    root.replaceChildren();
    const main = el("main", "overlay", root);

    this.wave = new Wave(main);
    this.wave.hidden = !cfg.show.has("wave");

    this.subtitle = el("section", "subtitle is-hidden", main);
    const p = el("p", "subtitle__text", this.subtitle);
    this.shownEl = el("span", "subtitle__shown", p);
    this.restEl = el("span", "subtitle__rest", p);
    this.subtitle.hidden = !cfg.show.has("subtitles");

    this.panel = el("aside", "panel is-out", main);
    this.panel.hidden = true;

    const emotion = fold("panel__sec", this.panel);
    this.emotionRow = emotion.el;
    const emotionBody = el("div", "emotion", emotion.body);
    this.emotionDot = el("i", "emotion__dot", emotionBody);
    this.emotionName = new Swap(el("span", "emotion__name", emotionBody));

    const status = fold("panel__sec", this.panel);
    this.statusBox = status.el;
    const statusBody = el("div", "status", status.body);
    const live = fold("status__row", statusBody);
    this.liveRow = live.el;
    const liveBody = el("div", "status__live", live.body);
    el("i", "status__pulse", liveBody);
    el("span", "", liveBody, "直播中");
    const scene = fold("status__row", statusBody);
    this.sceneRow = scene.el;
    this.sceneName = new Swap(el("div", "status__scene", scene.body));
    const chips = el("div", "status__chips", statusBody);
    const chip = (label: string): HTMLElement => {
      const c = el("span", "chip", chips);
      el("i", "chip__dot", c);
      el("span", "", c, label);
      return c;
    };
    this.chips = { core: chip("Core"), vts: chip("VTS"), obs: chip("OBS") };

    const queue = fold("panel__sec", this.panel);
    this.queueBox = queue.el;
    const queueBody = el("div", "queue", queue.body);
    el("h2", "queue__title", queueBody, "接下來");
    this.queueList = new QueueList(el("ol", "queue__list", queueBody));
    const more = fold("queue__more", queueBody);
    this.queueMore = more.el;
    this.queueMoreText = new Swap(more.body);

    this.sections = [this.emotionRow, this.statusBox, this.queueBox];

    // What she is doing (bottom left, right of the voice bars). Also shows an older Core's notice
    // (「準備歌曲中…」).
    this.activity = new ActivityCapsule(main);

    // The line for what people fed her (top centre, over the model's head room).
    this.gift = el("div", "gift is-out", main);
    this.gift.hidden = true;
    this.gift.setAttribute("role", "status");
    this.giftText = new Swap(el("span", "gift__text", this.gift));

    // Paid messages and song dedications, one at a time (top centre, under the gift line).
    this.screen = el("div", "shout is-out", main);
    this.screen.hidden = true;
    this.screen.setAttribute("role", "status");
    this.screenBody = new Swap(el("div", "shout__body", this.screen));

    // Where viewers touched the stream on the website: a ripple and a small heart, at the same
    // place of this 1920x1080 canvas as on their picture.
    this.touchLayer = el("div", "touches", main);
    this.touchLayer.hidden = !cfg.show.has("touches");
    this.touchLayer.setAttribute("aria-hidden", "true");

    this.offline = el("div", "offline is-out", main, "feed offline");
    this.offline.hidden = true;

    this.renderPanel();
  }

  dispatch(action: Action): void {
    if (action.type === "levels") {
      // Same clock as the rAF timestamps, but not tied to a frame having run.
      this.wave.level(action.rms, action.bands, performance.now());
      return;
    }
    if (action.type === "touch") {
      this.showTouch(action);
      return;
    }
    const prev = this.state;
    this.state = reduce(prev, action);
    if (this.state === prev) return;
    if (action.type === "speaking" && !this.state.speaking) this.quietSince = this.lastFrame;
    if (this.state.subtitleSeq !== this.seenSeq) this.onSubtitle();
    this.renderPanel();
  }

  /** Call once per animation frame with the rAF timestamp. */
  frame(now: number): void {
    const dt = this.lastFrame === 0 ? 0 : Math.min(100, now - this.lastFrame);
    this.lastFrame = now;

    if (this.visible) {
      const total = cpLength(this.text);
      if (this.shown < total) {
        this.shown = advance({ shown: this.shown, total, dtMs: dt, final: this.final, cps: this.cfg.cps });
      }
      this.paintText();
      if (this.shown >= total) this.completeAt ??= now;
      this.maybeHide(now, total);
    }
    this.wave.frame(dt, now);
    for (const id of this.touches.expire(performance.now())) this.dropTouch(id);
    present(this.offline, this.cfg.debug && !this.state.connected);
  }

  // ── touches ──────────────────────────────────────────────────────────────

  private showTouch({ x, y, part }: Touch): void {
    if (!this.cfg.show.has("touches")) return;
    const { touch, dropped } = this.touches.add({ x, y, part }, performance.now());
    for (const id of dropped) this.dropTouch(id);
    const e = el("div", `touch touch--${part}`, this.touchLayer);
    e.style.left = `${(x * 100).toFixed(2)}%`;
    e.style.top = `${(y * 100).toFixed(2)}%`;
    el("i", "touch__ripple", e);
    e.insertAdjacentHTML(
      "beforeend",
      '<svg class="touch__heart" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7.5-4.6-9.6-9.2C.9 8.4 2.6 4.5 6.3 4.5c2.1 0 3.9 1.2 5.7 3.2 1.8-2 3.6-3.2 5.7-3.2 3.7 0 5.4 3.9 3.9 7.3C19.5 16.4 12 21 12 21z"/></svg>',
    );
    this.touchEls.set(touch.id, e);
    // The set holds the cap; this only guards the DOM against a bug in it.
    while (this.touchEls.size > MAX_TOUCHES) this.dropTouch(this.touchEls.keys().next().value as number);
  }

  private dropTouch(id: number): void {
    this.touchEls.get(id)?.remove();
    this.touchEls.delete(id);
  }

  // ── subtitle ─────────────────────────────────────────────────────────────

  private onSubtitle(): void {
    const sub = this.state.subtitle;
    this.seenSeq = this.state.subtitleSeq;
    const now = this.lastFrame;
    if (!sub) {
      this.hide();
      return;
    }
    if (this.clearTimer) clearTimeout(this.clearTimer);
    this.clearTimer = undefined;

    const sameTurn = this.visible && sub.turn === this.turn;
    this.shown = sameTurn ? reconcile(this.shown, this.text, sub.text) : 0;
    this.text = sub.text;
    this.turn = sub.turn;
    this.final = sub.final;
    this.lastUpdateAt = now;
    this.completeAt = null;
    if (!this.state.speaking) this.quietSince = now;
    this.paintedShown = -1;
    if (!this.visible) {
      this.visible = true;
      this.subtitle.classList.remove("is-hidden");
    }
    this.subtitle.classList.toggle("is-final", sub.final);
    if (this.cfg.cps >= 200) this.shown = cpLength(sub.text); // effectively "no typewriter"
  }

  private maybeHide(now: number, total: number): void {
    if (this.state.speaking) return; // never take the words away while she is still saying them
    const quiet = Math.max(this.quietSince, this.lastUpdateAt);
    if (this.final) {
      if (this.completeAt !== null && this.shown >= total && now - Math.max(this.completeAt, quiet) > lingerMs(this.text)) {
        this.hide();
      }
    } else if (now - quiet > STALE_PARTIAL_MS) {
      this.hide();
    }
  }

  private hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.subtitle.classList.add("is-hidden");
    // Keep the words while the plate fades out, then drop them so the next line starts from a clean plate.
    this.clearTimer = setTimeout(() => {
      this.shownEl.textContent = "";
      this.restEl.textContent = "";
      this.paintedShown = -1;
    }, 600);
  }

  private paintText(): void {
    const n = Math.floor(this.shown);
    if (n === this.paintedShown) return;
    this.paintedShown = n;
    // The whole line is laid out from the first frame (the unrevealed part is transparent), so
    // words never jump to the next line while they are being typed.
    const [a, b] = splitAt(this.text, n);
    this.shownEl.textContent = a;
    this.restEl.textContent = b;
  }

  // ── paid screen messages ─────────────────────────────────────────────────

  /** Shows the first card of the queue for `SCREEN_SHOW_MS`, then tells the reducer it is done. */
  private renderScreen(): void {
    const card = this.cfg.show.has("screen") ? (this.state.screens[0] ?? null) : null;
    if (card === null) {
      clearTimeout(this.screenTimer);
      this.screenTimer = undefined;
      this.screenShown = null;
      present(this.screen, false);
      return;
    }
    if (card.id === this.screenShown) return;
    this.screenShown = card.id;
    this.screenBody.set(String(card.id), (item) => screenCard(item, card), !isPresent(this.screen));
    present(this.screen, true);
    clearTimeout(this.screenTimer);
    this.screenTimer = setTimeout(() => this.dispatch({ type: "screen_done", id: card.id }), SCREEN_SHOW_MS);
  }

  // ── side panel and activity ──────────────────────────────────────────────

  private renderPanel(): void {
    const { emotion, status, queue } = this.state;
    const show = this.cfg.show;

    if (emotion) {
      const c = emotionColor(emotion.name);
      this.wave.accent(c);
      this.activity.accent(c);
    }
    this.activity.show(show.has("activity") ? shownActivity(this.state) : null);

    const gift = show.has("gifts") ? this.state.gift : null;
    if (gift !== null) this.giftText.text(gift, !isPresent(this.gift));
    present(this.gift, gift !== null);

    this.renderScreen();

    // A panel that is fading in opens its sections at once instead of unfolding them behind the fade.
    const instant = !isPresent(this.panel);

    const emotionOn = show.has("emotion") && emotion !== null;
    if (emotion) {
      this.emotionName.text(emotion.name, instant || !isPresent(this.emotionRow));
      this.emotionDot.style.setProperty("--dot", emotionColor(emotion.name));
      this.emotionDot.style.setProperty("--level", String(0.45 + 0.55 * emotion.intensity));
    }

    const statusOn = show.has("status") && status !== null;
    if (status) {
      present(this.liveRow, status.streaming, instant);
      if (status.scene) this.sceneName.text(status.scene, instant || !isPresent(this.sceneRow));
      present(this.sceneRow, status.scene !== null, instant);
      for (const k of ["core", "vts", "obs"] as const) this.chips[k].classList.toggle("is-ok", status[k]);
    }

    const queueOn = show.has("queue") && queue.length > 0;
    if (queueOn) {
      this.queueList.render(queue.slice(0, QUEUE_SHOWN), instant || !isPresent(this.queueBox));
      const more = queue.length - QUEUE_SHOWN;
      if (more > 0) this.queueMoreText.text(`還有 ${more} 項`, instant || !isPresent(this.queueMore));
      present(this.queueMore, more > 0, instant);
    }

    const on = [emotionOn, statusOn, queueOn];
    const panelOn = on.some(Boolean);
    if (panelOn) present(this.panel, true);
    let first = true;
    this.sections.forEach((sec, i) => {
      // A section folding shut keeps its hairline until it is gone.
      if (!on[i]) {
        present(sec, false, instant);
        return;
      }
      sec.classList.toggle("is-first", first);
      first = false;
      present(sec, true, instant);
    });
    if (!panelOn) present(this.panel, false);
  }
}

/** The card on the screen for a paid message or dedication. */
function screenCard(item: HTMLElement, card: ScreenCard): void {
  item.classList.add("shout__card");
  const head = el("div", "shout__head", item);
  el("span", "shout__tag", head, card.kind === "dedication" ? "點歌獻詞" : "留言");
  el("span", "shout__name", head, card.name);
  el("div", "shout__text", item, card.text);
  if (card.song) el("div", "shout__song", item, `\u266A ${card.song}`);
}

/** Keys of queue items; a repeated item gets its occurrence number. */
function queueKeys(items: readonly QueueItem[]): string[] {
  const seen = new Map<string, number>();
  return items.map((q) => {
    const base = `${q.title}\u0000${q.by ?? ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}\u0000${n}`;
  });
}

/**
 * The queue list, keyed by item: new items unfold in, removed ones fold out before they are dropped,
 * and items that change place slide there (FLIP) instead of jumping.
 */
class QueueList {
  private readonly items = new Map<string, HTMLElement>();

  constructor(private readonly list: HTMLElement) {}

  render(queue: readonly QueueItem[], instant: boolean): void {
    const keys = queueKeys(queue);
    const wanted = new Set(keys);
    // First: where the items that stay are now.
    const before = new Map<HTMLElement, number>();
    for (const li of this.items.values()) before.set(li, li.getBoundingClientRect().top);

    for (const [key, li] of this.items) {
      if (wanted.has(key)) continue;
      this.items.delete(key);
      before.delete(li);
      if (instant) li.remove();
      else {
        li.classList.add("is-out");
        removeAfterExit(li);
      }
    }

    const entering: HTMLElement[] = [];
    let prev: Element | null = null;
    queue.forEach((q, i) => {
      const key = keys[i] as string;
      let li = this.items.get(key);
      if (!li) {
        li = el("li", instant ? "fold queue__item" : "fold queue__item is-out");
        const row = el("div", "queue__row", el("div", "fold__in", li));
        el("span", "queue__n", row);
        el("span", "queue__what", row, q.title);
        if (q.by) el("span", "queue__by", row, q.by);
        this.items.set(key, li);
        if (!instant) entering.push(li);
      }
      const n = li.querySelector(".queue__n");
      if (n) n.textContent = String(i + 1);
      // Items on their way out stay where they are; the others go in queue order around them.
      const at: ChildNode | null = prev ? prev.nextSibling : this.list.firstChild;
      if (at !== li) this.list.insertBefore(li, at);
      prev = li;
    });

    // Last, invert, play: items that moved start where they were and slide into place.
    const moved: HTMLElement[] = [];
    if (!instant) {
      for (const [li, top] of before) {
        const dy = top - li.getBoundingClientRect().top;
        if (Math.abs(dy) < 0.5) continue;
        li.classList.add("no-motion");
        li.style.transform = `translateY(${dy}px)`;
        moved.push(li);
      }
    }
    if (moved.length > 0 || entering.length > 0) reflow(this.list);
    for (const li of moved) {
      li.classList.remove("no-motion");
      li.style.transform = "";
    }
    for (const li of entering) li.classList.remove("is-out");
  }
}
