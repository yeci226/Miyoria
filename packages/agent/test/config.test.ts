import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  AgentConfigSchema,
  activenessFor,
  defaultAgentConfig,
  modeFor,
  parseActiveness,
  parseChannelMode,
  scaleByActiveness,
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

    expect(scaleByActiveness("low", 0.6)).toBeCloseTo(0.3, 6);
    expect(scaleByActiveness("medium", 0.6)).toBeCloseTo(0.6, 6);
    expect(scaleByActiveness("high", 0.8)).toBeCloseTo(1.0, 6);
    expect(parseActiveness("HIGH")).toBe("high");
    expect(() => parseActiveness("loud")).toThrow("unknown activeness `loud`");
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
      debounce_ms: 1500,
      typing_extend_ms: 2500,
      max_debounce_ms: 4000,
      history_after_fold: 10,
      history_limit: 50,
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
      reply_reference: false,
      typing_refresh_ms: 8000,
      tools_enabled: true,
      max_tool_steps: 3,
      tool_timeout_ms: 10_000,
      max_tool_result_chars: 1000,
      temperature: null,
      max_tokens: null,
      session_idle_ms: 21_600_000,
      seed: null,
      contributor_timeout_ms: 800,
      max_context_chars: 4000,
      budget_notice_interval_ms: 3_600_000,
      attention: {
        cooldown_ms: 5000,
        min_cooldown_ms: 2000,
        recent_window: 20,
        max_share_of_recent: null,
        keywords: [],
        gray_low: 0.3,
        gray_high: 0.6,
        direct_probability: 1.0,
        llm_check: true,
        llm_check_timeout_ms: 8000,
        llm_yes_probability: 0.9,
      },
      voice: {
        debounce_ms: 700,
        max_debounce_ms: 2500,
        default_mode: "normal",
        ambient_factor: 0.5,
        cooldown_ms: 20_000,
        min_cooldown_ms: 5000,
        max_share_of_recent: 0.2,
        question_window_ms: 8000,
        interrupt_scale: 0.35,
        gray_low: 0.15,
        llm_check: false,
        speak_ttl_ms: 30_000,
        text_chat: true,
        text_aside: true,
        text_echo: false,
      },
      history: { backfill: 20, reply_chain: 3, timeout_ms: 3000 },
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
    });
    expect(() => AgentConfigSchema.parse({ channels: { c: "loud" } })).toThrow();
  });
});
