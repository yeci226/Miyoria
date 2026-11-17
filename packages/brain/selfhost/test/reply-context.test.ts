// The lines around a replied-to message she cannot see (the old `fetchAround`): in block 7 of the
// run that answers the reply, never in the transcript.

import {
  type Attitude,
  type HistoryQuery,
  type IncomingMessage,
  type MessageRef,
  PlatformHistories,
  PlatformHistoriesKey,
  SocialSignalsKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { agoLabel } from "../src/parent.js";
import { account, channel, line, mention, Rig, says, stopRigs, textOf, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const MINUTE = 60_000;

function old(id: string, who: string, text: string, ago: number): IncomingMessage {
  return { ...line(C1, who, text), id: { context: C1, id }, ts: toTimestamp(Date.now() - ago) };
}

/** A platform history of `lines` (oldest first); `fetched` records each `fetch`. */
function history(lines: IncomingMessage[], fetched: string[] = []): PlatformHistories {
  const histories = new PlatformHistories();
  histories.register({
    platform: "test",
    recent: async (_context, query: HistoryQuery) => {
      if (query.after != null) {
        const at = lines.findIndex((m) => m.id.id === query.after);
        return at < 0 ? [] : lines.slice(at + 1, at + 1 + query.limit);
      }
      const at = lines.findIndex((m) => m.id.id === query.before);
      return at < 0 ? [] : lines.slice(Math.max(0, at - query.limit), at);
    },
    fetch: async (ref: MessageRef) => {
      fetched.push(ref.id);
      return lines.find((m) => m.id.id === ref.id) ?? null;
    },
  });
  return histories;
}

const THREAD = [
  old("h1", "carl", "週末要不要去爬山", 30 * MINUTE),
  old("h2", "dan", "哪一座", 29 * MINUTE),
  old("h3", "bob", "七星山吧", 28 * MINUTE),
  old("h4", "carl", "好啊幾點", 27 * MINUTE),
];

describe("lines around a replied-to message", () => {
  it("shows the parent and its neighbours in block 7 and writes none of them into the transcript", async () => {
    const fetched: string[] = [];
    const rig = await Rig.create({
      config: { history: { reply_context_before: 2, reply_context_after: 1 } },
      provide: (sup) => sup.services.provide("app", PlatformHistoriesKey, history(THREAD, fetched)),
    });
    rig.model.push(says("七星山不錯"));
    rig.say({
      ...mention(C1, "amy", "@她 你覺得這座怎樣"),
      reply_to: { context: C1, id: "h3" },
      referenced: { author: account("bob"), author_name: "bob", text: "七星山吧" },
    });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    const request = rig.model.requests[0];
    const block7 = String(request?.messages.at(-1)?.content);
    expect(block7).toContain("amy 回覆的那則訊息不在你看得到的對話裡");
    expect(block7).toContain("(前文) carl: 週末要不要去爬山");
    expect(block7).toContain("(前文) dan: 哪一座");
    expect(block7).toMatch(/\(2\d 分鐘前,被回覆\) bob: 七星山吧/);
    expect(block7).toContain("(後文) carl: 好啊幾點");
    // The neighbours are block 7's only: the transcript has the reply and its quoted parent.
    const contents = rig.entries(C1).map((e) => e.content);
    expect(contents.some((c) => c.includes("週末要不要去爬山"))).toBe(false);
    expect(contents.some((c) => c.includes("好啊幾點"))).toBe(false);
    expect(textOf(request).split("週末要不要去爬山").length - 1).toBe(1);
    expect(fetched).toContain("h3");
  });

  it("adds nothing when the parent is in the transcript she sees", async () => {
    const rig = await Rig.create({
      mode: "mention-only",
      provide: (sup) => sup.services.provide("app", PlatformHistoriesKey, history(THREAD)),
    });
    const parent = line(C1, "bob", "七星山吧");
    rig.say(parent);
    await until(() => rig.entries(C1).length >= 1, 3_000, "the parent");
    rig.model.push(says("好"));
    rig.say({ ...mention(C1, "amy", "@她 這個呢"), reply_to: parent.id });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    expect(textOf(rig.model.requests[0])).not.toContain("回覆的那則訊息不在你看得到的對話裡");
  });

  it("leaves out people she ignores and adds nothing without a platform history", async () => {
    const ignored: Attitude = {
      person: "p-dan" as Attitude["person"],
      affinity: 0,
      trust: 0,
      familiarity: 0,
      blocked: true,
      label: "陌生人",
      call_name: null,
      display_name: "dan",
    };
    const rig = await Rig.create({
      config: { history: { reply_context_before: 3, reply_context_after: 0 } },
      provide: (sup) => {
        sup.services.provide("app", PlatformHistoriesKey, history(THREAD));
        sup.services.provide("app", SocialSignalsKey, {
          attitude: (a) => (a.id === "dan" ? ignored : null),
        });
      },
    });
    rig.model.push(says("嗯"));
    rig.say({
      ...mention(C1, "amy", "@她 你看"),
      reply_to: { context: C1, id: "h4" },
    });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    const block7 = String(rig.model.requests[0]?.messages.at(-1)?.content);
    expect(block7).toContain("(前文) carl: 週末要不要去爬山");
    expect(block7).toContain("(前文) bob: 七星山吧");
    expect(block7).not.toContain("哪一座");
    expect(block7).toContain("被回覆) carl: 好啊幾點");
    expect(block7).not.toContain("(後文)");

    const bare = await Rig.create();
    bare.model.push(says("嗯"));
    bare.say({
      ...mention(C1, "amy", "@她 你看"),
      reply_to: { context: C1, id: "h4" },
      referenced: { author: account("carl"), author_name: "carl", text: "好啊幾點" },
    });
    await until(() => bare.sink.texts().length === 1, 3_000, "the answer without history");
    expect(textOf(bare.model.requests[0])).not.toContain("回覆的那則訊息不在你看得到的對話裡");
  });

  it("labels how long before the reply the parent was", () => {
    expect(agoLabel(20_000)).toBe("剛剛");
    expect(agoLabel(5 * MINUTE)).toBe("5 分鐘前");
    expect(agoLabel(3 * 60 * MINUTE)).toBe("3 小時前");
    expect(agoLabel(3 * 24 * 60 * MINUTE)).toBe("3 天前");
  });
});
