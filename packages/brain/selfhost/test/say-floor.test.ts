// A line `say` takes to another place claims and counts in that place's Floor, not in the Floor of
// the place of the run.

import { DeliveryLedgerKey, FloorKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { sayKind } from "../../self/src/index.js";
import { books } from "./books.js";
import { calls, channel, line, mention, Rig, says, stopRigs, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const C2 = channel("c2");

describe("say to another place", () => {
  it("holds and counts in the Floor of the place it is said in", async () => {
    const b = books({ budget: { base_lines: 1, per_human_line: 0 } });
    const rig = await Rig.create({
      mode: "mention-only",
      provide: (sup) => {
        sup.services.provide("app", DeliveryLedgerKey, b.ledger);
        sup.services.provide("app", FloorKey, b.floor);
      },
    });
    rig.say(line(C2, "bob", "這裡是二號頻道"));
    await until(() => rig.entries(C2).length === 1, 3_000, "the other place");
    rig.model.push(calls("say", { place: "<#c2>", text: "大家好" }), says("講了"));
    rig.say(mention(C1, "amy", "@她 去二號頻道打招呼"));
    await until(() => rig.sink.texts().length === 2, 3_000, "both lines");
    await until(() => b.floor.holder(C2) === null, 3_000, "the hold in c2 to end");
    expect(b.floor.budget(C2).used).toBe(1);
    expect(b.floor.budget(C2).unanswered).toBe(1);
    expect(b.floor.budget(C1).used).toBe(0);
    // Its own turn, owned by the mouth like every line of hers.
    const [elsewhere, here] = rig.sink.actions.filter((a) => a.payload.type === "send_message");
    expect(elsewhere?.turn).not.toBe(here?.turn);
    expect(rig.sink.strays).toEqual([]);

    // The budget of c2 is used up: the next `say` there is refused by its Floor, and she reads why.
    rig.model.push(calls("say", { place: "<#c2>", text: "再說一次" }), says("被擋了"));
    rig.say(mention(C1, "amy", "@她 再去說一次"));
    await until(() => rig.sink.texts().length === 3, 3_000, "her answer");
    expect(rig.sink.texts()).toEqual(["大家好", "講了", "被擋了"]);
    const result = rig.model.requests[3]?.messages.find(
      (m) => m.role === "tool" && String(m.content).includes("額度用完了"),
    );
    expect(result).toBeDefined();
  });

  it("claims as a start of hers there", () => {
    const from = { account: { platform: "test", id: "amy" }, name: "amy" };
    const message = { context: C1, id: "m1" };
    expect(sayKind({ kind: "addressed", reason: "mention", from, message })).toBe("notable");
    expect(sayKind({ kind: "result", tool: "t", job: null, ok: true, text: "" })).toBe("notable");
    expect(sayKind({ kind: "glance", lines: 2 })).toBe("wish");
    expect(sayKind({ kind: "timer", note: "x" })).toBe("wish");
    expect(sayKind({ kind: "world", what: "x" })).toBe("notable");
  });
});
