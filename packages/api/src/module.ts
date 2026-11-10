// Module `api`: an HTTP + SSE server for the CLI and the admin panel.
//
// ```toml
// [modules.api]
// bind = "127.0.0.1:7878"
// token = "${MIYORIA_API_TOKEN}"
// # Built panel served at `/` (skipped when missing). `MIYORIA_PANEL_DIR` overrides.
// panel_dir = "apps/panel/dist"
//
// # Optional: panel login with Discord (alongside the token).
// [modules.api.discord_oauth]
// client_id = "${DISCORD_CLIENT_ID:-}"
// client_secret = "${DISCORD_CLIENT_SECRET:-}"
// redirect_uri = "http://127.0.0.1:7878/api/auth/oauth/callback"
// session_days = 7
// # cookie_secure = true   # default: on when redirect_uri is https
// ```
//
// Every `/api` route except `GET /api/health`, the login routes, `/api/public/*` and
// `/api/member/*` requires `Authorization: Bearer <token>` or an admin session cookie; panel files
// at `/` never do. `GET /metrics` (Prometheus) needs the same unless `metrics_public = true`.

import type { AddressInfo } from "node:net";
import { isIPv4, isIPv6 } from "node:net";
import { createAdaptorServer, type ServerType } from "@hono/node-server";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { tokenize } from "@miyoria/memory";
import { SettingsStoreKey } from "@miyoria/store";
import { ActivityManagerKey, SONG_TOPIC } from "@miyoria/types";
import { z } from "zod";
import { MONITOR_TOPICS, Monitor } from "./monitor.js";
import { DiscordOAuthConfigSchema, OAuth, recheckMs, sessionTtlMs } from "./oauth.js";
import { PANEL_DIR_ENV, pickDir } from "./panel.js";
import { PublicConfigSchema, PublicSide, STATS_EVERY_MS } from "./public.js";
import { createApp } from "./server.js";
import { Sessions } from "./session.js";
import { ApiState, type PanelAuth, type Tokenizer } from "./state.js";
import { SAMPLE_EVERY_MS, TELEMETRY_TOPICS } from "./telemetry.js";
import { TRAIL_TOPIC } from "./trail.js";

/** How often expired panel sessions are dropped. */
export const PRUNE_EVERY_MS = 60 * 60_000;
/** How long open connections may take to finish once the module stops. */
const CLOSE_GRACE_MS = 2_000;

export const DEFAULT_BIND = "127.0.0.1:7878";
export const DEFAULT_PANEL_DIR = "apps/panel/dist";

/** `[modules.api]` config section. */
export const ApiConfigSchema = z.object({
  /** Listen address. Default `127.0.0.1:7878`. */
  bind: z.string().default(DEFAULT_BIND),
  /** Bearer token every protected request must present. Required. */
  token: z.string().default(""),
  /**
   * Built admin panel to serve at `/`, relative to the working directory. `MIYORIA_PANEL_DIR`
   * overrides it, empty disables it, and a directory without `index.html` is skipped.
   */
  panel_dir: z.string().default(DEFAULT_PANEL_DIR),
  /** Discord OAuth2 login for the panel; off unless configured. */
  discord_oauth: DiscordOAuthConfigSchema.prefault({}),
  /**
   * Serve `GET /metrics` without the token, for a Prometheus without credentials. Anyone who
   * can reach `bind` (or a reverse proxy in front of it) can then read the metrics.
   */
  metrics_public: z.boolean().default(false),
  /** The page anyone can see and the page of each logged-in person. On by default. */
  public: PublicConfigSchema.prefault({}),
});
export type ApiConfig = z.output<typeof ApiConfigSchema>;

export class ApiConfigError extends Error {
  override readonly name = "ApiConfigError";
}

export interface ApiModuleOptions {
  /** Search tokenizer for `/api/memory`. Default: `@miyoria/memory`'s `tokenize`. */
  tokenize?: Tokenizer;
  /** Environment lookup for `MIYORIA_PANEL_DIR` (default `process.env`). */
  env?: (name: string) => string | undefined;
  /** Emotions the profile's avatar knows (`avatarEmotions`), for `/api/stage`. */
  emotions?: readonly string[];
  /** Uniform in [0, 1) for choices that need no secrecy (a card's pose). Default `Math.random`. */
  random?: () => number;
}

/**
 * Emotion names of a raw `avatar.toml` table (`[emotion]` keys): lowercase, sorted, `neutral`
 * included, `<placeholder>` values left out.
 */
export function avatarEmotions(avatar: Record<string, unknown> | null | undefined): string[] {
  const table = avatar?.emotion;
  if (typeof table !== "object" || table === null || Array.isArray(table)) return [];
  const names = new Set<string>();
  for (const [name, value] of Object.entries(table)) {
    // `name = "file.exp3.json"`, or a table (`[emotion.<name>]` with a pose, decals, gestures).
    const isTable = typeof value === "object" && value !== null && !Array.isArray(value);
    if (!isTable && (typeof value !== "string" || value.trim().startsWith("<"))) continue;
    const key = name.trim().toLowerCase();
    if (key !== "") names.add(key);
  }
  return [...names].sort();
}

/** `host:port` (IPv6 hosts in brackets) of `bind`. */
export function parseBind(bind: string): { host: string; port: number } {
  const trimmed = bind.trim();
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(trimmed) ?? /^([^:]+):(\d+)$/.exec(trimmed);
  const port = m ? Number(m[2]) : Number.NaN;
  if (!m?.[1] || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new ApiConfigError(`invalid bind address \`${bind}\` (expected host:port)`);
  }
  return { host: m[1], port };
}

function isLoopback(address: string): boolean {
  if (isIPv4(address)) return address.startsWith("127.");
  if (isIPv6(address)) return address === "::1" || address.startsWith("::ffff:127.");
  return address === "localhost";
}

/**
 * Ports above 1024 that `fetch` refuses to connect to (the Fetch standard's "bad ports"). Some
 * systems hand them out for port 0, which would make the server unreachable for `ApiClient`.
 */
export const FETCH_BLOCKED_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

function listenOnce(server: ServerType, host: string, port: number): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve(server.address() as AddressInfo);
    });
  });
}

/** Listens on `host:port`; with port 0, never on a port `fetch` blocks. */
async function listen(server: ServerType, host: string, port: number): Promise<AddressInfo> {
  for (let attempt = 0; ; attempt++) {
    const address = await listenOnce(server, host, port);
    if (port !== 0 || !FETCH_BLOCKED_PORTS.has(address.port) || attempt >= 10) return address;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function close(server: ServerType): Promise<void> {
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  const http = server as ServerType & {
    closeIdleConnections?: () => void;
    closeAllConnections?: () => void;
  };
  http.closeIdleConnections?.();
  const timer = setTimeout(() => http.closeAllConnections?.(), CLOSE_GRACE_MS);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

/** Module `api`: serves the admin API until stopped. */
export class ApiModule implements Module {
  static readonly ID = "api";
  readonly manifest = defineManifest(ApiModule.ID, "Admin API", {
    description: "HTTP + SSE API for the CLI and the admin panel",
    configSchema: ApiConfigSchema,
  });
  readonly #tokenize: Tokenizer;
  readonly #env: (name: string) => string | undefined;
  readonly #emotions: readonly string[];
  readonly #random: () => number;
  #address: AddressInfo | null = null;

  constructor(options: ApiModuleOptions = {}) {
    this.#tokenize = options.tokenize ?? tokenize;
    this.#env = options.env ?? ((name) => process.env[name]);
    this.#emotions = [...(options.emotions ?? [])];
    this.#random = options.random ?? Math.random;
  }

  /** The address the server is bound to while running (useful with port 0). */
  localAddr(): AddressInfo | null {
    return this.#address;
  }

  /** `http://host:port` of the running server. */
  url(): string | null {
    const a = this.#address;
    if (!a) return null;
    const host = a.family === "IPv6" ? `[${a.address}]` : a.address;
    return `http://${host}:${a.port}`;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ApiConfigSchema);
    const token = config.token.trim();
    if (token === "") {
      throw new ApiConfigError(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the config syntax, quoted
        '`[modules.api] token` is empty: set the MIYORIA_API_TOKEN environment variable (with `token = "${MIYORIA_API_TOKEN}"`) or run `miyoria init`',
      );
    }
    const oauth = OAuth.fromConfig(config.discord_oauth, ctx.clock);
    const { host, port } = parseBind(config.bind);

    const panelDir = pickDir(this.#env(PANEL_DIR_ENV), config.panel_dir);
    if (panelDir !== null) ctx.log.info({ dir: panelDir }, "serving the admin panel at /");
    else ctx.log.debug("no built admin panel found; not serving one");

    const cookieSecure = config.discord_oauth.cookie_secure ?? oauth?.redirectIsHttps() ?? false;
    if (oauth) ctx.log.info({ secure_cookie: cookieSecure }, "Discord login for the panel is on");
    const auth: PanelAuth = {
      token: Buffer.from(token, "utf8"),
      sessions: new Sessions(
        sessionTtlMs(config.discord_oauth),
        recheckMs(config.discord_oauth),
        ctx.clock,
      ),
      oauth,
      cookieSecure,
    };

    const monitor = new Monitor();
    const publicSide = new PublicSide(config.public, () => ctx.clock.now());
    const state = new ApiState(
      ctx,
      auth,
      monitor,
      panelDir,
      this.#tokenize,
      this.#emotions,
      undefined,
      undefined,
      undefined,
      publicSide,
      this.#random,
    );
    const app = createApp(state, { metricsPublic: config.metrics_public });
    const server = createAdaptorServer({ fetch: app.fetch });
    let address: AddressInfo;
    try {
      address = await listen(server, host, port);
    } catch (error) {
      throw new ApiConfigError(
        `cannot bind admin API to \`${config.bind}\`: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (!isLoopback(address.address)) {
      ctx.log.warn({ addr: address }, "admin API is reachable from the network over plain HTTP");
    }
    this.#address = address;
    ctx.log.info({ addr: `${address.address}:${address.port}` }, "admin API listening");
    if (config.metrics_public) ctx.log.info("serving /metrics without authentication");

    const sub = ctx.subscribe(MONITOR_TOPICS);
    ctx.spawn("monitor", () => monitor.run(sub));

    const counted = ctx.subscribe(Object.keys(TELEMETRY_TOPICS));
    ctx.spawn("telemetry.events", async () => {
      for await (const env of counted) state.telemetry.handle(env);
    });
    const decided = ctx.subscribe([TRAIL_TOPIC]);
    ctx.spawn("arbiter.trail", async () => {
      for await (const env of decided) state.trail.handle(env);
    });
    ctx.spawn("telemetry", async (signal) => {
      state.telemetry.sample(state);
      for await (const _ of interval(SAMPLE_EVERY_MS, signal)) state.telemetry.sample(state);
    });

    if (config.public.enabled) {
      const store = () => ctx.services.get(SettingsStoreKey);
      const sung = ctx.subscribe([SONG_TOPIC]);
      ctx.spawn("public.songs", async () => {
        for await (const env of sung) {
          publicSide.stats.handle(env, ctx.clock.now());
          await publicSide.stats.save(store());
        }
      });
      ctx.spawn("public.stats", async (signal) => {
        await publicSide.stats.load(store(), ctx.clock.now());
        for await (const _ of interval(STATS_EVERY_MS, signal)) {
          const now = ctx.services.get(ActivityManagerKey)?.snapshot();
          publicSide.stats.sample(ctx.clock.now(), {
            live: now?.broadcast.type === "live",
            inVoice: now?.presence.type === "in",
          });
          await publicSide.stats.save(store());
        }
      });
    }

    if (oauth) {
      ctx.spawn("sessions", async (signal) => {
        await auth.sessions.prune(ctx.services.get(SettingsStoreKey));
        for await (const _ of interval(PRUNE_EVERY_MS, signal)) {
          await auth.sessions.prune(ctx.services.get(SettingsStoreKey));
        }
      });
    }

    ctx.spawn("server", async (signal) => {
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      });
      await close(server);
    });
  }

  async stop(): Promise<void> {
    this.#address = null;
  }
}
