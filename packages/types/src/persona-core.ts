// Her character core (docs/design/v2-architecture.md §3.4): the 3–5 sentences of who she is
// that the short Deliberate prompts (Appraise, Plan, Reflect) put in their system message
// instead of the whole chat persona (speaking style, `<silence/>` / `<emo>` rules, examples).
// Pure: taken from the persona text the profile has (`PersonaHandle.corePrompt()`).

/** Sentences kept, and the most characters they may take. */
export const CORE_SENTENCES = 5;
export const CORE_CHARS = 420;

/** Bullets that describe who she is, preferred after the opening paragraph. */
const CHARACTER_BULLET = /^(個性|性格|personality)/i;
/** One line of a leading tag block: `【PERSONA_LOAD】` or an `UPPER_SNAKE` tag. */
const TAG_LINE = /^(?:【[^】]*】|[A-Z][A-Z0-9_]*)$/;

function sentences(text: string): string[] {
  return text
    .split(/(?<=[。!?！？])|\n/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function plain(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/\*\*|__|`/g, "")
    .trim();
}

/**
 * The first few sentences of `persona`: its title (`你是 DeepSeek-chan`), the opening paragraph
 * and the bullet about her personality, at most `maxSentences` sentences and `maxChars`
 * characters. Sections after the first heading of a second section (style, examples) are not
 * read. Empty when `persona` is.
 */
export function characterCore(
  persona: string,
  maxSentences = CORE_SENTENCES,
  maxChars = CORE_CHARS,
): string {
  const lines = persona.split("\n");
  const picked: string[] = [];
  let headings = 0;
  let opening = true;
  let paragraph = false;
  const bullets: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === "") {
      if (paragraph) opening = false;
      continue;
    }
    // A tag block before the first heading (【PERSONA_LOAD】, then one UPPER_SNAKE tag a line) is
    // for the chat model; the core is the character's words, so it starts at the heading.
    if (headings === 0 && picked.length === 0 && TAG_LINE.test(line)) continue;
    if (line.startsWith("#")) {
      headings += 1;
      if (headings > 1) break;
      picked.push(plain(line));
      continue;
    }
    const isBullet = /^[-*+]\s+/.test(line);
    if (isBullet) {
      opening = false;
      const text = plain(line);
      if (CHARACTER_BULLET.test(text)) bullets.push(text.replace(/^[^::]*[::]\s*/, ""));
      continue;
    }
    if (opening) {
      picked.push(plain(line));
      paragraph = true;
    }
  }
  const all = [...picked.flatMap(sentences), ...bullets.flatMap((b) => sentences(b).slice(0, 2))];
  const out: string[] = [];
  let used = 0;
  for (const s of all) {
    if (out.length >= maxSentences) break;
    const n = [...s].length;
    if (out.length > 0 && used + n > maxChars) break;
    out.push(n > maxChars ? `${[...s].slice(0, maxChars).join("")}…` : s);
    used += n;
  }
  return out.join("\n");
}
