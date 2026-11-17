// The sections of a document: a small fixed set per kind, so a document reads the same way every
// time, a prompt card can pick what matters first, and the segment pass has to say what kind of
// thing a line is. Stored by key; shown to her (and to the model) by label.
//
// - A person: how to address them comes first because every reply needs it; `basics` are the
//   lasting facts; `likes` what they like and do not; `recent` what is going on with them lately
//   (the lines most often replaced); `promises` what the two of them agreed; `jokes` the running
//   gags; `her_view` what she thinks of them, the only section that holds conclusions rather than
//   things said. Shown as 我的看法: everything she reads is in the first person.
// - A place: what it is, its rules, who is usually there, what is going on, its gags.
// - A topic: the points, the details, where they came from, what she still wants to find out.
// - Herself: who she is lately, what she thinks, what she wants to do, what she learned.
// - `misc` in every kind: what an import or a tool call of hers could not place.

import type { DocumentKind } from "./schema.js";

export interface SectionDef {
  /** The stored key. */
  key: string;
  /** What she and the model read. */
  label: string;
}

/** The sections of each kind of document, in the order they are shown. */
export const SECTIONS: Readonly<Record<DocumentKind, readonly SectionDef[]>> = {
  person: [
    { key: "address", label: "稱呼" },
    { key: "basics", label: "基本" },
    { key: "likes", label: "喜好" },
    { key: "recent", label: "近況" },
    { key: "promises", label: "約定" },
    { key: "jokes", label: "梗" },
    { key: "her_view", label: "我的看法" },
    { key: "misc", label: "其他" },
  ],
  place: [
    { key: "about", label: "簡介" },
    { key: "rules", label: "規矩" },
    { key: "regulars", label: "常客" },
    { key: "recent", label: "近況" },
    { key: "jokes", label: "梗" },
    { key: "misc", label: "其他" },
  ],
  topic: [
    { key: "summary", label: "重點" },
    { key: "details", label: "細節" },
    { key: "sources", label: "來源" },
    { key: "open", label: "待查" },
    { key: "misc", label: "其他" },
  ],
  self: [
    { key: "recent", label: "最近" },
    { key: "thoughts", label: "想法" },
    { key: "wants", label: "想做的事" },
    { key: "learned", label: "學到的" },
    { key: "misc", label: "其他" },
  ],
};

/** The section every kind has for what fits nowhere else. */
export const MISC_SECTION = "misc";
/** The section of a person document that holds what she thinks of them. */
export const HER_VIEW_SECTION = "her_view";
/** Other spellings of a label the model or an old page may use. */
const ALIASES: Readonly<Record<string, string>> = { 她的看法: "her_view", 看法: "her_view" };

/** The key of `name` (a key or a label) among `kind`'s sections; `null`: not one of them. */
export function sectionKey(kind: DocumentKind, name: string): string | null {
  const wanted = name.trim();
  const found = SECTIONS[kind].find((s) => s.key === wanted || s.label === wanted);
  if (found) return found.key;
  const alias = ALIASES[wanted];
  return alias !== undefined && SECTIONS[kind].some((s) => s.key === alias) ? alias : null;
}

/** The label of section `key` of a `kind` document (the key itself when unknown). */
export function sectionLabel(kind: DocumentKind, key: string): string {
  return SECTIONS[kind].find((s) => s.key === key)?.label ?? key;
}

/** Where section `key` comes in a `kind` document; unknown sections come last. */
export function sectionOrder(kind: DocumentKind, key: string): number {
  const at = SECTIONS[kind].findIndex((s) => s.key === key);
  return at < 0 ? SECTIONS[kind].length : at;
}
