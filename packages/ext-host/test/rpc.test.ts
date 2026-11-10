import { PassThrough } from "node:stream";
import { sleep } from "@miyoria/kernel";
import type { JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  CANCEL_METHOD,
  encodeFrame,
  FrameDecoder,
  InitializeResultSchema,
  METHOD_NOT_FOUND,
  Peer,
  RpcError,
  type RpcHandler,
  registryToolName,
  TIMEOUT,
  ToolDeclSchema,
  validToolName,
} from "../src/index.js";

describe("protocol", () => {
  it("tool_names", () => {
    expect(validToolName("game.minecraft.act")).toBe(true);
    expect(registryToolName("game.minecraft.act")).toBe("game_minecraft_act");
    expect(validToolName("has space")).toBe(false);
    expect(validToolName("")).toBe(false);
  });

  it("decl_defaults", () => {
    const d = ToolDeclSchema.parse({ name: "a", description: "b" });
    expect((d.parameters as { type: string }).type).toBe("object");
    expect(d.permission).toBeNull();
    const r = InitializeResultSchema.parse({});
    expect(r.contributions.tools).toEqual([]);
  });
});

describe("rpc", () => {
  it("frames_roundtrip_across_chunks", () => {
    const a = encodeFrame({ x: "測試" });
    const b = encodeFrame([1, 2]);
    const bytes = Buffer.concat([a, b]);
    const decoder = new FrameDecoder();
    const frames: Buffer[] = [];
    // One byte at a time.
    for (let i = 0; i < bytes.length; i++) frames.push(...decoder.push(bytes.subarray(i, i + 1)));
    expect(frames).toHaveLength(2);
    expect(JSON.parse((frames[0] as Buffer).toString("utf8")).x).toBe("測試");
    expect((frames[1] as Buffer).toString()).toBe("[1,2]");
    expect(() => decoder.end()).not.toThrow();
  });

  it("rejects_bad_headers", () => {
    expect(() => new FrameDecoder().push(Buffer.from("Content-Type: x\r\n\r\n{}"))).toThrow(
      /missing Content-Length/,
    );
    expect(() =>
      new FrameDecoder().push(Buffer.from("Content-Length: 99999999999\r\n\r\n")),
    ).toThrow(/too large/);
    const d = new FrameDecoder();
    expect(d.push(Buffer.from("Content-Length: 10\r\n\r\n{}"))).toEqual([]);
    expect(() => d.end()).toThrow(/unexpected end/);
    expect(() => new FrameDecoder().push(Buffer.from("garbage\r\n"))).toThrow(/malformed header/);
  });

  const echo: RpcHandler = {
    async request(method: string, params: JsonValue): Promise<JsonValue> {
      switch (method) {
        case "echo":
          return params;
        case "sleep": {
          const ms = typeof params === "number" ? params : 0;
          await sleep(ms);
          return ms;
        }
        case "never":
          return new Promise<JsonValue>(() => {});
        default:
          throw new RpcError(METHOD_NOT_FOUND, method);
      }
    },
    notification() {},
  };

  function pair(): { a: Peer; b: Peer; aIn: PassThrough; bIn: PassThrough } {
    const aToB = new PassThrough();
    const bToA = new PassThrough();
    const a = new Peer(aToB);
    const b = new Peer(bToA);
    void a.serve(bToA, echo);
    void b.serve(aToB, echo);
    return { a, b, aIn: bToA, bIn: aToB };
  }

  it("correlates_out_of_order_responses", async () => {
    const { a } = pair();
    const t = 5000;
    const [slow, fast, echoed, missing] = await Promise.allSettled([
      a.request("sleep", 80, t),
      a.request("sleep", 5, t),
      a.request("echo", { k: 1 }, t),
      a.request("nope", null, t),
    ]);
    expect(slow).toEqual({ status: "fulfilled", value: 80 });
    expect(fast).toEqual({ status: "fulfilled", value: 5 });
    expect(echoed).toEqual({ status: "fulfilled", value: { k: 1 } });
    expect(missing.status).toBe("rejected");
    expect(((missing as PromiseRejectedResult).reason as RpcError).code).toBe(METHOD_NOT_FOUND);
  });

  it("times_out_and_closes", async () => {
    const { a, aIn } = pair();
    const err = (await a.request("never", null, 50).catch((e: unknown) => e)) as RpcError;
    expect(err).toBeInstanceOf(RpcError);
    expect(err.code).toBe(TIMEOUT);
    expect(err.message).toBe("`never` timed out after 50 ms");
    expect(a.pendingCount).toBe(0);
    // The connection stays usable.
    await expect(a.request("echo", 1, 1000)).resolves.toBe(1);
    // End of stream closes the peer and fails what is pending.
    const pending = a.request("never", null, 5000);
    aIn.end();
    await expect(pending).rejects.toMatchObject({ code: -32005 });
    expect(a.isClosed).toBe(true);
    await expect(a.request("echo", 1, 1000)).rejects.toMatchObject({ code: -32005 });
  });

  it("answers_parse_errors_and_cancels_on_abort", async () => {
    const out = new PassThrough();
    const input = new PassThrough();
    const peer = new Peer(out);
    const controller = new AbortController();
    const served = peer.serve(input, echo, controller.signal);
    const body = Buffer.from("{nope");
    input.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]));
    await sleep(10);
    const reply = new FrameDecoder().push(out.read() as Buffer);
    expect(JSON.parse((reply[0] as Buffer).toString()).error.code).toBe(-32700);
    controller.abort();
    await expect(served).resolves.toBeUndefined();
  });

  it("tells the other side when a request is aborted or times out", async () => {
    const out = new PassThrough();
    const peer = new Peer(out);
    const frames = (): JsonValue[] => {
      const chunk = out.read() as Buffer | null;
      return chunk === null
        ? []
        : new FrameDecoder().push(chunk).map((b) => JSON.parse(b.toString()) as JsonValue);
    };
    const controller = new AbortController();
    const aborted = peer.request("tools.call", { name: "x" }, 5000, controller.signal);
    controller.abort(new Error("turn cancelled"));
    await expect(aborted).rejects.toThrow("turn cancelled");
    const sent = frames();
    expect(sent).toEqual([
      { jsonrpc: "2.0", id: 1, method: "tools.call", params: { name: "x" } },
      { jsonrpc: "2.0", method: CANCEL_METHOD, params: { id: 1 } },
    ]);
    await expect(peer.request("tools.call", {}, 20)).rejects.toMatchObject({ code: TIMEOUT });
    expect(frames().at(-1)).toEqual({ jsonrpc: "2.0", method: CANCEL_METHOD, params: { id: 2 } });
  });

  it("rpc_error_wire_shape", () => {
    expect(JSON.stringify(new RpcError(-32001, "no"))).toBe('{"code":-32001,"message":"no"}');
    expect(String(new RpcError(-32001, "no"))).toBe("no (code -32001)");
  });
});
