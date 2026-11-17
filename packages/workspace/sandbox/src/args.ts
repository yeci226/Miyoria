// Argument arrays for the Docker CLI. Everything here is pure so the hardening flags can be
// asserted in unit tests; nothing is ever joined into a shell string.

import type { SandboxLimits } from "./config.js";
import { IMAGE_REF } from "./config.js";
import type { Language } from "./types.js";

/** Label on every sandbox container (startup reaping filters on it). */
export const LABEL = "miyoria.sandbox";
/** Label naming the sandbox root a container belongs to (one core does not reap another's). */
export const LABEL_INSTANCE = "miyoria.sandbox.instance";
/** Label carrying the run id (of a fresh or pooled container) or the session's container id. */
export const LABEL_RUN = "miyoria.sandbox.run";
/** Label saying what a container is for: `run` (fresh), `pool` (warm, one run) or `session`. */
export const LABEL_KIND = "miyoria.sandbox.kind";
/** Label carrying a session's name. */
export const LABEL_SESSION = "miyoria.sandbox.session";
/** Container name prefix. */
export const NAME_PREFIX = "miyoria-sbx-";

/** Mount points inside the container. */
export const WORK_DIR = "/work";
export const CODE_DIR = "/code";
export const TOOLS_DIR = "/tools";
export const WORKSPACE_DIR = "/workspace";

/** Program file per language, inside `CODE_DIR`. */
export const ENTRY_FILE: Record<Language, string> = { python: "main.py", node: "main.mjs" };

/**
 * Interpreter command per language. Python: `-I` isolated mode (ignores `PYTHON*` variables and
 * the user site directory), `-B` no `.pyc` writes, `-u` unbuffered so output survives a kill.
 */
export function entryCommand(language: Language, entry: string = ENTRY_FILE[language]): string[] {
  const file = `${CODE_DIR}/${entry}`;
  return language === "python" ? ["python3", "-I", "-B", "-u", file] : ["node", file];
}

/**
 * What a session container runs while it waits for `docker exec`: nothing but a sleep (under
 * `--init`, which reaps whatever the execs leave behind).
 */
export const KEEPER_COMMAND: readonly string[] = ["sleep", "infinity"];

/** Byte a pooled container writes to stderr once it waits for its program (then dropped). */
export const STANDBY_READY = 0x06;

/**
 * A pooled container's command: says it is up (`STANDBY_READY` on stderr), waits for one line on
 * stdin, then becomes `command` (`exec`), which reads the rest of stdin. The shell reads stdin a
 * byte at a time, so nothing of the program's stdin is lost; EOF before the line just exits.
 */
export function standbyCommand(command: readonly string[]): string[] {
  return ["sh", "-c", `printf '\\006' >&2; IFS= read -r _ || exit 0; exec "$@"`, "sh", ...command];
}

/**
 * The uid:gid a session container's keeper runs as: never the one its programs run as, so
 * `killAllArgs` (as the program's user) ends every program process but not the container.
 */
export function keeperUser(user: string): string {
  return user.split(":")[0] === "65534" ? "65533:65533" : "65534:65534";
}

/**
 * The only environment the program gets besides the image's own `ENV` lines. Nothing comes from
 * the host: `docker run` copies no variables unless asked, and the CLI itself runs with a
 * filtered environment (see `dockerCliEnv`).
 */
export const CONTAINER_ENV: Readonly<Record<string, string>> = {
  HOME: "/tmp",
  TMPDIR: "/tmp",
  LANG: "C.UTF-8",
};

/** Everything `buildRunArgs` needs. Host paths are absolute. */
export interface ContainerSpec {
  name: string;
  image: string;
  labels: Readonly<Record<string, string>>;
  /** Host directory mounted read-write at `/work` (the only writable bind mount). */
  workDir: string;
  /** Host directory with the program, mounted read-only at `/code`. */
  codeDir: string;
  /** Host directory mounted read-only at `/tools`, or `null`. */
  toolsDir: string | null;
  /** Host directory mounted read-write at `/workspace` (her persistent workspace), or `null`. */
  workspaceDir?: string | null;
  /**
   * Docker network. Default `"none"` (no interfaces but loopback). Only the egress network
   * (an `--internal` one whose only neighbour is the allowlist proxy) is ever passed here.
   */
  network?: string;
  /** `uid:gid`, never root. */
  user: string;
  limits: SandboxLimits;
  command: readonly string[];
  env: Readonly<Record<string, string>>;
  /**
   * `docker run -d` (a session container that waits for `docker exec`) instead of an attached
   * `-i` run of the program. Default `false`.
   */
  detached?: boolean;
}

export class InvalidSpecError extends Error {
  override readonly name = "InvalidSpecError";
}

const CONTAINER_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const LABEL_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/;
// Lower case too: `http_proxy` / `https_proxy` are what curl, pip and Python's urllib read.
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const NETWORK_NAME = /^[a-z0-9][a-z0-9_.-]{0,127}$/;
const USER = /^[1-9][0-9]*(:[1-9][0-9]*)?$/;

/**
 * One `--mount` value. Docker parses it as a CSV record, so a field with `,` or `"` is quoted
 * (quotes doubled) instead of letting a host path add mount options.
 */
export function mountArg(fields: readonly string[]): string {
  return fields
    .map((field) => (/[",\r\n]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field))
    .join(",");
}

function bind(source: string, target: string, readonly: boolean): string {
  const fields = ["type=bind", `source=${source}`, `target=${target}`];
  if (readonly) fields.push("readonly");
  return mountArg(fields);
}

/**
 * `docker run` arguments for one sandboxed program:
 *
 * - disposable and findable: `--rm`, `--name`, labels, `-i` (stdin; `-d` for a session container
 *   that waits for `docker exec`), `--pull never` (images are
 *   checked before the clock starts), `--log-driver none` (no copies of the output in Docker);
 * - no network: `--network none`;
 * - file system: `--read-only` root, `--tmpfs /tmp` (noexec, nosuid, nodev, sized), the run
 *   workspace at `/work` (read-write), the program at `/code` and optionally the tools workspace
 *   at `/tools` (both read-only);
 * - privileges: non-root `--user`, `--cap-drop ALL`, `--security-opt no-new-privileges`,
 *   `--ipc none`, Docker's default seccomp profile;
 * - resources: `--memory` = `--memory-swap` (no swap), `--cpus`, `--pids-limit`,
 *   `--ulimit fsize` / `nofile`, `--init` (reaps zombies, forwards the kill);
 * - environment: only `spec.env`, as explicit `NAME=value` pairs.
 *
 * Throws `InvalidSpecError` for values that could be read as flags or options.
 */
export function buildRunArgs(spec: ContainerSpec): string[] {
  if (!CONTAINER_NAME.test(spec.name)) throw new InvalidSpecError(`bad name \`${spec.name}\``);
  if (!IMAGE_REF.test(spec.image)) throw new InvalidSpecError(`bad image \`${spec.image}\``);
  if (!USER.test(spec.user)) {
    throw new InvalidSpecError(`bad user \`${spec.user}\` (must be a non-root uid[:gid])`);
  }
  if (spec.command.length === 0) throw new InvalidSpecError("empty command");
  const network = spec.network ?? "none";
  // `host`, `bridge` and `container:` networks give a run a way out; only `none` and the
  // sandbox's own (prefixed) egress network are allowed.
  if (network !== "none" && !(NETWORK_NAME.test(network) && network.startsWith(NAME_PREFIX))) {
    throw new InvalidSpecError(`bad network \`${network}\``);
  }
  const { limits } = spec;
  const args = ["run", "--rm", spec.detached ? "-d" : "-i", "--name", spec.name];
  for (const [key, value] of Object.entries(spec.labels)) {
    if (!LABEL_KEY.test(key) || /[\r\n]/.test(value)) {
      throw new InvalidSpecError(`bad label \`${key}\``);
    }
    args.push("--label", `${key}=${value}`);
  }
  args.push(
    "--pull",
    "never",
    "--log-driver",
    "none",
    "--network",
    network,
    "--read-only",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpfs_mb}m`,
    "--mount",
    bind(spec.workDir, WORK_DIR, false),
    "--mount",
    bind(spec.codeDir, CODE_DIR, true),
  );
  if (spec.toolsDir !== null) args.push("--mount", bind(spec.toolsDir, TOOLS_DIR, true));
  if (spec.workspaceDir) args.push("--mount", bind(spec.workspaceDir, WORKSPACE_DIR, false));
  args.push(
    "--workdir",
    WORK_DIR,
    "--user",
    spec.user,
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--ipc",
    "none",
    "--hostname",
    "sandbox",
    "--memory",
    `${limits.memory_mb}m`,
    "--memory-swap",
    `${limits.memory_mb}m`,
    "--cpus",
    String(limits.cpus),
    "--pids-limit",
    String(limits.pids_limit),
    "--ulimit",
    `fsize=${limits.max_file_size_bytes}`,
    "--ulimit",
    `nofile=${limits.nofile}:${limits.nofile}`,
    "--init",
  );
  for (const [key, value] of Object.entries(spec.env)) {
    if (!ENV_NAME.test(key) || /[\0\r\n]/.test(value)) {
      throw new InvalidSpecError(`bad env \`${key}\``);
    }
    args.push("--env", `${key}=${value}`);
  }
  // `--` is not needed: everything after the image is the container's command, never parsed as
  // a Docker flag. The image itself cannot start with `-` (IMAGE_REF).
  args.push(spec.image, ...spec.command);
  return args;
}

/**
 * `docker exec` of a program in a session container (it inherits the container's environment,
 * working directory and limits). `user` overrides the container's user.
 */
export function execArgs(name: string, command: readonly string[], user?: string): string[] {
  if (!CONTAINER_NAME.test(name)) throw new InvalidSpecError(`bad name \`${name}\``);
  if (user !== undefined && !USER.test(user)) throw new InvalidSpecError(`bad user \`${user}\``);
  if (command.length === 0) throw new InvalidSpecError("empty command");
  return ["exec", "-i", ...(user === undefined ? [] : ["--user", user]), name, ...command];
}

/**
 * Kills every process of `user` in a session container except the caller (`kill(-1)` skips
 * PID 1 and processes of other users, so the keeper and the container stay).
 */
export function killAllArgs(name: string, user: string): string[] {
  if (!CONTAINER_NAME.test(name)) throw new InvalidSpecError(`bad name \`${name}\``);
  if (!USER.test(user)) throw new InvalidSpecError(`bad user \`${user}\``);
  return ["exec", "--user", user, name, "sh", "-c", "kill -KILL -1; kill -KILL -1; exit 0"];
}

/** `docker container inspect` printing whether it runs (`true`); fails when it is gone. */
export function runningArgs(name: string): string[] {
  return ["container", "inspect", "--format", "{{.State.Running}}", name];
}

/** `docker kill <name>`. */
export function killArgs(name: string): string[] {
  return ["kill", "--signal", "KILL", name];
}

/** `docker rm -f <names...>`. */
export function removeArgs(names: readonly string[]): string[] {
  return ["rm", "-f", ...names];
}

/** `docker ps` listing every sandbox container (running or not) of one instance. */
export function listArgs(instance: string): string[] {
  return [
    "ps",
    "-a",
    "-q",
    "--filter",
    `label=${LABEL}=1`,
    "--filter",
    `label=${LABEL_INSTANCE}=${instance}`,
  ];
}

/** `docker version` with only the server version (fails when the daemon is down). */
export function versionArgs(): string[] {
  return ["version", "--format", "{{.Server.Version}}"];
}

/** `docker image inspect` (exit 0 = present locally). */
export function inspectImageArgs(image: string): string[] {
  return ["image", "inspect", "--format", "{{.Id}}", image];
}

/** `docker pull`. */
export function pullArgs(image: string): string[] {
  return ["pull", "--quiet", image];
}

/**
 * Host variables the Docker CLI itself may need (finding the daemon, its config and credential
 * helpers). Everything else, including every Miyoria secret, is left out, so not even the CLI
 * process has them to forward.
 */
const CLI_ENV_ALLOW = new Set(
  [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "SYSTEMDRIVE",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "TEMP",
    "TMP",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "DOCKER_CERT_PATH",
    "DOCKER_TLS_VERIFY",
    "DOCKER_API_VERSION",
  ].map((name) => name.toUpperCase()),
);

/** The filtered environment for the Docker CLI process (names compared case-insensitively). */
export function dockerCliEnv(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value !== undefined && CLI_ENV_ALLOW.has(name.toUpperCase())) out[name] = value;
  }
  return out;
}
