// The one-time move of today's notebook pages and knowledge documents into the notes, run when the
// memory module starts. `importLegacy` is idempotent on its own; the marker only saves the scan of
// every page and document at every later start. The old rows are left as they are.

import type { SettingsStore } from "@miyoria/store";
import { type Clock, isJsonObject, type ProfileId, systemClock, toTimestamp } from "@miyoria/types";
import { KnowledgeConfigSchema } from "../../learning/src/config.js";
import { KnowledgeStore } from "../../learning/src/knowledge.js";
import { type ImportReport, importLegacy, notebookPages } from "./importer.js";
import type { ScopeResolver } from "./scope.js";
import type { NotesStore } from "./store.js";

/** The setting that records the import was done. */
export const LEGACY_IMPORT_KEY = "notes:legacy_import";

export interface LegacyImportDeps {
  notes: NotesStore;
  resolver: ScopeResolver;
  settings: SettingsStore;
  profile: ProfileId;
  clock?: Clock;
}

/**
 * Imports the notebook pages and knowledge documents, once: `null` when an earlier start did it.
 * The marker is written after the import, so one that failed halfway is run again (the keys of
 * the lines it wrote are skipped).
 */
export async function importLegacyOnce(deps: LegacyImportDeps): Promise<ImportReport | null> {
  const { notes, resolver, settings, profile } = deps;
  const clock = deps.clock ?? systemClock;
  if (isJsonObject(await settings.get(profile, LEGACY_IMPORT_KEY))) return null;
  const pages = await notebookPages(settings, profile);
  const documents = new KnowledgeStore(settings, profile, KnowledgeConfigSchema.parse({}), clock);
  await documents.load();
  const report = importLegacy(notes, { pages, knowledge: documents.docs() }, resolver);
  await settings.set(profile, LEGACY_IMPORT_KEY, {
    at: toTimestamp(clock.now()),
    pages: pages.length,
    knowledge: documents.docs().length,
    documents: report.documents,
    added: report.added,
    already: report.already,
    unmapped: report.unmapped.length,
  });
  return report;
}
