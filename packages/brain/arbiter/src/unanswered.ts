// What counts as her starting to talk and as a person responding (docs/design/v3-architecture.md
// §7.2, 有人回應才算對話), for the count the Arbiter's ledger keeps (`Ledger.startedTalking`,
// `heard`). Whether she may talk now is the Floor's (floor.ts), which counts from the
// DeliveryLedger.
//
// The other rules on her own starts (caps, gaps, backoff) only look at `isSelfInitiated`, but in
// the run of 2026-11-07 that was a few of her 83 self-started turns: nearly all were game
// commentary, which is why this rule has its own, wider definition.

import {
  type AccountRef,
  type BusEvent,
  type ContextKey,
  Events,
  type Impulse,
  impulseReason,
  is,
  isSelfInitiated,
} from "@miyoria/types";

/** The reason of a memory followup (`action_result` is a result someone waits for). */
const MEMORY_FOLLOWUP = "followup";

/**
 * Whether this impulse has her talking with nobody asking: her own wishes (`plan`, `agenda`),
 * narration (`attention`) and memory followups. Only these are stopped by `max_unanswered`, and
 * only turns of these add to the count.
 *
 * Never: answers, commands and the panel, songs, notices, results someone waits for, urgent game
 * events and requested goals (no `attention`), greetings (someone just arrived).
 */
export function startsTalk(impulse: Impulse): boolean {
  if (isSelfInitiated(impulse.source) || (impulse.attention ?? null) !== null) return true;
  return impulse.source === "followup" && impulseReason(impulse) === MEMORY_FOLLOWUP;
}

/** Who responded and where. */
export interface HumanResponse {
  context: ContextKey;
  account: AccountRef;
}

/**
 * Whether `event` is a person responding: any message or transcribed speech of a human in that
 * context, addressed to her or not. People talking to each other are not "nobody", so they count
 * too. Not a response: her own lines, bots, reactions, someone joining or leaving, slash commands
 * and the panel.
 */
export function humanResponse(
  event: BusEvent,
  isSelf: (account: AccountRef) => boolean,
): HumanResponse | null {
  if (is(Events.PlatformMessageCreated, event)) {
    const { author, id } = event.data;
    if (author.is_bot || isSelf(author.account)) return null;
    return { context: id.context, account: author.account };
  }
  if (is(Events.VoiceUtteranceEvent, event)) {
    const { speaker, context, text } = event.data;
    if (speaker.is_bot || isSelf(speaker.account) || text.trim() === "") return null;
    return { context, account: speaker.account };
  }
  return null;
}
