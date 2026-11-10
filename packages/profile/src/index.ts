// @miyoria/profile: a *profile* is one complete character: persona prompts, which LLM it uses,
// voice and avatar settings. The persona prompts inside a profile can be edited without
// touching the rest.
//
//   profiles/<id>/
//     profile.toml
//     persona/
//       identity.md        # sections, in the order listed in profile.toml
//       style.md
//       examples/*.md      # few-shot dialogues
//     voice.toml
//     avatar.toml

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { JsonObject, ProfileId } from "@miyoria/types";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";

/**
 * Her own names, not the persona's: Miyoria is who she is whichever persona she plays, so these
 * always count as addressing her and always appear in her prompt.
 */
export const OWN_NAMES = ["Miyoria", "Miyo", "米優", "みよ"] as const;

/**
 * The line that tells her so; `persona` is the persona's display name. A fact about her names,
 * not a frame: 「那是你演的樣子」 told the model, first thing, that the persona was a role it played,
 * the very distance that reads as 「很 AI」 (docs/design/persona-v4.md §7).
 */
export function ownIdentity(persona: string): string {
  const name = persona.trim();
  const also =
    name !== "" && name.toLowerCase() !== "miyoria"
      ? `「${name}」也是你,是大家在這裡認識的你;有人叫 Miyoria、Miyo 或 ${name} 都是在叫你。`
      : "有人叫 Miyoria 或 Miyo 都是在叫你。";
  return `你的本名是 Miyoria,大家也叫你 Miyo(米優、みよ)。${also}問你叫什麼,你知道自己叫 Miyoria。`;
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

/** `profile.toml`. Unknown keys are ignored, like serde. */
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

  constructor(init: {
    dir: string;
    manifest: ProfileManifest;
    sections: PersonaSection[];
    examples: string[];
    voice: JsonObject | null;
    avatar: JsonObject | null;
  }) {
    this.id = init.manifest.id;
    this.dir = init.dir;
    this.manifest = init.manifest;
    this.sections = init.sections;
    this.examples = init.examples;
    this.voice = init.voice;
    this.avatar = init.avatar;
  }

  /** Loads `profilesDir/<id>`. */
  static load(profilesDir: string, id: string): Promise<Profile> {
    return Profile.loadDir(join(profilesDir, id));
  }

  static async loadDir(dir: string): Promise<Profile> {
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

    return new Profile({
      dir,
      manifest,
      sections,
      examples,
      voice: await readOptionalTable(join(dir, "voice.toml")),
      avatar: await readOptionalTable(join(dir, "avatar.toml")),
    });
  }

  get displayName(): string {
    return this.manifest.display_name;
  }

  /**
   * Display name, nicknames and her own names (`OWN_NAMES`), for "is she being addressed" checks.
   */
  names(): string[] {
    return [this.manifest.display_name, ...this.manifest.nicknames, ...OWN_NAMES];
  }

  /** Who she is whatever the persona: the first thing in her prompt. */
  ownIdentity(): string {
    return ownIdentity(this.manifest.display_name);
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
