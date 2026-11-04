// Threads extension: she scrolls her own Threads feed in a browser window on the streaming PC
// (OBS captures it) and talks about the posts, as the game `threads` (tools `game.threads.observe`
// / `game.threads.act`). Read-only: nothing it can do writes on Threads.

import { defineExtension } from "@miyoria/sdk";
import { ThreadsAdapter } from "./adapter.js";
import { defaultProfileDir, ThreadsBrowser } from "./browser.js";
import { ShareTools } from "./share.js";
import { Vision } from "./vision.js";

export { ACTIONS, GAME_ID, GUIDE, ThreadsAdapter } from "./adapter.js";
export { defaultProfileDir, ThreadsBrowser, WINDOW_TITLE } from "./browser.js";
export { describePost, parseCount, toPost } from "./feed.js";
export { ShareTools } from "./share.js";
export { Vision } from "./vision.js";

const SEEN_KEY = "share:seen";

/** `[extensions."miyoria.threads"]` (everything optional). */
export interface ThreadsConfig {
  start_url?: string;
  profile_dir?: string;
  width?: number;
  height?: number;
  /** No window (for a machine nobody watches). */
  headless?: boolean;
  /** Also playable as the game `threads`. */
  game?: boolean;
  vision_url?: string;
  vision_model?: string;
  vision_key_env?: string;
  vision_timeout_ms?: number;
}

export default defineExtension({
  async activate(ctx) {
    const config = ctx.config as ThreadsConfig;
    const env = process.env;
    const browser = new ThreadsBrowser({
      startUrl: config.start_url ?? "https://www.threads.com/",
      profileDir: config.profile_dir ?? defaultProfileDir(),
      width: config.width ?? 720,
      height: config.height ?? 1000,
      headless: config.headless ?? false,
    });
    const url = config.vision_url ?? env.MIYORIA_THREADS_VISION_URL ?? "";
    const model = config.vision_model ?? env.MIYORIA_THREADS_VISION_MODEL ?? "";
    const key = env[config.vision_key_env ?? "MIYORIA_THREADS_VISION_KEY"] ?? "";
    let vision: Vision | null = null;
    if (url !== "" && model !== "") {
      vision = new Vision({ url, model, key, timeoutMs: config.vision_timeout_ms ?? 20_000 });
      ctx.log.info("pictures are described by a vision model", { model });
    } else {
      ctx.log.info(
        "no vision model (vision_url / vision_model): she only knows a post has pictures",
      );
    }
    const share = new ShareTools(browser, vision, {
      load: async () => (await ctx.storage.get<string[]>(SEEN_KEY)) ?? [],
      save: (links) => ctx.storage.set(SEEN_KEY, links),
    });
    await ctx.tools.register({
      name: "internal.threads.feed",
      description: "Posts she has not seen yet (for the share module).",
      params: { limit: { type: "integer" } },
      run: (args) => share.feed(Number(args.limit)),
    });
    await ctx.tools.register({
      name: "internal.threads.capture",
      description: "One post as a picture (for the share module).",
      params: { link: { type: "string" } },
      run: (args) => share.capture(String(args.link)),
    });
    await ctx.tools.register({
      name: "internal.threads.close",
      description: "Closes the browser (for the share module).",
      run: async () => {
        await share.close();
        return "closed";
      },
    });
    const adapter = config.game === false ? null : new ThreadsAdapter(browser, vision);
    if (adapter) await ctx.game.registerAdapter(adapter);
    ctx.onShutdown(async () => {
      adapter?.close();
      await browser.close();
    });
  },
});
