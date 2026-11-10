// The whole extension through the SDK runtime against a fake host and a fake mod.

import { PassThrough } from "node:stream";
import { type InitializeResult, RpcPeer, runExtension } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../src/index.js";
import { FakeMod, SNAPSHOT, waitFor } from "./fake-mod.js";

let mod: FakeMod | undefined;
let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  await mod?.stop();
  mod = undefined;
});

function host() {
  const hostToExt = new PassThrough();
  const extToHost = new PassThrough();
  const published: Array<{ topic: string; payload: unknown }> = [];
  const taskEvents: Array<Record<string, unknown>> = [];
  const runtime = runExtension(extension, { input: hostToExt, output: extToHost, exit: () => {}, timeoutMs: 2000 });
  const peer = new RpcPeer({
    input: extToHost,
    output: hostToExt,
    timeoutMs: 3000,
    onRequest: (method, params) => {
      if (method === "events.publish") published.push(params as { topic: string; payload: unknown });
      return {};
    },
    onNotification: (method, params) => {
      if (method === "task.event") taskEvents.push((params as { event: Record<string, unknown> }).event);
    },
  });
  shutdown = () => runtime.shutdown();
  return { peer, published, taskEvents };
}

function initialize(peer: RpcPeer, config: Record<string, unknown>, game: string | null = "minecraft") {
  return peer.request<InitializeResult>("initialize", {
    protocol: 1,
    host: { name: "miyoria", version: "0.1.0" },
    extension: { id: "miyoria.minecraft", version: "0.1.0", dir: "/ext", game },
    config,
    permissions: { events: [], tools: true, commands: false, network: [], input: [] },
  });
}

describe("extension", () => {
  it("registers the game.minecraft executor and publishes game events", async () => {
    mod = await FakeMod.start();
    mod.capabilities = { baritone: true, altoclef: false, screenshot: true, tasks: true };
    mod.respond = (req) => (req.type === "observe" ? { ok: true, data: SNAPSHOT } : { ok: true, data: {} });
    const { peer, published, taskEvents } = host();
    const result = await initialize(peer, { url: mod.url, token: mod.token, reconnect_min_ms: 20 });
    // No raw tools: the executor is the only way in.
    expect(result.contributions.tools).toEqual([]);
    expect(result.contributions.executor?.name).toBe("Minecraft");
    expect(result.contributions.executor?.goals.map((g) => g.name)).toContain("obtain");
    expect(result.contributions.executor?.goals.find((g) => g.name === "goto")?.budget_s).toBe(120);
    expect(result.contributions.executor?.guide).toContain("生存的進度");
    expect(result.contributions.prompts).toEqual([]);
    const m = mod;
    await waitFor(() => m.hellos === 1);
    await waitFor(() => published.some((p) => p.topic === "game.minecraft.connected"));

    const observed = await peer.request<{ state: Record<string, unknown>; summary: string; task: string | null }>(
      "task.observe",
      {},
    );
    expect(observed.summary).toContain("血量 17.5/20");
    expect(observed.state).toMatchObject({ connected: true, in_game: true, busy: true });
    expect(observed.task).toBeNull();

    await peer.request("task.start", { task: { id: "t1", goal: "goto", args: { x: 10, y: 64, z: 5 }, budget_s: 60 } });
    await waitFor(() => m.requests.some((r) => r.type === "baritone"));
    expect(m.requests.at(-1)).toMatchObject({ type: "baritone", command: "goto", x: 10, y: 64, z: 5, task: "t1" });
    m.emit("task_done", { task: "t1", kind: "goto", detail: "到了" });
    await waitFor(() => taskEvents.some((e) => e.type === "done"));
    expect(taskEvents.map((e) => [e.type, e.task])).toEqual([
      ["started", "t1"],
      ["done", "t1"],
    ]);
    expect(taskEvents[1]).toMatchObject({ detail: "到了" });

    m.emit("death", { last_damage_source: "fall" });
    await waitFor(() => published.some((p) => p.topic === "game.minecraft.death"));
    expect(published.find((p) => p.topic === "game.minecraft.death")?.payload).toEqual({
      type: "death",
      data: { last_damage_source: "fall", text: "死掉了(摔落)" },
      important: true,
    });
    // Task lifecycle never goes out as a game event.
    expect(published.some((p) => p.topic.startsWith("game.minecraft.task"))).toBe(false);
  });

  it("fails activation when the manifest does not declare the game", async () => {
    const { peer } = host();
    await expect(initialize(peer, { url: "ws://127.0.0.1:1" }, null)).rejects.toMatchObject({
      message: expect.stringContaining('game = "minecraft"'),
    });
  });
});
