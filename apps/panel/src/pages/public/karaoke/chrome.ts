// When the singing view's controls show (the "chrome": the bar, the title plate, the notes).
// While the song plays they stay out of the way and come back on demand, like a player's: the
// pointer moving, the pointer resting near an edge or on a control, keyboard focus on a control,
// `Esc`; they go again after a short while without any of that. A tap on the stage (touch)
// toggles them. Before the song starts, after it ends, and while a dialog is open they always
// show. No DOM here: `Singing.tsx` feeds it events and asks it what to show and when to look again.

/** How long the controls stay after the last movement, in ms. */
export const CHROME_IDLE_MS = 2_500;
/** The bands along the top and bottom edges where a resting pointer keeps them, as a share of the height. */
export const CHROME_EDGE = 0.14;

/** `shownAt`: when they were last asked for (ms, any clock); `null`: put away (by a tap, or never asked). */
export interface ChromeState {
  shownAt: number | null;
}

export type ChromeEvent =
  /** The pointer moved, a key was pressed, `Esc`, fullscreen changed: show them (again). */
  | { type: "activity"; at: number }
  /** A tap on the stage: show them when they are away, put them away when they show. */
  | { type: "tap"; at: number; shown: boolean };

export const CHROME_START: ChromeState = { shownAt: null };

export function chromeReduce(_state: ChromeState, e: ChromeEvent): ChromeState {
  if (e.type === "activity") return { shownAt: e.at };
  return e.shown ? { shownAt: null } : { shownAt: e.at };
}

/** Why they must show whatever the timer says. */
export interface ChromeHold {
  /** The song is not playing (before the start, finishing, an error). */
  idle: boolean;
  /** A control has keyboard focus, or the pointer rests on one or near an edge. */
  focus: boolean;
  /** A dialog (or a menu) is open. */
  dialog: boolean;
}

export function chromeHeld(h: ChromeHold): boolean {
  return h.idle || h.focus || h.dialog;
}

/** Whether they show at `now`. */
export function chromeShown(state: ChromeState, hold: ChromeHold, now: number): boolean {
  if (chromeHeld(hold)) return true;
  return state.shownAt !== null && now - state.shownAt < CHROME_IDLE_MS;
}

/** In how many ms they go away by themselves (to look again then), or `null` when they will not. */
export function chromeHidesIn(state: ChromeState, hold: ChromeHold, now: number): number | null {
  if (chromeHeld(hold) || state.shownAt === null) return null;
  const left = state.shownAt + CHROME_IDLE_MS - now;
  return left > 0 ? left : null;
}

/** Whether a pointer at `y` (from the top) of a stage `height` tall rests in an edge band. */
export function nearEdge(y: number, height: number): boolean {
  if (height <= 0) return false;
  const band = height * CHROME_EDGE;
  return y <= band || y >= height - band;
}
