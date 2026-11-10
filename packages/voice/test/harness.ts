// Test harness: a supervisor running `voice.link` on port 0 and a fake voice node speaking the
// Voice Link protocol (port of `tests/common/mod.rs`).

import { readFileSync } from "node:fs";
import { type Module, ServiceRegistry, type Subscription, Supervisor } from "@miyoria/kernel";
import type { Envelope, JsonObject, JsonValue, ModuleStateKind } from "@miyoria/types";
import { parse as parseToml } from "smol-toml";
import WebSocket, { type RawData } from "ws";
import { type VoiceLink, VoiceLinkKey, VoiceLinkModule } from "../src/index.js";

export const TOKEN = "secret-token";
export const SELF_ID = "42";
const WAIT_MS = 5_000;

const PROFILE_VOICE = new URL("../../../profiles/deepseek-chan/voice.toml", import.meta.url);

export function deepseekVoice(): JsonObject {
  return parseToml(readFileSync(PROFILE_VOICE, "utf8")) as JsonObject;
}

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(cond: () => boolean): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleepMs(5);
  }
}

export async function nextEvent(sub: Subscription): Promise<Envelope> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("event in time")), WAIT_MS);
  });
  try {
    const env = await Promise.race([sub.recv(), timeout]);
    if (env === null) throw new Error("bus open");
    return env;
  } finally {
    clearTimeout(timer);
  }
}

export class Harness {
  private constructor(
    readonly sup: Supervisor,
    readonly services: ServiceRegistry,
    readonly linkModule: VoiceLinkModule,
  ) {}

  /** Boots `voice.link` (with `linkConfig` merged over the defaults) plus `extra` modules. */
  static async start(
    linkConfig: JsonObject = {},
    extra: Array<[Module, JsonValue | null]> = [],
    setup: (services: ServiceRegistry) => void = () => undefined,
  ): Promise<Harness> {
    const services = new ServiceRegistry();
    setup(services);
    const sup = new Supervisor({ services });
    const linkModule = new VoiceLinkModule();
    await sup.register(linkModule, { bind: "127.0.0.1:0", token: TOKEN, ...linkConfig }, true);
    for (const [module, config] of extra) await sup.register(module, config, true);
    await sup.startAll();
    return new Harness(sup, services, linkModule);
  }

  get bus() {
    return this.sup.bus;
  }

  url(): string {
    const addr = this.linkModule.localAddr();
    if (!addr) throw new Error("voice.link is not running");
    return `ws://127.0.0.1:${addr.port}/voice-link`;
  }

  link(): VoiceLink {
    return this.services.require(VoiceLinkKey);
  }

  subscribe(topics: string[]): Subscription {
    return this.bus.subscribe(topics);
  }

  connect(): Promise<Node> {
    return Node.connect(this.url());
  }

  /** Connects and authenticates as `account`. */
  async node(account: string, capabilities?: string[]): Promise<Node> {
    const node = await this.connect();
    node.hello(TOKEN, account, capabilities);
    const welcome = await node.recvJson();
    if (welcome.type !== "welcome" || typeof welcome.session !== "string" || !welcome.session) {
      throw new Error(`expected welcome, got ${JSON.stringify(welcome)}`);
    }
    // Wait until Core has registered the connection.
    const link = this.link();
    await waitUntil(() => link.selfAccount()?.id === account);
    return node;
  }

  moduleState(id: string): { state: ModuleStateKind; reason: string | null } {
    const s = this.sup.list().find((m) => m.id === id);
    if (!s) throw new Error(`no module ${id}`);
    return { state: s.state, reason: s.reason };
  }

  async stop(): Promise<void> {
    await this.sup.stopAll();
  }
}

export type Message =
  | { kind: "text"; text: string }
  | { kind: "binary"; data: Buffer }
  | { kind: "close"; code: number };

/** A fake voice node. */
export class Node {
  /** Answer `{"type":"ping"}` automatically. */
  autoPong = true;
  readonly #queue: Message[] = [];
  readonly #waiters: Array<(m: Message) => void> = [];

  private constructor(readonly ws: WebSocket) {
    ws.on("message", (data: RawData, isBinary: boolean) => {
      const buf = Array.isArray(data)
        ? Buffer.concat(data)
        : data instanceof ArrayBuffer
          ? Buffer.from(data)
          : data;
      this.#push(isBinary ? { kind: "binary", data: buf } : { kind: "text", text: buf.toString() });
    });
    ws.on("close", (code: number) => this.#push({ kind: "close", code }));
    ws.on("error", () => undefined);
  }

  static connect(url: string): Promise<Node> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { perMessageDeflate: false });
      const node = new Node(ws);
      ws.once("open", () => resolve(node));
      ws.once("error", reject);
    });
  }

  #push(m: Message): void {
    const w = this.#waiters.shift();
    if (w) w(m);
    else this.#queue.push(m);
  }

  #raw(timeoutMs: number): Promise<Message | null> {
    const m = this.#queue.shift();
    if (m) return Promise.resolve(m);
    return new Promise((resolve) => {
      const waiter = (msg: Message) => {
        clearTimeout(timer);
        resolve(msg);
      };
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(waiter);
        if (i >= 0) this.#waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  sendJson(value: JsonValue): void {
    this.ws.send(JSON.stringify(value));
  }

  hello(token: string, account: string, capabilities?: string[]): void {
    this.sendJson({
      type: "hello",
      version: 1,
      token,
      node: "test-node",
      self_account: { platform: "discord", id: account },
      ...(capabilities ? { capabilities } : {}),
    });
  }

  /** Every JSON message that arrives within `ms` (audio frames are skipped). */
  async collect(ms: number): Promise<Array<Record<string, JsonValue>>> {
    const out: Array<Record<string, JsonValue>> = [];
    const until = Date.now() + ms;
    for (;;) {
      const left = until - Date.now();
      if (left <= 0) return out;
      const msg = await this.tryRecv(left);
      if (msg === null) return out;
      if (msg.kind === "text") out.push(JSON.parse(msg.text) as Record<string, JsonValue>);
    }
  }

  /** Sends captured audio of `stream` in 20 ms frames. */
  sendAudio(stream: number, samples: Int16Array): void {
    for (let at = 0; at < samples.length; at += 320) {
      const chunk = samples.subarray(at, at + 320);
      const frame = Buffer.alloc(5 + chunk.length * 2);
      frame[0] = 0x01;
      frame.writeUInt32LE(stream, 1);
      for (let i = 0; i < chunk.length; i++) frame.writeInt16LE(chunk[i] as number, 5 + i * 2);
      this.ws.send(frame, { binary: true });
    }
  }

  /** Next data message (JSON, binary or close) within `timeoutMs`; answers pings. */
  async tryRecv(timeoutMs: number): Promise<Message | null> {
    for (;;) {
      const msg = await this.#raw(timeoutMs);
      if (msg === null) return null;
      if (msg.kind === "text" && this.autoPong && msg.text.includes('"ping"')) {
        this.sendJson({ type: "pong" });
        continue;
      }
      return msg;
    }
  }

  async recv(): Promise<Message> {
    const msg = await this.tryRecv(WAIT_MS);
    if (msg === null) throw new Error("message in time");
    return msg;
  }

  async recvJson(): Promise<Record<string, JsonValue>> {
    const msg = await this.recv();
    if (msg.kind !== "text") throw new Error(`expected JSON, got ${msg.kind}`);
    return JSON.parse(msg.text) as Record<string, JsonValue>;
  }

  /** Waits for a JSON message of `type`, skipping others (e.g. audio). */
  async recvType(type: string): Promise<Record<string, JsonValue>> {
    for (;;) {
      const msg = await this.recv();
      if (msg.kind === "close") throw new Error(`closed (${msg.code}) while waiting for ${type}`);
      if (msg.kind !== "text") continue;
      const v = JSON.parse(msg.text) as Record<string, JsonValue>;
      if (v.type === type) return v;
    }
  }

  /** Waits for the close frame and returns its code. */
  async expectClose(): Promise<number> {
    for (;;) {
      const msg = await this.recv();
      if (msg.kind === "close") return msg.code;
    }
  }

  close(): void {
    this.ws.close();
  }

  /** Drops the TCP connection without a close handshake. */
  drop(): void {
    this.ws.terminate();
  }
}
