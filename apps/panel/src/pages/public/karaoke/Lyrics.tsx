// The lyrics on the stage, karaoke-box style after the owner's own app: two large lines centred low
// on the stage, the line being sung over the next one. Between lines the coming line already sits
// in place, unlit, with four dots counting it in after a rest. An aligned line fills piece by piece
// as it is sung, white to the primary colour, outlined so it reads over a video; under reduced
// motion each piece lights whole as it begins. A line without times shows as a whole. Readings sit
// above the words when the viewer turned them on. Lyrics that are what the recogniser heard carry
// 「聽寫」 (`HeardBadge`); a looked-up line that did not match what was heard is underlined with dots.

import { useMemo } from "react";
import type {
  WorkersKaraokeLineV2,
  WorkersKaraokeLyricsV2,
  WorkersKaraokePiece,
} from "@miyoria/contracts/workers/karaoke";
import { Badge } from "@/components/ui/badge";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/utils";
import {
  COUNTDOWN_DOTS,
  countdown,
  fillClip,
  isDoubtful,
  lineProgress,
  type ReadingMode,
  readingLabel,
  readingModes,
  rubyOf,
  stageLines,
  stepped,
  sungEnd,
} from "@miyoria/play/karaoke/lyrics";

/** The share of a piece already sung, as the right edge of what shows of the fill (shared with the stream). */
export { fillClip };

/** Words over a picture: an outline under the fill and a shadow, so any frame behind stays clear. */
export const LYRIC_INK =
  "text-white [-webkit-text-stroke:3px_rgba(0,0,0,0.82)] [paint-order:stroke_fill] [text-shadow:0_2px_4px_rgba(0,0,0,0.85)] sm:[-webkit-text-stroke:4px_rgba(0,0,0,0.82)]";
/**
 * The line being sung: sized by the stage (container units), by its width or, on a short stage (a
 * phone held sideways), by its height, whichever is smaller.
 */
export const LYRIC_MAIN = "text-[clamp(22px,min(3.8cqw,7cqh),60px)] font-semibold leading-[1.45] tracking-[0.02em]";
/** The line after it. */
export const LYRIC_NEXT =
  "text-[clamp(17px,min(2.8cqw,5.2cqh),44px)] font-medium leading-[1.45] tracking-[0.02em] text-white/88";
/** A reading above a piece: never under 12 px. */
export const LYRIC_RUBY =
  "text-[max(12px,0.36em)] font-normal tracking-normal text-white/85 [-webkit-text-stroke:2px_rgba(0,0,0,0.82)]";

export function Lyrics({
  lyrics,
  now,
  loaded,
  mode,
  reduced = false,
}: {
  lyrics: WorkersKaraokeLyricsV2 | null;
  now: number;
  loaded: boolean;
  mode: ReadingMode;
  /** Reduced motion: pieces light whole, no wipe. */
  reduced?: boolean;
}) {
  const lines = lyrics?.lines ?? [];
  const timed = useMemo(() => lines.map((l) => ({ start: l.start, end: sungEnd(l) })), [lines]);
  if (lines.length === 0) {
    return (
      <p className={cn("text-center text-[15px] sm:text-lg", LYRIC_INK)}>{loaded ? "沒有找到歌詞" : " "}</p>
    );
  }
  const modes = readingModes(lyrics);
  const shown: ReadingMode = modes.includes(mode) ? mode : "off";
  const { main, second } = stageLines(timed, now);
  const dots = countdown(timed, now);
  return (
    <div aria-live="off" className="grid justify-items-center gap-[0.35em] text-center">
      <Countdown left={dots} />
      <LineText
        line={main === null ? null : (lines[main] ?? null)}
        now={now}
        mode={shown}
        reduced={reduced}
        kind="current"
        className={LYRIC_MAIN}
      />
      <LineText
        line={second === null ? null : (lines[second] ?? null)}
        now={null}
        mode={shown}
        reduced={reduced}
        kind="next"
        className={LYRIC_NEXT}
      />
    </div>
  );
}

/** Four dots, one going out each second before a line after a rest. */
function Countdown({ left }: { left: number | null }) {
  return (
    <div
      className="flex h-2 items-center justify-center gap-2.5"
      role={left === null ? undefined : "img"}
      aria-label={left === null ? undefined : `${left} 秒後開始`}
    >
      {left !== null &&
        Array.from({ length: COUNTDOWN_DOTS }, (_, i) => COUNTDOWN_DOTS - i).map((n) => (
          <i
            key={n}
            data-dot={n <= left ? "on" : "off"}
            className={cn(
              "size-2 rounded-full bg-primary shadow-[0_0_0_1.5px_rgba(0,0,0,0.7)]",
              n <= left ? "opacity-100" : "opacity-20",
            )}
          />
        ))}
    </div>
  );
}

/** One line; `now` lights its pieces as they are sung (`null`: the line to come, not lit). */
function LineText({
  line,
  now,
  mode,
  reduced,
  kind,
  className,
}: {
  line: WorkersKaraokeLineV2 | null;
  now: number | null;
  mode: ReadingMode;
  reduced: boolean;
  kind: "current" | "next";
  className: string;
}) {
  const ruby = mode !== "off";
  const box = cn(
    "max-w-full text-balance break-words",
    LYRIC_INK,
    className,
    ruby ? "min-h-[2.2em] leading-[2]" : "min-h-[1.45em]",
  );
  if (line === null) return <p data-line={kind} className={box} />;
  const doubtful = isDoubtful(line);
  const progress = now === null ? null : lineProgress(line, now);
  const pieces = line.pieces;
  return (
    <p
      data-line={kind}
      className={cn(
        box,
        doubtful && "underline decoration-white/55 decoration-dotted decoration-2 underline-offset-[0.3em]",
      )}
      title={doubtful ? "這一行和聽到的不太一樣" : undefined}
    >
      {pieces === null
        ? line.text
        : pieces.map((p, i) => {
            const raw = progress === null ? null : (progress[i] ?? 0);
            return (
              <Piece
                key={i}
                piece={p}
                ruby={rubyOf(p, mode)}
                at={raw === null ? null : reduced ? stepped(raw) : raw}
              />
            );
          })}
    </p>
  );
}

function Piece({ piece, ruby, at }: { piece: WorkersKaraokePiece; ruby: string | null; at: number | null }) {
  const text = at === null ? piece.text : <Lit text={piece.text} at={at} />;
  if (ruby === null || !piece.sung) return <>{text}</>;
  return (
    <ruby className="[ruby-position:over]">
      {text}
      <rt className={LYRIC_RUBY}>{ruby}</rt>
    </ruby>
  );
}

/** The piece white, and the primary colour over the share already sung. */
function Lit({ text, at }: { text: string; at: number }) {
  return (
    <span className="relative inline-block whitespace-pre">
      <span>{text}</span>
      <span
        aria-hidden
        data-lit={at >= 1 ? "all" : at > 0 ? "part" : "none"}
        className="absolute inset-0 whitespace-pre text-primary transition-[clip-path] duration-100 ease-linear motion-reduce:transition-none"
        style={{ clipPath: fillClip(at) }}
      >
        {text}
      </span>
    </span>
  );
}

/** 不顯示 / 假名 / 羅馬字 (or 拼音) for the readings, when the song has any. */
export function ReadingToggle({
  lyrics,
  mode,
  onMode,
}: {
  lyrics: WorkersKaraokeLyricsV2 | null;
  mode: ReadingMode;
  onMode: (m: ReadingMode) => void;
}) {
  const modes = readingModes(lyrics);
  if (modes.length === 0) return null;
  const shown: ReadingMode = modes.includes(mode) ? mode : "off";
  return (
    <Segmented<ReadingMode>
      label="讀音"
      value={shown}
      onChange={onMode}
      options={(["off", ...modes] as ReadingMode[]).map((m) => ({
        value: m,
        label: readingLabel(m, lyrics?.language ?? null),
      }))}
    />
  );
}

/** 「聽寫」 when the lyrics are what the recogniser heard. */
export function HeardBadge({ lyrics }: { lyrics: WorkersKaraokeLyricsV2 | null }) {
  if (lyrics?.source !== "heard") return null;
  return (
    <Badge title="歌詞是聽出來的,可能有錯" aria-label="聽寫:歌詞是聽出來的,可能有錯">
      聽寫
    </Badge>
  );
}
