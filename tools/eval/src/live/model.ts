// The live run's router, built from `miyoria.toml` like the core builds it (same providers, same
// purposes, the profile's `[llm.purposes]` over the global ones), with every provider behind the
// run's meter. The config's own budget is left out: the run has its own limit (`--max-usd`), and
// what it spends is not seen by the budget of a core that is running.

import { existsSync } from "node:fs";
import {
  type ChatProvider,
  LlmConfigSchema,
  LlmRouter,
  type ModelRef,
  modelRefString,
  OpenAiFactory,
  parseModelRef,
} from "@miyoria/llm/llm";
import { Config, loadDotenv } from "@miyoria/runtime/kernel";
import type { Profile } from "@miyoria/runtime/profile";
import { Meter } from "./meter.js";

export type LiveModel =
  | { kind: "ready"; router: LlmRouter; meter: Meter; chain: string }
  | { kind: "none"; reason: string };

/**
 * `configPath` is `miyoria.toml`. A missing file, no provider or no `chat` chain is `none`; a
 * config that is there but wrong throws.
 */
export async function setupLiveModel(
  configPath: string,
  profile: Profile,
  maxUsd: number | null,
): Promise<LiveModel> {
  if (!existsSync(configPath)) return { kind: "none", reason: `no config file at ${configPath}` };
  loadDotenv(configPath);
  const config = await Config.load(configPath);
  const llm = config.get("llm", LlmConfigSchema);
  if (Object.keys(llm.providers).length === 0) {
    return { kind: "none", reason: `${configPath} sets no [llm.providers.*]` };
  }
  const meter = new Meter({ pricing: new Map(Object.entries(llm.pricing)), maxUsd });
  const factory = new OpenAiFactory();
  const providers = new Map<string, ChatProvider>();
  for (const [name, cfg] of Object.entries(llm.providers)) {
    if (!factory.kinds.includes(cfg.kind)) {
      throw new Error(`provider \`${name}\`: unknown kind \`${cfg.kind}\``);
    }
    providers.set(name, meter.wrap(factory.build(name, cfg)));
  }
  const router = new LlmRouter(providers, new Map(Object.entries(llm.purposes)), {
    pricing: new Map(Object.entries(llm.pricing)),
    reasoning: new Map(Object.entries(llm.reasoning)),
    imageInput: new Map(Object.entries(llm.image_input)),
  });
  const own = new Map<string, ModelRef[]>(
    Object.entries(profile.manifest.llm.purposes).map(([purpose, chain]) => [
      purpose,
      chain.map(parseModelRef),
    ]),
  );
  router.setPurposes(own);
  const chain = router.chain("chat");
  if (chain.length === 0) {
    return { kind: "none", reason: "neither [llm.purposes] nor the profile has a `chat` chain" };
  }
  return { kind: "ready", router, meter, chain: chain.map(modelRefString).join(" > ") };
}
