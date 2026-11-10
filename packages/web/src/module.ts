import { actuatorsFor } from "@miyoria/actions";
import { defineManifest, type Module, type ModuleContext } from "@miyoria/kernel";
import { WebConfigSchema } from "./config.js";
import { webCapabilities } from "./tools.js";
import { WebService } from "./web.js";

/**
 * Module `web`: her `web_search` (DuckDuckGo's HTML endpoint) and `web_read` (one public page as
 * text) as capabilities `web.search` / `web.read`, permission `tools.web`. Page fetches go through
 * the SSRF guard (net.ts); results reach her as untrusted data (web.ts). Enabled unless
 * `[modules.web] enabled = false`. Registers in the `ActuatorRegistry`; nothing else needs it.
 */
export class WebModule implements Module {
  static readonly ID = "web";
  readonly manifest = defineManifest(WebModule.ID, "Web", {
    description: "Web search and a page reader for her; results are untrusted data",
    optional: ["actions"],
    configSchema: WebConfigSchema,
  });
  #unregister: (() => void) | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(WebConfigSchema);
    const web = new WebService({ config, clock: ctx.clock });
    const actuators = actuatorsFor(ctx);
    const off = webCapabilities(web).map((capability) => actuators.register(capability));
    this.#unregister = () => {
      for (const f of off) f();
    };
  }

  async stop(): Promise<void> {
    this.#unregister?.();
    this.#unregister = null;
  }
}
