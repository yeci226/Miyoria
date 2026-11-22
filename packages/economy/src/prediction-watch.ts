// What predictions that settle by themselves are bound to and settled on (docs/design/v5-play.md
// §4.2: "由遊戲和直播的事件自動結算"). Only what the system itself saw, never anything a member
// typed:
//
// * `soup`: a turtle soup going on (`PartyOverview` lists it). The party module tells when it
//   ends (`PartyOutcomes`): guessed (the referee's ruling as the game took it) settles 「猜中」,
//   ended any other way 「沒猜中」. A soup that ends with the module shutting down is never told:
//   nothing is known, and the sweep gives every stake back when the wait runs out.
// * `goal`: the game goal she is working on, as the game director's decisions name it
//   (`game.director.decision`). Its end (`game.director.goal`) settles 「做到」 when done, and
//   「沒做到」 when it failed at it (gave up, no progress, died, timed out, ...). A goal that did not
//   really end (cancelled, superseded, busy, invalid, the game's process went away) or a game
//   session that stopped first cannot be told: every stake goes back.
//
// What she is working on is kept in memory from the bus: after a restart nothing can be bound
// until the director decides again, and a goal that ended while the economy was down is never
// seen (the sweep gives the stakes back).

import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type BusEvent,
  type ContextKey,
  contextKeyEquals,
  Events,
  is,
  type PartyOutcome,
  type PartyOutcomes,
  PartyOverviewKey,
  PlacesKey,
} from "@miyoria/types";
import type { EconomyService } from "./economy.js";
import type { PredictionDesk, PredictionSource } from "./predictions.js";
import { spaceAt } from "./spaces.js";
import type { PredictionSourceKind } from "./v2-types.js";

/** Goal ends that say nothing about whether she could do it: the goal did not really end. */
const UNTOLD = new Set(["cancelled", "superseded", "busy", "invalid", "disconnected", "crashed"]);

/** Bus topics the watch reads (the economy module subscribes to them). */
export const WATCHED_TOPICS = [
  Events.GameDirectorSession.type,
  Events.GameDirectorDecision.type,
  Events.GameDirectorGoal.type,
] as const;

export class PredictionWatch implements PartyOutcomes {
  /** Game → the goal she is working on in it (`null`: a session with no goal yet). */
  readonly #goals = new Map<string, string | null>();

  constructor(
    private readonly e: EconomyService,
    private readonly desk: PredictionDesk,
  ) {}

  /** What a prediction opened now would be bound to; `null` when there is nothing (or too much). */
  bind(kind: PredictionSourceKind, context: ContextKey | null): PredictionSource | null {
    if (kind === "goal") {
      const going = [...this.#goals].filter(
        (entry): entry is [string, string] => entry[1] !== null,
      );
      if (going.length !== 1) return null;
      const [game, goal] = going[0] as [string, string];
      return { kind, ref: goal, game, label: `她的遊戲目標「${goal}」` };
    }
    // A soup of another server is never this one's to bet on.
    const places = this.e.services.get(PlacesKey);
    const space = spaceAt(places, context);
    const soups = (this.e.services.get(PartyOverviewKey)?.snapshot().sessions ?? []).filter(
      (s) => s.game === "soup" && (space === null || spaceAt(places, s.context) === space),
    );
    const here = context === null ? [] : soups.filter((s) => contextKeyEquals(s.context, context));
    const soup = here.length === 1 ? here[0] : soups.length === 1 ? soups[0] : undefined;
    if (soup === undefined) return null;
    return { kind, ref: soup.id, game: "soup", label: "這碗海龜湯" };
  }

  /** A party game ended (`PartyOutcomesKey`): a soup settles what is bound to it. */
  async ended(o: PartyOutcome): Promise<void> {
    if (o.game !== "soup") return;
    const result = o.solved === null ? null : o.solved ? 0 : 1;
    const note =
      o.solved === null
        ? "看不出海龜湯的結果,全部退回"
        : o.solved
          ? "海龜湯被猜中了"
          : "海龜湯沒有人猜中就結束了";
    await this.#settle("soup", { ref: o.session, game: "soup" }, result, note);
  }

  /** One of `WATCHED_TOPICS`. */
  async onEvent(env: BusEvent): Promise<void> {
    if (is(Events.GameDirectorSession, env)) {
      const { game, state } = env.data;
      if (state === "started") {
        this.#goals.set(game, null);
        return;
      }
      this.#goals.delete(game);
      await this.#settle("goal", { game }, null, "遊戲在目標結束前停了,全部退回");
    } else if (is(Events.GameDirectorDecision, env)) {
      if (env.data.goal !== null && env.data.goal.trim() !== "") {
        this.#goals.set(env.data.game, env.data.goal);
      }
    } else if (is(Events.GameDirectorGoal, env)) {
      const end = env.data;
      if (this.#goals.get(end.game) === end.goal) this.#goals.set(end.game, null);
      const result = end.status === "done" ? 0 : UNTOLD.has(end.code) ? null : 1;
      const note =
        result === 0
          ? `她做到了目標「${end.goal}」`
          : result === 1
            ? `目標「${end.goal}」沒有做到`
            : `目標「${end.goal}」沒有真的結束(${end.code}),全部退回`;
      await this.#settle("goal", { ref: end.goal, game: end.game }, result, note);
    }
  }

  async #settle(
    kind: PredictionSourceKind,
    match: { ref?: string; game: string },
    result: number | null,
    note: string,
  ): Promise<void> {
    try {
      await this.desk.settleFrom(kind, match, result, note);
    } catch (error) {
      this.e.log.warn({ err: errorMessage(error), kind }, "cannot settle predictions on it");
    }
  }
}
