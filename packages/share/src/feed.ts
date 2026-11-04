// The browser, reached through the tools the Threads extension registers. They are hidden from the
// model (`internal_` names); only this module calls them.

import type { ToolContext, ToolRegistry } from "@miyoria/tools";
import type { JsonValue } from "@miyoria/types";
import { z } from "zod";
import type { FeedPost } from "./judge.js";

export interface FeedResult {
  logged_in: boolean;
  posts: FeedPost[];
}

export interface CaptureResult {
  jpeg: string | null;
  description: string | null;
}

const FeedSchema = z.object({
  logged_in: z.boolean(),
  posts: z.array(
    z.object({
      link: z.string(),
      author: z.string(),
      age: z.string().nullable(),
      body: z.string(),
      images: z.number(),
    }),
  ),
});
const CaptureSchema = z.object({ jpeg: z.string().nullable(), description: z.string().nullable() });

const FEED = "internal_threads_feed";
const CAPTURE = "internal_threads_capture";
const CLOSE = "internal_threads_close";

export class ThreadsFeed {
  readonly #tools: () => ToolRegistry | undefined;
  readonly #ctx: ToolContext;

  constructor(tools: () => ToolRegistry | undefined, ctx: ToolContext) {
    this.#tools = tools;
    this.#ctx = ctx;
  }

  get ready(): boolean {
    return this.#tools()?.get(FEED) !== undefined;
  }

  async feed(limit: number): Promise<FeedResult> {
    return FeedSchema.parse(JSON.parse(await this.#call(FEED, { limit })));
  }

  async capture(link: string): Promise<CaptureResult> {
    return CaptureSchema.parse(JSON.parse(await this.#call(CAPTURE, { link })));
  }

  /** Never throws: closing is what a failed round does last. */
  async close(): Promise<void> {
    await this.#call(CLOSE, {}).catch(() => {});
  }

  async #call(name: string, args: JsonValue): Promise<string> {
    const tool = this.#tools()?.get(name);
    if (!tool) throw new Error(`tool \`${name}\` is not registered`);
    return tool.call(this.#ctx, args);
  }
}
