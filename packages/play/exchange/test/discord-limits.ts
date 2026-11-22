// Discord's limits on what a reply becomes (owner 2026-11-22, after a select with two chosen
// options was refused live and the member saw "didn't respond in time"). `packages/discord`'s
// `renderCard` turns a card into one Components V2 container: the title and every text or muted
// block a TextDisplay, a section a Section with its button, a row of buttons or a select an action
// row, an image a MediaGallery; the renderer cuts what is too long instead of failing, so a cut
// label is a bug here too. These checks are strict: whatever they let through, Discord takes as it
// is.

import type { Card, CardBlock, CommandReply, Modal } from "@miyoria/commands";

/** Discord's numbers (Components V2 message, string select, button, modal). */
export const DISCORD = {
  text: 4000 - 20,
  components: 40,
  rows: 5,
  buttonsPerRow: 5,
  buttonLabel: 80,
  customId: 100,
  options: 25,
  optionText: 100,
  placeholder: 150,
  modalTitle: 45,
  modalFields: 5,
  fieldLabel: 45,
  fieldPlaceholder: 100,
} as const;

const len = (s: string) => [...s].length;

/** What one block counts as, components and characters, the way `renderCard` renders it. */
function weigh(b: CardBlock): { components: number; text: number; row: boolean } {
  switch (b.type) {
    case "text":
    case "muted":
      return {
        components: b.text.trim() === "" ? 0 : 1,
        text: len(b.text) + (b.type === "muted" ? 3 * b.text.split("\n").length : 0),
        row: false,
      };
    case "section":
      return { components: 3, text: len(b.text), row: false };
    case "buttons":
      return {
        components: b.buttons.length === 0 ? 0 : 1 + b.buttons.length,
        text: 0,
        row: b.buttons.length > 0,
      };
    case "select":
      return {
        components: b.select.options.length === 0 ? 0 : 2,
        text: 0,
        row: b.select.options.length > 0,
      };
    default:
      return { components: 1, text: 0, row: false };
  }
}

/** Every way `reply` breaks one of Discord's limits (empty: it goes through as it is). */
export function discordProblems(reply: CommandReply): string[] {
  const card = reply.card as Card | undefined;
  if (!card) return len(reply.text) > DISCORD.text ? ["plain text over 4000"] : [];
  const out: string[] = [];
  const where = card.title ?? "(card)";
  let components = 1 + (card.title ? 1 : 0);
  let text = card.title ? len(card.title) + 4 : 0;
  let rows = 0;
  const ids = new Set<string>();
  const id = (x: string) => {
    if (len(x) > DISCORD.customId) out.push(`${where}: custom id over 100: ${x}`);
    if (ids.has(x)) out.push(`${where}: custom id twice: ${x}`);
    ids.add(x);
  };
  for (const b of card.blocks) {
    const w = weigh(b);
    components += w.components;
    text += w.text;
    if (w.row) rows++;
    if (b.type === "buttons") {
      if (b.buttons.length > DISCORD.buttonsPerRow)
        out.push(`${where}: ${b.buttons.length} buttons in a row`);
      for (const x of b.buttons) {
        if (len(x.label) === 0 || len(x.label) > DISCORD.buttonLabel)
          out.push(`${where}: button label ${x.label}`);
        if (!x.url) id(x.id);
      }
    }
    if (b.type === "section" && !b.button.url) id(b.button.id);
    if (b.type === "select") {
      const s = b.select;
      id(s.id);
      if (s.options.length < 1 || s.options.length > DISCORD.options)
        out.push(`${where}: select ${s.id} has ${s.options.length} options`);
      if (len(s.placeholder) > DISCORD.placeholder)
        out.push(`${where}: select placeholder over 150`);
      const values = s.options.map((o) => o.value);
      if (new Set(values).size !== values.length)
        out.push(`${where}: select ${s.id} repeats a value`);
      const chosen = s.options.filter((o) => o.default === true).length;
      if (chosen > (s.maxValues ?? 1))
        out.push(`${where}: select ${s.id} has ${chosen} chosen options`);
      for (const o of s.options) {
        if (len(o.label) === 0 || len(o.label) > DISCORD.optionText)
          out.push(`${where}: option label ${o.label}`);
        if (len(o.value) === 0 || len(o.value) > DISCORD.optionText)
          out.push(`${where}: option value ${o.value}`);
        if (o.description !== undefined && len(o.description) > DISCORD.optionText)
          out.push(`${where}: option description over 100: ${o.description}`);
      }
    }
  }
  if (rows > DISCORD.rows) out.push(`${where}: ${rows} action rows`);
  if (components > DISCORD.components) out.push(`${where}: ${components} components`);
  if (text > DISCORD.text) out.push(`${where}: ${text} characters of text`);
  return out;
}

/** Every way `modal` breaks one of Discord's limits. */
export function modalProblems(modal: Modal): string[] {
  const out: string[] = [];
  if (len(modal.title) === 0 || len(modal.title) > DISCORD.modalTitle)
    out.push(`modal title ${modal.title}`);
  if (len(modal.id) > DISCORD.customId) out.push(`modal id over 100: ${modal.id}`);
  if (modal.fields.length < 1 || modal.fields.length > DISCORD.modalFields)
    out.push(`modal has ${modal.fields.length} fields`);
  const ids = new Set<string>();
  for (const f of modal.fields) {
    if (ids.has(f.id)) out.push(`modal field twice: ${f.id}`);
    ids.add(f.id);
    if (len(f.label) === 0 || len(f.label) > DISCORD.fieldLabel)
      out.push(`field label ${f.label} (${len(f.label)})`);
    if (f.placeholder !== undefined && len(f.placeholder) > DISCORD.fieldPlaceholder)
      out.push(`field placeholder over 100: ${f.placeholder}`);
  }
  return out;
}
