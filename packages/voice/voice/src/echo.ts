// Things that are not somebody talking to her: an ASR model printing its prompt back, and her
// own voice coming back through somebody's microphone.

const KEEP = /[\p{L}\p{N}]/u;

/** Lower-case letters and digits only (transcripts space and punctuate arbitrarily). */
export function matchCore(text: string): string {
  let out = "";
  for (const ch of text.toLowerCase()) if (KEEP.test(ch)) out += ch;
  return out;
}

/** Character bigrams (a single character counts as itself) of an already normalized text. */
function bigrams(core: string): Set<string> {
  const chars = [...core];
  const out = new Set<string>();
  if (chars.length === 1) out.add(chars[0] as string);
  for (let i = 0; i + 1 < chars.length; i++) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

/** How much of `a` appears in `b`, by character bigrams (0..1; 0 when `a` has none). */
export function containment(a: string, b: string): number {
  const ga = bigrams(matchCore(a));
  if (ga.size === 0) return 0;
  const gb = bigrams(matchCore(b));
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit++;
  return hit / ga.size;
}

/** Separators of a prompt's terms (`Miyo、米優、Minecraft`, names after a space). */
const TERM_SEPARATORS = /[、,，;；\s]+/u;

/** The transcript has at least this many letters / digits before similarity is judged. */
const MIN_ECHO_CHARS = 8;
/** At least this share of the transcript's bigrams are in the prompt. */
const ECHO_CONTAINMENT = 0.8;
/** The transcript recites at least this share of a prompt of `MIN_PROMPT_CHARS`+ characters. */
const ECHO_COVERAGE = 0.6;
const MIN_PROMPT_CHARS = 6;

/**
 * The transcript is the ASR prompt (her names, the people in the channel, game terms) printed
 * back, which models do when the audio holds no clear speech ("御坂10514號、v(t) = Vm·sin(ωt + φ)").
 * Judged by character-bigram similarity to the configured prompt, so it does not depend on the
 * exact terms: most of a transcript that is not short is made of the prompt's pieces, or the
 * transcript repeats most of the prompt. Calling her by one of the hotwords (a short transcript)
 * is not an echo.
 */
export function looksLikeHintEcho(text: string, prompt: string | null): boolean {
  if (prompt === null) return false;
  const promptLength = [...matchCore(prompt)].length;
  if (promptLength < 2) return false;
  const core = matchCore(text);
  // Saying one of the hotwords on its own (her name) is somebody calling her.
  if (prompt.split(TERM_SEPARATORS).some((term) => matchCore(term).includes(core))) return false;
  const length = [...core].length;
  if (length >= MIN_ECHO_CHARS && containment(text, prompt) >= ECHO_CONTAINMENT) return true;
  return (
    promptLength >= MIN_PROMPT_CHARS &&
    length >= MIN_PROMPT_CHARS &&
    containment(prompt, text) >= ECHO_COVERAGE
  );
}

/** At least this share of a transcript must be in a line she said. */
const SELF_CONTAINMENT = 0.7;
const MIN_SELF_CHARS = 4;
const KEEP_LINES = 8;

interface Said {
  variants: string[];
  at: number;
}

interface GuildEcho {
  said: Said[];
  playing: number;
  lastEnd: number;
}

export interface SelfEchoOptions {
  now: () => number;
  /** After her playback ends, an echo may still arrive (ASR latency, room reverb). */
  tailMs?: number;
  /** Lines she said longer ago than this are not echoed any more. */
  windowMs?: number;
}

/**
 * Remembers what she says and tells when a transcript is her own voice picked up by somebody's
 * microphone: it overlaps what she is saying now, or said a moment ago.
 */
export class SelfEchoGuard {
  readonly #now: () => number;
  readonly #tailMs: number;
  readonly #windowMs: number;
  readonly #guilds = new Map<string, GuildEcho>();

  constructor(options: SelfEchoOptions) {
    this.#now = options.now;
    this.#tailMs = options.tailMs ?? 5_000;
    this.#windowMs = options.windowMs ?? 60_000;
  }

  #guild(guild: string): GuildEcho {
    let g = this.#guilds.get(guild);
    if (!g) {
      g = { said: [], playing: 0, lastEnd: Number.NEGATIVE_INFINITY };
      this.#guilds.set(guild, g);
    }
    return g;
  }

  /** A line (`variants`: as written and as spoken) starts playing. */
  started(guild: string, variants: readonly string[]): void {
    const g = this.#guild(guild);
    g.playing++;
    g.said.push({ variants: variants.filter((v) => matchCore(v) !== ""), at: this.#now() });
    if (g.said.length > KEEP_LINES) g.said.splice(0, g.said.length - KEEP_LINES);
  }

  /** The line that was started is over (finished, stopped or failed). */
  ended(guild: string): void {
    const g = this.#guild(guild);
    g.playing = Math.max(0, g.playing - 1);
    g.lastEnd = this.#now();
  }

  /** Whether `transcript` is her own voice coming back. */
  isEcho(guild: string, transcript: string): boolean {
    const g = this.#guilds.get(guild);
    if (!g) return false;
    const now = this.#now();
    if (g.playing === 0 && now - g.lastEnd > this.#tailMs) return false;
    if ([...matchCore(transcript)].length < MIN_SELF_CHARS) return false;
    for (const line of g.said) {
      if (now - line.at > this.#windowMs) continue;
      for (const v of line.variants) {
        if (containment(transcript, v) >= SELF_CONTAINMENT) return true;
      }
    }
    return false;
  }
}
