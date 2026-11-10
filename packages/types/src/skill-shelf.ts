// Her skills as something to look at (docs/design/v4-plan.md §8.3 item 3), read-only.
//
// The `skills` module provides it next to its own store, so the admin API can list skills and read
// one without depending on the package or re-reading the workspace files in its own way (the file
// layout and the cleaning of a skill's text are the store's business). A failure carries a
// `kind` (`not_found`, `invalid`) as the store's errors do.

import { serviceKey } from "./service-key.js";

export interface SkillShelfEntry {
  name: string;
  /** One line. */
  description: string;
}

/** A file beside a skill's `SKILL.md`. */
export interface SkillShelfFile {
  path: string;
  size: number;
  /** `approved`: reviewed and unchanged, so she can run it; `unapproved`: not. */
  script: "approved" | "unapproved" | null;
}

/** One page of a skill's body, with the files beside it. */
export interface SkillShelfPage extends SkillShelfEntry {
  text: string;
  offset: number;
  /** Where the next page starts; `null` when `text` reaches the end. */
  next_offset: number | null;
  /** The body was cut where the store keeps it short. */
  truncated: boolean;
  files: SkillShelfFile[];
}

export interface SkillShelf {
  list(): Promise<{ skills: SkillShelfEntry[]; truncated: boolean }>;
  /** Throws an error with `kind: "not_found"` for a skill that does not exist. */
  read(name: string, offset?: number): Promise<SkillShelfPage>;
}

export const SkillShelfKey = serviceKey<SkillShelf>("SkillShelf");
