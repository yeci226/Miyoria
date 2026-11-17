// Where the segment pass puts what is not a document line: the episode (L2) and the follow-ups.
//
// Until L2 is rebuilt on its own table, both go to today's `memory_records` through the memory
// engine's public write (`MemoryEngine.store`), with the scope translated to the old vocabulary
// (`toMemoryScope`), so recall keeps finding them. A scope the resolver cannot translate is not
// widened: the item is not stored.
//
// Follow-ups are read back too: the pass is shown the open ones about the people and the place of
// its segment, and closes or changes them by id the way the old consolidation did (`done`, and the
// open ones about the same person and matter with it). A new one the engine already holds in other
// words (`followupTwin`) is not stored again.

import type { MemoryRecord, MemoryScope } from "@miyoria/store";
import type { AccountRef, ContextKey, PersonId, Timestamp } from "@miyoria/types";
import type { NewMemory, Stored } from "../../memory/src/engine.js";
import { LINE_REF_PREFIX } from "../../memory/src/evidence.js";
import { type NoteScope, type ScopeResolver, toMemoryScope } from "./scope.js";

/** One episode of a segment: what happened, who was there, how she felt. */
export interface SegmentEpisode {
  summary: string;
  /** Her feeling in a few words; `null`: none given. */
  feeling: string | null;
  /** 0..1 */
  importance: number;
  people: PersonId[];
  /** Where it may be recalled: the place's scope. */
  scope: NoteScope;
  session: string;
  seq_from: number;
  seq_to: number;
  /** The platform ids of the messages of the segment. */
  message_ids: string[];
  at: Timestamp;
}

/** Something to bring up later. */
export interface SegmentFollowup {
  about: string;
  /** Whom it is about; `null`: nobody in particular. */
  person: PersonId | null;
  due: Timestamp;
  scope: NoteScope;
  session: string;
  at: Timestamp;
  /** Names of the people of the segment, which say nothing about the matter (`sameMatter`). */
  names?: readonly string[];
}

/** A follow-up still open, as the pass shows it. */
export interface OpenFollowup {
  id: string;
  about: string;
  /** Whom it is about; `null`: nobody in particular. */
  person: PersonId | null;
  due: Timestamp | null;
}

/** Which open follow-ups a segment is shown: about its people, visible at its place. */
export interface FollowupQuery {
  people: readonly PersonId[];
  /** The place's scope (`placeScope`). */
  scope: NoteScope;
  session: string;
  limit: number;
  at: Timestamp;
}

/**
 * Where the pass hands episodes and follow-ups. A write returns the id stored, `null`: not stored
 * (refused, or the same follow-up is held already).
 */
export interface EpisodeSink {
  episode(episode: SegmentEpisode, signal?: AbortSignal): Promise<string | null>;
  followup?(followup: SegmentFollowup, signal?: AbortSignal): Promise<string | null>;
  /** The open follow-ups of `query`, newest first. */
  openFollowups?(query: FollowupQuery, signal?: AbortSignal): Promise<OpenFollowup[]>;
  /**
   * Closes the follow-up `id` (answered or done), with the open ones about the same person and
   * matter. Returns how many were closed.
   */
  closeFollowup?(id: string, at: Timestamp, names: readonly string[]): Promise<number>;
  /** Rewords an open follow-up or moves its time; whether it changed. */
  updateFollowup?(
    id: string,
    change: { about: string | null; due: Timestamp | null },
    at: Timestamp,
    signal?: AbortSignal,
  ): Promise<boolean>;
}

/** The followup record shape the adapter reads back. */
type FollowupRecord = Pick<MemoryRecord, "id" | "content" | "subjects" | "due">;

/**
 * What the adapter needs of the memory engine: its one public write, and for follow-ups what it
 * shows, closes, changes and finds held already (`MemoryEngine` has all of them).
 */
export interface MemoryWriter {
  store(memory: NewMemory, now: Timestamp, signal?: AbortSignal): Promise<Stored>;
  openFollowupsAbout?(
    where: {
      context: ContextKey;
      persons: readonly PersonId[];
      accounts: readonly AccountRef[];
      dm: { account: AccountRef; person: PersonId | null } | null;
      limit: number;
    },
    now: Timestamp,
  ): Promise<FollowupRecord[]>;
  closeFollowupById?(id: string, now: Timestamp, names?: readonly string[]): Promise<number>;
  updateFollowup?(
    id: string,
    change: { content: string | null; due: Timestamp | null },
    now: Timestamp,
    signal?: AbortSignal,
  ): Promise<boolean>;
  followupTwin?(
    subjects: readonly PersonId[],
    about: string,
    context: ContextKey | null,
    names: readonly string[],
    now: Timestamp,
  ): Promise<boolean>;
}

export interface MemorySinkOptions {
  resolver: ScopeResolver;
  /** The platform a DM scope's account is looked up on. */
  platform?: string;
  /** The context written as `source_context`, by session; `null`: none known. */
  contextOf?: (session: string) => ContextKey | null;
}

const idOf = (stored: Stored): string | null =>
  stored.type === "refused" ? null : stored.type === "superseded" ? stored.new : stored.id;

/** The episode as today's episodes read: the summary, then her feeling. */
export function episodeText(episode: Pick<SegmentEpisode, "summary" | "feeling">): string {
  const feeling = episode.feeling?.trim() ?? "";
  return feeling === "" ? episode.summary : `${episode.summary}(當時我的心情:${feeling})`;
}

/**
 * An `EpisodeSink` over the memory engine: an episode is a `memory_records` row of kind `episode`
 * (origin `experienced`, its evidence the segment's messages), a follow-up one of kind
 * `followup` with its due time.
 */
export function memoryEpisodeSink(writer: MemoryWriter, options: MemorySinkOptions): EpisodeSink {
  const scopeOf = (scope: NoteScope): MemoryScope | null =>
    toMemoryScope(scope, options.resolver, options.platform);
  const context = (session: string) => options.contextOf?.(session) ?? null;
  return {
    async episode(episode, signal) {
      const scope = scopeOf(episode.scope);
      if (scope === null) return null;
      const stored = await writer.store(
        {
          kind: "episode",
          scope,
          subjects: [...episode.people],
          content: episodeText(episode),
          importance: episode.importance,
          confidence: 1,
          source_context: context(episode.session),
          due: null,
          origin: "experienced",
          source_events: episode.message_ids.map((id) => `${LINE_REF_PREFIX}${id}`),
        },
        episode.at,
        signal,
      );
      return idOf(stored);
    },
    async followup(followup, signal) {
      const scope = scopeOf(followup.scope);
      if (scope === null) return null;
      const subjects = followup.person === null ? [] : [followup.person];
      // Reworded, the same question is not a new one (`MemoryEngine.followupTwin`).
      const held = await writer.followupTwin?.(
        subjects,
        followup.about,
        context(followup.session),
        followup.names ?? [],
        followup.at,
      );
      if (held === true) return null;
      const stored = await writer.store(
        {
          kind: "followup",
          scope,
          subjects,
          content: followup.about,
          importance: 0.5,
          confidence: 1,
          source_context: context(followup.session),
          due: followup.due,
          origin: "experienced",
        },
        followup.at,
        signal,
      );
      return idOf(stored);
    },
    async openFollowups(query) {
      const where = context(query.session);
      if (where === null || writer.openFollowupsAbout === undefined) return [];
      let dm: { account: AccountRef; person: PersonId | null } | null = null;
      if (query.scope.type === "dm") {
        const account = options.resolver.accountOf(
          query.scope.person,
          options.platform ?? where.platform,
        );
        if (account === null) return [];
        dm = { account, person: query.scope.person };
      }
      const records = await writer.openFollowupsAbout(
        {
          context: where,
          persons: query.people,
          accounts: dm === null ? [] : [dm.account],
          dm,
          limit: query.limit,
        },
        query.at,
      );
      return records.map((r) => ({
        id: r.id,
        about: r.content,
        person: r.subjects[0] ?? null,
        due: r.due,
      }));
    },
    async closeFollowup(id, at, names) {
      return (await writer.closeFollowupById?.(id, at, names)) ?? 0;
    },
    async updateFollowup(id, change, at, signal) {
      return (
        (await writer.updateFollowup?.(
          id,
          { content: change.about, due: change.due },
          at,
          signal,
        )) ?? false
      );
    },
  };
}
