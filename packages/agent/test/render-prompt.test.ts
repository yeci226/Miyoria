// The whole prompt of a text turn and a voice turn of the main line, as the model receives it,
// with the shipped persona (profiles/deepseek-chan) and every reader a live turn has: her mood,
// what she is doing, the people here, memory, just now, elsewhere, her notebook, the server's
// emoji. `MIYORIA_PROMPT_DUMP=<dir>` writes each to a file, to read the prompt as a whole
// (docs/design/persona-v4.md §7); the checks below hold what the prompt must keep saying once.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ArbiterModule } from "@miyoria/arbiter";
import { FactsModule } from "@miyoria/facts";
import type { ChatProvider, ChatRequest, ChatStream, StreamEvent } from "@miyoria/llm";
import { Profile } from "@miyoria/profile";
import {
  type ActivityManager,
  ActivityManagerKey,
  type AffectState,
  AffectStateKey,
  type ContextKey,
  type JsonValue,
  type LifeLog,
  LifeLogKey,
  type MemoryRetrieval,
  MemoryRetrievalKey,
  type PersonProfiles,
  PersonProfilesKey,
  PipelineKey,
  PromptContributors,
  PromptContributorsKey,
  type RetrievedMemory,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KAOMOJI_LINE } from "../src/lorebook.js";
import { done, Harness, mention, nextTs, stopHarnesses, textDelta, wait } from "./harness.js";

const PROFILE = join(fileURLToPath(new URL("../../..", import.meta.url)), "profiles/deepseek-chan");
const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "聊天室", kind: "channel" };
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "語音", kind: "voice" };

beforeEach(() => {
  vi.useFakeTimers();
  // 14:00 in Taipei.
  vi.setSystemTime(Date.UTC(2026, 10, 10, 6, 0, 0));
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

class Recorder implements ChatProvider {
  readonly name = "recorder";
  readonly requests: ChatRequest[] = [];

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const events: StreamEvent[] = [textDelta("<emo:neutral>嗯。"), done()];
    return (async function* (): ChatStream {
      for (const e of events) yield e;
    })();
  }
}

type Services = Parameters<NonNullable<Parameters<typeof Harness.build>[4]["provide"]>>[0];

/** What a live turn reads, at ordinary sizes; `voice`: she is in the voice channel. */
function provide(services: Services, voice: boolean) {
  services.provide("app", PipelineKey, { pipeline: "v3" as const });
  const now = toTimestamp(Date.now());
  const affect = {
    snapshot: () => ({
      at: now,
      drives: {},
      boredom: 0.2,
      top: [{ name: "joy", intensity: 0.5, cause: "joy", at: now, person: null }],
      mood: { valence: 0.3, arousal: 0.5, energy: 0.6 },
      mood_line: "心情不錯、精神普通",
      shown: {
        from: "joy",
        tag: "smug",
        style: "表面淡定,但話變多,忍不住多分享一點",
        masked: true,
      },
      biases: {},
    }),
    emotions: () => [],
    card: () => null,
    cardByHandle: () => null,
    cards: () => [],
  };
  services.provide("app", AffectStateKey, affect as unknown as AffectState);
  const body = {
    snapshot: () => ({
      version: 1,
      at: now,
      presence: voice ? { type: "in", channel: VOICE, since: now } : { type: "none" },
      broadcast: { type: "off" },
      activity: { type: "idle", since: now },
      override: null,
      scene: null,
    }),
    tasks: () => [],
    task: () => null,
  };
  services.provide("app", ActivityManagerKey, body as unknown as ActivityManager);
  const registry = new PromptContributors();
  const section = (key: string, title: string, text: string, order: number) => ({
    key,
    contribute: async () => [{ key, title, body: text, order }],
  });
  registry.register(
    section("notebook", "你的筆記本", "- 人/阿明:在準備轉職面試\n- 主題/想練的歌", 30),
  );
  registry.register(
    section(
      "just_now",
      "剛才",
      "- 13:20 在 #聊天室 跟阿明聊轉職\n- 13:40 唱完〈小幸運〉,有三個人在聽",
      6,
    ),
  );
  registry.register(section("elsewhere", "別的地方", "語音頻道現在沒有人。", 7));
  registry.register(
    section("server_emoji", "伺服器表情", "這個伺服器的自訂表情和意思。\n- :fanfan: 一碗白飯", 70),
  );
  services.provide("app", PromptContributorsKey, registry);
  const memory: MemoryRetrieval = {
    retrieve: async () => [{ id: "m1", content: "阿明上禮拜說他下週二面試" } as RetrievedMemory],
    format: (memories) => memories.map((m) => `- ${m.content}`).join("\n"),
  };
  services.provide("app", MemoryRetrievalKey, memory);
  const profiles: PersonProfiles = {
    profiles: async () => [],
    render: async () =>
      '<person name="阿明" relation="朋友" level="24" call_as="阿明" impression="很拚但常熬夜" last_seen="昨天晚上"/>\n<person name="小林" relation="認識" level="6"/>',
  };
  services.provide("app", PersonProfilesKey, profiles);
  const life: LifeLog = {
    entries: () => [],
    today: () => [],
    summary: () =>
      "今天到 14:00 你做過的事:\n- 11:30 查了 Minecraft 的新生物\n- 13:40 唱了〈小幸運〉",
  };
  services.provide("app", LifeLogKey, life);
}

async function rig(chat: ChatProvider, voice: boolean): Promise<Harness> {
  const config: JsonValue = {
    attention: { llm_check: false },
    ...(voice ? { voice: { default_mode: "always", cooldown_ms: 0 } } : {}),
  };
  return Harness.build(voice ? "off" : "normal", config, chat, null, {
    profile: await Profile.loadDir(PROFILE),
    provide: (services) => provide(services, voice),
    ...(voice
      ? {
          voiceSink: {
            speaksIn: "Japanese",
            prepare: () => undefined,
            speak: async () => "completed" as const,
          },
        }
      : {}),
    before: [[new FactsModule(null, "p"), null]],
    modules: [[new ArbiterModule("p"), { quiet_start_hour: 0, quiet_end_hour: 0 }]],
  });
}

function render(request: ChatRequest | undefined): string {
  const parts = (request?.messages ?? []).map((m, i) => {
    const content =
      typeof m.content === "string"
        ? m.content
        : (m.content ?? []).map((p) => (p.type === "text" ? p.text : `[${p.type}]`)).join("");
    return `===== [${i}] ${m.role} =====\n${content}`;
  });
  const tools = (request?.tools ?? []).map((t) => JSON.stringify(t));
  return `${parts.join("\n\n")}\n\n===== tools (${tools.length}) =====\n${tools.join("\n")}\n`;
}

function dump(name: string, text: string): void {
  const dir = process.env.MIYORIA_PROMPT_DUMP;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), text);
}

const systemText = (request: ChatRequest | undefined) =>
  (request?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => String(m.content))
    .join("\n");

describe("the whole prompt of the shipped persona", () => {
  it("a text turn", async () => {
    const llm = new Recorder();
    const h = await rig(llm, false);
    const lines: [string, string][] = [
      ["阿明", "下午好無聊"],
      ["小林", "我剛把 Rust 的 borrow checker 搞懂一半"],
      ["阿明", "一半是哪一半 www"],
    ];
    for (const [who, line] of lines) {
      h.say({ ...mention(TEXT, who, line), mentions_self: false });
      await wait(10);
    }
    h.say(mention(TEXT, "阿明", "DS醬 明天面試好緊張,你覺得我該準備什麼"));
    await wait(3000);
    const request = llm.requests[0];
    dump("text-turn.txt", render(request));
    expect(request).toBeDefined();
    const system = systemText(request);
    // One place says how long a reply is, and it names no sentence count.
    expect(system).not.toMatch(/[一二三1-3]\s*到\s*[二三四2-4]\s*句/);
    expect(system.split("短、口語").length - 1).toBe(1);
    // Her names are a fact, not a role she plays.
    expect(system).not.toMatch(/演的樣子|角色設定/);
    // Her mood is a state: no way to act it and no tag picked for her in the tail.
    const tail = String(request?.messages.at(-1)?.content);
    expect(tail).not.toContain("外表的樣子");
    // It may remind her to open with a tag, but never names one for her.
    expect(tail).not.toMatch(/<emo:(?!名稱)/);
    // The example dialogues name nobody real.
    expect(JSON.stringify(request?.messages)).not.toContain("Owen");
    // The examples are examples, not data; the data blocks are tags.
    const slow = String(request?.messages[1]?.content);
    expect(slow.startsWith("<examples note=")).toBe(true);
    expect(slow).toContain('<example situation="被餵白飯">\n<chat>星野: ');
    expect(slow).toContain('<data source="people" title="在場的人">\n<person name="阿明"');
    expect(JSON.stringify(request?.messages)).not.toContain("⟦");
    // The tail: her state, the turn's style note with four kaomoji, what she answers last.
    expect(tail).toMatch(
      /^<now>\n[\s\S]*\n<\/now>\n\n<style_note>\n[\s\S]*\n<\/style_note>\n\n<reply_to>\n/,
    );
    expect(tail.endsWith("阿明 問你:DS醬 明天面試好緊張,你覺得我該準備什麼\n</reply_to>")).toBe(
      true,
    );
    const kaomoji = tail.split("\n").find((l) => l.startsWith(KAOMOJI_LINE)) ?? "";
    expect(kaomoji.slice(KAOMOJI_LINE.length).split(" ")).toHaveLength(4);
    // What she answers is said once in the history and once at the end, nowhere else.
    expect(JSON.stringify(request?.messages).split("明天面試好緊張")).toHaveLength(3);

    // The next turn: the fixed front reads the same; what it brings up is only in the tail.
    h.say(mention(TEXT, "阿明", "主人說你最近變胖了"));
    await wait(3000);
    const next = llm.requests[1];
    expect(next?.messages[0]).toEqual(request?.messages[0]);
    expect(next?.messages[1]).toEqual(request?.messages[1]);
    const nextTail = String(next?.messages.at(-1)?.content);
    expect(nextTail).toContain("流線型");
    expect(nextTail).toContain("最怕被扣白飯");
    expect(String(request?.messages.at(-1)?.content)).not.toContain("炸毛");
  });

  it("a voice turn, heard in Japanese", async () => {
    const llm = new Recorder();
    const h = await rig(llm, true);
    h.publish({
      type: "voice_joined",
      data: {
        context: VOICE,
        participants: [
          {
            account: { platform: "discord", id: "amin" },
            display_name: "阿明",
            is_self: false,
            muted: false,
            deafened: false,
          },
        ],
      },
    });
    const at = toTimestamp(nextTs());
    h.publish({
      type: "voice_utterance",
      data: {
        id: "u1",
        context: VOICE,
        speaker: {
          account: { platform: "discord", id: "amin" },
          display_name: "阿明",
          is_bot: false,
        },
        text: "米優你今天在幹嘛",
        language: "zh",
        emotion: null,
        audio_events: [],
        started_at: at,
        ended_at: at,
        asr_ms: 200,
      },
    });
    await wait(3000);
    const request = llm.requests[0];
    dump("voice-turn.txt", render(request));
    expect(request).toBeDefined();
    expect(systemText(request)).toContain("<voice>");
    // The language in Chinese, and the format shown again in the tail.
    expect(systemText(request)).not.toContain("Japanese");
    expect(String(request?.messages.at(-1)?.content)).toContain("<voice>えっ、本当に?</voice>");
    // No kaomoji offered in voice; what she answers comes last.
    const tail = String(request?.messages.at(-1)?.content);
    expect(tail).toContain("<style_note>");
    expect(tail).not.toContain(KAOMOJI_LINE);
    expect(tail.endsWith("阿明(語音) 問你:米優你今天在幹嘛\n</reply_to>")).toBe(true);
    // No example with code in it: it cannot be read aloud.
    expect(JSON.stringify(request?.messages)).not.toContain(".chars()");
  });
});
