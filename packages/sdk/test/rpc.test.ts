import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CANCEL_METHOD, RpcError, RpcPeer } from "../src/rpc.js";
import { ErrorCode } from "../src/types.js";

function pair(onRequest: (method: string, params: unknown, signal: AbortSignal) => unknown) {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const notes: Array<[string, unknown]> = [];
  const a = new RpcPeer({ input: ba, output: ab, timeoutMs: 500 });
  const b = new RpcPeer({
    input: ab,
    output: ba,
    onRequest,
    onNotification: (m, p) => notes.push([m, p]),
  });
  return { a, b, ab, ba, notes };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("RpcPeer", () => {
  it("correlates out-of-order responses", async () => {
    const { a } = pair(async (method, params) => {
      if (method === "sleep") {
        await sleep(params as number);
        return params;
      }
      if (method === "echo") return params;
      throw new RpcError(ErrorCode.MethodNotFound, method);
    });
    const [slow, fast, echo] = await Promise.all([
      a.request("sleep", 60),
      a.request("sleep", 5),
      a.request("echo", { k: [1] }),
    ]);
    expect([slow, fast, echo]).toEqual([60, 5, { k: [1] }]);
  });

  it("aborts a handler when the caller sends $/cancelRequest", async () => {
    let seen: AbortSignal | null = null;
    const { a } = pair(async (_method, _params, signal) => {
      seen = signal;
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      return "stopped";
    });
    const running = a.request("work", null, 2_000);
    await sleep(10);
    expect(seen).not.toBeNull();
    a.notify(CANCEL_METHOD, { id: 1 });
    await expect(running).resolves.toBe("stopped");
    expect((seen as AbortSignal | null)?.aborted).toBe(true);
  });

  it("maps thrown errors to error responses", async () => {
    const { a } = pair((method) => {
      if (method === "denied") throw new RpcError(ErrorCode.PermissionDenied, "nope", { why: 1 });
      throw new Error("boom");
    });
    await expect(a.request("denied")).rejects.toMatchObject({
      code: ErrorCode.PermissionDenied,
      message: "nope",
      data: { why: 1 },
    });
    await expect(a.request("other")).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      message: "boom",
    });
  });

  it("times out and ignores the late response", async () => {
    const { a } = pair(async () => {
      await sleep(100);
      return "late";
    });
    await expect(a.request("x", null, 20)).rejects.toMatchObject({ code: ErrorCode.Timeout });
    await sleep(120);
    expect(await a.request("y", null, 500)).toBe("late");
  });

  it("delivers notifications and fails pending requests on close", async () => {
    const { a, ba, notes } = pair(() => new Promise(() => {}));
    a.notify("log", { message: "hi" });
    const pending = a.request("never", null, 5000);
    await sleep(10);
    expect(notes).toEqual([["log", { message: "hi" }]]);
    ba.end();
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.Closed });
    expect(a.closed).toBe(true);
    await expect(a.request("again")).rejects.toMatchObject({ code: ErrorCode.Closed });
  });
});
