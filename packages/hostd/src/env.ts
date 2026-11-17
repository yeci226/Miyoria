// The environment a service starts with (docs/design/v5-hostd.md §4): the base allowlist and the
// descriptor's `pass_env` from the daemon's own environment, then the descriptor's `env`, then
// `host.toml`'s, then what hostd adds. Nothing else of the daemon's environment is passed on.

const ENV_ALLOW =
  /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|USERNAME|APPDATA|LOCALAPPDATA|PROGRAMDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|COMPUTERNAME|NUMBER_OF_PROCESSORS|PROCESSOR_\w+|OS|LANG|LC_\w+|TZ|CUDA_\w+|NVIDIA_\w+|HF_\w+|HUGGINGFACE_\w+|TRANSFORMERS_\w+|TORCH\w*|XDG_\w+|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|LOG_LEVEL)$/i;

/**
 * What a worker inherits: the system basics, CUDA and model-cache variables, proxies. Not the rest
 * of the shell (API keys, tokens), and not a stale `ASR_MODEL` left from an older setup.
 */
export function workerBaseEnv(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && ENV_ALLOW.test(key)) out[key] = value;
  }
  return out;
}

/**
 * Whether a variable name matches one `pass_env` pattern: `*` alone is every name, a trailing `*`
 * a prefix, anything else the name itself. Case is ignored on Windows, where variable names are.
 */
export function matchesPassEnv(
  name: string,
  pattern: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (pattern === "*") return true;
  const fold = (s: string) => (platform === "win32" ? s.toUpperCase() : s);
  const n = fold(name);
  const p = fold(pattern);
  return p.endsWith("*") ? n.startsWith(p.slice(0, -1)) : n === p;
}

/** The daemon's variables that the patterns select. */
export function passEnv(
  patterns: readonly string[],
  source: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (patterns.length === 0) return out;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && patterns.some((p) => matchesPassEnv(key, p, platform)))
      out[key] = value;
  }
  return out;
}

/**
 * Merges layers of variables, later ones winning. On Windows a later `Path` replaces an earlier
 * `PATH`, since both name one variable there.
 */
export function mergeEnv(
  layers: ReadonlyArray<Record<string, string>>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  const keyOf = new Map<string, string>();
  for (const layer of layers) {
    for (const [key, value] of Object.entries(layer)) {
      if (platform === "win32") {
        const folded = key.toUpperCase();
        const previous = keyOf.get(folded);
        if (previous !== undefined && previous !== key) delete out[previous];
        keyOf.set(folded, key);
      }
      out[key] = value;
    }
  }
  return out;
}
