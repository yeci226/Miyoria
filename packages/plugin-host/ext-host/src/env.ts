// The environment of an extension process. Extensions used to inherit the core's whole
// `process.env`, which holds its secrets (`LLM_API_KEY`, `DISCORD_BOT_TOKEN`,
// `MIYORIA_API_TOKEN`, ...). Now they get:
//
// 1. a fixed platform allowlist (`BASE_ENV`: what runtimes and the OS need to start, find
//    executables, temp and home directories, locale);
// 2. the host variables the manifest declares (`[env] pass`), or the owner's `env_pass`
//    instead;
// 3. the literal values of `[extensions."<id>"] env`;
// 4. `MIYORIA_RPC` and `MIYORIA_EXTENSION_ID`, always.
//
// Not passed on purpose: `NODE_OPTIONS` (a dev loader of the core is no business of an
// extension), proxies (their URLs may carry credentials; pass them explicitly if needed).

/** Platform variables every extension gets (matched case-insensitively on Windows). */
export const BASE_ENV: readonly string[] = [
  // Finding executables and the OS.
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  // Temp, home and per-user directories.
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "COMMONPROGRAMFILES",
  "COMMONPROGRAMFILES(X86)",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  // Who and where.
  "USER",
  "USERNAME",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  // Terminal output of their logs.
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  // TLS trust stores (paths, not secrets).
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];

/** What an extension may receive besides `BASE_ENV`. */
export interface ExtensionEnv {
  /** Host variable names (or `PREFIX*`) passed through. */
  pass: readonly string[];
  /** Values set for the process (win over everything but the protocol variables). */
  set: Readonly<Record<string, string>>;
}

function matcher(patterns: readonly string[], caseless: boolean): (name: string) => boolean {
  const norm = (s: string) => (caseless ? s.toUpperCase() : s);
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const p of patterns) {
    if (p.endsWith("*")) prefixes.push(norm(p.slice(0, -1)));
    else exact.add(norm(p));
  }
  return (name) => {
    const n = norm(name);
    return exact.has(n) || prefixes.some((prefix) => prefix !== "" && n.startsWith(prefix));
  };
}

/**
 * The environment of extension `id`: `BASE_ENV` and `env.pass` from `source` (default
 * `process.env`), then `env.set`, then the protocol variables.
 */
export function extensionEnv(
  id: string,
  env: ExtensionEnv = { pass: [], set: {} },
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const caseless = platform === "win32";
  const base = matcher(BASE_ENV, caseless);
  const passed = matcher(env.pass, caseless);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (base(name) || passed(name)) out[name] = value;
  }
  // A configured value replaces an inherited one, whatever its case on Windows.
  for (const [name, value] of Object.entries(env.set)) {
    if (caseless) {
      for (const key of Object.keys(out)) {
        if (key.toUpperCase() === name.toUpperCase()) delete out[key];
      }
    }
    out[name] = value;
  }
  out.MIYORIA_RPC = "stdio";
  out.MIYORIA_EXTENSION_ID = id;
  return out;
}
