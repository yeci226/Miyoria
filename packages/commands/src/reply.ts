// Command replies: plain text plus an optional structured card, files and a panel session.
//
// The card model is platform neutral. Discord renders it as a Components V2 container (see
// `@miyoria/discord`'s `render.ts`); text platforms (CLI, chat `!cmd`, extensions) use `text`,
// which the helpers below always fill in from the card.

import type { JsonValue } from "@miyoria/types";

/** How a notice reads. `warn` and `error` replies are always ephemeral (see `replyEphemeral`). */
export type Tone = "info" | "success" | "warn" | "error";

/** Accent colour of a card. `danger` is the red of confirm cards. */
export type Accent = Tone | "neutral" | "brand" | "danger";

export type ButtonStyle = "primary" | "secondary" | "success" | "danger";

export interface CardButton {
  /** Component id (`componentId(...)`). Ignored for link buttons. */
  id: string;
  label: string;
  style?: ButtonStyle;
  /** A link button: opens the URL instead of sending an interaction. */
  url?: string;
  disabled?: boolean;
  emoji?: string;
}

export interface SelectOption {
  label: string;
  value: string;
  description?: string;
  default?: boolean;
}

export interface CardSelect {
  id: string;
  placeholder: string;
  options: SelectOption[];
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
}

export type CardBlock =
  /** Markdown text. */
  | { type: "text"; text: string }
  /** Small, muted text (raw errors, hints, footers). */
  | { type: "muted"; text: string }
  /** Text with one button beside it. */
  | { type: "section"; text: string; button: CardButton }
  | { type: "separator"; large?: boolean }
  /** One row of up to five buttons. */
  | { type: "buttons"; buttons: CardButton[] }
  /** One select menu. */
  | { type: "select"; select: CardSelect }
  /** Shows one of the reply's `files`. */
  | { type: "file"; name: string };

export interface Card {
  accent: Accent;
  title: string | null;
  blocks: CardBlock[];
}

/** A file sent with the reply. */
export interface ReplyFile {
  name: string;
  data: Uint8Array | string;
  contentType?: string;
}

/**
 * Ask the platform to track the message the reply creates: only the invoker may use its
 * controls (`initiatorOnly`), and they are disabled after `ttlMs`.
 */
export interface ReplySession {
  ttlMs?: number;
  /** Default `true`. */
  initiatorOnly?: boolean;
  data?: JsonValue;
}

export interface CommandReply {
  /** Plain text: the whole reply on text platforms, the fallback everywhere else. */
  text: string;
  /**
   * `true` makes the reply visible to the invoker only. Visibility otherwise follows the
   * command's visibility (`CommandSpec.ephemeral`, overridable); see `replyEphemeral`.
   */
  ephemeral?: boolean;
  tone?: Tone;
  card?: Card;
  files?: ReplyFile[];
  session?: ReplySession;
}

export const CommandReply = {
  /** Plain text that follows the command's visibility. */
  text: (text: string): CommandReply => ({ text }),
  /** Plain text that follows the command's visibility (kept for older callers). */
  public: (text: string): CommandReply => ({ text, ephemeral: false }),
  /** Plain text only the invoker sees. */
  ephemeral: (text: string): CommandReply => ({ text, ephemeral: true }),
} as const;

/** One text field of a modal. */
export interface ModalField {
  id: string;
  label: string;
  /** Default `short`. */
  style?: "short" | "paragraph";
  placeholder?: string;
  /** Default `true`. */
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  value?: string;
}

export interface Modal {
  /** Component id the submission is routed by. */
  id: string;
  title: string;
  fields: ModalField[];
}

/**
 * The visibility rule, in one place: `warn` / `error` replies and replies that ask for it are
 * ephemeral; everything else follows the declaration (`declaredEphemeral`). A reply can make a
 * public command's answer ephemeral, never the other way round.
 */
export function replyEphemeral(declaredEphemeral: boolean, reply: CommandReply): boolean {
  if (reply.tone === "warn" || reply.tone === "error") return true;
  if (reply.ephemeral === true) return true;
  return declaredEphemeral;
}

// ---- helpers ---------------------------------------------------------------------------------

/** Plain text of a card: title, text blocks and muted lines (controls are left out). */
export function cardText(card: Card): string {
  const lines: string[] = [];
  if (card.title) lines.push(card.title);
  for (const block of card.blocks) {
    switch (block.type) {
      case "text":
      case "muted":
      case "section":
        lines.push(block.text);
        break;
      case "file":
        lines.push(`（附件：${block.name}）`);
        break;
      default:
        break;
    }
  }
  return lines.join("\n");
}

export interface CardOptions {
  accent?: Accent;
  title?: string | null;
  tone?: Tone;
  ephemeral?: boolean;
  files?: ReplyFile[];
  session?: ReplySession;
}

/** A reply made of a card; `text` is derived from it. */
export function cardReply(blocks: CardBlock[], options: CardOptions = {}): CommandReply {
  const card: Card = {
    accent: options.accent ?? options.tone ?? "neutral",
    title: options.title ?? null,
    blocks,
  };
  const reply: CommandReply = { text: cardText(card), card };
  if (options.tone) reply.tone = options.tone;
  if (options.ephemeral) reply.ephemeral = true;
  if (options.files && options.files.length > 0) reply.files = options.files;
  if (options.session) reply.session = options.session;
  return reply;
}

/**
 * A short system notice: one sentence, optionally followed by a muted detail line (raw error
 * text, a hint). `warn` and `error` notices are always ephemeral.
 */
export function notice(tone: Tone, text: string, detail?: string | null): CommandReply {
  const blocks: CardBlock[] = [{ type: "text", text }];
  if (detail) blocks.push({ type: "muted", text: detail });
  return cardReply(blocks, { tone });
}

export interface ConfirmOptions {
  title: string;
  text: string;
  /** Component id of the confirm button. */
  confirmId: string;
  /** Component id of the cancel button. */
  cancelId: string;
  confirmLabel?: string;
  detail?: string;
}

/** The red confirm card shown before every destructive action. */
export function confirm(options: ConfirmOptions): CommandReply {
  const blocks: CardBlock[] = [{ type: "text", text: options.text }];
  if (options.detail) blocks.push({ type: "muted", text: options.detail });
  blocks.push({
    type: "buttons",
    buttons: [
      { id: options.confirmId, label: options.confirmLabel ?? "確認", style: "danger" },
      { id: options.cancelId, label: "取消", style: "secondary" },
    ],
  });
  // A session: only the invoker may confirm, and the buttons are disabled after a while.
  return cardReply(blocks, {
    accent: "danger",
    title: options.title,
    ephemeral: true,
    session: {},
  });
}

/** The card a confirm turns into when it is cancelled. */
export function cancelled(text = "已取消。"): CommandReply {
  return notice("info", text);
}

export interface Page<T> {
  items: T[];
  /** Zero-based, clamped to the available pages. */
  page: number;
  pages: number;
}

/** Slices `items` into pages of `size`. */
export function pageOf<T>(items: readonly T[], page: number, size: number): Page<T> {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const index = Math.min(Math.max(0, Math.trunc(page)), pages - 1);
  return { items: items.slice(index * size, (index + 1) * size), page: index, pages };
}

/**
 * Previous / next buttons for a paged card, or nothing when there is only one page. `id(page)`
 * builds the component id of a page.
 */
export function pageButtons(page: Page<unknown>, id: (page: number) => string): CardBlock[] {
  if (page.pages <= 1) return [];
  return [
    {
      type: "buttons",
      buttons: [
        {
          id: id(page.page - 1),
          label: "上一頁",
          style: "secondary",
          disabled: page.page === 0,
        },
        {
          id: id(page.page + 1),
          label: "下一頁",
          style: "secondary",
          disabled: page.page >= page.pages - 1,
        },
      ],
    },
    { type: "muted", text: `第 ${page.page + 1} / ${page.pages} 頁` },
  ];
}
