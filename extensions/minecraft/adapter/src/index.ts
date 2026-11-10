// Minecraft game adapter extension: connects to the miyoria-bridge mod and
// exposes it as the task executor of `game.minecraft` (goals started as tasks,
// `game.minecraft.task.*` events with failure codes) and `game.minecraft.*`
// events (docs/ARCHITECTURE.md §12.3–§12.4, docs/design/v2-architecture.md §3.8).

import { defineExtension } from "@miyoria/sdk";
import { MinecraftAdapter } from "./adapter.js";
import { BridgeClient } from "./bridge.js";
import { type AdapterConfig, bridgeConfigPath, resolveEndpoint } from "./config.js";
import { Launcher } from "./launcher.js";

export { MinecraftAdapter, GAME_ID, OBTAIN_STRATEGIES, jobEnd, modFailureCode } from "./adapter.js";
export { BridgeClient, BridgeError } from "./bridge.js";
export { ACTIONS, HIDDEN_ACTIONS, failureCode, toRequests } from "./actions.js";
export { mapEvent } from "./events.js";
export { compactState, summarize } from "./summary.js";
export { bridgeConfigPath, defaultMinecraftDir, resolveEndpoint } from "./config.js";
export { Launcher, LaunchError, prismCandidates, prismInstanceOf } from "./launcher.js";
export { ObtainRunner } from "./obtain.js";
export { PlanError, describeStep, plan } from "./planner.js";

export default defineExtension({
  async activate(ctx) {
    const config = ctx.config as AdapterConfig;
    let warned = false;
    const endpoint = async () => {
      const found = await resolveEndpoint(config);
      if (found.token === "" && !warned) {
        warned = true;
        ctx.log.warn(
          'no miyoria-bridge token: start Minecraft once with the mod, then set minecraft_dir in [extensions."miyoria.minecraft"]',
          { looked_in: bridgeConfigPath(config) ?? null },
        );
      } else if (found.token !== "") {
        warned = false;
      }
      return found;
    };
    const bridge = new BridgeClient({
      endpoint,
      requestTimeoutMs: config.request_timeout_ms,
      reconnectMinMs: config.reconnect_min_ms,
      reconnectMaxMs: config.reconnect_max_ms,
      log: ctx.log,
    });
    const minecraftDir = config.minecraft_dir ?? process.env.MIYORIA_MC_DIR;
    const launcher = new Launcher({ config, minecraftDir });
    if (launcher.problem() === null) {
      ctx.log.info("can start the game itself", {
        prism: launcher.executable() ?? null,
        instance: launcher.instance() ?? null,
      });
    }
    const adapter = new MinecraftAdapter(bridge, {
      damageImportant: config.damage_important,
      allowCommands: config.allow_commands,
      launcher,
    });
    await ctx.game.registerAdapter(adapter);
    bridge.start();
    ctx.onShutdown(() => {
      bridge.close();
      adapter.close();
    });
  },
});
