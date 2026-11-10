import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { MainLineConfigSchema, WorkConfigSchema } from "../src/config.js";
import {
  AgentConfigSchema,
  activenessFor,
  defaultAgentConfig,
  deprecatedAgentKeys,
  modeFor,
  parseActiveness,
  parseChannelMode,
} from "../src/index.js";

const ctx: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };

describe("config", () => {
  it("mode_resolution_order", () => {
    const cfg = defaultAgentConfig();
    expect(modeFor(cfg, ctx, "normal")).toBe("normal");
    cfg.default_mode = "mention-only";
    expect(modeFor(cfg, ctx, "normal")).toBe("mention-only");
    cfg.channels.c1 = "always";
    expect(modeFor(cfg, ctx, "normal")).toBe("always");
    cfg.channels["discord:g1"] = "off";
    expect(modeFor(cfg, ctx, "normal")).toBe("off");
    cfg.channels["discord:g1:c1"] = "normal";
    expect(modeFor(cfg, ctx, "off")).toBe("normal");
  });

  it("voice_contexts_have_their_own_default_mode", () => {
    const voice: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
    const cfg = AgentConfigSchema.parse({ default_mode: "always" });
    expect(modeFor(cfg, voice, "off")).toBe("normal");
    cfg.voice.default_mode = "mention-only";
    expect(modeFor(cfg, voice, "off")).toBe("mention-only");
    cfg.channels.v1 = "off";
    expect(modeFor(cfg, voice, "always")).toBe("off");

    const parsed = AgentConfigSchema.parse({
      voice: { debounce_ms: 500, default_mode: "mention-only" },
    });
    expect(parsed.voice.debounce_ms).toBe(500);
    expect(parsed.voice.max_debounce_ms).toBe(2500);
    expect(parsed.voice.default_mode).toBe("mention-only");
  });

  it("activeness_resolution_and_scaling", () => {
    const cfg = defaultAgentConfig();
    expect(activenessFor(cfg, ctx, "low")).toBe("low");
    cfg.default_activeness = "medium";
    expect(activenessFor(cfg, ctx, "low")).toBe("medium");
    cfg.activeness["discord:g1"] = "high";
    expect(activenessFor(cfg, ctx, "low")).toBe("high");

    expect(parseActiveness("HIGH")).toBe("high");
    expect(() => parseActiveness("loud")).toThrow("unknown activeness `loud`");
  });

  it("old attention cooldowns and multipliers still load, flagged as deprecated", () => {
    const raw = {
      attention: { cooldown_ms: 5000, min_cooldown_ms: 2000, talk_floor: 0.2 },
      voice: { ambient_factor: 0.5, cooldown_ms: 20_000, interrupt_scale: 0.35, debounce_ms: 600 },
    };
    const parsed = AgentConfigSchema.parse(raw);
    expect(parsed.attention.talk_floor).toBe(0.2);
    expect(parsed.voice.debounce_ms).toBe(600);
    expect("cooldown_ms" in parsed.attention).toBe(false);
    expect(deprecatedAgentKeys(raw)).toEqual([
      "attention.cooldown_ms",
      "attention.min_cooldown_ms",
      "voice.ambient_factor",
      "voice.cooldown_ms",
      "voice.interrupt_scale",
    ]);
    expect(deprecatedAgentKeys({ attention: { talk_floor: 0.1 } })).toEqual([]);
    expect(deprecatedAgentKeys(null)).toEqual([]);
  });

  it("parses_modes", () => {
    expect(parseChannelMode("mention-only")).toBe("mention-only");
    expect(parseChannelMode("Mention_Only")).toBe("mention-only");
    expect(() => parseChannelMode("loud")).toThrow("unknown channel mode `loud`");
    const cfg = AgentConfigSchema.parse({
      debounce_ms: 10,
      channels: { c: "always" },
      attention: { llm_check: false },
    });
    expect(cfg.debounce_ms).toBe(10);
    expect(cfg.channels.c).toBe("always");
    expect(cfg.attention.llm_check).toBe(false);
    expect(cfg.max_debounce_ms).toBe(4000);
    expect(cfg.tools_enabled).toBe(true);
    expect(cfg.max_tool_steps).toBe(3);
    expect(cfg.contributor_timeout_ms).toBe(800);
    expect(cfg.max_context_chars).toBe(4000);
    expect(cfg.budget_notice_interval_ms).toBe(3_600_000);
  });

  it("defaults", () => {
    expect(defaultAgentConfig()).toEqual({
      debounce_ms: 800,
      typing_extend_ms: 2500,
      max_debounce_ms: 4000,
      history_after_fold: 25,
      mainline: MainLineConfigSchema.parse({}),
      work: WorkConfigSchema.parse({}),
      history_limit: 240,
      prompt_history: 30,
      max_prompt_chars: 16_000,
      max_entry_chars: 2000,
      time_gap_ms: 1_800_000,
      mention_users: true,
      default_mode: null,
      channels: {},
      default_activeness: null,
      activeness: {},
      respond_to_bots: false,
      reply_ttl_ms: 120_000,
      max_message_chars: 1900,
      reply_reference: true,
      typing_refresh_ms: 8000,
      tools_enabled: true,
      max_tool_steps: 3,
      tool_timeout_ms: 10_000,
      max_tool_result_chars: 12_500,
      temperature: null,
      max_tokens: null,
      session_idle_ms: 21_600_000,
      seed: null,
      contributor_timeout_ms: 800,
      max_context_chars: 4000,
      budget_notice_interval_ms: 3_600_000,
      corrections: {
        tool_text_reask: true,
        promise_commit: true,
        claims: true,
        leak_screen: true,
        self_talk: true,
        prohibition_write: true,
      },
      attention: {
        recent_window: 20,
        max_share_of_recent: null,
        keywords: [],
        gray_low: 0.3,
        gray_high: 0.6,
        direct_probability: 1.0,
        llm_check: true,
        llm_check_timeout_ms: 8000,
        llm_yes_probability: 0.9,
        talk_floor: 0.15,
      },
      voice: {
        debounce_ms: 700,
        direct_debounce_ms: 400,
        turn_debounce_ms: 100,
        max_debounce_ms: 2500,
        default_mode: "normal",
        max_share_of_recent: 0.2,
        question_window_ms: 8000,
        gray_low: 0.15,
        llm_check: false,
        speak_ttl_ms: 30_000,
        voice_first: true,
        text_chat: true,
        text_aside: true,
        text_echo: false,
        keep_in_voice: true,
        debounce_from_speech_end: true,
        speculate: true,
        speculate_max_per_min: 4,
        warm_context: true,
        warm_contributors: ["notebook", "just_now", "elsewhere"],
        warm_max_age_ms: 120_000,
        live_context_ms: 400,
      },
      history: {
        backfill: 20,
        reply_chain: 3,
        reply_context_before: 5,
        reply_context_after: 3,
        timeout_ms: 3000,
      },
      files: { enabled: true, max_files: 2 },
      vision: {
        enabled: true,
        max_images: 3,
        max_image_bytes: 5_000_000,
        max_total_bytes: 10_000_000,
        same_author_window_ms: 120_000,
        detail: "auto",
        download_timeout_ms: 5000,
        allowed_hosts: ["cdn.discordapp.com", "media.discordapp.net"],
        cache_entries: 32,
      },
      prompt: {
        budgets: {
          conversation: 900,
          memory: 1000,
          knowledge: 700,
          lessons: 500,
          world: 500,
          game: 700,
          sing: 400,
          people: 800,
          examples: 2500,
        },
        default_budget: 600,
        self_chars: 1600,
        save_every: 1,
        saved: 50,
        saved_message_chars: 800,
      },
    });
    expect(() => AgentConfigSchema.parse({ channels: { c: "loud" } })).toThrow();
  });
});
