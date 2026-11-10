// The emergency stop (docs/design/v3-architecture.md §16). One button: she shuts up, the stream ends
// and the game stops. In this order:
//
// 1. `pause`: the flag every output path reads. From here on the gate lets only commands and the
//    panel act, the scheduler sends nothing of hers and the voice sink says nothing.
// 2. `silence`: turns in flight end, queued lines are dropped, speech stops mid-sentence.
// 3. `song`, `stream`, `voice`, `game`: each as a `panel` principal, the broadcast, the voice channel
//    and the game through the ActivityManager, and each waits until the manager's state shows it
//    happened: a task that says "done" with the stream still up is not done.
//
// A step that fails or hangs does not stop the ones after it. The result of each goes back to
// whoever pressed the button, and pressing it again runs them all again.
//
// `resume` lifts the flag. Nothing comes back on its own: she does not rejoin the channel, and what
// was said while she was stopped is in her history but gets no answer.

import { errorMessage, getLogger, type ServiceLookup, sleep } from "@miyoria/kernel";
import {
  ActionSinkKey,
  type ActivityManager,
  ActivityManagerKey,
  type ActivityRequest,
  type ActivitySnapshot,
  type Clock,
  customEvent,
  EMERGENCY_TOPIC,
  type EmergencyReport,
  type EmergencyStep,
  type EmergencyStepName,
  type Event,
  type JsonValue,
  type Principal,
  Principals,
  type TaskId,
  TurnSilencerKey,
  toTimestamp,
  VoiceSinkKey,
} from "@miyoria/types";
import type { ActionOutcome, ActionRequest } from "./capability.js";

const log = getLogger("actions.emergency");

const WHY = "緊急停止";
/** The capability that ends a song: the ActivityManager leaves songs to the singer. */
const SONG_STOP = "sing.stop";
/** How often a task and her state are looked at while a step waits for them. */
const POLL_MS = 100;

export interface EmergencyDeps {
  services: ServiceLookup;
  clock: Clock;
  publish(event: Event): void;
  /** The flag: in memory at once, then persisted. */
  setPaused(paused: boolean): Promise<void>;
  /** Runs a capability through the gate. */
  invoke(request: ActionRequest, signal: AbortSignal): Promise<ActionOutcome>;
  /** How long one step may take. */
  stepMs(): number;
}

/** A step ran out of time. */
class StepTimeout extends Error {
  override readonly name = "StepTimeout";
}

export class EmergencyStop {
  readonly #d: EmergencyDeps;
  /** The stop in progress: a second press joins it, a resume waits for it. */
  #running: Promise<EmergencyReport> | null = null;
  #last: EmergencyReport | null = null;

  constructor(deps: EmergencyDeps) {
    this.#d = deps;
  }

  /** The last time the button was pressed either way. */
  get last(): EmergencyReport | null {
    return this.#last;
  }

  /** `by`: who, for the report (`panel:owen`). `actor`: the panel principal's actor. */
  stop(by: string, actor: string): Promise<EmergencyReport> {
    this.#running ??= this.#stop(by, Principals.panel(actor)).finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async resume(by: string): Promise<EmergencyReport> {
    await this.#running;
    const step = await this.#step("resume", null, async () => {
      await this.#d.setPaused(false);
      return "她可以再開口和行動了";
    });
    return this.#report(by, false, [step]);
  }

  #report(by: string, paused: boolean, steps: EmergencyStep[]): EmergencyReport {
    const at = toTimestamp(this.#d.clock.now());
    const report: EmergencyReport = { paused, by, at, steps };
    this.#last = report;
    log.warn({ by, paused, steps }, paused ? "emergency stop" : "emergency stop lifted");
    this.#d.publish(customEvent(EMERGENCY_TOPIC, report as unknown as JsonValue));
    return report;
  }

  async #stop(by: string, principal: Principal): Promise<EmergencyReport> {
    const limit = this.#d.stepMs();
    const steps: EmergencyStep[] = [];
    steps.push(
      await this.#step("pause", null, async () => {
        await this.#d.setPaused(true);
        return "只有指令和面板能讓她行動";
      }),
    );
    steps.push(await this.#step("silence", null, () => this.#silence()));
    steps.push(await this.#step("song", limit, (signal) => this.#song(principal, signal)));
    steps.push(
      await this.#transition("stream", limit, principal, {
        request: { type: "stop_live" },
        over: (s) => s.broadcast.type === "off",
        idle: "沒有在直播",
        done: "直播已結束",
      }),
    );
    steps.push(
      await this.#transition("voice", limit, principal, {
        request: { type: "leave_voice" },
        over: (s) => s.presence.type === "none",
        idle: "不在語音裡",
        done: "已離開語音",
      }),
    );
    steps.push(
      await this.#transition("game", limit, principal, {
        request: { type: "stop", activity: "game" },
        // A game that failed stays in the state for a while so everyone sees why: it is over.
        over: (s) => s.activity.type !== "game" || s.activity.phase === "failed",
        idle: "沒有在玩遊戲",
        done: "遊戲已停止",
      }),
    );
    return this.#report(by, true, steps);
  }

  /** One step: it answers what happened, and nothing it does can take the others with it. */
  async #step(
    step: EmergencyStepName,
    limit: number | null,
    work: (signal: AbortSignal) => Promise<string>,
  ): Promise<EmergencyStep> {
    const control = new AbortController();
    const timer = limit === null ? null : setTimeout(() => control.abort(new StepTimeout()), limit);
    try {
      const stopped = new Promise<never>((_, reject) => {
        control.signal.addEventListener("abort", () => reject(control.signal.reason), {
          once: true,
        });
      });
      const running = work(control.signal);
      running.catch(() => undefined);
      return { step, ok: true, detail: await Promise.race([running, stopped]) };
    } catch (error) {
      const detail = error instanceof StepTimeout ? "逾時,沒有確認到結果" : errorMessage(error);
      log.warn({ step, detail }, "an emergency stop step failed");
      return { step, ok: false, detail };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /** Who holds a line drops it. One that fails does not keep the next from dropping its own. */
  async #silence(): Promise<string> {
    const { services } = this.#d;
    const failed: string[] = [];
    const attempt = async (what: string, work: () => unknown): Promise<void> => {
      try {
        await work();
      } catch (error) {
        failed.push(`${what}:${errorMessage(error)}`);
      }
    };
    await attempt("回合", () => services.get(TurnSilencerKey)?.silence(WHY));
    let dropped = 0;
    await attempt("排程", async () => {
      dropped = (await services.get(ActionSinkKey)?.silence?.()) ?? 0;
    });
    await attempt("語音", () => services.get(VoiceSinkKey)?.silence?.());
    if (failed.length > 0) throw new Error(failed.join(";"));
    return dropped === 0 ? "她閉嘴了" : `她閉嘴了,丟掉 ${dropped} 個排隊中的動作`;
  }

  async #song(principal: Principal, signal: AbortSignal): Promise<string> {
    const outcome = await this.#d.invoke(
      { principal, capability: SONG_STOP, args: { all: true }, why: WHY, turn: null },
      signal,
    );
    switch (outcome.status) {
      case "done":
        return typeof outcome.result === "string" ? outcome.result : outcome.result.text;
      case "failed":
        throw new Error(outcome.error);
      case "denied":
        // Not registered: there is no singer, so nothing is playing.
        if (outcome.decision.stage === "unknown") return "沒有在唱歌";
        throw new Error(outcome.decision.reason);
    }
  }

  async #transition(
    step: EmergencyStepName,
    limit: number,
    principal: Principal,
    plan: {
      request: ActivityRequest;
      over: (snapshot: ActivitySnapshot) => boolean;
      idle: string;
      done: string;
    },
  ): Promise<EmergencyStep> {
    let task: TaskId | null = null;
    const manager = this.#d.services.get(ActivityManagerKey);
    const result = await this.#step(step, limit, async (signal) => {
      if (manager === undefined) throw new Error("活動管理沒有啟用,確認不了");
      const answer = await manager.request(
        { request: plan.request, principal, turn: null, context: null, why: WHY },
        signal,
      );
      if (answer.status === "refused") throw new Error(answer.detail);
      task = answer.task;
      if (task === null && plan.over(manager.snapshot())) return plan.idle;
      if (task !== null) await settled(manager, task, signal);
      while (!plan.over(manager.snapshot())) await sleep(POLL_MS, signal);
      return plan.done;
    });
    // What hangs must not hold the resource against the steps after it.
    if (!result.ok && task !== null) manager?.cancel(task, WHY);
    return result;
  }
}

/** Waits for `task` to end; a task that failed throws why. Forgotten counts as ended. */
async function settled(manager: ActivityManager, task: TaskId, signal: AbortSignal): Promise<void> {
  for (;;) {
    const record = manager.task(task);
    if (record === null || record.status === "done") return;
    if (record.status === "failed") throw new Error(record.failure?.detail ?? "沒有成功");
    await sleep(POLL_MS, signal);
  }
}
