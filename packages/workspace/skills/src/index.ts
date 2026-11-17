// @miyoria/workspace/skills: module `skills`, her skills (small how-to documents with optional scripts,
// kept in her sandbox workspace and loaded on demand). See README.md.

export {
  NODE_SKILLS,
  SKILL_DELETE,
  SKILL_LIST,
  SKILL_READ,
  SKILL_TOOL,
  SKILL_WRITE,
  skillCapabilities,
  skillTool,
} from "./capabilities.js";
export { type SkillsConfig, SkillsConfigSchema } from "./config.js";
export { SkillsModule } from "./module.js";
export {
  MAX_SKILL_TOOLS,
  SKILL_FILE,
  SKILLS_DIR,
  SkillError,
  type SkillFile,
  type SkillPage,
  SkillStore,
  type SkillSummary,
  splitTools,
  toolNames,
} from "./store.js";
