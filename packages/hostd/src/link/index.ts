// The control link to Core (docs/design/v5-hostd.md §6.1): the daemon's client, and the
// reconnect helpers it is built on, which know nothing about hostd. The daemon's API seam is
// re-exported so a client of this entry needs nothing else of the daemon.

export {
  type Caller,
  type ClusterClient,
  type GuardSource,
  type HostApi,
  HostRpcError,
} from "../api.js";

export {
  CoreLink,
  type CoreLinkLogger,
  type CoreLinkOptions,
  type CoreLinkState,
} from "./core-link.js";
export {
  Backoff,
  type BackoffOptions,
  mayRetry,
  type ReconnectOptions,
  reconnectLoop,
  type SessionEnd,
  sleep,
  Watchdog,
} from "./reconnect.js";
export { HostRelay, type HostRelayLogger, type HostRelayOptions, relayUrl } from "./relay.js";
