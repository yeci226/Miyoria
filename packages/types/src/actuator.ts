// Who asks for an action, and the hook the scheduler uses to run gate-approved actions.
//
// Every action she can take (joining voice, going live, switching scenes, playing a game,
// sending a DM, ...) is a capability of the actuator registry (`@miyoria/actions`). Every call
// carries a `Principal`: on whose behalf it runs. The gate decides on the principal, the
// capability and its arguments only, never on chat text.

import { type AccountRef, accountRefString, type ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";

/**
 * - `self`: she decided on her own (possibly suggested by `requester`).
 * - `user`: someone asked her in chat; a request she may decline.
 * - `command`: a slash command; with `override` her own judgment is skipped.
 * - `panel`: the admin panel / API.
 * - `director`: the game director's slow loop.
 */
export type PrincipalKind = "self" | "user" | "command" | "panel" | "director";

export const PRINCIPAL_KINDS: readonly PrincipalKind[] = [
  "self",
  "user",
  "command",
  "panel",
  "director",
];

/** On whose behalf an action runs (serialized into audit entries and `gate.decision`). */
export interface Principal {
  kind: PrincipalKind;
  /**
   * The account that asked: the speaker for `user`, the invoker for `command`, the person who
   * suggested it for `self` (if anyone). `null` for `panel` (see `actor`) and `director`.
   */
  requester: AccountRef | null;
  /** Where the request came from (the chat / command context). */
  context: ContextKey | null;
  /**
   * `command` only: do it regardless of her judgment (no rate limits, cooldowns or self-review).
   * Hard prohibitions and consent still apply.
   */
  override: boolean;
  /** `panel`: the API actor (`"api"`, `"discord:<id>"`); `null` otherwise. */
  actor: string | null;
}

export const Principals = {
  self(context: ContextKey | null, suggestedBy: AccountRef | null = null): Principal {
    return { kind: "self", requester: suggestedBy, context, override: false, actor: null };
  },
  user(requester: AccountRef, context: ContextKey | null): Principal {
    return { kind: "user", requester, context, override: false, actor: null };
  },
  command(invoker: AccountRef, context: ContextKey | null, override = true): Principal {
    return { kind: "command", requester: invoker, context, override, actor: null };
  },
  panel(actor: string, context: ContextKey | null = null): Principal {
    return { kind: "panel", requester: null, context, override: false, actor };
  },
  director(context: ContextKey | null): Principal {
    return { kind: "director", requester: null, context, override: false, actor: null };
  },
} as const;

/** Audit actor of a principal: `self`, `user:discord:1`, `command:discord:1`, `panel:api`, ... */
export function principalActor(p: Principal): string {
  if (p.kind === "panel") return `panel:${p.actor ?? "api"}`;
  if (p.requester === null) return p.kind;
  return `${p.kind}:${accountRefString(p.requester)}`;
}

/** Whether the principal acts on its own (her or the director), not for a human right now. */
export function isAutonomous(p: Principal): boolean {
  return p.kind === "self" || p.kind === "director";
}

/**
 * Runs actions the gate already approved and that were queued in the scheduler as `actuate`
 * actions (lanes, TTL, `cancelTurn`). Provided by the app with the actuator registry.
 */
export interface ActuatorExecutor {
  /** Runs the approved request `ticket`; resolves with its result text. */
  run(ticket: string, signal: AbortSignal): Promise<string>;
  /** The scheduler dropped `ticket` without running it (expired, cancelled, ...). */
  dropped(ticket: string, reason: string): void;
  /** The emergency stop is on: she is muted. The one switch every output path reads. */
  readonly paused?: boolean;
}

export const ActuatorExecutorKey = serviceKey<ActuatorExecutor>("ActuatorExecutor");
