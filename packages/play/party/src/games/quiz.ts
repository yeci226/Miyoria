// 問答: she reads a question, the first right answer scores. The program judges answers and
// holds them: she never sees the answer of an open question, so she cannot give it away, and
// with the built-in questions she can play along. With her own questions she knows the answers
// and only hosts.

import { QUIZ_QUESTIONS, type QuizQuestion } from "../content.js";
import {
  type EndReason,
  GAME_TITLES,
  type Game,
  type Host,
  PartyError,
  type Player,
  type StartOptions,
  shuffled,
} from "../game.js";
import { HiddenRound, nameOf, quote, secsLeft } from "./common.js";

export class QuizGame implements Game {
  readonly id = "quiz" as const;
  readonly title = GAME_TITLES.quiz;
  readonly scored = true;
  readonly rules: string;
  readonly #host: Host;
  readonly #questions: QuizQuestion[];
  /** She wrote the questions: she knows the answers. */
  readonly #own: boolean;
  #index = -1;
  #round: HiddenRound | null = null;
  #herGuesses = 0;

  constructor(host: Host, options: StartOptions) {
    this.#host = host;
    const own = options.questions ?? [];
    this.#own = own.length > 0;
    const rounds = options.rounds ?? host.cfg.quiz_rounds;
    this.#questions = this.#own
      ? own.slice(0, rounds)
      : shuffled(QUIZ_QUESTIONS, () => host.random()).slice(0, rounds);
    this.rules = this.#own
      ? "題目是你出的。你念題目,大家搶答,答對由程式判定,有人答對或時間到會告訴你。party_host:next 下一題(上一題沒人答對會先公布答案)、hint 提示、accept / reject 判定「很接近」的答案、end 結束。"
      : "你念題目,大家搶答;答案由程式判定,你也看不到,有人答對或時間到會告訴你,公布前別猜答案是什麼。party_host:next 下一題(上一題沒人答對會先公布答案)、hint 提示、accept / reject 判定「很接近」的答案(多半是語音辨識錯字)、end 結束。你也可以用 party_play 搶答,但先讓大家答。";
  }

  begin(): string {
    return `問答開始,一共 ${this.#questions.length} 題。用 party_host 的 next 出第一題。`;
  }

  #last(): boolean {
    return this.#index >= this.#questions.length - 1;
  }

  next(): string {
    const parts: string[] = [];
    const open = this.#round;
    if (open?.open) {
      this.#host.clearTimer("answer");
      parts.push(`第 ${open.no} 題沒人答對,答案是「${open.close()}」。`);
    }
    if (this.#last()) {
      this.#host.end("done", true);
      return `${parts.join("")}題目出完了,遊戲結束。最後分數:${this.#host.standings()}`;
    }
    this.#index++;
    const q = this.#questions[this.#index] as QuizQuestion;
    const secs = this.#host.cfg.quiz_answer_secs;
    this.#round = new HiddenRound(this.#index + 1, q.answers, this.#host.now() + secs * 1000);
    this.#herGuesses = 0;
    this.#host.setTimer("answer", secs * 1000);
    parts.push(
      `第 ${this.#index + 1}/${this.#questions.length} 題:「${q.question}」把題目念出來,${secs} 秒內搶答。`,
    );
    return parts.join("");
  }

  input(player: Player, text: string): boolean {
    const round = this.#round;
    if (round === null || !round.open) return false;
    const verdict = round.judge(text);
    if (verdict === "hit") {
      this.#win(round, player, false);
      return true;
    }
    if (verdict === "close") {
      if (round.nearMiss(player, text)) {
        this.#host.note(
          `q${round.no}:near:${player.key}`,
          `${nameOf(player)} 說「${quote(text)}」,跟答案${round.howClose(text)}。像是語音辨識的錯字就用 party_host accept 算他對,不然說很接近了。`,
          { untrusted: true, person: player },
        );
      }
      return true;
    }
    return false;
  }

  /** `quiet`: she made the call herself (her tool says so). */
  #win(round: HiddenRound, player: Player, quiet: boolean): string {
    this.#host.clearTimer("answer");
    const answer = round.close();
    this.#host.score(player, 1);
    const line = `${nameOf(player)} 答對了第 ${round.no} 題,答案是「${answer}」。目前分數:${this.#host.standings()}`;
    const last = this.#last();
    if (!quiet) {
      this.#host.note(
        `q${round.no}:won`,
        last ? line : `${line}。可以用 party_host next 出下一題。`,
        {
          person: player,
          // The end of the game says the rest.
          speak: !last,
        },
      );
    }
    if (last) this.#host.end("done", quiet);
    return line;
  }

  hint(): string {
    const round = this.#open();
    return round.hint() ?? "沒有更多提示了。";
  }

  judge(accept: boolean, player: Player | null): string {
    const round = this.#open();
    const near = round.takeNear(player);
    if (near === null) return "現在沒有等你判定的答案。";
    if (!accept) return `不算,${nameOf(near.player)} 再想想。`;
    return `算 ${this.#win(round, near.player, true)}`;
  }

  play(text: string): string {
    if (this.#own) throw new PartyError("題目是你出的,你知道答案,不能自己搶答。");
    const round = this.#open();
    if (this.#herGuesses >= 2) throw new PartyError("這題你已經猜兩次了,讓大家猜。");
    this.#herGuesses++;
    const verdict = round.judge(text);
    if (verdict === "hit") return `你答對了!${this.#win(round, this.#host.her(), true)}`;
    return verdict === "close" ? "很接近,但不算。" : "不對。";
  }

  ask(): Promise<string> {
    throw new PartyError("問答不用 party_ask,大家直接搶答。");
  }

  timer(name: string): void {
    const round = this.#round;
    if (name !== "answer" || round === null || !round.open) return;
    const answer = round.close();
    const last = this.#last();
    this.#host.note(
      `q${round.no}:timeout`,
      last
        ? `第 ${round.no} 題時間到,沒人答對,答案是「${answer}」。`
        : `第 ${round.no} 題時間到,沒人答對,答案是「${answer}」。用 party_host next 出下一題。`,
      { speak: !last },
    );
    if (last) this.#host.end("done");
  }

  #open(): HiddenRound {
    const round = this.#round;
    if (round === null || !round.open) throw new PartyError("現在沒有進行中的題目,用 next 出題。");
    return round;
  }

  view(): string[] {
    const round = this.#round;
    const total = this.#questions.length;
    if (round === null) return [`還沒出題(共 ${total} 題)。`];
    const q = this.#questions[this.#index] as QuizQuestion;
    if (!round.open) {
      return [`第 ${round.no}/${total} 題已經結束(答案「${round.revealed()}」)。`];
    }
    const lines = [
      `第 ${round.no}/${total} 題:「${q.question}」,剩大約 ${secsLeft(round.deadline, this.#host.now())} 秒。`,
    ];
    if (this.#own) lines.push(`(你出的題,答案:${q.answers.join(" / ")})`);
    if (round.hintsGiven.length > 0) lines.push(`給過的提示:${round.hintsGiven.join(";")}`);
    const near = round.near;
    if (near !== null) {
      lines.push(`等你判定:${nameOf(near.player)} 說「${quote(near.text)}」,很接近答案。`);
    }
    return lines;
  }

  finish(_reason: EndReason): string[] {
    const round = this.#round;
    if (round === null || !round.open) return [];
    return [`最後一題的答案是「${round.close()}」。`];
  }
}
