// The data categories as the store's own schemas declare them (`data.ts`): the event log, the
// `identity`, `config`, `artifact` and `legacy` tables and the settings key families. Every store
// has these; a store adds the declarations of the plugins it has installed (`StorePlugin.data`),
// listed after its own tables and before the settings families (`storeRegistry`).
//
// `DATA_CATEGORIES` is that list without any plugin: the categories by id with the store's own
// parts. What a plugin holds is counted, exported and deleted only where it is installed.

import { artifactData } from "./artifacts/data.js";
import { configData, settingsData } from "./config/data.js";
import { type CategoryData, type DataCategory, type DataCategoryId, DataRegistry } from "./data.js";
import { eventsData } from "./events/data.js";
import { identityData } from "./identity/data.js";
import { legacyData } from "./legacy-schema/data.js";

/** The store's own tables' parts, in the order a category lists them. */
export const STORE_DATA: readonly CategoryData[] = [
  ...eventsData,
  ...identityData,
  ...configData,
  ...artifactData,
  ...legacyData,
];

/** The registry of a store with the plugins that declare `plugins`, in the order given. */
export function storeRegistry(plugins: readonly CategoryData[] = []): DataRegistry {
  return new DataRegistry([...STORE_DATA, ...plugins, ...settingsData]);
}

const STORE = storeRegistry();

/** Every category, in display order, with the parts of the store's own schemas. */
export const DATA_CATEGORIES: readonly DataCategory[] = STORE.categories;

/** A category with the parts of the store's own schemas. */
export function dataCategory(id: DataCategoryId): DataCategory {
  return STORE.category(id);
}
