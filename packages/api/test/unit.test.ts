// The Rust crate's inline unit tests (session, oauth, people, monitor, panel, client), plus
// TS-specific checks of helpers.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Relationship, RelationshipDelta } from "@miyoria/store";
import {
  type AccountRef,
  BaseAuthorizer,
  type ContextKey,
  newEnvelope,
  newId,
  PlatformSinks,
  type Subject,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { ApiClient, ApiConfigSchema, parseBind, SseParser } from "../src/index.js";
import { ContextLabels, LABEL_MISS_TTL_MS } from "../src/labels.js";
import { Monitor, percentile } from "../src/monitor.js";
import {
  avatarUrl,
  CDN,
  type DiscordUser,
  MAX_PENDING,
  Pending,
  type PendingLogin,
  pkceChallenge,
  STATE_TTL_MS,
  safeNext,
  userName,
  validId,
} from "../src/oauth.js";
import { pickDir } from "../src/panel.js";
import { absoluteHistory } from "../src/people.js";
import {
  checkAccess,
  cookieToken,
  looksLikeToken,
  PANEL_ACCESS,
  PANEL_WRITE,
  randomToken,
  Sessions,
  sha256Hex,
  TOKEN_LEN,
} from "../src/session.js";

// ---- session.rs ---------------------------------------------------------------------------

function account(): AccountRef {
  return { platform: "discord", id: "1" };
}

class Allow extends BaseAuthorizer {
  constructor(
    readonly panel: boolean,
    readonly write: boolean,
  ) {
    super();
  }
  allowsSubject(_: Subject, node: string): boolean {
    if (node === PANEL_ACCESS) return this.panel;
    if (node === PANEL_WRITE) return this.write;
    return false;
  }
}

describe("session", () => {
  it("tokens_are_random_and_hashes_are_hex", () => {
    const a = randomToken(32);
    expect(a).toHaveLength(TOKEN_LEN);
    expect(looksLikeToken(a)).toBe(true);
    expect(a).not.toBe(randomToken(32));
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(looksLikeToken("short")).toBe(false);
    expect(looksLikeToken(`${a.slice(0, 42)}!`)).toBe(false);
  });

  it("parses_the_session_cookie", () => {
    const headers = ["a=b; other=1"];
    expect(cookieToken(headers)).toBeNull();
    headers.push("x=y;  miyoria_session=tok ; z=1");
    expect(cookieToken(headers)).toBe("tok");
  });

  it("expired_sessions_are_gone_and_checks_are_cached", async () => {
    const clock = { now: () => Date.now() };
    const sessions = new Sessions(86_400_000, 60_000, clock);
    const token = await sessions.create(undefined, account(), "A", null, "admin");
    const found = await sessions.lookup(undefined, new Allow(true, false), token);
    expect(found?.access).toEqual({ panel: true, write: false });
    // Cached: a changed authorizer is not consulted until `recheck` passes.
    const again = await sessions.lookup(undefined, new Allow(false, false), token);
    expect(again?.access.panel).toBe(true);

    const expired = new Sessions(-1000, 0, clock);
    const stale = await expired.create(undefined, account(), "A", null, "admin");
    expect(await expired.lookup(undefined, new Allow(true, true), stale)).toBeNull();
    expect(expired.size).toBe(0);
  });

  it("no_authorizer_means_no_access", () => {
    const access = checkAccess(undefined, account());
    expect(access.panel || access.write).toBe(false);
    expect(checkAccess(new Allow(false, true), account()).write).toBe(false);
  });
});

// ---- oauth.rs -----------------------------------------------------------------------------

function login(at: number): PendingLogin {
  return { verifier: "v", next: "/", redirect: new URL("http://127.0.0.1/cb"), at };
}

describe("oauth", () => {
  it("states_expire_and_are_single_use", () => {
    const pending = new Pending();
    const t0 = 1_000_000;
    pending.insert("a", login(t0), t0);
    pending.insert("b", login(t0), t0);
    expect(pending.take("a", t0 + 60_000)).not.toBeNull();
    expect(pending.take("a", t0 + 61_000), "used").toBeNull();
    expect(pending.take("b", t0 + STATE_TTL_MS), "expired").toBeNull();
    expect(pending.take("nope", t0)).toBeNull();
  });

  it("pending_logins_are_capped", () => {
    const pending = new Pending();
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_PENDING + 5; i++) pending.insert(String(i), login(t0 + i), t0 + i);
    expect(pending.map.size).toBe(MAX_PENDING);
    expect(pending.map.has("0"), "the oldest went first").toBe(false);
  });

  it("next_must_be_a_local_path", () => {
    for (const ok of ["/", "/people?q=1", "/card/MYR-AB12-CD34-EF56", "/#/people"])
      expect(safeNext(ok), ok).toBe(ok);
    for (const bad of [
      "",
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "javascript:alert(1)",
      "/a b",
      "/\r\nSet-Cookie:x",
      "/人",
    ]) {
      expect(safeNext(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it("pkce_challenge_matches_rfc_7636", () => {
    // RFC 7636 appendix B.
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("avatar_and_name_fallbacks", () => {
    let user: DiscordUser = {
      id: "80351110224678912",
      username: "nelly",
      global_name: " ",
      avatar: null,
    };
    expect(userName(user)).toBe("nelly");
    expect(avatarUrl(user).startsWith(`${CDN}/embed/avatars/`)).toBe(true);
    // (80351110224678912 >> 22) % 6, computed exactly.
    expect(avatarUrl(user)).toBe(`${CDN}/embed/avatars/${(80351110224678912n >> 22n) % 6n}.png`);
    user = { ...user, avatar: "abc", global_name: "Nelly" };
    expect(userName(user)).toBe("Nelly");
    expect(avatarUrl(user)).toBe(`${CDN}/avatars/80351110224678912/abc.png?size=64`);
    expect(validId("123") && !validId("12a") && !validId("")).toBe(true);
  });
});

// ---- people.rs ----------------------------------------------------------------------------

function delta(affinity: number, reason: string): RelationshipDelta {
  return { at: new Date().toISOString(), affinity, trust: 0, familiarity: 1, reason };
}

function relationship(affinity: number, familiarity: number): Relationship {
  return {
    profile: "p",
    person: newId(),
    affinity,
    trust: 50,
    familiarity,
    tags: [],
    notes: "",
    call_name: null,
    interactions: 2,
    last_interaction: null,
    updated_at: new Date().toISOString(),
  };
}

describe("people", () => {
  it("history_is_absolute_and_oldest_first", () => {
    const history = absoluteHistory([delta(10, "a"), delta(5, "b")], relationship(15, 2));
    expect(history.map((d) => [d.affinity, d.familiarity, d.reason])).toEqual([
      [10, 1, "a"],
      [15, 2, "b"],
    ]);
  });
});

// ---- monitor.rs ---------------------------------------------------------------------------

describe("monitor", () => {
  it("percentiles_use_nearest_rank", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 0.5)).toBe(50);
    expect(percentile(v, 0.95)).toBe(95);
  });

  it("tracks_sessions_speaking_and_latency", () => {
    const m = new Monitor();
    const context: ContextKey = { platform: "discord", scope: "g", channel: "vc", kind: "voice" };
    const me: AccountRef = { platform: "discord", id: "1" };
    const send = (event: Parameters<typeof newEnvelope>[1]) =>
      m.handle(newEnvelope("voice", event));
    send({
      type: "voice_joined",
      data: {
        context,
        participants: [
          { account: me, display_name: "Mika", is_self: false, muted: false, deafened: false },
        ],
      },
    });
    send({ type: "voice_speaking", data: { context, account: me, speaking: true } });
    for (const ms of [100, 300, 200]) {
      send({
        type: "custom",
        data: {
          topic: "voice.latency",
          payload: { stage: "asr", context: { ...context }, asr_ms: ms },
        },
      });
    }
    send({ type: "voice_playback", data: { context, turn: null, state: "started", text: "hi" } });
    expect(m.speaking()).toBe(true);
    const state = m.voice(Date.now());
    expect(state.sessions).toHaveLength(1);
    const s = state.sessions[0];
    expect(s?.speaking).toEqual([me]);
    expect(s?.latency.asr.samples).toBe(3);
    expect(s?.latency.asr.p50_ms).toBe(200);
    expect(s?.latency.tts_first_audio.p50_ms).toBeNull();

    send({ type: "voice_left", data: { context, reason: null } });
    expect(m.speaking()).toBe(false);
    expect(m.voice(Date.now()).sessions).toEqual([]);
    expect(m.voiceContext()).toBeNull();
  });

  it("reads p50 and p90 per end-to-end segment, counting incomplete replies apart", () => {
    const m = new Monitor();
    const context: ContextKey = { platform: "discord", scope: "g", channel: "vc", kind: "voice" };
    m.handle(newEnvelope("voice", { type: "voice_joined", data: { context, participants: [] } }));
    const e2e = (payload: Record<string, unknown>) =>
      m.handle(
        newEnvelope("voice", {
          type: "custom",
          data: {
            topic: "voice.latency",
            payload: { stage: "e2e", context: { ...context }, ...payload } as never,
          },
        }),
      );
    for (let i = 1; i <= 10; i++) {
      e2e({
        complete: true,
        reason: null,
        total_ms: i * 600,
        segments: {
          endpoint: i * 100,
          asr: i * 100,
          llm_first: i * 100,
          tts_queue: i * 100,
          tts_first: i * 100,
          playback: i * 100,
        },
      });
    }
    // A barged-in reply and a TTS failure only count; their partial segments feed nothing.
    e2e({ complete: false, reason: "barge_in", total_ms: null, segments: { endpoint: 9_999 } });
    e2e({ complete: false, reason: "tts_failed", total_ms: null, segments: { endpoint: 9_999 } });
    e2e({ complete: false, reason: "tts_failed", total_ms: null, segments: { endpoint: 9_999 } });
    const l = m.voice(Date.now()).sessions[0]?.latency.e2e;
    expect(l?.complete).toBe(10);
    expect(l?.incomplete).toBe(3);
    expect(l?.incomplete_by_reason).toEqual({ barge_in: 1, tts_failed: 2 });
    expect(l?.total).toEqual({ p50_ms: 3_000, p90_ms: 5_400, samples: 10 });
    expect(l?.segments.endpoint).toEqual({ p50_ms: 500, p90_ms: 900, samples: 10 });
    expect(l?.segments.playback.samples).toBe(10);
  });

  it("drops latency samples outside the 15 minute window", () => {
    const m = new Monitor();
    const context: ContextKey = { platform: "discord", scope: "g", channel: "vc", kind: "voice" };
    m.handle(newEnvelope("voice", { type: "voice_joined", data: { context, participants: [] } }));
    m.handle(
      newEnvelope(
        "voice",
        {
          type: "custom",
          data: {
            topic: "voice.latency",
            payload: { stage: "tts", context: { ...context }, first_audio_ms: 90 },
          },
        },
        { now: 0 },
      ),
    );
    expect(m.voice(10 * 60_000).sessions[0]?.latency.tts_first_audio.samples).toBe(1);
    expect(m.voice(16 * 60_000).sessions[0]?.latency.tts_first_audio.samples).toBe(0);
  });
});

// ---- panel.rs -----------------------------------------------------------------------------

describe("panel", () => {
  it("env_overrides_config_and_missing_dirs_are_skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-panel-"));
    try {
      expect(pickDir(undefined, dir), "no index.html yet").toBeNull();
      writeFileSync(join(dir, "index.html"), "<!doctype html>");
      expect(pickDir(undefined, dir)).toBe(dir);
      expect(pickDir("", dir)).toBe(dir);
      expect(pickDir("does/not/exist", dir)).toBeNull();
      expect(pickDir(dir, "elsewhere")).toBe(dir);
      expect(pickDir(undefined, "")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---- client.rs ----------------------------------------------------------------------------

describe("client", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);

  it("sse_parser_handles_split_chunks_and_comments", () => {
    const p = new SseParser();
    expect(p.feed(bytes(": keep-alive\n\nid: 1\nda"))).toEqual([]);
    expect(p.feed(bytes('ta: {"a":\r\ndata: 1}\r\n\r\n'))).toEqual(['{"a":\n1}']);
    expect(p.feed(bytes("data:x\n\ndata\n\n"))).toEqual(["x", ""]);
  });

  it("sse_parser_keeps_utf8_split_across_chunks", () => {
    const p = new SseParser();
    const all = bytes("data: 哈囉\n\n");
    expect(p.feed(all.slice(0, 8))).toEqual([]);
    expect(p.feed(all.slice(8))).toEqual(["哈囉"]);
  });

  it("builds_urls_under_api", () => {
    const c = new ApiClient("http://127.0.0.1:7878/", "t");
    expect(c.url(["modules", "platform.discord.bot", "enable"]).href).toBe(
      "http://127.0.0.1:7878/api/modules/platform.discord.bot/enable",
    );
    expect(new ApiClient("http://host/prefix", "t").url(["health"]).href).toBe(
      "http://host/prefix/api/health",
    );
    expect(c.url(["people", "a/b c"]).href).toBe("http://127.0.0.1:7878/api/people/a%2Fb%20c");
    expect(() => new ApiClient("not a url", "t")).toThrow("invalid API base URL");
    expect(() => new ApiClient("ftp://host", "t")).toThrow("invalid API base URL");
  });
});

// ---- TS-specific ---------------------------------------------------------------------------

describe("config and helpers", () => {
  it("config defaults equal the Rust Default impls", () => {
    expect(ApiConfigSchema.parse({})).toEqual({
      bind: "127.0.0.1:7878",
      token: "",
      panel_dir: "apps/panel/dist",
      discord_oauth: {
        client_id: "",
        client_secret: "",
        redirect_uri: "",
        redirect_uris: [],
        session_days: 7,
        cookie_secure: null,
        recheck_secs: 5,
        discord_url: "https://discord.com",
      },
      metrics_public: false,
      public: {
        enabled: true,
        song_requests: true,
        cache_secs: 10,
        rate_per_minute: 60,
        rate_total_per_minute: 3000,
        utc_offset_minutes: 480,
      },
    });
  });

  it("parses bind addresses", () => {
    expect(parseBind("127.0.0.1:7878")).toEqual({ host: "127.0.0.1", port: 7878 });
    expect(parseBind("[::1]:0")).toEqual({ host: "::1", port: 0 });
    expect(() => parseBind("nope")).toThrow("invalid bind address");
    expect(() => parseBind("host:99999")).toThrow("invalid bind address");
  });
});

describe("ContextLabels", () => {
  const ctx: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "voice" };
  const sinksWith = (describe: () => Promise<string | null>) => {
    const sinks = new PlatformSinks();
    sinks.register({
      platform: "discord",
      send: async () => ({ context: ctx, id: "1" }),
      react: async () => {},
      typing: async () => {},
      describe,
    });
    return sinks;
  };

  it("gives up on slow lookups without failing, then uses the late answer", async () => {
    const labels = new ContextLabels(() => 0, 20);
    let answer: (v: string | null) => void = () => {};
    const sinks = sinksWith(
      () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    );
    expect(await labels.label(sinks, ctx)).toBeNull();
    answer("Guild / Voice");
    await new Promise((r) => setTimeout(r, 0));
    expect(await labels.label(sinks, ctx)).toBe("Guild / Voice");
  });

  it("caches misses for a while and survives a throwing platform", async () => {
    let now = 0;
    let calls = 0;
    const labels = new ContextLabels(() => now, 20);
    const sinks = sinksWith(async () => {
      calls += 1;
      throw new Error("Missing Access");
    });
    expect(await labels.label(sinks, ctx)).toBeNull();
    expect(await labels.label(sinks, ctx)).toBeNull();
    expect(calls).toBe(1);
    now += LABEL_MISS_TTL_MS + 1;
    expect(await labels.label(sinks, ctx)).toBeNull();
    expect(calls).toBe(2);
    expect(await labels.label(undefined, ctx)).toBeNull();
  });
});
