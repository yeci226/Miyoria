// The reference editor's blocks around the timeline: the list of lines (those that want a look
// first), what was saved before, a line's pieces with their readings, the notes' tools, the
// whole-song tools, the problems a save would be refused for, the shortcut list and the live
// preview of the wipe.

import type { KaraokeEditEntry } from "@miyoria/contracts/api";
import type { WorkersKaraokeLineV2, WorkersKaraokeLyricsV2, WorkersKaraokePiece } from "@miyoria/contracts/workers/karaoke";
import type { EditProblem } from "@miyoria/play/karaoke/edit";
import { CircleAlert, Keyboard, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { EmptyLine } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { fmtDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ReadingMode } from "../lyric-text";
import { Lyrics, ReadingToggle } from "../Lyrics";
import { clockOf, lineFlags, lineOrder } from "./model";

// ---- the lines ----------------------------------------------------------------------------------

export function LineList({
  lines,
  current,
  problems,
  lookFirst,
  onLookFirst,
  onPick,
}: {
  lines: readonly WorkersKaraokeLineV2[];
  current: number;
  problems: ReadonlySet<number>;
  lookFirst: boolean;
  onLookFirst: (v: boolean) => void;
  onPick: (i: number) => void;
}) {
  const order = lineOrder(lines, lookFirst);
  const looks = lines.filter((l) => lineFlags(l).look).length;
  // The picked line stays in view as it changes.
  useEffect(() => {
    document.querySelector(`[data-line-row="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);
  return (
    <Card aria-label="歌詞的行">
      <CardHeader>
        <CardTitle className="text-[13px]">歌詞的行</CardTitle>
        <CardAction>
          <Segmented<"look" | "time">
            label="排列"
            size="md"
            value={lookFirst ? "look" : "time"}
            onChange={(v) => onLookFirst(v === "look")}
            options={[
              { value: "look", label: `要看的先列${looks > 0 ? ` ${looks}` : ""}` },
              { value: "time", label: "照時間" },
            ]}
          />
        </CardAction>
      </CardHeader>
      {lines.length === 0 ? (
        <EmptyLine>沒有歌詞</EmptyLine>
      ) : (
        <ol className="grid max-h-[min(60vh,560px)] overflow-y-auto pr-1" aria-label="行">
          {order.map((i) => {
            const line = lines[i] as WorkersKaraokeLineV2;
            const { words } = lineFlags(line);
            const on = i === current;
            return (
              <li key={i} data-line-row={i}>
                <button
                  type="button"
                  onClick={() => onPick(i)}
                  aria-current={on ? "true" : undefined}
                  className={cn(
                    "grid w-full grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring",
                    on && "bg-control",
                  )}
                >
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                  <span className="truncate text-[13px]">{line.text || "(沒有字)"}</span>
                  <span className="font-mono text-xs text-muted-foreground tabular-nums">{clockOf(line.start).split(".")[0]}</span>
                  <span className="flex flex-wrap gap-1">
                    {problems.has(i) && <Badge variant="default">有問題</Badge>}
                    {words.map((w) => (
                      <Badge key={w} variant={w === "已改" ? "brand" : w === "沒有逐字" ? "outline" : "warning"}>
                        {w}
                      </Badge>
                    ))}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

// ---- what was saved -------------------------------------------------------------------------------

export function SavedBlock({ history, results }: { history: readonly KaraokeEditEntry[]; results: number }) {
  return (
    <Card aria-label="存過的紀錄">
      <CardHeader>
        <CardTitle className="text-[13px]">存過的紀錄</CardTitle>
      </CardHeader>
      <p className="text-xs text-muted-foreground">
        {results > 0
          ? `這首已經記下 ${results} 次分數:照當時的參考算的,存了也不會重算,最好成績照留。`
          : "這首還沒有人唱過。"}
      </p>
      {history.length === 0 ? (
        <EmptyLine>還沒有改過</EmptyLine>
      ) : (
        <ul className="divide-y divide-line-soft">
          {history.map((h) => (
            <li key={`${h.at}-${h.revision}`} className="grid gap-0.5 py-(--row-y)">
              <p className="text-[13px]">
                {h.action === "save" ? `存了第 ${h.revision} 版` : "還原成原本的"}
                <span className="ml-2 text-muted-foreground">{h.name || "已被忘記的人"}</span>
              </p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {fmtDateTime(h.at)}
                {h.action === "save" &&
                  ` · 改過 ${h.lines} 行 · ${h.notes} 個音符${h.pitch_shift !== 0 ? ` · 整首 ${signed(h.pitch_shift)} 半音` : ""}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${Math.abs(n)}` : "0");

// ---- a line's pieces ------------------------------------------------------------------------------

/** A line's sung pieces with their readings (and romaji for Japanese), each editable. */
export function PiecesGrid({
  line,
  language,
  picked,
  onPick,
  onReading,
}: {
  line: WorkersKaraokeLineV2;
  language: string | null;
  picked: number | null;
  onPick: (k: number) => void;
  onReading: (k: number, patch: { reading?: string | null; roman?: string | null }) => void;
}) {
  const pieces = line.pieces ?? [];
  if (pieces.length === 0) return null;
  const roman = language === "ja" || pieces.some((p) => p.roman !== null);
  const readingWord = language === "zh" ? "拼音" : language === "ja" ? "假名" : "讀音";
  return (
    <div className="grid gap-1.5" aria-label="這一行的字">
      <p className="text-xs text-muted-foreground">
        字和{readingWord}
        {roman && "、羅馬字"}(點一個字選它;拆開這一行會拆在選的字前面)
      </p>
      <ul className="flex flex-wrap gap-1.5">
        {pieces.map((p, k) =>
          p.sung ? (
            <PieceCell
              key={`${k}-${p.text}`}
              piece={p}
              index={k}
              picked={picked === k}
              roman={roman}
              readingWord={readingWord}
              onPick={() => onPick(k)}
              onReading={(patch) => onReading(k, patch)}
            />
          ) : (
            <li key={`${k}-gap`} aria-hidden className="self-center px-0.5 text-[13px] text-muted-foreground">
              {p.text.trim() === "" ? "␣" : p.text}
            </li>
          ),
        )}
      </ul>
    </div>
  );
}

function PieceCell({
  piece,
  index,
  picked,
  roman,
  readingWord,
  onPick,
  onReading,
}: {
  piece: WorkersKaraokePiece;
  index: number;
  picked: boolean;
  roman: boolean;
  readingWord: string;
  onPick: () => void;
  onReading: (patch: { reading?: string | null; roman?: string | null }) => void;
}) {
  const [reading, setReading] = useState(piece.reading ?? "");
  const [romaji, setRomaji] = useState(piece.roman ?? "");
  useEffect(() => setReading(piece.reading ?? ""), [piece.reading]);
  useEffect(() => setRomaji(piece.roman ?? ""), [piece.roman]);
  const timed = piece.start !== null && piece.end !== null;
  return (
    <li
      className={cn(
        "grid w-[5.5rem] gap-1 rounded-md bg-well p-1.5",
        picked && "ring-2 ring-secondary-line",
      )}
    >
      <button
        type="button"
        onClick={onPick}
        className="min-h-7 truncate rounded-sm text-center text-[15px] outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={timed ? `${clockOf(piece.start as number)} – ${clockOf(piece.end as number)}` : "沒有時間"}
        aria-label={`第 ${index + 1} 個字「${piece.text}」${timed ? "" : ",沒有時間"}`}
      >
        {piece.text}
        {!timed && <span className="ml-0.5 text-xs text-primary">·</span>}
      </button>
      <Input
        aria-label={`「${piece.text}」的${readingWord}`}
        placeholder={readingWord}
        value={reading}
        className="h-7 px-1.5 text-center text-xs"
        onChange={(e) => setReading(e.target.value)}
        onBlur={() => reading !== (piece.reading ?? "") && onReading({ reading })}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
      />
      {roman && (
        <Input
          aria-label={`「${piece.text}」的羅馬字`}
          placeholder="羅馬字"
          value={romaji}
          className="h-7 px-1.5 text-center text-xs"
          onChange={(e) => setRomaji(e.target.value)}
          onBlur={() => romaji !== (piece.roman ?? "") && onReading({ roman: romaji })}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        />
      )}
    </li>
  );
}

// ---- the whole song -------------------------------------------------------------------------------

export function SongTools({
  shift,
  onShift,
  onLyrics,
}: {
  shift: number;
  onShift: (semitones: number) => void;
  onLyrics: (ms: number) => void;
}) {
  const [ms, setMs] = useState("0");
  const n = Number(ms);
  const usable = Number.isFinite(n) && Number.isInteger(n) && n !== 0 && Math.abs(n) <= 10_000;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline">
          <SlidersHorizontal aria-hidden />
          整首
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="grid w-80 gap-4 p-3">
        <div className="grid gap-2">
          <p className="text-[13px] font-medium">音符和參考的音高</p>
          <p className="text-xs text-muted-foreground">
            和準備好時比:{shift === 0 ? "沒有移" : `${signed(shift)} 半音`}。參考的音高是算分數用的,一起移。
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={() => onShift(-12)}>
              低八度
            </Button>
            <Button variant="outline" size="sm" onClick={() => onShift(-1)}>
              低半音
            </Button>
            <Button variant="outline" size="sm" onClick={() => onShift(1)}>
              高半音
            </Button>
            <Button variant="outline" size="sm" onClick={() => onShift(12)}>
              高八度
            </Button>
          </div>
        </div>
        <form
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (usable) onLyrics(n);
            setMs("0");
          }}
        >
          <label className="text-[13px] font-medium" htmlFor="lyrics-shift">
            歌詞的時間整首移動
          </label>
          <div className="flex items-center gap-2">
            <Input
              id="lyrics-shift"
              type="number"
              step={10}
              value={ms}
              onChange={(e) => setMs(e.target.value)}
              className="w-28 font-mono"
            />
            <span className="text-xs text-muted-foreground">毫秒(負的是提早)</span>
            <Button type="submit" variant="secondary" size="sm" className="ml-auto" disabled={!usable}>
              移動
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  );
}

// ---- problems -------------------------------------------------------------------------------------

export function Problems({ problems, onGo }: { problems: readonly EditProblem[]; onGo: (p: EditProblem) => void }) {
  if (problems.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" className="text-primary">
          <CircleAlert aria-hidden />
          {problems.length >= 50 ? "50 個以上的問題" : `${problems.length} 個問題`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-1">
        <p className="px-2 pt-1.5 pb-1 text-xs text-muted-foreground">這些改好之前不能存</p>
        <ul className="max-h-80 overflow-y-auto">
          {problems.map((p, i) => (
            <li key={`${i}-${p.message}`}>
              <button
                type="button"
                className="w-full rounded-sm px-2 py-1.5 text-left text-[13px] outline-none hover:bg-hover focus-visible:bg-hover"
                onClick={() => onGo(p)}
              >
                {p.message}
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

// ---- shortcuts ------------------------------------------------------------------------------------

/** The editor's keys, as the help lists them. */
export const SHORTCUTS: [string, string][] = [
  ["空白鍵", "從游標播放 / 停止"],
  ["Enter", "播放這一行"],
  ["L", "循環這一行"],
  ["1 / 2 / 3", "速度 0.5× / 0.75× / 1×"],
  ["J / K", "上一行 / 下一行"],
  ["T", "跟著按:每個字唱的時候按住空白鍵,Esc 取消"],
  ["↑ / ↓", "選的音符高 / 低半音"],
  ["Shift + ↑ / ↓", "選的音符高 / 低八度"],
  ["← / →", "選的音符早 / 晚 10 毫秒(加 Shift:100 毫秒)"],
  ["S", "在游標拆開選的音符"],
  ["M", "合併選的音符"],
  ["N", "在游標加一個音符"],
  ["Delete", "刪掉選的音符"],
  ["Esc", "取消選取"],
  ["Ctrl + Z", "復原"],
  ["Ctrl + Shift + Z / Ctrl + Y", "重做"],
  ["Ctrl + S", "儲存"],
  ["?", "這張表"],
];

export function ShortcutHelp({ open, onOpen }: { open: boolean; onOpen: (open: boolean) => void }) {
  return (
    <Popover open={open} onOpenChange={onOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" aria-label="快捷鍵">
          <Keyboard aria-hidden />
          快捷鍵
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[26rem] p-3">
        <p className="mb-2 text-[13px] font-medium">快捷鍵(在輸入框裡不算)</p>
        <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px]">
          {SHORTCUTS.map(([k, what]) => (
            <div key={k} className="contents">
              <dt className="font-mono text-xs leading-5 text-muted-foreground">{k}</dt>
              <dd>{what}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}

// ---- the preview ----------------------------------------------------------------------------------

/**
 * The wipe as the singer will see it, over a dark stage: following the playhead every frame while
 * it plays, else at the cursor.
 */
export function Preview({
  lyrics,
  time,
  playing,
  mode,
  onMode,
}: {
  lyrics: WorkersKaraokeLyricsV2 | null;
  time: () => number;
  playing: boolean;
  mode: ReadingMode;
  onMode: (m: ReadingMode) => void;
}) {
  // A new frame while it plays: `time()` is read on every render.
  const [, setFrame] = useState(0);
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    const loop = () => {
      setFrame((n) => n + 1);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  const now = time();
  return (
    <Card aria-label="預覽">
      <CardHeader>
        <CardTitle className="text-[13px]">預覽</CardTitle>
        <CardAction>
          <ReadingToggle lyrics={lyrics} mode={mode} onMode={onMode} />
        </CardAction>
      </CardHeader>
      <div className="relative grid h-44 place-items-center overflow-hidden rounded-md bg-black px-4 [container-type:size]">
        <Lyrics lyrics={lyrics} now={now} loaded mode={mode} />
        <span className="absolute right-2 bottom-1.5 font-mono text-xs text-white/60 tabular-nums">{clockOf(now)}</span>
      </div>
    </Card>
  );
}
