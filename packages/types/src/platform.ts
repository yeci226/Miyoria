import type {
  AccountRef,
  Attachment,
  ContextKey,
  Embed,
  IncomingMessage,
  MessageRef,
  Sticker,
} from "@miyoria/contracts/wire";
import type { PlatformId } from "./ids.js";
import { serviceKey } from "./service-key.js";

// The shapes of accounts, contexts and messages are contracts (`@miyoria/contracts/wire`). What
// is here works on them: the text forms, the equality checks, and the in-process services a
// platform provides.
export type {
  AccountRef,
  Attachment,
  Author,
  ContextKey,
  ContextKind,
  Embed,
  ForwardedMessage,
  IncomingMessage,
  MentionedAccount,
  MessageRef,
  QuotedMessage,
  Sticker,
} from "@miyoria/contracts/wire";

/** `"<platform>:<id>"`, e.g. `"discord:1234"` (the form used in config and `edited_by` fields). */
export function accountRefString(account: AccountRef): string {
  return `${account.platform}:${account.id}`;
}

export function sameAccount(a: AccountRef, b: AccountRef): boolean {
  return a.platform === b.platform && a.id === b.id;
}

/**
 * Display form, used in lane keys and logs: `discord:<guild>:<channel>`, `discord:dm:<channel>`.
 * Voice contexts get a `voice:` infix (`discord:<guild>:voice:<channel>`): on Discord a voice
 * channel's text chat has the same channel id as the voice channel itself.
 * The kind is otherwise not part of it, so it is not a unique key; see `contextKeyEquals`.
 */
export function contextKeyString(key: ContextKey): string {
  const voice = key.kind === "voice" ? "voice:" : "";
  return key.scope === null
    ? `${key.platform}:dm:${voice}${key.channel}`
    : `${key.platform}:${key.scope}:${voice}${key.channel}`;
}

export function contextKeyEquals(a: ContextKey, b: ContextKey): boolean {
  return (
    a.platform === b.platform && a.scope === b.scope && a.channel === b.channel && a.kind === b.kind
  );
}

/** Image types she can look at. */
export const IMAGE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** The image type of an attachment (`content_type`, else the file extension), if it is one. */
export function imageType(a: Attachment): string | null {
  const declared = a.content_type?.split(";")[0]?.trim().toLowerCase() ?? null;
  if (declared !== null && declared !== "") return IMAGE_TYPES.includes(declared) ? declared : null;
  const ext = a.filename.split(".").at(-1)?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS[ext] ?? null;
}

/** png / jpeg / webp / gif by their first bytes, else `null`: what the bytes are, not what was said. */
export function sniffImage(bytes: Uint8Array): string | null {
  const at = (i: number, text: string) =>
    [...text].every((c, k) => bytes[i + k] === c.charCodeAt(0));
  if (bytes[0] === 0x89 && at(1, "PNG")) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (at(0, "GIF87a") || at(0, "GIF89a")) return "image/gif";
  if (at(0, "RIFF") && at(8, "WEBP")) return "image/webp";
  return null;
}

/** `[圖片: cat.png(一隻橘貓)]` for images, `[附件: notes.pdf]` for other files. */
export function attachmentLabel(a: Attachment): string {
  const alt = a.description?.trim() ?? "";
  const kind = imageType(a) === null ? "附件" : "圖片";
  return alt === "" ? `[${kind}: ${a.filename}]` : `[${kind}: ${a.filename}(${alt})]`;
}

/**
 * The preview picture of a link embed (its large image, else its thumbnail) as an attachment of
 * its message, so it is looked at, limited and labelled like one. The URL is the platform's own
 * proxy copy (`Embed.image`), never the original. The platform checked that it is a picture but
 * does not say which kind, so the type is a guess from the name; the download is checked again
 * against what the server says and the bytes.
 */
export function embedPicture(e: Embed): Attachment | null {
  const url = (e.image ?? e.thumbnail)?.trim() ?? "";
  if (url === "") return null;
  let name = "";
  let format = "";
  try {
    const parsed = new URL(url);
    name = decodeURIComponent(parsed.pathname.split("/").at(-1) ?? "");
    format = parsed.searchParams.get("format")?.toLowerCase() ?? "";
  } catch {
    return null;
  }
  const ext = name.split(".").at(-1)?.toLowerCase() ?? "";
  const type = IMAGE_EXTENSIONS[ext] ?? IMAGE_EXTENSIONS[format] ?? "image/jpeg";
  return { url, filename: name === "" ? "preview" : name, content_type: type };
}

/** The attachments of a message and the preview pictures of its embeds, in that order. */
export function picturesOf(msg: {
  attachments: readonly Attachment[];
  embeds?: readonly Embed[] | undefined;
}): Attachment[] {
  const out = [...msg.attachments];
  for (const e of msg.embeds ?? []) {
    const picture = embedPicture(e);
    if (picture !== null) out.push(picture);
  }
  return out;
}

function embedLabel(e: Embed): string | null {
  const parts = [e.title, e.description].map((s) => s?.trim() ?? "").filter((s) => s !== "");
  const body = parts.join(" - ");
  if (body === "" && (e.url === null || e.url.trim() === "")) return null;
  const url = e.url?.trim() ?? "";
  return `[嵌入: ${body}${body !== "" && url !== "" ? " " : ""}${url}]`;
}

/** Text of a message body with its stickers, embeds and attachments noted inline. */
function bodyText(
  text: string,
  attachments: readonly Attachment[],
  stickers: readonly Sticker[],
  embeds: readonly Embed[],
): string {
  const parts = [text.trim()];
  for (const s of stickers) parts.push(`[貼圖: ${s.name}]`);
  for (const e of embeds) {
    parts.push(embedLabel(e) ?? "");
    if (embedPicture(e) !== null) parts.push("[圖片: 連結預覽]");
  }
  for (const a of attachments) parts.push(attachmentLabel(a));
  return parts.filter((p) => p !== "").join(" ");
}

/**
 * A message as one line of plain text: its text, then stickers, embeds, attachments and
 * forwarded messages noted inline (`[貼圖: …]`, `[嵌入: …]`, `[圖片: …]`, `[轉傳: …]`). This
 * is what history, the message log and memory see of it.
 */
export function incomingText(msg: IncomingMessage): string {
  let out = bodyText(msg.text, msg.attachments, msg.stickers ?? [], msg.embeds ?? []);
  for (const f of msg.forwarded ?? []) {
    const body = bodyText(f.text, f.attachments, f.stickers, f.embeds);
    if (body === "") continue;
    out += `${out === "" ? "" : " "}[轉傳: ${body}]`;
  }
  return out;
}

/**
 * A file that goes out with a message: an artifact of the artifact store, named by its id. Never a
 * host path and never bytes: the platform sink asks the `AttachmentSource` for the content when it
 * sends, and the source checks again that the destination may see it (v5-architecture §11.2).
 */
export interface OutgoingAttachment {
  artifact_id: string;
}

export interface OutgoingMessage {
  /** May be empty when `attachments` is not. */
  text: string;
  reply_to: MessageRef | null;
  /**
   * Files sent with the message. A sink without `attachmentLimit` cannot take any: senders check
   * `attachmentLimit` first and do not put attachments on a message for such a sink.
   */
  attachments?: OutgoingAttachment[];
}

/** Why an attachment did not go out. */
export type AttachmentRefusal =
  /** Nothing here can resolve artifacts (no artifact store, or the platform takes no files). */
  | "unavailable"
  /** No such artifact, or it is gone (expired, deleted, taken down). */
  | "not_found"
  /** The destination may not see it. */
  | "not_visible"
  /** It may never leave as a file (a song cover). */
  | "not_shareable"
  /** Larger than the platform takes there. */
  | "too_large"
  /** More files than one message takes. */
  | "too_many"
  /** Its bytes are missing or are not the ones recorded. */
  | "damaged"
  /** The platform refused the upload (no permission to attach files there, its own limits). */
  | "platform";

/** An attachment could not be sent; `message` says why in plain words (for logs and the tool). */
export class AttachmentError extends Error {
  override readonly name = "AttachmentError";

  constructor(
    readonly code: AttachmentRefusal,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/** The `AttachmentError` in `error` or its causes, if any. */
export function attachmentErrorOf(error: unknown): AttachmentError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current instanceof Error; depth++) {
    if (current instanceof AttachmentError) return current;
    current = current.cause;
  }
  return null;
}

/** An attachment resolved for one send: its upload name, sniffed type and bytes. */
export interface AttachmentFile {
  artifact_id: string;
  /** Cleaned by the artifact store; never a path. */
  filename: string;
  content_type: string;
  size: number;
  data: Uint8Array;
}

export interface AttachmentOpenOptions {
  /** The largest file the platform takes at the destination, in bytes. */
  maxBytes: number;
  signal?: AbortSignal;
}

/**
 * Resolves outgoing attachments at send time. Provided by the app over the artifact store
 * (`AttachmentSourceKey`); platform sinks look it up per message.
 */
export interface AttachmentSource {
  /**
   * The content of artifact `artifactId` for a message into `destination`. Checks, now, that the
   * artifact is still there, may be downloaded, is visible at the destination and fits `maxBytes`.
   * Throws an `AttachmentError` otherwise.
   */
  open(
    artifactId: string,
    destination: ContextKey,
    options: AttachmentOpenOptions,
  ): Promise<AttachmentFile>;
}

export const AttachmentSourceKey = serviceKey<AttachmentSource>("AttachmentSource");

/**
 * Implemented by platform adapters so the scheduler can execute output actions without knowing
 * which platform (or which account) it talks to.
 */
/** What `send` answers. `blocked`: the sink replaced the text with the filtered line (the rule). */
export type SentMessage = MessageRef & { blocked?: string };

export interface PlatformSink {
  readonly platform: PlatformId;
  send(context: ContextKey, message: OutgoingMessage, signal?: AbortSignal): Promise<SentMessage>;
  react(message: MessageRef, emoji: string, signal?: AbortSignal): Promise<void>;
  typing(context: ContextKey, signal?: AbortSignal): Promise<void>;
  /**
   * The largest attachment `send` takes in `context`, in bytes; `null` when it takes none there.
   * Optional: a platform without it has no attachments at all, and `send` ignores them.
   */
  attachmentLimit?(context: ContextKey): number | null;
  /**
   * Sets the status line of the voice channel `context` (`""` clears it). Optional; platforms
   * without one leave it out.
   */
  setVoiceStatus?(context: ContextKey, status: string, signal?: AbortSignal): Promise<void>;
  /**
   * Human name of a context, e.g. `"Miyoria / 雜談"` (server / channel), for the admin panel.
   * `null` when unknown. Optional.
   */
  describe?(context: ContextKey, signal?: AbortSignal): Promise<string | null>;
  /**
   * The DM context with `account` (opening the DM channel if needed), for messages she sends to
   * someone directly. Optional; platforms without DMs leave it out.
   */
  openDm?(account: AccountRef, signal?: AbortSignal): Promise<ContextKey>;
  /**
   * The markup that mentions `account` in a message (Discord: `<@id>`), or `null` when it
   * cannot be mentioned. Optional; without it her `@name` stays plain text.
   */
  mention?(account: AccountRef): string | null;
}

/**
 * Registry of platform sinks, keyed by platform. Created by the app at boot and provided as the
 * `PlatformSinksKey` service; platform modules register their sink on start and unregister on
 * stop.
 */
export class PlatformSinks {
  readonly #sinks = new Map<PlatformId, PlatformSink>();

  register(sink: PlatformSink): void {
    this.#sinks.set(sink.platform, sink);
  }

  unregister(platform: PlatformId): void {
    this.#sinks.delete(platform);
  }

  get(platform: PlatformId): PlatformSink | undefined {
    return this.#sinks.get(platform);
  }
}

export const PlatformSinksKey = serviceKey<PlatformSinks>("PlatformSinks");

/** Which messages `PlatformHistory.recent` returns. */
export interface HistoryQuery {
  /** Only messages before this message id (`null`: the newest). */
  before: string | null;
  /** Only messages after this message id (the lines that followed it); `before` is then ignored. */
  after?: string | null;
  limit: number;
}

/**
 * Reads earlier messages from a platform, for context she did not see live (a session started
 * cold after a restart, the parent of a reply). Results are mapped like live messages.
 */
export interface PlatformHistory {
  readonly platform: PlatformId;
  /** Up to `query.limit` messages of `context`, oldest first. */
  recent(
    context: ContextKey,
    query: HistoryQuery,
    signal?: AbortSignal,
  ): Promise<IncomingMessage[]>;
  /** One message; `null` when it does not exist or cannot be read. */
  fetch(ref: MessageRef, signal?: AbortSignal): Promise<IncomingMessage | null>;
}

/**
 * Registry of platform histories, keyed by platform (like `PlatformSinks`). Created by the app
 * at boot and provided as `PlatformHistoriesKey`; platform modules register on start (once
 * connected) and unregister on stop.
 */
export class PlatformHistories {
  readonly #histories = new Map<PlatformId, PlatformHistory>();

  register(history: PlatformHistory): void {
    this.#histories.set(history.platform, history);
  }

  unregister(platform: PlatformId): void {
    this.#histories.delete(platform);
  }

  get(platform: PlatformId): PlatformHistory | undefined {
    return this.#histories.get(platform);
  }
}

export const PlatformHistoriesKey = serviceKey<PlatformHistories>("PlatformHistories");
