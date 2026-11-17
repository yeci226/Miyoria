// Logging: one pino root logger, scoped child loggers everywhere else.
//
//   const log = getLogger("llm.router");          // module-scope, at import time
//   log.warn({ model, err }, "model failed, trying next in chain");
//
// Modules use `ctx.log` (bound to `{ module: <id> }`). Messages are English; only user-facing
// strings (chat replies, CLI output, panel text) are Traditional Chinese.
//
// Loggers are bound lazily, so `configureLogging()` (called once by the app at boot) also
// reconfigures loggers created at import time.

import pino from "pino";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";

export type LogBindings = Record<string, unknown>;

export interface LogFn {
  /** Structured fields first, then the message. An `err` field is serialized as an error. */
  (fields: object, message?: string): void;
  (message: string): void;
}

export interface Logger {
  readonly fatal: LogFn;
  readonly error: LogFn;
  readonly warn: LogFn;
  readonly info: LogFn;
  readonly debug: LogFn;
  readonly trace: LogFn;
  child(bindings: LogBindings): Logger;
}

export interface LoggingOptions {
  /** Default: `$MIYORIA_LOG_LEVEL`, else `"silent"` under Vitest and `"info"` otherwise. */
  level?: LogLevel;
  /** Default: stdout (JSON lines, or `pretty` lines on a terminal). */
  destination?: pino.DestinationStream;
  /**
   * One readable line per entry instead of JSON. Default: `$MIYORIA_LOG_FORMAT` (`pretty` /
   * `json`), else pretty when stdout is a terminal. Ignored with a `destination`.
   */
  pretty?: boolean;
}

function defaultLevel(): LogLevel {
  const env = process.env.MIYORIA_LOG_LEVEL;
  if (env) return env as LogLevel;
  return process.env.VITEST ? "silent" : "info";
}

function defaultPretty(): boolean {
  const env = process.env.MIYORIA_LOG_FORMAT;
  if (env === "json") return false;
  if (env === "pretty") return true;
  return process.stdout.isTTY === true;
}

const LEVEL_NAMES: Record<number, string> = {
  10: "TRACE",
  20: "DEBUG",
  30: "INFO ",
  40: "WARN ",
  50: "ERROR",
  60: "FATAL",
};
const LEVEL_COLORS: Record<number, string> = {
  10: "90",
  20: "90",
  30: "36",
  40: "33",
  50: "31",
  60: "31",
};
const HIDDEN_FIELDS = new Set(["level", "time", "pid", "hostname", "msg", "scope", "module"]);

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** One pino JSON line as `HH:MM:SS INFO  scope/module message key=value ...`. */
export function formatLogLine(line: string, color: boolean): string {
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return line;
  }
  const paint = (code: string, text: string) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const level = typeof entry.level === "number" ? entry.level : 30;
  const d = new Date(typeof entry.time === "number" ? entry.time : Date.now());
  const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const where = [entry.module, entry.scope].filter((v) => typeof v === "string").join(" ");
  const fields = Object.entries(entry)
    .filter(([k]) => !HIDDEN_FIELDS.has(k))
    .map(([k, v]) => {
      if (k === "err" && v !== null && typeof v === "object") {
        const err = v as { message?: unknown; stack?: unknown };
        return `err=${String(err.message ?? JSON.stringify(v))}`;
      }
      return `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`;
    });
  return [
    paint("90", time),
    paint(LEVEL_COLORS[level] ?? "0", LEVEL_NAMES[level] ?? String(level)),
    where === "" ? "" : paint("35", where),
    String(entry.msg ?? ""),
    fields.length === 0 ? "" : paint("90", fields.join(" ")),
  ]
    .filter((part) => part !== "")
    .join(" ");
}

/** pino destination that writes `formatLogLine` output to stdout. */
function prettyDestination(): pino.DestinationStream {
  const color = process.stdout.isTTY === true && !process.env.NO_COLOR;
  return {
    write(chunk: string) {
      for (const line of chunk.split("\n")) {
        if (line !== "") process.stdout.write(`${formatLogLine(line, color)}\n`);
      }
    },
  };
}

function makeRoot(options: LoggingOptions): pino.Logger {
  const config: pino.LoggerOptions = { level: options.level ?? defaultLevel() };
  if (options.destination) return pino(config, options.destination);
  return (options.pretty ?? defaultPretty()) ? pino(config, prettyDestination()) : pino(config);
}

let root = makeRoot({});
let generation = 0;

/** Replaces the root logger (level / destination). Existing loggers follow. */
export function configureLogging(options: LoggingOptions = {}): void {
  root = makeRoot(options);
  generation++;
}

const LEVELS = ["fatal", "error", "warn", "info", "debug", "trace"] as const;

class BoundLogger implements Logger {
  readonly #bindings: LogBindings;
  #inner: pino.Logger | undefined;
  #generation = -1;

  declare readonly fatal: LogFn;
  declare readonly error: LogFn;
  declare readonly warn: LogFn;
  declare readonly info: LogFn;
  declare readonly debug: LogFn;
  declare readonly trace: LogFn;

  constructor(bindings: LogBindings) {
    this.#bindings = bindings;
    for (const level of LEVELS) {
      const fn = (fields: object | string, message?: string) => {
        const inner = this.#target();
        if (typeof fields === "string") inner[level](fields);
        else inner[level](fields, message);
      };
      Object.defineProperty(this, level, { value: fn, enumerable: false });
    }
  }

  #target(): pino.Logger {
    if (this.#generation !== generation || this.#inner === undefined) {
      this.#inner = root.child(this.#bindings);
      this.#generation = generation;
    }
    return this.#inner;
  }

  child(bindings: LogBindings): Logger {
    return new BoundLogger({ ...this.#bindings, ...bindings });
  }
}

/** Logger bound to `{ scope }`, e.g. `getLogger("kernel.supervisor")`. */
export function getLogger(scope: string): Logger {
  return new BoundLogger({ scope });
}
