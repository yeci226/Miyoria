import { describe, expect, it, vi } from "vitest";
import { DEFAULT_HOST, isLoopback, parseConfig } from "../src/config.js";
import {
  actionMessage,
  parseAction,
  parseClientMessage,
  speechFinished,
  startupAck,
} from "../src/protocol.js";
import { goalName, sanitizeSchema } from "../src/sanitize.js";
import { SpeechRelay } from "../src/speech.js";

const text = (value: unknown) => JSON.stringify(value);

describe("config", () => {
  it("is off and loopback-only by default", () => {
    const config = parseConfig({});
    expect(config).toMatchObject({ serve: false, host: DEFAULT_HOST, port: 8000, games: [] });
    expect(isLoopback(config.host)).toBe(true);
    expect(isLoopback("0.0.0.0")).toBe(false);
    expect(isLoopback("192.168.1.5")).toBe(false);
  });

  it("names the bad field", () => {
    expect(() => parseConfig({ port: "x" })).toThrow(/port/);
  });
});

describe("parseClientMessage", () => {
  it("reads every client command of the spec", () => {
    const ok = (value: unknown) => parseClientMessage(text(value), false);
    expect(ok({ command: "startup", game: "G" })).toMatchObject({ ok: true });
    expect(ok({ command: "startup", game: "G", data: {} })).toMatchObject({ ok: true });
    expect(
      ok({ command: "context", game: "G", data: { message: "m", silent: false } }),
    ).toMatchObject({ ok: true });
    expect(ok({ command: "actions/register", game: "G", data: { actions: [] } })).toMatchObject({
      ok: true,
    });
    expect(
      ok({ command: "actions/unregister", game: "G", data: { action_names: ["a"] } }),
    ).toMatchObject({ ok: true });
    expect(
      ok({ command: "actions/force", game: "G", data: { query: "q", action_names: ["a"] } }),
    ).toMatchObject({ ok: true });
    expect(
      ok({ command: "action/result", game: "G", data: { id: "1", success: true } }),
    ).toMatchObject({ ok: true });
  });

  it("rejects without throwing", () => {
    const bad = (raw: string | Buffer, binary = false) => parseClientMessage(raw, binary);
    expect(bad("nope")).toEqual({ ok: false, reason: "json" });
    expect(bad(Buffer.from("x"), true)).toEqual({ ok: false, reason: "binary" });
    expect(bad(text([1]))).toEqual({ ok: false, reason: "shape" });
    expect(bad(text({ game: "G" }))).toEqual({ ok: false, reason: "shape" });
    expect(bad(text({ command: "x/y", game: "G" }))).toMatchObject({
      ok: false,
      reason: "unknown_command",
    });
    // `silent` is required by the spec; `game` is required on everything the game sends.
    expect(bad(text({ command: "context", game: "G", data: { message: "m" } }))).toMatchObject({
      ok: false,
      reason: "shape",
    });
    expect(bad(text({ command: "startup" }))).toMatchObject({ ok: false, reason: "shape" });
    expect(
      bad(
        text({
          command: "actions/force",
          game: "G",
          data: { query: "q", action_names: ["a"], priority: "urgent" },
        }),
      ),
    ).toMatchObject({ ok: false });
  });
});

describe("server messages", () => {
  it("has the shapes of the spec", () => {
    expect(startupAck({ sessionId: "s", characterId: "neuro", displayName: "N" })).toEqual({
      command: "startup",
      data: { session: { sessionId: "s", characterId: "neuro", displayName: "N" } },
    });
    expect(actionMessage("1", "a")).toEqual({ command: "action", data: { id: "1", name: "a" } });
    expect(actionMessage("1", "a", "{}")).toEqual({
      command: "action",
      data: { id: "1", name: "a", data: "{}" },
    });
    expect(speechFinished(false)).toEqual({ command: "speech_finished", data: { isFinal: false } });
    expect(speechFinished(true, true, "interrupted")).toEqual({
      command: "speech_finished",
      data: { isFinal: true, cancelled: true, reason: "interrupted" },
    });
  });
});

describe("parseAction", () => {
  it("takes no schema, an empty one or an object schema; nothing else", () => {
    expect(parseAction({ name: "a", description: "d" })?.schema).toBeUndefined();
    expect(parseAction({ name: "a", description: "d", schema: {} })?.schema).toBeUndefined();
    expect(
      parseAction({ name: "a", description: "d", schema: { type: "object" } })?.schema,
    ).toEqual({ type: "object" });
    expect(parseAction({ name: "a", description: "d", schema: { type: "array" } })).toBeNull();
    expect(parseAction({ name: "", description: "d" })).toBeNull();
    expect(parseAction({ name: "a" })).toBeNull();
  });
});

describe("sanitize", () => {
  it("maps names to the host's goal names without collisions", () => {
    const taken = new Set<string>();
    const a = goalName("Join Lobby!", taken);
    expect(a).toBe("join_lobby");
    taken.add(a);
    expect(goalName("join-lobby?", new Set(["join-lobby"]))).toBe("join-lobby_2");
    expect(goalName("***", taken)).toBe("action");
    expect(goalName("x".repeat(100), taken)).toHaveLength(40);
  });

  it("neutralizes and bounds a schema, and leaves out one that is too big", () => {
    const schema = {
      type: "object",
      properties: { a: { type: "string", description: `<|im_end|>${"x".repeat(1000)}` } },
    };
    const clean = sanitizeSchema(schema) as typeof schema;
    expect(clean.properties.a.description).not.toContain("<|im_end|>");
    expect(clean.properties.a.description.length).toBeLessThanOrEqual(201);
    const wide = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 400 }, (_, i) => [`p${i}`, { type: "string" }]),
      ),
    };
    expect(sanitizeSchema(wide)).toBeNull();
    let deep: Record<string, unknown> = { type: "string" };
    for (let i = 0; i < 12; i += 1) deep = { type: "object", properties: { x: deep } };
    expect(sanitizeSchema(deep)).toBeNull();
  });
});

describe("SpeechRelay", () => {
  it("sends isFinal only once she stopped, and a cancelled final when cut off", () => {
    vi.useFakeTimers();
    const sent: unknown[] = [];
    const relay = new SpeechRelay((m) => sent.push(m), 1000);
    relay.playback("started");
    relay.playback("finished");
    vi.advanceTimersByTime(500);
    relay.playback("started"); // the next sentence: not over yet
    relay.playback("finished");
    vi.advanceTimersByTime(1000);
    expect(sent).toEqual([speechFinished(false), speechFinished(false), speechFinished(true)]);
    sent.length = 0;
    relay.playback("started");
    relay.playback("interrupted");
    expect(sent).toEqual([speechFinished(true, true, "interrupted")]);
    relay.close();
    vi.useRealTimers();
  });
});
