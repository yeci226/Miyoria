// Her persona sections and their edit history, and which profile this Core runs.

import { z } from "zod";
import { TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";

/** One persona section, from `GET /api/persona`. */
export const PersonaSectionInfoSchema = z
  .object({ key: z.string(), body: z.string() })
  .meta({ id: "ApiPersonaSectionInfo" });
export type PersonaSectionInfo = z.output<typeof PersonaSectionInfoSchema>;

/** Body of `PUT /api/persona/{key}`. */
export const SetPersonaRequestSchema = z
  .object({
    body: z.string(),
    /** Defaults to the caller (`"api"` for the token). */
    edited_by: z.string().nullish(),
  })
  .meta({ id: "ApiSetPersonaRequest" });
export type SetPersonaRequest = z.input<typeof SetPersonaRequestSchema>;

/** Answer of `PUT /api/persona/{key}`. */
export const SetPersonaResponseSchema = z
  .object({ key: z.string(), version: z.number().int() })
  .meta({ id: "ApiSetPersonaResponse" });
export type SetPersonaResponse = z.output<typeof SetPersonaResponseSchema>;

/** One version of a persona section override. */
export const PersonaOverrideSchema = z
  .object({
    profile: z.string(),
    /** Persona section, e.g. `"identity"` or `"style"`. */
    key: z.string(),
    /** Starts at 1 and increases by 1 per edit of the same section. */
    version: z.number().int(),
    body: z.string(),
    /** Who made the edit, e.g. `"panel:owen"` or `"discord:1234"`. */
    edited_by: z.string(),
    edited_at: TimestampSchema,
  })
  .meta({ id: "ApiPersonaOverride" });
export type PersonaOverride = z.output<typeof PersonaOverrideSchema>;

/**
 * `GET /api/profile`: which profile this Core runs (docs/design/v5-profiles.md), for the panel's
 * one-line indicator. Switching is stopping the Core and starting it on another; no route does it.
 */
export const RunningProfileSchema = z
  .object({
    /** The profile's folder name. */
    id: z.string(),
    /** It has its own config and data; `false`: it runs on the install's. */
    own: z.boolean(),
    /** Her name (`[character] name`). */
    character: z.string(),
    /** The persona's display name. */
    persona: z.string(),
  })
  .meta({ id: "ApiRunningProfile" });
export type RunningProfile = z.output<typeof RunningProfileSchema>;

/** A section key; the server answers 400 for one that is not letters, digits, `-` or `_`. */
const SectionParams = z.object({ key: z.string() });

export const persona = {
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/persona" })
    .output(z.array(PersonaSectionInfoSchema)),
  /** Replaces a section and records the edit; the new text is live from the next turn. */
  set: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "PUT", path: "/api/persona/{key}" })
    .input(z.object({ params: SectionParams, body: SetPersonaRequestSchema }))
    .output(SetPersonaResponseSchema),
  /** Every stored version of a section, oldest first. */
  history: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/persona/{key}/history" })
    .input(z.object({ params: SectionParams }))
    .output(z.array(PersonaOverrideSchema)),
  /** Which profile runs. */
  profile: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/profile" })
    .output(RunningProfileSchema),
};
