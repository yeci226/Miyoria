// Resolution: which services this host runs and with what. The effective list is the catalog's
// descriptors that `host.toml` lists, with its overrides applied. A problem disables that one
// service with a readable reason; it never stops the daemon. Placeholders are substituted when a
// service starts, with the port it really got (`expandService`); `planServices` runs the same
// substitution once ahead of time so a missing environment or variable shows up as `disabled`.

import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { HostGpuPolicy, HostServiceConfig, HostServiceStatus } from "@miyoria/contracts/host";
import {
  type Catalog,
  type CatalogEntry,
  ENV_PLACEHOLDER_PREFIX,
  isKnownPlaceholder,
  LINK_PLACEHOLDER_PREFIX,
  type LinkPlaceholder,
  placeholdersIn,
} from "./catalog.js";
import type { ServiceDescriptor as HostService } from "./descriptor.js";
import { mergeEnv, passEnv, workerBaseEnv } from "./env.js";
import type { LoadedHostConfig } from "./host-config.js";
import { missingRequiredFiles } from "./install/files.js";
import { localAddress, urlHost } from "./ports.js";

/** What the daemon knows that descriptors refer to. */
export interface ResolveContext {
  /** The workspace folder (`host.toml`'s folder). */
  workspace: string;
  /** The state folder, absolute. */
  state: string;
  /** `[network] bind`. */
  bind: string;
  /** The Core config path (`{config}`), absolute. */
  configPath: string;
  /** How this CLI was started (`{miyoria}`): the program and its leading arguments. */
  miyoria: readonly string[];
  /** `{node}`. */
  node: string;
  /** The daemon's environment: the source of `pass_env`, the base allowlist and `{env:NAME}`. */
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** `[paths] ca_bundle`, absolute. */
  caBundle?: string;
}

/** One service of this host, before it is started. */
export interface ServicePlan {
  name: string;
  /** `null` when `host.toml` names a service the catalog does not have. */
  entry: CatalogEntry | null;
  override: HostServiceConfig;
  kind: HostServiceStatus["kind"];
  provides: string[];
  /** Why the service cannot run here; `null` when it can. */
  disabled: string | null;
  /** The port from `host.toml`, else the descriptor's (`[probe] port` for an external one). */
  port: number | "auto" | undefined;
  gpuPolicy: HostGpuPolicy | undefined;
}

/** What only exists once a service is being started. */
export interface LiveValues {
  /** The port the service got; `undefined` for one without a port. */
  port: number | undefined;
  /** `{offload_urls}`: comma-separated, possibly empty. */
  offloadUrls: string;
  /** `MIYORIA_SERVICE_TOKEN`. */
  token: string;
  /**
   * `MIYORIA_HOST_TOKEN`: shared by the services of this machine, new at each daemon start. A
   * worker accepts it beside its own token and sends it to a neighbour on the same machine.
   */
  hostToken: string;
  /** `MIYORIA_HOSTD_URL`. */
  hostdUrl: string;
  /**
   * `host.toml [gpu] arbiter`. With `hostd`, a service whose GPU policy is `on_demand` (the song
   * worker) gets `SING_GPU_ARBITER=hostd` and no `{offload_urls}`: it asks hostd for the card and
   * never calls its neighbours. Default `worker`: nothing changes.
   */
  gpuArbiter?: "worker" | "hostd";
  /**
   * `{link:voice.url}` and the others: what Core told this host about its node links. One that is
   * missing leaves its environment variable out (the node falls back to its own settings).
   */
  links?: Readonly<Partial<Record<LinkPlaceholder, string>>>;
}

/** The `{link:...}` values a start used, by name; `null` for one that had no value then. */
export type UsedLinks = Partial<Record<LinkPlaceholder, string | null>>;

/** A program to spawn: no shell, an argument list. */
export interface SpawnSpec {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The `{link:...}` placeholders its environment refers to, with the values it got. */
  links: UsedLinks;
}

export class ResolveError extends Error {
  override name = "ResolveError";
}

/** The interpreter of a Python environment folder. */
export function pythonIn(envDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? join(envDir, "Scripts", "python.exe")
    : join(envDir, "bin", "python");
}

/** The environment folder of a service: `host.toml`'s `python`, else `<state>/envs/<service>`. */
export function pythonEnvDir(plan: ServicePlan, ctx: ResolveContext): string {
  const configured = plan.override.python;
  if (configured !== undefined) return resolve(ctx.workspace, configured);
  return join(ctx.state, "envs", plan.name);
}

/** The effective GPU policy: `host.toml`'s, else the descriptor's. */
function gpuPolicyOf(descriptor: HostService | null, override: HostServiceConfig) {
  return override.gpu?.policy ?? descriptor?.gpu?.policy;
}

function portOf(descriptor: HostService, override: HostServiceConfig): number | "auto" | undefined {
  if (override.port !== undefined) return override.port;
  if (descriptor.kind === "external") return descriptor.probe?.port;
  return descriptor.run?.port;
}

/** The catalog file's problems for a service folder of that name, for a readable reason. */
function catalogProblem(catalog: Catalog, name: string): string | null {
  const found = catalog.problems.filter((p) => {
    const parts = p.file.split(/[\\/]/);
    return parts.at(-2) === name;
  });
  if (found.length === 0) return null;
  return found.map((p) => p.message).join("; ");
}

/**
 * Every service `host.toml` lists, in start order: each `after` service of this host first, then
 * the catalog's order. Services with `enabled = false` are listed too, as disabled.
 */
export function planServices(
  catalog: Catalog,
  host: LoadedHostConfig,
  ctx: ResolveContext,
): ServicePlan[] {
  const plans: ServicePlan[] = [];
  for (const [name, override] of Object.entries(host.config.services)) {
    const entry = catalog.services.get(name) ?? null;
    if (entry === null) {
      const problem = catalogProblem(catalog, name);
      plans.push({
        name,
        entry: null,
        override,
        kind: "worker",
        provides: [],
        disabled:
          problem === null ? "目錄裡沒有這個服務的 service.toml" : `service.toml 有問題:${problem}`,
        port: override.port,
        gpuPolicy: override.gpu?.policy,
      });
      continue;
    }
    const descriptor = entry.descriptor;
    const plan: ServicePlan = {
      name,
      entry,
      override,
      kind: descriptor.kind,
      provides: descriptor.provides,
      disabled: null,
      port: portOf(descriptor, override),
      gpuPolicy: gpuPolicyOf(descriptor, override),
    };
    plan.disabled = checkPlan(plan, ctx);
    plans.push(plan);
  }
  return startOrder(plans, catalog);
}

/** Why a plan cannot run, or `null`. Runs the start-time substitution with stand-in values. */
export function checkPlan(plan: ServicePlan, ctx: ResolveContext): string | null {
  if (!plan.override.enabled) return "host.toml 裡 enabled = false";
  const descriptor = plan.entry?.descriptor;
  if (descriptor === undefined) return plan.disabled ?? "目錄裡沒有這個服務的 service.toml";
  if (!descriptor.platforms.includes(ctx.platform)) {
    return `只支援 ${descriptor.platforms.join("、")},這台是 ${ctx.platform}`;
  }
  if (descriptor.kind === "external") return null;
  try {
    expandService(plan, ctx, {
      port: typeof plan.port === "number" ? plan.port : plan.port === "auto" ? 1 : undefined,
      offloadUrls: "",
      token: "check",
      hostToken: "check",
      hostdUrl: "http://127.0.0.1:1",
    });
  } catch (error) {
    if (error instanceof ResolveError) return error.message;
    throw error;
  }
  return filesProblem(plan, ctx);
}

/**
 * Why a service cannot start for want of its `[[install.files]]`: a file it needs (not `optional`)
 * that is missing or the wrong size. Reads no file, so it is cheap enough for every start;
 * `miyoria doctor` verifies the checksums.
 */
export function filesProblem(plan: ServicePlan, ctx: ResolveContext): string | null {
  const files = plan.entry?.descriptor.install.files ?? [];
  if (files.length === 0) return null;
  const missing = missingRequiredFiles(files, join(ctx.state, "models"));
  if (missing.length === 0) return null;
  return `缺少必要的檔案:${missing.join("、")}(\`miyoria add ${plan.name}\` 或 \`miyoria doctor --fix\` 下載)`;
}

/** Topological order over `after` among the plans, stable in catalog order. */
function startOrder(plans: ServicePlan[], catalog: Catalog): ServicePlan[] {
  const rank = new Map([...catalog.services.keys()].map((name, i) => [name, i]));
  const byRank = [...plans].sort(
    (a, b) =>
      (rank.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.name) ?? Number.MAX_SAFE_INTEGER),
  );
  const names = new Set(plans.map((p) => p.name));
  const out: ServicePlan[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (plan: ServicePlan) => {
    if (placed.has(plan.name) || visiting.has(plan.name)) return; // a cycle keeps catalog order
    visiting.add(plan.name);
    for (const dep of plan.entry?.descriptor.run?.after ?? []) {
      const other = names.has(dep) ? byRank.find((p) => p.name === dep) : undefined;
      if (other !== undefined) visit(other);
    }
    visiting.delete(plan.name);
    placed.add(plan.name);
    out.push(plan);
  };
  for (const plan of byRank) visit(plan);
  return out;
}

/** The value of one placeholder in a text (never `{miyoria}`, which is whole elements only). */
function placeholderValue(
  name: string,
  where: string,
  plan: ServicePlan,
  ctx: ResolveContext,
  live: LiveValues,
): string {
  if (name.startsWith(LINK_PLACEHOLDER_PREFIX)) {
    // `expandEnv` leaves out a variable whose link value is missing before it gets here.
    const value = live.links?.[name.slice(LINK_PLACEHOLDER_PREFIX.length) as LinkPlaceholder];
    if (value === undefined) throw new ResolveError(`${where}:{${name}} 還沒有值`);
    return value;
  }
  if (name.startsWith(ENV_PLACEHOLDER_PREFIX)) {
    const variable = name.slice(ENV_PLACEHOLDER_PREFIX.length);
    const value = ctx.env[variable];
    if (value === undefined || value === "") {
      throw new ResolveError(`${where} 要用環境變數 ${variable},但 hostd 的環境裡沒有它`);
    }
    return value;
  }
  const dir = plan.entry?.dir ?? ctx.workspace;
  switch (name) {
    case "python": {
      const exe = pythonIn(pythonEnvDir(plan, ctx), ctx.platform);
      if (!existsSync(exe)) {
        const how =
          plan.override.python === undefined
            ? `(在 host.toml 的 [services.${plan.name}] 用 python = "<環境資料夾>" 指定)`
            : "";
        throw new ResolveError(`找不到 Python 環境 ${exe}${how}`);
      }
      return exe;
    }
    case "node":
      return ctx.node;
    case "config":
      return ctx.configPath;
    case "workspace":
      return ctx.workspace;
    case "state":
      return ctx.state;
    case "models":
      return join(ctx.state, "models");
    case "service":
      return dir;
    case "host":
      return ctx.bind;
    case "port":
      if (live.port === undefined) throw new ResolveError(`${where} 用了 {port},但這個服務沒有埠`);
      return String(live.port);
    case "offload_urls":
      return live.offloadUrls;
    case "miyoria":
      throw new ResolveError(`${where}:{miyoria} 只能是 run.command 裡完整的一項`);
    default:
      throw new ResolveError(
        isKnownPlaceholder(name)
          ? `${where}:{${name}} 在啟動時沒有值`
          : `${where}:不認得的 {${name}}`,
      );
  }
}

function substitute(
  text: string,
  where: string,
  plan: ServicePlan,
  ctx: ResolveContext,
  live: LiveValues,
): string {
  if (placeholdersIn(text).length === 0) return text;
  return text.replace(
    /\{([A-Za-z_][A-Za-z0-9_-]*(?::[A-Za-z_][A-Za-z0-9_.]*)?)\}/g,
    (_m, name: string) => placeholderValue(name, where, plan, ctx, live),
  );
}

/**
 * An environment table with its placeholders substituted; `{offload_urls}` empty drops the key,
 * and so does a `{link:...}` hostd has no value for yet. The link values it used go into `used`.
 */
function expandEnv(
  table: Record<string, string>,
  where: string,
  plan: ServicePlan,
  ctx: ResolveContext,
  live: LiveValues,
  used: UsedLinks,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(table)) {
    let missing = false;
    for (const name of placeholdersIn(raw)) {
      if (!name.startsWith(LINK_PLACEHOLDER_PREFIX)) continue;
      const link = name.slice(LINK_PLACEHOLDER_PREFIX.length) as LinkPlaceholder;
      const value = live.links?.[link];
      used[link] = value ?? null;
      if (value === undefined || value === "") missing = true;
    }
    if (missing) continue;
    const value = substitute(raw, `${where}.${key}`, plan, ctx, live);
    if (value === "" && placeholdersIn(raw).includes("offload_urls")) continue;
    out[key] = value;
  }
  return out;
}

/**
 * What hostd gives a service before its descriptor and `host.toml` say anything: a Python service
 * keeps its Hugging Face cache in the host's model folder, where `miyoria models pull` puts it.
 * Both the descriptor's `env` and `host.toml`'s override it; the daemon's own environment does not.
 */
function defaultEnv(descriptor: HostService, ctx: ResolveContext): Record<string, string> {
  if (descriptor.install.runtime !== "python") return {};
  return { HF_HUB_CACHE: join(ctx.state, "models", "hf") };
}

/**
 * The program, arguments, folder and environment of one start. Throws `ResolveError` when a
 * placeholder has no value (no Python environment, an unset `{env:NAME}`).
 */
export function expandService(
  plan: ServicePlan,
  ctx: ResolveContext,
  given: LiveValues,
): SpawnSpec {
  const entry = plan.entry;
  // hostd arbitrates the card: the holder does not learn its neighbours' addresses.
  const asksHostd = given.gpuArbiter === "hostd" && plan.gpuPolicy === "on_demand";
  const live: LiveValues = asksHostd ? { ...given, offloadUrls: "" } : given;
  const run = entry?.descriptor.run;
  if (entry === null || run === undefined) {
    throw new ResolveError(`${plan.name} 沒有 [run],hostd 不能啟動它`);
  }
  const argv: string[] = [];
  run.command.forEach((part, i) => {
    if (part === "{miyoria}") {
      if (ctx.miyoria.length === 0) throw new ResolveError("不知道怎麼執行 miyoria 本身");
      argv.push(...ctx.miyoria);
    } else {
      argv.push(substitute(part, `run.command[${i}]`, plan, ctx, live));
    }
  });
  const [file, ...args] = argv as [string, ...string[]];
  const cwdText = substitute(run.cwd, "run.cwd", plan, ctx, live);
  const cwd = isAbsolute(cwdText) ? cwdText : resolve(entry.dir, cwdText);

  const added: Record<string, string> = {
    MIYORIA_SERVICE_TOKEN: live.token,
    MIYORIA_HOST_TOKEN: live.hostToken,
    MIYORIA_HOSTD_URL: live.hostdUrl,
  };
  if (asksHostd) added.SING_GPU_ARBITER = "hostd";
  if (run.host_env !== undefined) added[run.host_env] = ctx.bind;
  if (run.port_env !== undefined && live.port !== undefined) {
    added[run.port_env] = String(live.port);
  }
  if (ctx.caBundle !== undefined) {
    added.SSL_CERT_FILE = ctx.caBundle;
    added.REQUESTS_CA_BUNDLE = ctx.caBundle;
  }
  const links: UsedLinks = {};
  const env = mergeEnv(
    [
      workerBaseEnv(ctx.env),
      passEnv(run.pass_env, ctx.env, ctx.platform),
      defaultEnv(entry.descriptor, ctx),
      expandEnv(run.env, "run.env", plan, ctx, live, links),
      expandEnv(plan.override.env, `host.toml services.${plan.name}.env`, plan, ctx, live, links),
      added,
    ],
    ctx.platform,
  );
  return { file, args, cwd, env, links };
}

/** The base URL a local client uses for a service on `port`. */
export function localUrl(bind: string, port: number): string {
  return `http://${urlHost(localAddress(bind))}:${port}`;
}

/**
 * `{offload_urls}` (while `[gpu] arbiter = "worker"`): the services of this host with the effective GPU policy
 * `evictable` that host.toml enables, tts first, then asr, then the others in start order.
 */
export function offloadUrls(
  plans: readonly ServicePlan[],
  portOf: (plan: ServicePlan) => number | undefined,
  bind: string,
): string {
  const first = ["tts", "asr"];
  const evictable = plans.filter((p) => p.override.enabled && p.gpuPolicy === "evictable");
  const ordered = [
    ...first.flatMap((n) => evictable.filter((p) => p.name === n)),
    ...evictable.filter((p) => !first.includes(p.name)),
  ];
  return ordered
    .map((p) => {
      const port = portOf(p);
      return port === undefined ? null : localUrl(bind, port);
    })
    .filter((u): u is string => u !== null)
    .join(",");
}
