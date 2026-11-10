// How the manager's steps touch the outside world: by running capabilities. The real port runs
// them through the actuator registry (`GatePort`); tests use a fake.
//
// A step is either the request's *primary* step (the capability she / the command / the panel
// called, already allowed by the gate: it runs as is) or an *implied* one (OBS following Go Live,
// stopping the broadcast before leaving voice, leaving one server's voice to join another): those
// go through the gate on their own.

import {
  type ActionResult,
  ActuatorRegistryKey,
  type DirectRun,
  deniedText,
} from "@miyoria/actions";
import { errorMessage, isAbortError, type ServiceLookup } from "@miyoria/kernel";
import {
  isTaskFailureCode,
  type JsonObject,
  type LaneKey,
  type Principal,
  type Priority,
  type TaskFailureCode,
  type TaskId,
  type TurnId,
} from "@miyoria/types";

/** The capability a routed request came with; runs it bypassing the gate. */
export type PrimaryStep = (run: DirectRun) => Promise<ActionResult>;

export interface StepCall {
  capability: string;
  args: JsonObject;
  principal: Principal;
  why: string;
  turn: TurnId | null;
  task: TaskId;
  signal: AbortSignal;
  /** Set for the primary step: the gate already allowed it. */
  primary: PrimaryStep | null;
  /** Queue the run in `lane` with `priority` (e.g. leaving behind her speech). */
  priority?: Priority;
  lane?: LaneKey;
}

export interface ActivityPort {
  /** Whether `capability` is registered (e.g. `stage.stream` without a stage link: no OBS step). */
  has(capability: string): boolean;
  /** Runs one step; throws `StepError` (or the executor's own error, kept as `cause`). */
  run(call: StepCall): Promise<ActionResult>;
}

/** A step that failed, with the code the task fails with. */
export class StepError extends Error {
  override readonly name = "StepError";

  constructor(
    readonly code: TaskFailureCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** Failure code of an executor's error. */
export function failureCode(error: unknown): TaskFailureCode {
  if (error instanceof StepError) return error.code;
  if (isAbortError(error)) return "cancelled";
  // An executor's own code (the game's `GameError` / `GameTaskError` from its task events).
  const code = (error as { code?: unknown } | null)?.code;
  if (error instanceof Error && isTaskFailureCode(code)) return code;
  const name = error instanceof Error ? error.name : "";
  if (name === "ActionDroppedError") return "cancelled";
  if (name === "ActionDeniedError") return "denied";
  // `CapabilityError` and its kin (`GameError`, `GoLiveJoinError`): a precondition is missing.
  if (/Capability|Game|Join/.test(name)) return "precondition";
  return "internal";
}

/** The real port: capabilities of the app's actuator registry. */
export class GatePort implements ActivityPort {
  constructor(readonly services: ServiceLookup) {}

  has(capability: string): boolean {
    return this.services.get(ActuatorRegistryKey)?.get(capability) !== undefined;
  }

  async run(call: StepCall): Promise<ActionResult> {
    const queue =
      call.priority !== undefined && call.lane !== undefined
        ? { priority: call.priority, lane: call.lane }
        : {};
    if (call.primary !== null) {
      // The capability's own arguments, as the gate allowed them (`call.args` is only what the
      // manager would ask for on its own, e.g. without her `where` or the scene's name).
      return call.primary({ signal: call.signal, task: call.task, ...queue });
    }
    const registry = this.services.get(ActuatorRegistryKey);
    if (!registry) throw new StepError("precondition", "行動閘門沒有啟用");
    if (!registry.get(call.capability)) {
      throw new StepError("precondition", `\`${call.capability}\` 沒有啟用`);
    }
    const outcome = await registry.invoke(
      {
        principal: call.principal,
        capability: call.capability,
        args: call.args,
        why: call.why,
        turn: call.turn,
      },
      { signal: call.signal, activity: "direct", task: call.task, implied: true, ...queue },
    );
    switch (outcome.status) {
      case "done":
        return outcome.result;
      case "denied":
        throw new StepError(
          "denied",
          `${deniedText(outcome.decision.stage)}(${outcome.decision.reason})`,
        );
      case "failed":
        throw new StepError(
          failureCode(outcome.cause),
          errorMessage(outcome.cause ?? outcome.error),
          {
            cause: outcome.cause,
          },
        );
    }
  }
}
