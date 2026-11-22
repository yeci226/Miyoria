import { configJsonSchema, placeFields, settingFields } from "@miyoria/runtime/kernel";
import type { ContextKey } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { DelegateConfigSchema, MainLineConfigSchema, WorkConfigSchema } from "../src/config.js";
import {
  AgentConfigSchema,
  activenessFor,
  defaultAgentConfig,
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
    expect(() => parseActiveness("normal")).toThrow("unknown activeness `normal`");
  });

  it("parses_modes", () => {
    expect(parseChannelMode("mention-only")).toBe("mention-only");
    expect(parseChannelMode("Mention_Only")).toBe("mention-only");
    expect(() => parseChannelMode("loud")).toThrow("unknown channel mode `loud`");
    const cfg = AgentConfigSchema.parse({
      debounce_ms: 10,
      channels: { c: "always" },
    });
    expect(cfg.debounce_ms).toBe(10);
    expect(cfg.channels.c).toBe("always");
    expect(cfg.max_debounce_ms).toBe(4000);
    expect(cfg.contributor_timeout_ms).toBe(800);
  });

  it("the_six_output_checks_are_on_by_default", () => {
    expect(defaultAgentConfig().corrections).toEqual({
      leak_screen: true,
      leak_screen_spoken: true,
      thinking_block: true,
      fallback_line: true,
      tag_strip: true,
      self_talk: true,
    });
    const off = AgentConfigSchema.parse({ corrections: { self_talk: false } }).corrections;
    expect(off.self_talk).toBe(false);
    expect(off.leak_screen).toBe(true);
  });

  it("defaults", () => {
    expect(defaultAgentConfig()).toEqual({
      debounce_ms: 800,
      typing_extend_ms: 2500,
      max_debounce_ms: 4000,
      mainline: MainLineConfigSchema.parse({}),
      work: WorkConfigSchema.parse({}),
      delegate: DelegateConfigSchema.parse({}),
      history_limit: 240,
      prompt_history: 30,
      mention_users: true,
      default_mode: null,
      channels: {},
      default_activeness: null,
      activeness: {},
      mode: null,
      activeness_level: null,
      language: null,
      session_usd_per_hour: 1,
      session_tokens_per_hour: 3_000_000,
      respond_to_bots: false,
      reply_ttl_ms: 120_000,
      max_message_chars: 1900,
      reply_reference: true,
      one_caller_per_turn: true,
      typing_refresh_ms: 8000,
      temperature: null,
      max_tokens: null,
      session_idle_ms: 21_600_000,
      contributor_timeout_ms: 800,
      corrections: {
        leak_screen: true,
        leak_screen_spoken: true,
        thinking_block: true,
        fallback_line: true,
        tag_strip: true,
        self_talk: true,
      },
      voice: {
        debounce_ms: 700,
        direct_debounce_ms: 400,
        turn_debounce_ms: 100,
        max_debounce_ms: 2500,
        default_mode: "normal",
        mode: null,
        activeness_level: null,
        question_window_ms: 8000,
        speak_ttl_ms: 30_000,
        text_chat: true,
        text_aside: true,
        text_echo: false,
        text_echo_text: "written",
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
        allowed_hosts: [
          "cdn.discordapp.com",
          "media.discordapp.net",
          "images-ext-1.discordapp.net",
          "images-ext-2.discordapp.net",
        ],
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
        self_chars: 2000,
        mood_style: true,
        save_every: 1,
        saved: 50,
        saved_message_chars: 800,
      },
    });
    expect(() => AgentConfigSchema.parse({ channels: { c: "loud" } })).toThrow();
  });

  it("the_levels_differ_per_room", () => {
    expect(settingFields(configJsonSchema(AgentConfigSchema)).skipped).toEqual([]);
    expect(placeFields(AgentConfigSchema).map((f) => [f.keys.join("."), f.scope])).toEqual([
      ["mode", "room"],
      ["activeness_level", "room"],
      ["language", "room"],
      ["voice.mode", "room"],
      ["voice.activeness_level", "room"],
      ["session_usd_per_hour", "room"],
      ["session_tokens_per_hour", "room"],
    ]);
  });
});
