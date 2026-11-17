// The event log's parts of the data categories (`data.ts`): the chat lines (`messages`), her
// decisions and turn outcomes (`decisions`), the audit entries and configuration changes
// (`audit`), the LLM calls (`llm_usage`), and the rest of the log with compaction's counts
// (`event_log`). One database is one character, so every row belongs to the profile.
//
// The rest of the log keeps its keep-tier events when it is wiped (`spare`), unless the category
// they record is wiped too: each schema claims its own (`CategoryData.keptEvents`).

import { type CategoryData, tablePart } from "../data.js";
import { AUDIT_TYPES_SQL } from "./audit.js";
import { CHAT_TYPES_SQL } from "./chat.js";
import { LLM_CALL_TYPE_SQL } from "./llm.js";
import { ConfigRevised, PrivacyRedacted, SettingsChanged } from "./types.js";

/** Her decisions among `events` (`turns.ts`). */
const DECISIONS = "type = 'agent.decision'";
/** How her turns ended, among `events` (`turns.ts`). */
const OUTCOMES = "type = 'agent.turn.outcome'";
/** Configuration changes among `events` (`config/revisions.ts`, `config/places.ts`). */
const CONFIG_CHANGES = `type IN ('${ConfigRevised.type}', '${SettingsChanged.type}')`;
/** What the other parts on `events` hold: the rest is `event_log`'s. */
const CLAIMED = [
  CHAT_TYPES_SQL,
  DECISIONS,
  OUTCOMES,
  AUDIT_TYPES_SQL,
  LLM_CALL_TYPE_SQL,
  CONFIG_CHANGES,
];

export const eventsData: readonly CategoryData[] = [
  {
    category: "messages",
    parts: [
      // The chat lines of the event log, exported in the old `message_log` columns (`v_messages`)
      // with their payload.
      tablePart(
        "message_log",
        "events",
        "node",
        "at",
        "seq",
        {
          id: "text",
          type: "text",
          platform: "text",
          scope: "text",
          channel: "text",
          kind: "text",
          author_platform: "text",
          author_id: "text",
          author_name: "text",
          text: "text",
          is_self: "bool",
          ts: "ts",
          turn_id: "text",
          session: "text",
          person_id: "text",
          redacted_at: "ts",
          data: "json",
        },
        { where: CHAT_TYPES_SQL, exportFrom: "v_messages" },
      ),
    ],
    // A redaction's record goes with the lines it was about.
    keptEvents: `type = '${PrivacyRedacted.type}'`,
  },
  {
    category: "decisions",
    parts: [
      // Her decisions and how each turn ended, exported in the old tables' columns
      // (`v_decisions`, and `v_turns`: the latest outcome of each turn) with their place. Counted
      // and deleted as events: a turn whose outcome was written twice counts twice.
      tablePart(
        "decision_log",
        "events",
        "node",
        "at",
        "ts, id",
        { id: "text", ts: "ts", trace: "json", turn: "text", session: "text" },
        { where: DECISIONS, exportFrom: "v_decisions" },
      ),
      tablePart(
        "turn_outcomes",
        "events",
        "node",
        "at",
        "ts, id",
        { id: "text", ts: "ts", outcome: "text", record: "json", session: "text" },
        { where: OUTCOMES, exportFrom: "v_turns" },
      ),
    ],
  },
  {
    // What she perceived, decided and said that no other part holds, and the counts of what
    // compaction removed.
    category: "event_log",
    parts: [
      tablePart(
        "events",
        "events",
        "node",
        "at",
        "seq",
        {
          seq: "num",
          id: "text",
          at: "ts",
          type: "text",
          v: "num",
          source: "text",
          parent: "text",
          turn: "text",
          session: "text",
          space_id: "text",
          room_id: "text",
          person_id: "text",
          account_id: "text",
          scope: "text",
          tier: "text",
          key: "text",
          data: "json",
          redacted_at: "ts",
        },
        { where: `NOT (${CLAIMED.join(" OR ")})`, spare: "tier = 'keep'" },
      ),
      tablePart("event_rollups", "event_rollups", "node", "last_at", "day, type, source", {
        day: "ts",
        type: "text",
        source: "text",
        count: "num",
        first_at: "ts",
        last_at: "ts",
      }),
    ],
  },
  {
    category: "audit",
    parts: [
      // The `audit.*` events, exported in the old `audit_log` columns (`v_audit`).
      tablePart(
        "audit_log",
        "events",
        "node",
        "at",
        "at, id",
        {
          id: "text",
          at: "ts",
          actor: "text",
          action: "text",
          target: "text",
          detail: "json",
          ok: "bool",
        },
        { where: AUDIT_TYPES_SQL, exportFrom: "v_audit" },
      ),
      // Who changed the configuration: a new config revision, a per-place setting.
      tablePart(
        "config_changes",
        "events",
        "node",
        "at",
        "seq",
        { id: "text", at: "ts", type: "text", data: "json" },
        { where: CONFIG_CHANGES },
      ),
    ],
  },
  {
    // Spending, checked against the budget: the `llm.call` events (metadata and cost of each
    // call, never the prompt or the response), exported in columns (`v_llm_calls`) with their
    // payload.
    category: "llm_usage",
    parts: [
      tablePart(
        "llm_calls",
        "events",
        "node",
        "at",
        "seq",
        {
          id: "text",
          at: "ts",
          call_id: "text",
          log_day: "text",
          purpose: "text",
          module: "text",
          model: "text",
          provider: "text",
          status: "text",
          error_kind: "text",
          prompt_tokens: "num",
          completion_tokens: "num",
          cached_prompt_tokens: "num",
          reasoning_tokens: "num",
          cost_usd: "num",
          duration_ms: "num",
          turn: "text",
          data: "json",
        },
        { where: LLM_CALL_TYPE_SQL, exportFrom: "v_llm_calls" },
      ),
    ],
  },
];
