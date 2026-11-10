// Fakes of the v2 services the mind consumes: the affect service (records what it is asked to
// do), the Arbiter (records impulses, answers with a verdict) and a scripted LLM provider that
// answers by call kind (Appraise / Plan).

import type { ChatProvider, ChatRequest, ChatStream } from "@miyoria/llm";
import type {
  AffectInput,
  AffectSnapshot,
  AffectSource,
  AffectState,
  AppliedAppraisal,
  Arbiter,
  ArbiterDecision,
  BondChange,
  EmotionReading,
  Impulse,
  LedgerLimits,
  LedgerRecord,
  LedgerView,
  PersonCard,
  PersonId,
} from "@miyoria/types";

export function card(handle: string, person: PersonId, p: Partial<PersonCard> = {}): PersonCard {
  return {
    person,
    handle,
    call_name: null,
    affinity: 30,
    trust: 40,
    familiarity: 40,
    attachment: 0.5,
    emotions: {},
    feeling: "",
    label: "朋友",
    level: 6,
    owner: false,
    blocked: false,
    last_seen: null,
    last_together: null,
    updated_at: "2026-11-02T12:00:00.000Z",
    ...p,
  };
}

export class FakeAffect implements AffectState {
  readonly appraised: AffectInput[] = [];
  readonly bonds: { person: PersonId; change: BondChange; by: AffectSource }[] = [];
  readonly cardList: PersonCard[] = [];
  snap: AffectSnapshot = {
    at: "2026-11-02T12:00:00.000Z",
    drives: {
      social: 0.2,
      play: 0.2,
      attention: 0.1,
      rest: 0.1,
      curiosity: 0.1,
      esteem: 0.1,
      hunger: 0,
      longing: 0,
    },
    boredom: 0.1,
    top: [],
    mood: { valence: 0.3, arousal: 0.4, energy: 0.6 },
    mood_line: "心情不錯",
    shown: null,
    biases: { talkativeness: 0, initiative: 0, wants: [] },
  };

  snapshot(): AffectSnapshot {
    return structuredClone(this.snap);
  }
  emotions(): EmotionReading[] {
    return [];
  }
  appraise(input: AffectInput): AppliedAppraisal[] {
    this.appraised.push(structuredClone(input));
    return input.events.map((e) => ({
      emotion: e.emotion,
      toward: null,
      amount: 0.1,
      habituation: 1,
      inhibited: {},
    }));
  }
  satisfy(): void {}
  card(person: PersonId): PersonCard | null {
    return this.cardList.find((c) => c.person === person) ?? null;
  }
  cardByHandle(handle: string): PersonCard | null {
    return this.cardList.find((c) => c.handle === handle) ?? null;
  }
  cards(): PersonCard[] {
    return [...this.cardList].sort((a, b) => b.attachment - a.attachment);
  }
  async adjustBond(
    person: PersonId,
    change: BondChange,
    by: AffectSource,
  ): Promise<PersonCard | null> {
    this.bonds.push({ person, change: structuredClone(change), by });
    return this.card(person);
  }
}

export function limits(p: Partial<LedgerLimits> = {}): LedgerLimits {
  return {
    initiatives_today: 0,
    initiative_cap: 12,
    unanswered_streak: 0,
    next_initiative_at: null,
    quiet_hours: { start_hour: 1, end_hour: 7, active: false },
    paused: false,
    blocked: [],
    ...p,
  };
}

export class FakeArbiter implements Arbiter {
  readonly impulses: Impulse[] = [];
  view: Partial<LedgerView> = {};
  verdict: (impulse: Impulse) => ArbiterDecision = (impulse) => ({
    impulse: impulse.id,
    source: impulse.source,
    verdict: "accepted",
    reason: null,
    detail: "ok",
    retry_at: null,
    merged_into: null,
    turn: `T-${this.impulses.length}`,
    task: null,
    at: impulse.created_at,
  });

  async submit(impulse: Impulse): Promise<ArbiterDecision> {
    this.impulses.push(structuredClone(impulse));
    return this.verdict(impulse);
  }
  ledger(): LedgerView {
    return {
      at: "2026-11-02T12:00:00.000Z",
      entries: [],
      limits: limits(),
      unanswered: [],
      ...this.view,
    };
  }
  record(_entry: LedgerRecord): string {
    return "L1";
  }
  resolve(): boolean {
    return true;
  }
}

/** Which Deliberate call a request is. */
export function callKind(request: ChatRequest): "appraise" | "plan" | "plan_daily" | "other" {
  const p = request.reasoning_purpose;
  return p === "appraise" || p === "plan" || p === "plan_daily" ? p : "other";
}

/** A provider that answers each request with `answer(request)`. */
export class ScriptedProvider implements ChatProvider {
  readonly name = "p";
  readonly #requests: ChatRequest[] = [];

  constructor(public answer: (request: ChatRequest) => string) {}

  requests(kind?: ReturnType<typeof callKind>): ChatRequest[] {
    return this.#requests.filter((r) => kind === undefined || callKind(r) === kind);
  }

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.#requests.push(structuredClone(request));
    const text = this.answer(request);
    async function* events() {
      yield { type: "text_delta" as const, text };
      yield {
        type: "done" as const,
        finish_reason: "stop" as const,
        usage: { prompt_tokens: 10, completion_tokens: 5, cached_prompt_tokens: null },
      };
    }
    return events() as unknown as ChatStream;
  }
}

/** The system and user text of a request. */
export function texts(request: ChatRequest | undefined): { system: string; data: string } {
  const of = (role: string) =>
    (request?.messages ?? [])
      .filter((m) => m.role === role)
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
  return { system: of("system"), data: of("user") };
}
