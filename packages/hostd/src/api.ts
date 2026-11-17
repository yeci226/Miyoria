// The seam between the daemon and whatever talks to it: the local API (CLI and the services of
// this machine) and the control link to Core. The daemon implements `HostApi`; the transports
// only move messages (docs/design/v5-hostd.md §5).

import type {
  HostClusterContext,
  HostGuardState,
  HostLinks,
  HostReport,
  HostServiceEvent,
} from "@miyoria/contracts/host";

/** Who is calling. Decides which methods are allowed. */
export type Caller =
  | { kind: "operator" } // the CLI on this machine
  | { kind: "core" } // Core, over the control link
  | { kind: "service"; service: string }; // a service of this machine, by its token

/** A failed call. `code` is one of `HOST_ERROR_CODE` or a JSON-RPC standard code. */
export class HostRpcError extends Error {
  override name = "HostRpcError";
  readonly code: number;
  readonly data: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

/** Where the guarded states of the cluster come from ("singing", "live"). */
export interface GuardSource {
  states(signal?: AbortSignal): Promise<HostGuardState[]>;
}

/** The `cluster.*` methods Core serves. Present while the control link is up. */
export interface ClusterClient {
  /** `timeoutMs`: how long Core may take; default the link's request timeout. */
  call(method: string, params: unknown, signal?: AbortSignal, timeoutMs?: number): Promise<unknown>;
}

export interface HostApi {
  /** The full snapshot, as `host.report` carries it. Service tokens only when asked for. */
  report(options: { withTokens: boolean }): HostReport;
  /** Runs one method of the host protocol. Throws `HostRpcError`. */
  call(method: string, params: unknown, caller: Caller, signal?: AbortSignal): Promise<unknown>;
  /** Every service state change, for `service.event`. Returns the unsubscribe function. */
  onEvent(listener: (event: HostServiceEvent) => void): () => void;
  /**
   * Any change of what `report` returns (a state, health, a port), for `host.report`. Optional:
   * added by H2 for health changes, which `onEvent` does not carry.
   */
  onChange?(listener: () => void): () => void;
  /** Log lines of one service as they are written, for `service.log`. */
  followLogs(service: string, listener: (line: string) => void): () => void;
  /**
   * Where a running service of this machine listens and what it expects in a request: for
   * requests Core relays over the control link. `null` when it is not running or has no port.
   */
  target(service: string): { url: string; headers: Record<string, string> } | null;
  /** The control link sets this while it is connected; `null` puts the default source back. */
  setGuardSource(source: GuardSource | null): void;
  /** The control link sets this while it is connected. */
  setClusterClient(client: ClusterClient | null): void;
  /** Where Core's node links are (`cluster.links`), each time Core sends them. Optional (H4b). */
  setLinks?(links: HostLinks["links"]): void;
  /**
   * Who listens and which songs are needed now (`cluster.context`), each time Core sends it, for
   * the GPU arbiter. Optional (H7).
   */
  setContext?(context: HostClusterContext): void;
}
