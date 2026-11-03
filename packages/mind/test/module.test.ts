import { LlmRouterKey, MockProvider } from "@miyoria/llm";
import { MemorySettingsStore } from "@miyoria/store";
import {
  ConversationStatesKey,
  customEvent,
  type JsonValue,
  KnowledgeKey,
  LessonsKey,
  SelfStateKey,
  type Thought,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_QUIET_MINUTES, MIN_SELF_TALK, THOUGHT_PREFIX } from "../src/index.js";
import { HER, OWEN, rig, salient, stopRigs, TEXT, VOICE, wait } from "./helpers.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.parse("2026-11-02T12:00:00.000Z")); // 20:00 at UTC+8
});

afterEach(async () => {
  await stopRigs();
  vi.useRealTimers();
});

const TURN = "01JCTURN000000000000000000";

const FULL_REPLY = JSON.stringify({
  thought: "Owen 進語音了耶……主動跑去好像很在意他,就說我剛好路過。",
  feelings: [{ person: "u1", note: "有點在意他", affinity_hint: "+" }],
  drives: { social: -0.1 },
  policy: {
    talkativeness: [{ scope: "p2", level: 0.8, for_min: 30, why: "大家很熱鬧" }],
  },
  agenda: { add: [{ text: "問 Owen 報告的結果", person: "u1" }] },
  intents: [
    { action: "voice.join", place: "p1", person: "u1", why: "想找 Owen", opening: "假裝路過" },
    { action: "speak", place: "p1", why: "x" },
  ],
});

function systemText(provider: MockProvider, n = 0): string {
  const request = provider.requests()[n];
  return (request?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
}

function dataText(provider: MockProvider, n = 0): string {
  const request = provider.requests()[n];
  return (request?.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => m.content)
    .join("\n");
}

describe("mind module", () => {
  it("thinks with reasoning only when [llm.thinking] mind is on", async () => {
    const provider = new MockProvider("p").reply(FULL_REPLY);
    await rig(provider, { thinking: { mind: true } }).then((r) =>
      r.publish(salient("Owen 進了語音頻道「聊天室」")),
    );
    await wait(4000);
    expect(provider.requests()[0]?.thinking).toBe(true);
  });

  it("thinks about a salient change and acts on it, within bounds", async () => {
    const provider = new MockProvider("p").reply(FULL_REPLY);
    const r = await rig(provider);
    r.publish(salient("Owen 進了語音頻道「聊天室」"));
    await wait(2000);
    expect(provider.requests().length, "coalescing").toBe(0);
    await wait(2000);
    expect(provider.requests().length).toBe(1);
    const request = provider.requests()[0];
    expect(request?.json_mode).toBe(true);
    // Not forced on: `[llm.thinking] mind` decides, and this rig sets none.
    expect(request?.thinking).toBe(false);
    expect(request?.model).toBe("mind");
    // Names, the world summary and what happened are data; the system role has none of it.
    for (const derived of ["Owen", "Minecraft", "聊天室", "海豚"]) {
      expect(systemText(provider), derived).not.toContain(derived);
    }
    expect(dataText(provider)).toContain("⟦資料 來源=world");
    expect(dataText(provider)).toContain("Owen 進了語音頻道");
    expect(systemText(provider)).toContain("你是住在深海的鯨魚娘。");

    await wait(100);
    // The intent, resolved against the snapshot; `speak` is not hers to start.
    expect(r.intents.intents).toEqual([
      expect.objectContaining({
        capability: "voice.join",
        args: { channel: "v1", guild: "g1" },
        context: VOICE,
        about: OWEN,
        opening: "假裝路過",
      }),
    ]);
    const self = r.sup.services.require(SelfStateKey);
    expect(self.feeling("person-owen")?.text).toBe("有點在意他");
    expect(r.social.events).toEqual([["person-owen", [["mind", "warm", 0.3]]]]);
    expect(self.talkativeness(TEXT)).toMatchObject({ level: 0.8, scope: "discord:g1:c1" });
    expect(self.agenda().map((a) => [a.text, a.person])).toEqual([
      ["問 Owen 報告的結果", "person-owen"],
    ]);

    const [thought] = r.mind().thoughts();
    expect(thought?.thought).toContain("就說我剛好路過");
    expect(thought?.triggers.map((t) => t.kind)).toEqual(["salient"]);
    expect(thought?.changes).toContain("對 Owen 的感覺");
    expect(thought?.intents.map((i) => [i.capability, i.status, i.detail])).toEqual([
      ["voice.join", "started", "her turn is queued"],
      ["speak", "dropped", "not something she can do"],
    ]);

    // What became of it: the gate decision and what she said in her turn.
    r.publish(
      customEvent("gate.decision", {
        turn: TURN,
        capability: "voice.join",
        allowed: true,
        stage: "rate",
        reason: "within limits",
        at: toTimestamp(Date.now()),
      }),
    );
    r.publish({
      type: "agent_turn_completed",
      data: { turn: TURN, context: VOICE, text: "我只是剛好路過喔。" },
    });
    await wait(10);
    const [after] = r.mind().thoughts();
    expect(after?.intents[0]).toMatchObject({
      status: "done",
      said: "我只是剛好路過喔。",
      turn: TURN,
      decisions: [expect.objectContaining({ capability: "voice.join", allowed: true })],
    });
    // The whole lifecycle of the intent, what she saw and what each part of her reply changed.
    expect(after?.intents[0]?.history?.map((h) => h.status)).toEqual([
      "pending",
      "started",
      "done",
    ]);
    expect(after?.intents[1]?.history).toEqual([
      expect.objectContaining({ status: "dropped", detail: "not something she can do" }),
    ]);
    expect(after?.input?.world).toContain("Minecraft");
    expect(after?.input?.people.map((p) => p.name)).toContain("Owen");
    expect(after?.effects).toMatchObject({
      drives: { social: -0.1 },
      feelings: [{ name: "Owen", note: "有點在意他", hint: "+" }],
      talkativeness: [{ scope: "discord:g1:c1", level: 0.8, minutes: 30 }],
      agenda_added: [{ text: "問 Owen 報告的結果" }],
    });
    expect(after?.attempts).toBe(1);
    // Linked to the call inspector both ways.
    const router = r.sup.services.require(LlmRouterKey);
    expect(after?.calls).toHaveLength(1);
    expect(router.calls.list({ thought: after?.id ?? "" }).items[0]).toMatchObject({
      id: after?.calls?.[0],
      module: "mind",
      label: "thought",
      purpose: "mind",
      status: "ok",
    });
    const published = r.thoughts() as unknown as Thought[];
    expect(published.length).toBeGreaterThanOrEqual(3);
    expect(published.at(-1)?.intents[0]?.said).toBe("我只是剛好路過喔。");
    expect(r.mind().stats()).toMatchObject({ calls_last_hour: 1, calls_total: 1 });
  });

  it("nudges her emotions, her own and toward someone, from her reply", async () => {
    const provider = new MockProvider("p").reply(
      JSON.stringify({
        thought: "Owen 進語音了……才、才沒有很開心。",
        emotions: { joy: 0.3, shy: 0.2 },
        feelings: [{ person: "u1", emotions: { gratitude: 0.25 } }],
      }),
    );
    const r = await rig(provider);
    r.publish(salient("Owen 進了語音頻道「聊天室」"));
    await wait(4100);
    expect(provider.requests().length).toBe(1);
    const self = r.sup.services.require(SelfStateKey);
    const felt = Object.fromEntries(self.emotions(0).map((e) => [e.name, e.intensity]));
    expect(felt.joy).toBeCloseTo(0.3, 2);
    expect(felt.shy).toBeCloseTo(0.2, 2);
    expect(self.heart("person-owen")?.emotions.gratitude).toBeCloseTo(0.25, 2);
    const [thought] = r.mind().thoughts();
    expect(thought?.effects?.emotions).toEqual({ joy: 0.3, shy: 0.2 });
    expect(thought?.changes).toContain("情緒 喜 +0.30、害羞 +0.20");
  });

  it("adapts the heartbeat and keeps to the hourly cap", async () => {
    const provider = new MockProvider("p").reply('{"thought": "沒什麼事。"}');
    const r = await rig(provider, { config: { max_calls_per_hour: 3, min_interval_secs: 30 } });
    await wait(11 * 60_000);
    expect(provider.requests().length).toBe(0);
    await wait(60_000);
    expect(provider.requests().length, "first heartbeat after 12 min").toBe(1);
    expect(
      r
        .mind()
        .thoughts()[0]
        ?.triggers.map((t) => t.kind),
    ).toEqual(["heartbeat"]);
    // Nothing came of it: the next one is 1.5× sparser.
    await wait(17 * 60_000);
    expect(provider.requests().length).toBe(1);
    await wait(60_000);
    expect(provider.requests().length).toBe(2);
    // Lots happening, but at most three thoughts in the hour.
    for (let i = 0; i < 6; i++) {
      r.publish(salient(`事件 ${i}`));
      await wait(40_000);
    }
    expect(provider.requests().length).toBe(3);
    expect(r.mind().stats().calls_last_hour).toBe(3);
  });

  it("does not think while autonomy is paused", async () => {
    const provider = new MockProvider("p").reply('{"thought": "嗯"}');
    const r = await rig(provider);
    await r.registry.setPaused(true);
    expect(r.mind().accepting).toBe(false);
    expect(r.mind().stats().idle_reason).toBe("paused");
    expect(
      r.mind().suggest({
        source: "initiative",
        reason: "greeting",
        context: TEXT,
        hint: "打招呼",
        about: [],
      }),
    ).toBe(false);
    r.publish(salient("Owen 上線了"));
    await wait(30 * 60_000);
    expect(provider.requests().length).toBe(0);
    await r.registry.setPaused(false);
    r.publish(salient("Owen 上線了"));
    await wait(40_000);
    expect(provider.requests().length).toBe(1);
  });

  it("takes initiative's suggestions as reasons to think (followups go on her agenda)", async () => {
    const provider = new MockProvider("p").reply(
      JSON.stringify({
        thought: "對了,要問他考試的事。",
        intents: [{ action: "chat.start", place: "p1", person: "u1", opening: "考得怎樣?" }],
      }),
    );
    const r = await rig(provider);
    const accepted = r.mind().suggest({
      source: "initiative",
      reason: "followup",
      context: TEXT,
      hint: "問他考試考得怎樣",
      about: [OWEN],
    });
    expect(accepted).toBe(true);
    const self = r.sup.services.require(SelfStateKey);
    expect(self.agenda().map((a) => a.text)).toEqual(["問他考試考得怎樣"]);
    await wait(5000);
    expect(dataText(provider)).toContain("可能的契機");
    expect(dataText(provider)).toContain("問他考試考得怎樣(p1 u1)");
    await wait(10);
    expect(r.intents.intents.map((i) => [i.capability, i.context, i.about])).toEqual([
      ["chat.start", TEXT, OWEN],
    ]);
  });

  it("thinks when her voice channel goes quiet after a conversation", async () => {
    const provider = new MockProvider("p").reply('{"thought": "大家怎麼都不說話了。"}');
    const r = await rig(provider);
    const member = (id: string, self: boolean): VoiceParticipant => ({
      account: { platform: "discord", id },
      display_name: id,
      is_self: self,
      muted: false,
      deafened: false,
    });
    r.publish({ type: "platform_ready", data: { platform: "discord", self_account: HER } });
    r.publish({
      type: "voice_joined",
      data: { context: VOICE, participants: [member(OWEN.id, false), member(HER.id, true)] },
    });
    for (let i = 0; i < 3; i++) {
      r.publish({
        type: "voice_utterance",
        data: {
          id: `u${i}`,
          context: VOICE,
          speaker: { account: OWEN, display_name: "Owen", is_bot: false },
          text: "然後呢",
          language: "zh",
          emotion: null,
          audio_events: [],
          started_at: toTimestamp(Date.now()),
          ended_at: toTimestamp(Date.now()),
          asr_ms: 100,
        },
      });
      await wait(5000);
    }
    expect(provider.requests().length).toBe(0);
    await wait(45_000);
    expect(provider.requests().length).toBe(1);
    expect(
      r
        .mind()
        .thoughts()[0]
        ?.triggers.map((t) => [t.kind, t.context]),
    ).toEqual([["voice_quiet", VOICE]]);
  });

  it("falls back to the chat chain and records failures in the journal", async () => {
    const provider = new MockProvider("p").reply("我不想用 JSON");
    const r = await rig(provider, { chatOnly: true });
    r.publish(salient("Owen 上線了"));
    await wait(5000);
    expect(provider.requests()[0]?.model).toBe("chat");
    const [thought] = r.mind().thoughts();
    expect(thought?.error).toContain("no JSON object");
    expect(thought?.intents).toEqual([]);
  });

  it("keeps the quiet she chooses herself above a floor and short", async () => {
    const provider = new MockProvider("p").reply(
      JSON.stringify({
        thought: "整排請勿打擾,那我也躺平",
        policy: {
          talkativeness: [{ scope: "p2", level: 0.05, for_min: 120, why: "躺平" }],
          initiative: { level: 0.01, why: "躺平" },
        },
      }),
    );
    const r = await rig(provider);
    r.publish(salient("頻道安靜下來了"));
    await wait(5000);
    const self = r.sup.services.require(SelfStateKey);
    const talk = self.talkativeness(TEXT);
    expect(talk?.level).toBe(MIN_SELF_TALK);
    expect(Date.parse(talk?.until ?? "") - Date.now()).toBeLessThanOrEqual(
      MAX_QUIET_MINUTES * 60_000,
    );
    expect(self.snapshot().policy.initiative).toBe(MIN_SELF_TALK);
  });

  it("tells her when she has done nothing for several thoughts in a row", async () => {
    const provider = new MockProvider("p");
    for (let i = 0; i < 4; i++) provider.reply('{"thought": "繼續窩著"}');
    const r = await rig(provider, { config: { min_interval_secs: 0 } });
    for (const what of ["a", "b", "c", "d"]) {
      r.publish(salient(what));
      await wait(5000);
    }
    expect(provider.requests().length).toBe(4);
    expect(systemText(provider, 2)).not.toContain("# 你已經發呆一陣子了");
    expect(systemText(provider, 3)).toContain("連續想了 3 次都沒做任何事");
  });

  it("keeps her journal across restarts, the newest `journal_keep`", async () => {
    const store = new MemorySettingsStore();
    const provider = new MockProvider("p").reply('{"thought": "一"}').reply('{"thought": "二"}');
    const r = await rig(provider, {
      store,
      config: { journal_keep: 1, digest_batch: 1, min_interval_secs: 0 },
    });
    r.publish(salient("a"));
    await wait(5000);
    r.publish(salient("b"));
    await wait(5000);
    const keys = [...(await store.list("p", THOUGHT_PREFIX)).keys()];
    expect(keys.length).toBe(1);
    await r.sup.restart("mind");
    expect(
      r
        .mind()
        .thoughts()
        .map((t) => t.thought),
    ).toEqual(["二"]);
    const saved = (await store.list("p", THOUGHT_PREFIX)).values().next().value as JsonValue;
    expect((saved as unknown as Thought).thought).toBe("二");
  });

  it("sees her documents, lessons and the recap, and changes documents as herself", async () => {
    const applied: [unknown, unknown][] = [];
    const reply = JSON.stringify({
      thought: "Owen 好像很喜歡拉麵,記一下。",
      documents: [
        {
          type: "create",
          subject: "u1",
          kind: "人物卡",
          title: "Owen",
          content: { 喜歡: ["拉麵"] },
        },
        { type: "explode", doc: "#x" },
      ],
    });
    const provider = new MockProvider("p").reply(reply);
    const r = await rig(provider, {
      extra: (sup) => {
        sup.services.provide("app", KnowledgeKey, {
          docs: () => [],
          get: () => null,
          render: () => "#abc123 人物卡「Owen」\n  - 喜歡: 拉麵",
          apply: async (change: unknown, writer: unknown) => {
            applied.push([change, writer]);
            return { ok: true, doc: null };
          },
        });
        sup.services.provide("app", LessonsKey, {
          all: () => [],
          applicable: () => [
            {
              id: "l1",
              text: "Owen 講話時不要插嘴",
              person: "person-owen",
              scope: null,
              talk: -0.5,
              created_at: "",
              expires_at: null,
              source: "daily",
            },
          ],
          talkShift: () => -0.1,
        });
        sup.services.provide("app", ConversationStatesKey, {
          get: () => ({
            context: VOICE,
            updated_at: "",
            folded_up_to: null,
            folds: 1,
            lines: 3,
            recap: "大家在聊拉麵",
            notes: {},
          }),
          list: () => [],
        });
      },
    });
    r.publish(salient("Owen 進語音了"));
    await wait(5000);
    const data = dataText(provider);
    expect(data).toContain("你整理的資料");
    expect(data).toContain("#abc123 人物卡「Owen」");
    expect(data).toContain("Owen 講話時不要插嘴");
    expect(data).toContain("大家在聊拉麵");
    expect(systemText(provider)).not.toContain("拉麵");
    expect(applied).toHaveLength(1);
    expect(applied[0]?.[0]).toMatchObject({
      type: "create",
      subject: { type: "person", person: "person-owen" },
    });
    expect(applied[0]?.[1]).toMatchObject({ kind: "self" });
  });

  it("asks once more when her reply has no JSON, then uses the fixed one", async () => {
    const provider = new MockProvider("p")
      .reply("我在想事情……")
      .reply('好:\n```json\n{"thought": "還是想一下好了"}\n```');
    const r = await rig(provider);
    r.publish(salient("Owen 上線了"));
    await wait(5000);
    expect(provider.requests()).toHaveLength(2);
    expect(r.mind().thoughts()[0]?.thought).toBe("還是想一下好了");
  });
});
