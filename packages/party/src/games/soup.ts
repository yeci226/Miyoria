// 海龜湯: she reads the surface, people ask yes-or-no questions, she answers. She hosts without
// knowing the bottom: every question goes through `party_ask` to the referee (judge.ts), which
// sees the bottom and answers one fixed word. The bottom reaches her only once the soup is over
// (solved, given up, out of time), so until then she cannot let it slip.

import { errorMessage } from "@miyoria/kernel";
import { SOUP_PUZZLES, type SoupPuzzle } from "../content.js";
import {
  type EndReason,
  GAME_TITLES,
  type Game,
  type Host,
  PartyError,
  type Player,
  type StartOptions,
} from "../game.js";
import type { SoupJudge, SoupVerdict } from "../judge.js";
import { nameOf, quote, secsLeft } from "./common.js";

const ANSWERS: Readonly<Record<Exclude<SoupVerdict, "solved">, string>> = {
  yes: "是",
  no: "不是",
  irrelevant: "不重要(跟真相無關)",
  close: "很接近了",
};

const SOLVE_POINTS = 3;
/** Questions shown to her (the newest), so she knows what was settled. */
const SHOWN_QUESTIONS = 8;

export class SoupGame implements Game {
  readonly id = "soup" as const;
  readonly title = GAME_TITLES.soup;
  readonly scored = true;
  readonly rules =
    "你是主持人,但湯底你也不知道,由裁判判定。有人問是非題或說出他猜的真相,就用 party_ask 把那句話交給裁判,照結果回答「是 / 不是 / 不重要 / 很接近了」,不要自己編答案。猜中了程式會公布湯底。party_host:hint 給一個提示、next 放棄並公布湯底、end 結束。";
  readonly #host: Host;
  readonly #judge: SoupJudge;
  readonly #puzzle: SoupPuzzle;
  readonly #asked: { question: string; answer: string }[] = [];
  readonly #deadline: number;
  #hints = 0;
  #over = false;

  constructor(host: Host, _options: StartOptions) {
    this.#host = host;
    const judge = host.judge();
    if (judge === null) throw new PartyError("現在沒有裁判可以判海龜湯(語言模型沒開)。");
    this.#judge = judge;
    const index = Math.floor(host.random() * SOUP_PUZZLES.length);
    this.#puzzle = SOUP_PUZZLES[index] ?? (SOUP_PUZZLES[0] as SoupPuzzle);
    this.#deadline = host.now() + host.cfg.soup_mins * 60_000;
  }

  begin(): string {
    this.#host.setTimer("time", this.#host.cfg.soup_mins * 60_000);
    return `海龜湯「${this.#puzzle.title}」開始。先把湯面念給大家聽:「${this.#puzzle.surface}」大家可以問是非題,${this.#host.cfg.soup_mins} 分鐘內要猜出真相。`;
  }

  async ask(question: string, player: Player | null): Promise<string> {
    if (this.#over) throw new PartyError("這碗湯已經結束了。");
    const text = question.trim();
    if (text === "") throw new PartyError("要把問題寫進來。");
    let verdict: SoupVerdict;
    try {
      verdict = await this.#judge.judge(
        { surface: this.#puzzle.surface, bottom: this.#puzzle.bottom, question: text },
        this.#host.signal,
      );
    } catch (error) {
      if (this.#host.signal.aborted) throw new PartyError("遊戲已經結束了。");
      throw new PartyError(`裁判現在判斷不了(${errorMessage(error)}),請對方換個問法再問一次。`);
    }
    // Someone else's question may have solved it while this one was with the referee.
    if (this.#over) return "已經有人先猜中了。";
    if (player !== null && !player.her) player.active = true;
    if (verdict === "solved") return this.#solved(player);
    const answer = ANSWERS[verdict];
    this.#asked.push({ question: quote(text, 40), answer });
    return `裁判:${answer}。`;
  }

  #solved(player: Player | null): string {
    this.#over = true;
    this.#host.clearTimer("time");
    if (player !== null && !player.her) this.#host.score(player, SOLVE_POINTS);
    const who = player === null || player.her ? "有人" : nameOf(player);
    const line = `猜中了!${who} 說出了真相。湯底是:「${this.#puzzle.bottom}」`;
    this.#host.end("done", true);
    return line;
  }

  next(): string {
    if (this.#over) throw new PartyError("這碗湯已經結束了,要再玩就重新開始。");
    this.#over = true;
    const line = `公布湯底:「${this.#puzzle.bottom}」`;
    this.#host.end("done", true);
    return line;
  }

  hint(): string {
    if (this.#over) throw new PartyError("這碗湯已經結束了。");
    const hint = this.#puzzle.hints[this.#hints];
    if (hint === undefined) return "提示用完了。";
    this.#hints++;
    return `提示:${hint}`;
  }

  input(): boolean {
    // Questions reach the referee through her (`party_ask`): she decides what was a question.
    return false;
  }

  judge(): string {
    throw new PartyError("海龜湯由裁判判定,把那句話用 party_ask 交給裁判。");
  }

  play(): string {
    throw new PartyError("海龜湯你是主持人,不能自己猜。");
  }

  timer(name: string): void {
    if (name !== "time" || this.#over) return;
    this.#over = true;
    this.#host.note(
      "timeout",
      `海龜湯時間到,沒人猜中。湯底是:「${this.#puzzle.bottom}」把真相講給大家聽。`,
    );
    this.#host.end("done", true);
  }

  view(): string[] {
    const lines = [
      `海龜湯「${this.#puzzle.title}」,湯面:「${this.#puzzle.surface}」`,
      `問了 ${this.#asked.length} 題,剩大約 ${Math.ceil(secsLeft(this.#deadline, this.#host.now()) / 60)} 分鐘,給過 ${this.#hints} 個提示。`,
    ];
    const asked = this.#asked.slice(-SHOWN_QUESTIONS);
    if (asked.length > 0) {
      lines.push("問過的(裁判的答案):");
      for (const a of asked) lines.push(`「${a.question}」→ ${a.answer}`);
    }
    return lines;
  }

  finish(reason: EndReason): string[] {
    // Solved, given up or out of time: the bottom was told already.
    if (this.#over || reason === "shutdown") return [];
    this.#over = true;
    return [`湯底是:「${this.#puzzle.bottom}」`];
  }
}
