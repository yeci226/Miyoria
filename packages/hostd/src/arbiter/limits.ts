// The policy and the limits of GPU arbitration, under the names and defaults the song worker has
// always read them (workers/sing/gpu.py `policy_from_env`, `Limits.from_env`). Durations are
// seconds, as in the recorded table: the arithmetic must be Python's, float for float.

import { pyFloat, pyInt } from "./num.js";

export const POLICIES = ["yield", "auto", "share", "offload", "wait"] as const;
export type Policy = (typeof POLICIES)[number];

/** Stages that can run on the CPU instead, so they never take her voice's card. */
export const CPU_STAGES: readonly string[] = ["separate", "lead"];

export interface Limits {
  prior_need_mb: number;
  headroom_pct: number;
  room_wait_s: number;
  defer_s: number;
  wait_max_s: number;
  silence_max_s: number;
  silence_gap_s: number;
  lease_s: number;
  spill_factor: number;
  spill_step_s: number;
  steps: number;
  steps_min: number;
  yield_max_s: number;
  yield_patient_s: number;
  context_ttl_s: number;
  check_s: number;
  burst_mb: number;
}

/** Each limit's variable, default and parser (`int` falls back on anything `int()` rejects, `1.5` too). */
export const LIMITS_ENV: {
  readonly [K in keyof Limits]: { env: string; default: number; type: "int" | "float" };
} = {
  prior_need_mb: { env: "SING_SHARE_MIN_FREE_MB", default: 4096, type: "int" },
  headroom_pct: { env: "SING_GPU_HEADROOM_PCT", default: 12.0, type: "float" },
  room_wait_s: { env: "SING_SHARE_WAIT_S", default: 0.0, type: "float" },
  defer_s: { env: "SING_DEFER_S", default: 120.0, type: "float" },
  wait_max_s: { env: "SING_WAIT_MAX_S", default: 600.0, type: "float" },
  silence_max_s: { env: "SING_SILENCE_MAX_S", default: 90.0, type: "float" },
  silence_gap_s: { env: "SING_SILENCE_GAP_S", default: 60.0, type: "float" },
  lease_s: { env: "SING_OFFLOAD_LEASE_S", default: 60.0, type: "float" },
  spill_factor: { env: "SING_SPILL_FACTOR", default: 5.0, type: "float" },
  spill_step_s: { env: "SING_SPILL_STEP_S", default: 2.0, type: "float" },
  steps: { env: "SING_DIFFUSION_STEPS", default: 30, type: "int" },
  steps_min: { env: "SING_DIFFUSION_STEPS_MIN", default: 20, type: "int" },
  yield_max_s: { env: "SING_YIELD_MAX_S", default: 120.0, type: "float" },
  yield_patient_s: { env: "SING_YIELD_PATIENT_S", default: 900.0, type: "float" },
  context_ttl_s: { env: "SING_CONTEXT_TTL_S", default: 20.0, type: "float" },
  check_s: { env: "SING_GPU_CHECK_S", default: 1.0, type: "float" },
  burst_mb: { env: "SING_SPEECH_BURST_MB", default: 1024, type: "int" },
};

export const LIMITS_DEFAULT: Readonly<Limits> = Object.freeze(
  Object.fromEntries(
    Object.entries(LIMITS_ENV).map(([k, v]) => [k, v.default]),
  ) as unknown as Limits,
);

export type Settings = Readonly<Record<string, string | undefined>>;

/** `Limits.from_env`: every limit from its variable, the default where it is unset or unparsable. */
export function limitsFrom(settings: Settings): Limits {
  const out = { ...LIMITS_DEFAULT };
  for (const [field, info] of Object.entries(LIMITS_ENV) as [
    keyof Limits,
    (typeof LIMITS_ENV)[keyof Limits],
  ][]) {
    const raw = settings[info.env];
    if (raw === undefined) continue;
    const value = info.type === "int" ? pyInt(raw) : pyFloat(raw);
    if (value !== null) out[field] = value;
  }
  return out;
}

export type PolicySource = "SING_GPU_POLICY" | "SING_GPU_SHARE" | "default";

/**
 * `policy_from_env`: `SING_GPU_POLICY` when it names a policy; else the older `SING_GPU_SHARE`
 * (`1` is `auto`, anything else set is `offload`); else `yield`.
 */
export function policyFrom(settings: Settings): { policy: Policy; source: PolicySource } {
  const raw = (settings.SING_GPU_POLICY ?? "").trim().toLowerCase();
  if ((POLICIES as readonly string[]).includes(raw))
    return { policy: raw as Policy, source: "SING_GPU_POLICY" };
  const legacy = (settings.SING_GPU_SHARE ?? "").trim();
  if (legacy !== "")
    return { policy: legacy === "1" ? "auto" : "offload", source: "SING_GPU_SHARE" };
  return { policy: "yield", source: "default" };
}
