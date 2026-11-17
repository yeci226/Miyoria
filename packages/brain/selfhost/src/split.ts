// A long text line cut into messages of at most `limit` characters. Cuts fall between paragraphs,
// then between sentences, and only then inside a sentence (at a space when there is one). A fenced
// code block stays whole while it fits; a longer one is cut by lines, each piece fenced again. A
// mention (`<@id>`) is never cut.

const FENCED = /(```[\s\S]*?(?:```|$))/u;
const PARAGRAPH_END = /(?<=\n\n)/u;
const SENTENCE_END = /(?<=[。！？…]|[.!?](?=\s)|\n)/u;
const MENTION = /<[@#:][^>\s]*>/gu;

/** Cuts `text` into parts of at most `limit` UTF-16 units, none empty; one part when it fits. */
export function splitLine(text: string, limit: number): string[] {
  if (text.length <= limit) return text.trim() === "" ? [] : [text];
  const atoms: string[] = [];
  for (const [i, segment] of text.split(FENCED).entries()) {
    if (segment === "") continue;
    if (i % 2 === 1) atoms.push(...codeAtoms(segment, limit));
    else atoms.push(...proseAtoms(segment, limit));
  }
  const parts: string[] = [];
  let current = "";
  for (const atom of atoms) {
    if (current !== "" && current.length + atom.length > limit) {
      parts.push(current);
      current = "";
    }
    current += atom;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== "");
}

function proseAtoms(prose: string, limit: number): string[] {
  const out: string[] = [];
  for (const paragraph of prose.split(PARAGRAPH_END)) {
    if (paragraph.length <= limit) {
      out.push(paragraph);
      continue;
    }
    for (const sentence of paragraph.split(SENTENCE_END)) {
      if (sentence.length <= limit) out.push(sentence);
      else out.push(...hardCut(sentence, limit));
    }
  }
  return out;
}

/** A code block that does not fit goes by lines; every piece is a fenced block of its own. */
function codeAtoms(block: string, limit: number): string[] {
  if (block.length <= limit) return [block];
  const lines = block.split("\n");
  const open = (lines[0] ?? "```").startsWith("```") ? (lines[0] as string) : "```";
  const closed = lines.at(-1)?.trim() === "```" && lines.length > 1;
  const body = lines.slice(1, closed ? -1 : undefined);
  const room = Math.max(limit - open.length - 5, 1);
  const pieces: string[] = [];
  let current = "";
  const flush = () => {
    if (current !== "") pieces.push(`${open}\n${current}\n\`\`\``);
    current = "";
  };
  for (const line of body) {
    for (const piece of line.length > room ? hardCut(line, room) : [line]) {
      if (current !== "" && current.length + piece.length + 1 > room) flush();
      current = current === "" ? piece : `${current}\n${piece}`;
    }
  }
  flush();
  return pieces.length === 0 ? [block.slice(0, limit)] : pieces;
}

/** `text` in pieces of at most `limit`, at a space when one is in the second half. */
function hardCut(text: string, limit: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = limit;
    const space = rest.slice(0, cut).search(/\s\S*$/u);
    if (space >= limit / 2) cut = space + 1;
    const high = rest.charCodeAt(cut - 1);
    if (high >= 0xd800 && high <= 0xdbff) cut -= 1;
    for (const m of rest.matchAll(MENTION)) {
      const end = m.index + m[0].length;
      if (m.index < cut && end > cut) {
        if (m.index > 0) cut = m.index;
        break;
      }
    }
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest !== "") out.push(rest);
  return out;
}
