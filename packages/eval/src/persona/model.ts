// The one place the blind test touches a model: the repo's LLM router, built from `miyoria.toml`
// the way the core builds it (same providers, same purposes). Both persona versions go through
// the same chain and the same settings. With nothing configured it says so and returns `none`.

import { existsSync } from "node:fs";
import { Config, loadDotenv } from "@miyoria/kernel";
import {
  LlmConfigSchema,
  LlmModule,
  type ModelRef,
  OpenAiFactory,
  parseModelRef,
  systemMessage,
  userMessage,
} from "@miyoria/llm";
import type { Profile } from "@miyoria/profile";
import type { Complete } from "./blind.js";

export interface ModelSettings {
  /** The model purpose that answers (the chain of `[llm.purposes]` or the profile's). */
  purpose: string;
  temperature: number;
  max_tokens: number;
}

export const DEFAULT_SETTINGS: ModelSettings = {
  purpose: "chat",
  temperature: 0.8,
  max_tokens: 400,
};

export type ModelSetup =
  | { kind: "ready"; complete: Complete; chain: string }
  | { kind: "none"; reason: string };

/**
 * `configPath` is `miyoria.toml`; `profile` is the new persona's profile (its `[llm.purposes]`
 * win over the global ones, as they do when she runs). A missing file, no provider or no chain
 * for the purpose is `none`; a config that is there but wrong throws.
 */
export async function setupModel(
  configPath: string,
  profile: Profile,
  settings: ModelSettings = DEFAULT_SETTINGS,
): Promise<ModelSetup> {
  if (!existsSync(configPath)) return { kind: "none", reason: `找不到設定檔 ${configPath}` };
  loadDotenv(configPath);
  const config = await Config.load(configPath);
  const llm = config.get("llm", LlmConfigSchema);
  if (Object.keys(llm.providers).length === 0) {
    return { kind: "none", reason: `${configPath} 沒有設任何 [llm.providers.*]` };
  }
  const own = profile.manifest.llm.purposes[settings.purpose];
  const chain: ModelRef[] = own?.map(parseModelRef) ?? llm.purposes[settings.purpose] ?? [];
  if (chain.length === 0) {
    return {
      kind: "none",
      reason: `[llm.purposes] 和 profile 都沒有 ${settings.purpose} 這個用途的模型`,
    };
  }
  const router = new LlmModule(llm, [new OpenAiFactory()], {
    purposeOverrides: new Map([[settings.purpose, chain]]),
  }).buildRouter();
  const complete: Complete = async ({ system, user }) => {
    const response = await router.complete(settings.purpose, {
      messages: [systemMessage(system), userMessage(user)],
      temperature: settings.temperature,
      max_tokens: settings.max_tokens,
      reasoning_purpose: "chat_text",
    });
    return response.text;
  };
  return {
    kind: "ready",
    complete,
    chain: chain.map((m) => `${m.provider}:${m.model}`).join(" > "),
  };
}
