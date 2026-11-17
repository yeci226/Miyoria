// Test harness: a supervisor running the `cluster` module on an ephemeral port over an in-memory
// store, and a fake host that speaks the control link with the SDK's peer.

import { busEventRegistry, checkBusEvent } from "@miyoria/contracts/events";
import {
  HOST_LINK_PATH,
  HOST_PROTOCOL_VERSION,
  type HostReport,
  type HostServiceStatus,
  type HostWelcome,
} from "@miyoria/contracts/host";
import {
  type Module,
  ServiceRegistry,
  type Subscription,
  Supervisor,
} from "@miyoria/runtime/kernel";
import { type RequestHandler, RpcPeer, WebSocketTransport } from "@miyoria/sdk";
import { SqliteStore, StoreKey } from "@miyoria/store";
import type { Envelope, JsonObject } from "@miyoria/types";
import WebSocket from "ws";
import {
  type ClusterGuard,
  ClusterKey,
  ClusterModule,
  type ClusterModuleOptions,
  type ClusterService,
  clusterTables,
  type RelayOptions,
} from "../src/index.js";

export const WAIT_MS = 5_000;

export function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitUntil(cond: () => boolean, what = "condition"): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} not met in time`);
    await sleepMs(5);
  }
}

/** The next event on `sub`, checked against its registered payload schema. */
export async function nextEvent(sub: Subscription): Promise<Envelope> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("no event in time")), WAIT_MS);
  });
  try {
    const env = await Promise.race([sub.recv(), timeout]);
    if (env === null) throw new Error("the bus closed");
    const problems = checkBusEvent(busEventRegistry(), env.type, env.data).problems;
    if (problems.length > 0) {
      throw new Error(`${env.type} payload: ${JSON.stringify(problems)}`);
    }
    return env;
  } finally {
    clearTimeout(timer);
  }
}

export function service(fields: Partial<HostServiceStatus> & { name: string }): HostServiceStatus {
  return {
    kind: "worker",
    provides: [fields.name],
    state: "running",
    since: 0,
    healthy: true,
    restarts: 0,
    // A `url` in these tests is an address Core can call, as a host that advertises one (or shares
    // Core's machine) reports it. Pass `advertised: undefined` for a host reachable by link only.
    ...(fields.url !== undefined && !("advertised" in fields) ? { advertised: fields.url } : {}),
    ...fields,
  };
}

export function report(services: HostServiceStatus[], name = "pc"): HostReport {
  return {
    name,
    version: "0.1.0",
    platform: "win32",
    protocol: HOST_PROTOCOL_VERSION,
    gpu: null,
    services,
  };
}

export class Harness {
  private constructor(
    readonly sup: Supervisor,
    readonly store: SqliteStore,
    readonly module: ClusterModule,
  ) {}

  static async start(
    config: JsonObject = {},
    options: {
      guards?: ClusterGuard[];
      extra?: Module[];
      relay?: RelayOptions;
      /** More options of the module (`complete`, `uses`, `llmRate`, ...). */
      module?: Omit<ClusterModuleOptions, "guards" | "version" | "relay">;
      /** The supervisor's clock (default the system's). */
      clock?: { now(): number };
    } = {},
  ): Promise<Harness> {
    const services = new ServiceRegistry();
    const store = await SqliteStore.open(":memory:", { plugins: [clusterTables] });
    services.provide("kernel", StoreKey, store);
    const sup = new Supervisor({
      services,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const module = new ClusterModule({
      ...options.module,
      guards: options.guards ?? [],
      version: "9.9.9",
      ...(options.relay === undefined ? {} : { relay: options.relay }),
    });
    await sup.register(module, { bind: "127.0.0.1:0", hello_timeout_ms: 2_000, ...config }, true);
    for (const extra of options.extra ?? []) await sup.register(extra, null, true);
    await sup.startAll();
    return new Harness(sup, store, module);
  }

  get bus() {
    return this.sup.bus;
  }

  cluster(): ClusterService {
    return this.sup.services.require(ClusterKey);
  }

  url(): string {
    const addr = this.module.localAddr();
    if (addr === null) throw new Error("the cluster module is not listening");
    return `ws://127.0.0.1:${addr.port}${HOST_LINK_PATH}`;
  }

  moduleState(): { state: string; reason: string | null } {
    const s = this.sup.list().find((m) => m.id === "cluster");
    if (!s) throw new Error("no cluster module");
    return { state: s.state, reason: s.reason };
  }

  async stop(): Promise<void> {
    await this.sup.stopAll();
    await this.store.close();
  }
}

/** A socket that records its close code. */
export async function open(url: string): Promise<{ ws: WebSocket; closed: Promise<number> }> {
  const ws = new WebSocket(url);
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return { ws, closed };
}

/** A host as hostd will be: hello, welcome, then a peer over the socket. */
export class FakeHost {
  private constructor(
    readonly ws: WebSocket,
    readonly welcome: HostWelcome,
    readonly peer: RpcPeer,
    readonly closed: Promise<number>,
  ) {}

  static async connect(
    url: string,
    hello: { host: string; key: string; name?: string },
    onRequest?: RequestHandler,
  ): Promise<FakeHost> {
    const { ws, closed } = await open(url);
    const welcome = new Promise<HostWelcome>((resolve, reject) => {
      ws.once("message", (data) => resolve(JSON.parse(String(data)) as HostWelcome));
      ws.once("close", (code) => reject(new Error(`closed with ${code} before welcome`)));
    });
    ws.send(
      JSON.stringify({
        protocol: HOST_PROTOCOL_VERSION,
        host: hello.host,
        key: hello.key,
        name: hello.name ?? "pc",
        platform: "win32",
        version: "0.1.0",
      }),
    );
    const got = await welcome;
    const peer = new RpcPeer({
      transport: new WebSocketTransport(ws),
      role: "host",
      timeoutMs: 2_000,
      ...(onRequest ? { onRequest } : {}),
    });
    return new FakeHost(ws, got, peer, closed);
  }

  close(): Promise<number> {
    this.ws.close(1000, "bye");
    return this.closed;
  }
}

/** Makes an approved host and returns its id and key. */
export function approvedHost(
  cluster: ClusterService,
  name: string,
  capabilities: string[],
): { id: string; key: string } {
  const made = cluster.hosts.create({ name, approved: true, capabilities });
  return { id: made.host.id, key: made.key };
}
