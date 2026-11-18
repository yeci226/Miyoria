// The reference editor (docs/design/karaoke.md 「做了什麼第六步」): a panel admin corrects a
// prepared song's lyrics and guide notes on the member page, one line at a time, and saves the
// result as the song's reference for everyone (Core keeps the worker's own, so it can be restored).
// Lines the recogniser was unsure of, or did not hear as written, are listed first with what it
// heard beside them. A line's pieces are timed on its timeline (drag, or tap along while it plays),
// its readings typed under it, its notes moved, resized, split, merged, added or deleted on the
// lane. Playback is the backing (with the reference curve as a tone when wanted), a line or from
// the cursor, looped, at 0.5×, 0.75× or 1×, with the wipe previewed as it will be sung. Every
// change is one undo step for the session; leaving with changes unsaved asks first.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KaraokeEditView } from "@miyoria/contracts/api";
import type { WorkersKaraokeLineV2 } from "@miyoria/contracts/workers/karaoke";
import {
  addNote,
  deleteLine,
  deleteNotes,
  docOf,
  type EditDoc,
  type EditProblem,
  fitLineToPieces,
  insertLine,
  markChecked,
  mergeLines,
  mergeNotes,
  moveNotes,
  type NoteEdit,
  piecesOf,
  setLineText,
  setLineTimes,
  setNote,
  setPiece,
  shiftLine,
  shiftLyrics,
  shiftSong,
  splitLine,
  splitNote,
  spreadPieces,
  timePieces,
  validateEdit,
} from "@miyoria/play/karaoke/edit";
import { ArrowLeft, Pause, Play, Redo2, Repeat, RotateCcw, Save, Undo2 } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { describeError } from "@/api/http";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { Page } from "@/components/page";
import { ErrorLine, SkeletonRows } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { fmtDateTime } from "@/lib/format";
import { notify } from "@/lib/notify";
import { cn } from "@/lib/utils";
import { Refusal } from "../bits";
import { midiRange } from "../lane";
import { loadReading, type ReadingMode, saveReading } from "../lyric-text";
import { KARAOKE, OVERVIEW } from "../queries";
import {
  clockOf,
  type History,
  isDirty,
  lineFlags,
  lineWindow,
  midiName,
  pushHistory,
  redo,
  savedAs,
  startHistory,
  sungTimes,
  TapAlong,
  undo,
} from "./model";
import { LineList, PiecesGrid, Preview, Problems, SavedBlock, ShortcutHelp, SongTools } from "./parts";
import { createPlayer, type EditorPlayer } from "./player";
import { Timeline } from "./Timeline";

export const editKey = (id: string) => [...KARAOKE, "edit", id] as const;

type Rate = "0.5" | "0.75" | "1";

/** Seconds played before a line when tapping along, to get the beat. */
const TAP_LEAD_S = 1.5;

export function ReferenceEditor({ songId, onBack }: { songId: string; onBack: () => void }) {
  const api = useApi();
  const view = useQuery({
    queryKey: editKey(songId),
    queryFn: ({ signal }) => api.rpc.karaoke.editor({ params: { id: songId } }, { signal }),
    retry: false,
    refetchOnWindowFocus: false,
  });
  if (view.isPending) {
    return (
      <Page>
        <SkeletonRows count={6} />
      </Page>
    );
  }
  if (view.isError) {
    return (
      <Page>
        <Button variant="outline" className="w-fit" onClick={onBack}>
          <ArrowLeft aria-hidden />
          回到歌單
        </Button>
        <ErrorLine error={view.error} onRetry={() => void view.refetch()} />
      </Page>
    );
  }
  return <Editor key={songId} initial={view.data} onBack={onBack} />;
}

function Editor({ initial, onBack }: { initial: KaraokeEditView; onBack: () => void }) {
  const api = useApi();
  const client = useQueryClient();
  const [view, setView] = useState(initial);
  const [history, setHistory] = useState<History<EditDoc>>(() =>
    startHistory(docOf(initial.reference, initial.edit.pitch_shift)),
  );
  const doc = history.present;
  const lines = doc.lyrics?.lines ?? [];
  const songEnd = view.song.duration_s;
  const [current, setCurrent] = useState(() => {
    const look = lines.findIndex((l) => lineFlags(l).look);
    return Math.max(0, look);
  });
  const line = lines[Math.min(current, lines.length - 1)] ?? null;
  const at = line === null ? -1 : Math.min(current, lines.length - 1);
  const [selection, setSelection] = useState<number[]>([]);
  const [piece, setPieceSel] = useState<number | null>(null);
  const [cursor, setCursor] = useState(() => line?.start ?? 0);
  const [lookFirst, setLookFirst] = useState(true);
  const [rate, setRate] = useState<Rate>("1");
  const [loop, setLoop] = useState(false);
  const [tone, setTone] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [help, setHelp] = useState(false);
  const [reading, setReading] = useState<ReadingMode>(() => loadReading());
  const [leaving, setLeaving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [envelope, setEnvelope] = useState<Float32Array>(() => new Float32Array());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tapping, setTapping] = useState<{ tap: TapAlong; before: ReturnType<typeof sungTimes>; line: number } | null>(null);
  const player = useRef<EditorPlayer | null>(null);

  // ---- the curve and the staff ----
  // The worker's curve (what Core moves by the shift), and the curve as it will be sung.
  const baseCurve = useMemo(() => {
    const s = view.edit.pitch_shift;
    return s === 0 ? view.reference.pitch.midi : view.reference.pitch.midi.map((m) => (m === null ? null : Math.round((m - s) * 100) / 100));
  }, [view]);
  const curve = useMemo(
    () => ({
      hz: view.reference.pitch.hz,
      start: view.reference.pitch.start,
      midi: doc.pitch_shift === 0 ? baseCurve : baseCurve.map((m) => (m === null ? null : m + doc.pitch_shift)),
    }),
    [view, baseCurve, doc.pitch_shift],
  );
  // The staff stays put while notes move: the song's range, anew only when the whole song moves.
  const range = useMemo(() => midiRange(curve.midi, doc.notes), [curve]);
  const problems = useMemo(() => validateEdit(doc, { duration_s: songEnd, curve: baseCurve }), [doc, songEnd, baseCurve]);
  const problemLines = useMemo(() => new Set(problems.flatMap((p) => (p.line === null ? [] : [p.line]))), [problems]);
  const dirty = isDirty(history);

  // ---- playback ----
  useEffect(() => {
    const p = createPlayer();
    player.current = p;
    const ctl = new AbortController();
    p.load(view.backing_url, ctl.signal)
      .then((r) => setEnvelope(r.envelope))
      .catch((e: unknown) => {
        if (!ctl.signal.aborted) setLoadError(e instanceof Error ? e.message : "伴唱帶拿不到");
      });
    return () => {
      ctl.abort();
      p.close();
      player.current = null;
    };
  }, [view.backing_url]);
  useEffect(() => player.current?.setRate(Number(rate)), [rate]);
  useEffect(() => player.current?.setTone(tone ? curve : null), [tone, curve]);
  // Whether it still plays (a stretch ends by itself).
  useEffect(() => {
    if (!playing) return;
    const timer = window.setInterval(() => {
      if (!player.current?.playing()) setPlaying(false);
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing]);

  const lineEnd = useCallback((l: WorkersKaraokeLineV2) => l.end ?? Math.min(songEnd, l.start + 6), [songEnd]);
  const stop = useCallback(() => {
    const p = player.current;
    if (!p) return;
    if (p.playing()) setCursor(Math.round(p.time() * 100) / 100);
    p.stop();
    setPlaying(false);
  }, []);
  const playLine = useCallback(() => {
    if (!line || !player.current) return;
    player.current.play(line.start, lineEnd(line), loop);
    setPlaying(true);
  }, [line, loop, lineEnd]);
  const playCursor = useCallback(() => {
    if (!player.current) return;
    if (player.current.playing()) return stop();
    const to = loop && line ? lineEnd(line) : null;
    player.current.play(loop && line ? Math.min(cursor, line.start) : cursor, to, loop);
    setPlaying(true);
  }, [cursor, loop, line, stop, lineEnd]);
  const timeNow = useCallback(() => (player.current?.playing() ? player.current.time() : cursor), [cursor]);
  const playhead = useCallback(() => (player.current?.playing() ? player.current.time() : null), []);

  // ---- edits ----
  const apply = useCallback((fn: (d: EditDoc) => EditDoc) => setHistory((h) => pushHistory(h, fn(h.present))), []);
  const applyNotes = useCallback((fn: (d: EditDoc) => NoteEdit) => {
    setHistory((h) => {
      const r = fn(h.present);
      setSelection(r.selection);
      return pushHistory(h, r.doc);
    });
  }, []);
  const pick = useCallback(
    (i: number) => {
      const l = lines[i];
      if (!l) return;
      stop();
      setTapping(null);
      setCurrent(i);
      setSelection([]);
      setPieceSel(null);
      setCursor(l.start);
    },
    [lines, stop],
  );

  // ---- tap along ----
  const startTap = useCallback(() => {
    if (!line || !player.current) return;
    const pieces = piecesOf(line);
    const sung = pieces.filter((p) => p.sung).length;
    if (sung === 0) return;
    setTapping({ tap: new TapAlong(sung), before: sungTimes(pieces), line: at });
    player.current.play(Math.max(0, line.start - TAP_LEAD_S), Math.min(songEnd, lineEnd(line) + 1), false);
    setPlaying(true);
  }, [line, at, songEnd, lineEnd]);
  const finishTap = useCallback(
    (keep: boolean) => {
      const t = tapping;
      setTapping(null);
      const now = player.current?.time() ?? 0;
      player.current?.stop();
      setPlaying(false);
      if (!t || !keep || t.tap.tapped === 0) return;
      apply((d) => timePieces(d, t.line, t.tap.times(t.before, now)));
    },
    [tapping, apply],
  );
  // The stretch ended before every piece was tapped: what was tapped is kept.
  useEffect(() => {
    if (tapping && !playing) finishTap(true);
  }, [tapping, playing, finishTap]);

  // ---- saving ----
  const save = useMutation({
    mutationFn: () =>
      api.rpc.karaoke.saveEdit({
        params: { id: view.song.id },
        body: { revision: view.edit.revision, lyrics: doc.lyrics, notes: doc.notes, pitch_shift: doc.pitch_shift },
      }),
    onSuccess: (next) => {
      setView(next);
      client.setQueryData(editKey(next.song.id), next);
      void client.invalidateQueries({ queryKey: OVERVIEW });
      setHistory((h) => savedAs(h, docOf(next.reference, next.edit.pitch_shift)));
      notify.ok(`存好了:第 ${next.edit.revision} 版`);
    },
  });
  const restore = useMutation({
    mutationFn: () => api.rpc.karaoke.restoreEdit({ params: { id: view.song.id }, body: { revision: view.edit.revision } }),
    onSuccess: (next) => {
      setView(next);
      client.setQueryData(editKey(next.song.id), next);
      void client.invalidateQueries({ queryKey: OVERVIEW });
      setHistory((h) => savedAs(h, docOf(next.reference, next.edit.pitch_shift)));
      setRestoring(false);
      setSelection([]);
      notify.ok("還原成原本的了");
    },
  });
  const canSave = dirty && problems.length === 0 && !save.isPending;

  // Leaving the page with changes unsaved asks first.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const back = () => (dirty ? setLeaving(true) : onBack());

  const goTo = (p: EditProblem) => {
    if (p.line !== null) pick(p.line);
    if (p.note !== null) {
      const n = doc.notes[p.note];
      if (n) {
        const i = lines.findIndex((l, j) => l.start <= n.start && (lines[j + 1]?.start ?? Number.POSITIVE_INFINITY) > n.start);
        if (i >= 0 && p.line === null) pick(i);
        setSelection([p.note]);
        setCursor(n.start);
      }
    }
  };

  // ---- the keys ----
  const keys = useRef<(e: KeyboardEvent, down: boolean) => void>(() => {});
  keys.current = (e, down) => {
    if (tapping) {
      if (e.key === " ") {
        e.preventDefault();
        if (e.repeat) return;
        const t = player.current?.time() ?? 0;
        if (down) tapping.tap.down(t);
        else {
          tapping.tap.up(t);
          if (tapping.tap.done) finishTap(true);
        }
        return;
      }
      if (down && e.key === "Escape") {
        e.preventDefault();
        finishTap(false);
      }
      return;
    }
    if (!down) return;
    const target = e.target as HTMLElement | null;
    const typing = target !== null && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    if (mod && key === "s") {
      e.preventDefault();
      if (canSave) save.mutate();
      return;
    }
    if (typing) return;
    if (mod && key === "z") {
      e.preventDefault();
      setHistory((h) => (e.shiftKey ? redo(h) : undo(h)));
      return;
    }
    if (mod && key === "y") {
      e.preventDefault();
      setHistory(redo);
      return;
    }
    if (mod || e.altKey) return;
    const sel = selection;
    const act = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    switch (e.key) {
      case " ":
        return act(playCursor);
      case "Enter":
        return act(() => (player.current?.playing() ? stop() : playLine()));
      case "Escape":
        return act(() => {
          setSelection([]);
          setPieceSel(null);
        });
      case "ArrowUp":
      case "ArrowDown": {
        if (sel.length === 0) return;
        const step = (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1);
        return act(() => applyNotes((d) => moveNotes(d, sel, 0, step)));
      }
      case "ArrowLeft":
      case "ArrowRight": {
        if (sel.length === 0) return;
        const step = (e.key === "ArrowRight" ? 1 : -1) * (e.shiftKey ? 0.1 : 0.01);
        return act(() => applyNotes((d) => moveNotes(d, sel, step, 0)));
      }
      case "Delete":
      case "Backspace":
        if (sel.length === 0) return;
        return act(() => applyNotes((d) => deleteNotes(d, sel)));
      case "?":
        return act(() => setHelp((h) => !h));
    }
    switch (key) {
      case "l":
        return act(() => setLoop((v) => !v));
      case "1":
        return act(() => setRate("0.5"));
      case "2":
        return act(() => setRate("0.75"));
      case "3":
        return act(() => setRate("1"));
      case "j":
        return act(() => at > 0 && pick(at - 1));
      case "k":
        return act(() => at < lines.length - 1 && pick(at + 1));
      case "t":
        return act(startTap);
      case "s":
        if (sel.length !== 1) return;
        return act(() => applyNotes((d) => splitNote(d, sel[0] as number, cursor)));
      case "m":
        if (sel.length < 2) return;
        return act(() => applyNotes((d) => mergeNotes(d, sel)));
      case "n":
        return act(() => addAtCursor());
    }
  };
  useEffect(() => {
    const down = (e: KeyboardEvent) => keys.current(e, true);
    const up = (e: KeyboardEvent) => keys.current(e, false);
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  const addAtCursor = () => {
    const m = curve.midi[Math.round((cursor - curve.start) * curve.hz)];
    const following = doc.notes.find((n) => n.start > cursor);
    const end = Math.min(cursor + 0.3, following?.start ?? Number.POSITIVE_INFINITY, songEnd);
    if (end - cursor < 0.03) return;
    applyNotes((d) => addNote(d, cursor, end, Math.round(m ?? (range.lo + range.hi) / 2)));
  };

  const windowOf = line === null ? { from: Math.max(0, cursor - 3), to: Math.min(songEnd, cursor + 5) } : lineWindow(line, songEnd);
  const picked = selection.length === 1 ? doc.notes[selection[0] as number] : undefined;
  const flags = line === null ? null : lineFlags(line);
  const outside =
    line !== null &&
    (line.pieces ?? []).some(
      (p) => (p.start !== null && p.start < line.start - 0.001) || (p.end !== null && line.end !== null && p.end > line.end + 0.001),
    );

  return (
    <Page
      rail={
        <>
          <LineList lines={lines} current={at} problems={problemLines} lookFirst={lookFirst} onLookFirst={setLookFirst} onPick={pick} />
          <SavedBlock history={view.history} results={view.results} />
        </>
      }
    >
      {/* The bar: the song, its state, and what to do with the whole. */}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={back}>
          <ArrowLeft aria-hidden />
          回到歌單
        </Button>
        <h2 className="min-w-0 truncate text-[15px] font-semibold">
          {view.song.title}
          {view.song.artist && <span className="ml-2 font-normal text-muted-foreground">{view.song.artist}</span>}
        </h2>
        <Badge variant={view.edit.revision > 0 ? "brand" : "outline"}>
          {view.edit.revision > 0 ? `改過的第 ${view.edit.revision} 版` : "準備好時的樣子"}
        </Badge>
        {dirty && <Badge variant="warning">還沒存</Badge>}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Button variant="outline" size="icon" aria-label="復原" title="復原(Ctrl+Z)" disabled={history.past.length === 0} onClick={() => setHistory(undo)}>
            <Undo2 aria-hidden />
          </Button>
          <Button variant="outline" size="icon" aria-label="重做" title="重做(Ctrl+Shift+Z)" disabled={history.future.length === 0} onClick={() => setHistory(redo)}>
            <Redo2 aria-hidden />
          </Button>
          <Problems problems={problems} onGo={goTo} />
          <SongTools shift={doc.pitch_shift} onShift={(n) => apply((d) => shiftSong(d, n))} onLyrics={(ms) => apply((d) => shiftLyrics(d, ms))} />
          <ShortcutHelp open={help} onOpen={setHelp} />
          <Button variant="outline" disabled={view.edit.revision === 0} onClick={() => setRestoring(true)}>
            <RotateCcw aria-hidden />
            還原成原本的
          </Button>
          <Button onClick={() => save.mutate()} disabled={!canSave} busy={save.isPending} title="儲存(Ctrl+S)">
            <Save aria-hidden />
            儲存
          </Button>
        </div>
      </div>
      <div className="-mt-4 grid gap-1">
        {view.edit.revision > 0 && view.edit.saved_at && (
          <p className="text-xs text-muted-foreground">
            {view.edit.saved_by || "已被忘記的人"} 在 {fmtDateTime(view.edit.saved_at)} 存的;大家唱的是這一版
            {view.edit.pitch_shift !== 0 && `,整首移了 ${view.edit.pitch_shift > 0 ? "+" : "−"}${Math.abs(view.edit.pitch_shift)} 半音`}
          </p>
        )}
        {view.edit.worker_changed && (
          <p role="status" className="text-[13px] text-primary">
            這首重新準備過,準備歌的機器給了新的參考。大家唱的還是改過的這一版;再存一次會以新的為底(歌詞和音符照這裡的),還原就用新的。
          </p>
        )}
        {save.isError && <Refusal>{describeError(save.error)}</Refusal>}
        {loadError && <Refusal>{`${loadError},只能改不能播`}</Refusal>}
      </div>

      {line === null ? (
        <Card aria-label="歌詞">
          <CardHeader>
            <CardTitle>歌詞</CardTitle>
          </CardHeader>
          <p className="text-[13px] text-muted-foreground">這首沒有歌詞。音符還是可以改。</p>
          <Button variant="outline" className="w-fit" onClick={() => apply((d) => insertLine(d, -1, cursor))}>
            加一行
          </Button>
        </Card>
      ) : (
        <LineBlock
          key={at}
          index={at}
          line={line}
          language={doc.lyrics?.language ?? null}
          count={lines.length}
          flags={flags}
          outside={outside}
          piece={piece}
          songEnd={songEnd}
          onText={(text) => apply((d) => setLineText(d, at, text))}
          onTimes={(start, end) => apply((d) => setLineTimes(d, at, start, end))}
          onNudge={(dt) => apply((d) => shiftLine(d, at, dt))}
          onFit={() => apply((d) => fitLineToPieces(d, at))}
          onChecked={() => apply((d) => markChecked(d, at))}
          onSplit={() => piece !== null && apply((d) => splitLine(d, at, piece))}
          onMerge={() => apply((d) => mergeLines(d, at))}
          onInsert={() => {
            apply((d) => insertLine(d, at));
            setCurrent(at + 1);
          }}
          onDelete={() => {
            apply((d) => deleteLine(d, at));
            setCurrent(Math.max(0, Math.min(at, lines.length - 2)));
          }}
          onSpread={() => apply((d) => spreadPieces(d, at, songEnd))}
          onPickPiece={(k) => {
            setPieceSel(k);
            const s = line.pieces?.[k]?.start;
            if (s !== null && s !== undefined) setCursor(s);
          }}
          onReading={(k, patch) => apply((d) => setPiece(d, at, k, patch))}
        >
          <Transport
            playing={playing}
            loop={loop}
            rate={rate}
            tone={tone}
            tapping={tapping === null ? null : { done: tapping.tap.tapped, of: piecesOf(line).filter((p) => p.sung).length }}
            cursor={cursor}
            onPlayLine={() => (playing ? stop() : playLine())}
            onPlayCursor={playCursor}
            onLoop={setLoop}
            onRate={setRate}
            onTone={setTone}
            onTap={() => (tapping ? finishTap(false) : startTap())}
          />
          <Timeline
            line={line}
            window={windowOf}
            notes={doc.notes}
            selection={selection}
            piece={piece}
            curve={curve}
            envelope={envelope}
            range={range}
            songEnd={songEnd}
            cursor={cursor}
            playhead={playhead}
            playing={playing}
            onCursor={(t) => {
              setCursor(t);
              if (playing) stop();
            }}
            onPiece={setPieceSel}
            onPieces={(changes) =>
              apply((d) => changes.reduce((acc, [k, start, end]) => setPiece(acc, at, k, { start, end }), d))
            }
            onSelect={setSelection}
            onMoveNotes={(sel, dt, semis) => applyNotes((d) => moveNotes(d, sel, dt, semis))}
            onResizeNote={(i, start, end) => applyNotes((d) => setNote(d, i, { start, end }))}
            onAddNote={(start, end, midi) => applyNotes((d) => addNote(d, start, end, midi))}
          />
          <NotesBar
            count={selection.length}
            picked={picked === undefined ? null : `${midiName(picked.midi)} · ${clockOf(picked.start)} – ${clockOf(picked.end)}`}
            onShift={(n) => applyNotes((d) => moveNotes(d, selection, 0, n))}
            onSplit={() => selection.length === 1 && applyNotes((d) => splitNote(d, selection[0] as number, cursor))}
            onMerge={() => applyNotes((d) => mergeNotes(d, selection))}
            onDelete={() => applyNotes((d) => deleteNotes(d, selection))}
            onAdd={addAtCursor}
          />
        </LineBlock>
      )}

      <Preview
        lyrics={doc.lyrics}
        time={timeNow}
        playing={playing}
        mode={reading}
        onMode={(m) => {
          setReading(m);
          saveReading(m);
        }}
      />

      <ConfirmDialog
        open={leaving}
        title="還沒存的修改會不見"
        confirmLabel="不存,離開"
        onConfirm={() => {
          setLeaving(false);
          onBack();
        }}
        onClose={() => setLeaving(false)}
      >
        <p>這次改的東西還沒有存。離開之後就沒有了。</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={restoring}
        title="還原成準備好時的樣子?"
        confirmLabel="還原"
        busy={restore.isPending}
        onConfirm={() => restore.mutate()}
        onClose={() => setRestoring(false)}
      >
        <p>
          改過的版本會拿掉,大家改唱準備歌的機器做的版本。已經記下的分數不會變。{dirty && "這裡還沒存的修改也會不見。"}
        </p>
        {restore.isError && <p className="mt-2 text-primary">{describeError(restore.error)}</p>}
      </ConfirmDialog>
    </Page>
  );
}

// ---- the line -------------------------------------------------------------------------------------

function TimeField({ label, value, onCommit, allowEmpty }: { label: string; value: number | null; onCommit: (v: number | null) => void; allowEmpty?: boolean }) {
  const [text, setText] = useState(value === null ? "" : value.toFixed(2));
  useEffect(() => setText(value === null ? "" : value.toFixed(2)), [value]);
  const commit = () => {
    if (text.trim() === "" && allowEmpty) {
      if (value !== null) onCommit(null);
      return;
    }
    const n = Number(text);
    if (!Number.isFinite(n)) return setText(value === null ? "" : value.toFixed(2));
    if (n !== value) onCommit(n);
  };
  return (
    <label className="grid gap-1 text-xs text-muted-foreground">
      {label}
      <Input
        type="number"
        step={0.01}
        min={0}
        value={text}
        placeholder={allowEmpty ? "到下一行" : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
        className="w-28 font-mono text-[13px] text-foreground"
      />
    </label>
  );
}

function LineBlock({
  index,
  line,
  language,
  count,
  flags,
  outside,
  piece,
  songEnd,
  children,
  onText,
  onTimes,
  onNudge,
  onFit,
  onChecked,
  onSplit,
  onMerge,
  onInsert,
  onDelete,
  onSpread,
  onPickPiece,
  onReading,
}: {
  index: number;
  line: WorkersKaraokeLineV2;
  language: string | null;
  count: number;
  flags: { words: string[]; look: boolean } | null;
  outside: boolean;
  piece: number | null;
  songEnd: number;
  children: ReactNode;
  onText: (text: string) => void;
  onTimes: (start: number, end: number | null) => void;
  onNudge: (dt: number) => void;
  onFit: () => void;
  onChecked: () => void;
  onSplit: () => void;
  onMerge: () => void;
  onInsert: () => void;
  onDelete: () => void;
  onSpread: () => void;
  onPickPiece: (k: number) => void;
  onReading: (k: number, patch: { reading?: string | null; roman?: string | null }) => void;
}) {
  const [text, setText] = useState(line.text);
  useEffect(() => setText(line.text), [line.text]);
  const pieces = line.pieces ?? [];
  const canSplit = piece !== null && piece > 0 && piece < pieces.length;
  return (
    <Card aria-label={`第 ${index + 1} 行`}>
      <CardHeader>
        <CardTitle>
          第 {index + 1} 行
          <span className="font-normal text-muted-foreground">/ {count}</span>
        </CardTitle>
        {flags?.words.map((w) => (
          <Badge key={w} variant={w === "已改" ? "brand" : w === "沒有逐字" ? "outline" : "warning"}>
            {w}
          </Badge>
        ))}
        <CardAction className="flex-wrap">
          {flags?.look && (
            <Button variant="outline" size="sm" onClick={onChecked} title="字和時間都對:不再標成要看的">
              這一行沒問題
            </Button>
          )}
          <Button variant="outline" size="sm" disabled={!canSplit} onClick={onSplit} title="在選的字前面拆成兩行">
            拆開
          </Button>
          <Button variant="outline" size="sm" disabled={index >= count - 1} onClick={onMerge}>
            和下一行合併
          </Button>
          <Button variant="outline" size="sm" onClick={onInsert}>
            在後面加一行
          </Button>
          <Button variant="outline" size="sm" onClick={onDelete}>
            刪掉這一行
          </Button>
        </CardAction>
      </CardHeader>
      <div className="grid gap-3">
        <div className="grid gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <label className="grid gap-1 text-xs text-muted-foreground">
            字
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => text !== line.text && onText(text)}
              onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
              className="text-[15px] text-foreground"
              aria-invalid={text.trim() === "" || undefined}
            />
          </label>
          <div className="grid gap-1 text-xs text-muted-foreground">
            聽到的
            <p className="flex min-h-8 items-center rounded-md bg-black/25 px-2.5 text-[15px] text-foreground/85">
              {line.heard ?? <span className="text-[13px] text-muted-foreground">沒有聽寫</span>}
              {line.similarity !== null && (
                <span className="ml-auto pl-2 font-mono text-xs text-muted-foreground">像 {Math.round(line.similarity * 100)}%</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <TimeField label="開始(秒)" value={line.start} onCommit={(v) => v !== null && onTimes(Math.min(songEnd, Math.max(0, v)), line.end)} />
          <TimeField label="結束(秒)" value={line.end} allowEmpty onCommit={(v) => onTimes(line.start, v)} />
          <div className="flex gap-1.5">
            <Button variant="outline" onClick={() => onNudge(-0.05)} title="整行連字一起早 50 毫秒">
              整行 −50ms
            </Button>
            <Button variant="outline" onClick={() => onNudge(0.05)} title="整行連字一起晚 50 毫秒">
              整行 +50ms
            </Button>
          </div>
          {outside && (
            <Button variant="outline" onClick={onFit} className="text-primary" title="有字在這一行的時間外面">
              把行撐到字的範圍
            </Button>
          )}
          <Button variant="outline" onClick={onSpread} disabled={pieces.filter((p) => p.sung).length === 0 && line.text.trim() === ""} title="每個字平均分配這一行的時間">
            平均分配字的時間
          </Button>
        </div>
        {children}
        <PiecesGrid line={line} language={language} picked={piece} onPick={onPickPiece} onReading={onReading} />
      </div>
    </Card>
  );
}

function Transport({
  playing,
  loop,
  rate,
  tone,
  tapping,
  cursor,
  onPlayLine,
  onPlayCursor,
  onLoop,
  onRate,
  onTone,
  onTap,
}: {
  playing: boolean;
  loop: boolean;
  rate: Rate;
  tone: boolean;
  tapping: { done: number; of: number } | null;
  cursor: number;
  onPlayLine: () => void;
  onPlayCursor: () => void;
  onLoop: (v: boolean) => void;
  onRate: (r: Rate) => void;
  onTone: (v: boolean) => void;
  onTap: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={onPlayLine} disabled={tapping !== null}>
        {playing ? <Pause aria-hidden /> : <Play aria-hidden />}
        {playing ? "停止" : "播放這一行"}
      </Button>
      <Button variant="outline" onClick={onPlayCursor} disabled={tapping !== null}>
        從游標播放
        <span className="font-mono text-xs text-muted-foreground tabular-nums">{clockOf(cursor)}</span>
      </Button>
      <Button
        variant="outline"
        aria-pressed={loop}
        onClick={() => onLoop(!loop)}
        className={cn(loop && "bg-secondary text-secondary-foreground hover:bg-secondary-hover")}
      >
        <Repeat aria-hidden />
        循環
      </Button>
      <Segmented<Rate>
        label="速度"
        size="md"
        value={rate}
        onChange={onRate}
        options={[
          { value: "0.5", label: "0.5×" },
          { value: "0.75", label: "0.75×" },
          { value: "1", label: "1×" },
        ]}
      />
      <label className="flex items-center gap-2 text-[13px]">
        <Switch checked={tone} onCheckedChange={onTone} aria-label="參考音" />
        參考音
      </label>
      <Button variant={tapping ? "default" : "outline"} onClick={onTap} className="ml-auto" title="播這一行,每個字唱的時候按住空白鍵">
        {tapping ? `跟著按中 ${tapping.done} / ${tapping.of}(Esc 取消)` : "跟著按"}
      </Button>
    </div>
  );
}

function NotesBar({
  count,
  picked,
  onShift,
  onSplit,
  onMerge,
  onDelete,
  onAdd,
}: {
  count: number;
  picked: string | null;
  onShift: (semitones: number) => void;
  onSplit: () => void;
  onMerge: () => void;
  onDelete: () => void;
  onAdd: () => void;
}) {
  const none = count === 0;
  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="音符">
      <p className="mr-1 min-w-32 text-[13px]">
        {none ? <span className="text-muted-foreground">沒有選音符</span> : picked ?? `選了 ${count} 個音符`}
      </p>
      <Button variant="outline" size="sm" disabled={none} onClick={() => onShift(1)}>
        高半音
      </Button>
      <Button variant="outline" size="sm" disabled={none} onClick={() => onShift(-1)}>
        低半音
      </Button>
      <Button variant="outline" size="sm" disabled={none} onClick={() => onShift(12)}>
        高八度
      </Button>
      <Button variant="outline" size="sm" disabled={none} onClick={() => onShift(-12)}>
        低八度
      </Button>
      <Button variant="outline" size="sm" disabled={count !== 1} onClick={onSplit} title="在游標拆開">
        拆開
      </Button>
      <Button variant="outline" size="sm" disabled={count < 2} onClick={onMerge}>
        合併
      </Button>
      <Button variant="outline" size="sm" disabled={none} onClick={onDelete}>
        刪掉
      </Button>
      <Button variant="outline" size="sm" onClick={onAdd} title="在游標加一個音符;也可以在空的地方點兩下">
        在游標加音符
      </Button>
    </div>
  );
}
