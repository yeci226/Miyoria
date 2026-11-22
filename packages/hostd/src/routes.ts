// `routes.toml` (docs/design/v5-hostd.md §16): the ways Core may reach this machine's services,
// written by the machine's owner beside `host.toml`. Read once at start; `miyoria down` and `up`
// apply a change. A file that does not load is one problem for the whole file: the host then
// reports no routes and Core routes it as before (`[network] advertise`, else the relay).
//
// It is its own file, not a table of `host.toml`, for the reason of §15.1: an older hostd's
// `host.toml` schema is strict, and a remote update would leave such a hostd reading a file it
// refuses. An older hostd never opens `routes.toml`.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  HOST_ROUTE,
  type HostGatewayConfig,
  type HostRoute,
  type HostRouteKind,
  HostRoutesFileSchema,
  isLoopbackHost,
  routeUrlProblem,
} from "@miyoria/contracts/host";
import { parse as parseToml } from "smol-toml";
import { urlHost } from "./ports.js";

const MB = 1024 * 1024;

/** One route as this host serves it. */
export interface RoutePlan {
  name: string;
  kind: HostRouteKind;
  /** `tailnet`: the address; `direct`, `tunnel`: the gateway's public URL without a trailing `/`. */
  base: string | null;
  maxBodyBytes: number | null;
  implicit: boolean;
  /** Why it cannot be used; it is reported with this and never used. */
  problem: string | null;
}

/** The gateway as `routes.toml` asks for it. */
export interface GatewayPlan {
  bind: string;
  port: number;
  /** Absolute PEM paths, both or neither. */
  tls: { cert: string; key: string } | null;
}

export interface LoadedRoutes {
  /** The file, absolute. */
  file: string;
  routes: RoutePlan[];
  /** `null` when no route needs one, or `[gateway]` is missing or wrong (see `problems`). */
  gateway: GatewayPlan | null;
  /** Problems of the file as a whole (it did not load, the gateway is wrong). */
  problems: string[];
}

export interface RouteContext {
  workspace: string;
  /** `[network] advertise`. */
  advertise: string | undefined;
  /** `[network] bind`: where the services listen. */
  bind: string;
}

function loopbackBind(bind: string): boolean {
  return isLoopbackHost(bind);
}

/** A tailnet address: a host name or an IP, no scheme, no port, no path. */
function addressProblem(address: string): string | null {
  if (/[/\s@?#]/u.test(address) || address.includes("://")) {
    return `address 只能是名字或 IP,不含 http:// 和路徑:${address}`;
  }
  if (!address.startsWith("[") && /^[^:]+:\d+$/u.test(address)) {
    return `address 不含埠(每個服務用自己的埠):${address}`;
  }
  return null;
}

/**
 * The routes of `routes.toml` in `workspace`, with the implicit ones: `advertise` (a `tailnet`
 * route from `[network] advertise` when the file names no `tailnet` route) and `relay`. `null`
 * when there is no file: the host reports nothing new and is routed exactly as before.
 */
export function loadRoutes(ctx: RouteContext): LoadedRoutes | null {
  const file = resolve(ctx.workspace, HOST_ROUTE.FILE);
  if (!existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = parseToml(readFileSync(file, "utf8"));
  } catch (error) {
    return failed(file, ctx, `${HOST_ROUTE.FILE} 不是有效的 TOML:${messageOf(error)}`);
  }
  const parsed = HostRoutesFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => {
      const path = issue.path.map(String).join(".");
      return path === "" ? issue.message : `${path}: ${issue.message}`;
    });
    return failed(file, ctx, `${HOST_ROUTE.FILE}:${issues.join("; ")}`);
  }
  const problems: string[] = [];
  const routes: RoutePlan[] = [];
  const taken = new Set<string>();
  const count = new Map<HostRouteKind, number>();
  for (const decl of parsed.data.route) {
    const n = (count.get(decl.kind) ?? 0) + 1;
    count.set(decl.kind, n);
    const name = decl.name ?? (n === 1 ? decl.kind : `${decl.kind}-${n}`);
    if (taken.has(name)) {
      problems.push(`兩條路線都叫 ${name}`);
      continue;
    }
    taken.add(name);
    const limit =
      decl.max_body_mb ?? (decl.kind === "tunnel" ? HOST_ROUTE.TUNNEL_MAX_BODY_MB : undefined);
    const maxBodyBytes = limit === undefined ? null : Math.floor(limit * MB);
    let base: string | null = null;
    let problem: string | null = null;
    switch (decl.kind) {
      case "tailnet": {
        const address = decl.address ?? ctx.advertise;
        if (decl.url !== undefined) problem = "tailnet 路線用 address,不用 url";
        else if (address === undefined) {
          problem = "tailnet 路線要寫 address(或 host.toml 的 [network] advertise)";
        } else {
          problem = addressProblem(address);
          base = address;
        }
        if (problem === null && loopbackBind(ctx.bind) && !isLoopbackHost(address ?? "")) {
          problem = `服務只聽 ${ctx.bind},別台連不到:host.toml 的 [network] bind 要改成 tailnet 的位址`;
        }
        break;
      }
      case "direct":
      case "tunnel": {
        if (decl.address !== undefined) problem = `${decl.kind} 路線用 url,不用 address`;
        else if (decl.url === undefined) problem = `${decl.kind} 路線要寫 url(https://...)`;
        else {
          base = decl.url.replace(/\/+$/u, "");
          problem = routeUrlProblem(decl.kind, base);
        }
        break;
      }
      case "relay":
        if (decl.address !== undefined || decl.url !== undefined) {
          problem = "relay 路線不用位址:它就是控制連線";
        }
        break;
    }
    routes.push({ name, kind: decl.kind, base, maxBodyBytes, implicit: false, problem });
  }
  const needsGateway = routes.some(
    (r) => (r.kind === "direct" || r.kind === "tunnel") && r.problem === null,
  );
  let gateway: GatewayPlan | null = null;
  if (needsGateway) {
    const g = parsed.data.gateway;
    const why = g === undefined ? "direct 和 tunnel 路線要有 [gateway](埠)" : gatewayProblem(g);
    if (why === null && g !== undefined) {
      gateway = {
        bind: g.bind,
        port: g.port,
        tls:
          g.tls_cert !== undefined && g.tls_key !== undefined
            ? { cert: resolve(ctx.workspace, g.tls_cert), key: resolve(ctx.workspace, g.tls_key) }
            : null,
      };
    } else {
      problems.push(why as string);
      for (const r of routes) {
        if ((r.kind === "direct" || r.kind === "tunnel") && r.problem === null) {
          r.problem = why;
        }
      }
    }
  }
  return { file, routes: withImplicit(routes, ctx), gateway, problems };
}

/** Why the gateway may not start as written, or `null`. */
export function gatewayProblem(g: HostGatewayConfig): string | null {
  if ((g.tls_cert === undefined) !== (g.tls_key === undefined)) {
    return "[gateway] 的 tls_cert 和 tls_key 要一起寫";
  }
  if (g.tls_cert === undefined && !loopbackBind(g.bind)) {
    return `[gateway] 聽 ${g.bind} 一定要有 TLS(tls_cert、tls_key),或聽 127.0.0.1 並在前面放 TLS 的反向代理或 tunnel`;
  }
  return null;
}

function failed(file: string, ctx: RouteContext, problem: string): LoadedRoutes {
  return { file, routes: withImplicit([], ctx), gateway: null, problems: [problem] };
}

/** Adds `advertise` (when no tailnet route is declared) and `relay` (when not declared). */
function withImplicit(routes: RoutePlan[], ctx: RouteContext): RoutePlan[] {
  const out = [...routes];
  const names = new Set(out.map((r) => r.name));
  if (!out.some((r) => r.kind === "tailnet") && ctx.advertise !== undefined) {
    out.unshift({
      name: names.has("advertise") ? "advertise-1" : "advertise",
      kind: "tailnet",
      base: ctx.advertise,
      maxBodyBytes: null,
      implicit: true,
      problem: addressProblem(ctx.advertise),
    });
  }
  if (!out.some((r) => r.kind === "relay")) {
    out.push({
      name: names.has("relay") ? "relay-1" : "relay",
      kind: "relay",
      base: null,
      maxBodyBytes: null,
      implicit: true,
      problem: null,
    });
  }
  return out;
}

/**
 * The routes with `local` first when the Core this host reports to runs on this machine: the
 * services' own ports at the local address, the nearest route there is.
 */
export function withLocal(loaded: LoadedRoutes, local: string | null): LoadedRoutes {
  if (local === null || loaded.routes.some((r) => r.name === "local")) return loaded;
  return {
    ...loaded,
    routes: [
      {
        name: "local",
        kind: "tailnet",
        base: local,
        maxBodyBytes: null,
        implicit: true,
        problem: null,
      },
      ...loaded.routes,
    ],
  };
}

/** The routes as `host.report` carries them. */
export function reportRoutes(loaded: LoadedRoutes, gatewayProblemNow: string | null): HostRoute[] {
  return loaded.routes.map((r) => {
    const gatewayDown =
      (r.kind === "direct" || r.kind === "tunnel") && r.problem === null ? gatewayProblemNow : null;
    const problem = r.problem ?? gatewayDown;
    return {
      name: r.name,
      kind: r.kind,
      ...(r.base !== null ? { url: r.base } : {}),
      ...(r.maxBodyBytes !== null ? { max_body_bytes: r.maxBodyBytes } : {}),
      ...(r.implicit ? { implicit: true } : {}),
      ...(problem !== null ? { problem } : {}),
    };
  });
}

/**
 * Where a service is on each usable route: its own port at a `tailnet` address, or under the
 * gateway (`<url>/svc/<name>`) for `direct` and `tunnel`. Only services the gateway serves get a
 * gateway URL (`gatewayServes`).
 */
export function reachOf(
  loaded: LoadedRoutes,
  service: string,
  port: number,
  gatewayServes: boolean,
  gatewayUp: boolean,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of loaded.routes) {
    if (r.problem !== null || r.base === null) continue;
    if (r.kind === "tailnet") out[r.name] = `http://${urlHost(r.base)}:${port}`;
    else if ((r.kind === "direct" || r.kind === "tunnel") && gatewayServes && gatewayUp) {
      out[r.name] = `${r.base}${HOST_ROUTE.SERVICE_PREFIX}${encodeURIComponent(service)}`;
    }
  }
  return out;
}

/** Where `routes.toml` would be for a workspace. */
export function routesFile(workspace: string): string {
  return join(workspace, HOST_ROUTE.FILE);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
