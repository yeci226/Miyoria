// A profile's front page (docs/design/v5-profiles.md §8): `profiles/<id>/landing/landing.json`.
//
//   {"builtin": "miyoria"}                       the first character's hand-made page (the panel's)
//   {"line": "…", "cover": "cover.webp",         a page of her own: plain text, and pictures that
//    "sections": [{"title": "…", "text": "…",    sit beside the file in the same folder
//                  "image": "a.webp"}]}
//
// No file: the plain page built from `[character]`. A file that does not read is reported and the
// plain page is used: the front page is never a reason for Core not to start. Pictures follow the
// static rules the API serves them by (`LANDING_FILE`): a plain name of letters, digits, `-` and
// `_` with a picture's extension, directly in the folder, a regular file (never a link), at most
// `LANDING_FILE_MAX_BYTES`. One that is missing or breaks a rule is dropped and reported.

import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { LandingContent, ProfileLanding } from "@miyoria/types";
import { z } from "zod";

/** The folder of a profile's front page, and its one file. */
export const LANDING_DIR = "landing";
export const LANDING_FILE_NAME = "landing.json";

/** A picture's name in the landing folder: no path, no dot file, a picture's extension. */
export const LANDING_FILE = /^[a-z0-9][a-z0-9_-]{0,63}\.(?:webp|png|jpe?g|avif|gif)$/i;
/** The largest picture served. */
export const LANDING_FILE_MAX_BYTES = 8 * 1024 * 1024;

const text = (max: number) => z.string().trim().min(1).max(max);
const picture = z.string().regex(LANDING_FILE, "a picture's file name in the landing folder");

const BuiltinSchema = z.object({ builtin: z.literal("miyoria") }).strict();

const ContentSchema = z
  .object({
    line: text(200).nullable().default(null),
    cover: picture.nullable().default(null),
    sections: z
      .array(
        z
          .object({
            title: text(60),
            text: text(2000),
            image: picture.nullable().default(null),
          })
          .strict(),
      )
      .max(12)
      .default([]),
  })
  .strict();

/** What `loadLanding` found, and what it had to leave out (for the log). */
export interface LoadedLanding {
  landing: ProfileLanding;
  problems: string[];
}

/** Whether `name` is a picture the landing folder may serve, and its size if so. */
export async function landingPicture(dir: string, name: string): Promise<number | null> {
  if (!LANDING_FILE.test(name)) return null;
  try {
    const st = await lstat(join(dir, name));
    if (!st.isFile() || st.size > LANDING_FILE_MAX_BYTES) return null;
    return st.size;
  } catch {
    return null;
  }
}

/** Reads `<profileDir>/landing/landing.json`. */
export async function loadLanding(profileDir: string): Promise<LoadedLanding> {
  const dir = join(profileDir, LANDING_DIR);
  const path = join(dir, LANDING_FILE_NAME);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { landing: plain, problems: [] };
    return { landing: plain, problems: [`cannot read ${path}: ${(error as Error).message}`] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    return { landing: plain, problems: [`${path} is not JSON: ${(error as Error).message}`] };
  }
  if (BuiltinSchema.safeParse(json).success) return { landing: { kind: "builtin" }, problems: [] };
  const parsed = ContentSchema.safeParse(json);
  if (!parsed.success) {
    const why = parsed.error.issues
      .map((i) => `${i.path.join(".") || "(top)"}: ${i.message}`)
      .join("; ");
    return { landing: plain, problems: [`${path} does not read as a front page: ${why}`] };
  }
  const problems: string[] = [];
  const keep = async (name: string | null): Promise<string | null> => {
    if (name === null) return null;
    if ((await landingPicture(dir, name)) !== null) return name;
    problems.push(
      `${join(dir, name)} is left out: not a regular file in the landing folder, or over ${LANDING_FILE_MAX_BYTES} bytes`,
    );
    return null;
  };
  const c = parsed.data;
  const content: LandingContent = {
    line: c.line,
    cover: await keep(c.cover),
    sections: await Promise.all(
      c.sections.map(async (s) => ({ title: s.title, text: s.text, image: await keep(s.image) })),
    ),
  };
  return { landing: { kind: "own", dir, content }, problems };
}

const plain: ProfileLanding = { kind: "plain" };
