import { EventEmitter } from "node:events";
import { StreamConnection } from "@dank074/discord-video-stream";
import { describe, expect, it, vi } from "vitest";
import { noopLogger } from "../src/log.js";
import { answerSdp, assertLibraryShape, DiscordWatchEngine, type WatchLibrary } from "../src/watch/connection.js";

const DISCORD_SDP = [
  "a=extmap-allow-mixed",
  "m=audio 50001 UDP/TLS/RTP/SAVPF 120",
  "c=IN IP4 203.0.113.7",
  "a=rtcp:50001",
  "a=setup:passive",
  "a=mid:0",
  "a=ice-ufrag:abcd1234",
  "a=ice-pwd:secretpwdsecretpwdsecretpwd",
  "a=fingerprint:sha-256 AA:BB:CC:DD",
  "a=candidate:1 1 UDP 4261412863 203.0.113.7 50001 typ host",
  "m=video 50001 UDP/TLS/RTP/SAVPF 101",
  "a=mid:1",
  "",
].join("\n");

describe("answerSdp", () => {
  it("answer_sdp_keeps_transport_fields", () => {
    const sdp = answerSdp(DISCORD_SDP);
    expect(sdp.match(/^m=/gm)).toHaveLength(1);
    expect(sdp).toMatch(/^m=video 50001 /);
    expect(sdp).toContain("a=sendrecv");
    expect(sdp).toContain("a=mid:1");
    expect(sdp).toContain("a=ice-ufrag:abcd1234");
    expect(sdp).toContain("a=fingerprint:sha-256 AA:BB:CC:DD");
    expect(sdp).toContain("a=candidate:1 1 UDP 4261412863 203.0.113.7 50001 typ host");
  });
});

describe("assertLibraryShape", () => {
  it("library_shape_check_names_what_is_missing", () => {
    const conn = new StreamConnection({} as never, "g", "u", "c", () => {});
    const stripped = new Proxy(conn, { has: (t, k) => k !== "_webRtcWrapper" && Reflect.has(t, k) });
    expect(() => assertLibraryShape(stripped)).toThrow(/_webRtcWrapper/);
    expect(() => assertLibraryShape(null)).toThrow(/_webRtcWrapper/);
  });

  it("library_shape_matches_the_installed_version", () => {
    const conn = new StreamConnection({} as never, "g", "u", "c", () => {});
    expect(() => assertLibraryShape(conn)).not.toThrow();
  });
});

describe("DiscordWatchEngine", () => {
  const plan = { guild: "g1", channel: "vc", userId: "u1", sessionId: "s" };
  const hooks = { onLive: vi.fn(), onKeyframe: vi.fn(), onOpus: vi.fn() };

  function fakes() {
    const client = Object.assign(new EventEmitter(), { user: { id: "self" } });
    const sent: Array<[number, unknown]> = [];
    const lib = {
      dvs: {
        GatewayOpCodes: { STREAM_WATCH: 20, STREAM_DELETE: 19 },
        Streamer: class {
          sendOpcode(op: number, d: unknown): void {
            sent.push([op, d]);
          }
        },
      },
      dc: {},
    } as unknown as WatchLibrary;
    return { client, sent, lib };
  }

  it("returns promptly when aborted although Discord never answers", async () => {
    const { client, sent, lib } = fakes();
    const engine = new DiscordWatchEngine(client as never, noopLogger, async () => lib);
    const abort = new AbortController();
    const run = engine.run(plan, hooks, abort.signal);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]).toEqual([20, { stream_key: "guild:g1:vc:u1" }]);
    const t0 = Date.now();
    abort.abort();
    await expect(run).resolves.toBe("stopped");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(sent.at(-1)).toEqual([19, { stream_key: "guild:g1:vc:u1" }]);
    expect(client.listenerCount("raw")).toBe(0);
  });

  it("ends with 'stream ended' when Discord deletes the stream", async () => {
    const { client, sent, lib } = fakes();
    const engine = new DiscordWatchEngine(client as never, noopLogger, async () => lib);
    const run = engine.run(plan, hooks, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 20));
    client.emit("raw", { t: "STREAM_DELETE", d: { stream_key: "guild:g1:vc:u1" } });
    await expect(run).resolves.toBe("stream ended");
    expect(sent.filter(([op]) => op === 19)).toHaveLength(0);
  });

  it("fails readably when the library cannot load", async () => {
    const { client } = fakes();
    const engine = new DiscordWatchEngine(client as never, noopLogger, async () => {
      throw new Error("no native module");
    });
    await expect(engine.run(plan, hooks, new AbortController().signal)).rejects.toThrow(/no native module/);
  });
});
