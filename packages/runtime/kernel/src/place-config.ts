// A module's config resolved per place (docs/design/v5-places.md): `placeConfig(ctx, Schema)` reads
// which fields may differ per Space or Room from the schema's `setting({...})` meta and asks Core's
// `PlaceConfigKey` service for the resolver. Without the service (a unit test, a node without a
// store) every place gets the cluster value, so a module written against it runs anywhere.
//
//     const cfg = placeConfig(ctx, MarketConfigSchema);
//     const channel = cfg.for({ space_id }).auction_channel;   // read where it is used
//     ctx.spawn("watch", async () => { cfg.onChange(() => reschedule()); ... });

import {
  type JsonValue,
  type PlaceConfig,
  type PlaceConfigChange,
  PlaceConfigKey,
  type PlaceField,
} from "@miyoria/types";
import type { z } from "zod";
import { parseSection } from "./config.js";
import { configJsonSchema } from "./config-schema.js";
import type { ModuleContext } from "./context.js";
import { type SettingField, settingFields } from "./settings.js";

/** The fields of a schema that may differ per place (`scope: "space" | "room"`), secrets never. */
export function placeFields(schema: z.ZodType): PlaceField[] {
  return settingFields(configJsonSchema(schema)).fields.flatMap((f: SettingField) =>
    f.scope === "cluster" || f.secret
      ? []
      : [
          {
            keys: [...f.keys],
            scope: f.scope,
            merge: f.merge,
            channel: f.kind === "channel" ? { ref: f.ref, multiple: f.multiple } : null,
          },
        ],
  );
}

/** Every place gets `value`: what a module sees without Core's service. */
export function fixedPlaceConfig<T>(value: T): PlaceConfig<T> {
  return {
    base: () => value,
    for: () => value,
    onChange: (_listener: (change: PlaceConfigChange) => void) => () => {},
  };
}

/**
 * The module's section (`[modules.<id>]`, as `ctx.config(schema)` reads it) resolved per place.
 * Call it in `start`: it throws `ConfigError` like `ctx.config` when the section does not fit.
 */
export function placeConfig<S extends z.ZodType>(
  ctx: ModuleContext,
  schema: S,
): PlaceConfig<z.output<S>> {
  const path = `modules.${ctx.id}`;
  const parse = (section: JsonValue | null): z.output<S> =>
    parseSection(schema, section ?? undefined, path);
  const base = parse(ctx.rawConfig);
  const service = ctx.services.get(PlaceConfigKey);
  const fields = service === undefined ? [] : placeFields(schema);
  if (service === undefined || fields.length === 0) return fixedPlaceConfig(base);
  return service.open({
    module: ctx.id,
    section: ctx.rawConfig,
    fields,
    parse,
    signal: ctx.signal,
  });
}
