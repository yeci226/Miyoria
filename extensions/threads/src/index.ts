// Threads extension: she scrolls her own Threads feed in a browser window on the streaming PC
// (OBS captures it) and talks about the posts, as the game `threads` (tools `game.threads.observe`
// / `game.threads.act`). Read-only: nothing it can do writes on Threads.

import { defineExtension } from "@miyoria/sdk";
import { ThreadsAdapter } from "./adapter.js";
import { defaultProfileDir, ThreadsBrowser } from "./browser.js";
import { Vision } from "./vision.js";

export { ACTIONS, GAME_ID, GUIDE, ThreadsAdapter } from "./adapter.js";
export { defaultProfileDir, ThreadsBrowser, WINDOW_TITLE } from "./browser.js";
export { describePost, parseCount, toPost } from "./feed.js";
export { Vision } from "./vision.js";

/** `[extensions."miyoria.threads"]` (everything optional). */
export interface ThreadsConfig {
  start_url?: string;
  profile_dir?: string;
  width?: number;
  height?: number;
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
    const adapter = new ThreadsAdapter(browser, vision);
    await ctx.game.registerAdapter(adapter);
    ctx.onShutdown(async () => {
      adapter.close();
      await browser.close();
    });
  },
});
