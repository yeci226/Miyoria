// What the facts writer reads of a bus envelope, and the rows it stores from one run of published
// events. The writer reads the envelope's own fields (`id`, `at`, `type`, `v`, `source`, `parent`,
// `turn`, `data`), never the old view; the rows below are what it stored before it moved off the
// view, with each observation's `origin.event` checked on its own (it is the one field that
// changed: the bus event's `type`, `v` and `data`).

import { Supervisor } from "@miyoria/runtime/kernel";
import { type LoggedEvent, openStore, type Store } from "@miyoria/store";
import {
  type BusEnvelope,
  type ContextKey,
  Events,
  type JsonValue,
  PlatformSinks,
  PlatformSinksKey,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsModule } from "../src/module.js";

const T0 = Date.UTC(2026, 10, 15, 6);
const TEXT: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };
const OWEN = { platform: "discord", id: "100" };
const HER = { platform: "discord", id: "999" };
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

describe("the envelope fields the facts writer reads", () => {
  it("are the published event and its stamps, for a typed event and a custom one", async () => {
    const supervisor = new Supervisor();
    const sub = supervisor.bus.subscribe(["platform.typing", "stage.error"]);
    const first = supervisor.bus.publish(
      "discord",
      Events.PlatformTyping,
      { context: TEXT, account: OWEN },
      { now: T0 + 7 },
    );
    const second = supervisor.bus.publish(
      "stage",
      Events.StageError,
      { message: "斷線" },
      { now: T0 + 1000, turn: "01JC0000000000000000000000", parent: first.id },
    );
    const read = (env: BusEnvelope | null) =>
      env === null
        ? null
        : JSON.stringify({
            id: env.id,
            at: env.at,
            type: env.type,
            v: env.v,
            source: env.source,
            parent: env.parent,
            turn: env.turn,
            data: env.data,
          });
    expect(read(await sub.recv())).toBe(
      `{"id":"${first.id}","at":"2026-11-15T06:00:00.007Z","type":"platform.typing","v":1,"source":"discord","parent":null,"turn":null,"data":{"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"account":{"platform":"discord","id":"100"}}}`,
    );
    expect(read(await sub.recv())).toBe(
      `{"id":"${second.id}","at":"2026-11-15T06:00:01.000Z","type":"stage.error","v":1,"source":"stage","parent":"${first.id}","turn":"01JC0000000000000000000000","data":{"message":"斷線"}}`,
    );
    sub.close();
  });
});

describe("the rows stored from one run", () => {
  let store: Store;
  let supervisor: Supervisor;

  beforeEach(async () => {
    // Only `Date` is fake: every line's time and id comes from the publishes, the timers run.
    vi.useFakeTimers({ toFake: ["Date"], now: T0 });
    store = await openStore("memory://");
    supervisor = new Supervisor();
    supervisor.services.provide("kernel", PlatformSinksKey, new PlatformSinks());
    await supervisor.register(
      new FactsModule(store, "p", { names: ["米優"] }),
      { flush_ms: 5 } as unknown as JsonValue,
      true,
    );
    await supervisor.startAll();
  });

  afterEach(async () => {
    await supervisor.stopAll();
    await store.close();
    vi.useRealTimers();
  });

  /** Publishes one run of events, one second apart; returns them by name. */
  function publishRun(): Map<string, BusEnvelope> {
    const bus = supervisor.bus;
    const at = (s: number) => ({ now: T0 + s * 1000 });
    const stamp = (s: number) => toTimestamp(T0 + s * 1000);
    const message = (id: string, account: typeof OWEN, text: string) => ({
      id: { context: TEXT, id },
      author: { account, display_name: account === HER ? "Miyoria" : "Owen", is_bot: false },
      text,
      mentions_self: false,
      reply_to_self: false,
      attachments: [],
      ts: stamp(1),
    });
    const sent: [string, BusEnvelope][] = [
      [
        "ready",
        bus.publish(
          "discord",
          Events.PlatformReady,
          { platform: "discord", self_account: HER },
          at(1),
        ),
      ],
      [
        "owen",
        bus.publish("discord", Events.PlatformMessageCreated, message("m1", OWEN, "米優你好"), {
          ...at(2),
          turn: "T1",
        }),
      ],
      [
        "hers",
        bus.publish("discord", Events.PlatformMessageCreated, message("m2", HER, "嗨"), at(3)),
      ],
      [
        "utterance",
        bus.publish(
          "voice.link",
          Events.VoiceUtteranceEvent,
          {
            id: "u1",
            context: VOICE,
            speaker: { account: OWEN, display_name: "Owen", is_bot: false },
            text: "今天好冷",
            language: null,
            emotion: null,
            audio_events: [],
            started_at: stamp(4),
            ended_at: stamp(4),
            asr_ms: 100,
          },
          at(4),
        ),
      ],
      [
        "focus",
        bus.publish(
          "agent",
          Events.AgentTurnFocus,
          {
            turn: "T1",
            context: TEXT,
            reason: "addressed",
            phase: "generating",
            addressed_by: ["Owen"],
            addressed_accounts: [OWEN],
            focus: [{ context: TEXT, id: "m1" }],
            background: [],
            restarts: 0,
            started_at: stamp(5),
            updated_at: stamp(5),
          },
          { ...at(5), turn: "T1" },
        ),
      ],
      [
        "decision",
        bus.publish(
          "agent",
          Events.AgentDecision,
          { turn: "T1", context: TEXT, respond: true, score: 0.9, reasons: ["mention"] },
          { ...at(6), turn: "T1" },
        ),
      ],
      [
        "playback",
        bus.publish(
          "voice",
          Events.VoicePlaybackEvent,
          { context: VOICE, turn: "T1", state: "started", text: "你好呀" },
          { ...at(7), turn: "T1" },
        ),
      ],
      [
        "outcome",
        bus.publish(
          "agent",
          Events.AgentTurnOutcome,
          {
            turn: "T1",
            context: TEXT,
            reason: "addressed",
            outcome: { type: "sent", parts: 1 },
            addressed_by: ["Owen"],
            focus: [{ context: TEXT, id: "m1" }],
            restarts: 0,
            reasoning: null,
            latency_ms: 800,
            at: stamp(8),
          },
          { ...at(8), turn: "T1" },
        ),
      ],
      [
        "session",
        bus.publish(
          "game",
          Events.GameDirectorSession,
          { state: "started", game: "minecraft", game_name: "Minecraft", context: VOICE },
          at(9),
        ),
      ],
      [
        "craft",
        bus.publish(
          "ext.minecraft",
          Events.GameAdapterEvent,
          { type: "craft_finished", data: { item: "stone_pickaxe" } },
          { ...at(10), type: "game.minecraft.craft_finished" },
        ),
      ],
      [
        "task",
        bus.publish(
          "ext.minecraft",
          Events.TaskStarted,
          { type: "started", task: "k1", goal: "挖礦", at: stamp(11) },
          { ...at(11), type: "game.minecraft.task.started" },
        ),
      ],
      [
        "module",
        bus.publish(
          "kernel",
          Events.SystemModuleState,
          { module: "ext.minecraft", state: "failed", reason: "crashed" },
          at(12),
        ),
      ],
      ["stage", bus.publish("stage", Events.StageError, { message: "斷線" }, at(13))],
    ];
    const byName = new Map(sent);
    const utterance = byName.get("utterance");
    // A parent the publisher set: the line's cause when the writer has none of its own.
    byName.set(
      "golive",
      bus.publish(
        "voice.link",
        Events.VoiceGoLive,
        { platform: "discord", guild: "g", state: "failed", error: "x", reason: null },
        { ...at(14), parent: utterance?.id ?? null },
      ),
    );
    byName.set(
      "llm",
      bus.publish(
        "llm",
        Events.LlmCall,
        {
          call_id: "c1",
          log_day: "2026-11-15",
          requested_at: stamp(15),
          purpose: "chat",
          chain: "chat",
          kind: "chat",
          module: "agent",
          label: "reply",
          model: "m:big",
          provider: "m",
          status: "ok",
          error_kind: null,
          finish_reason: "stop",
          reasoning: "off",
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            cached_prompt_tokens: 0,
            reasoning_tokens: null,
          },
          cost_usd: 0.25,
          duration_ms: 900,
          first_token_ms: 200,
          fallbacks: [],
          retries: 0,
          tools: [],
        },
        { ...at(15), turn: "T1" },
      ),
    );
    return byName;
  }

  /** Every row, until two looks in a row find the same number. */
  async function rows(): Promise<LoggedEvent[]> {
    let last = -1;
    for (let i = 0; i < 400; i++) {
      await new Promise((r) => setTimeout(r, 10));
      const found = (await store.events?.query({ limit: 1000, order: "asc" })) ?? [];
      if (found.length === last && found.length > 0) return found;
      last = found.length;
    }
    throw new Error("the rows did not settle");
  }

  /**
   * One line per row, without `seq` (commit order differs between the chat lines and the
   * buffered lines) and with ids named: a published event's by its name, any other id (her lines'
   * own, persons, rooms) by the order it first appears in.
   */
  function named(found: LoggedEvent[], sent: Map<string, BusEnvelope>): string[] {
    const names = new Map<string, string>();
    for (const [name, env] of sent) names.set(env.id, `<${name}>`);
    const sorted = [...found].sort((a, b) => {
      const ka = `${a.envelope.at} ${a.envelope.type} ${a.envelope.source}`;
      const kb = `${b.envelope.at} ${b.envelope.type} ${b.envelope.source}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    const rename = (value: unknown): unknown => {
      if (typeof value === "string" && ULID.test(value)) {
        if (!names.has(value)) names.set(value, `<#${names.size - sent.size + 1}>`);
        return names.get(value);
      }
      if (Array.isArray(value)) return value.map(rename);
      if (value !== null && typeof value === "object") {
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rename(v)]));
      }
      return value;
    };
    return sorted.map((row) => {
      const { seq: _seq, ...envelope } = row.envelope;
      return JSON.stringify(rename({ ...envelope, context: row.context, handle: row.handle }));
    });
  }

  /** Each observation's `origin.event`, by the id of the line, taken out of its row. */
  function origins(found: LoggedEvent[]): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const row of found) {
      const data = row.envelope.data as { origin?: { event?: unknown } | null } | null;
      if (data?.origin === undefined || data.origin === null) continue;
      out.set(row.envelope.id, data.origin.event);
      data.origin.event = "<origin.event>";
    }
    return out;
  }

  it("are the same rows as before, but for each observation's origin.event", async () => {
    const sent = publishRun();
    const found = await rows();
    const events = origins(found);
    // The one change: an observation keeps the bus event's type, version and payload.
    const kept = (name: string) => {
      const env = sent.get(name);
      return env ? events.get(env.id) : undefined;
    };
    const observed = ["owen", "utterance", "session", "craft", "task", "module", "stage", "golive"];
    for (const name of observed) {
      const env = sent.get(name);
      expect(kept(name), name).toEqual({ type: env?.type, v: env?.v, data: env?.data });
    }
    // The kernel's word that the facts module runs, published before the run.
    expect([...events.values()]).toContainEqual({
      type: "system.module.state",
      v: 1,
      data: { module: "facts", state: "running", reason: null },
    });
    expect(events.size).toBe(observed.length + 1);
    expect(named(found, sent)).toMatchInlineSnapshot(`
      [
        "{"id":"<#1>","at":"2026-11-15T06:00:00.000Z","type":"facts.decision","v":1,"parent":"<owen>","turn":"T1","session":"discord:g:c","space_id":"<#2>","room_id":"<#3>","person_id":"<#4>","account_id":null,"key":null,"source":"agent.focus","scope":"room","tier":"short","redacted_at":null,"data":{"turn":"T1","reason":"addressed","addressed_by":["Owen"],"focus":["m1"],"background":[]},"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"handle":"Owen"}",
        "{"id":"<#5>","at":"2026-11-15T06:00:00.000Z","type":"facts.observation.ambient","v":1,"parent":null,"turn":null,"session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":"system:boot","source":"core.lifecycle","scope":"self","tier":"ambient","redacted_at":null,"data":{"observation":{"source":"core.lifecycle","silent":true,"salience":"ambient","attention_key":"system:boot","revision":1,"summary":"核心啟動了","addressed_to_her":false,"from":null,"context":null},"buckets":[{"op":"boot"}],"speech":false,"origin":null,"restoring":null},"context":null,"handle":null}",
        "{"id":"<#6>","at":"2026-11-15T06:00:00.000Z","type":"facts.observation.ambient","v":1,"parent":null,"turn":null,"session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":"system:module:facts","source":"system","scope":"self","tier":"ambient","redacted_at":null,"data":{"observation":{"source":"system","silent":true,"salience":"ambient","attention_key":"system:module:facts","revision":1,"summary":"模組 facts:running","addressed_to_her":false,"from":null,"context":null},"buckets":[],"speech":false,"origin":{"module":"kernel","topic":"system.module.state","event":"<origin.event>","turn":null}},"context":null,"handle":null}",
        "{"id":"<#7>","at":"2026-11-15T06:00:01.000Z","type":"platform.message.created","v":1,"parent":null,"turn":"T1","session":"discord:g:c","space_id":"<#2>","room_id":"<#3>","person_id":"<#4>","account_id":"<#8>","key":"msg:discord:m1","source":"discord","scope":"room","tier":"long","redacted_at":null,"data":{"id":{"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"id":"m1"},"author":{"account":{"platform":"discord","id":"100"},"display_name":"Owen","is_bot":false},"text":"米優你好","mentions_self":false,"reply_to_self":false,"attachments":[],"ts":"2026-11-15T06:00:01.000Z"},"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"handle":"Owen"}",
        "{"id":"<#9>","at":"2026-11-15T06:00:01.000Z","type":"platform.message.created","v":1,"parent":null,"turn":null,"session":"discord:g:c","space_id":"<#2>","room_id":"<#3>","person_id":null,"account_id":null,"key":"msg:discord:m2","source":"discord","scope":"room","tier":"long","redacted_at":null,"data":{"id":{"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"id":"m2"},"author":{"account":{"platform":"discord","id":"999"},"display_name":"Miyoria","is_bot":false},"text":"嗨","mentions_self":false,"reply_to_self":false,"attachments":[],"ts":"2026-11-15T06:00:01.000Z","self":true},"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"handle":null}",
        "{"id":"<owen>","at":"2026-11-15T06:00:02.000Z","type":"facts.observation.said","v":1,"parent":null,"turn":null,"session":"discord:g:c","space_id":"<#2>","room_id":"<#3>","person_id":"<#4>","account_id":"<#8>","key":"msg:discord:m1","source":"platform.discord","scope":"room","tier":"long","redacted_at":null,"data":{"observation":{"source":"platform.discord","silent":false,"salience":"notable","attention_key":"msg:discord:m1","revision":1,"summary":"Owen:米優你好","addressed_to_her":true,"from":"Owen","context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"}},"buckets":[{"op":"append-self","writer":"platform.text","owner":"discord","untrusted":true}],"speech":true,"origin":{"module":"discord","topic":"platform.message.created","event":"<origin.event>","turn":"T1"}},"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"handle":"Owen"}",
        "{"id":"<utterance>","at":"2026-11-15T06:00:04.000Z","type":"facts.observation.said","v":1,"parent":null,"turn":null,"session":"discord:g:voice:v","space_id":"<#2>","room_id":"<#10>","person_id":"<#4>","account_id":"<#8>","key":"voice:utterance:u1","source":"voice.asr","scope":"room","tier":"long","redacted_at":null,"data":{"observation":{"source":"voice.asr","silent":true,"salience":"ambient","attention_key":"voice:utterance:u1","revision":1,"summary":"Owen:今天好冷","addressed_to_her":false,"from":"Owen","context":{"platform":"discord","scope":"g","channel":"v","kind":"voice"}},"buckets":[{"op":"append-self","writer":"voice.asr","owner":"voice.link","untrusted":true}],"speech":true,"origin":{"module":"voice.link","topic":"voice.utterance","event":"<origin.event>","turn":null}},"context":{"platform":"discord","scope":"g","channel":"v","kind":"voice"},"handle":"Owen"}",
        "{"id":"<#11>","at":"2026-11-15T06:00:04.000Z","type":"voice.utterance","v":1,"parent":null,"turn":null,"session":"discord:g:voice:v","space_id":"<#2>","room_id":"<#10>","person_id":"<#4>","account_id":"<#8>","key":"voice:utterance:u1","source":"voice.link","scope":"room","tier":"long","redacted_at":null,"data":{"id":"u1","context":{"platform":"discord","scope":"g","channel":"v","kind":"voice"},"speaker":{"account":{"platform":"discord","id":"100"},"display_name":"Owen","is_bot":false},"text":"今天好冷","language":null,"emotion":null,"audio_events":[],"started_at":"2026-11-15T06:00:04.000Z","ended_at":"2026-11-15T06:00:04.000Z","asr_ms":100},"context":{"platform":"discord","scope":"g","channel":"v","kind":"voice"},"handle":"Owen"}",
        "{"id":"<decision>","at":"2026-11-15T06:00:06.000Z","type":"agent.decision","v":1,"parent":"<#1>","turn":"T1","session":"discord:g:c","space_id":"<#2>","room_id":"<#3>","person_id":"<#4>","account_id":null,"key":null,"source":"agent","scope":"room","tier":"short","redacted_at":null,"data":{"turn":"T1","context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"respond":true,"score":0.9,"reasons":["mention"]},"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"handle":"Owen"}",
        "{"id":"<#12>","at":"2026-11-15T06:00:07.000Z","type":"voice.playback","v":1,"parent":null,"turn":"T1","session":"discord:g:voice:v","space_id":"<#2>","room_id":"<#10>","person_id":null,"account_id":null,"key":null,"source":"voice","scope":"room","tier":"long","redacted_at":null,"data":{"context":{"platform":"discord","scope":"g","channel":"v","kind":"voice"},"turn":"T1","state":"started","text":"你好呀","speaker":{"account":{"platform":"discord","id":"999"},"display_name":"","is_bot":true}},"context":{"platform":"discord","scope":"g","channel":"v","kind":"voice"},"handle":null}",
        "{"id":"<#13>","at":"2026-11-15T06:00:08.000Z","type":"agent.turn.outcome","v":1,"parent":"<decision>","turn":"T1","session":"discord:g:c","space_id":"<#2>","room_id":"<#3>","person_id":"<#4>","account_id":null,"key":null,"source":"agent","scope":"room","tier":"short","redacted_at":null,"data":{"turn":"T1","context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"reason":"addressed","outcome":{"type":"sent","parts":1},"addressed_by":["Owen"],"focus":[{"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"id":"m1"}],"restarts":0,"reasoning":null,"latency_ms":800,"at":"2026-11-15T06:00:08.000Z"},"context":{"platform":"discord","scope":"g","channel":"c","kind":"channel"},"handle":"Owen"}",
        "{"id":"<session>","at":"2026-11-15T06:00:09.000Z","type":"facts.observation","v":1,"parent":null,"turn":null,"session":"discord:g:voice:v","space_id":"<#2>","room_id":"<#10>","person_id":null,"account_id":null,"key":"game:session:minecraft","source":"game.session","scope":"room","tier":"short","redacted_at":null,"data":{"observation":{"source":"game.session","silent":false,"salience":"notable","attention_key":"game:session:minecraft","revision":1,"summary":"正在玩 Minecraft","addressed_to_her":false,"from":null,"context":{"platform":"discord","scope":"g","channel":"v","kind":"voice"}},"buckets":[{"op":"replace-self","writer":"game.session","owner":"game","untrusted":true}],"speech":false,"origin":{"module":"game","topic":"game.director.session","event":"<origin.event>","turn":null}},"context":{"platform":"discord","scope":"g","channel":"v","kind":"voice"},"handle":null}",
        "{"id":"<craft>","at":"2026-11-15T06:00:10.000Z","type":"facts.observation","v":1,"parent":null,"turn":null,"session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":"game:craft:stone_pickaxe","source":"game.minecraft","scope":"self","tier":"short","redacted_at":null,"data":{"observation":{"source":"game.minecraft","silent":false,"salience":"notable","attention_key":"game:craft:stone_pickaxe","revision":1,"summary":"craft_finished","addressed_to_her":false,"from":null,"context":null},"buckets":[{"op":"append-self","writer":"game.minecraft","owner":"ext.minecraft","untrusted":true}],"speech":false,"origin":{"module":"ext.minecraft","topic":"game.minecraft.craft_finished","event":"<origin.event>","turn":null}},"context":null,"handle":null}",
        "{"id":"<task>","at":"2026-11-15T06:00:11.000Z","type":"facts.observation.ambient","v":1,"parent":null,"turn":null,"session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":"task:k1","source":"game.minecraft","scope":"self","tier":"ambient","redacted_at":null,"data":{"observation":{"source":"game.minecraft","silent":true,"salience":"ambient","attention_key":"task:k1","revision":1,"summary":"任務開始:挖礦","addressed_to_her":false,"from":null,"context":null},"buckets":[{"op":"replace-self","writer":"game.minecraft.task","owner":"ext.minecraft","untrusted":true}],"speech":false,"origin":{"module":"ext.minecraft","topic":"game.minecraft.task.started","event":"<origin.event>","turn":null}},"context":null,"handle":null}",
        "{"id":"<module>","at":"2026-11-15T06:00:12.000Z","type":"facts.observation.ambient","v":1,"parent":null,"turn":null,"session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":"system:module:ext.minecraft","source":"system","scope":"self","tier":"ambient","redacted_at":null,"data":{"observation":{"source":"system","silent":true,"salience":"ambient","attention_key":"system:module:ext.minecraft","revision":1,"summary":"模組 ext.minecraft:failed(crashed)","addressed_to_her":false,"from":null,"context":null},"buckets":[{"op":"leave-owner","owner":"ext.minecraft"}],"speech":false,"origin":{"module":"kernel","topic":"system.module.state","event":"<origin.event>","turn":null}},"context":null,"handle":null}",
        "{"id":"<stage>","at":"2026-11-15T06:00:13.000Z","type":"facts.observation","v":1,"parent":null,"turn":null,"session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":"stage:error","source":"stage","scope":"self","tier":"short","redacted_at":null,"data":{"observation":{"source":"stage","silent":false,"salience":"notable","attention_key":"stage:error","revision":1,"summary":"直播機出錯:斷線","addressed_to_her":false,"from":null,"context":null},"buckets":[],"speech":false,"origin":{"module":"stage","topic":"stage.error","event":"<origin.event>","turn":null}},"context":null,"handle":null}",
        "{"id":"<golive>","at":"2026-11-15T06:00:14.000Z","type":"facts.observation","v":1,"parent":"<utterance>","turn":null,"session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":"stream:golive:g","source":"stream","scope":"self","tier":"short","redacted_at":null,"data":{"observation":{"source":"stream","silent":false,"salience":"notable","attention_key":"stream:golive:g","revision":1,"summary":"Go Live:failed","addressed_to_her":false,"from":null,"context":null},"buckets":[{"op":"leave","writer":"stream"}],"speech":false,"origin":{"module":"voice.link","topic":"voice.golive","event":"<origin.event>","turn":null}},"context":null,"handle":null}",
        "{"id":"<llm>","at":"2026-11-15T06:00:15.000Z","type":"llm.call","v":1,"parent":null,"turn":"T1","session":null,"space_id":null,"room_id":null,"person_id":null,"account_id":null,"key":null,"source":"llm","scope":"owner","tier":"short","redacted_at":null,"data":{"call_id":"c1","log_day":"2026-11-15","requested_at":"2026-11-15T06:00:15.000Z","purpose":"chat","chain":"chat","kind":"chat","module":"agent","label":"reply","model":"m:big","provider":"m","status":"ok","error_kind":null,"finish_reason":"stop","reasoning":"off","usage":{"prompt_tokens":10,"completion_tokens":5,"cached_prompt_tokens":0,"reasoning_tokens":null},"cost_usd":0.25,"duration_ms":900,"first_token_ms":200,"fallbacks":[],"retries":0,"tools":[]},"context":null,"handle":null}",
      ]
    `);
  });
});
