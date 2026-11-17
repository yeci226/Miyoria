// 接龍, in three kinds:
//
// * 成語接龍 / 詞語接龍: free for all. The next word starts with the last character of the one
//   before; the first to say one in voice (or type it) gets the point, and she plays too. Nobody
//   continues for a while and the chain breaks: whoever added the last word gets a bonus. An
//   idiom missing from the small list is accepted for her to veto; a known idiom that starts with
//   another character (often a homophone the recognizer picked) waits for her ruling.
// * 故事接龍: turns. Each person adds one line when it is their turn, she adds hers with
//   `party_play`; she can send a line back. Nobody scores.

import { safeName } from "@miyoria/types";
import { IDIOMS, STARTER_WORDS } from "../content.js";
import {
  CHAIN_TITLES,
  type ChainMode,
  type EndReason,
  type Game,
  type Host,
  PartyError,
  type Player,
  type StartOptions,
} from "../game.js";
import { fold, hanRuns, sameChar, trimParticles } from "../match.js";
import { nameOf, quote } from "./common.js";

const IDIOM_SET = new Set(IDIOMS.map(fold));
/** Bonus of whoever added the last word of a chain nobody could continue. */
const LAST_WORD_BONUS = 2;
/** Han characters of a line that is a move and nothing else ("嗯…一石二鳥吧"). */
const MAX_MOVE_CHARS = 8;

interface Link {
  word: string;
  by: Player;
  /** Not in the idiom list: she may veto it. */
  unverified: boolean;
}

interface Pending {
  player: Player;
  word: string;
}

interface Line {
  by: Player;
  text: string;
}

function lastChar(word: string): string {
  return [...word].at(-1) ?? "";
}

export class ChainGame implements Game {
  readonly id = "chain" as const;
  readonly title: string;
  readonly scored: boolean;
  readonly rules: string;
  readonly #host: Host;
  readonly #mode: ChainMode;
  readonly #rounds: number;
  // Word chains.
  #links: Link[] = [];
  #used = new Set<string>();
  #pending: Pending | null = null;
  #chains = 0;
  #broken = false;
  // Story chain.
  readonly #lines: Line[] = [];
  #turn: Player | null = null;

  constructor(host: Host, options: StartOptions) {
    this.#host = host;
    this.#mode = options.mode ?? "idiom";
    this.#rounds = options.rounds ?? 3;
    this.title = CHAIN_TITLES[this.#mode];
    this.scored = this.#mode !== "story";
    this.rules =
      this.#mode === "story"
        ? "大家輪流一人一句接故事,你也下場:輪到你就用 party_play 說你的那句。輪到誰、誰接了什麼程式會告訴你。party_host:reject 退回上一句不合適的(請他重說)、next 跳過現在輪到的人、end 結束。結束時幫大家把故事串起來講一遍。"
        : `${this.title}:下一個要用上一個的最後一個字開頭,先說先贏,一個一分;你也下場,用 party_play 說你的。接得對不對程式會判定並告訴你。party_host:accept 算同音字的接法、reject 否決不算數的詞(會收回上一個)、hint 想不出來時給個例子、next 開新的一串、end 結束。`;
  }

  begin(): string {
    if (this.#mode === "story") {
      this.#turn = this.#host.her();
      return "故事接龍開始!你先用 party_play 說故事的第一句,之後大家輪流一人一句。";
    }
    return this.#newChain();
  }

  // ---- word chains --------------------------------------------------------------------------

  #need(): string {
    return lastChar(this.#links.at(-1)?.word ?? "");
  }

  #newChain(): string {
    const pool = this.#mode === "idiom" ? IDIOMS : STARTER_WORDS;
    const fresh = pool.filter((w) => !this.#used.has(fold(w)));
    const list = fresh.length > 0 ? fresh : pool;
    const start = list[Math.floor(this.#host.random() * list.length)] ?? pool[0] ?? "一帆風順";
    this.#chains++;
    this.#broken = false;
    this.#pending = null;
    this.#links = [{ word: start, by: this.#host.her(), unverified: false }];
    this.#used.add(fold(start));
    this.#host.setTimer("idle", this.#host.cfg.chain_idle_secs * 1000);
    const kind = this.#mode === "idiom" ? "成語" : "詞";
    return `${this.title}第 ${this.#chains} 串:你先出「${start}」,大家要接「${this.#need()}」開頭的${kind},先說先贏。`;
  }

  /** Words in `text` that would continue the chain, best first; and a known idiom that would not. */
  #candidates(text: string): { fits: string[]; other: string | null } {
    const need = this.#need();
    const length = this.#mode === "idiom" ? 4 : 2;
    const fits: string[] = [];
    let other: string | null = null;
    for (const run of hanRuns(text)) {
      const chars = [...run];
      for (let i = 0; i + length <= chars.length; i++) {
        const word = chars.slice(i, i + length).join("");
        // "天啊" is somebody's sigh, not a word.
        if (this.#mode === "word" && trimParticles(word) !== word) continue;
        if (sameChar(chars[i] ?? "", need)) fits.push(word);
        else if (this.#mode === "idiom" && other === null && IDIOM_SET.has(fold(word))) {
          other = word;
        }
      }
    }
    // In a long sentence any four characters after the right one look like a move ("心裡覺得"):
    // there only a known idiom counts.
    const short = [...hanRuns(text).join("")].length <= MAX_MOVE_CHARS;
    return { fits: short ? fits : fits.filter((w) => IDIOM_SET.has(fold(w))), other };
  }

  #link(player: Player, word: string, quiet: boolean): string {
    const unverified = this.#mode === "idiom" && !IDIOM_SET.has(fold(word));
    this.#links.push({ word, by: player, unverified });
    this.#used.add(fold(word));
    this.#pending = null;
    this.#host.score(player, 1);
    this.#host.setTimer("idle", this.#host.cfg.chain_idle_secs * 1000);
    const doubt = unverified ? "(詞庫裡沒有,不是成語就用 party_host reject 否決)" : "";
    const line = `${nameOf(player)} 接了「${quote(word, 8)}」${doubt},下一個要接「${this.#need()}」。`;
    if (!quiet) {
      this.#host.note(`c${this.#chains}:w${this.#links.length}`, line, {
        untrusted: true,
        person: player,
      });
    }
    return line;
  }

  #wordInput(player: Player, text: string): boolean {
    if (this.#broken) return false;
    const { fits, other } = this.#candidates(text);
    const fresh = fits.find((w) => !this.#used.has(fold(w)));
    if (fresh !== undefined) {
      this.#link(player, fresh, false);
      return true;
    }
    const n = this.#links.length;
    if (fits.length > 0) {
      this.#host.note(
        `c${this.#chains}:w${n}:used:${player.key}`,
        `${nameOf(player)} 說的「${quote(fits[0] ?? "", 8)}」已經用過了。`,
        { untrusted: true, person: player },
      );
      return true;
    }
    if (other !== null && this.#used.has(fold(other))) {
      this.#host.note(
        `c${this.#chains}:w${n}:used:${player.key}`,
        `${nameOf(player)} 說的「${quote(other, 8)}」已經用過了。`,
        { untrusted: true, person: player },
      );
      return true;
    }
    if (other !== null) {
      this.#pending = { player, word: other };
      this.#host.note(
        `c${this.#chains}:w${n}:other:${player.key}`,
        `${nameOf(player)} 說了「${quote(other, 8)}」,但開頭不是「${this.#need()}」。是同音字的話可以用 party_host accept 算他接上。`,
        { untrusted: true, person: player },
      );
      return true;
    }
    return false;
  }

  #breakChain(): void {
    if (this.#broken) return;
    this.#broken = true;
    this.#pending = null;
    const last = this.#links.at(-1);
    const word = last?.word ?? "";
    let bonus = "";
    if (last !== undefined && this.#links.length > 1) {
      this.#host.score(last.by, LAST_WORD_BONUS);
      bonus = `${nameOf(last.by)} 是最後接上的,多拿 ${LAST_WORD_BONUS} 分。`;
    }
    const done = this.#chains >= this.#rounds;
    const then = done ? "" : "用 party_host next 開新的一串,或 end 結束。";
    this.#host.note(
      `c${this.#chains}:broken`,
      `沒人接得下去,這串斷在「${quote(word, 8)}」。${bonus}目前分數:${this.#host.standings()}。${then}`,
      { speak: !done },
    );
    if (done) this.#host.end("done");
  }

  // ---- story chain --------------------------------------------------------------------------

  /** Whoever comes after `player`: people still here in the order they came, then her. */
  #after(player: Player): Player {
    const order = this.#host.players().filter((p) => p.present);
    const at = order.findIndex((p) => p.key === player.key);
    return order[(at + 1) % order.length] ?? this.#host.her();
  }

  #addLine(player: Player, text: string, quiet: boolean): string {
    const line = [...text.trim()].slice(0, this.#host.cfg.story_line_chars).join("");
    this.#lines.push({ by: player, text: line });
    if (!player.her) player.active = true;
    if (this.#lines.length >= this.#host.cfg.story_max_lines) {
      this.#host.end("done", quiet);
      return "故事完成了!把整個故事串起來講一遍給大家聽。";
    }
    return this.#pass(
      this.#after(player),
      quiet,
      `${nameOf(player)} 接了:「${quote(line, 60)}」。`,
    );
  }

  /** The turn goes to `next`. */
  #pass(next: Player, quiet: boolean, before: string): string {
    this.#turn = next;
    if (next.her) this.#host.clearTimer("turn");
    else this.#host.setTimer("turn", this.#host.cfg.story_turn_secs * 1000);
    const whose = next.her
      ? "輪到你了,用 party_play 接下一句。"
      : `輪到 ${nameOf(next)} 接下一句。`;
    const line = `${before}${whose}`;
    if (!quiet) {
      this.#host.note(`story:l${this.#lines.length}:${next.key}`, line, {
        untrusted: true,
        person: next.her ? null : next,
      });
    }
    return line;
  }

  // ---- what she and the players do ----------------------------------------------------------

  input(player: Player, text: string): boolean {
    if (this.#mode !== "story") return this.#wordInput(player, text);
    if (this.#turn?.key !== player.key) return false;
    this.#addLine(player, text, false);
    return true;
  }

  next(): string {
    if (this.#mode === "story") {
      const turn = this.#turn ?? this.#host.her();
      return this.#pass(this.#after(turn), true, `跳過 ${nameOf(turn)}。`);
    }
    if (!this.#broken) {
      this.#host.clearTimer("idle");
      this.#broken = true;
    }
    if (this.#chains >= this.#rounds) {
      this.#host.end("done", true);
      return `接了 ${this.#chains} 串,遊戲結束。最後分數:${this.#host.standings()}`;
    }
    return this.#newChain();
  }

  hint(): string {
    if (this.#mode === "story") return "故事接龍沒有提示,可以幫輪到的人起個頭。";
    if (this.#broken) throw new PartyError("這串已經斷了,用 next 開新的一串。");
    const need = this.#need();
    const pool = this.#mode === "idiom" ? IDIOMS : [];
    const idea = pool.find((w) => sameChar([...w][0] ?? "", need) && !this.#used.has(fold(w)));
    return idea === undefined
      ? `想想「${need}」開頭的${this.#mode === "idiom" ? "成語" : "詞"}。`
      : `例如「${idea}」。`;
  }

  judge(accept: boolean, player: Player | null): string {
    if (this.#mode === "story") {
      if (accept) return "好,繼續。";
      const last = this.#lines.at(-1);
      if (last === undefined || last.by.her) return "沒有可以退回的句子。";
      this.#lines.pop();
      return this.#pass(last.by, true, `退回 ${nameOf(last.by)} 的那句,`);
    }
    const pending = this.#pending;
    if (pending !== null && (player === null || pending.player.key === player.key)) {
      if (!accept) {
        this.#pending = null;
        return `不算,還是要接「${this.#need()}」。`;
      }
      if (this.#broken) throw new PartyError("這串已經斷了。");
      return `算他接上:${this.#link(pending.player, pending.word, true)}`;
    }
    if (accept) return "現在沒有等你判定的接法。";
    const last = this.#links.at(-1);
    if (last === undefined || this.#links.length <= 1 || last.by.her) {
      return "沒有可以收回的詞。";
    }
    this.#links.pop();
    this.#used.delete(fold(last.word));
    this.#host.score(last.by, -1);
    return `收回 ${nameOf(last.by)} 的「${quote(last.word, 8)}」,還是要接「${this.#need()}」。`;
  }

  play(text: string): string {
    const her = this.#host.her();
    if (this.#mode === "story") {
      if (this.#turn !== null && !this.#turn.her) {
        throw new PartyError(`現在輪到 ${nameOf(this.#turn)},等他說完。`);
      }
      const line = text.trim();
      if (line === "") throw new PartyError("要說一句故事。");
      return this.#addLine(her, line, true);
    }
    if (this.#broken) throw new PartyError("這串已經斷了,用 party_host next 開新的一串。");
    const need = this.#need();
    const { fits } = this.#candidates(text);
    const word = fits.find((w) => !this.#used.has(fold(w)));
    if (word === undefined) {
      const kind = this.#mode === "idiom" ? "四字成語" : "兩個字的詞";
      throw new PartyError(`要用「${need}」開頭的${kind},而且不能重複。`);
    }
    return this.#link(her, word, true);
  }

  ask(): Promise<string> {
    throw new PartyError("接龍不用 party_ask。");
  }

  timer(name: string): void {
    if (name === "idle" && this.#mode !== "story") this.#breakChain();
    if (name === "turn" && this.#mode === "story" && this.#turn !== null) {
      const turn = this.#turn;
      this.#pass(this.#after(turn), false, `${nameOf(turn)} 沒接上,跳過。`);
    }
  }

  view(): string[] {
    if (this.#mode === "story") {
      const lines = [
        `故事接龍(${this.#lines.length}/${this.#host.cfg.story_max_lines} 句),輪到 ${this.#turn === null ? "你" : nameOf(this.#turn)}。`,
      ];
      if (this.#lines.length > 0) lines.push("故事到現在:");
      for (const l of this.#lines.slice(-8)) lines.push(`${nameOf(l.by)}:${quote(l.text, 80)}`);
      return lines;
    }
    if (this.#broken) {
      return [`第 ${this.#chains}/${this.#rounds} 串斷了,用 next 開新的一串或 end 結束。`];
    }
    const recent = this.#links
      .slice(-5)
      .map((l) => `${nameOf(l.by)}「${quote(l.word, 8)}」`)
      .join(" → ");
    const lines = [
      `第 ${this.#chains}/${this.#rounds} 串,要接「${this.#need()}」開頭。`,
      `最近:${recent}`,
    ];
    const pending = this.#pending;
    if (pending !== null) {
      lines.push(
        `等你判定:${nameOf(pending.player)} 說「${quote(pending.word, 8)}」,開頭不對,可能是同音字。`,
      );
    }
    return lines;
  }

  finish(_reason: EndReason): string[] {
    if (this.#mode !== "story" || this.#lines.length === 0) return [];
    const story = this.#lines.map((l) => safeName(l.text, 80)).join("");
    return [`整個故事:${story}`];
  }
}
