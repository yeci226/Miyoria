// The control link (docs/design/v5-hostd.md §5, §6.1): each host's hostd dials Core, proves who
// it is with `hello`, and then both sides speak JSON-RPC over the socket with the extension
// protocol's `RpcPeer`.
//
// The first message must be a valid `hello` within `hello_timeout_ms`: a bad one closes with
// `BAD_HELLO`, an unknown host, wrong key or revoked host with `UNAUTHORIZED`, silence with
// `TIMEOUT`. A second connection of the same host replaces the first (`REPLACED`). Core pings
// every `ping_secs` and drops a host it has heard nothing from for `peer_timeout_secs`.
//
// A pending host (joined, not approved) may connect and report; nothing it reports is used.
//
// What a service of a host asks Core for through its hostd (`cluster.llm`, `cluster.fetch`) is
// checked and run by `ClusterCalls` (`calls.ts`) with what this link knows of the host.
//
// Core tells each approved host where its node links are (`cluster.links`: the voice link for a
// host approved for `voice-room`, the stage link for one approved for `renderer`) when it
// connects, when it is approved and when the values change, so a node never needs its link
// address and token written by hand on a machine that joined.
//
// Who listens to her and which songs are needed now (`cluster.context`, for the GPU arbiter of
// v5-gpu.md §12) goes to every approved host that reports a service providing `sing`, `tts` or
// `asr`, each time the `sing` module sends it (every poll while a song is prepared), and once to
// such a host whose first report arrives while the last one is still fresh.
//
// Binary frames after `welcome` are the relay's (§7.1, `relay.ts`): each connection has its
// channel, and every stream of it fails when the connection ends.

import { EXT_ERROR_CODE } from "@miyoria/contracts/ext";
import {
  HOST_ERROR_CODE,
  HOST_LINK_CLOSE,
  HOST_METHOD,
  HOST_NOTIFICATION,
  HOST_PROTOCOL_VERSION,
  HOST_RELAY_PROTOCOL_ERROR,
  type HostCheckout,
  type HostClusterContext,
  type HostHello,
  HostHelloSchema,
  type HostLinks,
  type HostRemoteUpdate,
  type HostReport,
  HostReportSchema,
  HostServiceEventSchema,
  type HostUpgradeJob,
  type HostWelcome,
  RelaySocketSink,
} from "@miyoria/contracts/host";
import { errorMessage, type Logger } from "@miyoria/runtime/kernel";
import { RpcError, RpcPeer, WebSocketTransport } from "@miyoria/sdk";
import { Events, type Publish } from "@miyoria/types";
import WebSocket, { type RawData } from "ws";
import type { CallerHost, ClusterCalls } from "./calls.js";
import type { ClusterConfig } from "./config.js";
import type { GuardRegistry } from "./guards.js";
import type { EndpointRegistry } from "./registry.js";
import { RelayChannel, RelayError, type RelayHost, type RelayOptions } from "./relay.js";
import { ClusterError, type ClusterTables, type HostRecord } from "./tables.js";

/** How long a close handshake may take before the socket is dropped. */
const CLOSE_GRACE_MS = 2_000;
/** Default timeout of a request Core sends a host. */
const CALL_TIMEOUT_MS = 30_000;
/** The capabilities of the services a GPU arbiter shares the card between. */
const CONTEXT_CAPABILITIES: ReadonlySet<string> = new Set(["sing", "tts", "asr"]);
/**
 * A context this recent is sent to a host that connects: the `sing` module sends one every poll
 * (1.5 s by default) while a song is prepared and none otherwise.
 */
export const CONTEXT_FRESH_MS = 5_000;

/** One connected host. */
export interface HostConnection {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly version: string;
  /** Approved: what it reports is used. */
  readonly approved: boolean;
  /** Epoch ms. */
  readonly since: number;
  /** What its last report says of its checkout; `undefined` from a daemon older than that. */
  readonly checkout?: HostCheckout | null;
  /** Whether it takes `host.upgrade`; `undefined` from an older daemon (it does not). */
  readonly remoteUpdate?: HostRemoteUpdate;
  /** Its running or last update. */
  readonly upgrade?: HostUpgradeJob | null;
}

export interface ClusterLinkOptions {
  config: ClusterConfig;
  tables: ClusterTables;
  registry: EndpointRegistry;
  guards: GuardRegistry;
  /** Publishes as the owning module. */
  publish: Publish;
  /** The module's stop signal. */
  signal: AbortSignal;
  log: Logger;
  /** What `welcome` says Core's version is. */
  coreVersion: string;
  now: () => number;
  /** The relay of HTTP requests over the link (v5-hostd §7.1). */
  relay?: RelayOptions;
  /** Serves `cluster.llm` and `cluster.fetch`; without it they are not found. */
  calls?: ClusterCalls;
  /**
   * Where Core's node links listen and their tokens (`cluster.links`); read whenever a host
   * connects or is approved, and on `refreshLinks`. Without it nothing is sent.
   */
  links?: () => HostLinks["links"];
}

interface Conn {
  readonly id: string;
  readonly name: string;
  readonly platform: string;
  readonly version: string;
  approved: boolean;
  /** The capabilities it is approved for. */
  capabilities: readonly string[];
  /** Its latest report. */
  report: HostReport | null;
  readonly since: number;
  readonly ws: WebSocket;
  readonly peer: RpcPeer;
  /** Requests relayed to its services. */
  readonly relay: RelayChannel;
  /** The first close code wins. */
  closing: { code: number; reason: string } | null;
  /** The last `cluster.links` it was sent, as JSON; `null` before the first. */
  sentLinks: string | null;
  /** It was sent a `cluster.context` on this connection. */
  contextSent: boolean;
}

/** Whether a socket's remote address is this machine. */
export function isLoopbackAddress(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

/** Starts the close handshake; drops the socket if the other side does not answer in time. */
export function closeSocket(ws: WebSocket, code: number, reason: string): void {
  if (ws.readyState === WebSocket.CLOSED) return;
  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    try {
      ws.close(code, reason);
    } catch {
      ws.terminate();
      return;
    }
  }
  setTimeout(() => {
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  }, CLOSE_GRACE_MS).unref();
}

function rawBytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

function rawText(data: RawData): string {
  return rawBytes(data).toString("utf8");
}

type HelloOutcome =
  | { ok: true; hello: HostHello; host: HostRecord }
  | { ok: false; code: number; reason: string };

/** The control link's server side: connections by host name. */
export class ClusterLink {
  readonly #o: ClusterLinkOptions;
  readonly #conns = new Map<string, Conn>();
  /** The last `cluster.context` and when it came (`now()`). */
  #context: { value: HostClusterContext; at: number } | null = null;

  constructor(options: ClusterLinkOptions) {
    this.#o = options;
  }

  /** The hosts connected now, by name. */
  connected(): HostConnection[] {
    return [...this.#conns.values()]
      .map(({ id, name, platform, version, approved, since, report }) => ({
        id,
        name,
        platform,
        version,
        approved,
        since,
        ...(report?.checkout !== undefined ? { checkout: report.checkout } : {}),
        ...(report?.remote_update !== undefined ? { remoteUpdate: report.remote_update } : {}),
        ...(report?.upgrade !== undefined ? { upgrade: report.upgrade } : {}),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  isConnected(name: string): boolean {
    return this.#conns.has(name);
  }

  /** Sends a request to a connected host (`host.info`, `service.*`). Rejects with `RpcError`. */
  call(name: string, method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const conn = this.#conns.get(name);
    if (conn === undefined) {
      return Promise.reject(new ClusterError(`host \`${name}\` is not connected`));
    }
    return conn.peer.request(method, params ?? null, CALL_TIMEOUT_MS, signal);
  }

  /** What the relay needs of a connected host; `null` when it is not connected. */
  relayHost(name: string): RelayHost | null {
    const conn = this.#conns.get(name);
    if (conn === undefined) return null;
    return {
      approved: conn.approved,
      capabilities: conn.capabilities,
      services: conn.report?.services ?? null,
      channel: conn.relay,
    };
  }

  /** The host's approval changed while it may be connected. */
  approvalChanged(host: HostRecord): void {
    const conn = this.#conns.get(host.name);
    if (conn === undefined) return;
    conn.approved = host.status === "approved";
    conn.capabilities = conn.approved ? host.capabilities : [];
    this.#o.registry.setHost(host.name, conn.approved ? host.capabilities : null);
    this.#sendLinks(conn);
    this.#catchUpContext(conn);
  }

  /**
   * `cluster.context`: sent now to every connected, approved host that reports a service
   * providing `sing`, `tts` or `asr` (the hosts that may run a GPU arbiter).
   */
  sendContext(context: HostClusterContext): void {
    this.#context = { value: context, at: this.#o.now() };
    for (const conn of this.#conns.values()) {
      if (this.#wantsContext(conn)) this.#notifyContext(conn, context);
    }
  }

  #wantsContext(conn: Conn): boolean {
    if (!conn.approved || conn.report === null) return false;
    return conn.report.services.some(
      (s) => s.state !== "disabled" && s.provides.some((p) => CONTEXT_CAPABILITIES.has(p)),
    );
  }

  #notifyContext(conn: Conn, context: HostClusterContext): void {
    conn.contextSent = true;
    conn.peer.tryNotify(HOST_NOTIFICATION.ClusterContext, context satisfies HostClusterContext);
  }

  /** A host that came (or became usable) while songs are prepared gets the last context now. */
  #catchUpContext(conn: Conn): void {
    const last = this.#context;
    if (conn.contextSent || last === null || this.#o.now() - last.at > CONTEXT_FRESH_MS) return;
    if (this.#wantsContext(conn)) this.#notifyContext(conn, last.value);
  }

  /** The node links' values may have changed: tells every connected host whose share changed. */
  refreshLinks(): void {
    for (const conn of this.#conns.values()) this.#sendLinks(conn);
  }

  /**
   * Sends `cluster.links` when what this host should know differs from what it was last sent:
   * `voice` for a host approved for `voice-room`, `stage` for one approved for `renderer`. A host
   * that was never sent anything and should know nothing (pending) gets nothing.
   */
  #sendLinks(conn: Conn): void {
    const source = this.#o.links;
    if (source === undefined) return;
    let all: HostLinks["links"];
    try {
      all = source();
    } catch (error) {
      this.#o.log.warn({ err: errorMessage(error) }, "cannot read the node links' values");
      return;
    }
    const links: HostLinks["links"] = {};
    if (conn.approved) {
      if (all.voice !== undefined && conn.capabilities.includes("voice-room")) {
        links.voice = all.voice;
      }
      if (all.stage !== undefined && conn.capabilities.includes("renderer")) {
        links.stage = all.stage;
      }
    }
    const text = JSON.stringify(links);
    if (text === conn.sentLinks) return;
    if (conn.sentLinks === null && Object.keys(links).length === 0) return;
    conn.sentLinks = text;
    conn.peer.notify(HOST_NOTIFICATION.ClusterLinks, { links } satisfies HostLinks);
    this.#o.log.info(
      { host: conn.name, links: Object.keys(links) },
      "told a host where the node links are",
    );
  }

  /** Closes a host's link (revoked, removed). */
  disconnect(name: string, code: number, reason: string): void {
    const conn = this.#conns.get(name);
    if (conn !== undefined) this.#shutdown(conn, code, reason);
  }

  /** Closes every link (module stop). */
  closeAll(): void {
    for (const conn of [...this.#conns.values()]) {
      this.#shutdown(conn, HOST_LINK_CLOSE.GOING_AWAY, "core shutting down");
    }
  }

  /**
   * Runs the protocol on a freshly upgraded socket. `remote`: the address it came from, which
   * tells a host on Core's own machine from one elsewhere (v5-hostd §15).
   */
  serve(ws: WebSocket, from: { remote?: string | undefined } = {}): void {
    const o = this.#o;
    let phase: "hello" | "open" | "done" = "hello";
    const helloTimer = setTimeout(
      () => reject(HOST_LINK_CLOSE.TIMEOUT, "no hello in time"),
      o.config.hello_timeout_ms,
    );
    const onAbort = () => reject(HOST_LINK_CLOSE.GOING_AWAY, "core shutting down");
    const endHello = () => {
      clearTimeout(helloTimer);
      o.signal.removeEventListener("abort", onAbort);
      ws.off("message", onHello);
      ws.off("close", onEarlyClose);
    };
    const reject = (code: number, reason: string) => {
      if (phase !== "hello") return;
      phase = "done";
      endHello();
      o.log.warn({ code, reason }, "refused a host link");
      closeSocket(ws, code, reason);
    };
    const onHello = (data: RawData, isBinary: boolean) => {
      if (phase !== "hello") return;
      if (isBinary) {
        reject(HOST_LINK_CLOSE.BAD_HELLO, "expected hello");
        return;
      }
      const outcome = this.#readHello(rawText(data));
      if (!outcome.ok) {
        reject(outcome.code, outcome.reason);
        return;
      }
      phase = "open";
      endHello();
      this.#open(ws, outcome.hello, outcome.host, from.remote);
    };
    const onEarlyClose = () => {
      if (phase !== "hello") return;
      phase = "done";
      endHello();
    };
    ws.on("error", (error: Error) => o.log.debug({ err: errorMessage(error) }, "host link error"));
    if (o.signal.aborted) {
      reject(HOST_LINK_CLOSE.GOING_AWAY, "core shutting down");
      return;
    }
    o.signal.addEventListener("abort", onAbort, { once: true });
    ws.on("message", onHello);
    ws.on("close", onEarlyClose);
  }

  #readHello(text: string): HelloOutcome {
    const refuse = (code: number, reason: string): HelloOutcome => ({ ok: false, code, reason });
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return refuse(HOST_LINK_CLOSE.BAD_HELLO, "invalid JSON");
    }
    const parsed = HostHelloSchema.safeParse(value);
    if (!parsed.success) return refuse(HOST_LINK_CLOSE.BAD_HELLO, "malformed hello");
    const hello = parsed.data;
    // The key before anything else, so a stranger learns nothing more.
    if (!this.#o.tables.hosts.verify(hello.host, hello.key)) {
      return refuse(HOST_LINK_CLOSE.UNAUTHORIZED, "unknown host or wrong key");
    }
    if (hello.protocol !== HOST_PROTOCOL_VERSION) {
      return refuse(
        HOST_LINK_CLOSE.BAD_HELLO,
        `protocol ${hello.protocol} is not supported (${HOST_PROTOCOL_VERSION} is)`,
      );
    }
    const host = this.#o.tables.hosts.get(hello.host);
    if (host === null || host.status === "revoked") {
      return refuse(HOST_LINK_CLOSE.UNAUTHORIZED, "unknown host or wrong key");
    }
    return { ok: true, hello, host };
  }

  #open(ws: WebSocket, hello: HostHello, host: HostRecord, remote: string | undefined): void {
    const o = this.#o;
    const approved = host.status === "approved";
    const welcome: HostWelcome = {
      protocol: HOST_PROTOCOL_VERSION,
      core_version: o.coreVersion,
      host: host.name,
      approved: approved ? host.capabilities : [],
    };
    // Welcome goes out before anything else on this connection.
    ws.send(JSON.stringify(welcome));
    try {
      o.tables.hosts.seen(host.id, { platform: hello.platform, version: hello.version });
    } catch (error) {
      o.log.warn({ host: host.name, err: errorMessage(error) }, "cannot record the host's visit");
    }
    if (hello.name !== host.name) {
      o.log.info(
        { host: host.name, calls_itself: hello.name },
        "a host calls itself by another name; Core's name is used",
      );
    }

    let conn: Conn | null = null;
    const peer = new RpcPeer({
      transport: new WebSocketTransport(ws),
      role: "host",
      onRequest: (method, params, signal) => this.#onRequest(host.name, method, params, signal),
      onNotification: (method, params) => {
        if (conn !== null) this.#onNotification(conn, method, params);
      },
      onError: (what, error, method) =>
        o.log.debug({ host: host.name, what, method, err: errorMessage(error) }, "host link"),
    });
    const relay = new RelayChannel({
      host: host.name,
      peer,
      sink: new RelaySocketSink(ws),
      onProtocolError: (reason) => {
        o.log.warn({ host: host.name, reason }, "a host broke the relay protocol");
        if (conn !== null) this.#shutdown(conn, HOST_RELAY_PROTOCOL_ERROR, "relay protocol error");
      },
      ...(o.relay?.maxStreams === undefined ? {} : { maxStreams: o.relay.maxStreams }),
      ...(o.relay?.timeoutMs === undefined ? {} : { timeoutMs: o.relay.timeoutMs }),
    });
    conn = {
      id: host.id,
      name: host.name,
      platform: hello.platform,
      version: hello.version,
      approved,
      capabilities: approved ? host.capabilities : [],
      report: null,
      since: o.now(),
      ws,
      peer,
      relay,
      closing: null,
      sentLinks: null,
      contextSent: false,
    };
    // Binary frames are the relay's; JSON-RPC reads the text frames.
    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) relay.frame(rawBytes(data));
    });
    const old = this.#conns.get(host.name);
    this.#conns.set(host.name, conn);
    if (old !== undefined) {
      o.log.info({ host: host.name }, "host link replaced by a newer connection");
      this.#shutdown(old, HOST_LINK_CLOSE.REPLACED, "replaced by a newer connection");
    }
    o.registry.setHost(host.name, approved ? host.capabilities : null);
    if (remote !== undefined) o.registry.setLink(host.name, { local: isLoopbackAddress(remote) });
    o.log.info({ host: host.name, approved, platform: hello.platform }, "host connected");
    o.publish(Events.ClusterHostConnected, {
      host: host.name,
      platform: hello.platform,
      version: hello.version,
      approved,
    });
    this.#sendLinks(conn);
    const stopBeat = this.#heartbeat(conn);
    const current = conn;
    ws.on("close", (code: number, reason: Buffer) => {
      stopBeat();
      relay.close(new RelayError(`the link to host \`${current.name}\` closed`));
      peer.close();
      const closing = current.closing ?? { code, reason: reason.toString("utf8") };
      if (this.#conns.get(current.name) === current) {
        this.#conns.delete(current.name);
        o.registry.removeHost(current.name);
      }
      o.log.info({ host: current.name, code: closing.code }, "host disconnected");
      o.publish(Events.ClusterHostDisconnected, {
        host: current.name,
        code: closing.code,
        reason: closing.reason,
      });
    });
  }

  /** Pings, the peer timeout and module shutdown. Returns the teardown. */
  #heartbeat(conn: Conn): () => void {
    const o = this.#o;
    const { ws } = conn;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(deadline);
      deadline = setTimeout(() => {
        o.log.warn({ host: conn.name }, "host link timed out");
        this.#shutdown(conn, HOST_LINK_CLOSE.TIMEOUT, "heartbeat timeout");
      }, o.config.peer_timeout_secs * 1000);
    };
    bump();
    // The round trip of each ping, for the hosts nearest Core (v5-hostd §15).
    let pingAt: number | null = null;
    const ping = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      pingAt = o.now();
      ws.ping();
    }, o.config.ping_secs * 1000);
    const onPong = () => {
      if (pingAt === null) return;
      o.registry.setLink(conn.name, { rttMs: Math.max(0, o.now() - pingAt) });
      pingAt = null;
    };
    ws.on("pong", onPong);
    const onAbort = () => this.#shutdown(conn, HOST_LINK_CLOSE.GOING_AWAY, "core shutting down");
    o.signal.addEventListener("abort", onAbort, { once: true });
    // Any traffic, control frames too, shows the host is alive.
    ws.on("message", bump);
    ws.on("ping", bump);
    ws.on("pong", bump);
    return () => {
      clearTimeout(deadline);
      clearInterval(ping);
      o.signal.removeEventListener("abort", onAbort);
      ws.off("message", bump);
      ws.off("ping", bump);
      ws.off("pong", bump);
      ws.off("pong", onPong);
    };
  }

  #shutdown(conn: Conn, code: number, reason: string): void {
    conn.closing ??= { code, reason };
    closeSocket(conn.ws, conn.closing.code, conn.closing.reason);
  }

  /** The caller as `ClusterCalls` needs it; refused when its connection is gone. */
  #caller(name: string): CallerHost {
    const conn = this.#conns.get(name);
    if (conn === undefined) throw new RpcError(HOST_ERROR_CODE.NotAllowed, "not connected");
    return {
      name: conn.name,
      approved: conn.approved,
      capabilities: conn.capabilities,
      services: conn.report?.services ?? null,
    };
  }

  async #onRequest(
    name: string,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    const o = this.#o;
    switch (method) {
      case HOST_METHOD.ClusterLlm:
        if (o.calls === undefined) break;
        return o.calls.llm(this.#caller(name), params, signal);
      case HOST_METHOD.ClusterFetch:
        if (o.calls === undefined) break;
        return o.calls.fetch(this.#caller(name), params, signal);
      case HOST_METHOD.ClusterGuard: {
        const states = await o.guards.active((error) =>
          o.log.warn({ err: errorMessage(error) }, "a guard source failed"),
        );
        return { states };
      }
      case HOST_METHOD.ClusterResolve:
        // Endpoints carry their tokens: only for what the asking service was granted (`uses`).
        if (o.calls === undefined) {
          throw new RpcError(HOST_ERROR_CODE.NotAllowed, "Core resolves nothing for hosts");
        }
        return o.calls.resolve(this.#caller(name), params);
    }
    throw new RpcError(EXT_ERROR_CODE.MethodNotFound, `unknown method "${method}"`);
  }

  /** Logs an update of the host that ended since its last report (v5-hostd §14). */
  #upgradeEnded(conn: Conn, before: HostUpgradeJob | null, after: HostUpgradeJob | null): void {
    if (after === null || after.finished_at === undefined) return;
    if (before !== null && before.id === after.id && before.finished_at !== undefined) return;
    const fields = {
      host: conn.name,
      job: after.id,
      state: after.state,
      from: after.from,
      target: after.target,
      commit: after.commit ?? null,
      error: after.error ?? null,
    };
    if (after.state === "done") this.#o.log.info(fields, "a host finished its update");
    else this.#o.log.warn(fields, "a host's update did not finish");
  }

  #onNotification(conn: Conn, method: string, params: unknown): void {
    const o = this.#o;
    switch (method) {
      case HOST_NOTIFICATION.Report: {
        const parsed = HostReportSchema.safeParse(params);
        if (!parsed.success) {
          o.log.warn({ host: conn.name, err: parsed.error.message }, "a host sent a bad report");
          return;
        }
        if (this.#conns.get(conn.name) !== conn) return;
        this.#upgradeEnded(conn, conn.report?.upgrade ?? null, parsed.data.upgrade ?? null);
        conn.report = parsed.data;
        o.registry.report(conn.name, parsed.data);
        this.#catchUpContext(conn);
        return;
      }
      case HOST_NOTIFICATION.ServiceEvent: {
        const parsed = HostServiceEventSchema.safeParse(params);
        if (!parsed.success) {
          o.log.warn({ host: conn.name, err: parsed.error.message }, "a host sent a bad event");
          return;
        }
        const event = parsed.data;
        o.publish(Events.ClusterServiceState, {
          host: conn.name,
          service: event.service,
          state: event.state,
          previous: event.previous,
          reason: event.reason ?? null,
        });
        return;
      }
      default:
        o.log.debug({ host: conn.name, method }, "a host sent an unknown notification");
    }
  }
}
