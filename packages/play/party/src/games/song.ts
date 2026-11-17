// 猜歌: a clip of a song she has a cover of plays in the channel, the first to name it scores.
// The songs come from `SongClips` (her library, provided by the singing module). Which song is
// playing is held here: she does not know it either, so she can guess along.

import type { SongClipInfo } from "@miyoria/types";
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
import { judgeAnswer } from "../match.js";
import { HiddenRound, nameOf, quote, secsLeft } from "./common.js";

/** The title as people say it: without "(Live)", "[MV]", "【官方】" and the like. */
export function bareTitle(title: string): string {
  return title
    .replace(/[([【「《][^)\]】」》]*[)\]】」》]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function answersOf(song: SongClipInfo): string[] {
  const bare = bareTitle(song.title);
  return [...new Set([bare === "" ? song.title : bare, song.title, ...(song.aliases ?? [])])];
}

export class SongGame implements Game {
  readonly id = "song" as const;
  readonly title = GAME_TITLES.song;
  readonly scored = true;
  readonly rules =
    "你放一首歌的片段讓大家搶答歌名,答對由程式判定;是哪首歌你也不知道,可以用 party_play 一起猜(先讓大家猜)。party_host:next 放下一首(上一首沒人猜到會先公布)、hint 提示、accept / reject 判定「很接近」的答案、end 結束。片段在放的時候不要講太多話。";
  readonly #host: Host;
  readonly #songs: SongClipInfo[];
  #index = -1;
  #round: HiddenRound | null = null;
  #clip: AbortController | null = null;
  #herGuesses = 0;
  /** Someone named the singer this round (said once). */
  #artistTold = false;

  constructor(host: Host, options: StartOptions) {
    this.#host = host;
    const clips = host.clips();
    const songs = clips?.list() ?? [];
    if (clips === null || songs.length === 0) {
      throw new PartyError("現在沒有歌可以放片段(唱歌的功能沒開,或還沒有準備好的歌)。");
    }
    const rounds = options.rounds ?? host.cfg.song_rounds;
    this.#songs = shuffled(songs, () => host.random()).slice(0, rounds);
  }

  begin(): string {
    return `猜歌開始,一共 ${this.#songs.length} 首。用 party_host 的 next 放第一首。`;
  }

  #song(): SongClipInfo {
    return this.#songs[this.#index] as SongClipInfo;
  }

  #last(): boolean {
    return this.#index >= this.#songs.length - 1;
  }

  next(): string {
    const parts: string[] = [];
    const open = this.#round;
    if (open?.open) {
      this.#stopClip();
      this.#host.clearTimer("answer");
      parts.push(`第 ${open.no} 首沒人猜到,是「${open.close()}」。`);
    }
    if (this.#last()) {
      this.#host.end("done", true);
      return `${parts.join("")}歌放完了,遊戲結束。最後分數:${this.#host.standings()}`;
    }
    this.#index++;
    const song = this.#song();
    const secs = this.#host.cfg.song_answer_secs;
    this.#round = new HiddenRound(this.#index + 1, answersOf(song), this.#host.now() + secs * 1000);
    this.#herGuesses = 0;
    this.#artistTold = false;
    this.#host.setTimer("answer", secs * 1000);
    this.#play(song, this.#round.no);
    parts.push(
      `第 ${this.#index + 1}/${this.#songs.length} 首的片段開始放了(${this.#host.cfg.clip_secs} 秒),${secs} 秒內搶答。`,
    );
    return parts.join("");
  }

  #play(song: SongClipInfo, no: number): void {
    const clips = this.#host.clips();
    if (clips === null) {
      this.#host.note(`s${no}:clip`, "歌的片段放不出來(唱歌的功能停了),可以 end 結束遊戲。");
      return;
    }
    this.#stopClip();
    const controller = new AbortController();
    this.#clip = controller;
    const stop = () => controller.abort();
    this.#host.signal.addEventListener("abort", stop, { once: true });
    const clip = { startMs: song.clipStartMs ?? 0, durationMs: this.#host.cfg.clip_secs * 1000 };
    void clips
      .play(this.#host.context, song.id, clip, controller.signal)
      .catch(() => "failed" as const)
      .then((outcome) => {
        this.#host.signal.removeEventListener("abort", stop);
        if (this.#clip === controller) this.#clip = null;
        if (outcome === "failed" && !controller.signal.aborted) {
          this.#host.note(`s${no}:clip`, "這首的片段放不出來,可以用 party_host next 換下一首。");
        }
      });
  }

  #stopClip(): void {
    this.#clip?.abort();
    this.#clip = null;
  }

  input(player: Player, text: string): boolean {
    const round = this.#round;
    if (round === null || !round.open) return false;
    const verdict = round.judge(text);
    if (verdict === "hit") {
      this.#win(round, player, false);
      return true;
    }
    const artist = this.#song().artist;
    if (!this.#artistTold && artist !== null && judgeAnswer(text, [artist]) === "hit") {
      this.#artistTold = true;
      this.#host.note(
        `s${round.no}:artist`,
        `${nameOf(player)} 猜到歌手是${quote(artist, 24)}了,但要猜的是歌名。`,
        { person: player },
      );
      return true;
    }
    if (verdict === "close") {
      if (round.nearMiss(player, text)) {
        this.#host.note(
          `s${round.no}:near:${player.key}`,
          `${nameOf(player)} 說「${quote(text)}」,跟歌名${round.howClose(text)}。像是語音辨識的錯字就用 party_host accept 算他對,不然說很接近了。`,
          { untrusted: true, person: player },
        );
      }
      return true;
    }
    return false;
  }

  #win(round: HiddenRound, player: Player, quiet: boolean): string {
    this.#host.clearTimer("answer");
    this.#stopClip();
    const title = round.close();
    const artist = this.#song().artist;
    this.#host.score(player, 1);
    const by = artist === null ? "" : `(${quote(artist, 24)})`;
    const line = `${nameOf(player)} 猜對了第 ${round.no} 首,是「${quote(title, 40)}」${by}。目前分數:${this.#host.standings()}`;
    const last = this.#last();
    if (!quiet) {
      this.#host.note(
        `s${round.no}:won`,
        last ? line : `${line}。可以用 party_host next 放下一首。`,
        {
          person: player,
          speak: !last,
        },
      );
    }
    if (last) this.#host.end("done", quiet);
    return line;
  }

  hint(): string {
    const round = this.#open();
    const artist = this.#song().artist;
    return round.hint(artist === null ? [] : [`歌手是${quote(artist, 24)}`]) ?? "沒有更多提示了。";
  }

  judge(accept: boolean, player: Player | null): string {
    const round = this.#open();
    const near = round.takeNear(player);
    if (near === null) return "現在沒有等你判定的答案。";
    if (!accept) return `不算,${nameOf(near.player)} 再想想。`;
    return `算 ${this.#win(round, near.player, true)}`;
  }

  play(text: string): string {
    const round = this.#open();
    if (this.#herGuesses >= 2) throw new PartyError("這首你已經猜兩次了,讓大家猜。");
    this.#herGuesses++;
    const verdict = round.judge(text);
    if (verdict === "hit") return `你猜對了!${this.#win(round, this.#host.her(), true)}`;
    return verdict === "close" ? "很接近,但不算。" : "不對。";
  }

  ask(): Promise<string> {
    throw new PartyError("猜歌不用 party_ask,大家直接搶答。");
  }

  timer(name: string): void {
    const round = this.#round;
    if (name !== "answer" || round === null || !round.open) return;
    this.#stopClip();
    const title = round.close();
    const last = this.#last();
    const line = `第 ${round.no} 首時間到,沒人猜到,是「${quote(title, 40)}」。`;
    this.#host.note(`s${round.no}:timeout`, last ? line : `${line}用 party_host next 放下一首。`, {
      speak: !last,
    });
    if (last) this.#host.end("done");
  }

  #open(): HiddenRound {
    const round = this.#round;
    if (round === null || !round.open) {
      throw new PartyError("現在沒有在猜的歌,用 next 放下一首。");
    }
    return round;
  }

  view(): string[] {
    const round = this.#round;
    const total = this.#songs.length;
    if (round === null) return [`還沒放第一首(共 ${total} 首)。`];
    if (!round.open) {
      return [`第 ${round.no}/${total} 首已經結束(是「${quote(round.revealed() ?? "", 40)}」)。`];
    }
    const lines = [
      `第 ${round.no}/${total} 首:片段${this.#clip === null ? "放完了" : "正在放"},大家在猜,剩大約 ${secsLeft(round.deadline, this.#host.now())} 秒。`,
    ];
    if (round.hintsGiven.length > 0) lines.push(`給過的提示:${round.hintsGiven.join(";")}`);
    const near = round.near;
    if (near !== null) {
      lines.push(`等你判定:${nameOf(near.player)} 說「${quote(near.text)}」,很接近歌名。`);
    }
    return lines;
  }

  finish(_reason: EndReason): string[] {
    this.#stopClip();
    const round = this.#round;
    if (round === null || !round.open) return [];
    return [`最後一首是「${quote(round.close(), 40)}」。`];
  }
}
