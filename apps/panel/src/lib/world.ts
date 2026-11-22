// The words of her world (docs/design/v5-profiles.md): the coins' name, the exchange's name, the
// pronoun texts use for her, the persona's name and which landing page the profile has. The Core
// puts them into the page it serves as `<meta name="miyoria:world">` (JSON) only when one differs
// from the first character's, so a page without the tag (the default install, the dev server,
// tests) reads exactly as before. Like her name (`site-name.ts`), read once: it cannot change
// without the Core restarting, which reloads the page.

/** Which front page the profile has: today's hand-made one, its own content, or the plain one. */
export type LandingKind = "builtin" | "own" | "plain";

export interface World {
  /** The coins' name (`[modules.economy] currency`). */
  currency: string;
  /** The stock exchange's name (`[character] exchange_name`). */
  exchange_name: string;
  /** How texts refer to her (`[character] pronoun`). */
  pronoun: string;
  /** The persona's display name (`profile.toml`), what the panel's sidebar calls her. */
  persona: string;
  landing: LandingKind;
}

/** The first character's words: the defaults of every field. */
export const DEFAULT_WORLD: Readonly<World> = Object.freeze({
  currency: "魚幣",
  exchange_name: "深海交易所",
  pronoun: "她",
  persona: "DeepSeek-chan",
  landing: "builtin",
});

const LANDINGS: readonly LandingKind[] = ["builtin", "own", "plain"];

const word = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t !== "" && t.length <= max ? t : null;
};

/** The words the Core tagged `doc` with; a missing tag, bad JSON or a bad field is the default's. */
export function readWorld(doc: Document | undefined = globalThis.document): World {
  const raw = doc?.querySelector('meta[name="miyoria:world"]')?.getAttribute("content");
  let tagged: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) tagged = parsed as Record<string, unknown>;
    } catch {
      // A broken tag reads as none.
    }
  }
  const landing = LANDINGS.find((l) => l === tagged.landing);
  return {
    currency: word(tagged.currency, 16) ?? DEFAULT_WORLD.currency,
    exchange_name: word(tagged.exchange_name, 32) ?? DEFAULT_WORLD.exchange_name,
    pronoun: word(tagged.pronoun, 8) ?? DEFAULT_WORLD.pronoun,
    persona: word(tagged.persona, 64) ?? DEFAULT_WORLD.persona,
    landing: landing ?? DEFAULT_WORLD.landing,
  };
}

/** Read once, at load. */
export const WORLD: Readonly<World> = Object.freeze(readWorld());
