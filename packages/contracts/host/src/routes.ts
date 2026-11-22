// The ways Core can reach a host's services (docs/design/v5-hostd.md §16): the `routes.toml` a
// machine's owner writes beside `host.toml`, and what hostd reports of it. A host may have several
// routes; Core measures them, picks the one that fits the work and falls back when one fails.
//
// Kinds:
// - `tailnet`: each service's own port at a private address (Tailscale, a LAN, this machine).
//   Plain HTTP: the network itself is the protection. Real-time work and WebSockets.
// - `direct`: hostd's gateway at a public address and a forwarded port. TLS and the service's own
//   token are required. Real-time work, large files.
// - `tunnel`: hostd's gateway behind a tunnel hostname (Cloudflare). TLS at the tunnel's edge, the
//   service's token at the gateway. A body limit per request, so large files travel in ranges.
//   Not for real-time work.
// - `relay`: the control link itself (§7.1). Always there while the link is up; the fallback.
//
// Every reported field is optional: an older hostd reports none, and a Core that sees none routes
// the host exactly as before (`advertised`, else the relay).

import { z } from "zod";

export const HOST_ROUTE_KINDS = ["tailnet", "direct", "tunnel", "relay"] as const;
export const HostRouteKindSchema = z.enum(HOST_ROUTE_KINDS).meta({ id: "HostRouteKind" });
export type HostRouteKind = z.output<typeof HostRouteKindSchema>;

/** What the gateway and the routes share as constants. */
export const HOST_ROUTE = {
  /** The file beside `host.toml`. */
  FILE: "routes.toml",
  /** A service behind the gateway: `<route url>/svc/<service>/<path>`. */
  SERVICE_PREFIX: "/svc/",
  /** Core's probe of a gateway route: `GET <route url>/_miyoria/probe[?bytes=N]`. */
  PROBE_PATH: "/_miyoria/probe",
  /** The largest throughput sample the gateway sends. */
  MAX_SAMPLE_BYTES: 1024 * 1024,
  /**
   * Every answer the gateway itself makes carries this header (value `gateway`): an answer without
   * it came from something in between (the tunnel's edge, a proxy), never from the service.
   */
  GATEWAY_HEADER: "x-miyoria-route",
  /** The body limit of a `tunnel` route that does not state one, in MB (Cloudflare's). */
  TUNNEL_MAX_BODY_MB: 100,
} as const;

/** Whether a URL's host is this machine (`localhost`, `127.x`, `::1`). */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return host === "localhost" || host === "::1" || /^127\.\d+\.\d+\.\d+$/u.test(host);
}

/**
 * Why a route's base URL may not be used, or `null`. `direct` and `tunnel` need `https:` (plain
 * `http:` only to this machine, for tests and a TLS proxy in front of the gateway); no route URL
 * carries credentials, a query or a fragment.
 */
export function routeUrlProblem(kind: HostRouteKind, url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `不是有效的位址:${url}`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `只能是 http 或 https:${parsed.protocol}`;
  }
  if (parsed.username !== "" || parsed.password !== "") return "位址裡不能有帳號密碼";
  if (parsed.search !== "" || parsed.hash !== "") return "位址裡不能有 ? 或 #";
  if (
    (kind === "direct" || kind === "tunnel") &&
    parsed.protocol !== "https:" &&
    !isLoopbackHost(parsed.hostname)
  ) {
    return `${kind} 一定要用 https(TLS),不接受 http`;
  }
  return null;
}

/** A route name: what the panel shows and what `reach` is keyed by. */
const RouteNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/u, "lower-case letters, digits and -, at most 32");

/** One `[[route]]` of `routes.toml`. */
export const HostRouteDeclSchema = z
  .object({
    /** Default: the kind, then `-2`, `-3` for a second of the same kind. */
    name: RouteNameSchema.optional(),
    kind: HostRouteKindSchema,
    /**
     * `tailnet`: the name or address the services' own ports are reached at (default
     * `[network] advertise`). No scheme, no port.
     */
    address: z.string().min(1).optional(),
    /** `direct` and `tunnel`: the gateway's public base URL, `https://...`. */
    url: z.string().min(1).optional(),
    /** The largest request or response body one request may carry, in MB (`tunnel` default 100). */
    max_body_mb: z.number().positive().optional(),
  })
  .strict()
  .meta({ id: "HostRouteDecl" });
export type HostRouteDecl = z.output<typeof HostRouteDeclSchema>;

/** `[gateway]` of `routes.toml`: hostd's one HTTP(S) entry for `direct` and `tunnel` routes. */
export const HostGatewayConfigSchema = z
  .object({
    /** Where it listens. A non-loopback address needs `tls_cert` and `tls_key`. */
    bind: z.string().min(1).default("127.0.0.1"),
    port: z.number().int().min(1).max(65_535),
    /** PEM files, relative to the workspace: the gateway then speaks HTTPS itself. */
    tls_cert: z.string().min(1).optional(),
    tls_key: z.string().min(1).optional(),
  })
  .strict()
  .meta({ id: "HostGatewayConfig" });
export type HostGatewayConfig = z.output<typeof HostGatewayConfigSchema>;

/** The shape of `routes.toml`. */
export const HostRoutesFileSchema = z
  .object({
    gateway: HostGatewayConfigSchema.optional(),
    route: z.array(HostRouteDeclSchema).default([]),
  })
  .strict()
  .meta({ id: "HostRoutesFile" });
export type HostRoutesFile = z.output<typeof HostRoutesFileSchema>;

/** One route as hostd reports it. */
export const HostRouteSchema = z
  .object({
    name: z.string(),
    kind: HostRouteKindSchema,
    /** The route's base: the gateway's URL (`direct`, `tunnel`), the address (`tailnet`). */
    url: z.string().optional(),
    /** The largest body one request may carry, in bytes; absent: no limit. */
    max_body_bytes: z.number().int().positive().optional(),
    /** Not declared by the owner: `[network] advertise`, Core's own machine, the relay. */
    implicit: z.boolean().optional(),
    /** Why it cannot be used (a plain-HTTP `direct`, the gateway not listening); never used then. */
    problem: z.string().optional(),
  })
  .meta({ id: "HostRoute" });
export type HostRoute = z.output<typeof HostRouteSchema>;
