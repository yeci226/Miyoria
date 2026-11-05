import { defineManifest, type Module, type ModuleContext } from "@miyoria/kernel";
import { ToolRegistryKey } from "@miyoria/tools";
import { WebConfigSchema } from "./config.js";
import { WEB_FETCH, WEB_SEARCH, WebFetchTool, WebSearchTool } from "./tools.js";

/** Module `web`: registers `web_search` and `web_fetch`. Off without a `token`. */
export class WebModule implements Module {
  static readonly ID = "web";
  readonly manifest = defineManifest(WebModule.ID, "Web search", {
    description: "She searches the web and reads pages through DeepSeek's Search and Fetch API",
    configSchema: WebConfigSchema,
  });
  #cleanup: (() => void) | null = null;

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config(WebConfigSchema);
    const tools = ctx.services.get(ToolRegistryKey);
    if (!tools) {
      ctx.log.warn("no tool registry: she cannot use the web");
      return;
    }
    tools.register(new WebSearchTool(cfg));
    tools.register(new WebFetchTool(cfg));
    this.#cleanup = () => {
      tools.unregister(WEB_SEARCH);
      tools.unregister(WEB_FETCH);
    };
  }

  async stop(): Promise<void> {
    this.#cleanup?.();
    this.#cleanup = null;
  }
}
