// Events across the extension boundary (protocol 2, docs/protocols/extension-rpc.md): the bus
// envelope as the `event` notification carries it, and which types an extension may publish with
// `events.publish`, resolved against the registry of bus topics (`BUS_EVENTS`).
//
// The registry decides what is reserved. Two of its definitions are open namespaces that belong
// to extensions (`ExtensionEvent`, `ext.**`, and `GameAdapterEvent`, `game.*.*`); every other
// definition, fixed or family, is a built-in event, and an extension may never publish a type one
// of them covers (`platform.message.created`, `gate.decision`, `ext.<id>.task.done`, which the
// task families cover: task events come from `task.event` and the host's checks). Two built-in
// events are the exception: `self.nudge` and `self.feel` are inputs meant for games and
// extensions (docs/design/autonomy.md), so one of them may be published with a granted `events`
// pattern that matches it. Outside that:
//
// - `ext.<own id>.…` is always allowed;
// - `game.<own game>.…` is allowed for the adapter that declares that game, and no one else;
// - `ext.<other id>.…` is allowed when a granted `events` pattern matches it;
// - a type no definition covers (protocol 1's custom topics, `custom.thing`) is refused: every
//   event on the bus has a registered schema, and an extension's own events have one under
//   `ext.<id>.`.
//
// The payload is checked against the definition's schema and published as the schema reads it.

import type { BusEnvelopeJson } from "@miyoria/contracts/events";
import {
  type AnyEventDefinition,
  busEventRegistry,
  ExtensionEvent,
  familyCovers,
  GameAdapterEvent,
  SelfFeel,
  SelfNudge,
} from "@miyoria/contracts/events";
import type { TopicFilter } from "@miyoria/runtime/kernel";
import type { BusEnvelope, JsonValue } from "@miyoria/types";
import { z } from "zod";
import { validTopic } from "./manifest.js";
import { RpcError } from "./rpc.js";

/** The bus topics with their payload schemas. */
const REGISTRY = busEventRegistry();

/** The registry's definitions that belong to extensions rather than to Core. */
export const OPEN_EVENT_NAMESPACES: readonly AnyEventDefinition[] = [
  ExtensionEvent,
  GameAdapterEvent,
];

/**
 * Built-in events that are inputs meant for games and extensions: a nudge to her drives and one
 * to her emotions (the self module caps each). An extension publishes one only with a granted
 * `events` pattern that matches it; the payload is checked like any other.
 */
export const EXTENSION_INPUT_EVENTS: readonly AnyEventDefinition[] = [SelfNudge, SelfFeel];

/** Every other definition: built-in events, which no extension may publish. */
const BUILT_IN: readonly AnyEventDefinition[] = REGISTRY.list().filter(
  (definition) =>
    !OPEN_EVENT_NAMESPACES.includes(definition) && !EXTENSION_INPUT_EVENTS.includes(definition),
);

/** The built-in definition that covers `type` (its own or a family's), or `null`. */
export function reservedBy(type: string): AnyEventDefinition | null {
  return BUILT_IN.find((definition) => familyCovers(definition.type, type)) ?? null;
}

/** Who is publishing: the extension's id, its declared game and its granted `events` patterns. */
export interface Publisher {
  id: string;
  game: string | null;
  grants: TopicFilter;
}

/** An `events.publish` the host accepted: the definition to publish by and the checked payload. */
export interface ResolvedPublish {
  definition: AnyEventDefinition;
  data: unknown;
}

/**
 * Resolves one `events.publish` of `type` with `data` from `who`, or throws the `RpcError` the
 * extension gets: `PermissionDenied` for a type it may not publish, `InvalidParams` for a type
 * that is not a concrete topic, that nobody registered, or whose payload does not fit.
 */
export function resolvePublish(who: Publisher, type: string, data: JsonValue): ResolvedPublish {
  if (!validTopic(type)) throw RpcError.invalidParams(`bad event type \`${type}\``);
  const builtIn = reservedBy(type);
  if (builtIn !== null) {
    throw RpcError.denied(
      `\`${type}\` is a built-in event (\`${builtIn.type}\`): extensions may not publish it`,
    );
  }
  const ownExt = type.startsWith(`ext.${who.id}.`);
  const ownGame = who.game !== null && type.startsWith(`game.${who.game}.`);
  const definition = REGISTRY.resolve(type);
  if (definition === GameAdapterEvent && !ownGame) {
    throw RpcError.denied(
      `\`${type}\` is in a game's namespace: only the adapter that declares that game may publish it`,
    );
  }
  if (!ownExt && !ownGame && !who.grants.matches(type)) {
    throw RpcError.denied(`publishing \`${type}\` is not permitted`);
  }
  if (definition === null) {
    throw RpcError.invalidParams(
      `no event type \`${type}\` is registered: an extension publishes its own events under \`ext.${who.id}.\``,
    );
  }
  const parsed = definition.data.safeParse(data);
  if (!parsed.success) {
    throw RpcError.invalidParams(
      `\`${type}\` does not fit \`${definition.type}\` v${definition.v}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return { definition, data: parsed.data };
}

/**
 * The bus envelope as the `event` notification carries it (`BusEnvelopeSchema`): every key in the
 * schema's order (the bus stamps them in another order).
 */
export function wireEnvelope(envelope: BusEnvelope): BusEnvelopeJson {
  return {
    id: envelope.id,
    at: envelope.at,
    type: envelope.type,
    v: envelope.v,
    parent: envelope.parent,
    turn: envelope.turn,
    session: envelope.session,
    space_id: envelope.space_id,
    room_id: envelope.room_id,
    person_id: envelope.person_id,
    account_id: envelope.account_id,
    key: envelope.key,
    scope: envelope.scope,
    source: envelope.source,
    data: (envelope.data ?? null) as JsonValue,
  };
}
