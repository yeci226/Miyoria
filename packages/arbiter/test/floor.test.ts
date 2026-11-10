// The Floor (docs/design/v3-architecture.md §7) on a real log and ledger shape, without the rest of
// her: the claim order, a budget nothing but delivered lines moves, interrupt levels, and the mic
// coming back on every way a turn can end.

import {
  type ContextKey,
  claimOf,
  type Delivery,
  type DeliveryLedger,
  FLOOR_CLAIMS,
  type FloorClaimKind,
  floorRank,
  type Impulse,
  type LogEvent,
  newId,
  newImpulse,
  toTimestamp,
} from "@miyoria/types";
import { beforeEach, describe, expect, it } from "vitest";
import { arbiterConfig, FLOOR_SOURCE, FloorConfigSchema, FloorCore } from "../src/index.js";

const ROOM: ContextKey = { platform: "t", scope: "g", channel: "v", kind: "voice" };
const TEXT: ContextKey = { platform: "t", scope: "g", channel: "c", kind: "channel" };
const MIN = 60_000;

/** A log of one: the Floor as a projection, fed by hand. */
class Rig {
  now = Date.UTC(2026, 10, 7, 6);
  humans: number | null = 2;
  performing = false;
  talk = 1;
  feeling = 0;
  deliveries: Delivery[] = [];
  floor: FloorCore;

  constructor(overrides: Record<string, unknown> = {}, maxUnanswered = 3) {
    const ledger = {
      delivered: (key: string) => this.deliveries.findLast((d) => d.attention_key === key) ?? null,
      mayClaim: (o: { attention_key: string; revision: number; salience: string }) => {
        const d = this.deliveries.findLast((x) => x.attention_key === o.attention_key);
        return o.salience !== "ambient" && (d === undefined || d.revision < o.revision);
      },
      saidLately: () => null,
    } as unknown as DeliveryLedger;
    this.floor = new FloorCore(FloorConfigSchema.parse(overrides), maxUnanswered, {
      now: () => this.now,
      ledger: () => ledger,
      humans: () => this.humans,
      performing: () => this.performing,
      talk: () => this.talk,
      feeling: () => this.feeling,
    });
  }

  #event(kind: LogEvent["kind"], body: unknown, context: ContextKey | null = ROOM): LogEvent {
    return {
      id: newId(),
      at: toTimestamp(this.now),
      kind,
      source: "t",
      cause: null,
      context,
      person: null,
      body: body as LogEvent["body"],
    };
  }

  /** A line of `turn` goes out; returns its id. */
  open(turn: string): string {
    const event = this.#event("utterance", { turn });
    this.floor.apply(event);
    return event.id;
  }

  ack(line: string, key = "k", revision = 1): void {
    const d = {
      attention_key: key,
      revision,
      channel: "voice",
      context: ROOM,
      said: "x",
      delivered_at: toTimestamp(this.now),
      audience: [],
      answered_by: [],
      line,
    } as Delivery;
    this.deliveries.push(d);
    this.floor.apply(this.#event("delivered", d));
  }

  undelivered(line: string, state: string): void {
    this.floor.apply(this.#event("result", { line, delivery: state }));
  }

  /** A whole turn of hers, heard to the end. */
  said(kind: FloorClaimKind, lines = 1, context: ContextKey = ROOM): string {
    const turn = newId();
    this.floor.hold(turn, context, kind);
    for (let i = 0; i < lines; i++) this.ack(this.open(turn));
    this.floor.turnEnded(turn);
    return turn;
  }

  person(context: ContextKey = ROOM): void {
    this.floor.apply(
      this.#event(
        "observation",
        { observation: { from: "Alice", context }, speech: true, buckets: [] },
        context,
      ),
    );
  }
}

let rig: Rig;

beforeEach(() => {
  rig = new Rig();
});

function impulse(input: Partial<Parameters<typeof newImpulse>[0]>): Impulse {
  return newImpulse({ source: "game", context: ROOM, ttlMs: MIN, why: "", ...input }, rig.now);
}

describe("claim order", () => {
  it("is §7.1, most urgent first", () => {
    expect(FLOOR_CLAIMS).toEqual([
      "addressed",
      "reply",
      "result",
      "urgent",
      "notable",
      "wish",
      "ambient",
    ]);
    expect(floorRank("addressed")).toBe(1);
    expect(floorRank("ambient")).toBe(7);
  });

  it("reads each source as its row", () => {
    expect(claimOf(impulse({ source: "notice" }))).toBe("result");
    expect(claimOf(impulse({ source: "song" }))).toBe("result");
    expect(claimOf(impulse({ source: "followup", reason: "action_result" }))).toBe("result");
    expect(claimOf(impulse({ source: "followup", reason: "followup" }))).toBe("wish");
    expect(claimOf(impulse({ source: "plan" }))).toBe("wish");
    expect(claimOf(impulse({ source: "game" }))).toBe("urgent");
    const narration = { key: "game:x", repeat_after_ms: 1 };
    expect(claimOf(impulse({ source: "game", attention: narration }))).toBe("notable");
    expect(claimOf(impulse({ source: "world" }))).toBe("notable");
    expect(claimOf(impulse({ claim: "urgent", source: "world" }))).toBe("urgent");
  });

  it("someone waiting always gets the mic, whatever her budget says", () => {
    for (let i = 0; i < 10; i++) rig.said("notable", 2);
    expect(rig.floor.check("notable", ROOM)).not.toBeNull();
    for (const kind of ["addressed", "reply", "result", "urgent"] as const) {
      expect(rig.floor.check(kind, ROOM), kind).toBeNull();
    }
  });

  it("wishes need somebody there; a voice room counts heads, a text channel recent words", () => {
    rig.humans = 0;
    expect(rig.floor.check("wish", ROOM)?.detail).toContain("真人");
    expect(rig.floor.check("notable", ROOM)).toBeNull();
    rig.humans = null;
    expect(rig.floor.check("wish", TEXT)?.detail).toContain("真人");
    rig.person(TEXT);
    rig.now += 29 * MIN;
    expect(rig.floor.check("wish", TEXT)).toBeNull();
    rig.now += 2 * MIN;
    expect(rig.floor.check("wish", TEXT)?.detail).toContain("真人");
  });
});

describe("budget", () => {
  it("counts only lines that reached someone", () => {
    const turn = newId();
    rig.floor.hold(turn, ROOM, "notable");
    const heard = rig.open(turn);
    const cut = rig.open(turn);
    const lost = rig.open(turn);
    rig.ack(heard);
    rig.undelivered(cut, "interrupted");
    rig.undelivered(lost, "failed");
    expect(rig.floor.budget(ROOM).used).toBe(1);
  });

  it("cannot be reset by anything she does: tools, tasks, quiet turns, answering", () => {
    for (let i = 0; i < 6; i++) rig.said("notable");
    const before = rig.floor.budget(ROOM);
    expect(before.used).toBe(6);
    // What a tool run leaves in the log, a turn that said nothing and one owed to someone.
    rig.floor.apply({
      id: newId(),
      at: toTimestamp(rig.now),
      kind: "action",
      source: "mainline.hands",
      cause: null,
      context: ROOM,
      person: null,
      body: { tool: "game_goal" },
    });
    rig.floor.apply({
      id: newId(),
      at: toTimestamp(rig.now),
      kind: "result",
      source: "mainline.hands",
      cause: null,
      context: ROOM,
      person: null,
      body: { state: "done" },
    });
    const quiet = newId();
    rig.floor.hold(quiet, ROOM, "notable");
    rig.floor.turnEnded(quiet);
    rig.said("addressed", 3);
    expect(rig.floor.budget(ROOM)).toEqual(before);
  });

  it("lines of a person add to it, and the window frees what is old", () => {
    for (let i = 0; i < 6; i++) rig.said("ambient");
    expect(rig.floor.check("ambient", ROOM)?.reason).toBe("rate");
    rig.person();
    expect(rig.floor.budget(ROOM).allowed).toBe(7);
    expect(rig.floor.check("ambient", ROOM)).toBeNull();
    rig.said("ambient");
    expect(rig.floor.check("ambient", ROOM)?.reason).toBe("rate");
    rig.now += 11 * MIN;
    expect(rig.floor.budget(ROOM).used).toBe(0);
    expect(rig.floor.check("ambient", ROOM)).toBeNull();
  });

  it("performing adds its bonus", () => {
    rig.performing = true;
    expect(rig.floor.budget(ROOM).allowed).toBe(14);
  });

  it("her talkativeness scales it, up to the owner's cap", () => {
    rig.talk = 0.5;
    expect(rig.floor.budget(ROOM).allowed).toBe(3);
    rig.talk = 10;
    expect(rig.floor.budget(ROOM).allowed).toBe(9);
  });

  it("how she feels is a weight on her own lines, inside hard limits", () => {
    rig.feeling = 0.2;
    expect(rig.floor.budget(ROOM).allowed).toBe(7);
    rig.feeling = -0.2;
    expect(rig.floor.budget(ROOM).allowed).toBe(4);
    rig.feeling = 100;
    expect(rig.floor.budget(ROOM).allowed).toBe(7);
    rig.feeling = -100;
    expect(rig.floor.budget(ROOM).allowed).toBe(3);
  });

  it("what people say still counts in full, and so does performing", () => {
    rig.feeling = -100;
    for (let i = 0; i < 4; i++) rig.person();
    expect(rig.floor.budget(ROOM).allowed).toBe(7);
    rig.performing = true;
    expect(rig.floor.budget(ROOM).allowed).toBe(15);
  });

  it("feeling and talkativeness together stop at the owner's cap", () => {
    rig.talk = 1.5;
    rig.feeling = 100;
    expect(rig.floor.budget(ROOM).allowed).toBe(9);
  });

  it("a broken reading lifts no limit", () => {
    rig.feeling = Number.NaN;
    expect(rig.floor.budget(ROOM).allowed).toBe(6);
    rig.feeling = Number.POSITIVE_INFINITY;
    expect(rig.floor.budget(ROOM).allowed).toBe(6);
    rig.feeling = 0;
    rig.talk = Number.NaN;
    expect(rig.floor.budget(ROOM).allowed).toBe(6);
  });

  it("the limits cannot be configured away", () => {
    expect(() => FloorConfigSchema.parse({ min_feeling_multiplier: 0 })).toThrow();
    expect(() => FloorConfigSchema.parse({ max_feeling_multiplier: 0.5 })).toThrow();
  });

  it("the worst mood leaves her a line, and her own silence stays hers", () => {
    const small = new Rig({ budget: { base_lines: 1 } });
    small.feeling = -100;
    expect(small.floor.budget(ROOM).allowed).toBe(1);
    expect(small.floor.check("wish", ROOM)).toBeNull();
    small.talk = 0;
    expect(small.floor.budget(ROOM).allowed).toBe(0);
  });

  it("a feeling moves no count: a good mood resets nothing", () => {
    rig.person();
    rig.said("wish", 3);
    const before = rig.floor.budget(ROOM);
    for (const feeling of [-100, 100, 0]) {
      rig.feeling = feeling;
      const after = rig.floor.budget(ROOM);
      expect(after.used).toBe(before.used);
      expect(after.unanswered).toBe(before.unanswered);
      expect(after.human_lines).toBe(before.human_lines);
    }
  });

  it("at her limit, a better mood only adds what the limit allows", () => {
    rig.feeling = -100;
    rig.said("ambient", 3);
    expect(rig.floor.check("ambient", ROOM)?.reason).toBe("rate");
    rig.feeling = 100;
    expect(rig.floor.check("ambient", ROOM)).toBeNull();
    rig.said("ambient", 4);
    expect(rig.floor.check("ambient", ROOM)?.reason).toBe("rate");
  });

  it("no feeling gets past max_unanswered or the wait after a line nobody answered", () => {
    rig.feeling = 100;
    rig.talk = 100;
    rig.said("notable");
    expect(rig.floor.check("notable", ROOM)?.reason).toBe("unanswered");
    for (let i = 0; i < 2; i++) {
      rig.now += 5 * MIN;
      rig.said("notable");
    }
    rig.now += 5 * MIN;
    expect(rig.floor.waitingForResponse(ROOM)).toBe(true);
    expect(rig.floor.check("notable", ROOM)).toMatchObject({ reason: "unanswered", retryAt: null });
    expect(rig.floor.check("wish", ROOM)?.reason).toBe("unanswered");
  });

  it("no feeling keeps her from answering, or changes who may cut in", () => {
    const levels = () =>
      FLOOR_CLAIMS.flatMap((incoming) =>
        FLOOR_CLAIMS.map((holder) => rig.floor.interruptLevel(incoming, holder)),
      );
    const calm = levels();
    for (const feeling of [-100, 100]) {
      rig.feeling = feeling;
      rig.talk = feeling < 0 ? 0 : 100;
      for (const kind of ["addressed", "reply", "result", "urgent"] as const) {
        expect(rig.floor.check(kind, ROOM), `${kind} at ${feeling}`).toBeNull();
      }
      expect(levels()).toEqual(calm);
    }
  });

  it("max_unanswered: quiet until a person speaks, and a person speaking resumes her", () => {
    for (let i = 0; i < 3; i++) {
      rig.said("notable");
      rig.now += 5 * MIN;
    }
    const held = rig.floor.check("notable", ROOM);
    expect(held?.reason).toBe("unanswered");
    expect(held?.detail).toContain("3");
    expect(rig.floor.budget(ROOM).waiting_for_response).toBe(true);
    rig.now += 60 * MIN;
    expect(rig.floor.check("notable", ROOM)?.reason).toBe("unanswered");
    rig.person();
    expect(rig.floor.check("notable", ROOM)).toBeNull();
  });

  it("a turn counts once, however many sentences it had; a new audience starts over", () => {
    rig.said("notable", 3);
    expect(rig.floor.budget(ROOM).unanswered).toBe(1);
    rig.floor.newAudience(ROOM);
    expect(rig.floor.budget(ROOM).unanswered).toBe(0);
  });

  it("each line nobody answered doubles the wait", () => {
    rig.said("notable");
    expect(rig.floor.check("notable", ROOM)?.reason).toBe("unanswered");
    rig.now += 60_000;
    expect(rig.floor.check("notable", ROOM)).toBeNull();
    rig.said("notable");
    rig.now += 60_000;
    expect(rig.floor.check("notable", ROOM)?.retryAt).toBe(rig.now + 60_000);
    rig.now += 60_000;
    expect(rig.floor.check("notable", ROOM)).toBeNull();
  });

  it("does not go mute in an ordinary quiet room (§21): a few lines an hour still get through", () => {
    let said = 0;
    for (let minute = 0; minute < 60; minute += 4) {
      if (rig.floor.check("notable", ROOM) === null) {
        rig.said("notable", 2);
        said += 1;
      }
      // Somebody answers now and then.
      if (minute % 12 === 0) rig.person();
      rig.now += 4 * MIN;
    }
    expect(said).toBeGreaterThanOrEqual(8);
  });
});

describe("what was said is not claimed again", () => {
  const attention = { key: "game:craft:stone_pickaxe", repeat_after_ms: 45 * MIN };

  it("the same revision is a repeat from the moment a turn takes it", () => {
    expect(rig.floor.repeated(attention)).toBe(false);
    rig.floor.reserve(attention, "t1");
    expect(rig.floor.repeated(attention)).toBe(true);
  });

  it("a turn that did not go out gives it back", () => {
    rig.floor.reserve(attention, "t1");
    rig.floor.unreserve(attention);
    expect(rig.floor.repeated(attention)).toBe(false);
  });

  it("delivered stops it until the repeat window passed; undelivered does not", () => {
    const turn = newId();
    rig.floor.hold(turn, ROOM, "notable");
    rig.undelivered(rig.open(turn), "interrupted");
    expect(rig.floor.repeated(attention)).toBe(false);
    rig.ack(rig.open(turn), attention.key);
    expect(rig.floor.repeated(attention)).toBe(true);
    rig.now += 46 * MIN;
    expect(rig.floor.repeated(attention)).toBe(false);
    expect(rig.floor.revisionOf(attention)).toBe(2);
  });

  it("the turn's end frees what it reserved, the ledger takes over", () => {
    rig.floor.hold("t1", ROOM, "notable");
    rig.floor.reserve(attention, "t1");
    rig.floor.turnEnded("t1");
    expect(rig.floor.holder(ROOM)).toBeNull();
    expect(rig.floor.repeated(attention)).toBe(false);
  });
});

describe("interrupt levels", () => {
  const level = (incoming: FloorClaimKind, holder: FloorClaimKind, overHer = false) =>
    rig.floor.interruptLevel(incoming, holder, overHer);

  it("someone calling her wraps up what she says on her own, and waits for an answer to end", () => {
    expect(level("addressed", "notable")).toBe("wrap_up");
    expect(level("reply", "wish")).toBe("wrap_up");
    expect(level("addressed", "addressed")).toBe("queue");
    expect(level("addressed", "result")).toBe("queue");
  });

  it("urgent cuts her own lines short and wraps up the rest", () => {
    expect(level("urgent", "ambient")).toBe("cut_short");
    expect(level("urgent", "addressed")).toBe("wrap_up");
    expect(level("urgent", "urgent")).toBe("queue");
  });

  it("nothing of her own or a result ever cuts anyone off", () => {
    for (const incoming of ["result", "notable", "wish", "ambient"] as const) {
      for (const holder of FLOOR_CLAIMS) expect(level(incoming, holder)).toBe("queue");
    }
  });

  it("a person talking over her stops her at once", () => {
    expect(level("addressed", "addressed", true)).toBe("interrupt");
  });
});

describe("the mic is released", () => {
  it("only after the audio finished, not when generation ended", () => {
    rig.floor.hold("t", ROOM, "addressed");
    const line = rig.open("t");
    rig.floor.turnEnded("t");
    expect(rig.floor.holder(ROOM)?.turn).toBe("t");
    rig.ack(line);
    expect(rig.floor.holder(ROOM)).toBeNull();
  });

  it("not while another line of the turn is still out", () => {
    rig.floor.hold("t", ROOM, "addressed");
    const a = rig.open("t");
    const b = rig.open("t");
    rig.floor.turnEnded("t");
    rig.ack(a);
    expect(rig.floor.holder(ROOM)).not.toBeNull();
    rig.ack(b);
    expect(rig.floor.holder(ROOM)).toBeNull();
  });

  it.each(["interrupted", "failed", "cancelled"])("when a line ends %s", (state) => {
    rig.floor.hold("t", ROOM, "addressed");
    const line = rig.open("t");
    rig.floor.turnEnded("t");
    rig.undelivered(line, state);
    expect(rig.floor.holder(ROOM)).toBeNull();
  });

  it("when a turn ends with nothing said", () => {
    rig.floor.hold("t", ROOM, "addressed");
    rig.floor.turnEnded("t");
    expect(rig.floor.holder(ROOM)).toBeNull();
  });

  it("when she leaves the channel, whatever is in flight", () => {
    rig.floor.hold("t", ROOM, "addressed");
    rig.open("t");
    rig.floor.releaseContext(ROOM, "left");
    expect(rig.floor.holder(ROOM)).toBeNull();
  });

  it("after max_hold_secs when a line never reports back: a lost ack does not mute her", () => {
    rig.floor.hold("t", ROOM, "addressed");
    rig.open("t");
    rig.floor.turnEnded("t");
    rig.now += 119_000;
    expect(rig.floor.expire()).toEqual([]);
    rig.now += 2_000;
    expect(rig.floor.expire()).toEqual(["t"]);
    expect(rig.floor.holder(ROOM)).toBeNull();
  });

  it("the most urgent hold is what a claim is measured against", () => {
    rig.floor.hold("own", ROOM, "notable");
    rig.floor.hold("answer", ROOM, "addressed");
    expect(rig.floor.holder(ROOM)?.turn).toBe("answer");
  });
});

describe("a restart", () => {
  it("rebuilds the budget from the log", () => {
    const first = new Rig();
    const events: LogEvent[] = [];
    const at = toTimestamp(first.now);
    const line = "line-1";
    const event = (
      kind: LogEvent["kind"],
      source: string,
      id: string,
      body: unknown,
    ): LogEvent => ({
      id,
      at,
      kind,
      source,
      cause: null,
      context: ROOM,
      person: null,
      body: body as LogEvent["body"],
    });
    events.push(event("decision", FLOOR_SOURCE, "d", { floor_turn: "t", kind: "notable" }));
    events.push(event("utterance", "mainline", line, { turn: "t" }));
    events.push(
      event("delivered", "delivery.voice", "a", {
        line,
        context: ROOM,
        delivered_at: at,
        attention_key: "k",
        revision: 1,
      }),
    );
    for (const e of events) first.floor.apply(e);
    expect(first.floor.budget(ROOM)).toMatchObject({ used: 1, unanswered: 1 });
  });
});

it("the config has §7.2's numbers", () => {
  expect(arbiterConfig().floor.budget).toEqual({
    window_mins: 10,
    base_lines: 6,
    per_human_line: 1,
    unanswered_backoff: 2,
    backoff_base_secs: 60,
    performing_bonus: 8,
  });
  expect(arbiterConfig().max_unanswered).toBe(3);
});
