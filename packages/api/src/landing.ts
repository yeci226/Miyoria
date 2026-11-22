// The profile's front page and its words for the panel (docs/design/v5-profiles.md §8).
//
// * `GET /api/public/landing`: which front page this profile has, and its content when it is its
//   own (`{"kind": "builtin"}`, `{"kind": "plain", name, line}`, `{"kind": "own", name, line,
//   cover, sections}`). Plain text only; picture fields are paths of the route below.
// * `GET /api/public/landing/files/{name}`: one picture of the profile's own page. Only a name the
//   page uses is served, and only under the same rules the loader checked (`LANDING_FILE`: a plain
//   name with a picture's extension, a regular file directly in the folder, never a link, at most
//   `LANDING_FILE_MAX_BYTES`), with `nosniff` and the type its extension says.
//
// Both are open to anyone while the public side is on, like the pages they draw.
//
// `worldOf` is what the served HTML tells the panel (`<meta name="miyoria:world">`): the coins'
// name, the exchange's name, the pronoun, the persona's name and the landing kind. It is `null`
// when every one of them is the first character's, so the default install's page is unchanged.

import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { LANDING_FILE, landingPicture } from "@miyoria/runtime/profile";
import {
  CharacterKey,
  CurrencyKey,
  DEFAULT_CHARACTER,
  DEFAULT_CURRENCY,
  DEFAULT_LANDING,
  type LandingKind,
  type ProfileLanding,
  ProfileLandingKey,
  RunningProfileKey,
} from "@miyoria/types";
import { json, param, type Route } from "./route.js";
import type { ApiState } from "./state.js";

/** The words the panel reads from the page; every field set when the tag is there at all. */
export interface PanelWorld {
  currency: string;
  exchange_name: string;
  pronoun: string;
  persona: string;
  landing: LandingKind;
}

/** The persona's display name of the first character (`profiles/deepseek-chan/profile.toml`). */
export const DEFAULT_PERSONA = "DeepSeek-chan";

/** The first character's words: no tag is written for these. */
export const DEFAULT_WORLD: Readonly<PanelWorld> = Object.freeze({
  currency: DEFAULT_CURRENCY,
  exchange_name: DEFAULT_CHARACTER.exchange_name,
  pronoun: DEFAULT_CHARACTER.pronoun,
  persona: DEFAULT_PERSONA,
  landing: "builtin",
});

const LANDING_PATH = "/api/public/landing";
const FILES_PATH = `${LANDING_PATH}/files`;

function landingOf(state: ApiState): ProfileLanding {
  return state.optional(ProfileLandingKey) ?? DEFAULT_LANDING;
}

/** The running profile's words for the panel, or `null` when they are all the defaults. */
export function worldOf(state: ApiState): PanelWorld | null {
  const her = state.optional(CharacterKey) ?? DEFAULT_CHARACTER;
  const world: PanelWorld = {
    currency: state.optional(CurrencyKey) ?? DEFAULT_CURRENCY,
    exchange_name: her.exchange_name,
    pronoun: her.pronoun,
    persona: state.optional(RunningProfileKey)?.persona || DEFAULT_PERSONA,
    landing: landingOf(state).kind,
  };
  const same = (Object.keys(DEFAULT_WORLD) as (keyof PanelWorld)[]).every(
    (k) => world[k] === DEFAULT_WORLD[k],
  );
  return same ? null : world;
}

/** The plain page's line: what the site's description says of her. */
export function plainLine(name: string): string {
  return `${name} 是住在 Discord 和直播裡的 AI VTuber。`;
}

const fileUrl = (name: string | null): string | null =>
  name === null ? null : `${FILES_PATH}/${encodeURIComponent(name)}`;

/** `GET /api/public/landing`'s body. */
export function landingBody(state: ApiState): Record<string, unknown> {
  const landing = landingOf(state);
  const name = (state.optional(CharacterKey) ?? DEFAULT_CHARACTER).name;
  if (landing.kind === "builtin") return { kind: "builtin" };
  if (landing.kind === "plain") return { kind: "plain", name, line: plainLine(name) };
  const c = landing.content;
  return {
    kind: "own",
    name,
    line: c.line ?? plainLine(name),
    cover: fileUrl(c.cover),
    sections: c.sections.map((s) => ({ title: s.title, text: s.text, image: fileUrl(s.image) })),
  };
}

const TYPES: Readonly<Record<string, string>> = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif",
  ".gif": "image/gif",
};

const notFound = (): Response =>
  new Response("not found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });

/** One picture the profile's own page uses, or a 404. */
async function landingFile(state: ApiState, name: string): Promise<Response> {
  const landing = landingOf(state);
  if (landing.kind !== "own" || !LANDING_FILE.test(name)) return notFound();
  const c = landing.content;
  const used = new Set([c.cover, ...c.sections.map((s) => s.image)]);
  if (!used.has(name)) return notFound();
  // Checked again on every request: the folder may have changed since boot.
  if ((await landingPicture(landing.dir, name)) === null) return notFound();
  const type = TYPES[extname(name).toLowerCase()];
  if (type === undefined) return notFound();
  let bytes: Buffer;
  try {
    bytes = await readFile(join(landing.dir, name));
  } catch {
    return notFound();
  }
  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "content-type": type,
      "content-length": String(bytes.length),
      "cache-control": "public, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}

/** The front page's routes, open to anyone while the public side is on. */
export function landingRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    {
      method: "GET",
      path: LANDING_PATH,
      public: true,
      handler: () => {
        const res = json(landingBody(state));
        res.headers.set("cache-control", "public, max-age=60");
        return res;
      },
    },
    {
      method: "GET",
      path: `${FILES_PATH}/:file`,
      public: true,
      handler: (c) => landingFile(state, param(c, "file")),
    },
  ];
}
