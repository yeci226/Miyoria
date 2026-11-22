// The catalog: every `service.toml` of a checkout, loaded and checked. A broken descriptor is a
// problem to report, never an exception, so one bad file does not hide the others.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { ZodError } from "zod";
import { type ServiceDescriptor, ServiceDescriptorSchema } from "./descriptor.js";

/**
 * Where descriptors live, relative to the workspace root. `dir/*` is every folder one level
 * below `dir`; anything else is that folder itself. `extensions/*` joins later.
 */
export const CATALOG_ROOTS = [
  "workers/*",
  "apps/*",
  "packages/core",
  "packages/stage",
  "services/*",
] as const;

/** The file name of a descriptor. */
export const DESCRIPTOR_FILE = "service.toml";

/**
 * The `{name}` placeholders a descriptor may use in a command, an environment value or a path.
 * They are substituted when a service starts (`resolve.ts`), not by this module. `{env:NAME}`,
 * the value of one of the daemon's environment variables, is allowed besides these, and in
 * `run.env` only, `{link:voice.url}` and the others of `LINK_PLACEHOLDERS`.
 */
export const PLACEHOLDERS = [
  "python",
  "node",
  "miyoria",
  "config",
  "workspace",
  "state",
  "models",
  "service",
  "port",
  "host",
  "voice",
  // Until H7: the base URLs of this host's evictable GPU services, for the sing worker.
  "offload_urls",
] as const;

/** The prefix of the `{env:NAME}` placeholder. */
export const ENV_PLACEHOLDER_PREFIX = "env:";

/** The prefix of the `{link:...}` placeholders. */
export const LINK_PLACEHOLDER_PREFIX = "link:";

/**
 * Where Core's node links are, as Core tells this host (`cluster.links`), for a node's `run.env`.
 * A value hostd does not have yet leaves the variable out; it never disables the service.
 */
export const LINK_PLACEHOLDERS = ["voice.url", "voice.token", "stage.url", "stage.token"] as const;
export type LinkPlaceholder = (typeof LINK_PLACEHOLDERS)[number];

/** Whether a placeholder name, as `placeholdersIn` returns it, is one hostd knows. */
export function isKnownPlaceholder(name: string): boolean {
  if (name.startsWith(ENV_PLACEHOLDER_PREFIX)) return name.length > ENV_PLACEHOLDER_PREFIX.length;
  if (name.startsWith(LINK_PLACEHOLDER_PREFIX)) {
    const link = name.slice(LINK_PLACEHOLDER_PREFIX.length);
    return (LINK_PLACEHOLDERS as readonly string[]).includes(link);
  }
  return (PLACEHOLDERS as readonly string[]).includes(name);
}

export interface CatalogEntry {
  name: string;
  /** The folder of the descriptor, absolute. */
  dir: string;
  /** The descriptor file, absolute. */
  file: string;
  descriptor: ServiceDescriptor;
}

export interface CatalogProblem {
  file: string;
  message: string;
}

export interface Catalog {
  services: Map<string, CatalogEntry>;
  problems: CatalogProblem[];
}

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_-]*(?::[A-Za-z_][A-Za-z0-9_.]*)?)\}/g;

/**
 * The names of the `{placeholders}` in a text, in order, repeats included (`env:NAME` and
 * `link:voice.url` whole).
 */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1] as string);
}

/** The folders a root entry stands for that exist. */
function foldersOf(root: string, entry: string): string[] {
  if (!entry.endsWith("/*")) return [join(root, entry)];
  const base = join(root, entry.slice(0, -2));
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => join(base, d.name))
    .sort();
}

function describeIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.map(String).join(".");
    return path === "" ? issue.message : `${path}: ${issue.message}`;
  });
}

/** Every text of a descriptor that may carry placeholders, with where it is. */
function placeholderTexts(descriptor: ServiceDescriptor): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const { run, launch, install } = descriptor;
  if (run) {
    run.command.forEach((part, i) => {
      out.push([`run.command[${i}]`, part]);
    });
    out.push(["run.cwd", run.cwd]);
    for (const [key, value] of Object.entries(run.env)) out.push([`run.env.${key}`, value]);
  }
  if (launch) {
    launch.command.forEach((part, i) => {
      out.push([`launch.command[${i}]`, part]);
    });
    out.push(["launch.cwd", launch.cwd]);
  }
  if (install.project !== undefined) out.push(["install.project", install.project]);
  install.manual.forEach((m, i) => {
    out.push([`install.manual[${i}].path`, m.path]);
  });
  return out;
}

/** What a descriptor lacks for its kind, which the schema cannot say. */
function kindProblems(descriptor: ServiceDescriptor): string[] {
  if (descriptor.kind === "external") {
    return descriptor.probe === undefined ? ["an external service needs [probe]"] : [];
  }
  return descriptor.run === undefined ? [`a ${descriptor.kind} needs [run]`] : [];
}

/** Two `[[install.files]]` that would land on the same file. */
function fileProblems(descriptor: ServiceDescriptor): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  descriptor.install.files.forEach((f, i) => {
    const key = f.path.toLowerCase();
    if (seen.has(key)) out.push(`install.files.${i}.path: ${f.path} is listed twice`);
    seen.add(key);
  });
  return out;
}

/** The placeholders a `[routing]` path may use (those of `install.manual`). */
const ROUTING_PATH_PLACEHOLDERS: ReadonlySet<string> = new Set([
  "voice",
  "state",
  "models",
  "workspace",
  "service",
]);

/** What `[routing]` says that its schema cannot check. */
function routingProblems(descriptor: ServiceDescriptor): string[] {
  const routing = descriptor.routing;
  if (routing === undefined) return [];
  const out: string[] = [];
  if (routing.class === "job" && routing.latency === "realtime") {
    out.push('routing: a realtime service keeps its sessions on one host; use class = "session"');
  }
  if (routing.queue && descriptor.run?.health.http === undefined) {
    out.push(
      "routing.queue: the load is read from [run.health] http, which this service has none of",
    );
  }
  if (descriptor.kind === "external" && routing.queue) {
    out.push("routing.queue: hostd does not probe an external service for its load");
  }
  const paths: Array<[string, string]> = [
    ...routing.needs.files.map((p, i): [string, string] => [`routing.needs.files[${i}]`, p]),
    ...(routing.variant?.files ?? []).map((p, i): [string, string] => [
      `routing.variant.files[${i}]`,
      p,
    ]),
  ];
  for (const [where, path] of paths) {
    for (const name of placeholdersIn(path)) {
      if (!ROUTING_PATH_PLACEHOLDERS.has(name)) out.push(`${where}: unknown placeholder {${name}}`);
    }
  }
  if (routing.yields_to.includes(descriptor.name)) {
    out.push("routing.yields_to: a service does not yield to itself");
  }
  return out;
}

/** The file that may hold a service's `[routing]` beside its `service.toml`. */
export const ROUTING_FILE = "routing.toml";

type RoutingRead = { ok: true; table: unknown } | { ok: false; file: string; message: string };

/**
 * `[routing]` of a descriptor folder: the table in `service.toml`, or the whole of `routing.toml`
 * beside it. The repository uses the second for now: an older hostd rejects an unknown table in
 * `service.toml` and would disable the service, while it never reads `routing.toml`.
 */
function readRouting(dir: string, descriptor: unknown): RoutingRead {
  const file = join(dir, ROUTING_FILE);
  const inline =
    typeof descriptor === "object" && descriptor !== null && "routing" in descriptor
      ? (descriptor as { routing: unknown }).routing
      : undefined;
  if (!existsSync(file)) return { ok: true, table: inline };
  if (inline !== undefined) {
    return {
      ok: false,
      file,
      message: `[routing] is in service.toml and in ${ROUTING_FILE}; keep one`,
    };
  }
  try {
    return { ok: true, table: parseToml(readFileSync(file, "utf8")) };
  } catch (error) {
    return {
      ok: false,
      file,
      message: `not valid TOML: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** Loads every descriptor under the catalog roots of a workspace folder. */
export function loadCatalog(root: string): Catalog {
  const base = resolve(root);
  const services = new Map<string, CatalogEntry>();
  const problems: CatalogProblem[] = [];

  for (const entry of CATALOG_ROOTS) {
    for (const dir of foldersOf(base, entry)) {
      const file = join(dir, DESCRIPTOR_FILE);
      if (!existsSync(file)) continue;
      const fail = (message: string) => problems.push({ file, message });

      let raw: unknown;
      try {
        raw = parseToml(readFileSync(file, "utf8"));
      } catch (error) {
        fail(`not valid TOML: ${error instanceof Error ? error.message : String(error)}`);
        continue;
      }
      const routing = readRouting(dir, raw);
      if (!routing.ok) {
        problems.push({ file: routing.file, message: routing.message });
        continue;
      }
      if (routing.table !== undefined) raw = { ...(raw as object), routing: routing.table };
      const parsed = ServiceDescriptorSchema.safeParse(raw);
      if (!parsed.success) {
        for (const message of describeIssues(parsed.error)) fail(message);
        continue;
      }
      const descriptor = parsed.data;
      const found = [
        ...kindProblems(descriptor),
        ...fileProblems(descriptor),
        ...routingProblems(descriptor),
        ...placeholderTexts(descriptor).flatMap(([where, text]) =>
          placeholdersIn(text).flatMap((name) => {
            if (!isKnownPlaceholder(name)) return [`${where}: unknown placeholder {${name}}`];
            if (name.startsWith(LINK_PLACEHOLDER_PREFIX) && !where.startsWith("run.env.")) {
              return [`${where}: {${name}} may only be used in run.env`];
            }
            return [];
          }),
        ),
      ];
      if (found.length > 0) {
        for (const message of found) fail(message);
        continue;
      }
      const other = services.get(descriptor.name);
      if (other !== undefined) {
        fail(`the name "${descriptor.name}" is already used by ${other.file}`);
        continue;
      }
      services.set(descriptor.name, { name: descriptor.name, dir, file, descriptor });
    }
  }
  return { services, problems };
}
