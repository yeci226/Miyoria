// VTube Studio client against a fake VTS server.

import { existsSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { ApiError, type PluginInfo, tokenPath, VtsClient } from "../src/index.js";
import { FakeVts, type Json, tempDir, waitUntil } from "./common.js";

const TIMEOUT = 5_000;
const plugin = (): PluginInfo => ({ name: "Miyoria", developer: "Miyoria", icon: null });

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function start(): Promise<FakeVts> {
  const vts = await FakeVts.start();
  cleanup.push(() => vts.close());
  return vts;
}

async function client(vts: FakeVts): Promise<VtsClient> {
  const c = await VtsClient.connect(vts.url(), TIMEOUT);
  cleanup.push(() => c.close());
  return c;
}

describe("vts", () => {
  it("auth_flow_persists_and_renews_the_token", async () => {
    const vts = await start();
    const dir = tempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = tokenPath(join(dir, "nested"));

    let c = await client(vts);
    await c.authenticate(plugin(), file, TIMEOUT);
    expect(vts.types()).toStrictEqual(["AuthenticationTokenRequest", "AuthenticationRequest"]);
    expect(readFileSync(file, "utf8")).toBe("tok-1");
    const reqs = vts.requests();
    expect(reqs[0].apiName).toBe("VTubeStudioPublicAPI");
    expect(reqs[0].apiVersion).toBe("1.0");
    expect(reqs[0].data.pluginName).toBe("Miyoria");
    expect(reqs[0].data.pluginDeveloper).toBe("Miyoria");
    expect(reqs[0].data).not.toHaveProperty("pluginIcon");
    expect(reqs[1].data.authenticationToken).toBe("tok-1");
    expect(reqs[0].requestID).not.toBe(reqs[1].requestID);
    c.close();

    // The stored token is reused.
    vts.clear();
    c = await client(vts);
    await c.authenticate(plugin(), file, TIMEOUT);
    expect(vts.types()).toStrictEqual(["AuthenticationRequest"]);
    c.close();

    // A revoked token is replaced.
    vts.clear();
    vts.state.validToken = "revoked";
    c = await client(vts);
    await c.authenticate(plugin(), file, TIMEOUT);
    expect(vts.types()).toStrictEqual([
      "AuthenticationRequest",
      "AuthenticationTokenRequest",
      "AuthenticationRequest",
    ]);
    expect(readFileSync(file, "utf8")).toBe("tok-2");
  });

  it("denied_plugin_is_an_error", async () => {
    const vts = await start();
    vts.state.deny = true;
    const dir = tempDir();
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = tokenPath(dir);
    const c = await client(vts);
    await expect(c.authenticate(plugin(), file, TIMEOUT)).rejects.toThrow(/denied/);
    expect(existsSync(file)).toBe(false);
  });

  it("model_hotkeys_and_expressions", async () => {
    const vts = await start();
    const c = await client(vts);

    const model = await c.currentModel();
    expect(model).toStrictEqual({ loaded: true, name: "DeepSeek-chan", id: "m1" });

    const hotkeys = await c.hotkeys();
    expect(hotkeys.length).toBe(2);
    expect(hotkeys[0]?.kind).toBe("TriggerAnimation");

    // Names resolve to ids, case-insensitively; ids pass through.
    expect(await c.triggerHotkey("wave")).toBe("hk-wave");
    expect(await c.triggerHotkey("hk-clear")).toBe("hk-clear");
    await expect(c.triggerHotkey("Dance")).rejects.toThrow("no hotkey `Dance`");
    const triggers = vts
      .requests()
      .filter((r: Json) => r.messageType === "HotkeyTriggerRequest")
      .map((r: Json) => r.data.hotkeyID);
    expect(triggers).toStrictEqual(["hk-wave", "hk-clear"]);

    const expressions = await c.expressions();
    expect(expressions[0]?.file).toBe("happy.exp3.json");
    await c.setExpression("happy.exp3.json", true, 0.3);
    const req = vts
      .requests()
      .findLast((r: Json) => r.messageType === "ExpressionActivationRequest");
    expect(req.data.expressionFile).toBe("happy.exp3.json");
    expect(req.data.active).toBe(true);
    expect(Math.abs(req.data.fadeTime - 0.3)).toBeLessThan(1e-6);
    const state = vts.requests().find((r: Json) => r.messageType === "ExpressionStateRequest");
    expect(state.data.details).toBe(false);

    const params = await c.inputParameters();
    expect(params.has("FaceAngleX") && params.has("MouthSmile")).toBe(true);

    const err = await c.request("NoSuchRequest", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).id).toBe(2);
  });

  it("injection_is_batched_and_coalesced", async () => {
    const vts = await start();
    const c = await client(vts);
    // Several frames queued back to back: unsent values merge, newest wins.
    c.inject(
      [
        ["MouthOpen", 0.5],
        ["MouthSmile", 0.55],
      ],
      false,
    );
    c.inject([["FaceAngleX", 3.0]], false);
    c.inject(
      [
        ["MouthOpen", 0.7],
        ["NotANumber", Number.NaN],
      ],
      true,
    );
    await waitUntil(() => {
      const last = vts.injections().at(-1);
      return (
        last?.parameterValues.some(
          (p: Json) => p.id === "MouthOpen" && Math.abs(p.value - 0.7) < 1e-6,
        ) ?? false
      );
    });
    const injections = vts.injections();
    expect(injections.length).toBeGreaterThanOrEqual(1);
    expect(injections.length).toBeLessThanOrEqual(3);
    const seen = new Map<string, number>();
    for (const d of injections) {
      expect(d.mode).toBe("set");
      for (const p of d.parameterValues) seen.set(p.id, p.value);
    }
    expect(injections.at(-1).faceFound).toBe(true);
    expect([...seen.keys()].sort()).toStrictEqual(["FaceAngleX", "MouthOpen", "MouthSmile"]);
    expect(Math.abs((seen.get("FaceAngleX") as number) - 3)).toBeLessThan(1e-6);

    // A single frame carries every parameter in one request.
    vts.clear();
    c.inject(
      [
        ["MouthOpen", 0.2],
        ["FaceAngleX", 1.0],
        ["EyeLeftX", -0.5],
      ],
      false,
    );
    await waitUntil(() => vts.injections().length > 0);
    expect(vts.injections()[0].parameterValues.length).toBe(3);
    // Parameters go out ordered by id.
    expect(vts.injections()[0].parameterValues.map((p: Json) => p.id)).toStrictEqual([
      "EyeLeftX",
      "FaceAngleX",
      "MouthOpen",
    ]);
  });

  it("disconnect_fails_requests", async () => {
    // A server that hangs up on the first request.
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    cleanup.push(() => new Promise<void>((r) => wss.close(() => r())));
    wss.on("connection", (ws) => ws.once("message", () => ws.terminate()));
    const port = (wss.address() as AddressInfo).port;
    const c = await VtsClient.connect(`ws://127.0.0.1:${port}`, TIMEOUT);
    cleanup.push(() => c.close());
    await expect(c.currentModel()).rejects.toThrow(/disconnected/);
    await c.closed();
    expect(c.isClosed()).toBe(true);
    await expect(c.currentModel()).rejects.toThrow(/disconnected/);
    await expect(VtsClient.connect("ws://127.0.0.1:1", 500)).rejects.toThrow(/VTube Studio/);
  });

  it("requests_time_out", async () => {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((r) => wss.once("listening", () => r()));
    cleanup.push(() => {
      for (const ws of wss.clients) ws.terminate();
      return new Promise<void>((r) => wss.close(() => r()));
    });
    const port = (wss.address() as AddressInfo).port;
    const c = await VtsClient.connect(`ws://127.0.0.1:${port}`, 100);
    cleanup.push(() => c.close());
    await expect(c.currentModel()).rejects.toThrow("did not answer `CurrentModelRequest` in time");
  });
});
