// What the lines of a run carry beyond their text, and the replies' parents she did not see: the
// old turn's `#lookAround` and `#readFiles` (agent/turn.ts), on the transcript.
//
// - Reply chains. A line of the run that replies to a message the transcript does not have gets
//   that message's ancestors as notes (`TranscriptStore.attachParent`): the direct parent (when the
//   platform's quote did not come with the reply) and up to `history.reply_chain` in all, nearest
//   first, fetched from the platform within one `history.timeout_ms`. Nothing already in the
//   transcript is rewritten; a parent noted once is not noted again.
// - Images (`[modules.agent.vision]`, agent/vision.ts): those of the lines of the run, of the
//   message each replies to, and those the same person sent a moment before (not for a reply);
//   a link preview's picture counts as one of its message's (the platform's proxy copy),
//   each labelled with whose it is and where it was; only when the chat model takes images.
// - Files (`[modules.agent.files]`, agent/files.ts): read in the sandbox for people allowed
//   `tools.file`; without the sandbox nothing is read.
//
// Parts go to block 6 of this run only; the transcript keeps `[圖片: …]` / `[附件: …]`. The
// messages themselves (with their attachments' URLs, which the transcript does not keep) are
// remembered per place for a while (`RecentLines`).

import type { ContentPart } from "@miyoria/llm/llm";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  REPLY_PARENT_LABEL,
  SELF_QUOTE_NAME,
  type TranscriptEntry,
  type TranscriptStore,
} from "@miyoria/memory/transcript";
import { errorMessage } from "@miyoria/runtime/kernel";
import {
  type Attachment,
  AuthorizerKey,
  type ContextKey,
  contextKeyString,
  FileReaderKey,
  type IncomingMessage,
  imageType,
  type MessageRef,
  PlatformHistoriesKey,
  picturesOf,
  sameAccount,
  timestampMs,
} from "@miyoria/types";
import {
  type Agent,
  allowedUrl,
  fileParts,
  type ImageCandidate,
  imageParts,
  selectFiles,
  timeout,
} from "../../agent/src/index.js";

/** Messages of one place kept for their attachments and as reply parents. */
const LINES_PER_PLACE = 120;

/** The newest messages of each place, by platform id. */
export class RecentLines {
  readonly #places = new Map<string, Map<string, IncomingMessage>>();

  add(msg: IncomingMessage): void {
    const key = contextKeyString(msg.id.context);
    let lines = this.#places.get(key);
    if (lines === undefined) {
      lines = new Map();
      this.#places.set(key, lines);
    }
    lines.delete(msg.id.id);
    lines.set(msg.id.id, msg);
    while (lines.size > LINES_PER_PLACE) {
      const oldest = lines.keys().next().value;
      if (oldest === undefined) break;
      lines.delete(oldest);
    }
  }

  get(context: ContextKey, id: string): IncomingMessage | undefined {
    return this.#places.get(contextKeyString(context))?.get(id);
  }

  /** The messages of `context`, oldest first. */
  of(context: ContextKey): IncomingMessage[] {
    return [...(this.#places.get(contextKeyString(context))?.values() ?? [])];
  }
}

/** One run's lines, as the look around needs them. */
export interface AroundRun {
  session: string;
  context: ContextKey;
  turn: string;
  /** The lines the run is about (what woke her), oldest first. */
  inputs: readonly IncomingMessage[];
  signal: AbortSignal;
}

export class LookAround {
  readonly #agent: Agent;
  readonly #transcript: TranscriptStore;
  readonly recent = new RecentLines();

  constructor(agent: Agent, transcript: TranscriptStore) {
    this.#agent = agent;
    this.#transcript = transcript;
  }

  /** The files, then the images, of `run`; the reply chains noted on the way. Never throws. */
  async parts(run: AroundRun): Promise<ContentPart[]> {
    if (run.inputs.length === 0) return [];
    let parents: IncomingMessage[] = [];
    try {
      parents = await this.#parents(run);
    } catch (error) {
      if (run.signal.aborted) return [];
      this.#agent.log.debug({ err: errorMessage(error) }, "no reply parents for a run");
    }
    const [files, images] = await Promise.all([
      this.#files(run).catch((error: unknown) => {
        this.#agent.log.warn({ err: errorMessage(error) }, "could not read a run's files");
        return [] as ContentPart[];
      }),
      this.#images(run, parents).catch((error: unknown) => {
        this.#agent.log.debug({ err: errorMessage(error) }, "could not load a run's images");
        return [] as ContentPart[];
      }),
    ]);
    return [...files, ...images];
  }

  // ---- reply chains ----------------------------------------------------------------------------

  /** The direct parent of each input that replies to something (for its images). */
  async #parents(run: AroundRun): Promise<IncomingMessage[]> {
    const h = this.#agent.config.history;
    const entries = this.#transcript.tail(run.session).entries;
    const noted = new Set<string>();
    for (const e of entries) {
      if (e.kind === "note" && e.label === REPLY_PARENT_LABEL && e.message_id !== null) {
        noted.add(e.message_id);
      }
    }
    const found = await timeout(h.timeout_ms, run.signal, (signal) =>
      Promise.all(run.inputs.map((input) => this.#chain(run, input, entries, noted, signal))),
    );
    return found.flatMap((p) => (p === null ? [] : [p]));
  }

  /**
   * Notes `input`'s ancestors the transcript lacks (not those in `noted`, which it adds to);
   * returns its direct parent when known.
   */
  async #chain(
    run: AroundRun,
    input: IncomingMessage,
    entries: readonly TranscriptEntry[],
    noted: Set<string>,
    signal: AbortSignal,
  ): Promise<IncomingMessage | null> {
    const agent = this.#agent;
    const first = input.reply_to ?? null;
    if (first === null) return null;
    const said = (id: string) => entries.some((e) => e.message_id === id && e.kind !== "note");
    // In the transcript: no chain, but its images still count.
    if (said(first.id)) return this.recent.get(first.context, first.id) ?? null;
    const max = agent.config.history.reply_chain;
    const history = agent.ctx.services.get(PlatformHistoriesKey)?.get(input.id.context.platform);
    const chain: IncomingMessage[] = [];
    const seen = new Set<string>([input.id.id]);
    let ref: MessageRef | null = first;
    while (ref !== null && chain.length < Math.max(max, 1) && !seen.has(ref.id)) {
      seen.add(ref.id);
      if (said(ref.id)) break;
      const parent: IncomingMessage | null =
        this.recent.get(ref.context, ref.id) ??
        (max > 0 && history ? await history.fetch(ref, signal) : null);
      // Only what came with the reply then: the quote noted when the line came in.
      if (parent === null) break;
      chain.push(parent);
      ref = parent.reply_to ?? null;
    }
    for (const parent of chain) {
      if (noted.has(parent.id.id) || agent.isBlocked(parent.author.account)) continue;
      noted.add(parent.id.id);
      const own = agent.isSelf(parent.author.account);
      this.#transcript.attachParent(run.session, input.id.id, {
        author: own ? SELF_QUOTE_NAME : parent.author.display_name,
        text: parent.text,
        message_id: parent.id.id,
        person_id: own ? null : (agent.attitude(parent.author.account)?.person ?? null),
        turn: run.turn,
      });
    }
    return chain[0] ?? null;
  }

  // ---- images ----------------------------------------------------------------------------------

  async #images(run: AroundRun, parents: readonly IncomingMessage[]): Promise<ContentPart[]> {
    const agent = this.#agent;
    const vision = agent.config.vision;
    if (!vision.enabled || vision.max_images === 0) return [];
    if (agent.ctx.services.get(LlmRouterKey)?.takesImages("chat") !== true) return [];
    const candidates = this.#candidates(run, parents);
    if (candidates.length === 0) return [];
    const loaded = await agent.images.load(candidates, vision, run.signal);
    return imageParts(loaded, vision.detail);
  }

  /** `selectImages` (agent/vision.ts) over the remembered lines instead of a session. */
  #candidates(run: AroundRun, parents: readonly IncomingMessage[]): ImageCandidate[] {
    const cfg = this.#agent.config.vision;
    const out: ImageCandidate[] = [];
    const keys = new Set<string>();
    const consider = (
      a: Attachment,
      author: string,
      source: ImageCandidate["source"],
      agoMs = 0,
    ): void => {
      if (out.length >= cfg.max_images) return;
      const type = imageType(a);
      if (type === null) return;
      if (a.size != null && a.size > cfg.max_image_bytes) return;
      if (!allowedUrl(a.url, cfg.allowed_hosts)) return;
      const key = a.id ? `id:${a.id}` : `url:${a.url.split("?")[0]}`;
      if (keys.has(key)) return;
      keys.add(key);
      out.push({
        attachment: a,
        author,
        key,
        type,
        source,
        ...(source === "earlier" ? { ago_s: Math.max(0, Math.round(agoMs / 1000)) } : {}),
      });
    };
    // Attachments and the preview pictures of link embeds (the platform's proxy copies, which
    // `allowed_hosts` lets through; the third party's own server is never asked), forwards too.
    const attachmentsOf = (m: IncomingMessage) => [
      ...picturesOf(m),
      ...(m.forwarded ?? []).flatMap((f) => picturesOf(f)),
    ];
    const newest = [...run.inputs].reverse();
    for (const m of newest) {
      for (const a of attachmentsOf(m)) consider(a, m.author.display_name, "message");
    }
    for (const p of parents) {
      for (const a of attachmentsOf(p)) consider(a, p.author.display_name, "parent");
    }
    const ids = new Set(run.inputs.map((m) => m.id.id));
    const earlier = this.recent.of(run.context).reverse();
    for (const m of newest) {
      if (m.reply_to != null) continue;
      const until = timestampMs(m.ts);
      const since = until - cfg.same_author_window_ms;
      for (const e of earlier) {
        if (ids.has(e.id.id) || this.#agent.isSelf(e.author.account)) continue;
        const at = timestampMs(e.ts);
        if (at > until || at < since) continue;
        if (!sameAccount(e.author.account, m.author.account)) continue;
        for (const a of picturesOf(e)) consider(a, e.author.display_name, "earlier", until - at);
      }
    }
    return out;
  }

  // ---- files -----------------------------------------------------------------------------------

  async #files(run: AroundRun): Promise<ContentPart[]> {
    const agent = this.#agent;
    const cfg = agent.config.files;
    const services = agent.ctx.services;
    const reader = services.get(FileReaderKey);
    if (!cfg.enabled || cfg.max_files === 0 || reader === undefined) return [];
    const picked = selectFiles(run.inputs, reader, services.get(AuthorizerKey), cfg);
    if (picked.length === 0) return [];
    return await fileParts(picked, reader, run.signal, (name, error) =>
      agent.log.warn({ file: name, error }, "could not read file"),
    );
  }
}
