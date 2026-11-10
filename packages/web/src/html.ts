// A small, forgiving HTML reader: a linear tokenizer (no backtracking regexes on page text),
// the readable text of a page, and DuckDuckGo's result list. Not a validating parser: it only
// has to pull text out of hostile or broken markup without hanging.

const NAMED: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  bull: "•",
  middot: "·",
  laquo: "«",
  raquo: "»",
  times: "×",
  yen: "¥",
  euro: "€",
  pound: "£",
  cent: "¢",
  deg: "°",
};

/** Decodes the common named entities and every numeric one; unknown ones stay as written. */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(
    /&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]{1,8});/giu,
    (whole, body: string) => {
      if (body[0] === "#") {
        const code =
          body[1] === "x" || body[1] === "X"
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "�";
        return String.fromCodePoint(code);
      }
      return NAMED[body.toLowerCase()] ?? whole;
    },
  );
}

// ---- tokenizer ----------------------------------------------------------------------------

export type Token =
  | { kind: "text"; text: string }
  | { kind: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "close"; name: string };

const isSpace = (c: string) => c === " " || c === "\n" || c === "\t" || c === "\r" || c === "\f";
const isNameChar = (c: string) => /[a-z0-9:_-]/i.test(c);

/** Elements whose content is not markup. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title", "xmp", "plaintext"]);

/** Parses one tag starting after `<` at `from`; returns the token and the index after `>`. */
function parseTag(html: string, from: number): { token: Token; end: number } | null {
  let i = from;
  const closing = html[i] === "/";
  if (closing) i++;
  const nameStart = i;
  while (i < html.length && isNameChar(html[i] as string)) i++;
  if (i === nameStart) return null;
  const name = html.slice(nameStart, i).toLowerCase();
  const attrs: Record<string, string> = {};
  let selfClosing = false;
  while (i < html.length) {
    const c = html[i] as string;
    if (c === ">") return { token: tagToken(closing, name, attrs, selfClosing), end: i + 1 };
    if (c === "/") {
      selfClosing = html[i + 1] === ">";
      i++;
      continue;
    }
    if (isSpace(c)) {
      i++;
      continue;
    }
    const attrStart = i;
    while (i < html.length && !isSpace(html[i] as string) && !"=>/".includes(html[i] as string))
      i++;
    const attr = html.slice(attrStart, i).toLowerCase();
    while (i < html.length && isSpace(html[i] as string)) i++;
    let value = "";
    if (html[i] === "=") {
      i++;
      while (i < html.length && isSpace(html[i] as string)) i++;
      const quote = html[i];
      if (quote === '"' || quote === "'") {
        const close = html.indexOf(quote, i + 1);
        const stop = close === -1 ? html.length : close;
        value = html.slice(i + 1, stop);
        i = close === -1 ? html.length : close + 1;
      } else {
        const valueStart = i;
        while (i < html.length && !isSpace(html[i] as string) && html[i] !== ">") i++;
        value = html.slice(valueStart, i);
      }
    }
    // An unterminated quote swallowed the rest; stop instead of scanning on.
    if (attr !== "" && !(attr in attrs)) attrs[attr] = decodeEntities(value);
    if (i === attrStart) i++;
  }
  return null;
}

function tagToken(
  closing: boolean,
  name: string,
  attrs: Record<string, string>,
  selfClosing: boolean,
): Token {
  return closing ? { kind: "close", name } : { kind: "open", name, attrs, selfClosing };
}

/** Index of the next `</name` at or after `from` (any case), else -1. Linear overall. */
function findClose(html: string, name: string, from: number): number {
  for (let at = html.indexOf("</", from); at !== -1; at = html.indexOf("</", at + 2)) {
    if (html.slice(at + 2, at + 2 + name.length).toLowerCase() === name) return at;
  }
  return -1;
}

/** Walks `html` as tokens; text is not decoded (callers decode what they keep). */
export function* tokenize(html: string): Generator<Token> {
  let i = 0;
  const n = html.length;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1) {
      yield { kind: "text", text: html.slice(i) };
      return;
    }
    if (lt > i) yield { kind: "text", text: html.slice(i, lt) };
    if (html.startsWith("<!--", lt)) {
      const end = html.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    const next = html[lt + 1];
    if (next === "!" || next === "?") {
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const tag = next === undefined ? null : parseTag(html, lt + 1);
    if (tag === null) {
      yield { kind: "text", text: "<" };
      i = lt + 1;
      continue;
    }
    i = tag.end;
    yield tag.token;
    if (tag.token.kind === "open" && !tag.token.selfClosing && RAW_TEXT.has(tag.token.name)) {
      const name = tag.token.name;
      const close = findClose(html, name, i);
      const stop = close === -1 ? n : close;
      if (stop > i) yield { kind: "text", text: html.slice(i, stop) };
      const end = html.indexOf(">", stop);
      if (close !== -1) yield { kind: "close", name };
      i = end === -1 ? n : end + 1;
    }
  }
}

// ---- readable text ------------------------------------------------------------------------

/** Dropped with everything inside. */
const ALWAYS_SKIP = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "canvas",
  "object",
  "embed",
  "select",
  "option",
]);
/** Page furniture, dropped unless that leaves (almost) nothing. */
const FURNITURE = new Set(["nav", "footer", "aside", "form", "button", "dialog", "menu"]);
const BLOCKS = new Set([
  "p",
  "div",
  "ul",
  "ol",
  "dl",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "section",
  "article",
  "main",
  "header",
  "blockquote",
  "pre",
  "figure",
  "address",
  "details",
]);
/** Start a new line when they open, but leave no blank line after them. */
const LINES = new Set(["li", "br", "tr", "dt", "dd", "hr", "summary", "figcaption"]);
const CELLS = new Set(["td", "th"]);
const VOID = new Set(["br", "hr", "img", "input", "meta", "link", "area", "base", "col", "wbr"]);

export interface PageText {
  title: string;
  text: string;
}

const squashLine = (s: string) => s.replace(/[ \t\f\v ]+/g, " ").trim();

/** Collapses whitespace: lines trimmed, blank runs and repeated lines dropped. */
export function tidy(text: string): string {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    const line = squashLine(raw);
    if (line === "") {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
    } else if (out[out.length - 1] !== line) out.push(line);
  }
  while (out[out.length - 1] === "") out.pop();
  return out.join("\n");
}

function extract(html: string, dropFurniture: boolean): PageText & { main: string } {
  let title = "";
  let inTitle = false;
  let titleSeen = false;
  const all: string[] = [];
  const main: string[] = [];
  // The element we are skipping (name and nesting of the same name), and how deep in main/article.
  let skip: string | null = null;
  let skipDepth = 0;
  let mainDepth = 0;
  const skipSet = (name: string) => ALWAYS_SKIP.has(name) || (dropFurniture && FURNITURE.has(name));
  const push = (s: string) => {
    all.push(s);
    if (mainDepth > 0) main.push(s);
  };
  for (const t of tokenize(html)) {
    if (t.kind === "text") {
      if (inTitle) {
        if (!titleSeen) title += t.text;
      } else if (skip === null) push(decodeEntities(t.text));
      continue;
    }
    if (t.kind === "open") {
      if (t.name === "title") inTitle = true;
      if (skip !== null) {
        if (t.name === skip && !t.selfClosing) skipDepth++;
        continue;
      }
      const hidden = "hidden" in t.attrs || t.attrs["aria-hidden"] === "true";
      if (!VOID.has(t.name) && !t.selfClosing && (skipSet(t.name) || hidden)) {
        skip = t.name;
        skipDepth = 1;
        continue;
      }
      if (t.name === "main" || t.name === "article") mainDepth++;
      if (BLOCKS.has(t.name) || LINES.has(t.name)) push("\n");
      continue;
    }
    if (t.name === "title") {
      inTitle = false;
      titleSeen = true;
    }
    if (skip !== null) {
      if (t.name === skip && --skipDepth === 0) skip = null;
      continue;
    }
    if ((t.name === "main" || t.name === "article") && mainDepth > 0) mainDepth--;
    if (BLOCKS.has(t.name)) push("\n");
    else if (CELLS.has(t.name)) push(" ");
  }
  return {
    title: squashLine(decodeEntities(title).replace(/\s+/g, " ")),
    text: tidy(all.join("")),
    main: tidy(main.join("")),
  };
}

/**
 * The readable text of an HTML page: title, then the text of `<main>` / `<article>` when that
 * is substantial, else the body, without scripts, styles, navigation, forms and hidden parts.
 * An unclosed `<nav>` that would swallow the page is detected (too little text) and the page is
 * read again keeping those parts.
 */
export function readableText(html: string): PageText {
  let page = extract(html, true);
  if (page.text.length < 200 && page.text.length < extract(html, false).text.length / 2) {
    page = extract(html, false);
  }
  return { title: page.title, text: page.main.length >= 300 ? page.main : page.text };
}

// ---- DuckDuckGo ---------------------------------------------------------------------------

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * The real URL behind a result link: `//duckduckgo.com/l/?uddg=<encoded>&rut=...` (or a relative
 * `/l/?uddg=`) carries it in `uddg`; a plain absolute link is itself. Only http(s) results come
 * back; ads (`duckduckgo.com/y.js`) and anything undecodable give `null`.
 */
export function decodeResultLink(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href.trim(), "https://duckduckgo.com/");
  } catch {
    return null;
  }
  let target = url;
  if (url.hostname === "duckduckgo.com" || url.hostname.endsWith(".duckduckgo.com")) {
    const uddg = url.pathname.startsWith("/l/") ? url.searchParams.get("uddg") : null;
    if (uddg === null) return null;
    try {
      target = new URL(uddg);
    } catch {
      return null;
    }
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return null;
  if (target.hostname === "duckduckgo.com" || target.hostname.endsWith(".duckduckgo.com")) {
    return null;
  }
  return target.href;
}

/** What DuckDuckGo's answer page is. */
export type SearchPage =
  | { kind: "results"; hits: SearchHit[] }
  | { kind: "empty" }
  | { kind: "challenge" };

const CHALLENGE =
  /anomaly-modal|anomaly\.js|g-recaptcha|h-captcha|cf-challenge|bots use duckduckgo too|select all squares|unusual traffic/i;

const hasClass = (attrs: Record<string, string>, name: string) =>
  (attrs.class ?? "").split(/\s+/).includes(name);

/** Text of the element that opens at `tokens[i]` (an `a`, `div`, `td` ...), up to its close. */
function innerText(tokens: Token[], i: number): string {
  const open = tokens[i] as Extract<Token, { kind: "open" }>;
  let depth = 1;
  let out = "";
  for (let j = i + 1; j < tokens.length; j++) {
    const t = tokens[j] as Token;
    if (t.kind === "text") out += t.text;
    else if (t.name === open.name) {
      if (t.kind === "open" && !t.selfClosing) depth++;
      else if (t.kind === "close" && --depth === 0) break;
    }
  }
  return squashLine(decodeEntities(out).replace(/\s+/g, " "));
}

/**
 * Reads DuckDuckGo's HTML result page (`result__a` links with `result__snippet` text beside
 * them). A page with no results and no "no results" marker is treated like a challenge: the
 * layout is not what we know, so what we got cannot be trusted as "nothing found".
 */
export function parseSearchPage(html: string): SearchPage {
  if (CHALLENGE.test(html)) return { kind: "challenge" };
  const tokens = [...tokenize(html)];
  const hits: SearchHit[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as Token;
    if (t.kind !== "open") continue;
    if (t.name === "a" && hasClass(t.attrs, "result__a")) {
      const url = decodeResultLink(t.attrs.href ?? "");
      const title = innerText(tokens, i);
      if (url !== null && title !== "") hits.push({ title, url, snippet: "" });
      else hits.push({ title: "", url: "", snippet: "" }); // keeps snippets aligned; dropped below
    } else if (hasClass(t.attrs, "result__snippet") || hasClass(t.attrs, "result-snippet")) {
      const last = hits[hits.length - 1];
      if (last !== undefined && last.snippet === "") last.snippet = innerText(tokens, i);
    }
  }
  const real = hits.filter((h) => h.url !== "");
  if (real.length > 0) return { kind: "results", hits: real };
  if (/no-results|No results found|找不到結果|沒有找到/i.test(html)) return { kind: "empty" };
  return { kind: "challenge" };
}
