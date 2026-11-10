// A fake game that speaks the Neuro Game SDK protocol (client side) over a real WebSocket.

import { createServer } from "node:net";
import { WebSocket } from "ws";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export type Msg = { command: string; data?: Record<string, unknown> };

export class FakeGame {
  readonly received: Msg[] = [];
  closed: { code: number; reason: string } | null = null;
  #ws: WebSocket;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (raw) => this.received.push(JSON.parse(raw.toString())));
    ws.on("close", (code, reason) => {
      this.closed = { code, reason: reason.toString() };
    });
  }

  static async connect(port: number, host = "127.0.0.1"): Promise<FakeGame> {
    const ws = new WebSocket(`ws://${host}:${port}`);
    const game = new FakeGame(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
    });
    return game;
  }

  get open(): boolean {
    return this.#ws.readyState === WebSocket.OPEN;
  }

  /** `game` is filled in like the SDK does. */
  send(command: string, data?: Record<string, unknown>, game = "Fake Game"): void {
    this.#ws.send(JSON.stringify(data === undefined ? { command, game } : { command, game, data }));
  }

  raw(text: string | Buffer, binary = false): void {
    this.#ws.send(text, { binary });
  }

  /** The next not-yet-consumed server message with this command. */
  async next(command: string): Promise<Msg> {
    await waitFor(() => this.received.some((m) => m.command === command));
    const index = this.received.findIndex((m) => m.command === command);
    return this.received.splice(index, 1)[0] as Msg;
  }

  async waitClosed(): Promise<{ code: number; reason: string }> {
    await waitFor(() => this.closed !== null);
    return this.closed as { code: number; reason: string };
  }

  close(): void {
    this.#ws.close();
  }
}
