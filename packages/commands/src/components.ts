// Component routes: buttons, select menus and modals that belong to a command.
//
// Every control Miyoria sends has a component id `mi:<route>:<params...>` (colon separated).
// Commands declare their routes when they register; the registry resolves an incoming id to the
// longest registered route prefix, checks the owning command's permission (plus the route's own
// node, if any), parses the remaining segments, runs `require` and then `handle`. Two commands
// cannot declare the same route.

import type { AccountRef, JsonValue } from "@miyoria/types";
import type { CommandReply, Modal } from "./reply.js";
import { CommandError, Invocation, type InvocationData } from "./spec.js";

export const COMPONENT_PREFIX = "mi";
/** Discord's limit for `custom_id`. */
export const MAX_COMPONENT_ID = 100;

const SEGMENT = /^[A-Za-z0-9_.\-@]+$/;

function checkSegment(segment: string, what: string): void {
  if (!SEGMENT.test(segment)) {
    throw new CommandError(`invalid component ${what} segment \`${segment}\``);
  }
}

/** Validates a route name such as `"queue:list:next"`. */
export function validateRoute(route: string): string[] {
  const segments = route.split(":");
  for (const segment of segments) checkSegment(segment, "route");
  return segments;
}

/**
 * Builds a component id: `componentId("queue:skip", 12)` → `"mi:queue:skip:12"`. Parameters
 * must not contain `:`; ids longer than 100 characters are rejected.
 */
export function componentId(route: string, ...params: readonly (string | number)[]): string {
  validateRoute(route);
  const parts = params.map(String);
  for (const part of parts) checkSegment(part, "parameter");
  const id = [COMPONENT_PREFIX, route, ...parts].join(":");
  if (id.length > MAX_COMPONENT_ID) {
    throw new CommandError(`component id \`${id}\` is longer than ${MAX_COMPONENT_ID}`);
  }
  return id;
}

/** The segments after `mi:`, or `null` for ids Miyoria did not make. */
export function componentSegments(id: string): string[] | null {
  const segments = id.split(":");
  if (segments[0] !== COMPONENT_PREFIX || segments.length < 2) return null;
  return segments.slice(1);
}

/** What the platform tracked about the message a control is on (see `ReplySession`). */
export interface SessionInfo {
  initiator: AccountRef;
  initiator_only: boolean;
  data: JsonValue | null;
}

/** One control interaction, normalized by the platform (the in-process wire shape). */
export interface ComponentInvocationData extends Omit<InvocationData, "path" | "args"> {
  custom_id: string;
  /** Selected values of a select menu. */
  values?: string[];
  /** Field values of a submitted modal, by field id. */
  fields?: Record<string, string>;
  /** The message the control is on (modals submitted from a command have none). */
  message_id?: string | null;
  /** The tracked session of that message, if it has one and it has not expired. */
  session?: SessionInfo | null;
}

/** A component interaction as the handler sees it; `path` is the owning command's. */
export class ComponentInvocation extends Invocation {
  readonly customId: string;
  readonly route: string;
  readonly params: readonly string[];
  readonly values: readonly string[];
  readonly fields: Readonly<Record<string, string>>;
  readonly messageId: string | null;
  readonly session: SessionInfo | null;

  constructor(
    data: ComponentInvocationData,
    path: readonly string[],
    route: string,
    params: readonly string[],
  ) {
    super({ ...data, path: [...path], args: {} });
    this.customId = data.custom_id;
    this.route = route;
    this.params = [...params];
    this.values = [...(data.values ?? [])];
    this.fields = { ...(data.fields ?? {}) };
    this.messageId = data.message_id ?? null;
    this.session = data.session ?? null;
  }

  /** A modal field, trimmed; `""` when missing. */
  field(id: string): string {
    return Object.hasOwn(this.fields, id) ? (this.fields[id] ?? "").trim() : "";
  }
}

/**
 * What a component handler answers:
 *
 * - `update`: replace the message the control is on (keeps its visibility).
 * - `reply`: send a new message (visible like the command's replies, or ephemeral when the
 *   route or the reply asks for it).
 * - `modal`: open a modal (only as the first answer).
 */
export type ComponentResult =
  | { type: "update"; reply: CommandReply }
  | { type: "reply"; reply: CommandReply }
  | { type: "modal"; modal: Modal };

export const ComponentResult = {
  update: (reply: CommandReply): ComponentResult => ({ type: "update", reply }),
  reply: (reply: CommandReply): ComponentResult => ({ type: "reply", reply }),
  modal: (modal: Modal): ComponentResult => ({ type: "modal", modal }),
} as const;

export interface ComponentRoute<P = readonly string[]> {
  /** Route name, colon separated, e.g. `"queue:list:next"`. */
  route: string;
  /** Extra node besides the owning command's (e.g. changing a setting the command shows). */
  permission?: string;
  /**
   * `true` makes `reply` answers ephemeral even when the command is public. Default: follow the
   * command's visibility (a private command stays private whatever the route says).
   */
  ephemeral?: boolean;
  /** The message must still have a live session (else: expired panel). Default `false`. */
  requiresSession?: boolean;
  /** Typed parameters from the segments after the route; `null` rejects the interaction. */
  parse?: (params: readonly string[]) => P | null;
  /** Extra check after the permission check; `false` refuses. */
  require?: (params: P, inv: ComponentInvocation) => boolean | Promise<boolean>;
  handle: (inv: ComponentInvocation, params: P) => ComponentResult | Promise<ComponentResult>;
}

/** A route with its parameter type erased (what the registry stores). */
export type AnyComponentRoute = ComponentRoute<unknown>;

/** Declares a route with typed parameters. */
export function defineRoute<P>(route: ComponentRoute<P>): AnyComponentRoute {
  return route as unknown as AnyComponentRoute;
}

/** A non-negative integer parameter, or `null`. */
export function intParam(raw: string | undefined): number | null {
  if (raw === undefined || !/^\d{1,15}$/.test(raw)) return null;
  return Number(raw);
}

/** One autocomplete suggestion. */
export interface Choice {
  name: string;
  value: string;
}

/** Suggestions for one argument while the user types `value`. */
export type AutocompleteHandler = (inv: Invocation, value: string) => Choice[] | Promise<Choice[]>;
