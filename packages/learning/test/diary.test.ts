import type { ExecContext } from "@miyoria/actions";
import type { LlmRouter } from "@miyoria/llm";
import type { SettingsStore } from "@miyoria/store";
import {
  type ContextKey,
  type OutgoingMessage,
  type PlatformSink,
  PlatformSinks,
  Principals,
  type ReflectionRun,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { reflectConfig } from "../src/config.js";
import { Diary, diaryCapability, diaryMaterial, diaryRules, fitEntry } from "../src/diary.js";

const run = (over: Partial<ReflectionRun> = {}): ReflectionRun => ({
  id: "r1",
  at: "2026-11-10T21:00:00.000Z",
  kind: "daily",
  context: null,
  summary: "今天陪大家唱了三首歌,晚上有人來討飯。",
  insights: 0,
  superseded: 0,
  lessons: ["別一直重複同一個梗"],
  goals: [],
  documents: [],
  feelings: ["開心"],
  error: null,
  tokens: null,
  ms: 0,
  ...over,
});

function sinkThatRecords(): { sinks: PlatformSinks; sent: [ContextKey, OutgoingMessage][] } {
  const sent: [ContextKey, OutgoingMessage][] = [];
  const sink = {
    platform: "discord",
    send: async (context: ContextKey, message: OutgoingMessage) => {
      sent.push([context, message]);
      return { context, id: "1" };
    },
  } as unknown as PlatformSink;
  const sinks = new PlatformSinks();
  sinks.register(sink);
  return { sinks, sent };
}

function routerSaying(text: string, asked: string[] = []): LlmRouter {
  return {
    complete: async (_purpose: string, request: { messages: { content: unknown }[] }) => {
      asked.push(String(request.messages[1]?.content ?? ""));
      return { text, reasoning: "", tool_calls: [], finish_reason: "stop", usage: null };
    },
  } as unknown as LlmRouter;
}

describe("diary", () => {
  it("is_off_without_a_channel", async () => {
    const { sinks, sent } = sinkThatRecords();
    const diary = new Diary(reflectConfig().diary, {
      router: () => routerSaying("日記"),
      sinks: () => sinks,
      persona: () => "",
      name: "Miyo",
    });
    expect(diary.where()).toBeNull();
    expect(await diary.write(run())).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("posts_the_daily_entry_once_a_day_with_its_heading", async () => {
    const { sinks, sent } = sinkThatRecords();
    const asked: string[] = [];
    const cfg = reflectConfig({
      diary: { channel: "discord:1:2", heading: "📔 今天的日記" },
    }).diary;
    const diary = new Diary(cfg, {
      router: () => routerSaying("「今天唱了好多歌,好累但好開心。」", asked),
      sinks: () => sinks,
      persona: () => "",
      name: "Miyo",
    });
    const text = await diary.write(run());
    expect(text).toBe("📔 今天的日記\n今天唱了好多歌,好累但好開心。");
    expect(sent[0]?.[0]).toEqual({
      platform: "discord",
      scope: "1",
      channel: "2",
      kind: "channel",
    });
    expect(sent[0]?.[1]).toMatchObject({ reply_to: null, proactive: true });
    expect(asked[0]).toContain("今天陪大家唱了三首歌");
    expect(await diary.write(run({ id: "r2" }))).toBeNull();
    expect(await diary.write(run({ kind: "light", at: "2026-11-11T21:00:00.000Z" }))).toBeNull();
    expect(await diary.write(run({ error: "x", at: "2026-11-12T21:00:00.000Z" }))).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it("is_something_she_chooses_to_do_once_per_reflection", async () => {
    const { sinks, sent } = sinkThatRecords();
    const saved = new Map<string, unknown>();
    const store = {
      get: async (_p: string, key: string) => saved.get(key) ?? null,
      set: async (_p: string, key: string, value: unknown) => {
        saved.set(key, value);
      },
    } as unknown as SettingsStore;
    const deps = {
      router: () => routerSaying("今天唱了好多歌。"),
      sinks: () => sinks,
      persona: () => "",
      name: "Miyo",
      store,
      profile: "p",
    };
    const cfg = reflectConfig({ diary: { channel: "discord:1:2" } }).diary;
    const diary = new Diary(cfg, deps);
    // Newest first, as `Reflector.runs` gives them; a light one is no material.
    let runs: ReflectionRun[] = [
      run({ id: "r3", kind: "light", at: "2026-11-11T22:00:00.000Z" }),
      run({ id: "r2", at: "2026-11-11T21:00:00.000Z" }),
      run({ id: "r1" }),
    ];
    // The id the "diary" row of her activity table waits for (packages/mind life/activities.ts).
    const cap = diaryCapability(diary, () => runs);
    expect(cap.name).toBe("diary.write");
    expect(cap.tool?.name).toBe("diary_write");
    const principal = Principals.self(null);
    expect(cap.check?.({}, principal)).toBeNull();
    const ctx = { signal: new AbortController().signal } as unknown as ExecContext;
    expect(await cap.execute({}, ctx)).toMatchObject({ data: { day: "2026-11-11" } });
    expect(sent).toHaveLength(1);
    // Written: refused before the gate lets it through, so a try is not counted as written.
    expect(cap.check?.({}, principal)).toContain("已經寫過了");
    await expect(cap.execute({}, ctx)).rejects.toThrow();
    // A restart remembers the day.
    const again = new Diary(cfg, deps);
    await again.load();
    expect(again.pending(runs)).toBeNull();
    // The next reflection can be written.
    runs = [run({ id: "r4", at: "2026-11-12T21:00:00.000Z" }), ...runs];
    expect(again.pending(runs)?.id).toBe("r4");
    // No channel: nothing to choose.
    const off = diaryCapability(new Diary(reflectConfig().diary, deps), () => runs);
    expect(off.check?.({}, principal)).toBe("日記頻道沒有設定");
  });

  it("material_rules_and_cutting", () => {
    expect(diaryMaterial(run())).toContain("心情:開心");
    expect(diaryRules(300)).toContain("300 字以內");
    expect(fitEntry("短短的。", 300)).toBe("短短的。");
    const long = `${"今天很好玩。".repeat(10)}然後`;
    const cut = fitEntry(long, 40);
    expect([...cut].length).toBeLessThanOrEqual(40);
    expect(cut.endsWith("。")).toBe(true);
  });
});
