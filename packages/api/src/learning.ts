// What she organized and learned, read-only: `GET /api/knowledge` (her documents, whatever their
// shape), `GET /api/knowledge/conversations` (her running notes on each conversation),
// `GET /api/reflection` (her reflections, lessons and feedback signals) and
// `GET /api/mind/digests` (condensed older thoughts). Changes are hers (or the data page's
// delete), not these routes'. On the route table (`@miyoria/contracts/api`): `knowledgeRpc`,
// `reflectionRpc` and `digestRpc`.

import type {
  ConversationNote as ConversationNoteView,
  KnowledgeDoc as KnowledgeDocView,
  KnowledgeView,
  Lesson as LessonView,
  ReflectionView,
} from "@miyoria/contracts/api";
import { PeopleDirectoryKey } from "@miyoria/heart/person";
import {
  ConversationStatesKey,
  KnowledgeKey,
  type KnowledgeSubject,
  LessonsKey,
  MindKey,
  PlatformSinksKey,
  ReflectionKey,
} from "@miyoria/types";
import { os } from "./contract.js";
import type { ApiState } from "./state.js";

const MAX_RUNS = 60;

/** `#` + the last 6 characters of the id (what her prompts show). */
function shortId(id: string): string {
  return `#${id.slice(-6).toLowerCase()}`;
}

function subjectLabel(state: ApiState, subject: KnowledgeSubject): string {
  switch (subject.type) {
    case "person":
      return state.optional(PeopleDirectoryKey)?.displayName(subject.person) ?? subject.person;
    case "guild":
      return `伺服器 ${subject.guild}`;
    case "self":
      return "她自己";
    case "topic":
      return subject.name;
  }
}

function knowledgeView(state: ApiState): KnowledgeView {
  const kb = state.service(KnowledgeKey, "knowledge module");
  const documents: KnowledgeDocView[] = kb.docs().map((doc) => ({
    ...doc,
    short_id: shortId(doc.id),
    subject_label: subjectLabel(state, doc.subject),
  }));
  return { documents };
}

async function conversations(state: ApiState): Promise<ConversationNoteView[]> {
  const states = state.service(ConversationStatesKey, "conversation module");
  const sinks = state.optional(PlatformSinksKey);
  return Promise.all(
    states.list().map(async (s) => {
      let label: string | null = null;
      try {
        label = await state.labels.label(sinks, s.context);
      } catch {
        label = null;
      }
      return { ...s, label };
    }),
  );
}

function reflectionView(state: ApiState, days: number): ReflectionView {
  const reflection = state.service(ReflectionKey, "reflect module");
  const social = state.optional(PeopleDirectoryKey);
  const lessons: LessonView[] = (state.optional(LessonsKey)?.all() ?? []).map((l) => ({
    ...l,
    display_name: l.person === null ? null : (social?.displayName(l.person) ?? null),
  }));
  return {
    stats: reflection.stats(),
    runs: reflection.runs(MAX_RUNS),
    lessons,
    feedback: reflection.feedback(days),
  };
}

/** A count of the query string; one that is not a number is `fallback`, as it always was. */
function intQuery(raw: string | number | undefined, fallback: number, max: number): number {
  const n = Number(raw ?? fallback);
  return Number.isFinite(n) ? Math.min(Math.max(Math.trunc(n), 1), max) : fallback;
}

/** `GET /api/knowledge` and `GET /api/knowledge/conversations`. */
export const knowledgeRpc = {
  documents: os.knowledge.documents.handler(({ context }) => knowledgeView(context.state)),
  conversations: os.knowledge.conversations.handler(({ context }) => conversations(context.state)),
};

/** `GET /api/reflection?days=`. */
export const reflectionRpc = os.reflection.handler(({ input, context }) =>
  reflectionView(context.state, intQuery(input.query.days, 7, 14)),
);

/** `GET /api/mind/digests?limit=`: joins the mind group. */
export const digestRpc = {
  digests: os.mind.digests.handler(({ input, context }) => {
    const mind = context.state.service(MindKey, "mind module");
    return mind.digests?.(intQuery(input.query.limit, 20, 100)) ?? [];
  }),
};
