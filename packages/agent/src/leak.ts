// A reply that is her reasoning, not her words. A model with thinking switched off can still
// think out loud in the visible answer: planning the tone, the length, the emotion tag, drafting
// the reply ("可以說：「…」"), re-checking a calculation. Streamed line by line, each of those
// lines would reach the chat as a message (2026-11-09: 23 messages in one turn).
//
// This is the net at the send boundary, not the fix of the cause (the model and its thinking
// switch, docs/design/backlog.md): lines that talk about the reply itself are recognised, and
// once a response has done so, the rest of it is dropped.

/** Lines that plan the reply: one of these is enough. */
const STRONG: readonly RegExp[] = [
  /情緒標記|情緒標籤|表情標記/,
  /回覆要(?:短|簡短|精簡)|回覆(?:短|控制在)|一兩句到三句|兩三句就好/,
  /(?:可以|我可以|大概|不如|先)(?:說|回|這樣說|這樣回)[:：]\s*[「『"]/,
  /設定說|人設(?:是|說|上)|角色設定/,
  /(?:語氣|口吻|表現|反應)要(?:傲嬌|別扭|短|收|帶)/,
  /(?:用|選|標)\s*(?:neutral|happy|smug|annoyed|angry|embarrassed|sad|surprised|thinking)\s*(?:吧|比較|好了|就好)/i,
  /<\/?(?:think|thinking|reasoning)>/i,
  /^(?:思考|推理|分析|草稿|Reasoning|Thinking)[:：]/i,
  /(?:現在)?(?:情緒|語氣)方面[:：]/,
  /我(?:該|應該|要)(?:驗收|回覆|回答|接著說|先說)/,
];

/** Lines that think aloud: two of them (or one with a strong line) are a leak. */
const WEAK: readonly RegExp[] = [
  /^(?:等一下|等等|不對|慢著|啊不對|嗯，讓我|讓我(?:想|算|確認|看看))/,
  /我(?:得|要|再|先)(?:驗算|確認|檢查|算一下|重算)/,
  /(?:驗算|驗證)[:：]/,
  /^(?:所以|那麼|因此).{0,20}(?:對的|正確|沒錯)[。.]?$/,
];

/** 0 for her words, 1 for a line that thinks aloud, 2 for one that plans the reply. */
export function reasoningScore(line: string): number {
  const text = line.trim();
  if (STRONG.some((r) => r.test(text))) return 2;
  if (WEAK.some((r) => r.test(text))) return 1;
  return 0;
}

/** Whether one line alone is reasoning. */
export function looksLikeReasoning(line: string): boolean {
  return reasoningScore(line) >= 2;
}

/**
 * Judges the lines of one reply in order. Once the total reaches two the response is a leak:
 * that line and every later one are dropped.
 */
export class ReasoningGuard {
  #score = 0;
  #leaking = false;

  get leaking(): boolean {
    return this.#leaking;
  }

  /** `true` when `line` must not be sent. */
  drops(line: string): boolean {
    if (this.#leaking) return true;
    this.#score += reasoningScore(line);
    if (this.#score >= 2) this.#leaking = true;
    return this.#leaking;
  }
}

/**
 * Lines on their way to the chat: the first one waits for the second (or the end of the reply),
 * so a leak that starts with an innocent line takes that line with it.
 */
export class ReplyScreen<T extends { text: string }> {
  readonly #guard = new ReasoningGuard();
  #first: T | null = null;
  #started = false;
  /** Set once the response was judged a leak. */
  dropped = false;

  /** What may be sent now; `retracted` is set when it took the held first line back. */
  push(item: T): { send: T[]; retracted: boolean } {
    if (this.#guard.drops(item.text)) {
      const retracted = this.#first !== null;
      this.#first = null;
      this.dropped = true;
      return { send: [], retracted };
    }
    if (!this.#started) {
      this.#started = true;
      this.#first = item;
      return { send: [], retracted: false };
    }
    const held = this.#first;
    this.#first = null;
    return { send: held === null ? [item] : [held, item], retracted: false };
  }

  /** The reply ended: a first line still waiting goes out. */
  flush(): T[] {
    const held = this.#first;
    this.#first = null;
    return held === null ? [] : [held];
  }
}
