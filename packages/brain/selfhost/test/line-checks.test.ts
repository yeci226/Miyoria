// What the old path held back of her own starts, on the lines of the new runner: a repeat of what
// she said there lately (the Floor's `saidLately` check) and a wish that is done (the wish book),
// each coming back to her as the reason the line was not sent.

import { entryOfIncoming } from "@miyoria/memory/transcript";
import {
  type ContextKey,
  DeliveryLedgerKey,
  Events,
  newId,
  toTimestamp,
  WishesKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { WishBook } from "../../arbiter/src/index.js";
import { books } from "./books.js";
import { channel, line, mention, Rig, says, stopRigs, textOf, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const C2 = channel("c2");

/** A timer of hers comes due in `context`. */
function timer(rig: Rig, context: ContextKey, what: string): void {
  rig.sup.bus.publish("mind", Events.MindReminder, {
    state: "fired",
    reminder: {
      id: newId(),
      key: newId(),
      what,
      due: toTimestamp(Date.now()),
      daily: false,
      context,
      person: null,
      for_account: null,
      fired: 1,
      created_at: toTimestamp(Date.now() - 60_000),
    },
  });
}

/** `who` said `text` in `context` before the rig's host heard anything (no run). */
function spokeBefore(rig: Rig, context: ContextKey, who: string, text: string): void {
  const host = rig.host;
  if (host === null) throw new Error("no host");
  host.transcript.append(host.sessionOf(context), [entryOfIncoming(line(context, who, text))], {
    context,
  });
}

describe("a repeat of hers", () => {
  it("a start of hers that says what she said there lately is refused, and she reads why", async () => {
    const { ledger } = books();
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", DeliveryLedgerKey, ledger),
    });
    const said = ledger.open({
      attention_key: "k",
      revision: 1,
      channel: "text",
      context: C1,
      said: "大家早安,今天也要加油喔",
    });
    ledger.ack(said);
    rig.model.push(says("大家早安,今天也要加油喔!"), says(""));
    timer(rig, C1, "跟大家道早安");
    await until(() => rig.model.requests.length === 2, 3_000, "the step after the refusal");
    expect(rig.sink.texts()).toEqual([]);
    expect(textOf(rig.model.requests[1])).toContain("這件事你剛說過了,沒有新進展就不用再提");
  });

  it("what she said in another place is no repeat here", async () => {
    const { ledger } = books();
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", DeliveryLedgerKey, ledger),
    });
    ledger.ack(
      ledger.open({
        attention_key: "k",
        revision: 1,
        channel: "text",
        context: C2,
        said: "大家早安,今天也要加油喔",
      }),
    );
    rig.model.push(says("大家早安,今天也要加油喔!"));
    timer(rig, C1, "跟大家道早安");
    await until(() => rig.sink.texts().length === 1, 3_000, "her line");
    expect(rig.sink.sent()).toEqual([["c1", "大家早安,今天也要加油喔!"]]);
  });

  it("an answer to someone is not checked", async () => {
    const { ledger } = books();
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", DeliveryLedgerKey, ledger),
    });
    ledger.ack(
      ledger.open({ attention_key: "k", revision: 1, channel: "text", context: C1, said: "早安" }),
    );
    rig.model.push(says("早安"));
    rig.say(mention(C1, "amy", "@她 早安"));
    await until(() => rig.sink.texts().length === 1, 3_000, "her answer");
    expect(rig.sink.texts()).toEqual(["早安"]);
  });
});

describe("a wish that is done", () => {
  it("a start of hers asking what was answered is refused with the book's reason", async () => {
    const book = new WishBook({ followup_hours: 24, keep_hours: 72 }, { now: () => Date.now() });
    const wish = book.hold("amy", "問 amy 期末報告", "commitment:c1");
    if (wish === null) throw new Error("no wish");
    book.close(wish.key, "answered");
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", WishesKey, book),
    });
    spokeBefore(rig, C1, "amy", "今天好累");
    rig.model.push(says("amy 你的期末報告後來怎麼樣了?"), says("大家晚安"));
    timer(rig, C1, "關心 amy");
    await until(() => rig.sink.texts().length === 1, 3_000, "the line after the refusal");
    expect(rig.sink.texts()).toEqual(["大家晚安"]);
    expect(textOf(rig.model.requests[1])).toContain("對方已經回答過了,不用再問");
  });

  it("a line to one person is not refused for the closed wish of another in the room", async () => {
    const book = new WishBook({ followup_hours: 24, keep_hours: 72 }, { now: () => Date.now() });
    const wish = book.hold("bob", "問 bob 期末報告", "commitment:c1");
    if (wish === null) throw new Error("no wish");
    book.close(wish.key, "answered");
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", WishesKey, book),
    });
    spokeBefore(rig, C1, "amy", "今天好累");
    spokeBefore(rig, C1, "bob", "我也是");
    rig.model.push(says("@amy 你知道 bob 的期末報告後來怎麼樣了嗎"));
    timer(rig, C1, "關心 amy");
    await until(() => rig.sink.texts().length === 1, 3_000, "her line to amy");
    expect(rig.sink.texts()).toEqual(["@amy 你知道 bob 的期末報告後來怎麼樣了嗎"]);
  });

  it("a line that @mentions the person of the closed wish is refused", async () => {
    const book = new WishBook({ followup_hours: 24, keep_hours: 72 }, { now: () => Date.now() });
    const wish = book.hold("bob", "問 bob 期末報告", "commitment:c1");
    if (wish === null) throw new Error("no wish");
    book.close(wish.key, "answered");
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", WishesKey, book),
    });
    spokeBefore(rig, C1, "amy", "今天好累");
    spokeBefore(rig, C1, "bob", "我也是");
    rig.model.push(says("@bob 期末報告後來怎麼樣了"), says(""));
    timer(rig, C1, "關心 bob");
    await until(() => rig.model.requests.length === 2, 3_000, "the step after the refusal");
    expect(rig.sink.texts()).toEqual([]);
    expect(textOf(rig.model.requests[1])).toContain("對方已經回答過了,不用再問");
  });

  it("asked and not answered yet: no second time before the follow-up", async () => {
    const book = new WishBook({ followup_hours: 24, keep_hours: 72 }, { now: () => Date.now() });
    const wish = book.hold("amy", "問 amy 期末報告", "commitment:c1");
    if (wish === null) throw new Error("no wish");
    book.asked(wish.key);
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", WishesKey, book),
    });
    spokeBefore(rig, C1, "amy", "今天好累");
    rig.model.push(says("amy 期末報告寫完了嗎"), says(""));
    timer(rig, C1, "關心 amy");
    await until(() => rig.model.requests.length === 2, 3_000, "the step after the refusal");
    expect(rig.sink.texts()).toEqual([]);
    expect(textOf(rig.model.requests[1])).toContain("這件事你剛問過了,對方還沒回");
  });
});

describe("the audience of a text line", () => {
  const openWish = (book: WishBook, person: string): string => {
    const wish = book.hold(person, `問 ${person} 期末報告`, `commitment:${person}`);
    if (wish === null) throw new Error("no wish");
    return wish.key;
  };
  const stateOf = (book: WishBook, key: string) => book.all().find((w) => w.key === key)?.state;

  it("asking the person what a wish is about in a start of hers marks it asked", async () => {
    const wishes = new WishBook({ followup_hours: 24, keep_hours: 72 }, { now: () => Date.now() });
    const { ledger } = books({}, 3, [wishes]);
    const key = openWish(wishes, "amy");
    const rig = await Rig.create({
      provide: (sup) => {
        sup.services.provide("app", DeliveryLedgerKey, ledger);
        sup.services.provide("app", WishesKey, wishes);
      },
    });
    spokeBefore(rig, C1, "amy", "今天好累");
    rig.model.push(says("amy 你的期末報告後來怎麼樣了?"));
    timer(rig, C1, "關心 amy");
    await until(() => stateOf(wishes, key) === "asked", 3_000, "the wish marked asked");

    expect(rig.sink.texts()).toEqual(["amy 你的期末報告後來怎麼樣了?"]);
    const again = await wishes.screen({
      person: "amy",
      text: "amy 期末報告寫完了嗎",
      holder: null,
    });
    expect(again.raise).toBe(false);
  });

  it("an answer marks asked the wish of the person who is answered, not of the others there", async () => {
    const wishes = new WishBook({ followup_hours: 24, keep_hours: 72 }, { now: () => Date.now() });
    const { ledger } = books({}, 3, [wishes]);
    const amy = openWish(wishes, "amy");
    const bob = openWish(wishes, "bob");
    const rig = await Rig.create({
      provide: (sup) => {
        sup.services.provide("app", DeliveryLedgerKey, ledger);
        sup.services.provide("app", WishesKey, wishes);
      },
    });
    spokeBefore(rig, C1, "bob", "我也是");
    rig.model.push(says("期末報告後來怎麼樣了?"));
    rig.say(mention(C1, "amy", "@她 在嗎"));
    await until(() => stateOf(wishes, amy) === "asked", 3_000, "amy's wish marked asked");
    expect(stateOf(wishes, bob)).toBe("open");
  });
});
