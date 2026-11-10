// `/api/knowledge*`, `/api/reflection`, `/api/mind/digests`: what she organized and learned.

import { Supervisor, SupervisorKey } from "@miyoria/kernel";
import {
  DOC_PREFIX,
  FEEDBACK_PREFIX,
  KnowledgeStore,
  knowledgeConfig,
  LESSON_PREFIX,
  REFLECT_STATE_KEY,
  RUN_PREFIX,
  STATE_PREFIX,
} from "@miyoria/learning";
import { DIGEST_PREFIX, GOAL_MIGRATION_KEY, GOAL_PREFIX, PLAN_STATE_KEY } from "@miyoria/mind";
import { DATA_CATEGORIES, MemorySettingsStore } from "@miyoria/store";
import {
  type ConversationState,
  ConversationStatesKey,
  KnowledgeKey,
  type Mind,
  MindKey,
  ReflectionKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiClient, ApiModule } from "../src/index.js";
import { statusOf } from "./support/http.js";

const TOKEN = "test-token";
const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
});

const CONV: ConversationState = {
  context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
  updated_at: "2026-11-02T12:00:00.000Z",
  folded_up_to: { id: "01JC0000000000000000000009", ts: "2026-11-02T12:00:00.000Z" },
  folds: 2,
  lines: 30,
  recap: "大家在聊海豚。",
  notes: { 話題: ["海豚"] },
};

async function harness(provide: (sup: Supervisor) => void) {
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  provide(sup);
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  return new ApiClient(base, TOKEN);
}

describe("learning routes", () => {
  it("are 503 while their modules are stopped", async () => {
    const client = await harness(() => {});
    expect(await statusOf(client.knowledge())).toBe(503);
    expect(await statusOf(client.conversationNotes())).toBe(503);
    expect(await statusOf(client.reflection())).toBe(503);
    expect(await statusOf(client.digests())).toBe(503);
  });

  it("serve her documents, conversation notes, reflections and digests", async () => {
    const kb = new KnowledgeStore(new MemorySettingsStore(), "p", knowledgeConfig());
    await kb.apply(
      {
        type: "create",
        subject: { type: "topic", name: "大家的生日" },
        kind: "清單",
        title: "生日",
        content: { Owen: "3/14" },
        why: "",
      },
      { kind: "self", account: null, person: null, name: null, context: null },
    );
    const mind: Mind = {
      accepting: true,
      suggest: () => true,
      thoughts: () => [],
      digests: () => [
        {
          id: "d1",
          from: "2026-11-01T00:00:00.000Z",
          to: "2026-11-01T12:00:00.000Z",
          count: 50,
          summary: "那時一直在想 Owen 的考試。",
          intents: { "chat.start:done": 3 },
          by: "summarizer",
        },
      ],
      stats: () => ({
        calls_last_hour: 0,
        max_calls_per_hour: 12,
        calls_total: 0,
        tokens_total: 0,
        last_at: null,
        next_heartbeat_at: null,
        idle_reason: null,
      }),
    };
    const client = await harness((sup) => {
      sup.services.provide("app", KnowledgeKey, kb);
      sup.services.provide("app", ConversationStatesKey, { get: () => CONV, list: () => [CONV] });
      sup.services.provide("app", MindKey, mind);
      sup.services.provide("app", ReflectionKey, {
        runs: () => [],
        feedback: () => [],
        stats: () => ({
          calls_today: 1,
          max_calls_per_day: 6,
          last_daily_at: null,
          last_light_at: null,
          idle_reason: null,
        }),
      });
    });
    const k = await client.knowledge();
    expect(k.documents).toHaveLength(1);
    expect(k.documents[0]).toMatchObject({
      kind: "清單",
      subject_label: "大家的生日",
      content: { Owen: "3/14" },
    });
    expect(k.documents[0]?.short_id).toMatch(/^#[0-9a-z]{6}$/);
    expect((await client.conversationNotes())[0]).toMatchObject({
      recap: "大家在聊海豚。",
      label: null,
    });
    expect((await client.reflection()).stats.calls_today).toBe(1);
    expect((await client.digests())[0]?.summary).toContain("Owen");
  });

  it("are all covered by the data categories, whatever their shape", () => {
    const names = DATA_CATEGORIES.flatMap((c) => c.parts).flatMap((p) =>
      p.kind === "settings" && p.profile === "active" ? [...p.keys, ...p.prefixes] : [],
    );
    for (const name of [
      DOC_PREFIX,
      STATE_PREFIX,
      LESSON_PREFIX,
      RUN_PREFIX,
      REFLECT_STATE_KEY,
      FEEDBACK_PREFIX,
      DIGEST_PREFIX,
      GOAL_PREFIX,
    ]) {
      expect(names, name).toContain(name);
    }
    // Her plan state and the agenda migration record live under one prefix.
    for (const key of [GOAL_MIGRATION_KEY, PLAN_STATE_KEY]) {
      expect(
        names.some((n) => key.startsWith(n)),
        key,
      ).toBe(true);
    }
  });
});
