import { MockProvider } from "@miyoria/llm";
import { MemorySettingsStore } from "@miyoria/store";
import {
  CONVERSATION_FOLDED_TOPIC,
  type ConversationState,
  ConversationStatesKey,
  KnowledgeKey,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEEDBACK_TOPIC, STATE_PREFIX, stateKey } from "../src/index.js";
import {
  AMY,
  FakeLog,
  HangingProvider,
  HER,
  OWEN,
  request,
  rig,
  stopRigs,
  TEXT,
  VOICE,
  wait,
} from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T12:00:00.000Z"));
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

const FIRST = JSON.stringify({
  recap: "Owen 和 Amy 在聊海豚,Owen 說週三要考數學。",
  notes: { 話題: ["海豚"], 待回答: ["Amy 問我喜不喜歡海豚"], 計畫: { Owen: "週三考數學" } },
  documents: [
    {
      type: "create",
      subject: "Owen",
      kind: "人物卡",
      title: "Owen",
      content: { 最近在忙: "週三考數學" },
      said_by: "Owen",
    },
  ],
  feedback: [{ by: "Amy", tone: "positive", quote: "小鯨好可愛" }],
});

const SECOND = `好的,以下是更新:\n\`\`\`json\n${JSON.stringify({
  recap: "大家聊完海豚,開始聊晚餐。",
  notes: { 話題: ["晚餐"], 計畫: { Owen: "週三考數學" } },
})}\n\`\`\``;

async function lines(r: Awaited<ReturnType<typeof rig>>, n: number, prefix = "") {
  for (let i = 0; i < n; i++) {
    const who = i % 2 === 0 ? [OWEN, "Owen"] : [AMY, "Amy"];
    await r.say(TEXT, who[0] as typeof OWEN, who[1] as string, `${prefix}第 ${i + 1} 句`);
    await wait(100);
  }
}

describe("conversation compaction", () => {
  it("folds every fold_every_messages lines, persists the state and tells memory", async () => {
    const provider = new MockProvider("p").reply(FIRST);
    const r = await rig({ provider });
    await lines(r, 16);
    await wait(6_000);
    expect(provider.requests()).toHaveLength(1);
    const req = provider.requests()[0];
    expect(req?.json_mode).toBe(true);
    const states = r.sup.services.require(ConversationStatesKey);
    const s = states.get(TEXT) as ConversationState;
    expect(s.recap).toContain("海豚");
    expect(s.notes).toEqual({
      話題: ["海豚"],
      待回答: ["Amy 問我喜不喜歡海豚"],
      計畫: { Owen: "週三考數學" },
    });
    expect(s.folded_up_to?.id).toBe(r.log.entries.at(-1)?.id);
    expect(s.lines).toBe(16);
    const saved = await r.store.get("p", stateKey(TEXT));
    expect(saved).toMatchObject({ recap: s.recap, folds: 1 });
    const folded = r.events(CONVERSATION_FOLDED_TOPIC);
    expect(folded[0]?.event).toMatchObject({ data: { payload: { lines: 16, session_lines: 16 } } });
    // Feedback she noticed goes to `reflect`; a document about Owen, attributed to him.
    expect(r.events(FEEDBACK_TOPIC)[0]?.event).toMatchObject({
      data: { payload: { tone: "positive", name: "Amy", person: "p-amy" } },
    });
    const doc = r.sup.services.require(KnowledgeKey).docs({ type: "person", person: "p-owen" })[0];
    expect(doc?.content).toEqual({ 最近在忙: "週三考數學" });
    expect(doc?.sources[""]).toMatchObject({ kind: "said", name: "Owen" });
  });

  it("folds a pause, incrementally: the previous notes and only the new lines", async () => {
    const provider = new MockProvider("p").reply(FIRST).reply(SECOND);
    const r = await rig({ provider });
    await lines(r, 5, "舊");
    await wait(85_000);
    expect(provider.requests()).toHaveLength(0);
    await wait(10_000);
    expect(provider.requests()).toHaveLength(1);
    await lines(r, 4, "新");
    await wait(100_000);
    expect(provider.requests()).toHaveLength(2);
    const data = provider.requests()[1]?.messages[1]?.content as string;
    expect(data).toContain("你之前的筆記");
    expect(data).toContain("Owen 和 Amy 在聊海豚");
    expect(data).toContain("新第 1 句");
    expect(data).not.toContain("舊第 1 句");
    // Untrusted data stays out of the system role.
    const system = provider.requests()[1]?.messages[0]?.content as string;
    expect(system).not.toContain("海豚");
    const s = r.sup.services.require(ConversationStatesKey).get(TEXT);
    expect(s?.recap).toBe("大家聊完海豚,開始聊晚餐。");
    expect(s?.folds).toBe(2);
    expect(s?.lines).toBe(9);
  });

  it("keeps the state across restarts and shows it to turns as data", async () => {
    const store = new MemorySettingsStore();
    const log = new FakeLog();
    const provider = new MockProvider("p").reply(FIRST);
    const r = await rig({ provider, store, log });
    await lines(r, 16);
    await wait(6_000);
    await r.sup.restart("conversation");
    const s = r.sup.services.require(ConversationStatesKey).get(TEXT);
    expect(s?.recap).toContain("海豚");
    const body = await r.contribute("conversation", request(TEXT));
    expect(body).toContain("前情提要:Owen 和 Amy 在聊海豚");
    expect(body).toContain("- 計畫:\n  - Owen: 週三考數學");
    // Nothing new since the fold: a restart does not fold again.
    await wait(200_000);
    expect(provider.requests()).toHaveLength(1);
    expect([...(await store.list("p", STATE_PREFIX)).keys()]).toEqual([stateKey(TEXT)]);
  });

  it("hides threads of her notes nobody touched for stale_thread_mins from turns", async () => {
    // The second fold keeps the open question and the plan as they were: nobody touched them.
    const kept = JSON.stringify({
      recap: "大家聊完海豚,開始聊晚餐。",
      notes: { 話題: ["晚餐"], 待回答: ["Amy 問我喜不喜歡海豚"], 計畫: { Owen: "週三考數學" } },
    });
    const provider = new MockProvider("p").reply(FIRST).reply(kept);
    const r = await rig({ provider });
    await lines(r, 16);
    await wait(6_000);
    expect(await r.contribute("conversation", request(TEXT))).toContain("Amy 問我喜不喜歡海豚");
    await wait(20 * 60_000);
    await lines(r, 16, "晚餐");
    await wait(6_000);
    expect(provider.requests()).toHaveLength(2);
    await wait(10 * 60_000);
    // 30 minutes after it last changed: stale, so turns no longer resurface it.
    const body = await r.contribute("conversation", request(TEXT));
    expect(body).toContain("- 話題: 晚餐");
    expect(body).not.toContain("Amy 問我喜不喜歡海豚");
    expect(body).not.toContain("週三考數學");
    // The state itself keeps it; the next fold is asked to drop it if it is over.
    const s = r.sup.services.require(ConversationStatesKey).get(TEXT);
    expect(s?.notes.待回答).toEqual(["Amy 問我喜不喜歡海豚"]);
    await lines(r, 16, "又");
    await wait(6_000);
    const data = provider.requests()[2]?.messages[1]?.content as string;
    expect(data).toContain("超過 30 分鐘沒人提的部分");
    expect(data.split("超過 30 分鐘沒人提的部分")[1]).toContain("Amy 問我喜不喜歡海豚");
    expect(data.split("超過 30 分鐘沒人提的部分")[1]).not.toContain("晚餐");
  });

  it("never sits on the voice hot path: turns read the state while a fold is running", async () => {
    const hanging = new HangingProvider();
    const store = new MemorySettingsStore();
    await store.set("p", stateKey(VOICE), {
      context: { ...VOICE },
      updated_at: "2026-11-02T11:00:00.000Z",
      folded_up_to: null,
      folds: 1,
      lines: 10,
      recap: "大家在語音裡聊 Minecraft。",
      notes: { 話題: "Minecraft" },
    });
    const r = await rig({ provider: hanging, store });
    for (let i = 0; i < 16; i++) await r.say(VOICE, OWEN, "Owen", `語音第 ${i} 句`);
    await wait(6_000);
    expect(hanging.calls).toBe(1); // folding, never finishing
    const started = performance.now();
    const body = await r.contribute("conversation", request(VOICE));
    expect(body).toContain("大家在語音裡聊 Minecraft");
    expect(performance.now() - started).toBeLessThan(50);
  });

  it("changes nothing when the reply is unusable after one repair", async () => {
    const provider = new MockProvider("p").reply("我不想整理").reply('{"recap": ""}');
    const r = await rig({ provider });
    await lines(r, 16);
    await wait(6_000);
    expect(provider.requests()).toHaveLength(2);
    expect(provider.requests()[1]?.messages.at(-1)?.content).toContain("不能用");
    expect(r.sup.services.require(ConversationStatesKey).get(TEXT)).toBeNull();
    expect(r.events(CONVERSATION_FOLDED_TOPIC)).toHaveLength(0);
  });

  it("is capped: no more than max_calls_per_hour folds", async () => {
    const provider = new MockProvider("p").reply(FIRST);
    const r = await rig({
      provider,
      conversation: { max_calls_per_hour: 1, fold_every_messages: 4, min_interval_secs: 0 },
    });
    await lines(r, 4);
    await wait(6_000);
    await lines(r, 4);
    await wait(6_000);
    expect(provider.requests()).toHaveLength(1);
    expect(HER.id).toBe("999");
  });
});
