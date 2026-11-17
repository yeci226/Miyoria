// The one-off import of `miyoria.toml` into the config plugin (docs/design/v5-data.md §6, §7 step
// 5): the cut-over calls it once, at the first start on the new database. Nothing calls it before:
// until then Core reads the TOML file at start.
//
// - The file becomes config revision 1 (`created_by = 'import'`), as written: env references
//   (`${NAME}`) stay unexpanded, and a file that holds a secret literally is refused (secrets live
//   in the environment, never in the database).
// - The per-channel levels of `[modules.agent]` (`channels`, `activeness`) whose key names a place
//   move to `place_settings` of plugin `agent`: `<platform>:<guild>` is the space, keys `mode` and
//   `activeness`; `<platform>:<guild>:<channel>` the room, same keys; `<platform>:<guild>:voice:
//   <channel>` the same room's voice lane, keys `voice.mode` and `voice.activeness`. Spaces and
//   rooms are created on first sight. A bare channel id names no space and a DM key names no
//   person, so those entries stay in the document, and the result lists them.
// - Module disables remembered before the import (revisions a runtime toggle wrote on a database
//   that never imported) are kept: the imported revision carries them as `enabled = false`.
// - It runs once: when an imported revision exists it writes nothing and returns that one.
// All of it commits in one transaction.

import { parseTomlJson } from "@miyoria/runtime/kernel";
import { isJsonObject, type JsonObject, type JsonValue } from "@miyoria/types";
import { StoreError } from "../common.js";
import type { Db } from "../db.js";
import type { Identity } from "../identity/identity.js";
import type { PlaceSettings } from "./places.js";
import { type ConfigRevision, type ConfigRevisions, moduleFlags } from "./revisions.js";
import type { PlaceScope } from "./schema.js";

/** Who the imported revision and its place settings are written by. */
export const CONFIG_IMPORT_AUTHOR = "import";

/** The plugin the per-channel levels belong to. */
const AGENT = "agent";

/** `[modules.agent]` maps keyed by context, and the place setting each becomes. */
const LEVEL_MAPS = [
  { map: "channels", key: "mode" },
  { map: "activeness", key: "activeness" },
] as const;

/** Key names whose literal value would be a secret. */
const SECRET_KEY = /(^|_)(token|secret|password|passwd|api_key|apikey|stream_key|private_key)$/i;

/** The import refused the file. */
export class ConfigImportError extends StoreError {}

/** One per-channel level that moved to `place_settings`. */
export interface ImportedPlaceSetting {
  /** Where it was in the file: `modules.agent.channels."discord:1:2"`. */
  from: string;
  scope: PlaceScope;
  scope_id: string;
  plugin: string;
  key: string;
  value: JsonValue;
}

export interface ConfigImportResult {
  /** `false`: an earlier import exists, nothing was written. */
  imported: boolean;
  /** The imported revision (this one's, or the earlier one). */
  revision: ConfigRevision;
  places: ImportedPlaceSetting[];
  /** Entries of the level maps that stay in the document, by their path in the file. */
  kept: string[];
}

/** What the import writes through: the config plugin and identity on one database. */
export interface ConfigImportTarget {
  db: Db;
  revisions: ConfigRevisions;
  places: PlaceSettings;
  identity: Identity;
}

export interface ConfigImportOptions {
  /** The revision's note. Default `miyoria.toml`. */
  note?: string;
}

const quote = (key: string) => (/^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key));

/** The paths of string values that hold a secret literally (not as `${NAME}`). */
function literalSecrets(value: JsonValue, path: string, out: string[]): string[] {
  if (Array.isArray(value)) {
    value.forEach((v, i) => {
      literalSecrets(v, `${path}[${i}]`, out);
    });
  } else if (isJsonObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const here = path === "" ? quote(k) : `${path}.${quote(k)}`;
      if (typeof v === "string" && SECRET_KEY.test(k) && v !== "" && !v.includes("${")) {
        out.push(here);
      } else {
        literalSecrets(v, here, out);
      }
    }
  }
  return out;
}

type ParsedPlace =
  | { scope: "space"; platform: string; space: string }
  | { scope: "room"; platform: string; space: string; room: string; voice: boolean };

/** The place a `[modules.agent]` level key names, or `null` for one that names none. */
function placeOf(contextKey: string): ParsedPlace | null {
  const parts = contextKey.split(":");
  if (parts.some((p) => p === "")) return null;
  const [platform, space] = parts as [string, string];
  if (parts.length < 2 || space === "dm") return null;
  if (parts.length === 2) return { scope: "space", platform, space };
  if (parts.length === 3) {
    return { scope: "room", platform, space, room: parts[2] as string, voice: false };
  }
  if (parts.length === 4 && parts[2] === "voice") {
    return { scope: "room", platform, space, room: parts[3] as string, voice: true };
  }
  return null;
}

/**
 * Imports the text of `miyoria.toml` (see the file comment). Throws a `ConfigImportError` for a
 * file that holds a secret literally, and the TOML parser's `ConfigError` for one that is not TOML.
 */
export function importConfigToml(
  target: ConfigImportTarget,
  text: string,
  options: ConfigImportOptions = {},
): ConfigImportResult {
  const doc = parseTomlJson(text);
  const secrets = literalSecrets(doc, "", []);
  if (secrets.length > 0) {
    throw new ConfigImportError(
      `the config holds secrets as text at ${secrets.map((s) => `\`${s}\``).join(", ")}: ` +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the message names the ${NAME} syntax
        "move each to the environment (.env) and write `${NAME}` in their place",
    );
  }
  const { db, revisions, places, identity } = target;
  return db.tx(() => {
    const earlier = revisions
      .history()
      .filter((r) => r.created_by === CONFIG_IMPORT_AUTHOR)
      .at(-1);
    if (earlier !== undefined) return { imported: false, revision: earlier, places: [], kept: [] };

    const moved: ImportedPlaceSetting[] = [];
    const kept: string[] = [];
    const modules = isJsonObject(doc.modules ?? null) ? (doc.modules as JsonObject) : null;
    const agent =
      modules !== null && isJsonObject(modules.agent ?? null)
        ? (modules.agent as JsonObject)
        : null;
    for (const { map, key } of LEVEL_MAPS) {
      const levels = agent?.[map];
      if (agent === null || !isJsonObject(levels ?? null)) continue;
      const entries = levels as JsonObject;
      for (const [contextKey, value] of Object.entries(entries)) {
        const from = `modules.agent.${map}.${quote(contextKey)}`;
        const place = placeOf(contextKey);
        if (place === null) {
          kept.push(from);
          continue;
        }
        const scopeId =
          place.scope === "space"
            ? identity.ensureSpace(place.platform, place.space)
            : identity.ensureRoom(
                place.platform,
                place.space,
                place.room,
                place.voice ? "voice" : "text",
              ).id;
        const settingKey = place.scope === "room" && place.voice ? `voice.${key}` : key;
        places.set(place.scope, scopeId, AGENT, settingKey, value, CONFIG_IMPORT_AUTHOR);
        moved.push({
          from,
          scope: place.scope,
          scope_id: scopeId,
          plugin: AGENT,
          key: settingKey,
          value,
        });
        delete entries[contextKey];
      }
      if (Object.keys(entries).length === 0) delete agent[map];
    }

    // Disables a runtime toggle remembered before the import stay disables.
    const disabled = [...moduleFlags(revisions.current()?.doc)]
      .filter(([, enabled]) => !enabled)
      .map(([id]) => id);
    if (disabled.length > 0) {
      const all = modules ?? {};
      for (const id of disabled) {
        const section = all[id];
        all[id] = {
          ...(isJsonObject(section ?? null) ? (section as JsonObject) : {}),
          enabled: false,
        };
      }
      doc.modules = all;
    }

    const revision = revisions.write(doc, CONFIG_IMPORT_AUTHOR, {
      note: options.note ?? "miyoria.toml",
    });
    return { imported: true, revision, places: moved, kept };
  });
}
