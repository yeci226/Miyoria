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
import { GiftPricerKey, QuestPickerKey } from "@miyoria/economy";
import { BondRingImagesKey } from "@miyoria/heart/person";
import { tokenize } from "@miyoria/memory/memory";
import { CardFacesKey } from "@miyoria/play/cards";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import {
  ArtifactCleanerKey,
  ArtifactStoreKey,
  FileLinksKey,
  SettingsStoreKey,
} from "@miyoria/store";
import {
  ActivityManagerKey,
  Events,
  KeepsakesKey,
  ModerationKey,
  PicturesKey,
} from "@miyoria/types";
import { z } from "zod";
import { MemoryFailureLimiter } from "./admin-limit.js";
import { CardFaceService } from "./card-faces.js";
import { ImageCleaner } from "./files/clean.js";
import { FilesConfigSchema, parseOrigin } from "./files/config.js";
import { FileLinkService } from "./files/links.js";
import { fileOriginApp } from "./files/serve.js";
import type { FilesSide } from "./files/side.js";
import { Tickets } from "./files/tickets.js";
import { GiftPriceService } from "./gift-price.js";
import { KeepsakeService } from "./keepsakes.js";
import { MONITOR_TOPICS, Monitor } from "./monitor.js";
import { DiscordOAuthConfigSchema, OAuth, recheckMs, sessionTtlMs } from "./oauth.js";
import { PANEL_DIR_ENV, pickDir } from "./panel.js";
import { memberPicture } from "./picture-data.js";
import { backgroundPath, PictureRenderer, PictureService } from "./pictures.js";
import { PublicConfigSchema, PublicSide, STATS_EVERY_MS } from "./public.js";
import { QuestPickService } from "./quest-words.js";
import { RingImages } from "./ring-image.js";
import { createApp } from "./server.js";
import { Sessions } from "./session.js";
import { ApiState, type PanelAuth, type Tokenizer } from "./state.js";
import { SAMPLE_EVERY_MS, TELEMETRY_TOPICS } from "./telemetry.js";

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
  /**
   * The picture behind her picture messages (docs/design/v5-play.md §11.5), relative to the
   * working directory. Empty: the public page's own (`background.local.jpg` in the panel's
   * folder); without either the panel's 暮色 gradient.
   */
  picture_background: z.string().default(""),
  /**
   * The tunnel-facing listener (v5-architecture §11.1): the public views, the member pages and the
   * site, and nothing of the admin API. Empty (the default): one listener at `bind` serves
   * everything, as before. Once it is set, `bind` must be this machine, the tailnet or the LAN.
   */
  public_bind: z.string().default(""),
  /** The file origin of her share links (`files/config.ts`). Off until `origin` is set. */
  files: FilesConfigSchema.prefault({}),
});
export type ApiConfig = z.output<typeof ApiConfigSchema>;

export class ApiConfigError extends Error {
  override readonly name = "ApiConfigError";
}

export interface ApiModuleOptions {
  /** Search tokenizer for `/api/memory`. Default: `@miyoria/memory/memory`'s `tokenize`. */
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
 * systems hand them out for port 0, which would make the server unreachable for `fetch`.
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

function urlOf(a: AddressInfo | null): string | null {
  if (!a) return null;
  const host = a.family === "IPv6" ? `[${a.address}]` : a.address;
  return `http://${host}:${a.port}`;
}

/** Listens on `bind` (`what` names it in the error), or throws `ApiConfigError`. */
async function listenOn(server: ServerType, bind: string, what: string): Promise<AddressInfo> {
  const { host, port } = parseBind(bind);
  try {
    return await listen(server, host, port);
  } catch (error) {
    throw new ApiConfigError(`cannot bind ${what} to \`${bind}\`: ${errorMessage(error)}`, {
      cause: error,
    });
  }
}

/** The tailnet's addresses: Tailscale's CGNAT range and its IPv6 prefix. */
function isTailnet(address: string): boolean {
  if (isIPv4(address)) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 100 && b >= 64 && b <= 127;
  }
  return isIPv6(address) && address.toLowerCase().startsWith("fd7a:115c:a1e0:");
}

/** A LAN address (RFC 1918, IPv6 unique local or link local). */
function isLan(address: string): boolean {
  if (isIPv4(address)) {
    const [a, b] = address.split(".").map(Number) as [number, number];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v6 = address.toLowerCase();
  return isIPv6(address) && (/^f[cd]/.test(v6) || v6.startsWith("fe80:"));
}

/**
 * Where the admin listener may be once the public side has its own: this machine, the tailnet or
 * the LAN; never every address (`0.0.0.0`, `::`) and never a public one.
 */
export function privateAddress(address: string): boolean {
  return isLoopback(address) || isTailnet(address) || isLan(address);
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
    icon: "server",
    category: "platform",
    description: "HTTP + SSE API for the CLI and the admin panel",
    configSchema: ApiConfigSchema,
  });
  readonly #tokenize: Tokenizer;
  readonly #env: (name: string) => string | undefined;
  readonly #emotions: readonly string[];
  readonly #random: () => number;
  #address: AddressInfo | null = null;
  #publicAddress: AddressInfo | null = null;
  #filesAddress: AddressInfo | null = null;

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
    return urlOf(this.#address);
  }

  /** `http://host:port` of the public listener (`public_bind`), while it runs. */
  publicUrl(): string | null {
    return urlOf(this.#publicAddress);
  }

  /** `http://host:port` of the file origin's listener, while it runs. */
  filesUrl(): string | null {
    return urlOf(this.#filesAddress);
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
    // Bad addresses fail before anything listens.
    parseBind(config.bind);
    if (config.public_bind.trim() !== "") parseBind(config.public_bind);

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
      limiter: new MemoryFailureLimiter(),
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
    // The same cards and slips the member page gives, for a command in chat.
    ctx.provide(KeepsakesKey, new KeepsakeService(state));
    // Her words on a milestone card, which the cards module issues with no page open.
    ctx.provide(CardFacesKey, new CardFaceService(state));
    // The daily quest she thinks of for each person, from what the member page shows them.
    ctx.provide(QuestPickerKey, new QuestPickService(state));
    // The tier of a gift a member named in words (one small model call per new name).
    ctx.provide(GiftPricerKey, new GiftPriceService(state));
    // The bond ring's picture for `/me profile` and `/admin person show`.
    ctx.provide(BondRingImagesKey, new RingImages());
    // Her picture messages: the templates drawn to PNG, kept in the artifact store.
    const background = backgroundPath(config.picture_background, panelDir);
    const pictures = new PictureRenderer({
      background: () => background,
      store: () => ctx.services.get(ArtifactStoreKey),
    });
    ctx.provide(
      PicturesKey,
      new PictureService(pictures, (who, kind) => memberPicture(state, who, kind)),
    );
    // Her files: images handed out re-encoded, and links on the file origin when one is set.
    const files = this.#filesSide(ctx, config, oauth);
    state.files = files;
    ctx.provide(ArtifactCleanerKey, files.cleaner);
    if (files.links !== null) ctx.provide(FileLinksKey, files.links);

    const split = config.public_bind.trim() !== "";
    const servers: ServerType[] = [];
    const app = createApp(state, { metricsPublic: config.metrics_public, side: "admin" });
    const server = createAdaptorServer({ fetch: app.fetch });
    servers.push(server);
    const address = await listenOn(server, config.bind, "admin API");
    if (split && !privateAddress(address.address)) {
      await close(server);
      throw new ApiConfigError(
        `with \`public_bind\` set, \`[modules.api] bind\` must be this machine, the tailnet or the LAN, not \`${config.bind}\``,
      );
    }
    if (!isLoopback(address.address)) {
      ctx.log.warn({ addr: address }, "admin API is reachable from the network over plain HTTP");
    }
    this.#address = address;
    ctx.log.info({ addr: `${address.address}:${address.port}` }, "admin API listening");
    if (config.metrics_public) ctx.log.info("serving /metrics without authentication");
    try {
      if (split) {
        const publicApp = createApp(state, { metricsPublic: false, side: "public" });
        const publicServer = createAdaptorServer({ fetch: publicApp.fetch });
        servers.push(publicServer);
        const at = await listenOn(publicServer, config.public_bind, "the public listener");
        this.#publicAddress = at;
        ctx.log.info(
          { addr: `${at.address}:${at.port}` },
          "public site and member API listening (no admin routes)",
        );
      }
      if (files.origin !== null) {
        const fileApp = fileOriginApp({
          store: () => ctx.services.get(ArtifactStoreKey),
          cleaner: files.cleaner,
          tickets: files.tickets,
          site: () => files.site,
          isMember: (person, space) =>
            ctx.services.get(ArtifactStoreKey)?.shares.isMember(person, space) ?? false,
          moderation: () => ctx.services.get(ModerationKey),
          now: () => ctx.clock.now(),
          perIpPerMinute: config.files.per_ip_per_minute,
          perLinkPerMinute: config.files.per_link_per_minute,
          publicCacheSecs: config.files.public_cache_secs,
          clientIpHeader: config.public.client_ip_header,
        });
        const fileServer = createAdaptorServer({ fetch: fileApp.fetch });
        servers.push(fileServer);
        const at = await listenOn(fileServer, config.files.bind, "the file origin");
        this.#filesAddress = at;
        ctx.log.info(
          { addr: `${at.address}:${at.port}`, origin: files.origin },
          "file origin listening",
        );
      }
    } catch (error) {
      for (const s of servers) await close(s);
      throw error;
    }

    const sub = ctx.subscribe(MONITOR_TOPICS);
    ctx.spawn("monitor", () => monitor.run(sub));

    const counted = ctx.subscribe(Object.keys(TELEMETRY_TOPICS));
    ctx.spawn("telemetry.events", async () => {
      for await (const env of counted) state.telemetry.handle(env);
    });
    const decided = ctx.subscribe([Events.ArbiterDecided.type]);
    ctx.spawn("arbiter.trail", async () => {
      for await (const env of decided) state.trail.handle(env);
    });
    ctx.spawn("telemetry", async (signal) => {
      state.telemetry.sample(state);
      for await (const _ of interval(SAMPLE_EVERY_MS, signal)) state.telemetry.sample(state);
    });

    if (config.public.enabled) {
      const store = () => ctx.services.get(SettingsStoreKey);
      const sung = ctx.subscribe([Events.SingCue.type]);
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
      for (const s of servers) await close(s);
    });
  }

  /** The file side: the cleaner always, the file origin and its links only with an origin. */
  #filesSide(ctx: ModuleContext, config: ApiConfig, oauth: OAuth | null): FilesSide {
    const store = () => ctx.services.get(ArtifactStoreKey);
    const cleaner = new ImageCleaner(store);
    const tickets = new Tickets(() => ctx.clock.now());
    let origin: string | null;
    let site: string | null;
    try {
      origin = parseOrigin(config.files.origin, "[modules.api.files] origin");
      site =
        parseOrigin(config.files.site, "[modules.api.files] site") ??
        (oauth === null ? null : oauth.redirectFor(null).origin);
    } catch (error) {
      throw new ApiConfigError(errorMessage(error), { cause: error });
    }
    if (origin !== null && site !== null && new URL(origin).host === new URL(site).host) {
      throw new ApiConfigError(
        "`[modules.api.files] origin` must be a host of its own, not the site's: files there could reach the login",
      );
    }
    // Without the Discord login nobody can show who they are, so only links anyone may open.
    const scoped = oauth !== null && site !== null;
    const links =
      origin === null
        ? null
        : new FileLinkService({
            store,
            cleaner,
            origin,
            scoped: () => scoped,
            perPersonPerDay: config.files.links_per_person_per_day,
            moderation: () => ctx.services.get(ModerationKey),
            now: () => ctx.clock.now(),
          });
    if (origin === null)
      ctx.log.debug("no file origin: share links are off, attachments still work");
    return { config: config.files, origin, site, tickets, links, cleaner };
  }

  async stop(): Promise<void> {
    this.#address = null;
    this.#publicAddress = null;
    this.#filesAddress = null;
  }
}
