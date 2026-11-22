// @miyoria/runtime/profile: a *profile* is one complete character: persona prompts, which LLM it uses,
// voice and avatar settings. The persona prompts inside a profile can be edited without
// touching the rest.
//
//   profiles/<id>/
//     profile.toml
//     persona/
//       identity.md        # sections, in the order listed in profile.toml
//       style.md
//       examples/*.md      # few-shot dialogues
//     lorebook.toml        # World Info: kaomoji by mood, reminders brought up by words or moods
//     voice.toml
//     avatar.toml

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  type Character,
  characterNames,
  DEFAULT_CHARACTER,
  type JsonObject,
  orList,
  type ProfileId,
} from "@miyoria/types";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/**
 * Her own names, not the persona's: she is who `[character]` says whichever persona she plays, so
 * these always count as addressing her and always appear in her prompt. These are Miyoria's, the
 * default character's; a profile's come from `Profile.character`.
 */
export const OWN_NAMES: readonly string[] = Object.freeze(characterNames(DEFAULT_CHARACTER));

/**
 * The line that tells her so; `persona` is the persona's display name. A fact about her names,
 * not a frame: 「那是你演的樣子」 told the model, first thing, that the persona was a role it played,
 * the very distance that reads as 「很 AI」 (docs/design/persona-v4.md §7). With Miyoria's names it
 * is word for word the line she always had.
 */
export function ownIdentity(persona: string, character: Character = DEFAULT_CHARACTER): string {
  const name = persona.trim();
  const own = character.name.trim();
  const short = character.short_name.trim();
  const others = character.other_names.map((n) => n.trim()).filter((n) => n !== "");
  const called = short === "" ? [own] : [own, short];
  const also =
    name !== "" && name.toLowerCase() !== own.toLowerCase()
      ? `「${name}」也是你,是大家在這裡認識的你;有人叫 ${orList([...called, name])} 都是在叫你。`
      : `有人叫 ${orList(called)} 都是在叫你。`;
  const spelled = others.length > 0 ? `(${others.join("、")})` : "";
  const nick = short === "" ? "" : `大家也叫你 ${short}${spelled}。`;
  return `你的本名是 ${own},${nick}${also}問你叫什麼,你知道自己叫 ${own}。`;
}

export class ProfileError extends Error {
  override readonly name = "ProfileError";
}

export const LanguageConfigSchema = z.object({
  primary: z.string().default("zh-TW"),
  secondary: z.array(z.string()).default([]),
});

export const MoodBaselineSchema = z.object({
  /** -1..1 */
  valence: z.number().default(0),
  /** 0..1 */
  arousal: z.number().default(0.5),
  /** 0..1 */
  energy: z.number().default(0.7),
});

export const BehaviorConfigSchema = z.object({
  /** `off` | `mention-only` | `quiet` | `normal` | `lively` | `always` (old: `ambient` = `normal`) */
  default_channel_mode: z.string().default("quiet"),
  /** `low` | `medium` | `high` */
  initiative: z.string().default("medium"),
  /** Max share of recent messages that may be hers (anti-spam). */
  max_share_of_recent: z.number().default(0.3),
});

/** How fast one emotion rises and fades for this character. */
export const EmotionTemperamentSchema = z.object({
  /** How strongly events stir it (multiplier, 1 = ordinary). */
  gain: z.number().nonnegative().optional(),
  /** Time for half of it to fade. */
  half_life_mins: z.number().positive().optional(),
});

/**
 * `[temperament]`: her emotional temperament. Emotion names are the `self` module's
 * (`joy`, `shy`, `pride`, ..., and `resentment` for 不爽 toward someone); unknown ones are
 * ignored.
 */
export const TemperamentSchema = z.object({
  /** Display rules: `open` (shows what she feels) or `tsundere` (hides it, 傲嬌). */
  display: z.enum(["open", "tsundere"]).default("open"),
  emotions: z.record(z.string(), EmotionTemperamentSchema).default({}),
});

export const PersonaConfigSchema = z.object({
  /** Section files under `persona/`, in prompt order (without `.md`). */
  sections: z.array(z.string()).default(["identity", "style"]),
});

export const ProfileLlmSchema = z.object({
  /** Purpose → `provider:model` chain, overriding the global `[llm.purposes]`. */
  purposes: z.record(z.string(), z.array(z.string())).default({}),
});

/** `profile.toml`. Unknown keys are ignored. */
export const ProfileManifestSchema = z.object({
  id: z.string(),
  display_name: z.string(),
  /** Names that count as addressing her directly. */
  nicknames: z.array(z.string()).default([]),
  /** Topics she cares about; they make ambient messages more interesting. */
  interests: z.array(z.string()).default([]),
  language: LanguageConfigSchema.prefault({}),
  mood: MoodBaselineSchema.prefault({}),
  behavior: BehaviorConfigSchema.prefault({}),
  temperament: TemperamentSchema.prefault({}),
  persona: PersonaConfigSchema.prefault({}),
  llm: ProfileLlmSchema.prefault({}),
});
export type ProfileManifest = z.output<typeof ProfileManifestSchema>;
export type LanguageConfig = z.output<typeof LanguageConfigSchema>;
export type MoodBaseline = z.output<typeof MoodBaselineSchema>;
export type BehaviorConfig = z.output<typeof BehaviorConfigSchema>;
export type Temperament = z.output<typeof TemperamentSchema>;

/**
 * One group of `lorebook.toml`'s kaomoji: the faces for a feeling, and the emotion names (her
 * `<emo:…>` tags and the self module's emotions) that bring it up.
 */
export const KaomojiGroupSchema = z.object({
  group: z.string(),
  moods: z.array(z.string()).default([]),
  faces: z.array(z.string()).default([]),
});

/** One entry of `lorebook.toml` (World Info): a reminder shown when its keys or moods come up. */
export const LoreEntrySchema = z.object({
  id: z.string(),
  /** Words that bring it up in the last few messages or the message she answers (any case). */
  keys: z.array(z.string()).default([]),
  /** Her current emotions that bring it up. */
  moods: z.array(z.string()).default([]),
  text: z.string(),
  /** Higher first when more entries come up than are shown. */
  priority: z.number().default(0),
  channel: z.enum(["text", "voice", "both"]).default("both"),
});

/** `lorebook.toml`. */
export const LorebookSchema = z.object({
  kaomoji: z.array(KaomojiGroupSchema).default([]),
  entries: z.array(LoreEntrySchema).default([]),
});
export type KaomojiGroup = z.output<typeof KaomojiGroupSchema>;
export type LoreEntry = z.output<typeof LoreEntrySchema>;
export type Lorebook = z.output<typeof LorebookSchema>;

/** Parses `lorebook.toml` text. Throws `ProfileError`. */
export function parseLorebook(text: string, source = "lorebook.toml"): Lorebook {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new ProfileError(`parsing ${source}: ${(error as Error).message}`, { cause: error });
  }
  const parsed = LorebookSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProfileError(`parsing ${source}: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

/** Parses `profile.toml` text. Throws `ProfileError`. */
export function parseProfileManifest(text: string, source = "profile.toml"): ProfileManifest {
  let raw: unknown;
  try {
    raw = parseToml(text);
  } catch (error) {
    throw new ProfileError(`parsing ${source}: ${(error as Error).message}`, { cause: error });
  }
  const parsed = ProfileManifestSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ProfileError(`parsing ${source}: ${z.prettifyError(parsed.error)}`, {
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export interface PersonaSection {
  key: string;
  body: string;
}

async function readText(path: string, what: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    throw new ProfileError(`reading ${what}${path}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** TOML table as JSON (dates become strings). */
function tomlTable(text: string, path: string): JsonObject {
  try {
    return JSON.parse(JSON.stringify(parseToml(text))) as JsonObject;
  } catch (error) {
    throw new ProfileError(`parsing ${path}: ${(error as Error).message}`, { cause: error });
  }
}

async function readOptionalTable(path: string): Promise<JsonObject | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new ProfileError(`reading ${path}: ${(error as Error).message}`, { cause: error });
  }
  return tomlTable(text, path);
}

export class Profile {
  readonly id: ProfileId;
  readonly dir: string;
  readonly manifest: ProfileManifest;
  readonly sections: PersonaSection[];
  readonly examples: string[];
  /** `voice.toml`, if present. */
  readonly voice: JsonObject | null;
  /** `avatar.toml`, if present. */
  readonly avatar: JsonObject | null;
  /** `lorebook.toml`, if present. */
  readonly lorebook: Lorebook | null;
  /** Who she is in this profile (`[character]` of its config); Miyoria by default. */
  readonly character: Character;

  constructor(init: {
    dir: string;
    manifest: ProfileManifest;
    sections: PersonaSection[];
    examples: string[];
    voice: JsonObject | null;
    avatar: JsonObject | null;
    lorebook?: Lorebook | null;
    character?: Character;
  }) {
    this.character = init.character ?? DEFAULT_CHARACTER;
    this.id = init.manifest.id;
    this.dir = init.dir;
    this.manifest = init.manifest;
    this.sections = init.sections;
    this.examples = init.examples;
    this.voice = init.voice;
    this.avatar = init.avatar;
    this.lorebook = init.lorebook ?? null;
  }

  /** Loads `profilesDir/<id>`; `character` is who she is in it (default Miyoria). */
  static load(profilesDir: string, id: string, character?: Character): Promise<Profile> {
    return Profile.loadDir(join(profilesDir, id), character);
  }

  static async loadDir(dir: string, character?: Character): Promise<Profile> {
    const manifestPath = join(dir, "profile.toml");
    const manifest = parseProfileManifest(await readText(manifestPath, ""), manifestPath);

    const personaDir = join(dir, "persona");
    const sections: PersonaSection[] = [];
    for (const key of manifest.persona.sections) {
      const body = await readText(join(personaDir, `${key}.md`), "persona section ");
      sections.push({ key, body: body.trim() });
    }

    const examples: string[] = [];
    const examplesDir = join(personaDir, "examples");
    if (await isDir(examplesDir)) {
      const files = (await readdir(examplesDir)).filter((f) => f.endsWith(".md")).sort();
      for (const file of files) {
        examples.push((await readText(join(examplesDir, file), "")).trim());
      }
    }

    const lorebookPath = join(dir, "lorebook.toml");
    let lorebook: Lorebook | null = null;
    try {
      lorebook = parseLorebook(await readFile(lorebookPath, "utf8"), lorebookPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        if (error instanceof ProfileError) throw error;
        throw new ProfileError(`reading ${lorebookPath}: ${(error as Error).message}`, {
          cause: error,
        });
      }
    }

    return new Profile({
      dir,
      manifest,
      sections,
      examples,
      voice: await readOptionalTable(join(dir, "voice.toml")),
      avatar: await readOptionalTable(join(dir, "avatar.toml")),
      lorebook,
      ...(character === undefined ? {} : { character }),
    });
  }

  get displayName(): string {
    return this.manifest.display_name;
  }

  /**
   * Display name, nicknames and her own names (the character's), for "is she being addressed"
   * checks.
   */
  names(): string[] {
    return [
      this.manifest.display_name,
      ...this.manifest.nicknames,
      ...characterNames(this.character),
    ];
  }

  /** Who she is whatever the persona: the first thing in her prompt. */
  ownIdentity(): string {
    return ownIdentity(this.manifest.display_name, this.character);
  }

  /** Replaces a persona section's text (runtime edit, e.g. from the panel). */
  setSection(key: string, body: string): void {
    const section = this.sections.find((s) => s.key === key);
    if (section) section.body = body;
    else this.sections.push({ key, body });
  }

  /**
   * Stable persona prompt (sections + examples). Kept free of anything that changes per turn
   * so providers can cache it as a prefix.
   */
  personaPrompt(): string {
    let out = `${this.ownIdentity()}\n\n`;
    for (const s of this.sections) out += `${s.body}\n\n`;
    if (this.examples.length > 0) {
      out += "# 範例對話(只示範語氣,不要照抄)\n\n";
      for (const e of this.examples) out += `${e}\n\n`;
    }
    return out.trimEnd();
  }
}

export {
  LANDING_DIR,
  LANDING_FILE,
  LANDING_FILE_MAX_BYTES,
  LANDING_FILE_NAME,
  type LoadedLanding,
  landingPicture,
  loadLanding,
} from "./landing.js";
