// Renders `CommandReply`s as Discord Components V2 messages (a container with text displays,
// sections, separators, action rows and files) and modals. Never embeds.

import type {
  ButtonStyle as AccentButtonStyle,
  Card,
  CardBlock,
  CardButton,
  CommandReply,
  Modal,
} from "@miyoria/commands";
import { getLogger } from "@miyoria/runtime/kernel";
import {
  type APIActionRowComponent,
  type APIButtonComponent,
  type APIComponentInContainer,
  type APIComponentInMessageActionRow,
  type APIContainerComponent,
  type APIMessageTopLevelComponent,
  type APIModalInteractionResponseCallbackData,
  type APISectionComponent,
  type APIStringSelectComponent,
  ButtonStyle,
  ComponentType,
  MessageFlags,
  SeparatorSpacingSize,
  TextInputStyle,
} from "discord.js";
import { splitMessage } from "./split.js";

const log = getLogger("discord.render");

/** Total text a Components V2 message may carry. */
export const MAX_V2_TEXT = 4000;
/** Components (including nested ones) a message may carry. */
export const MAX_V2_COMPONENTS = 40;
/** Leave room for headings and muted lines when splitting plain text. */
const TEXT_CHUNK = 3800;
/** A media gallery item's description (its alt text) is at most this long. */
const MAX_ALT_CHARS = 1024;

/** Mentions in command replies never ping anyone. */
export const NO_MENTIONS = { parse: [] as never[] };

export const ACCENT_COLORS: Readonly<Record<Card["accent"], number | null>> = {
  neutral: null,
  brand: 0x6fb6e8,
  info: 0x5b8def,
  success: 0x3ba55d,
  warn: 0xf0a020,
  error: 0xed4245,
  danger: 0xed4245,
};

/** A file as discord.js takes it. */
export interface PayloadFile {
  attachment: Buffer;
  name: string;
  contentType?: string;
}

/** One message body (for reply, editReply, followUp, update and REST edits). */
export interface MessagePayload {
  components: APIMessageTopLevelComponent[];
  /** `IsComponentsV2`, plus `Ephemeral` for new ephemeral messages. */
  flags: number;
  files?: PayloadFile[];
  allowedMentions: typeof NO_MENTIONS;
}

function buttonStyle(style: AccentButtonStyle | undefined): ButtonStyle {
  switch (style) {
    case "primary":
      return ButtonStyle.Primary;
    case "success":
      return ButtonStyle.Success;
    case "danger":
      return ButtonStyle.Danger;
    default:
      return ButtonStyle.Secondary;
  }
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

function button(b: CardButton): APIButtonComponent {
  const emoji = b.emoji ? { emoji: { name: b.emoji } } : {};
  if (b.url) {
    return {
      type: ComponentType.Button,
      style: ButtonStyle.Link,
      url: b.url,
      label: truncate(b.label, 80),
      disabled: b.disabled ?? false,
      ...emoji,
    };
  }
  return {
    type: ComponentType.Button,
    style: buttonStyle(b.style) as Exclude<ButtonStyle, ButtonStyle.Link | ButtonStyle.Premium>,
    custom_id: b.id,
    label: truncate(b.label, 80),
    disabled: b.disabled ?? false,
    ...emoji,
  };
}

function row(
  components: APIComponentInMessageActionRow[],
): APIActionRowComponent<APIComponentInMessageActionRow> {
  return { type: ComponentType.ActionRow, components };
}

function select(block: Extract<CardBlock, { type: "select" }>): APIStringSelectComponent {
  const s = block.select;
  const options = s.options.slice(0, 25).map((o) => ({
    label: truncate(o.label, 100),
    value: truncate(o.value, 100),
    ...(o.description ? { description: truncate(o.description, 100) } : {}),
    ...(o.default ? { default: true } : {}),
  }));
  return {
    type: ComponentType.StringSelect,
    custom_id: s.id,
    placeholder: truncate(s.placeholder, 150),
    options,
    min_values: s.minValues ?? 1,
    max_values: Math.min(s.maxValues ?? 1, Math.max(1, options.length)),
    disabled: s.disabled ?? false,
  };
}

/** Counts a component and its children (Discord's limit counts nested ones). */
function count(component: { type: number; components?: unknown[]; accessory?: unknown }): number {
  let n = 1;
  for (const child of component.components ?? []) {
    n += count(child as { type: number; components?: unknown[] });
  }
  if (component.accessory) n += 1;
  return n;
}

function textLength(blocks: readonly CardBlock[], title: string | null): number {
  let n = title ? [...title].length + 4 : 0;
  for (const b of blocks) {
    if (b.type === "text" || b.type === "muted" || b.type === "section") n += [...b.text].length;
  }
  return n;
}

/** The container of a card. Over-long text is cut (with a log line) to fit the message. */
export function renderCard(card: Card, files: readonly string[] = []): APIContainerComponent {
  const inner: APIComponentInContainer[] = [];
  let budget = MAX_V2_TEXT - 20;
  if (textLength(card.blocks, card.title) > budget) {
    log.warn({ title: card.title }, "card text is too long for one message, cut");
  }
  const text = (content: string): string => {
    const cut = truncate(content, Math.max(1, budget));
    budget -= [...cut].length;
    return cut;
  };
  if (card.title) {
    inner.push({ type: ComponentType.TextDisplay, content: text(`### ${card.title}`) });
  }
  const shownFiles = new Set<string>();
  for (const block of card.blocks) {
    switch (block.type) {
      case "text":
        if (block.text.trim() !== "") {
          inner.push({ type: ComponentType.TextDisplay, content: text(block.text) });
        }
        break;
      case "muted":
        if (block.text.trim() !== "") {
          const lines = block.text.split("\n").map((l) => (l.trim() === "" ? l : `-# ${l}`));
          inner.push({ type: ComponentType.TextDisplay, content: text(lines.join("\n")) });
        }
        break;
      case "section": {
        const section: APISectionComponent = {
          type: ComponentType.Section,
          components: [{ type: ComponentType.TextDisplay, content: text(block.text) }],
          accessory: button(block.button),
        };
        inner.push(section);
        break;
      }
      case "separator":
        inner.push({
          type: ComponentType.Separator,
          divider: true,
          spacing: block.large ? SeparatorSpacingSize.Large : SeparatorSpacingSize.Small,
        });
        break;
      case "buttons":
        if (block.buttons.length > 0) inner.push(row(block.buttons.slice(0, 5).map(button)));
        break;
      case "select":
        if (block.select.options.length > 0) inner.push(row([select(block)]));
        break;
      case "file":
        shownFiles.add(block.name);
        inner.push({ type: ComponentType.File, file: { url: `attachment://${block.name}` } });
        break;
      case "image":
        shownFiles.add(block.name);
        inner.push({
          type: ComponentType.MediaGallery,
          items: [
            {
              media: { url: `attachment://${block.name}` },
              ...(block.alt ? { description: truncate(block.alt, MAX_ALT_CHARS) } : {}),
            },
          ],
        });
        break;
    }
  }
  // Attached files are only shown when a component references them.
  for (const name of files) {
    if (!shownFiles.has(name)) {
      inner.push({ type: ComponentType.File, file: { url: `attachment://${name}` } });
    }
  }
  if (inner.length === 0) inner.push({ type: ComponentType.TextDisplay, content: "……" });
  const container: APIContainerComponent = { type: ComponentType.Container, components: inner };
  const accent = ACCENT_COLORS[card.accent];
  if (accent !== null) container.accent_color = accent;
  while (count(container) > MAX_V2_COMPONENTS && container.components.length > 1) {
    log.warn({ title: card.title }, "card has too many components, dropping the last one");
    container.components.pop();
  }
  return container;
}

function payloadFiles(reply: CommandReply): PayloadFile[] {
  return (reply.files ?? []).map((f) => ({
    attachment: typeof f.data === "string" ? Buffer.from(f.data, "utf8") : Buffer.from(f.data),
    name: f.name,
    ...(f.contentType ? { contentType: f.contentType } : {}),
  }));
}

/**
 * The messages of a reply: the card (or the plain text, split into ~3800-character chunks, as
 * plain containers). Files go with the first message.
 */
export function renderReply(reply: CommandReply, ephemeral: boolean): MessagePayload[] {
  const flags = MessageFlags.IsComponentsV2 | (ephemeral ? MessageFlags.Ephemeral : 0);
  const files = payloadFiles(reply);
  const names = files.map((f) => f.name);
  if (reply.card) {
    const payload: MessagePayload = {
      components: [renderCard(reply.card, names)],
      flags,
      allowedMentions: NO_MENTIONS,
    };
    if (files.length > 0) payload.files = files;
    return [payload];
  }
  const chunks = splitMessage(reply.text.trim() === "" ? "……" : reply.text, TEXT_CHUNK);
  return chunks.map((chunk, i) => {
    const card: Card = { accent: "neutral", title: null, blocks: [{ type: "text", text: chunk }] };
    const payload: MessagePayload = {
      components: [renderCard(card, i === 0 ? names : [])],
      flags,
      allowedMentions: NO_MENTIONS,
    };
    if (i === 0 && files.length > 0) payload.files = files;
    return payload;
  });
}

/** Whether the components contain a usable (non-link) button or a select menu. */
export function hasControls(components: readonly APIMessageTopLevelComponent[]): boolean {
  const walk = (c: unknown): boolean => {
    if (typeof c !== "object" || c === null) return false;
    const o = c as Record<string, unknown>;
    if (o.type === ComponentType.Button && o.style !== ButtonStyle.Link && !o.disabled) return true;
    if (o.type === ComponentType.StringSelect && !o.disabled) return true;
    if (Array.isArray(o.components) && o.components.some(walk)) return true;
    return o.accessory !== undefined && walk(o.accessory);
  };
  return components.some(walk);
}

/** The same components with every button and select disabled (link buttons stay usable). */
export function disableComponents(
  components: readonly APIMessageTopLevelComponent[],
): APIMessageTopLevelComponent[] {
  const walk = (c: unknown): unknown => {
    if (typeof c !== "object" || c === null) return c;
    const copy: Record<string, unknown> = { ...(c as Record<string, unknown>) };
    const type = copy.type;
    if (type === ComponentType.Button && copy.style !== ButtonStyle.Link) copy.disabled = true;
    if (type === ComponentType.StringSelect) copy.disabled = true;
    if (Array.isArray(copy.components)) copy.components = copy.components.map(walk);
    if (copy.accessory) copy.accessory = walk(copy.accessory);
    return copy;
  };
  return components.map((c) => walk(c) as APIMessageTopLevelComponent);
}

/** A modal (title ≤ 45, at most five text inputs). */
export function renderModal(modal: Modal): APIModalInteractionResponseCallbackData {
  return {
    custom_id: modal.id,
    title: truncate(modal.title, 45),
    components: modal.fields.slice(0, 5).map((f) => ({
      type: ComponentType.ActionRow,
      components: [
        {
          type: ComponentType.TextInput,
          custom_id: f.id,
          label: truncate(f.label, 45),
          style: f.style === "paragraph" ? TextInputStyle.Paragraph : TextInputStyle.Short,
          required: f.required ?? true,
          ...(f.placeholder ? { placeholder: truncate(f.placeholder, 100) } : {}),
          ...(f.minLength !== undefined ? { min_length: f.minLength } : {}),
          ...(f.maxLength !== undefined ? { max_length: f.maxLength } : {}),
          ...(f.value !== undefined ? { value: f.value } : {}),
        },
      ],
    })),
  };
}
