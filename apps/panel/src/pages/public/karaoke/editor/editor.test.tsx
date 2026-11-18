// The reference editor (`/karaoke?edit=<song>`, panel admins): the undo history, the timeline's
// geometry and drags, tapping along, the words for a line; then the page: only an admin gets the way
// in, lines that want a look come first with what was heard, edits are undone and redone, a save
// sends the edit with its revision and shows Core's refusal, problems keep it from saving, restoring
// asks first, and leaving with changes unsaved asks first. The audio is a fake.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KaraokeEditView, KaraokeOverview, KaraokeSongView } from "@miyoria/contracts/api";
import type { WorkersKaraokeLineV2, WorkersKaraokePiece, WorkersKaraokeReferenceV2 } from "@miyoria/contracts/workers/karaoke";
import { mockFetch, renderPage } from "@/test/render";
import { KaraokePage } from "../KaraokePage";
import {
  dragPiece,
  grabPiece,
  isDirty,
  lineFlags,
  lineOrder,
  lineWindow,
  midiName,
  pushHistory,
  redo,
  savedAs,
  startHistory,
  TapAlong,
  undo,
} from "./model";
import { type EditorPlayer, setPlayerFactory } from "./player";
import { SHORTCUTS } from "./parts";

const piece = (text: string, start: number | null, end: number | null, sung = true): WorkersKaraokePiece => ({
  text,
  sung,
  start,
  end,
  reading: null,
  roman: null,
});

const line = (over: Partial<WorkersKaraokeLineV2> = {}): WorkersKaraokeLineV2 => ({
  start: 2,
  end: 5,
  text: "紙船",
  status: "matched",
  source: "found",
  similarity: 0.95,
  heard: "紙船",
  aligned: true,
  pieces: [piece("紙", 2, 2.5), piece("船", 2.5, 3.2)],
  edited: false,
  ...over,
});

describe("reference editor: the model", () => {
  it("undoes and redoes, and an edit that changes nothing is not a step", () => {
    let h = startHistory("a");
    h = pushHistory(h, "b");
    h = pushHistory(h, "b");
    expect(h.past).toEqual(["a"]);
    expect(isDirty(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe("a");
    expect(isDirty(h)).toBe(false);
    h = redo(h);
    expect(h.present).toBe("b");
    h = savedAs(h, "c");
    expect(isDirty(h)).toBe(false);
    // What Core saved stands for the last edit: undo goes to the one before it.
    expect(undo(h).present).toBe("a");
  });

  it("grabs a shared edge, a lone edge or a block, and keeps drags inside the line and off neighbours", () => {
    const pieces = [piece("紙", 2, 2.5), piece("船", 2.5, 3.2), piece("，", null, null, false), piece("夜", 3.5, 4)];
    const span = { from: 1, to: 6, width: 500 };
    // 100 px a second: 2.5 s is x 150.
    expect(grabPiece(pieces, span, 150)).toEqual({ kind: "edge", k: 0, next: 1 });
    expect(grabPiece(pieces, span, 100)).toEqual({ kind: "start", k: 0 });
    expect(grabPiece(pieces, span, 220)).toEqual({ kind: "end", k: 1 });
    expect(grabPiece(pieces, span, 280)).toEqual({ kind: "move", k: 3 });
    expect(grabPiece(pieces, span, 330)).toBeNull();
    // The shared edge moves both, never past either piece's far end.
    expect(dragPiece(pieces, { kind: "edge", k: 0, next: 1 }, 0.2, 2, 5)).toEqual([
      [0, 2, 2.7],
      [1, 2.7, 3.2],
    ]);
    expect(dragPiece(pieces, { kind: "edge", k: 0, next: 1 }, 5, 2, 5)[0]?.[2]).toBeCloseTo(3.17);
    // A block stops at the next timed piece and at the line's start.
    expect(dragPiece(pieces, { kind: "move", k: 1 }, 1, 2, 5)).toEqual([[1, 2.8, 3.5]]);
    expect(dragPiece(pieces, { kind: "start", k: 0 }, -1, 2, 5)).toEqual([[0, 2, 2.5]]);
  });

  it("shows a line with its pieces and a little either side", () => {
    expect(lineWindow(line({ pieces: [piece("紙", 1.5, 2.5)] }), 60)).toEqual({ from: 0.7, to: 5.8 });
  });

  it("times pieces from a key held while each is sung, keeping what was not tapped", () => {
    const tap = new TapAlong(3);
    tap.down(1);
    tap.up(1.4);
    tap.down(1.5);
    expect(tap.done).toBe(false);
    expect(tap.times([null, null, [9, 10]], 1.8)).toEqual([[1, 1.4], [1.5, 1.8], [9, 10]]);
    tap.down(2);
    tap.up(2.5);
    expect(tap.done).toBe(true);
    expect(tap.times([null, null, null], 3)).toEqual([[1, 1.4], [1.5, 2], [2, 2.5]]);
  });

  it("names a line's state, lists the doubtful first, and names notes", () => {
    expect(lineFlags(line({ status: "uncertain" }))).toEqual({ words: ["不確定"], look: true });
    expect(lineFlags(line({ status: "uncertain", edited: true }))).toEqual({ words: ["已改"], look: false });
    expect(lineFlags(line({ source: "heard", status: "uncertain", aligned: false })).words).toEqual(["聽寫", "沒有逐字"]);
    expect(lineOrder([line(), line({ status: "failed" }), line()], true)).toEqual([1, 0, 2]);
    expect(lineOrder([line(), line({ status: "failed" })], false)).toEqual([0, 1]);
    expect(midiName(60)).toBe("C4");
    expect(midiName(69.2)).toBe("A4 +20");
  });

  it("lists a shortcut for every frequent action", () => {
    const keys = SHORTCUTS.map(([k]) => k);
    for (const k of ["空白鍵", "Enter", "L", "T", "Ctrl + Z", "Ctrl + S", "Delete", "?"]) expect(keys).toContain(k);
  });
});

// ---- the page --------------------------------------------------------------------------------------

const song = (over: Partial<KaraokeSongView> = {}): KaraokeSongView => ({
  id: "k1",
  title: "紙船",
  artist: "示範",
  duration_s: 30,
  state: "ready",
  stage: null,
  progress: 1,
  position: null,
  error: null,
  lyrics: true,
  lyrics_source: "found",
  notes: 2,
  video: false,
  mine: false,
  best: null,
  sung: 0,
  ...over,
});

const overview = (admin: boolean): KaraokeOverview => ({
  open: false,
  admin,
  preparing: true,
  songs: [song()],
  limits: { daily: 10, used: 0, max_minutes: 8 },
  tolerance_cents: 50,
  comments: false,
  recent: [],
});

const LINES = [
  line(),
  line({ start: 6, end: 9, text: "夜空", heard: "也空", similarity: 0.5, status: "uncertain", aligned: false, pieces: [piece("夜", null, null), piece("空", null, null)] }),
];

const REFERENCE: WorkersKaraokeReferenceV2 = {
  format: "miyoria.karaoke.reference",
  version: 2,
  id: "k1",
  title: "紙船",
  artist: "示範",
  duration_s: 30,
  backing: "karaoke.m4a",
  pitch: { hz: 50, start: 0, midi: Array.from({ length: 1500 }, (_, i) => (i > 100 && i < 450 ? 62 : null)) },
  notes: [
    { start: 2, end: 2.5, midi: 62, source: "lyric", line: 0, char: 0 },
    { start: 2.5, end: 3.2, midi: 64, source: "lyric", line: 0, char: 1 },
  ],
  lyrics: { provider: "lrclib", source: "found", language: "zh", timing: "char", check: null, lines: LINES },
  quality: { ok: true, reason: null, voiced_ratio: 0.5, notes: 2, lead_split: true },
  made: { pitch: "rmvpe", notes: "lyric", lyrics: "line", asr: null, aligner: null },
};

const editView = (over: Partial<KaraokeEditView> = {}): KaraokeEditView => ({
  song: { id: "k1", title: "紙船", artist: "示範", duration_s: 30 },
  reference: REFERENCE,
  original: { lyrics: REFERENCE.lyrics, notes: REFERENCE.notes, pitch_shift: 0 },
  edit: { revision: 0, pitch_shift: 0, saved_by: null, saved_at: null, worker_changed: false },
  history: [],
  results: 3,
  backing_url: "/api/member/karaoke/edit/k1/backing",
  ...over,
});

class FakePlayer implements EditorPlayer {
  played: [number, number | null, boolean][] = [];
  #playing = false;
  async load() {
    return { duration: 30, envelope: new Float32Array(3000) };
  }
  play(from: number, to: number | null, loop: boolean) {
    this.played.push([from, to, loop]);
    this.#playing = true;
  }
  stop() {
    this.#playing = false;
  }
  time() {
    return 0;
  }
  playing() {
    return this.#playing;
  }
  setRate() {}
  setTone() {}
  close() {}
}

let player: FakePlayer;
beforeEach(() => {
  player = new FakePlayer();
  setPlayerFactory(() => player);
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
});

function site(o: { admin?: boolean; view?: KaraokeEditView; save?: { status?: number; body: unknown } } = {}) {
  const sent: { method: string; path: string; body: unknown }[] = [];
  mockFetch((method, url, body) => {
    const path = url.pathname;
    if (!path.startsWith("/api/member/karaoke")) return undefined;
    if (path === "/api/member/karaoke") return { body: overview(o.admin ?? true) };
    if (path === "/api/member/karaoke/songs/k1/edit") {
      if (method === "GET") return { body: o.view ?? editView() };
      sent.push({ method, path, body });
      return o.save ?? { body: editView({ edit: { revision: 1, pitch_shift: 0, saved_by: "小魚乾", saved_at: "2026-11-18T10:00:00Z", worker_changed: false } }) };
    }
    if (path === "/api/member/karaoke/songs/k1/edit/restore") {
      sent.push({ method, path, body });
      return { body: editView() };
    }
    return undefined;
  });
  return sent;
}

const openEditor = async () => {
  window.history.replaceState(null, "", "/karaoke?edit=k1");
  renderPage(<KaraokePage member={{ name: "小魚乾", avatar_url: null } as never} home="/me" />);
  return screen.findByRole("region", { name: /^第 \d 行$/ });
};

describe("reference editor: the page", () => {
  it("gives only an admin the way in from the song list", async () => {
    site({ admin: false });
    const first = renderPage(<KaraokePage member={{ name: "m", avatar_url: null } as never} home="/" />);
    await screen.findByText("現在沒有開放唱歌");
    first.unmount();
    site({ admin: true });
    renderPage(<KaraokePage member={{ name: "m", avatar_url: null } as never} home="/" />);
    await userEvent.click(await screen.findByRole("button", { name: "改 紙船 的歌詞和音符" }));
    expect(await screen.findByRole("region", { name: "第 2 行" })).toBeInTheDocument();
    expect(window.location.search).toContain("edit=k1");
  });

  it("opens on the doubtful line, with what was heard beside it, listed first", async () => {
    site();
    const block = await openEditor();
    expect(block).toHaveAccessibleName("第 2 行");
    expect(within(block).getByText("也空")).toBeInTheDocument();
    expect(within(block).getByText("像 50%")).toBeInTheDocument();
    const rows = within(screen.getByRole("list", { name: "行" })).getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("夜空");
    expect(rows[0]).toHaveTextContent("不確定");
    expect(screen.getByText(/已經記下 3 次分數/)).toBeInTheDocument();
  });

  it("edits, undoes and redoes, and saves the edit with its revision", async () => {
    const sent = site();
    const block = await openEditor();
    await userEvent.click(within(block).getByRole("button", { name: "平均分配字的時間" }));
    expect(screen.getByText("還沒存")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    await waitFor(() => expect(screen.queryByText("還沒存")).toBeNull());
    fireEvent.keyDown(window, { key: "y", ctrlKey: true });
    expect(await screen.findByText("還沒存")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    const body = sent[0]?.body as { revision: number; lyrics: { lines: WorkersKaraokeLineV2[] }; pitch_shift: number };
    expect(sent[0]?.method).toBe("PUT");
    expect(body.revision).toBe(0);
    expect(body.lyrics.lines[1]?.aligned).toBe(true);
    expect(body.lyrics.lines[1]?.edited).toBe(true);
    expect(body.lyrics.lines[1]?.pieces?.map((p) => [p.start, p.end])).toEqual([
      [6, 7.5],
      [7.5, 9],
    ]);
    expect(await screen.findByText("改過的第 1 版")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText("還沒存")).toBeNull());
  });

  it("shows Core's refusal of a save", async () => {
    site({ save: { status: 400, body: { error: "第 2 行:開始的時間要比上一行晚" } } });
    const block = await openEditor();
    await userEvent.click(within(block).getByRole("button", { name: "這一行沒問題" }));
    await userEvent.click(screen.getByRole("button", { name: "儲存" }));
    expect(await screen.findByText("第 2 行:開始的時間要比上一行晚")).toBeInTheDocument();
  });

  it("will not save while there are problems, and lists them", async () => {
    site();
    const block = await openEditor();
    const text = within(block).getByDisplayValue("夜空");
    await userEvent.clear(text);
    fireEvent.blur(text);
    const problems = await screen.findByRole("button", { name: /個問題/ });
    expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
    await userEvent.click(problems);
    expect(await screen.findByText("第 2 行:沒有字")).toBeInTheDocument();
  });

  it("plays the line, loops it, and taps it along with the space key", async () => {
    site();
    const block = await openEditor();
    await userEvent.click(within(block).getByRole("button", { name: "循環" }));
    await userEvent.click(within(block).getByRole("button", { name: "播放這一行" }));
    expect(player.played.at(-1)).toEqual([6, 9, true]);
    fireEvent.keyDown(window, { key: "Enter" });
    await userEvent.click(within(block).getByRole("button", { name: "跟著按" }));
    expect(player.played.at(-1)).toEqual([4.5, 10, false]);
    for (const [down, up] of [
      [6.1, 6.6],
      [7, 8],
    ] as const) {
      player.time = () => down;
      fireEvent.keyDown(window, { key: " " });
      player.time = () => up;
      act(() => {
        fireEvent.keyUp(window, { key: " " });
      });
    }
    expect(await screen.findByText("還沒存")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "行" })).toHaveTextContent("已改");
  });

  it("asks before restoring the worker's, and before leaving with changes unsaved", async () => {
    const saved = editView({ edit: { revision: 2, pitch_shift: 0, saved_by: "小魚乾", saved_at: "2026-11-18T10:00:00Z", worker_changed: true } });
    const sent = site({ view: saved });
    const block = await openEditor();
    expect(screen.getByRole("status")).toHaveTextContent("重新準備過");
    await userEvent.click(screen.getByRole("button", { name: "還原成原本的" }));
    await userEvent.click(await screen.findByRole("button", { name: "還原" }));
    await waitFor(() => expect(sent.map((s) => [s.path, s.body])).toEqual([["/api/member/karaoke/songs/k1/edit/restore", { revision: 2 }]]));
    await userEvent.click(within(block).getByRole("button", { name: "這一行沒問題" }));
    await userEvent.click(screen.getByRole("button", { name: "回到歌單" }));
    expect(await screen.findByText("還沒存的修改會不見")).toBeInTheDocument();
  });
});
