// Directive: the owner's rules (docs/design/v3-architecture.md §9).
//
// What the owner says used to fade after 20 minutes while her own goals lasted for ever, and
// anyone speaking could talk her out of a rule. A Directive is a stored rule with an issuer and an
// authority, enforced three times, none of which relies on the model behaving:
//
// 1. `inject`: the lines of the fixed system block, every turn, no retrieval.
// 2. `filterTools`: a forbidden tool is not on the list.
// 3. `check`: deny first, on the action path before the gate; it fails closed.
//
// The authority of a rule comes from the account that made it, resolved by the service. Nothing
// here takes an authority from a caller, and no text of a message ever reaches that decision.

import type { Principal } from "./actuator.js";
import type { Subject } from "./auth.js";
import type { Handle } from "./handle.js";
import type { Proposal } from "./mainline.js";
import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";
import type { Timestamp } from "./time.js";

/** `deny` and `require_approval` are enforced; `prefer` and `avoid` are only said to her. */
export const DIRECTIVE_EFFECTS = ["deny", "require_approval", "prefer", "avoid"] as const;

export type DirectiveEffect = (typeof DIRECTIVE_EFFECTS)[number];

export function isDirectiveEffect(value: unknown): value is DirectiveEffect {
  return typeof value === "string" && (DIRECTIVE_EFFECTS as readonly string[]).includes(value);
}

/** Highest first. `viewer` is everyone else: their rule can only ever be a short `prefer`. */
export const DIRECTIVE_AUTHORITIES = ["owner", "moderator", "system", "viewer"] as const;

export type DirectiveAuthority = (typeof DIRECTIVE_AUTHORITIES)[number];

export function isDirectiveAuthority(value: unknown): value is DirectiveAuthority {
  return typeof value === "string" && (DIRECTIVE_AUTHORITIES as readonly string[]).includes(value);
}

/** What a rule applies to. Every field narrows it; a field left out does not. */
export interface DirectiveScope {
  /** A capability or tool name, or a pattern (`game.*`, `*`). */
  capability?: string;
  /** A word of what is being done: the game (`minecraft`), a goal, a target (`diamond`). */
  activity?: string;
  context?: ContextKey;
  person?: Handle;
}

/** §9. */
export interface Directive {
  id: string;
  issuer: AccountRef;
  authority: DirectiveAuthority;
  scope: DirectiveScope;
  effect: DirectiveEffect;
  /** In the issuer's words: 「不要玩 Minecraft」. */
  text: string;
  /** `until_revoked` never expires. */
  expires: Timestamp | "until_revoked";
  /** What it came from: an EventLog id, `msg:<id>`, `command:<path>` or `panel:<actor>`. */
  source_event: string;
  created_at: Timestamp;
}

/** A stored rule and how it ended, if someone ended it. */
export interface DirectiveRecord extends Directive {
  revoked_at: Timestamp | null;
  /** The account (`discord:1`) or panel actor that removed it. */
  revoked_by: string | null;
}

/** Whether `directive` is in force at `nowMs`. */
export function directiveLive(directive: Pick<Directive, "expires">, nowMs: number): boolean {
  return directive.expires === "until_revoked" || Date.parse(directive.expires) > nowMs;
}

/**
 * Who changes the rules.
 *
 * - `account`: a person, by what the platform says of them (a tool call, a command, a panel
 *   session). `askers` are the others the same turn spoke for; the weakest of them all counts.
 * - `console`: whoever holds the panel's bearer token, which has every right.
 */
export type DirectiveActor =
  | { type: "account"; subject: Subject; askers?: readonly AccountRef[] }
  | { type: "console"; actor: string };

export interface DirectiveRequest {
  by: DirectiveActor;
  text: string;
  effect: DirectiveEffect;
  scope: DirectiveScope;
  /** How long it lasts. `null`: until revoked for the owner; a moderator has to say. */
  minutes: number | null;
  source_event: string;
  /** The statement could be read more than one way: this goes back, no rule is made. */
  question?: string | null;
}

export interface DirectiveRemoval {
  by: DirectiveActor;
  /** The rule, by id. */
  id?: string | null;
  /** Or a word of it (`minecraft`). More than one match is a question, not a guess. */
  match?: string | null;
  source_event: string;
}

export type DirectiveRefusal =
  /** The account may not do this. */
  | "authority"
  /** Nothing matches. */
  | "not_found"
  /** The request itself is wrong. */
  | "invalid"
  /** Too many short requests are open. */
  | "full"
  /** The store did not answer; nothing changed. */
  | "store";

export type DirectiveChange =
  | { status: "added"; directive: Directive; note: string | null }
  | { status: "removed"; directive: Directive }
  /** Nothing changed: ask this first. */
  | { status: "question"; question: string }
  | { status: "refused"; reason: DirectiveRefusal; detail: string };

/** What a rule can read of one of her goals. */
export interface DirectiveGoal {
  what: string;
  why: string;
  steps: readonly string[];
  person: Handle | null;
  context: ContextKey | null;
}

/** One action, for `check`. */
export interface DirectiveQuery {
  /** The capability. `null`: nothing to run (a proposal that only wants to talk). */
  capability: string | null;
  /** The arguments, after any patch: what is about to happen, not what was first asked for. */
  args?: unknown;
  principal: Principal;
  /** Who it concerns when the capability cannot tell (`ActionRequest.about`). */
  about?: AccountRef | null;
}

export type DirectiveVerdict =
  | { outcome: "allow" }
  /** `directive` is `null` when the rules could not be read: closed, not open. */
  | { outcome: "deny"; directive: string | null; reason: string }
  /** It goes to the owners first (`require_approval`). */
  | { outcome: "approval"; directive: string; reason: string };

/**
 * Provided by the app with the store (`packages/core/src/boot.ts`), whatever the `directive`
 * module's state: turning that module off removes the tools and commands, not the rules.
 */
export interface Directives {
  /** The lines of the fixed system block. Owner, moderator and system rules only. Reads memory. */
  inject(context: ContextKey | null): string[];
  /** What viewers asked for: for her context, never for the system block. Reads memory. */
  wishes(context: ContextKey | null): string[];
  /** `tools` without the forbidden ones. Reads memory. */
  filterTools<T extends { name: string }>(tools: readonly T[], context: ContextKey | null): T[];
  /** Deny first; asks the store, and a store that does not answer is a `deny`. */
  check(query: DirectiveQuery): Promise<DirectiveVerdict>;
  /**
   * The `deny` that forbids `goal`, read off its words: a rule that only names a capability says
   * nothing about a goal, which has none. Reads memory.
   */
  forbids(goal: DirectiveGoal): Directive | null;
  /**
   * Whether a background proposal may stand. A `deny` or `approval` drops it: the `directive` and
   * `result` lines of the log say why, and the board forgets it. Safe to call twice.
   */
  screen(proposal: Proposal): DirectiveVerdict;
  add(request: DirectiveRequest): Promise<DirectiveChange>;
  remove(request: DirectiveRemoval): Promise<DirectiveChange>;
  /** The rules in force, or with `history` the ended ones too, newest first. */
  list(options?: { history?: boolean }): Promise<DirectiveRecord[]>;
  /** Whether the last read of the store worked: while it does not, everything fails closed. */
  readonly healthy: boolean;
}

export const DirectivesKey = serviceKey<Directives>("Directives");

/** Bus topic: a rule was added or removed (`DirectiveChangedBody`). */
export const DIRECTIVE_CHANGED_TOPIC = "directive.changed";

/** The `body` of a `directive` log line, and the payload of `DIRECTIVE_CHANGED_TOPIC`. */
export interface DirectiveChangedBody {
  op: "add" | "remove" | "refused" | "proposal_dropped";
  /** What the panel shows. */
  text: string;
  directive: Directive | null;
  /** Who did it (`discord:1`, a panel actor, `directive` for what the rules themselves did). */
  by: string;
  /** `proposal_dropped`: which one. */
  proposal?: string;
}
