import {
  type AnyEventDefinition,
  type DecisionTraceData,
  type EventDraft,
  type EventPayload,
  familyCovers,
  type ModuleStateData,
} from "@miyoria/contracts/events";
import { type ModuleId, newId } from "./ids.js";
import { toTimestamp } from "./time.js";

// Every bus payload is a contract (`@miyoria/contracts/events`, one schema per bus topic); the
// types here are inferred from those schemas.

export type ModuleStateKind = ModuleStateData["state"];

/** Why the agent did or did not respond. Shown in the panel for debugging. */
export type DecisionTrace = DecisionTraceData;

// ---- the envelope ---------------------------------------------------------------------------
//
// The bus carries one envelope (K12b in docs/design/v5-contracts.md): the contract's event draft
// (`EventDraft` in @miyoria/contracts/events) with every key present, plus the `source` the bus
// stamps. `type` is the dotted topic and `data` the payload, for every event.

/** A bus topic's definition and the payload type it gives (re-exported from the contract). */
export type { AnyEventDefinition, EventPayload };

/** The bus envelope: the contract's draft plus the publishing module the bus stamps. */
export type BusEnvelope<Type extends string = string, Data = unknown> = Omit<
  EventDraft,
  "type" | "data"
> & {
  type: Type;
  /** The module that published it. */
  source: ModuleId;
  data: Data;
};

/** Every event on the bus is wrapped in an envelope. Treat envelopes as immutable. */
export type Envelope = BusEnvelope;

/** The part of an envelope that says what happened: what a reader narrows with `is`. */
export type BusEvent = Pick<BusEnvelope, "type" | "v" | "data">;

/** An envelope whose `data` is the payload of `D`. */
export type EnvelopeOf<D extends AnyEventDefinition> = Envelope & { data: EventPayload<D> };

/** What a publisher may say about an event besides its payload. */
export type EventMeta = Partial<
  Pick<
    EventDraft,
    | "parent"
    | "turn"
    | "session"
    | "space_id"
    | "room_id"
    | "person_id"
    | "account_id"
    | "scope"
    | "key"
  >
> & {
  /** Epoch ms for `at`; defaults to `Date.now()`. */
  now?: number;
};

/** Whether a definition's type is a family pattern (`**.task.done`, `game.*.*`). */
export type IsEventFamily<Type extends string> = Type extends `${string}*${string}` ? true : false;

/**
 * The meta argument of a publish by definition: a family needs the concrete `type` (one it
 * covers, `worklane.task.done` for `**.task.done`); a fixed type takes none. A definition whose
 * type is not known statically may take one.
 */
export type PublishMetaArgs<D extends AnyEventDefinition> = string extends D["type"]
  ? [meta?: EventMeta & { type?: string }]
  : IsEventFamily<D["type"]> extends true
    ? [meta: EventMeta & { type: string }]
    : [meta?: EventMeta & { type?: undefined }];

/**
 * Publishes one event by definition: what a module hands the parts that publish for it
 * (`ctx.publisher`, `bus.publisher(source)`).
 */
export type Publish = <D extends AnyEventDefinition>(
  definition: D,
  data: EventPayload<D>,
  ...meta: PublishMetaArgs<D>
) => void;

function stamped(
  source: ModuleId,
  type: string,
  v: number,
  data: unknown,
  meta: EventMeta,
): BusEnvelope {
  return {
    id: newId(),
    at: toTimestamp(meta.now ?? Date.now()),
    type,
    v,
    source,
    parent: meta.parent ?? null,
    turn: meta.turn ?? null,
    session: meta.session ?? null,
    space_id: meta.space_id ?? null,
    room_id: meta.room_id ?? null,
    person_id: meta.person_id ?? null,
    account_id: meta.account_id ?? null,
    scope: meta.scope ?? null,
    key: meta.key ?? null,
    data,
  };
}

/**
 * A fresh envelope of one event of `definition` from `source`. For a family, `meta.type` is the
 * concrete type; it must be one the family covers (a programming error otherwise: throws).
 */
export function eventEnvelope<D extends AnyEventDefinition>(
  source: ModuleId,
  definition: D,
  data: EventPayload<D>,
  ...[meta]: PublishMetaArgs<D>
): EnvelopeOf<D> {
  const m = (meta ?? {}) as EventMeta & { type?: string };
  let type: string = definition.type;
  if (definition.type.includes("*")) {
    if (m.type === undefined || !familyCovers(definition.type, m.type)) {
      throw new Error(`event family \`${definition.type}\` does not cover \`${String(m.type)}\``);
    }
    type = m.type;
  }
  return stamped(source, type, definition.v, data, m) as EnvelopeOf<D>;
}

/**
 * Whether `envelope` is an event of `definition` (its type, or a type its family covers, at its
 * version). Narrows `data` to the payload; the payload is not parsed: a bus payload is what its
 * publisher built (tests check publishers against the schemas).
 */
export function is<D extends AnyEventDefinition, E extends Pick<BusEnvelope, "type" | "v">>(
  definition: D,
  envelope: E,
): envelope is E & { data: EventPayload<D> } {
  if (envelope.v !== definition.v) return false;
  return definition.type.includes("*")
    ? familyCovers(definition.type, envelope.type)
    : envelope.type === definition.type;
}

/** What a test sees of a published event: its `type` and `data`. */
export interface PublishedEvent {
  type: string;
  data: unknown;
}

/**
 * A `Publish` that hands `fn` the `{ type, data }` of each event (a family's concrete type from
 * `meta.type`): for tests that look at what a part publishes.
 */
export function publishedVia(fn: (event: PublishedEvent) => void): Publish {
  return (definition, data, ...meta) => {
    const type = (meta[0] as { type?: string } | undefined)?.type ?? definition.type;
    fn({ type, data });
  };
}

/** A `Publish` that appends the `{ type, data }` of each event to `events` (see `publishedVia`). */
export function publishedInto(events: PublishedEvent[]): Publish {
  return publishedVia((event) => {
    events.push(event);
  });
}

/** Module id of the kernel itself: source of `system.module.state` events. */
export const KERNEL_MODULE: ModuleId = "kernel";
