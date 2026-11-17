// Where a stage runs: `decide` and the small rules around it, ported line for line from
// workers/sing/gpu.py and checked against every recorded case (test/arbiter/table.test.ts).
// Pure: everything a rule looks at is in its arguments. Reasons are the Chinese sentences she
// may say, with Python's number formatting.

import { CPU_STAGES, type Limits, type Policy } from "./limits.js";
import { pyFixed } from "./num.js";

/** Everything one placement decision looks at (gpu.py `Facts`). */
export interface Facts {
  policy: Policy;
  stage: string;
  limits: Limits;
  cuda: boolean;
  /** The stage is set to use the card. */
  on_gpu: boolean;
  /** The stage stops between steps while she speaks (not her RVC model). */
  pauses: boolean;
  total_mb: number | null;
  free_mb: number | null;
  own_mb: number;
  need_mb: number;
  headroom_mb: number;
  /** What offloading her voice gives. */
  freed_mb: number | null;
  speech_loaded: boolean;
  people: boolean | null;
  urgent: boolean;
  /** This wait. */
  waited_s: number;
  /** This job. */
  waited_total_s: number;
  silence_est_s: number | null;
  /** Until a window may open again. */
  gap_s: number;
  /** Her voice is offline for this job. */
  window: boolean;
  /** A window was tried and it still spilled. */
  offload_useless: boolean;
  /** Separation spilled. */
  cpu_only: boolean;
  /** Under `yield`, this stage goes to the CPU when there is no room. */
  cpu_fallback: boolean;
  /** The room at the last spill or out-of-memory. */
  crowded_mb: number | null;
}

export type DecisionMode = "share" | "offload" | "exclusive" | "wait" | "cpu" | "give_up";

export interface Decision {
  mode: DecisionMode;
  code: string;
  reason: string;
}

/** `_gb`: MB as GB with one decimal, or 未知. */
export function gb(mb: number | null): string {
  return mb === null ? "未知" : `${pyFixed(mb / 1024, 1)} GB`;
}

const f0 = (x: number): string => pyFixed(x, 0);

/** What the stage does now (gpu.py `decide`). */
export function decide(f: Facts): Decision {
  const limits = f.limits;
  if (!f.cuda)
    return { mode: "cpu", code: "no_cuda", reason: "這台機器沒有 CUDA,用 CPU 做,語音不受影響" };
  if (!f.on_gpu) return { mode: "cpu", code: "configured_cpu", reason: "這個階段設定在 CPU 上跑" };
  if (f.window)
    return { mode: "exclusive", code: "window", reason: "語音暫時離線,顯示卡給這首歌用" };
  if (f.cpu_only) {
    return { mode: "cpu", code: "spill_cpu", reason: "分離在顯示卡上溢出了,改用 CPU,語音不受影響" };
  }

  const room = f.free_mb === null ? null : f.free_mb + f.own_mb;
  // A stage that cannot stop while she speaks leaves her voice the room it takes meanwhile.
  const burst = f.pauses || !f.speech_loaded ? 0 : limits.burst_mb;
  const want = f.need_mb + f.headroom_mb + burst;
  const have = `有 ${gb(room)},要 ${gb(want)}${burst ? `,含她說話用的 ${gb(burst)}` : ""}`;
  // After a spill or an OOM the estimate was wrong: only more room than then counts.
  const fits =
    room !== null &&
    room >= want &&
    (f.crowded_mb === null || room >= f.crowded_mb + f.need_mb * 0.1);
  const separate = CPU_STAGES.includes(f.stage);

  if (f.policy === "share") {
    if (f.crowded_mb !== null && f.waited_s < limits.defer_s) {
      return {
        mode: "wait",
        code: "share_spill",
        reason: `剛剛溢出,放掉顯存等一下再繼續(${have})`,
      };
    }
    return { mode: "share", code: "policy_share", reason: `設定是一律共用,不動語音(${have})` };
  }
  if (f.policy === "offload") {
    if (!f.speech_loaded) {
      return {
        mode: "share",
        code: "nothing_to_offload",
        reason: "設定是獨佔,但沒有語音 worker 可以讓",
      };
    }
    if (f.offload_useless && !fits && f.waited_s < limits.defer_s) {
      return {
        mode: "wait",
        code: "offload_useless",
        reason: `語音讓出來還是溢出,先等空間(${have})`,
      };
    }
    return { mode: "offload", code: "policy_offload", reason: "設定是一律獨佔,語音暫時離線" };
  }
  if (fits) {
    if (!f.pauses)
      return { mode: "share", code: "fits", reason: `顯示卡放得下(${have}),跟語音一起跑` };
    return {
      mode: "share",
      code: "fits",
      reason: `顯示卡放得下(${have}),跟語音一起跑,她說話時讓路`,
    };
  }
  if (f.policy === "wait") {
    if (separate)
      return {
        mode: "cpu",
        code: "policy_wait_cpu",
        reason: `設定是等空間,分離先用 CPU 做(${have})`,
      };
    return { mode: "wait", code: "policy_wait", reason: `設定是等空間,不動語音(${have})` };
  }
  if (room === null && !f.speech_loaded) {
    return { mode: "share", code: "unknown_card", reason: "讀不到顯示卡,也沒有語音可以讓,直接跑" };
  }

  const can = f.speech_loaded && !f.offload_useless;
  const noRoomCpu: Decision = {
    mode: "cpu",
    code: "no_room_cpu",
    reason: `顯示卡放不下(${have}),分離改用 CPU,語音不受影響`,
  };
  const gap: Decision = {
    mode: "wait",
    code: "gap",
    reason: `她剛回來,先讓她說話,${f0(f.gap_s)} 秒後才能再用整張卡`,
  };
  if (f.policy === "yield") {
    if (f.cpu_fallback && (!can || f.gap_s > 0)) return noRoomCpu;
    if (f.gap_s > 0 && can) return gap;
    if (can) {
      const [code, why] = f.urgent ? ["urgent", "這首現在就要,"] : ["no_room", ""];
      return {
        mode: "offload",
        code,
        reason: `${why}顯示卡放不下(${have}),語音暫時離線,最多 ${f0(limits.silence_max_s)} 秒`,
      };
    }
    // Bounded like `auto`'s wait (since 2026-11-16; before, it waited for ever).
    if (f.waited_total_s >= limits.wait_max_s) {
      return {
        mode: "give_up",
        code: "no_room",
        reason: `等了 ${f0(f.waited_total_s / 60)} 分鐘顯示卡還是放不下這首(${have})`,
      };
    }
    return {
      mode: "wait",
      code: "no_room",
      reason: `顯示卡放不下(${have}),語音讓出來也沒用,等空間`,
    };
  }
  const helps = can && (f.freed_mb === null || room === null || room + f.freed_mb >= want);
  const small = f.total_mb !== null && f.total_mb < want;

  if (f.people === false && helps && f.waited_s >= limits.room_wait_s) {
    return {
      mode: "offload",
      code: "nobody_listening",
      reason: `顯示卡放不下(${have}),沒有人在聽,請語音先讓出來`,
    };
  }
  if (separate && (!f.urgent || !can || f.gap_s > 0)) return noRoomCpu;
  if (f.gap_s > 0 && can) return gap;
  if (f.urgent && can) {
    return {
      mode: "offload",
      code: "urgent",
      reason: `這首現在就要,顯示卡放不下(${have}),語音暫時離線,最多 ${f0(limits.silence_max_s)} 秒`,
    };
  }
  const short = f.silence_est_s !== null && f.silence_est_s <= limits.silence_max_s;
  if (helps && short && f.waited_s >= limits.defer_s) {
    return {
      mode: "offload",
      code: "short_silence",
      reason: `等了 ${f0(f.waited_s)} 秒還是放不下,預估 ${f0(f.silence_est_s as number)} 秒就好,語音暫時離線`,
    };
  }
  if (f.waited_total_s >= limits.wait_max_s) {
    if (can) {
      return {
        mode: "offload",
        code: "waited_long",
        reason: `等了 ${f0(f.waited_total_s)} 秒,分段做,語音每次最多離線 ${f0(limits.silence_max_s)} 秒`,
      };
    }
    if (!small) {
      return {
        mode: "give_up",
        code: "no_room",
        reason: `等了 ${f0(f.waited_total_s / 60)} 分鐘顯示卡還是放不下這首(${have})`,
      };
    }
  }
  if (small && !can) {
    return { mode: "share", code: "too_small", reason: `整張卡都放不下估計值(${have}),只能試試看` };
  }
  let who = f.people ? "有人在聽" : f.people === null ? "不確定有沒有人在聽" : "語音幫不上忙";
  if (f.offload_useless) who = "語音讓出來也沒用";
  return { mode: "wait", code: "no_room", reason: `顯示卡放不下(${have}),${who},等空間` };
}

/**
 * Free VRAM the card must keep: a share of the card, or more once a spill taught that
 * (`Profile.headroom`; `round` is half to even).
 */
export function headroom(totalMb: number | null, pct: number, learnedMb: number | null): number {
  const base = Number(pyFixed(((totalMb ?? 0) * pct) / 100, 0));
  return Math.max(base, Math.trunc(learnedMb ?? 0));
}

/** How long in total a job gives way while she speaks (`GpuJob.yield_allowance`). */
export function yieldAllowance(urgent: boolean, people: boolean | null, limits: Limits): number {
  return urgent || people === false ? limits.yield_max_s : limits.yield_patient_s;
}

/** How long it stays out of the way after the last busy answer (`SpeechYield.hold_s`). */
export function yieldHold(pollS: number, holdS: number): number {
  return Math.max(holdS, 2 * pollS);
}

/** The job, or one queued behind it, is needed now (server.py `_urgent`). */
export function urgentOf(
  job: string,
  queued: readonly string[],
  urgent: ReadonlySet<string>,
): boolean {
  return urgent.has(job) || queued.some((j) => urgent.has(j));
}

/** `silence_estimate`: the worker's estimate of the work left, plus how long a reload takes. */
export function silenceEstimate(workS: number | null, reloadS: number): number | null {
  return workS === null ? null : workS + reloadS;
}
