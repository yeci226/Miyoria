// What is left of her mind loop since phase 4 step 5 (docs/design/v5-heart.md §2.6, §2.10):
//
// * Her thought journal (`MindKey`): her `feel` applications and her reflections, a line each,
//   so the panel's 內心 page still shows what went on inside her. Nothing here calls a model to
//   think: Appraise is her own `feel`, Plan and her own starts are the new runner's.
// * Her goals' triggers (`GoalBook`, `TriggerWatch`): checked by cheap code; one that starts
//   firing becomes an item of her inbox on the new runner (a fired `mind.reminder`, which the
//   initiative turns into a `timer` item that wakes her there), never a Plan call.
//
// The life log and her old timers are the module's (`module.ts`).

import { getLogger, type Logger, type ServiceLookup, sleep } from "@miyoria/runtime/kernel";
import {
  type ActivitySnapshot,
  type Clock,
  DirectivesKey,
  type Envelope,
  Events,
  type Goal,
  HandleDirectoryKey,
  is,
  isJsonObject,
  type JsonValue,
  type Mind,
  type MindNote,
  type MindStats,
  newId,
  type Publish,
  type Reminder,
  runningActivity,
  type Thought,
  type ThoughtDigest,
  type ThoughtIntent,
  type ThoughtTrigger,
  type TriggerProbe,
  toTimestamp,
  WorldStateKey,
} from "@miyoria/types";
import type { MindConfig } from "./config.js";
import { describeTrigger, type GoalBook, goalKey, TriggerWatch } from "./goals.js";
import type { Journal } from "./journal.js";

const log = getLogger("mind");
const MINUTE_MS = 60_000;
/** The longest she naps between two looks at her goals. */
const NAP_MS = 60_000;
/** The longest line of the journal kept from a note. */
const MAX_NOTE = 400;

export interface MindDeps {
  config: MindConfig;
  services: ServiceLookup;
  clock: Clock;
  publish: Publish;
  log?: Logger;
  journal: Journal;
  goals: GoalBook;
}

function short(text: string, max: number): string {
  const c = [...text.replace(/\s+/g, " ").trim()];
  return c.length > max ? `${c.slice(0, max).join("")}…` : c.join("");
}

/** The activity running in a snapshot payload (`game:minecraft`), or `null`. */
function runningOf(payload: JsonValue): { type: string; target: string | null } | null {
  if (!isJsonObject(payload) || !isJsonObject(payload.activity)) return null;
  try {
    return runningActivity(payload as unknown as ActivitySnapshot);
  } catch {
    return null;
  }
}

/** Names an ended activity goes by in `after_activity` triggers. */
function endedNames(a: { type: string; target: string | null }): string[] {
  return a.target === null ? [a.type] : [a.type, `${a.type}:${a.target}`];
}

/** Where someone is, for a `when_online` trigger. */
export type Whereabouts = "voice" | "online" | "offline";

/** A goal whose trigger fired, as an item of her inbox (`mind.reminder`, `fired`). */
export function goalReminder(
  goal: Goal,
  fired: number,
  now: number,
  offsetMinutes: number,
): Reminder {
  return {
    id: `goal:${goal.id}`,
    key: goalKey(goal),
    what: `你的目標「${goal.what}」(${describeTrigger(goal.trigger, offsetMinutes)})`,
    due: toTimestamp(now),
    daily: false,
    context: goal.context,
    person: goal.person,
    for_account: null,
    fired,
    created_at: goal.created_at,
  };
}

/** Her journal and her goals' triggers (`MindKey`). */
export class MindLoop implements Mind {
  readonly #d: MindDeps;
  readonly #watch = new TriggerWatch();
  /** Activities that ended since the goals were last looked at. */
  #ended: string[] = [];
  #activity: { type: string; target: string | null } | null = null;
  /** Times each goal fired (its inbox items' keys). */
  readonly #fired = new Map<string, number>();
  #wake: (() => void) | null = null;
  #running = false;

  constructor(deps: MindDeps) {
    this.#d = deps;
  }

  // ---- Mind ---------------------------------------------------------------------------------

  thoughts(limit = 50): Thought[] {
    return this.#d.journal.list(limit);
  }

  thought(id: string): Thought | null {
    return this.#d.journal.get(id);
  }

  digests(limit = 20): ThoughtDigest[] {
    return this.#d.journal.digests(limit);
  }

  stats(): MindStats {
    const last = this.#d.journal.list(1)[0]?.at ?? null;
    return { last_at: last, idle_reason: this.#running ? null : "not running" };
  }

  /** A line of what went on inside her (a `feel` applied, a reflection), into the journal. */
  note(entry: MindNote): void {
    const text = short(entry.text, MAX_NOTE);
    if (text === "") return;
    const at = toTimestamp(this.#d.clock.now());
    // A feel in a DM is marked (and keeps its DM context): the daily reflection leaves it out of
    // what may reach public writing.
    const dm = entry.context?.kind === "dm";
    const trigger: ThoughtTrigger = {
      kind: entry.kind === "feel" ? "turn" : "heartbeat",
      detail: entry.kind === "feel" ? (dm ? "她在私訊裡的感受" : "她說話時的感受") : "她的反思",
      context: entry.context ?? null,
      at,
    };
    const thought: Thought = {
      id: newId(),
      at,
      triggers: [trigger],
      thought: text,
      changes: (entry.changes ?? []).map((c) => short(c, 200)).slice(0, 12),
      intents: [] as ThoughtIntent[],
      tokens: null,
      error: null,
      ms: 0,
    };
    this.#d.journal.add(thought).catch((error: unknown) => {
      (this.#d.log ?? log).warn({ err: String(error) }, "cannot keep a thought");
    });
  }

  // ---- what happens -------------------------------------------------------------------------

  /** Feeds one bus event: activities ending, people arriving, new rules, her reflections. */
  observe(env: Envelope): void {
    const payload = env.data as JsonValue;
    if (is(Events.WorldSalient, env)) {
      // Someone coming online may fire a `when_online` goal: look right away.
      if (env.data.kind === "came_online" || env.data.kind === "joined_voice") this.#wake?.();
      return;
    }
    if (is(Events.ReflectRun, env)) {
      const run = env.data;
      if (run.error !== null || run.summary.trim() === "") return;
      this.note({
        kind: "reflect",
        text: run.summary,
        changes: [...run.lessons.map((l) => `學到:${l}`), ...run.goals.map((g) => `目標:${g}`)],
        context: run.context,
      });
      return;
    }
    switch (env.type) {
      case Events.DirectiveChanged.type:
        this.#ruleChanged(payload);
        return;
      case Events.ActivityChanged.type: {
        const running = runningOf(payload);
        const prev = this.#activity;
        this.#activity = running;
        if (
          prev !== null &&
          (running === null || running.type !== prev.type || running.target !== prev.target)
        ) {
          this.#activityEnded(prev);
        }
        return;
      }
      case Events.ActivityDone.type:
      case Events.ActivityFailed.type: {
        if (!isJsonObject(payload) || payload.resource !== "activity") return;
        const request = isJsonObject(payload.request) ? payload.request : null;
        const failed = env.type === Events.ActivityFailed.type;
        const prev = this.#activity;
        if (prev !== null && (failed || request?.type === "stop")) {
          this.#activity = null;
          this.#activityEnded(prev);
        }
        return;
      }
      default:
        return;
    }
  }

  #activityEnded(a: { type: string; target: string | null }): void {
    this.#ended.push(...endedNames(a));
    this.#wake?.();
  }

  /** What a new rule forbids is off her goals at once, not when she next looks at them. */
  #ruleChanged(payload: JsonValue): void {
    if (!isJsonObject(payload) || payload.op !== "add") return;
    const directive = isJsonObject(payload.directive) ? payload.directive : null;
    const rules = this.#d.services.get(DirectivesKey);
    if (directive?.effect !== "deny" || !rules) return;
    for (const goal of this.#d.goals.goals()) {
      const rule = rules.forbids(goal);
      if (rule !== null) this.#d.goals.setStatus(goal.id, "dropped", `規則:${rule.text}`);
    }
  }

  // ---- goal triggers ------------------------------------------------------------------------

  /** Where `handle` is: in voice, online or offline (as far as she can see). */
  where(handle: string): Whereabouts {
    const world = this.#d.services.get(WorldStateKey);
    if (!world) return "offline";
    const entry = this.#d.services.get(HandleDirectoryKey)?.resolve(handle) ?? null;
    const snap = world.snapshot();
    const account =
      entry?.account ??
      snap.people.find((p) => p.display_name === handle)?.account ??
      snap.voice_channels.flatMap((v) => v.members).find((m) => m.display_name === handle)
        ?.account ??
      null;
    if (account === null) return "offline";
    const inVoice = snap.voice_channels.some((v) =>
      v.members.some(
        (m) => !m.is_self && m.account.platform === account.platform && m.account.id === account.id,
      ),
    );
    const presence = world.person(account);
    if (inVoice || presence?.voice) return "voice";
    if (presence?.status != null && presence.status !== "offline") return "online";
    return "offline";
  }

  #probe(now: number): TriggerProbe {
    return { now, online: (h) => this.where(h) !== "offline", ended: this.#ended };
  }

  /**
   * Drops expired goals; a goal whose trigger started firing becomes active and an item of her
   * inbox on the new runner (a fired `mind.reminder`): it wakes her there, and she decides.
   */
  checkGoals(now: number): Goal[] {
    const goals = this.#d.goals;
    for (const g of goals.sweep()) log.debug({ goal: g.id }, "goal expired");
    const fired = this.#watch.check(
      goals.goals(),
      this.#probe(now),
      this.#d.config.goal_refire_mins * MINUTE_MS,
    );
    this.#ended = [];
    for (const g of fired) {
      if (g.status === "pending") goals.setStatus(g.id, "active");
      const times = (this.#fired.get(g.id) ?? 0) + 1;
      this.#fired.set(g.id, times);
      const reminder = goalReminder(g, times, now, this.#d.config.utc_offset_minutes);
      this.#d.publish(Events.MindReminder, { state: "fired", reminder });
    }
    return fired;
  }

  // ---- loop ---------------------------------------------------------------------------------

  async run(signal: AbortSignal): Promise<void> {
    this.#running = true;
    try {
      while (!signal.aborted) {
        const now = this.#d.clock.now();
        this.checkGoals(now);
        let nap = NAP_MS;
        const at = TriggerWatch.nextAt(this.#d.goals.goals(), now);
        if (at !== null) nap = Math.min(nap, Math.max(at - now, 1000));
        // A wake ends the nap early (and its timer with it).
        const napping = new AbortController();
        const stop = () => napping.abort();
        signal.addEventListener("abort", stop, { once: true });
        this.#wake = stop;
        await sleep(nap, napping.signal).catch(() => undefined);
        signal.removeEventListener("abort", stop);
        this.#wake = null;
      }
    } finally {
      this.#running = false;
    }
  }

  static publish(publish: Publish, thought: Thought): void {
    publish(Events.MindThought, JSON.parse(JSON.stringify(thought)) as Thought);
  }
}
