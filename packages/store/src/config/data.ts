// The `config` plugin's parts of the data categories (`data.ts`): the runtime persona edits
// (`persona`), the modules' on/off flags (`module_state`), and the settings key families of
// `plugin_state` (`settingsData`).
//
// Settings keys belong to other packages that have no tables of their own yet; they are repeated
// here as strings (the store cannot depend on the modules), and `@miyoria/api`'s tests check them
// against the owners' constants. They are rows of plugin `settings` in `plugin_state`
// (`state.ts`): one key space, whatever profile their owners write them under, since one database
// belongs to one character. A store lists them after every plugin's parts, so a category's table
// parts come first.

import { type CategoryData, settingsPart, tablePart } from "../data.js";

export const configData: readonly CategoryData[] = [
  // One database is one character, so every edit is this profile's.
  {
    category: "persona",
    parts: [
      tablePart(
        "persona_overrides",
        "config_persona_overrides",
        "node",
        "edited_at",
        "section_key, version",
        {
          section_key: "text",
          version: "num",
          body: "text",
          edited_by: "text",
          edited_at: "ts",
        },
      ),
    ],
  },
  // Module on/off, remembered across restarts: the `enabled` flags of the current config revision.
  { category: "module_state", parts: [{ kind: "module_flags", id: "module_state" }] },
];

export const settingsData: readonly CategoryData[] = [
  // @miyoria/memory/memory `MAINTENANCE_KEY`
  {
    category: "memories",
    parts: [settingsPart("memory_maintenance", "active", ["memory_maintenance_last"])],
  },
  {
    category: "inner",
    // @miyoria/heart/self `STATE_KEY`, `FEELING_PREFIX`; @miyoria/heart/mind's thought journal and
    // its digests (`THOUGHT_PREFIX`, `DIGEST_PREFIX`), her goals and plan state (`GOAL_PREFIX`,
    // `GOAL_MIGRATION_KEY` and `PLAN_STATE_KEY` under `mind:plan:`)
    parts: [
      settingsPart("self_state", "active", ["self:state"]),
      settingsPart("self_feelings", "active", [], ["self:feeling:"]),
      settingsPart("self_cards_migration", "active", ["self:cards:migration"]),
      settingsPart("mind_thoughts", "active", [], ["mind:thought:"]),
      settingsPart("mind_digests", "active", [], ["mind:digest:"]),
      settingsPart("mind_goals", "active", [], ["mind:goal:", "mind:plan:"]),
    ],
  },
  // @miyoria/memory/learning `DOC_PREFIX`: her self-organized documents, whatever their shape.
  {
    category: "knowledge",
    parts: [settingsPart("knowledge_docs", "active", [], ["knowledge:doc:"])],
  },
  // @miyoria/memory/learning `LESSON_PREFIX`, `RUN_PREFIX`, `REFLECT_STATE_KEY`, `FEEDBACK_PREFIX`
  {
    category: "learning",
    parts: [
      settingsPart("lessons", "active", [], ["reflect:lesson:"]),
      settingsPart("reflections", "active", ["reflect:state"], ["reflect:run:"]),
      settingsPart("feedback", "active", [], ["feedback:day:"]),
    ],
  },
  // @miyoria/memory/learning `STATE_PREFIX`: her running notes on each conversation (from the log).
  {
    category: "conversation",
    parts: [settingsPart("conversation_states", "active", [], ["conversation:state:"])],
  },
  // The saved mood of the removed `mood` module (`@miyoria/heart/self` `migrate.ts` reads it).
  { category: "mood", parts: [settingsPart("mood", "active", ["mood:last"])] },
  // @miyoria/memory/memory `WATERMARK_PREFIX`: only ever together with the log.
  {
    category: "messages",
    parts: [settingsPart("memory_watermarks", "active", [], ["memory_watermark:"])],
  },
  // @miyoria/brain/arbiter `STATE_KEY` under `STATE_PROFILE` (her ledger: counters, backoff,
  // topics, greetings), and the old @miyoria/initiative state it replaced
  {
    category: "initiative",
    parts: [settingsPart("initiative", "global", ["arbiter:state", "initiative:state"])],
  },
  // V4 kept handles in settings (`handle:<platform>:<id>` under `_global`); a settings store that
  // is not this database's (tests, fallbacks) still does.
  { category: "people", parts: [settingsPart("handles", "global", [], ["handle:"])] },
  // @miyoria/brain/agent `MODE_PREFIX`, `ACTIVENESS_PREFIX`
  {
    category: "channels",
    parts: [
      settingsPart("channel_modes", "active", [], ["channel_mode:"]),
      settingsPart("channel_activeness", "active", [], ["activeness:"]),
    ],
  },
  // @miyoria/voice/voice `consentKey` under `CONSENT_PROFILE`, and @miyoria/types
  // `PRIVACY_PREFIX` under `PRIVACY_PROFILE`: owners still read and write these settings keys,
  // and the store keeps them in `persons.prefs` (`PrefsSettings`). The settings parts claim the
  // keys, so no stray row counts as `other_settings`.
  {
    category: "voice_consent",
    parts: [settingsPart("voice_consent_keys", "global", [], ["voice_consent:"])],
  },
  { category: "privacy", parts: [settingsPart("privacy_keys", "global", [], ["privacy:"])] },
  // @miyoria/play/queue `STATE_KEY` under `STATE_PROFILE`
  { category: "queue", parts: [settingsPart("queue", "global", ["queue:state"])] },
  // @miyoria/workspace/sandbox `TOOL_KEY_PREFIX`
  {
    category: "proposed_tools",
    parts: [settingsPart("proposed_tools", "active", [], ["sandbox:tool:"])],
  },
  // @miyoria/plugin-host/ext-host `storageKey`
  { category: "extensions", parts: [settingsPart("extension_storage", "active", [], ["ext:"])] },
  { category: "other_settings", parts: [{ kind: "other_settings", id: "other_settings" }] },
  // The API still writes the panel's logins as settings (`@miyoria/api` `STORE_PREFIX` under
  // `STORE_PROFILE`), which the auth plugin routes to its table; a store without it keeps them as
  // settings rows, which this part claims.
  {
    category: "panel_sessions",
    parts: [settingsPart("panel_session_keys", "global", [], ["panel_session:"])],
  },
];
