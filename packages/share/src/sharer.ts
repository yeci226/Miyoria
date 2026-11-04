// One round: read the feed, look at the posts, pick what she has something to say about, find the
// channels that would care and share one. Most posts say little without their pictures, so she
// looks first; most rounds still end before the second call to the model. Whatever fails ends the
// round: nothing is retried, nothing is sent.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { errorMessage } from "@miyoria/kernel";
import type { Completer } from "@miyoria/llm";
import {
  type AccountRef,
  type ContextKey,
  type JsonValue,
  newId,
  type PlatformSink,
  type TalkCeiling,
} from "@miyoria/types";
import { z } from "zod";
import {
  type Candidate,
  type ChannelMatch,
  eligibleChannels,
  type MatchDeps,
  matchChannels,
} from "./channels.js";
import type { ShareConfig } from "./config.js";
import type { CaptureResult, FeedResult } from "./feed.js";
import { decide, type FeedPost, pickPosts } from "./judge.js";
import { Limits, type Pause } from "./limits.js";

/** The browser (`ThreadsFeed`). */
export interface Feed {
  readonly ready: boolean;
  feed(limit: number): Promise<FeedResult>;
  capture(link: string): Promise<CaptureResult>;
  close(): Promise<void>;
}

export interface SharerDeps {
  model: Completer;
  persona(): string;
  feed: Feed;
  /** Every text place she knows of, most recent first. */
  contexts(): ContextKey[];
  /** The places people are talking in now. */
  lively(): ContextKey[];
  ceiling(context: ContextKey): TalkCeiling | null;
  match: MatchDeps;
  sink(platform: string): PlatformSink | undefined;
  owners(): AccountRef[];
  settings: { load(): Promise<unknown>; save(value: JsonValue): Promise<void> };
  now(): number;
  warn(message: string, error?: unknown): void;
}

const THREADS = "https://www.threads.com";
const HOUR_MS = 3_600_000;
const FILE_NAME = "threads.jpg";

const NOTICE: Record<Exclude<Pause, null>, string> = {
  login: "Threads 要重新登入了,我先不滑。到放瀏覽器的機器跑 `pnpm run login` 登入就好。",
  no_posts: "Threads 連續好幾輪都讀不到貼文,可能改版了,我先不滑。",
};

const WaitingSchema = z.object({
  at_ms: z.number(),
  candidates: z.array(
    z.object({
      link: z.string(),
      author: z.string(),
      body: z.string(),
      images: z.number(),
      description: z.string().nullable(),
      jpeg_path: z.string().nullable(),
    }),
  ),
});
const StateSchema = z.object({ limits: z.unknown(), waiting: WaitingSchema.nullable() });
type Waiting = z.output<typeof WaitingSchema>;
type Looked = FeedPost & Candidate;

export class Sharer {
  readonly #config: ShareConfig;
  readonly #deps: SharerDeps;
  readonly #dir: string;
  #limits: Limits;
  /** `when = "active"`: posts waiting for a channel to wake up. */
  #waiting: Waiting | null = null;
  #running: Promise<void> | null = null;

  constructor(config: ShareConfig, deps: SharerDeps, dataDir: string) {
    this.#config = config;
    this.#deps = deps;
    this.#dir = dataDir;
    this.#limits = new Limits(config);
  }

  /** Whether she could go scrolling now. */
  available(nowMs: number): boolean {
    return (
      this.#deps.feed.ready &&
      this.#running === null &&
      this.#waiting === null &&
      this.#limits.canBrowse(nowMs)
    );
  }

  /** Starts a round in the background; `false` when that is not possible now. */
  start(signal: AbortSignal): boolean {
    if (!this.available(this.#deps.now())) return false;
    this.#running = this.#round(signal).finally(() => {
      this.#running = null;
    });
    return true;
  }

  /** Resolves when no round is running. */
  async idle(): Promise<void> {
    await this.#running;
  }

  /** `when = "active"`: shares what is waiting once a channel is talking. */
  async flush(signal: AbortSignal): Promise<void> {
    const waiting = this.#waiting;
    if (waiting === null || this.#running !== null) return;
    const now = this.#deps.now();
    if (now - waiting.at_ms >= this.#config.keep_hours * HOUR_MS) {
      await this.#drop(waiting.candidates);
      return;
    }
    if (!this.#limits.canPost(now)) return;
    try {
      const matches = await this.#match(this.#eligible(this.#deps.lively()), waiting.candidates);
      if (matches.length === 0) return;
      await this.#share(waiting.candidates, matches, signal);
      await this.#drop(waiting.candidates);
    } catch (error) {
      this.#deps.warn("sharing what was waiting failed", error);
    }
  }

  /** While paused: looks whether Threads works again. Reads the page, spends no tokens. */
  async probe(): Promise<void> {
    if (this.#limits.paused === null || this.#running !== null) return;
    const feed = this.#deps.feed;
    try {
      const out = await feed.feed(1);
      if (out.logged_in && out.posts.length > 0) {
        this.#limits.resume();
        await this.#save();
      }
    } catch (error) {
      this.#deps.warn("checking Threads failed", error);
    } finally {
      await feed.close();
    }
  }

  /** Reads the saved state and removes pictures nothing refers to any more. */
  async restore(): Promise<void> {
    await mkdir(this.#dir, { recursive: true });
    const stored = StateSchema.safeParse(await this.#deps.settings.load());
    if (stored.success) {
      this.#limits = new Limits(this.#config, stored.data.limits);
      this.#waiting = stored.data.waiting;
    }
    const kept = new Set(this.#waiting?.candidates.map((c) => basename(c.jpeg_path ?? "")));
    for (const name of await readdir(this.#dir)) {
      if (!kept.has(name)) await rm(join(this.#dir, name), { force: true });
    }
  }

  async #round(signal: AbortSignal): Promise<void> {
    const deps = this.#deps;
    let looked: Looked[] = [];
    let kept: readonly Looked[] = [];
    try {
      this.#limits.noteRound(deps.now());
      await this.#save();
      const out = await deps.feed.feed(this.#config.posts);
      if (!out.logged_in) return await this.#pause("login");
      if (out.posts.length === 0) {
        if (this.#limits.noteEmpty()) await this.#pause("no_posts");
        return;
      }
      this.#limits.noteFound();
      if (signal.aborted) return;
      looked = await this.#capture(out.posts, signal);
      if (looked.length === 0 || signal.aborted) return;
      const links = await pickPosts(deps.model, deps.persona(), looked, signal);
      const picked = looked.filter((p) => links.includes(p.link));
      if (picked.length === 0 || signal.aborted) return;

      if (this.#config.when === "active") {
        this.#waiting = { at_ms: deps.now(), candidates: picked };
        kept = picked;
        return;
      }
      const matches = await this.#match(this.#eligible(deps.contexts()), picked);
      if (matches.length > 0) await this.#share(picked, matches, signal);
    } catch (error) {
      deps.warn("a round on Threads failed", error);
    } finally {
      await deps.feed.close();
      await this.#remove(looked.filter((c) => !kept.includes(c)));
      await this.#save();
    }
  }

  /** Where she may post now, among the places that can show the picture. */
  #eligible(contexts: readonly ContextKey[]): ContextKey[] {
    const deps = this.#deps;
    const places = contexts.filter((c) => deps.sink(c.platform)?.sendsFiles === true);
    return eligibleChannels(places, (c) => deps.ceiling(c), this.#config);
  }

  #match(
    contexts: readonly ContextKey[],
    posts: readonly { body: string }[],
  ): Promise<ChannelMatch[]> {
    const query = posts.map((p) => p.body).join("\n");
    return matchChannels(contexts, query, this.#deps.match, this.#deps.now());
  }

  /** The posts as pictures on disk. A post with pictures nobody could look at is dropped. */
  async #capture(posts: readonly FeedPost[], signal: AbortSignal): Promise<Looked[]> {
    await mkdir(this.#dir, { recursive: true });
    const out: Looked[] = [];
    for (const post of posts) {
      if (signal.aborted) break;
      try {
        const { jpeg, description } = await this.#deps.feed.capture(post.link);
        if (jpeg === null || (post.images > 0 && description === null)) continue;
        const path = join(this.#dir, `${newId()}.jpg`);
        await writeFile(path, Buffer.from(jpeg, "base64"));
        out.push({ ...post, description, jpeg_path: path });
      } catch (error) {
        this.#deps.warn("capturing a post failed", error);
      }
    }
    return out;
  }

  async #share(
    candidates: readonly Candidate[],
    matches: readonly ChannelMatch[],
    signal: AbortSignal,
  ): Promise<void> {
    const deps = this.#deps;
    const decision = await decide(deps.model, deps.persona(), candidates, matches, signal);
    if (decision === null || signal.aborted) return;
    // She took a while: everything is checked again, whatever the model said.
    const now = deps.now();
    if (!this.#limits.canPost(now)) return;
    const { context, comment, link } = decision;
    if (this.#eligible([context]).length === 0) return;
    const path = candidates.find((c) => c.link === link)?.jpeg_path;
    const sink = deps.sink(context.platform);
    if (!path || !sink) return;
    try {
      await sink.send(
        context,
        {
          text: `${comment}\n<${THREADS}${link}>`,
          reply_to: null,
          files: [{ name: FILE_NAME, path, contentType: "image/jpeg" }],
          mentions: false,
        },
        signal,
      );
      this.#limits.notePost(now);
      await this.#save();
    } catch (error) {
      deps.warn("sharing a post failed", error);
    }
  }

  async #pause(why: Exclude<Pause, null>): Promise<void> {
    if (!this.#limits.pause(why)) return;
    for (const owner of this.#deps.owners()) {
      try {
        const sink = this.#deps.sink(owner.platform);
        if (!sink?.openDm) continue;
        const dm = await sink.openDm(owner);
        await sink.send(dm, { text: NOTICE[why], reply_to: null });
      } catch (error) {
        this.#deps.warn(`telling an owner failed: ${errorMessage(error)}`);
      }
    }
  }

  async #drop(candidates: readonly Candidate[]): Promise<void> {
    this.#waiting = null;
    await this.#remove(candidates);
    await this.#save();
  }

  async #remove(candidates: readonly Candidate[]): Promise<void> {
    for (const c of candidates) {
      if (c.jpeg_path !== null) await rm(c.jpeg_path, { force: true });
    }
  }

  async #save(): Promise<void> {
    const state = { limits: this.#limits.snapshot(), waiting: this.#waiting };
    await this.#deps.settings.save(state as unknown as JsonValue).catch((error: unknown) => {
      this.#deps.warn("saving the share state failed", error);
    });
  }
}
