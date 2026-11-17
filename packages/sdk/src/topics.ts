// Topic patterns, matching the host's `TopicFilter`, and event types by definition.

import { type AnyEventDefinition, type EventPayload, familyCovers } from "@miyoria/contracts/events";

/** `"*"` matches everything, `"a.*"` every topic under `a.`, else exact. */
export function topicMatches(pattern: string, topic: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1); // keeps the trailing dot
    return topic.startsWith(prefix);
  }
  return pattern === topic;
}

const SEGMENT = /^[a-z0-9_-]+$/;

/** Concrete topic: dotted segments of `[a-z0-9_-]`. */
export function isValidTopic(topic: string): boolean {
  return topic.length > 0 && topic.length <= 128 && topic.split(".").every((s) => SEGMENT.test(s));
}

/**
 * Whether `envelope` is an event of `definition`: its type, or a type its family covers
 * (`game.*.*` covers `game.osu.death`), at its version. Narrows `data` to the payload type; the
 * payload is not parsed (`readEventData` from `@miyoria/contracts/events` parses it).
 */
export function is<D extends AnyEventDefinition, E extends { type: string; v: number }>(
  definition: D,
  envelope: E,
): envelope is E & { data: EventPayload<D> } {
  return envelope.v === definition.v && familyCovers(definition.type, envelope.type);
}

/**
 * The subscription pattern that receives every type of `definition`: the type itself, else the
 * words before its first wildcard as a prefix (`game.*.*` -> `game.*`, `**.task.done` -> `*`).
 * The pattern can be wider than the family; `is` narrows what arrives.
 */
export function definitionPattern(definition: AnyEventDefinition): string {
  const words = definition.type.split(".");
  const wild = words.findIndex((word) => word === "*" || word === "**");
  if (wild < 0) return definition.type;
  return wild === 0 ? "*" : `${words.slice(0, wild).join(".")}.*`;
}
