// The actuator registry and its gate. Capabilities are registered once (by the module that owns
// the service they wrap); every call goes through `invoke`, which runs the gate, records the
// decision (audit log + `gate.decision`) and then executes, directly or as an `actuate` action
// in the scheduler when it comes from a turn.
//
// Before the gate, the rules (`DirectivesKey`, docs/design/v3-architecture.md §9): a `deny` stops
// the request whoever asks, a `require_approval` sends what the gate allowed to the owners, and
// rules that cannot be read deny. A rule added while a run waits in a lane or in the
// ActivityManager still stops it: the check runs again right before it starts.
//
// Gate order:
//
// 1. pause: while paused only `command` and `panel` pass;
// 2. hard prohibitions (config): forbidden capabilities, other guilds, DMs to strangers;
// 3. consent: the target opted out (`/me privacy`);
// 4. permission: a `user` principal's requester needs the capability's node; a `command` with
//    `override` and the `panel` are allowed from here on;
// 5. budget: no autonomous (`self` / `director`) actions while the LLM budget is exhausted;
// 6. risk: `low` is allowed; `medium` and `high` must be within the rate limits (tightened
//    while the budget is degraded); `high` then goes to the self-review, whose `uncertain` asks
//    the owners.

import { CommandRegistryKey, ReplySinkKey } from "@miyoria/commands";
import { LlmRouterKey, withLlmTag } from "@miyoria/llm/llm";
import type { ToolRegistry } from "@miyoria/llm/tools";
import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/runtime/kernel";
import { AuditLogKey, SettingsStoreKey } from "@miyoria/store";
import {
  ActionSinkKey,
  type ActivityRequest,
  type ActuatorExecutor,
  AuthorizerKey,
  accountRefString,
  type Clock,
  DirectivesKey,
  type DirectiveVerdict,
  Events,
  type GateDecisionPayload,
  isAutonomous,
  type JsonValue,
  type LaneKey,
  newAction,
  newId,
  type Priority,
  type Publish,
  principalActor,
  SocialSignalsKey,
  sameAccount,
  serviceKey,
  systemClock,
  type TaskId,
  toTimestamp,
} from "@miyoria/types";
import { builtinCapabilities } from "./builtin.js";
import {
  ActionDroppedError,
  type ActionOutcome,
  type ActionRequest,
  type ActionResult,
  type ApprovalDetail,
  type Capability,
  type ExecContext,
  type GateDecision,
  type GateStage,
} from "./capability.js";
import { type ActionsConfig, capabilityMatches, defaultActionsConfig } from "./config.js";
import { EmergencyStop } from "./emergency.js";
import { publishNotice, recordOutcome } from "./outcome.js";
import { PRIVACY_PROFILE, Privacy } from "./privacy.js";
import { effectiveLimits, RateLimiter, type RateRun, tightened } from "./rate.js";
import { approvalCard, Escalations, parseReview, reviewMessages } from "./review.js";
import { shareCapability } from "./share.js";
import { CapabilityTool } from "./tools.js";

const log = getLogger("actions");

/** Topic of the event published for every gate decision. */
export const GATE_DECISION_TOPIC = Events.GateDecision.type;
/** Settings key (profile `_global`) of the runtime pause switch. */
export const PAUSED_KEY = "autonomy:paused";

const DEFAULT_TTL_MS = 60_000;

export interface ActuatorRegistryOptions {
  services: ServiceLookup;
  /** Where capability tools are registered (none: no tools). */
  tools?: ToolRegistry | null;
  /** Publishes `gate.decision` events. */
  publish?: Publish;
  clock?: Clock;
  /** Register the built-in `message.dm` and `speak` (the app's registry does). Default `true`. */
  builtins?: boolean;
}

/**
 * How `invoke` treats a capability with an `activity` mapping while an `ActivityRouter` is
 * installed: `wait` (default: commands, the panel, the mind) hands it to the ActivityManager
 * and waits for the task to end; `detach` (her tools) answers as soon as the manager accepted
 * it ("開始了,task 7"; the outcome reaches her later as a notice); `direct` executes the
 * capability here without the manager (the manager's own steps).
 */
export type ActivityMode = "wait" | "detach" | "direct";

export interface InvokeOptions {
  /** Aborts waiting (and a direct run). A queued run is cancelled with it. */
  signal?: AbortSignal;
  /**
   * From a turn: queue the run in the capability's lane with this priority (TTL, `cancelTurn`)
   * when it has one and a scheduler is running.
   */
  priority?: Priority;
  /** See `ActivityMode`. Default `wait`. */
  activity?: ActivityMode;
  /** Queue in this lane instead of the capability's own (needs `priority`). */
  lane?: LaneKey;
  /** `direct` runs for an ActivityManager task: its id (`ExecContext.task`). */
  task?: TaskId | null;
  /**
   * A step implied by a task the gate already allowed (OBS following Go Live, ending the
   * broadcast before leaving voice): the gate runs (pause, prohibitions, consent, permission,
   * budget), but a medium-risk step is not rate limited or counted a second time.
   */
  implied?: boolean;
}

/** How a routed call runs the capability itself (the gate already allowed it). */
export interface DirectRun {
  signal: AbortSignal;
  /** Replaces the parsed arguments (e.g. `game.start` without `stream`). */
  args?: unknown;
  /** Queue the run in `lane` with this priority first (e.g. behind her speech). */
  priority?: Priority;
  lane?: LaneKey | null;
  /** The ActivityManager task the run belongs to. */
  task?: TaskId | null;
}

/** A gate-approved call handed to the ActivityManager. */
export interface RoutedCall {
  capability: Capability;
  /** The parsed arguments. */
  args: unknown;
  /** What the capability's `activity` hook mapped them to. */
  requests: ActivityRequest[];
  request: ActionRequest;
  decision: GateDecision;
  /** Wait for the tasks to end (`wait`) or answer once accepted (`detach`). */
  wait: boolean;
  signal: AbortSignal | undefined;
  /** Runs the capability itself, bypassing the gate (it passed) and the router. */
  execute(run: DirectRun): Promise<ActionResult>;
}

/**
 * Installed by the `activity` module: takes the calls of capabilities with an `activity`
 * mapping. Resolves with the tool / command text; rejects (with the underlying error when there
 * is one) when the transition is refused or, in `wait` mode, fails.
 */
export interface ActivityRouter {
  route(call: RoutedCall): Promise<ActionResult>;
}

interface Verdict {
  allowed: boolean;
  stage: GateStage;
  reason: string;
  reviewer: string | null;
}

const allow = (stage: GateStage, reason: string, reviewer: string | null = null): Verdict => ({
  allowed: true,
  stage,
  reason,
  reviewer,
});
const deny = (stage: GateStage, reason: string, reviewer: string | null = null): Verdict => ({
  allowed: false,
  stage,
  reason,
  reviewer,
});

/** `GateDecision.reviewer` of her own review. */
export const SELF_REVIEWER = "self";

/** Extra lines for `/admin autonomy status` (e.g. the sandbox's state). */
export type StatusProvider = () => string[] | Promise<string[]>;

interface Ticket {
  capability: Capability;
  args: unknown;
  request: ActionRequest;
  decision: GateDecision;
  /** Hand the run to the ActivityManager. */
  route: Route | null;
  task: TaskId | null;
  /** Aborted when the waiting caller gives up (tool timeout, cancelled turn). */
  cancel: AbortController;
  resolve: (result: ActionResult) => void;
  reject: (error: unknown) => void;
}

interface Route {
  requests: ActivityRequest[];
  wait: boolean;
  /** The caller's signal (`wait`): aborts the manager's task while it is queued or running. */
  signal: AbortSignal | undefined;
}

interface Run {
  signal: AbortSignal;
  route: Route | null;
  task: TaskId | null;
}

function normalize(result: ActionResult | string): ActionResult {
  return typeof result === "string" ? { text: result, data: null } : result;
}

function toJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/** Rejects with `signal`'s reason once it aborts. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Every capability she has, and the gate in front of them. The app creates one at boot and
 * provides it as `ActuatorRegistryKey` (and as the scheduler's `ActuatorExecutorKey`); the
 * `actions` module configures it.
 */
export class ActuatorRegistry implements ActuatorExecutor {
  readonly #services: ServiceLookup;
  readonly #tools: ToolRegistry | null;
  readonly #publish: Publish;
  readonly #clock: Clock;
  readonly #capabilities = new Map<string, Capability>();
  readonly #tickets = new Map<string, Ticket>();
  readonly #status = new Map<string, StatusProvider>();
  #config: ActionsConfig = defaultActionsConfig();
  #router: ActivityRouter | null = null;
  #paused = false;
  #name = "她";
  #reviewFallbackLogged = false;
  readonly rate = new RateLimiter();
  /** The counted run of each allowed decision, to mark it when its executor fails. */
  readonly #counted = new WeakMap<GateDecision, RateRun>();
  readonly privacy: Privacy;
  readonly escalations: Escalations;
  /** The one button of §16: what `/admin autonomy pause` and `/api/mind/pause` run. */
  readonly emergency: EmergencyStop;

  constructor(options: ActuatorRegistryOptions) {
    this.#services = options.services;
    this.#tools = options.tools ?? null;
    this.#publish = options.publish ?? (() => {});
    this.#clock = options.clock ?? systemClock;
    this.privacy = new Privacy(options.services);
    this.escalations = new Escalations(this.#clock);
    this.emergency = new EmergencyStop({
      services: options.services,
      clock: this.#clock,
      publish: (definition, data, ...meta) => this.#publish(definition, data, ...meta),
      setPaused: (paused) => this.setPaused(paused),
      invoke: (request, signal) => this.invoke(request, { signal }),
      stepMs: () => this.#config.emergency_step_ms,
    });
    if (options.builtins ?? true) {
      for (const capability of builtinCapabilities(options.services)) this.register(capability);
      this.register(
        shareCapability({
          services: options.services,
          config: () => this.#config.share,
          publish: (definition, data, ...meta) => this.#publish(definition, data, ...meta),
          clock: this.#clock,
        }) as Capability,
      );
    }
  }

  get config(): ActionsConfig {
    return this.#config;
  }

  /** Applies `[modules.actions]` (and her name for the review prompt). */
  configure(config: ActionsConfig, name: string | null = null): void {
    this.#config = config;
    if (name !== null && name.trim() !== "") this.#name = name.trim();
  }

  get paused(): boolean {
    return this.#paused;
  }

  /** Pauses or resumes her autonomy; persisted when a `SettingsStore` is available. */
  async setPaused(paused: boolean): Promise<void> {
    this.#paused = paused;
    log.info({ paused }, paused ? "autonomy paused" : "autonomy resumed");
    await this.#services.get(SettingsStoreKey)?.set(PRIVACY_PROFILE, PAUSED_KEY, paused);
  }

  /** @internal Sets the pause state without persisting it (module start). */
  restorePaused(paused: boolean): void {
    this.#paused = paused;
  }

  /**
   * Installs the ActivityManager's router (see `Capability.activity`); returns the function
   * that removes it again (a no-op once another router replaced it).
   */
  setActivityRouter(router: ActivityRouter): () => void {
    this.#router = router;
    return () => {
      if (this.#router === router) this.#router = null;
    };
  }

  /** Whether an ActivityManager takes the calls of `activity` capabilities. */
  get routesActivity(): boolean {
    return this.#router !== null;
  }

  /** Registers (or replaces) a capability and its tool; returns the unregister function. */
  register<A>(capability: Capability<A>): () => void {
    const erased = capability as Capability;
    const previous = this.#capabilities.get(capability.name);
    if (previous) this.#removeTool(previous);
    this.#capabilities.set(capability.name, erased);
    if (erased.tool && this.#tools) this.#tools.register(new CapabilityTool(this, erased));
    return () => {
      if (this.#capabilities.get(capability.name) === erased) this.unregister(capability.name);
    };
  }

  unregister(name: string): boolean {
    const capability = this.#capabilities.get(name);
    if (!capability) return false;
    this.#capabilities.delete(name);
    this.#removeTool(capability);
    return true;
  }

  #removeTool(capability: Capability): void {
    const name = capability.tool?.name;
    if (!name || !this.#tools) return;
    const tool = this.#tools.get(name);
    if (tool instanceof CapabilityTool && tool.capability === capability)
      this.#tools.unregister(name);
  }

  get(name: string): Capability | undefined {
    return this.#capabilities.get(name);
  }

  /** Registered capability names, sorted. */
  names(): string[] {
    return [...this.#capabilities.keys()].sort();
  }

  /**
   * Adds lines to `/admin autonomy status` under `name` (replacing an earlier provider of that
   * name); returns the remove function.
   */
  addStatus(name: string, provider: StatusProvider): () => void {
    this.#status.set(name, provider);
    return () => {
      if (this.#status.get(name) === provider) this.#status.delete(name);
    };
  }

  /** Every status provider's lines, by provider name; a failing provider shows its error. */
  async statusLines(): Promise<string[]> {
    const out: string[] = [];
    for (const [name, provider] of [...this.#status].sort(([a], [b]) => a.localeCompare(b))) {
      try {
        out.push(...(await provider()));
      } catch (error) {
        out.push(`${name}:無法取得狀態(${errorMessage(error)})`);
      }
    }
    return out;
  }

  /**
   * Runs the gate, records its decision and executes the request when allowed. Never throws for
   * a refusal or a failing executor (see the outcome's `status`); rethrows only an abort.
   */
  async invoke(request: ActionRequest, options: InvokeOptions = {}): Promise<ActionOutcome> {
    const capability = this.#capabilities.get(request.capability);
    if (!capability) {
      const decision = this.#decision(request, null, deny("unknown", "unknown capability"));
      await this.#record(decision);
      return { status: "denied", decision };
    }
    const parsed = capability.args.safeParse(request.args);
    let verdict: Verdict;
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue && issue.path.length > 0 ? `\`${issue.path.join(".")}\`: ` : "";
      verdict = deny("args", `invalid arguments: ${where}${issue?.message ?? "invalid"}`);
    } else {
      const invalid = capability.check?.(parsed.data, request.principal) ?? null;
      const rule = invalid === null ? await this.#rule(capability, parsed.data, request) : null;
      verdict =
        invalid !== null
          ? deny("args", invalid)
          : rule?.outcome === "deny"
            ? deny("directive", rule.reason)
            : await this.#gate(
                capability,
                parsed.data,
                request,
                options.signal,
                options.implied === true,
              );
      if (rule?.outcome === "approval" && verdict.allowed) {
        verdict = await this.#escalate(capability, request, rule.reason, options.signal);
      }
    }
    const decision = this.#decision(request, capability, verdict);
    await this.#record(decision);
    if (!decision.allowed || !parsed.success) {
      if (parsed.success && (decision.stage === "review" || decision.stage === "escalation")) {
        await this.#denied(capability, parsed.data, request, decision);
      }
      const denied: ActionOutcome = { status: "denied", decision };
      // She should see what was refused and why (the Ledger), not only the audit log.
      if ((options.activity ?? "wait") !== "direct" && capability.risk !== "low") {
        this.#safely(() => recordOutcome(this.#sink(), capability, request, denied));
      }
      return denied;
    }
    if (options.implied !== true) {
      const counted = this.#count(capability, parsed.data, request);
      if (counted !== null) this.#counted.set(decision, counted);
    }
    const args = parsed.data;
    const route = this.#routeFor(capability, args, request, options);
    const task = options.task ?? null;
    let outcome: ActionOutcome;
    try {
      const lane =
        options.priority !== undefined
          ? options.lane !== undefined
            ? options.lane
            : (capability.lane?.(args, request.principal) ?? null)
          : null;
      const result =
        lane !== null && options.priority !== undefined
          ? await this.#queue(capability, args, request, decision, lane, options.priority, {
              signal: options.signal,
              route,
              task,
            })
          : await this.#execute(capability, args, request, decision, {
              signal: options.signal ?? new AbortController().signal,
              route,
              task,
            });
      outcome = { status: "done", decision, result: this.#postReceipt(request, result) };
    } catch (error) {
      if (options.signal?.aborted) throw error;
      this.#failed(decision);
      log.warn(
        { capability: capability.name, err: errorMessage(error) },
        "capability failed after the gate allowed it",
      );
      outcome = { status: "failed", decision, error: errorMessage(error), cause: error };
    }
    // Routed calls are recorded by the ActivityManager (its tasks), steps of its tasks too.
    if (route === null && (options.activity ?? "wait") !== "direct" && capability.risk !== "low") {
      this.#safely(() => recordOutcome(this.#sink(), capability, request, outcome));
    }
    return outcome;
  }

  /** What the rules say of a request. The app always provides them; a test may not. */
  async #rule(
    capability: Capability,
    args: unknown,
    request: ActionRequest,
  ): Promise<DirectiveVerdict | null> {
    const directives = this.#services.get(DirectivesKey);
    if (!directives) return null;
    try {
      return await directives.check({
        capability: capability.name,
        args,
        principal: request.principal,
        about: request.about ?? null,
      });
    } catch (error) {
      return { outcome: "deny", directive: null, reason: `讀不到規則(${errorMessage(error)})` };
    }
  }

  /** A run that waited: a rule made since then stops it (the request itself passed the gate). */
  async #stillAllowed(
    capability: Capability,
    args: unknown,
    request: ActionRequest,
  ): Promise<void> {
    const rule = await this.#rule(capability, args, request);
    if (rule?.outcome === "deny") throw new ActionDroppedError(rule.reason);
  }

  /** The ActivityManager route of a call, or `null` to execute it here. */
  #routeFor(
    capability: Capability,
    args: unknown,
    request: ActionRequest,
    options: InvokeOptions,
  ): Route | null {
    const mode = options.activity ?? "wait";
    if (mode === "direct" || this.#router === null || !capability.activity) return null;
    const requests = capability.activity(args, request.principal);
    if (requests === null || requests.length === 0) return null;
    return {
      requests,
      wait: mode === "wait",
      signal: mode === "wait" ? options.signal : undefined,
    };
  }

  /**
   * Tells her the outcome of a request nobody waits for any more (a high-risk tool answered
   * `REVIEW_PENDING`) as a `Notice` in the context she asked from. Never throws. (Every medium
   * and high-risk outcome is also recorded in the Ledger-ready form by `invoke`.)
   */
  notifyLate(capability: Capability, request: ActionRequest, outcome: ActionOutcome): void {
    this.#safely(() => publishNotice(this.#sink(), capability, request, outcome));
  }

  #sink() {
    return { services: this.#services, publish: this.#publish, now: this.#clock.now() };
  }

  #safely(fn: () => void): void {
    try {
      fn();
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot report an action outcome");
    }
  }

  async #execute(
    capability: Capability,
    args: unknown,
    request: ActionRequest,
    decision: GateDecision,
    run: Run,
  ): Promise<ActionResult> {
    const router = this.#router;
    if (run.route !== null && router !== null) {
      return router.route({
        capability,
        args,
        requests: run.route.requests,
        request,
        decision,
        wait: run.route.wait,
        signal: run.route.signal,
        // A task nobody waits for fails after `invoke` returned: its failure is seen here.
        execute: async (direct) => {
          try {
            return await this.#direct(capability, args, request, decision, direct);
          } catch (error) {
            if (!direct.signal.aborted) this.#failed(decision);
            throw error;
          }
        },
      });
    }
    const ctx: ExecContext = {
      principal: request.principal,
      request,
      decision,
      services: this.#services,
      signal: run.signal,
      task: run.task,
    };
    return normalize(await capability.execute(args, ctx));
  }

  /** `RoutedCall.execute`: the capability itself, for the ActivityManager's task. */
  async #direct(
    capability: Capability,
    args: unknown,
    request: ActionRequest,
    decision: GateDecision,
    direct: DirectRun,
  ): Promise<ActionResult> {
    const actual = direct.args === undefined ? args : direct.args;
    await this.#stillAllowed(capability, actual, request);
    const run = { signal: direct.signal, route: null, task: direct.task ?? null };
    if (direct.priority !== undefined && direct.lane) {
      return this.#queue(capability, actual, request, decision, direct.lane, direct.priority, run);
    }
    return this.#execute(capability, actual, request, decision, run);
  }

  /** The capability's `denied` hook (errors are logged). */
  async #denied(
    capability: Capability,
    args: unknown,
    request: ActionRequest,
    decision: GateDecision,
  ): Promise<void> {
    if (!capability.denied) return;
    try {
      await capability.denied(args, {
        principal: request.principal,
        request,
        decision,
        services: this.#services,
      });
    } catch (error) {
      log.warn(
        { capability: capability.name, err: errorMessage(error) },
        "the capability's denied hook failed",
      );
    }
  }

  /**
   * Submits an `actuate` action and waits for the scheduler to run (or drop) it. When the
   * caller's `signal` aborts first (the tool timed out, the turn was cancelled) the ticket is
   * cancelled with it: a queued run never starts and a running one sees its signal abort, so
   * stale work is harmless.
   */
  async #queue(
    capability: Capability,
    args: unknown,
    request: ActionRequest,
    decision: GateDecision,
    lane: LaneKey,
    priority: Priority,
    run: { signal: AbortSignal | undefined; route: Route | null; task: TaskId | null },
  ): Promise<ActionResult> {
    const signal = run.signal;
    const sink = this.#services.get(ActionSinkKey);
    if (!sink) {
      return this.#execute(capability, args, request, decision, {
        signal: signal ?? new AbortController().signal,
        route: run.route,
        task: run.task,
      });
    }
    if (signal?.aborted) throw signal.reason ?? new ActionDroppedError("cancelled");
    const ticket = newId();
    const cancel = new AbortController();
    const done = new Promise<ActionResult>((resolve, reject) => {
      this.#tickets.set(ticket, {
        capability,
        args,
        request,
        decision,
        route: run.route,
        task: run.task,
        cancel,
        resolve,
        reject,
      });
    });
    // Nobody may be waiting any more when it settles (the turn was aborted).
    done.catch(() => undefined);
    const onAbort = () => {
      const queued = this.#tickets.get(ticket);
      this.#tickets.delete(ticket);
      cancel.abort(signal?.reason ?? new ActionDroppedError("cancelled"));
      if (queued) {
        log.debug({ capability: capability.name, ticket }, "queued run cancelled by its caller");
        queued.reject(new ActionDroppedError("cancelled by the caller"));
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    const forget = () => signal?.removeEventListener("abort", onAbort);
    done.then(forget, forget);
    const action = newAction(
      lane,
      priority,
      {
        type: "actuate",
        capability: capability.name,
        ticket,
        context: request.principal.context,
      },
      { turn: request.turn, ttl: capability.ttlMs ?? DEFAULT_TTL_MS, now: this.#clock.now() },
    );
    try {
      await sink.submit(action);
    } catch (error) {
      this.#tickets.delete(ticket);
      throw error;
    }
    return abortable(done, signal);
  }

  /** `ActuatorExecutor`: the scheduler runs a queued request. */
  async run(ticket: string, signal: AbortSignal): Promise<string> {
    const t = this.#tickets.get(ticket);
    // Cancelled by its caller (or settled): the scheduler drops it quietly.
    if (!t) throw new ActionDroppedError("cancelled");
    this.#tickets.delete(ticket);
    try {
      await this.#stillAllowed(t.capability, t.args, t.request);
      const result = await this.#execute(t.capability, t.args, t.request, t.decision, {
        signal: AbortSignal.any([signal, t.cancel.signal]),
        route: t.route,
        task: t.task,
      });
      t.resolve(result);
      return result.text;
    } catch (error) {
      t.reject(error);
      throw error;
    }
  }

  /** `ActuatorExecutor`: the scheduler dropped a queued request. */
  dropped(ticket: string, reason: string): void {
    const t = this.#tickets.get(ticket);
    if (!t) return;
    this.#tickets.delete(ticket);
    t.reject(new ActionDroppedError(`dropped by the scheduler: ${reason}`));
  }

  #decision(request: ActionRequest, capability: Capability | null, verdict: Verdict): GateDecision {
    return {
      id: newId(),
      at: toTimestamp(this.#clock.now()),
      capability: request.capability,
      risk: capability?.risk ?? null,
      principal: request.principal,
      args: request.args,
      why: request.why,
      turn: request.turn,
      allowed: verdict.allowed,
      stage: verdict.stage,
      reason: verdict.reason,
      reviewer: verdict.reviewer,
    };
  }

  /** Audit entry (when there is an audit log) and `gate.decision` event. */
  async #record(decision: GateDecision): Promise<void> {
    const fields = {
      capability: decision.capability,
      principal: principalActor(decision.principal),
      allowed: decision.allowed,
      stage: decision.stage,
      reason: decision.reason,
    };
    if (decision.allowed) log.debug(fields, "gate allowed an action");
    else log.info(fields, "gate denied an action");
    const payload = toJson(decision);
    try {
      // A JSON round trip of the decision, as published before.
      this.#publish(Events.GateDecision, payload as GateDecisionPayload);
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot publish gate decision");
    }
    const audit = this.#services.get(AuditLogKey);
    if (!audit) return;
    try {
      await audit.append({
        id: decision.id,
        at: decision.at,
        actor: principalActor(decision.principal),
        action: `gate.${decision.capability}`,
        target: decision.capability,
        detail: payload,
        ok: decision.allowed,
      });
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot write gate audit entry");
    }
  }

  /** The person a medium / high action involves, for per-person limits. */
  #person(capability: Capability, args: unknown, request: ActionRequest): string | null {
    const who =
      capability.target?.(args, request.principal) ?? request.about ?? request.principal.requester;
    return who === null ? null : `${who.platform}:${who.id}`;
  }

  /** Rate limits count every medium / high run except overriding commands and the panel. */
  #count(capability: Capability, args: unknown, request: ActionRequest): RateRun | null {
    if (capability.risk === "low" || request.principal.kind === "panel") return null;
    if (request.principal.kind === "command" && request.principal.override) return null;
    return this.rate.record(
      capability.name,
      this.#person(capability, args, request),
      this.#clock.now(),
    );
  }

  /** The executor of an allowed request failed: no cooldown follows that run. */
  #failed(decision: GateDecision): void {
    const run = this.#counted.get(decision);
    if (run) this.rate.failed(run);
  }

  async #gate(
    capability: Capability,
    args: unknown,
    request: ActionRequest,
    signal: AbortSignal | undefined,
    implied = false,
  ): Promise<Verdict> {
    const p = request.principal;
    const cfg = this.#config;

    // 1. Emergency pause.
    if (this.#paused && p.kind !== "command" && p.kind !== "panel") {
      return deny("pause", "autonomy is paused (only commands and the panel may act)");
    }

    // 2. Hard prohibitions.
    if (cfg.forbidden.some((pattern) => capabilityMatches(pattern, capability.name))) {
      return deny("prohibition", "this capability is forbidden by configuration");
    }
    if (!cfg.cross_guild && (p.kind === "user" || p.kind === "self" || p.kind === "director")) {
      const where = capability.scope?.(args, p) ?? null;
      const from = p.context?.scope ?? null;
      if (where !== null && from !== null && where !== from) {
        return deny("prohibition", "not across servers");
      }
    }
    // An autonomous request may name who it is about when the capability names nobody.
    const target =
      capability.target?.(args, p) ?? (isAutonomous(p) ? (request.about ?? null) : null);
    const askedForThemselves =
      target !== null && p.requester !== null && sameAccount(target, p.requester);
    const social = this.#services.get(SocialSignalsKey);
    if (target !== null && social?.attitude(target)?.blocked) {
      return deny("prohibition", "the target is blocked");
    }
    if (
      capability.consent === "dm" &&
      target !== null &&
      !askedForThemselves &&
      !cfg.dm_strangers
    ) {
      const familiarity = social?.attitude(target)?.familiarity ?? 0;
      if (familiarity < cfg.stranger_familiarity) {
        return deny("prohibition", "she does not DM strangers");
      }
    }

    // 3. Consent.
    if (target !== null && !askedForThemselves) {
      const choices = await this.privacy.get(target);
      if (capability.consent === "dm" && !choices.dm) {
        return deny("consent", "the person opted out of DMs from her");
      }
      if (isAutonomous(p) && !choices.approach) {
        return deny("consent", "the person does not want to be approached");
      }
    }

    // 4. Permission (and the principals that need nothing more). Someone asking her to DM them is
    // asking about themselves: the permission guards against sending her at someone else, so it is
    // not needed then (consent above already lets a person reach themselves).
    const dmToAsker = capability.consent === "dm" && askedForThemselves;
    if (p.kind === "user" && capability.permission !== null && !dmToAsker) {
      const authorizer = this.#services.get(AuthorizerKey);
      const requester = p.requester;
      if (
        !authorizer ||
        requester === null ||
        !authorizer.allows(requester, capability.permission)
      ) {
        return deny(
          "permission",
          "the person asking may not request this (if you want to do it yourself, set on_own)",
        );
      }
    }
    if (p.kind === "command" && p.override) return allow("permission", "command override");
    if (p.kind === "panel") return allow("permission", "admin panel");

    // 5. Budget.
    const budget = this.#services.get(LlmRouterKey)?.budgetState() ?? "ok";
    if (budget === "exhausted" && isAutonomous(p)) {
      return deny("budget", "the LLM budget is exhausted: no autonomous actions");
    }

    // 6. Risk tier.
    if (capability.risk === "low") return allow("risk", "low risk");
    if (implied && capability.risk === "medium") {
      return allow("rate", "a step of an activity task the gate allowed");
    }
    let limits = effectiveLimits(
      cfg.limits[capability.name],
      cfg.medium,
      capability.limits ?? null,
    );
    if (budget === "degraded") limits = tightened(limits);
    const person = this.#person(capability, args, request);
    const exceeded = this.rate.check(capability.name, person, limits, this.#clock.now());
    if (exceeded !== null) {
      return deny("rate", budget === "degraded" ? `${exceeded}, budget degraded` : exceeded);
    }
    if (capability.risk === "medium") return allow("rate", "within limits");
    return this.#review(capability, request, signal);
  }

  /** The guardrails the review is told about. */
  #guardrails(): string[] {
    const cfg = this.#config;
    const out = [
      "never mention roles, @everyone or @here",
      "respect people's privacy choices and consent",
    ];
    if (!cfg.cross_guild) out.push("never act across servers");
    if (!cfg.dm_strangers) out.push("never DM strangers");
    if (cfg.forbidden.length > 0) out.push(`forbidden capabilities: ${cfg.forbidden.join(", ")}`);
    return out;
  }

  async #review(
    capability: Capability,
    request: ActionRequest,
    signal: AbortSignal | undefined,
  ): Promise<Verdict> {
    const router = this.#services.get(LlmRouterKey);
    if (!router) return deny("review", "no LLM router for the self-review");
    const purpose = this.#config.review_purpose;
    if (!router.configures(purpose) && !this.#reviewFallbackLogged) {
      this.#reviewFallbackLogged = true;
      log.warn({ purpose }, "no model chain for the review purpose; using the chat chain");
    }
    const requester = request.principal.requester;
    const attitude =
      requester === null
        ? null
        : (this.#services.get(SocialSignalsKey)?.attitude(requester) ?? null);
    const messages = reviewMessages({
      name: this.#name,
      principal: request.principal,
      requester: attitude,
      capability: capability.name,
      summary: capability.summary,
      guidance: capability.guidance ?? null,
      risk: capability.risk,
      args: request.args,
      why: request.why,
      guardrails: this.#guardrails(),
    });
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#config.review_timeout_ms);
    let reply: ReturnType<typeof parseReview>;
    try {
      const response = await withLlmTag({ module: "actions", label: "review" }, () =>
        router.complete(
          purpose,
          {
            messages,
            temperature: 0,
            max_tokens: 2000,
            json_mode: true,
            thinking: true,
            session: "actions-review",
          },
          controller.signal,
        ),
      );
      reply = parseReview(response.text);
    } catch (error) {
      if (signal?.aborted) throw error;
      const why = controller.signal.aborted ? "timed out" : errorMessage(error);
      return deny("review", `self-review failed (${why})`);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
    const reason = reply.reason === "" ? reply.verdict : reply.reason;
    if (reply.verdict === "allow") return allow("review", reason, SELF_REVIEWER);
    if (reply.verdict === "deny") return deny("review", reason, SELF_REVIEWER);
    return this.#escalate(capability, request, reason, signal);
  }

  /** The capability's card view of `args` (already accepted by its schema), if it has one. */
  #describe(capability: Capability, args: JsonValue): ApprovalDetail | null {
    if (!capability.describe) return null;
    const parsed = capability.args.safeParse(args);
    if (!parsed.success) return null;
    try {
      return capability.describe(parsed.data);
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot describe the request for the card");
      return null;
    }
  }

  /**
   * A result with a receipt, of her turn in a chat or voice context: the card goes up there
   * (not awaited: the tool answer does not wait for Discord) and she is told it did.
   */
  #postReceipt(request: ActionRequest, result: ActionResult): ActionResult {
    const card = result.receipt;
    const context = request.principal.context;
    if (!card || context === null || request.principal.kind === "command") return result;
    const sink = this.#services.get(ReplySinkKey);
    if (!sink?.sendCard || sink.platform !== context.platform) return result;
    sink.sendCard(context, { ...card, ephemeral: false }).catch((error: unknown) => {
      log.warn({ err: errorMessage(error) }, "could not post a receipt card");
    });
    return {
      ...result,
      text: `${result.text}(頻道上已經貼出一張收據卡片寫了金額和餘額,大家看得到,你不用再唸數字,照你的個性反應就好)`,
    };
  }

  /** Sends the approval card to every reachable owner and waits for the first answer. */
  async #escalate(
    capability: Capability,
    request: ActionRequest,
    review: string,
    signal: AbortSignal | undefined,
  ): Promise<Verdict> {
    const sink = this.#services.get(ReplySinkKey);
    const owners = (this.#services.get(CommandRegistryKey)?.permissions().owners() ?? []).filter(
      (o) => sink !== undefined && o.platform === sink.platform && /^[1-9]\d*$/.test(o.id),
    );
    if (!sink || owners.length === 0) {
      return deny("escalation", `uncertain (${review}) and no owner can be asked`);
    }
    const id = newId();
    const answer = this.escalations.wait(
      id,
      `${capability.name} (${principalActor(request.principal)})`,
      this.#config.escalation_timeout_ms,
      signal,
      {
        capability: capability.name,
        summary: capability.summary,
        principal: principalActor(request.principal),
        args: request.args,
        why: request.why,
        review,
      },
    );
    const card = approvalCard(
      id,
      capability,
      request.principal,
      request.args,
      request.why,
      review,
      this.#describe(capability, request.args),
    );
    let sent = 0;
    for (const owner of owners) {
      try {
        await sink.sendDirect(owner, card, signal);
        sent++;
      } catch (error) {
        log.warn({ owner: owner.id, err: errorMessage(error) }, "cannot send the approval card");
      }
    }
    if (sent === 0) this.escalations.cancel(id, "the approval card could not be sent");
    const result = await answer;
    const by =
      result.by === null
        ? null
        : typeof result.by === "string"
          ? result.by
          : accountRefString(result.by);
    return result.approved
      ? allow("escalation", result.reason, by)
      : deny("escalation", `uncertain (${review}); ${result.reason}`, by);
  }
}

/** The app's registry (also provided as `ActuatorExecutorKey`). */
export const ActuatorRegistryKey = serviceKey<ActuatorRegistry>("ActuatorRegistry");
