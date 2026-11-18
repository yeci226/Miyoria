// What other modules ask her to say, on the new runner: the Arbiter's `ImpulseHost` (a game's
// narration, a song's announcement, a notice).
//
// The Arbiter still decides whether and when: its floors, the Floor's claims, and retrying a
// place that is busy, most urgent first. What it admits is a run of the place's lane, as the turn
// the Arbiter books: the voice channel she is in when it is news of hers (a game, a song, a
// notice) and she is in voice on that server, else the place it names. The lane starts it at once
// or answers `busy` (never queued behind a run), as the old coordinator did; a claim that cuts
// into her speech there does so first (`Agent.yieldTo`, the Floor's interrupt level). What expires
// within seconds (a song's opening, which the song does not wait for) cannot wait for the
// Arbiter's retries: the desk asks the lane again every moment while the place is busy, so a run
// answering someone finishes first and the announcement still comes inside its window; the lane
// cancels one that has said nothing when the window is over. Past it nothing is said.
//
// The run's wake: a notice is a `result` whose data is the notices waiting for that place (taken
// when the run starts, so block 6 does not show them again); anything else is a `world` wake with
// what happened (`ADMITTED_NOTES`) and the Floor row it was admitted under. Lines that are fixed
// text do not come here: they go out through the mouth (`MouthKey.say`).

import { sleep } from "@miyoria/runtime/kernel";
import {
  type ArbiterReason,
  type ContextKey,
  type ConversationFacts,
  claimOf,
  type Impulse,
  type ImpulseHost,
  type ImpulseRun,
  newId,
} from "@miyoria/types";
import type { Agent } from "../../agent/src/index.js";
import type { Wake } from "../../self/src/index.js";
import { ADMITTED_NOTES, NOTICE_TOOL, noticeLine } from "./impulse-texts.js";
import type { AdmittedAnswer, AdmittedInput } from "./lane.js";

/** How long the Arbiter waits for a lane to take (or refuse) what it admitted. */
const OPEN_TIMEOUT_MS = 5_000;
/** An impulse that expires within this has no room for the Arbiter's retries (a song's opening). */
const SHORT_WINDOW_MS = 10_000;
/** How often the lane is asked again for such an impulse while its place is busy. */
const OFFER_EVERY_MS = 100;

export interface ImpulseDeskHost {
  agent: Agent;
  /** Hands `input` to the lane of `context`; `false`: no lane took it. */
  admit(context: ContextKey, input: AdmittedInput): boolean;
}

const refused = (reason: ArbiterReason, detail: string): ImpulseRun => ({
  status: "refused",
  reason,
  detail,
});

/** The Arbiter's host on the new runner (`ImpulseHostKey`). */
export class ImpulseDesk implements ImpulseHost {
  readonly #h: ImpulseDeskHost;

  constructor(host: ImpulseDeskHost) {
    this.#h = host;
  }

  facts(context: ContextKey): ConversationFacts {
    return this.#h.agent.facts(context);
  }

  async open(impulse: Impulse, signal?: AbortSignal): Promise<ImpulseRun> {
    const agent = this.#h.agent;
    if (agent.muted) return refused("denied", "緊急停止中");
    if (impulse.kind !== "speak") return refused("denied", "沒有動作的執行者");
    const target = impulse.target.context;
    if (target === null) return refused("denied", "沒有地方可以說");
    const source = impulse.source;
    const hers =
      source === "game" || source === "watch" || source === "song" || source === "notice";
    const context = hers ? agent.ownLinesContext(target) : target;
    if (context.kind === "voice" && !agent.inVoice(context)) {
      return refused("denied", "不在那個語音頻道");
    }
    const claim = claimOf(impulse);
    agent.yieldTo(context, claim);
    const hint = (impulse.hint ?? "").trim();
    const wake = (): Wake | null => {
      if (source === "notice") return this.#notices(context);
      const what =
        source === "game"
          ? ADMITTED_NOTES.game(hint)
          : source === "watch"
            ? ADMITTED_NOTES.watch(hint)
            : source === "song"
              ? ADMITTED_NOTES.song(hint)
              : ADMITTED_NOTES.other(hint === "" ? impulse.why : hint);
      return what.trim() === "" ? null : { kind: "world", what, claim };
    };
    const turn = newId();
    const started = (): Wake | null => {
      const w = wake();
      // Its lines are about what was admitted: the delivery ledger keeps the repeat window.
      if (w !== null) agent.mainline.about(turn, impulse.attention ?? null);
      return w;
    };
    // What is worth saying only for a few seconds (a song's opening) has no room for the Arbiter's
    // retries: while the place is busy, the lane is asked again until the window is over.
    const now = agent.ctx.clock.now();
    const expires = Date.parse(impulse.expires_at);
    const short = expires - now <= SHORT_WINDOW_MS;
    const giveUp = Math.min(expires, now + OPEN_TIMEOUT_MS);
    const until = short ? expires : undefined;
    let answer = await this.#admit(context, turn, started, signal, until);
    while (
      short &&
      answer.status === "busy" &&
      answer.open &&
      signal?.aborted !== true &&
      agent.ctx.clock.now() + OFFER_EVERY_MS < giveUp
    ) {
      try {
        await sleep(OFFER_EVERY_MS, signal);
      } catch {
        break;
      }
      answer = await this.#admit(context, turn, started, signal, until);
    }
    switch (answer.status) {
      case "started":
        return { status: "started", turn, task: null, detail: "" };
      case "busy":
        return { status: "busy", detail: answer.why };
      case "empty":
        return refused("repeat", "已經說過了");
    }
  }

  /** The notices waiting for `context` as a result to tell, taken; `null`: none are left. */
  #notices(context: ContextKey): Wake | null {
    const notices = this.#h.agent.takeNotices(context);
    if (notices.length === 0) return null;
    const only = notices.length === 1 ? notices[0] : undefined;
    return {
      kind: "result",
      tool: NOTICE_TOOL,
      job: only?.task ?? null,
      ok: notices.every((n) => n.ok),
      text: notices.map((n) => noticeLine(n.ok, n.text)).join("\n"),
      from: null,
    };
  }

  /**
   * Hands the run to the lane of `context` and waits for its answer (busy after a while);
   * `open`: the lane gave the answer, so asking again may be answered otherwise.
   */
  #admit(
    context: ContextKey,
    turn: string,
    wake: () => Wake | null,
    signal: AbortSignal | undefined,
    until: number | undefined,
  ): Promise<AdmittedAnswer & { open: boolean }> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (answer: AdmittedAnswer, open = false): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        resolve({ ...answer, open });
      };
      const onAbort = (): void => done({ status: "busy", why: "the arbiter gave up on it" });
      const timer = setTimeout(
        () => done({ status: "busy", why: "the place did not answer" }),
        OPEN_TIMEOUT_MS,
      );
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      const taken = this.#h.admit(context, {
        type: "admitted",
        turn,
        // An answer that came too late is no run: the Arbiter already took it as busy.
        wake: () => (settled ? null : wake()),
        ...(until !== undefined && { until }),
        answer: (answer) => done(answer, true),
      });
      if (!taken) done({ status: "busy", why: "the place is closing" });
    });
  }
}
