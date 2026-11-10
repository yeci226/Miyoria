// TS-specific checks: config defaults (Rust `Default` impls), persisted JSON shapes, manifest.

import { manifestJson } from "@miyoria/kernel";
import { MockProvider } from "@miyoria/llm";
import { describe, expect, it } from "vitest";
import {
  EmbeddingConfigSchema,
  MAINTENANCE_KEY,
  MemoryConfigSchema,
  MemoryModule,
  memoryConfig,
  toFollowup,
  WATERMARK_PREFIX,
} from "../src/index.js";
import { acct, env, envWith, guildCtx, MINUTE, profile, t0 } from "./helpers.js";

describe("shapes", () => {
  it("config defaults match legacy", () => {
    expect(MemoryConfigSchema.parse({})).toEqual({
      consolidate_idle_secs: 300,
      consolidate_every_messages: 40,
      tick_secs: 15,
      max_lines_per_batch: 200,
      retry_secs: 120,
      purpose: "summarizer",
      self_label: "我",
      utc_offset_minutes: 480,
      recall_limit: 8,
      candidate_limit: 32,
      min_score: 0.25,
      min_vector: 0.3,
      weights: { vector: 0.35, text: 0.25, recency: 0.15, importance: 0.15, subject: 0.1 },
      recency_tau_days: 14,
      episode_recency_tau_days: 1.5,
      state_note_hours: 12,
      followup_max_age_hours: 6,
      repeat: { window: 40, allowed: 3, penalty: 0.15, floor: 0.4, similarity: 0.6 },
      guild_scope: "guild",
      allow_global_from_dm: false,
      min_importance: 0.1,
      dedupe: { vector_similarity: 0.9, text_similarity: 0.85, reinforce: 0.1 },
      forgetting: {
        enabled: true,
        interval_hours: 24,
        episode_max_age_days: 30,
        episode_max_importance: 0.3,
        episode_not_accessed_days: 14,
        decay_after_days: 30,
        decay_per_day: 0.98,
        forget_below_confidence: 0.1,
      },
      // V3 §11
      pinned: {
        max_chars: 1200,
        persona_chars: 0,
        rules_chars: 400,
        max_commitments: 4,
        commitment_chars: 80,
        max_people: 6,
        person_chars: 120,
        person_facts: 3,
        cache_secs: 30,
      },
      evidence: { min_overlap: 0.25, max_events: 24, match_window_secs: 10 },
      unknown_origin_factor: 0.8,
    });
    // Nested sections keep their other defaults.
    expect(memoryConfig({ weights: { vector: 1 } }).weights.text).toBe(0.25);
    expect(EmbeddingConfigSchema.parse({})).toEqual({
      provider: "none",
      base_url: "",
      api_key: null,
      model: "",
      dimensions: null,
      timeout_secs: 10,
      batch_size: 32,
    });
    expect(() => MemoryConfigSchema.parse({ guild_scope: "server" })).toThrow();
  });

  it("manifest has the legacy id and dependencies", () => {
    const m = manifestJson(new MemoryModule(profile()).manifest);
    expect([m.id, m.name, m.requires, m.optional]).toEqual([
      "memory",
      "Memory",
      ["llm"],
      ["commands"],
    ]);
    expect(m.config_schema).not.toBeNull();
  });

  it("persists watermarks and maintenance time like legacy", async () => {
    const e = await envWith("fake", memoryConfig(), new MockProvider("sum").reply("{}"), null);
    const ctx = guildCtx("g1", "c1");
    await e.log(ctx, acct("2"), "Owen", "嗨", t0(-MINUTE), false);
    await e.engine.consolidate(ctx, t0());
    const w = await e.setting(`${WATERMARK_PREFIX}discord:g1:c1`);
    expect(w).toEqual({
      context: { platform: "discord", scope: "g1", channel: "c1", kind: "channel" },
      ts: t0(-MINUTE),
      id: expect.stringMatching(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    });
    await e.engine.maintain(t0());
    expect(await e.setting(MAINTENANCE_KEY)).toBe(t0());
  });

  it("followups use the shared shape", async () => {
    const e = await env("fake");
    const id = (
      await e.engine.store(
        {
          kind: "followup",
          scope: { type: "global" },
          subjects: [],
          content: "問問看",
          importance: 0.5,
          confidence: 1,
          source_context: null,
          source: null,
          origin: "experienced",
          due: null,
        },
        t0(),
      )
    ).type;
    expect(id).toBe("inserted");
    const [record] = await e.all();
    if (!record) throw new Error("missing");
    expect(toFollowup(record)).toEqual({
      id: record.id,
      profile: profile(),
      person: null,
      context: null,
      about: "問問看",
      due: t0(),
    });
  });
});
