// The import of `miyoria.toml` into the config plugin (docs/design/v5-data.md §6, §7 step 5;
// docs/design/v5-settings.md §13): `miyoria config import` runs it by hand, after a backup. Nothing
// calls it at boot: until then (and after, for `[core]`) Core reads the TOML file at start.
//
// - The file becomes the next config revision (`created_by = 'import'`), as written: env references
//   (`${NAME}`) stay unexpanded (Core's settings layer expands them like the file's), and a file
//   that holds a secret literally is refused (secrets live in the environment, never in the
//   database).
// - Merged with the current revision: each key the panel set (`modules.<id>.*` besides `enabled`)
//   is laid over the file's, so what the panel changed stays what the module runs with. Module
//   disables remembered before the import (a runtime toggle) are kept as `enabled = false`.
//   `replace` writes the file as it is instead (the panel's keys are dropped; the revisions keep
//   them), and is the only way to import again once an import exists: without it a second run
//   writes nothing and returns the earlier import.
// - The per-channel levels of `[modules.agent]` (`channels`, `activeness`) whose key names a place
//   move to `place_settings` of plugin `agent`: `<platform>:<guild>` is the space, keys `mode` and
//   `activeness_level` (the names the agent reads); `<platform>:<guild>:<channel>` the room, same keys; `<platform>:<guild>:voice:
//   <channel>` the same room's voice lane, keys `voice.mode` and `voice.activeness_level`. Spaces and
//   rooms are created on first sight. A bare channel id names no space and a DM key names no
//   person, so those entries stay in the document, and the result lists them.
// - Channel fields that may differ per server (`spaceChannels`, from the modules' schemas) are
//   copied from the cluster value into the place setting of the Space that owns each channel: a
//   context key names its server, a bare id is looked up in identity's rooms. The cluster value
//   stays (the channel rule keeps it from reaching another server). A channel no one knows stays
//   only at cluster level.
// - A place that already has its own value for a key keeps it, unless `replace`.
// - `dryRun` works it all out and writes nothing.
// All of it commits in one transaction.

import { parseTomlJson } from "@miyoria/runtime/kernel";
import { isJsonObject, type JsonObject, type JsonValue, toTimestamp } from "@miyoria/types";
import { and, eq, isNotNull } from "drizzle-orm";
import { StoreError } from "../common.js";
import type { Db } from "../db.js";
import type { Identity } from "../identity/identity.js";
import { rooms, spaces } from "../identity/schema.js";
import type { PlaceSettings } from "./places.js";
import {
  type ConfigRevision,
  type ConfigRevisions,
  changedPaths,
  moduleFlags,
} from "./revisions.js";
import type { PlaceScope } from "./schema.js";

/** Who the imported revision and its place settings are written by. */
export const CONFIG_IMPORT_AUTHOR = "import";

/** The plugin the per-channel levels belong to. */
const AGENT = "agent";

/** `[modules.agent]` maps keyed by context, and the place setting each becomes. */
const LEVEL_MAPS = [
  { map: "channels", key: "mode" },
  { map: "activeness", key: "activeness_level" },
] as const;

/** Key names whose literal value would be a secret. */
const SECRET_KEY = /(^|_)(token|secret|password|passwd|api_key|apikey|stream_key|private_key)$/i;

/** The import refused the file. `secrets` names the paths that hold a secret as text. */
export class ConfigImportError extends StoreError {
  readonly secrets: readonly string[];

  constructor(message: string, secrets: readonly string[] = []) {
    super(message);
    this.secrets = secrets;
  }
}

/** One setting that moved (or was copied) to `place_settings`. */
export interface ImportedPlaceSetting {
  /** Where it was in the file: `modules.agent.channels."discord:1:2"`. */
  from: string;
  scope: PlaceScope;
  scope_id: string;
  plugin: string;
  key: string;
  value: JsonValue;
}

/** A place setting the import works out, before anything is created. */
export interface PlannedPlaceSetting {
  from: string;
  scope: PlaceScope;
  /** The place as the platform names it: `discord:<guild>` or `discord:<guild>:<channel>`. */
  place: string;
  /** Identity's id when the place exists already; `null` when the import would create it. */
  scope_id: string | null;
  plugin: string;
  key: string;
  value: JsonValue;
  /** The place's own value now; `null` when it has none. */
  current: JsonValue | null;
  /** `write`: it is written; `keep`: the place keeps its own value (no `replace`). */
  action: "write" | "keep";
}

/** A channel field that may differ per server: copied into the owning Space's place setting. */
export interface SpaceChannelField {
  module: string;
  /** Path in the module's section; dotted it is the place setting's key. */
  keys: readonly string[];
  /** How the field stores a channel: a bare id, or a context key. */
  ref: "id" | "context";
}

export interface ConfigImportResult {
  /** `false`: nothing was written (an earlier import exists, or a dry run). */
  imported: boolean;
  /** The imported revision (this one's, or the earlier one); for a dry run, the one it would write (not stored). */
  revision: ConfigRevision;
  places: ImportedPlaceSetting[];
  /** Entries of the level maps that stay in the document, by their path in the file. */
  kept: string[];
  /** Set when the import was worked out (not for a second run without `replace`). */
  plan?: ConfigImportPlan;
}

/** Everything an import would do, for a dry run's report. */
export interface ConfigImportPlan {
  dry_run: boolean;
  replace: boolean;
  /** The current revision the import starts from (`null`: none yet). */
  base: number | null;
  /** The document of the new revision. */
  doc: JsonObject;
  /** The paths that differ from the current revision's document. */
  changed: string[];
  /** The panel's keys laid over the file's (`modules.<id>.<path>`); none with `replace`. */
  panel: string[];
  places: PlannedPlaceSetting[];
  /** Level-map entries that stay in the document. */
  kept: string[];
  /** Channel values of `spaceChannels` that no known Space owns, by their path: they stay at cluster level. */
  unplaced: string[];
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
  /** Write the file as it is, not merged with the panel's keys; also after an earlier import. */
  replace?: boolean;
  /** Work it out and write nothing. */
  dryRun?: boolean;
  /** Channel fields that may differ per server, to copy into the Space owning each channel. */
  spaceChannels?: readonly SpaceChannelField[];
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

const same = (a: JsonValue | undefined, b: JsonValue | undefined) =>
  JSON.stringify(a) === JSON.stringify(b);

function objectAt(doc: JsonObject, key: string): JsonObject | null {
  const value = doc[key];
  return isJsonObject(value ?? null) ? (value as JsonObject) : null;
}

function valueAt(doc: JsonValue | undefined, keys: readonly string[]): JsonValue | undefined {
  let at = doc;
  for (const key of keys) at = isJsonObject(at ?? null) ? (at as JsonObject)[key] : undefined;
  return at;
}

function setAt(doc: JsonObject, keys: readonly string[], value: JsonValue): void {
  let at = doc;
  keys.forEach((key, i) => {
    if (i === keys.length - 1) at[key] = value;
    else {
      const next = objectAt(at, key) ?? {};
      at[key] = next;
      at = next;
    }
  });
}

/** Every leaf of an object (a value that is not a non-empty object), with its keys. */
function leaves(value: JsonValue, prefix: string[] = []): [string[], JsonValue][] {
  if (!isJsonObject(value)) return prefix.length === 0 ? [] : [[prefix, value]];
  const out: [string[], JsonValue][] = [];
  for (const [key, child] of Object.entries(value)) {
    if (isJsonObject(child) && Object.keys(child).length > 0)
      out.push(...leaves(child, [...prefix, key]));
    else if (!isJsonObject(child)) out.push([[...prefix, key], child]);
  }
  return out;
}

/** A place before it is created: how to create it, and its id when it exists. */
interface PlaceRef {
  scope: PlaceScope;
  label: string;
  id: string | null;
  create: () => string;
}

/** Identity's rows, read without creating anything; `create` makes the place at apply time. */
function places(db: Db, identity: Identity) {
  const spaceId = (platform: string, guild: string): string | null =>
    db.orm
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.platform, platform), eq(spaces.external_id, guild)))
      .get()?.id ?? null;
  const roomId = (platform: string, channel: string): string | null =>
    db.orm
      .select({ id: rooms.id })
      .from(rooms)
      .where(and(eq(rooms.platform, platform), eq(rooms.external_id, channel)))
      .get()?.id ?? null;
  return {
    space(platform: string, guild: string): PlaceRef {
      return {
        scope: "space",
        label: `${platform}:${guild}`,
        id: spaceId(platform, guild),
        create: () => identity.ensureSpace(platform, guild),
      };
    },
    room(platform: string, guild: string, channel: string, voice: boolean): PlaceRef {
      return {
        scope: "room",
        label: `${platform}:${guild}:${channel}`,
        id: roomId(platform, channel),
        create: () => identity.ensureRoom(platform, guild, channel, voice ? "voice" : "text").id,
      };
    },
    /** The one Space a bare channel id is in, from identity's rooms; `null` when none or several. */
    channelOwner(channel: string): PlaceRef | null {
      const found = db.orm
        .selectDistinct({
          id: rooms.space_id,
          platform: spaces.platform,
          guild: spaces.external_id,
        })
        .from(rooms)
        .innerJoin(spaces, eq(spaces.id, rooms.space_id))
        .where(and(eq(rooms.external_id, channel), isNotNull(rooms.space_id)))
        .all();
      const [only] = found;
      if (found.length !== 1 || only === undefined || only.id === null) return null;
      const id = only.id;
      return { scope: "space", label: `${only.platform}:${only.guild}`, id, create: () => id };
    },
  };
}

interface Planned {
  plan: ConfigImportPlan;
  /** The planned place settings with how to reach each place. */
  writes: { planned: PlannedPlaceSetting; place: PlaceRef }[];
}

/** Works the import out against the database as it is; writes nothing. */
function planImport(
  target: ConfigImportTarget,
  doc: JsonObject,
  options: ConfigImportOptions,
): Planned {
  const { revisions, places: settings, db, identity } = target;
  const replace = options.replace === true;
  const current = revisions.current();
  const lookup = places(db, identity);
  /** `doc.modules`, made when the file has none. */
  const modulesOf = (): JsonObject => {
    const all = objectAt(doc, "modules") ?? {};
    doc.modules = all;
    return all;
  };

  // The panel's keys over the file's (not with `replace`).
  const panel: string[] = [];
  const currentModules = objectAt(current?.doc ?? {}, "modules") ?? {};
  if (!replace) {
    for (const [id, section] of Object.entries(currentModules)) {
      if (!isJsonObject(section)) continue;
      const { enabled: _, ...layer } = section;
      for (const [keys, value] of leaves(layer)) {
        const all = modulesOf();
        const own = objectAt(all, id) ?? {};
        all[id] = own;
        if (!same(valueAt(own, keys), value)) {
          panel.push(`modules.${quote(id)}.${keys.map(quote).join(".")}`);
        }
        setAt(own, keys, value);
      }
    }
  }
  // Disables a runtime toggle remembered before the import stay disables.
  const disabled = [...moduleFlags(current?.doc)].filter(([, on]) => !on).map(([id]) => id);
  if (disabled.length > 0) {
    const all = modulesOf();
    for (const id of disabled) all[id] = { ...(objectAt(all, id) ?? {}), enabled: false };
  }

  const writes: Planned["writes"] = [];
  const plan = (
    from: string,
    place: PlaceRef,
    plugin: string,
    key: string,
    value: JsonValue,
  ): void => {
    const own = place.id === null ? null : settings.get(place.scope, place.id, plugin, key);
    const action = own === null || replace ? "write" : "keep";
    writes.push({
      planned: {
        from,
        scope: place.scope,
        place: place.label,
        scope_id: place.id,
        plugin,
        key,
        value,
        current: own?.value ?? null,
        action,
      },
      place,
    });
  };

  // The agent's per-channel levels.
  const kept: string[] = [];
  const agent = objectAt(objectAt(doc, "modules") ?? {}, AGENT);
  for (const { map, key } of LEVEL_MAPS) {
    const levels = agent === null ? null : objectAt(agent, map);
    if (agent === null || levels === null) continue;
    for (const [contextKey, value] of Object.entries(levels)) {
      const from = `modules.agent.${map}.${quote(contextKey)}`;
      const parsed = placeOf(contextKey);
      if (parsed === null) {
        kept.push(from);
        continue;
      }
      const place =
        parsed.scope === "space"
          ? lookup.space(parsed.platform, parsed.space)
          : lookup.room(parsed.platform, parsed.space, parsed.room, parsed.voice);
      const settingKey = parsed.scope === "room" && parsed.voice ? `voice.${key}` : key;
      plan(from, place, AGENT, settingKey, value);
      delete levels[contextKey];
    }
    if (Object.keys(levels).length === 0) delete agent[map];
  }

  // Channel fields that may differ per server: into the Space that owns each channel.
  const unplaced: string[] = [];
  for (const field of options.spaceChannels ?? []) {
    const section = objectAt(objectAt(doc, "modules") ?? {}, field.module);
    const value = section === null ? undefined : valueAt(section, field.keys);
    if (value === undefined || value === "" || value === null) continue;
    const from = `modules.${quote(field.module)}.${field.keys.map(quote).join(".")}`;
    const list = Array.isArray(value) ? value : [value];
    const bySpace = new Map<string, { place: PlaceRef; values: JsonValue[] }>();
    for (const item of list) {
      if (typeof item !== "string" || item === "" || item.includes("${")) {
        if (item !== "") unplaced.push(`${from} = ${JSON.stringify(item)}`);
        continue;
      }
      let place: PlaceRef | null = null;
      if (field.ref === "context" || item.includes(":")) {
        const [platform, guild] = item.split(":");
        if (platform && guild && guild !== "dm") place = lookup.space(platform, guild);
      } else {
        place = lookup.channelOwner(item);
      }
      if (place === null) {
        unplaced.push(`${from} = ${JSON.stringify(item)}`);
        continue;
      }
      const entry = bySpace.get(place.label) ?? { place, values: [] };
      entry.values.push(item);
      bySpace.set(place.label, entry);
    }
    for (const { place, values } of bySpace.values()) {
      const placed: JsonValue = Array.isArray(value) ? values : (values[0] as JsonValue);
      plan(from, place, field.module, field.keys.join("."), placed);
    }
  }

  return {
    plan: {
      dry_run: options.dryRun === true,
      replace,
      base: current?.version ?? null,
      doc,
      changed: changedPaths(current?.doc, doc),
      panel,
      places: writes.map((w) => w.planned),
      kept,
      unplaced,
    },
    writes,
  };
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
      secrets,
    );
  }
  const { db, revisions, places } = target;
  return db.tx(() => {
    const earlier = revisions
      .history()
      .filter((r) => r.created_by === CONFIG_IMPORT_AUTHOR)
      .at(0);
    if (earlier !== undefined && options.replace !== true) {
      return { imported: false, revision: earlier, places: [], kept: [] };
    }
    const { plan, writes } = planImport(target, doc, options);
    if (plan.dry_run) {
      // The revision it would write, not stored.
      const preview: ConfigRevision = {
        version: (plan.base ?? 0) + 1,
        doc: plan.doc,
        created_at: toTimestamp(db.clock.now()),
        created_by: CONFIG_IMPORT_AUTHOR,
        note: options.note ?? "miyoria.toml",
      };
      return { imported: false, revision: preview, places: [], kept: plan.kept, plan };
    }
    const moved: ImportedPlaceSetting[] = [];
    for (const { planned, place } of writes) {
      if (planned.action !== "write") continue;
      const scopeId = place.create();
      places.set(
        place.scope,
        scopeId,
        planned.plugin,
        planned.key,
        planned.value,
        CONFIG_IMPORT_AUTHOR,
      );
      moved.push({
        from: planned.from,
        scope: planned.scope,
        scope_id: scopeId,
        plugin: planned.plugin,
        key: planned.key,
        value: planned.value,
      });
    }
    const revision = revisions.write(plan.doc, CONFIG_IMPORT_AUTHOR, {
      note: options.note ?? "miyoria.toml",
    });
    return { imported: true, revision, places: moved, kept: plan.kept, plan };
  });
}
