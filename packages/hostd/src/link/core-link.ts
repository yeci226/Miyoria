// The daemon's end of the control link (docs/design/v5-hostd.md §5, §6.1): dials Core, says
// `hello`, waits for `welcome`, then speaks JSON-RPC with the SDK's peer over the socket.
//
// While connected it reports the host (`host.report`, with service tokens), forwards every
// service state change (`service.event`, each followed by a fresh report, at most one report per
// `reportMs`), serves Core's requests through `HostApi.call` as caller `core`, and gives the daemon
// a cluster client and a guard source that ask Core; where Core's node links are (`cluster.links`)
// goes to `HostApi.setLinks`, who listens (`cluster.context`) to `HostApi.setContext`. Requests Core relays to a service of this
// machine (`relay.request` and the binary frames, §7.1) are served by `HostRelay`, whose fetches
// are aborted when the link drops. When the link drops the client and the source are taken away and
// it dials again with backoff; after `UNAUTHORIZED` or `BAD_HELLO` it stops for good, and after
// `REPLACED` too (another daemon holds this host's key).

import {
  HOST_LINK_CLOSE,
  HOST_METHOD,
  HOST_NOTIFICATION,
  HOST_PROTOCOL_VERSION,
  HOST_RELAY_METHOD,
  HOST_RELAY_PROTOCOL_ERROR,
  HostClusterContextSchema,
  HostGuardResultSchema,
  type HostGuardState,
  type HostHello,
  HostLinksSchema,
  HostServiceLogsSchema,
  type HostWelcome,
  HostWelcomeSchema,
  RelaySocketSink,
} from "@miyoria/contracts/host";
import { RpcError, RpcPeer, WebSocketTransport } from "@miyoria/sdk";
import WebSocket, { type RawData } from "ws";
import { type Caller, type HostApi, HostRpcError } from "../api.js";
import { mayRetry, reconnectLoop, type SessionEnd, Watchdog } from "./reconnect.js";
import { HostRelay } from "./relay.js";

/** Where the link is. */
export type CoreLinkState = "connecting" | "connected" | "unauthorized" | "stopped";

/** What the link logs through; a pino logger fits. */
export interface CoreLinkLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
  debug(fields: object, message: string): void;
}

export interface CoreLinkOptions {
  /** `ws://<core>/cluster-link`. */
  url: string;
  /** The id Core gave this host. */
  hostId: string;
  /** The host key, from `<state>/host.key`. */
  key: string;
  /** What this host calls itself; Core's name for it comes back in `welcome`. */
  name: string;
  platform: string;
  /** hostd's version. */
  version: string;
  logger?: CoreLinkLogger;
  /** Opens the socket (tests, a proxy). Default a `ws` client. */
  webSocket?: (url: string) => WebSocket;
  /** At most one report per this many ms. Default 200. */
  reportMs?: number;
  /** First backoff wait. Default 1 000 ms. */
  retryInitialMs?: number;
  /** Longest backoff wait. Default 30 000 ms. */
  retryMaxMs?: number;
  /** How long `welcome` may take. Default 10 000 ms. */
  welcomeTimeoutMs?: number;
  /** Core pings every 15 s; nothing at all from it for this long and the link is redialled. Default 60 000 ms. */
  silenceMs?: number;
  /** Timeout of a request to Core. Default 30 000 ms. */
  requestTimeoutMs?: number;
}

/** Close codes after which the link is not dialled again. */
const FINAL: readonly number[] = [
  HOST_LINK_CLOSE.UNAUTHORIZED,
  HOST_LINK_CLOSE.BAD_HELLO,
  HOST_LINK_CLOSE.REPLACED,
];
const UNAUTHORIZED: readonly number[] = [HOST_LINK_CLOSE.UNAUTHORIZED, HOST_LINK_CLOSE.BAD_HELLO];
/** Largest message: the same cap as Core's. */
const MAX_MESSAGE = 16 * 1024 * 1024;
const CORE: Caller = { kind: "core" };

const quiet: CoreLinkLogger = { info: () => {}, warn: () => {}, debug: () => {} };

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function bytes(data: RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  return data instanceof ArrayBuffer ? Buffer.from(data) : data;
}

function text(data: RawData): string {
  return bytes(data).toString("utf8");
}

/** A failure of a request to Core, as the daemon's API speaks it. */
function hostError(error: unknown): unknown {
  return error instanceof RpcError
    ? new HostRpcError(error.code, error.message, error.data)
    : error;
}

/** A failure of the daemon's API, as JSON-RPC speaks it. */
function rpcError(error: unknown): unknown {
  return error instanceof HostRpcError
    ? new RpcError(error.code, error.message, error.data)
    : error;
}

export class CoreLink {
  readonly #api: HostApi;
  readonly #o: CoreLinkOptions;
  readonly #log: CoreLinkLogger;
  readonly #listeners = new Set<(state: CoreLinkState) => void>();
  #state: CoreLinkState = "stopped";
  #welcome: HostWelcome | null = null;
  #stop: AbortController | null = null;
  #loop: Promise<void> | null = null;

  constructor(api: HostApi, options: CoreLinkOptions) {
    this.#api = api;
    this.#o = options;
    this.#log = options.logger ?? quiet;
  }

  get state(): CoreLinkState {
    return this.#state;
  }

  /** Core's last `welcome`; `null` before the first one. */
  get welcome(): HostWelcome | null {
    return this.#welcome;
  }

  /** Calls `listener` on every state change. Returns the unsubscribe. */
  onState(listener: (state: CoreLinkState) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Starts dialling. Does nothing while it is already running. */
  start(): void {
    if (this.#stop !== null) return;
    const stop = new AbortController();
    this.#stop = stop;
    this.#setState("connecting");
    this.#loop = reconnectLoop({
      signal: stop.signal,
      initialMs: this.#o.retryInitialMs ?? 1_000,
      maxMs: this.#o.retryMaxMs ?? 30_000,
      session: (signal) => this.#session(signal),
      onWait: (delay, attempt) =>
        this.#log.debug({ delay_ms: delay, attempt }, "dialling Core again after a wait"),
    }).finally(() => {
      if (this.#stop === stop) this.#stop = null;
      if (this.#state !== "unauthorized") this.#setState("stopped");
    });
  }

  /** Closes the link and stops dialling. */
  async stop(): Promise<void> {
    this.#stop?.abort();
    await this.#loop;
    this.#loop = null;
    if (this.#state !== "unauthorized") this.#setState("stopped");
  }

  #setState(state: CoreLinkState): void {
    if (this.#state === state) return;
    this.#state = state;
    for (const listener of [...this.#listeners]) {
      try {
        listener(state);
      } catch (error) {
        this.#log.debug({ err: messageOf(error) }, "a link state listener failed");
      }
    }
  }

  /** One connection, from dialling to its close. */
  #session(signal: AbortSignal): Promise<SessionEnd> {
    const o = this.#o;
    this.#setState("connecting");
    return new Promise<SessionEnd>((resolve) => {
      let established = false;
      let settled = false;
      const cleanups: Array<() => void> = [];
      const socket =
        o.webSocket?.(o.url) ??
        new WebSocket(o.url, {
          perMessageDeflate: false,
          maxPayload: MAX_MESSAGE,
          handshakeTimeout: o.welcomeTimeoutMs ?? 10_000,
        });
      const finish = (end: SessionEnd) => {
        if (settled) return;
        settled = true;
        for (const cleanup of cleanups.splice(0).reverse()) cleanup();
        resolve(end);
      };
      const welcomeTimer = setTimeout(() => {
        this.#log.warn({ url: o.url }, "Core did not answer hello in time");
        socket.terminate();
      }, o.welcomeTimeoutMs ?? 10_000);
      cleanups.push(() => clearTimeout(welcomeTimer));
      const watchdog = new Watchdog(o.silenceMs ?? 60_000, () => {
        this.#log.warn({ url: o.url }, "nothing from Core for too long; dialling again");
        socket.terminate();
      });
      cleanups.push(() => watchdog.stop());
      const bump = () => watchdog.bump();
      socket.on("ping", bump);
      socket.on("pong", bump);
      socket.on("message", bump);

      const onAbort = () => {
        try {
          socket.close(1000, "hostd stopping");
        } catch {
          socket.terminate();
        }
        // The close handshake ends the session; drop it if Core does not answer.
        setTimeout(() => socket.terminate(), 2_000).unref();
      };
      if (signal.aborted) {
        socket.terminate();
        finish({ retry: false, established: false });
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => signal.removeEventListener("abort", onAbort));

      socket.on("open", () => {
        const hello: HostHello = {
          protocol: HOST_PROTOCOL_VERSION,
          host: o.hostId,
          key: o.key,
          name: o.name,
          platform: o.platform,
          version: o.version,
        };
        socket.send(JSON.stringify(hello));
      });
      const onWelcome = (data: RawData, isBinary: boolean) => {
        socket.off("message", onWelcome);
        clearTimeout(welcomeTimer);
        let welcome: HostWelcome;
        try {
          if (isBinary) throw new Error("a binary frame");
          welcome = HostWelcomeSchema.parse(JSON.parse(text(data)));
        } catch (error) {
          this.#log.warn({ err: messageOf(error) }, "Core's answer to hello is not a welcome");
          socket.close(1002, "expected welcome");
          return;
        }
        established = true;
        this.#welcome = welcome;
        // The peer takes the socket over before the next message can arrive.
        cleanups.push(this.#connected(socket, welcome));
        this.#setState("connected");
        this.#log.info(
          { url: o.url, host: welcome.host, approved: welcome.approved },
          "connected to Core",
        );
      };
      socket.on("message", onWelcome);
      socket.on("error", (error) => this.#log.debug({ err: messageOf(error) }, "Core link error"));
      socket.on("close", (code: number, reason: Buffer) => {
        const why = reason.toString("utf8");
        if (UNAUTHORIZED.includes(code)) {
          this.#log.warn(
            { url: o.url, code, reason: why },
            "Core refused this host; not dialling again until the daemon restarts",
          );
          this.#setState("unauthorized");
        } else if (code === HOST_LINK_CLOSE.REPLACED) {
          this.#log.warn(
            { url: o.url },
            "another daemon connected with this host's key; this one stops dialling",
          );
        } else if (established) {
          this.#log.info({ url: o.url, code, reason: why }, "disconnected from Core");
        }
        const retry = !signal.aborted && mayRetry(code, FINAL);
        if (retry) this.#setState("connecting");
        finish({ retry, established });
      });
    });
  }

  /** Runs the protocol on a welcomed socket. Returns the teardown. */
  #connected(socket: WebSocket, _welcome: HostWelcome): () => void {
    const api = this.#api;
    const timeout = this.#o.requestTimeoutMs ?? 30_000;
    // Requests Core relays to a service of this machine; their bodies are the binary frames.
    const relay = new HostRelay({
      api,
      sink: new RelaySocketSink(socket),
      onProtocolError: (reason) => {
        this.#log.warn({ reason }, "Core broke the relay protocol; closing the link");
        socket.close(HOST_RELAY_PROTOCOL_ERROR, "relay protocol error");
      },
      logger: this.#log,
    });
    const onBinary = (data: RawData, isBinary: boolean) => {
      if (isBinary) relay.frame(bytes(data));
    };
    socket.on("message", onBinary);
    const peer: RpcPeer = new RpcPeer({
      transport: new WebSocketTransport(socket),
      role: "host",
      timeoutMs: timeout,
      onRequest: (method, params, signal) =>
        method === HOST_RELAY_METHOD
          ? relay.handle(params, signal).catch((error: unknown) => {
              throw rpcError(error);
            })
          : this.#serve(peer, method, params, signal),
      onNotification: (method, params) => this.#notified(method, params),
      onError: (what, error, method) =>
        this.#log.debug({ what, method, err: messageOf(error) }, "Core link"),
    });

    api.setClusterClient({
      call: async (method, params, signal, timeoutMs) => {
        try {
          return await peer.request(method, params, timeoutMs, signal);
        } catch (error) {
          throw hostError(error);
        }
      },
    });
    api.setGuardSource({
      states: async (signal): Promise<HostGuardState[]> => {
        try {
          const result = await peer.request(HOST_METHOD.ClusterGuard, {}, undefined, signal);
          return HostGuardResultSchema.parse(result).states;
        } catch (error) {
          throw hostError(error);
        }
      },
    });

    // Reports: the first at once, then at most one per `reportMs`.
    const every = this.#o.reportMs ?? 200;
    let last = Number.NEGATIVE_INFINITY;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sendReport = () => {
      last = Date.now();
      try {
        peer.notify(HOST_NOTIFICATION.Report, api.report({ withTokens: true }));
      } catch (error) {
        this.#log.warn({ err: messageOf(error) }, "cannot build the host report");
      }
    };
    const report = () => {
      if (timer !== null) return;
      const wait = last + every - Date.now();
      if (wait <= 0) {
        sendReport();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        sendReport();
      }, wait);
    };
    sendReport();
    const unsubscribe = api.onEvent((event) => {
      peer.notify(HOST_NOTIFICATION.ServiceEvent, event);
      report();
    });
    // A health change alone is not an event, and Core's registry reads health from the report.
    const unwatch = api.onChange?.(() => report());

    return () => {
      unsubscribe();
      unwatch?.();
      if (timer !== null) clearTimeout(timer);
      api.setClusterClient(null);
      api.setGuardSource(null);
      socket.off("message", onBinary);
      relay.close();
      peer.close();
    };
  }

  /** One of Core's notifications. */
  #notified(method: string, params: unknown): void {
    if (method === HOST_NOTIFICATION.ClusterLinks) {
      const parsed = HostLinksSchema.safeParse(params);
      if (!parsed.success) {
        this.#log.warn({ err: parsed.error.message }, "Core sent bad cluster.links");
        return;
      }
      this.#api.setLinks?.(parsed.data.links);
      return;
    }
    if (method === HOST_NOTIFICATION.ClusterContext) {
      const parsed = HostClusterContextSchema.safeParse(params);
      if (!parsed.success) {
        this.#log.warn({ err: parsed.error.message }, "Core sent bad cluster.context");
        return;
      }
      this.#api.setContext?.(parsed.data);
      return;
    }
    this.#log.debug({ method }, "Core sent a notification hostd does not use yet");
  }

  /** Answers one of Core's requests. */
  async #serve(
    peer: RpcPeer,
    method: string,
    params: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    try {
      if (method === HOST_METHOD.ServiceLogs) {
        const parsed = HostServiceLogsSchema.safeParse(params ?? {});
        if (parsed.success && parsed.data.follow)
          return await this.#follow(peer, parsed.data, signal);
      }
      return await this.#api.call(method, params, CORE, signal);
    } catch (error) {
      throw rpcError(error);
    }
  }

  /**
   * `service.logs` with `follow`: the last lines, then every new one, as `service.log`
   * notifications until Core cancels the request.
   */
  async #follow(
    peer: RpcPeer,
    params: { service: string; lines: number },
    signal: AbortSignal,
  ): Promise<never> {
    const send = (line: string) =>
      peer.tryNotify(HOST_NOTIFICATION.ServiceLog, { service: params.service, line });
    // Lines written while the tail is read wait, so none is lost or sent twice out of order.
    let held: string[] | null = [];
    const unfollow = this.#api.followLogs(params.service, (line) => {
      if (held !== null) held.push(line);
      else send(line);
    });
    try {
      const tail = (await this.#api.call(
        HOST_METHOD.ServiceLogs,
        { service: params.service, lines: params.lines, follow: false },
        CORE,
        signal,
      )) as { lines?: unknown };
      const lines = Array.isArray(tail?.lines) ? tail.lines : [];
      for (const line of lines) if (typeof line === "string") send(line);
      for (const line of held) send(line);
      held = null;
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      throw signal.reason ?? new Error("cancelled");
    } finally {
      unfollow();
    }
  }
}
