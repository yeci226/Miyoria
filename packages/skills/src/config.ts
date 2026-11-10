import { z } from "zod";

/**
 * `[modules.skills]`: her skills, small how-to documents kept in her sandbox workspace
 * (`skills/<name>/SKILL.md`, plus scripts beside it). The module needs `[modules.sandbox]` with
 * its workspace on; without it there are no skills and no tools.
 */
export const SkillsConfigSchema = z.object({
  /** Skills at most. */
  max_skills: z.number().int().min(1).default(50),
  /** Characters of one skill's body (a longer text is refused, so she writes it shorter). */
  max_body_chars: z.number().int().min(200).default(6000),
  /** Characters of the one-line description that is always available. */
  max_description_chars: z.number().int().min(20).default(140),
  /**
   * Characters of a skill body `skill_read` returns at once (the rest is read with `offset`).
   * Keep it below `[modules.agent] max_tool_result_chars` (4000), which cuts a tool result.
   */
  read_chars: z.number().int().min(200).default(3900),
  /** Characters of the index of names and descriptions (`SkillStore.index`) for the prompt. */
  index_chars: z.number().int().min(200).default(1500),
});
export type SkillsConfig = z.output<typeof SkillsConfigSchema>;
