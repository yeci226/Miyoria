// A fake miyoria-bridge WebSocket server speaking PROTOCOL.md.

import type { AddressInfo } from "node:net";
import { type WebSocket, WebSocketServer } from "ws";

export type Responder = (
  req: Record<string, unknown>,
) => { ok: true; data?: unknown } | { ok: false; code: string; message?: string } | "silent";

export class FakeMod {
  readonly server: WebSocketServer;
  readonly requests: Array<Record<string, unknown>> = [];
  readonly sockets = new Set<WebSocket>();
  token = "secret-token-1234";
  capabilities: Record<string, boolean> = { baritone: true, altoclef: true, screenshot: true };
  hellos = 0;
  respond: Responder = () => ({ ok: true, data: {} });

  private constructor(server: WebSocketServer) {
    this.server = server;
    server.on("connection", (ws) => this.#accept(ws));
  }

  static async start(port = 0): Promise<FakeMod> {
    const server = new WebSocketServer({ host: "127.0.0.1", port });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    return new FakeMod(server);
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  #accept(ws: WebSocket): void {
    let authed = false;
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (msg.type === "hello") {
        if (msg.token !== this.token) {
          ws.send(JSON.stringify({ type: "error", error: { code: "unauthorized", message: "bad token" } }));
          ws.close(1008, "unauthorized");
          return;
        }
        authed = true;
        this.hellos++;
        this.sockets.add(ws);
        ws.send(
          JSON.stringify({
            type: "hello_ack",
            protocol: 1,
            mod_version: "0.1.0",
            minecraft: "1.21.1",
            capabilities: this.capabilities,
          }),
        );
        return;
      }
      if (!authed) {
        ws.close(1008, "unauthorized");
        return;
      }
      this.requests.push(msg);
      const reply = this.respond(msg);
      if (reply === "silent") return;
      ws.send(
        JSON.stringify(
          reply.ok
            ? { type: "result", id: msg.id, ok: true, data: reply.data ?? {} }
            : { type: "result", id: msg.id, ok: false, error: { code: reply.code, message: reply.message ?? "" } },
        ),
      );
    });
    ws.on("close", () => this.sockets.delete(ws));
  }

  /** Pushes an event to every authenticated client. */
  emit(name: string, data: Record<string, unknown>): void {
    for (const ws of this.sockets) ws.send(JSON.stringify({ type: "event", name, time: Date.now(), data }));
  }

  /** Drops every client connection. */
  kick(): void {
    for (const ws of this.sockets) ws.terminate();
  }

  async stop(): Promise<void> {
    for (const ws of this.server.clients) ws.terminate();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

export function waitFor(predicate: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) resolve();
      else if (Date.now() - start > ms) reject(new Error("condition not met"));
      else setTimeout(tick, 5);
    };
    tick();
  });
}

export const SNAPSHOT = {
  health: 17.5,
  max_health: 20,
  food: 18,
  saturation: 4.3,
  air: 300,
  position: { x: 100.46, y: 64.0, z: -20.2 },
  block_position: { x: 100, y: 64, z: -21 },
  yaw: 91.3,
  pitch: -12.3,
  dimension: "overworld",
  biome: "plains",
  time_of_day: 6000,
  time_phase: "day",
  is_night: false,
  weather: "clear",
  held_item: { item: "iron_pickaxe", count: 1, durability_pct: 88, slot: 0 },
  inventory: { apple: 3, cobblestone: 84, iron_pickaxe: 1 },
  inventory_free_slots: 32,
  hotbar: [{ item: "iron_pickaxe", count: 1, durability_pct: 88 }, null, null, null, null, null, null, null, null],
  armor: { head: { item: "iron_helmet", count: 1, durability_pct: 50 }, chest: null, legs: null, feet: null },
  offhand: null,
  looking_at: { kind: "block" as const, block: "oak_log", position: { x: 5, y: 64, z: -3 }, face: "north", distance: 2.4 },
  nearby_entities: [
    { type: "zombie", distance: 3.0, hostile: true },
    { type: "player", name: "Steve", distance: 8.0, hostile: false },
    { type: "cow", distance: 12.0, hostile: false },
  ],
  nearby_entities_total: 3,
  hostile_count: 1,
  nearby_blocks: [
    { block: "diamond_ore", count: 2, nearest: { x: 30, y: 12, z: 30 }, distance: 40.0 },
    { block: "chest", count: 1, nearest: { x: 1, y: 64, z: 1 }, distance: 5.0 },
  ],
  baritone: { available: true, busy: true, process: "Mine", goal: "GoalBlock{x=1,y=2,z=3}" },
  altoclef: { available: false, busy: null },
};
