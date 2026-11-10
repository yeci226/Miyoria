import { describe, expect, it } from "vitest";
import {
  type ActivitySnapshot,
  asPromptBlock,
  assignHandle,
  customEvent,
  DEFAULT_REASONING,
  ephemeralHandlesIn,
  type Goal,
  goalDue,
  type Impulse,
  inputDisposition,
  isEphemeralHandle,
  isImpulseExpired,
  isLive,
  isPromptBlock,
  isSelfInitiated,
  isShortReply,
  isTaskFailureCode,
  isV2Topic,
  isValidHandle,
  type NewInputFacts,
  parseTaskTopic,
  REASONING_PURPOSES,
  reasoningFor,
  relationshipLabel,
  requestResource,
  runningActivity,
  TURN_OUTCOME_TOPIC,
  type TurnOutcomeRecord,
  taskTopic,
  triggerFires,
  V2_TOPIC_PREFIXES,
  V2_TOPICS,
  v2Event,
  v2Payload,
} from "../src/index.js";

const NOW = Date.parse("2026-11-04T12:00:00.000Z");
const voice = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" } as const;
const text = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;

describe("handles", () => {
  it("per-call codes are ephemeral, names are not", () => {
    for (const code of ["u1", "u12", "p3", "g7", " u2 "])
      expect(isEphemeralHandle(code)).toBe(true);
    for (const name of ["Owen", "御坂", "U2", "u", "user1", "u1a", "Owen#2"]) {
      expect(isEphemeralHandle(name)).toBe(false);
    }
  });

  it("finds codes inside persisted text, also next to CJK", () => {
    expect(ephemeralHandlesIn("u7 出現時只給必要的一句")).toEqual(["u7"]);
    expect(ephemeralHandlesIn("代號又洗牌一輪:u1=御坂,u2=Owen,u1 又來")).toEqual(["u1", "u2"]);
    expect(ephemeralHandlesIn("議程 g3 在 p1")).toEqual(["g3", "p1"]);
    expect(ephemeralHandlesIn("Owen 喜歡 U2 和 menu1")).toEqual([]);
  });

  it("assigns the display name, suffixed only on collision", () => {
    const taken = new Set(["Owen", "Owen#2"]);
    expect(assignHandle("御坂", (h) => taken.has(h))).toBe("御坂");
    expect(assignHandle("  Owen ", (h) => taken.has(h))).toBe("Owen#3");
    expect(assignHandle("u1", () => false)).toBe("u1#2");
    expect(assignHandle("", () => false)).toBe("?#2");
    expect(assignHandle("a\nb", () => false)).toBe("a b");
    expect(isValidHandle("Owen#3")).toBe(true);
    expect(isValidHandle("u1")).toBe(false);
    expect(isValidHandle(" Owen")).toBe(false);
  });
});

describe("turn ownership", () => {
  const base: NewInputFacts = {
    phase: "generating",
    voice: false,
    addressesHer: false,
    fromFocus: true,
    text: "那你覺得明天會下雨嗎",
    restarts: 0,
  };

  it("short replies never cancel", () => {
    for (const t of ["對。", "嗯", "哈哈", "哈哈哈哈哈哈", "www", "ok!", "好啊好啊"]) {
      expect(isShortReply(t)).toBe(true);
      expect(inputDisposition({ ...base, text: t })).toBe("background");
    }
    expect(isShortReply("我覺得不錯")).toBe(false);
  });

  it("follows the §3.9 table", () => {
    expect(inputDisposition({ ...base, phase: "debounce" })).toBe("merge");
    expect(inputDisposition(base)).toBe("restart");
    expect(inputDisposition({ ...base, restarts: 1 })).toBe("background");
    expect(inputDisposition({ ...base, fromFocus: false })).toBe("background");
    expect(inputDisposition({ ...base, fromFocus: false, addressesHer: true })).toBe("background");
    expect(inputDisposition({ ...base, voice: true })).toBe("background");
    expect(inputDisposition({ ...base, phase: "speaking" })).toBe("background");
    // Her own turn gives way to someone who addresses her (not to chatter or backchannel).
    const own = { ...base, fromFocus: false, selfStarted: true };
    expect(inputDisposition({ ...own, addressesHer: true })).toBe("restart");
    expect(inputDisposition({ ...own, addressesHer: true, voice: true })).toBe("restart");
    expect(inputDisposition({ ...own, addressesHer: true, text: "嗯" })).toBe("background");
    expect(inputDisposition({ ...own, addressesHer: false })).toBe("background");
    expect(inputDisposition({ ...own, addressesHer: true, phase: "speaking" })).toBe("background");
  });
});

describe("activity", () => {
  const snapshot: ActivitySnapshot = {
    version: 3,
    at: "2026-11-04T12:00:00.000Z",
    presence: { type: "in", channel: voice, since: "2026-11-04T11:00:00.000Z" },
    broadcast: {
      type: "starting",
      guild: "g1",
      golive: true,
      obs: false,
      task: "T1",
      since: "2026-11-04T11:59:00.000Z",
    },
    activity: {
      type: "game",
      target: "minecraft",
      phase: "running",
      task: null,
      failure: null,
      since: "2026-11-04T11:30:00.000Z",
    },
    override: null,
    scene: "遊戲",
  };

  it("helpers read the snapshot", () => {
    expect(isLive(snapshot)).toBe(true);
    expect(runningActivity(snapshot)).toEqual({ type: "game", target: "minecraft" });
    const failed: ActivitySnapshot = {
      ...snapshot,
      activity: {
        type: "game",
        target: "minecraft",
        phase: "failed",
        task: "T2",
        failure: { code: "disconnected", detail: "遊戲斷線", at: snapshot.at },
        since: snapshot.at,
      },
    };
    expect(runningActivity(failed)).toBeNull();
  });

  it("requests lock one resource", () => {
    expect(requestResource({ type: "leave_voice" })).toBe("presence");
    expect(requestResource({ type: "stop_live" })).toBe("broadcast");
    expect(
      requestResource({ type: "start", activity: "game", target: "minecraft", goal: null }),
    ).toBe("activity");
  });

  it("task topics", () => {
    expect(taskTopic("game.minecraft", "done")).toBe("game.minecraft.task.done");
    expect(parseTaskTopic("game.minecraft.task.failed")).toEqual({
      owner: "game.minecraft",
      type: "failed",
    });
    expect(parseTaskTopic("game.minecraft.death")).toBeNull();
    expect(isTaskFailureCode("timeout")).toBe(true);
    expect(isTaskFailureCode("失敗")).toBe(false);
  });
});

describe("arbiter", () => {
  it("only plan and agenda are her own initiative", () => {
    expect(isSelfInitiated("plan")).toBe(true);
    expect(isSelfInitiated("agenda")).toBe(true);
    for (const s of ["song", "game", "followup", "notice", "message"] as const) {
      expect(isSelfInitiated(s)).toBe(false);
    }
  });

  it("impulses expire", () => {
    const impulse = { expires_at: "2026-11-04T12:00:00.000Z" } as Impulse;
    expect(isImpulseExpired(impulse, NOW - 1)).toBe(false);
    expect(isImpulseExpired(impulse, NOW)).toBe(true);
    expect(isImpulseExpired({ expires_at: "nope" } as Impulse, NOW)).toBe(true);
  });
});

describe("affect", () => {
  it("one relationship scale", () => {
    expect(relationshipLabel({ affinity: 39.87, familiarity: 50 })).toBe("朋友");
    expect(relationshipLabel({ affinity: 5, familiarity: 1 })).toBe("陌生人");
    expect(relationshipLabel({ affinity: 80, familiarity: 40 })).toBe("摯友");
    expect(relationshipLabel({ affinity: -60, familiarity: 90 })).toBe("很討厭");
  });
});

describe("goals", () => {
  const goal: Goal = {
    id: "g",
    what: "找 Owen 問報告結果",
    why: "有點想他",
    trigger: { kind: "whenever" },
    steps: [],
    status: "pending",
    expires: "2026-11-05T00:00:00.000Z",
    person: "Owen",
    context: null,
    source: "plan",
    created_at: "2026-11-04T00:00:00.000Z",
    updated_at: "2026-11-04T00:00:00.000Z",
    closed_at: null,
    close_reason: null,
  };
  const probe = { now: NOW, online: (h: string) => h === "Owen", ended: ["game:minecraft"] };

  it("whenever is never due; the others fire on their condition", () => {
    expect(goalDue(goal, probe)).toBe(false);
    expect(triggerFires({ kind: "when_online", person: "Owen" }, probe)).toBe(true);
    expect(triggerFires({ kind: "when_online", person: "御坂" }, probe)).toBe(false);
    expect(triggerFires({ kind: "at", time: "2026-11-04T11:00:00.000Z" }, probe)).toBe(true);
    expect(triggerFires({ kind: "after_activity", activity: "game:minecraft" }, probe)).toBe(true);
    const online = { ...goal, trigger: { kind: "when_online", person: "Owen" } } as const;
    expect(goalDue(online, probe)).toBe(true);
    expect(goalDue({ ...online, expires: "2026-11-04T11:00:00.000Z" }, probe)).toBe(false);
    expect(goalDue({ ...online, status: "done" }, probe)).toBe(false);
  });
});

describe("reasoning", () => {
  it("defaults cover every purpose, the table overrides them", () => {
    for (const p of REASONING_PURPOSES) expect(DEFAULT_REASONING[p]).toBeDefined();
    expect(reasoningFor("chat_text")).toBe("off");
    expect(reasoningFor("plan_daily")).toBe("high");
    expect(reasoningFor("plan", { plan: "low" })).toBe("low");
    expect(reasoningFor("unknown")).toBe("off");
  });
});

describe("prompt blocks", () => {
  it("plain sections are untrusted data", () => {
    const section = { key: "memory", title: "你記得的事", body: "…", order: 10 };
    expect(isPromptBlock(section)).toBe(false);
    expect(asPromptBlock(section)).toMatchObject({ authority: "data", source: "memory" });
  });
});

describe("v2 topics", () => {
  it("custom events with typed payloads", () => {
    const record: TurnOutcomeRecord = {
      turn: "T",
      context: text,
      reason: "addressed",
      outcome: { type: "cancelled", cause: "input", by: "Owen" },
      addressed_by: ["Owen"],
      focus: [{ context: text, id: "m1" }],
      restarts: 1,
      reasoning: "off",
      latency_ms: null,
      at: "2026-11-04T12:00:00.000Z",
    };
    const event = v2Event(TURN_OUTCOME_TOPIC, record);
    expect(JSON.parse(JSON.stringify(event))).toEqual({
      type: "custom",
      data: { topic: "agent.turn.outcome", payload: record },
    });
    expect(v2Payload(event, TURN_OUTCOME_TOPIC)).toEqual(record);
    expect(v2Payload(customEvent("activity.changed", null), "activity.changed")).toBeNull();
    expect(V2_TOPICS.every(isV2Topic)).toBe(true);
    // Every new topic lives under a reserved prefix (agent.* already is).
    for (const topic of V2_TOPICS) {
      const head = topic.split(".")[0] as string;
      expect(head === "agent" || V2_TOPIC_PREFIXES.includes(head)).toBe(true);
    }
  });
});
