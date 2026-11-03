// The lyrics card: one message while she sings, showing the current line, edited at most every
// MIN_EDIT_MS and deleted (or blanked) when the song ends.

import type { Logger } from "@miyoria/kernel";
import { type ContextKey, type MessageRef, type SongCue, systemClock } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CardView,
  LyricsCard,
  MIN_EDIT_MS,
  PROGRESS_MS,
  renderCard,
  SongMetaSchema,
} from "../src/index.js";

const view = (over: Partial<CardView> = {}): CardView => ({
  title: "Sakura no Uta",
  artist: "Hana",
  line: "春の風",
  lyrics: "synced",
  elapsedMs: 84_000,
  durationMs: 238_000,
  ...over,
});

describe("renderCard", () => {
  it("shows the title, the artist, the line big and the progress", () => {
    expect(renderCard(view())).toBe("🎵 **Sakura no Uta** — Hana\n## 春の風\n`1:24 / 3:58`");
  });

  it("leaves the artist out when there is none", () => {
    expect(renderCard(view({ artist: null })).split("\n")[0]).toBe("🎵 **Sakura no Uta**");
  });

  it("shows a note between lines and a notice without lyrics", () => {
    expect(renderCard(view({ line: null })).split("\n")[1]).toBe("## 🎶");
    expect(renderCard(view({ line: null, lyrics: "none" })).split("\n")[1]).toBe("## (沒找到歌詞)");
  });

  it("escapes markdown and line breaks in untrusted text", () => {
    const line = renderCard(view({ line: "# **@everyone**\n- x_y" })).split("\n")[1];
    expect(line).toBe("## \\# \\*\\*@everyone\\*\\* \\- x\\_y");
    const title = renderCard(view({ title: "a`b|c>d[e]~f\\g" })).split("\n")[0];
    expect(title).toBe("🎵 **a\\`b\\|c\\>d\\[e\\]\\~f\\\\g** — Hana");
  });

  it("cuts each untrusted text to 200 characters", () => {
    const line = renderCard(view({ line: "あ".repeat(250) })).split("\n")[1] as string;
    expect(line).toBe(`## ${"あ".repeat(200)}`);
  });

  it("shows the progress without a length", () => {
    expect(renderCard(view({ durationMs: null })).split("\n")[2]).toBe("`1:24`");
  });
});

const ctx: ContextKey = { platform: "discord", scope: "1", channel: "300", kind: "voice" };
const song = SongMetaSchema.parse({
  id: "s1",
  title: "Sakura no Uta",
  artist: "Hana",
  duration_s: 238,
  lyrics: { synced: true, lines: [{ t: 1, text: "a" }] },
  play: { sample_rate: 44100, samples: null },
});

function fakeLog(): Logger & { warns: unknown[][] } {
  const warns: unknown[][] = [];
  const noop = () => {};
  const log = {
    warns,
    fatal: noop,
    error: noop,
    warn: (...args: unknown[]) => warns.push(args),
    info: noop,
    debug: noop,
    trace: noop,
    child: () => log,
  };
  return log as unknown as Logger & { warns: unknown[][] };
}

function fakeSink(fail: { send?: boolean; edit?: boolean } = {}) {
  const sent: string[] = [];
  const edits: { at: number; text: string }[] = [];
  return {
    sent,
    edits,
    async send(context: ContextKey, message: { text: string }): Promise<MessageRef> {
      if (fail.send) throw new Error("403 Missing Permissions");
      sent.push(message.text);
      return { context, id: "m1" };
    },
    async edit(_m: MessageRef, text: string): Promise<void> {
      if (fail.edit) throw new Error("edit failed");
      edits.push({ at: Date.now(), text });
    },
  };
}

const started: SongCue = {
  state: "started",
  song: "s1",
  title: "Sakura no Uta",
  duration_ms: 238_000,
};
const line = (index: number, text: string): SongCue => ({ state: "line", song: "s1", index, text });
const ended = (outcome: string): SongCue => ({ state: "ended", song: "s1", outcome });

describe("LyricsCard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function card(fail: { send?: boolean; edit?: boolean } = {}, canDelete = false) {
    const base = fakeSink(fail);
    const deleted: string[] = [];
    const sink = canDelete
      ? Object.assign(base, {
          deleted,
          async delete(m: MessageRef): Promise<void> {
            deleted.push(m.id);
          },
        })
      : Object.assign(base, { deleted });
    const log = fakeLog();
    const c = new LyricsCard({ sink, context: ctx, song, clock: systemClock, log });
    return { sink, log, c };
  }

  it("sends the card when the song starts", async () => {
    const { sink, c } = card();
    c.onCue(started);
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.sent).toHaveLength(1);
    expect(sink.sent[0]).toContain("## 🎶");
  });

  it("edits only the newest of lines that come quickly", async () => {
    const { sink, c } = card();
    c.onCue(started);
    await vi.advanceTimersByTimeAsync(0);
    c.onCue(line(0, "a"));
    await vi.advanceTimersByTimeAsync(100);
    c.onCue(line(1, "b"));
    await vi.advanceTimersByTimeAsync(100);
    c.onCue(line(2, "c"));
    await vi.advanceTimersByTimeAsync(MIN_EDIT_MS);
    expect(sink.edits.map((e) => e.text.split("\n")[1])).toEqual(["## c"]);
  });

  it("keeps edits at least MIN_EDIT_MS apart", async () => {
    const { sink, c } = card();
    c.onCue(started);
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 8; i++) {
      c.onCue(line(i, `l${i}`));
      await vi.advanceTimersByTimeAsync(400);
    }
    await vi.advanceTimersByTimeAsync(MIN_EDIT_MS);
    expect(sink.edits.length).toBeGreaterThan(1);
    for (let i = 1; i < sink.edits.length; i++) {
      const gap = (sink.edits[i]?.at ?? 0) - (sink.edits[i - 1]?.at ?? 0);
      expect(gap).toBeGreaterThanOrEqual(MIN_EDIT_MS);
    }
    expect(sink.edits.at(-1)?.text).toContain("## l7");
  });

  it("updates the progress every PROGRESS_MS between lines", async () => {
    const { sink, c } = card();
    c.onCue(started);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(PROGRESS_MS);
    expect(sink.edits).toHaveLength(1);
    expect(sink.edits[0]?.text).toContain("`0:10 / 3:58`");
  });

  it("deletes the card when the song ends and never touches it again", async () => {
    for (const outcome of ["finished", "interrupted"]) {
      const { sink, c } = card({}, true);
      c.onCue(started);
      await vi.advanceTimersByTimeAsync(0);
      c.onCue(line(0, "a"));
      c.onCue(ended(outcome));
      await vi.advanceTimersByTimeAsync(MIN_EDIT_MS);
      expect(sink.deleted).toEqual(["m1"]);
      const count = sink.edits.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sink.edits).toHaveLength(count);
      expect(sink.deleted).toEqual(["m1"]);
    }
  });

  it("blanks the card when the platform cannot delete", async () => {
    const { sink, c } = card();
    c.onCue(started);
    await vi.advanceTimersByTimeAsync(0);
    c.onCue(ended("finished"));
    await vi.advanceTimersByTimeAsync(MIN_EDIT_MS);
    expect(sink.edits.map((e) => e.text)).toEqual(["** **"]);
  });

  it("does nothing for a song that ends before it started", async () => {
    const { sink, c } = card();
    c.onCue(ended("error"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sink.sent).toHaveLength(0);
    expect(sink.edits).toHaveLength(0);
  });

  it("gives up quietly when the card cannot be sent", async () => {
    const { sink, log, c } = card({ send: true });
    c.onCue(started);
    await vi.advanceTimersByTimeAsync(0);
    c.onCue(line(0, "a"));
    c.onCue(ended("finished"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sink.edits).toHaveLength(0);
    expect(log.warns).toHaveLength(1);
  });

  it("stops editing after an edit fails", async () => {
    const { sink, log, c } = card({ edit: true });
    c.onCue(started);
    await vi.advanceTimersByTimeAsync(0);
    c.onCue(line(0, "a"));
    await vi.advanceTimersByTimeAsync(MIN_EDIT_MS);
    c.onCue(line(1, "b"));
    c.onCue(ended("finished"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(log.warns).toHaveLength(1);
    expect(sink.sent).toHaveLength(1);
  });
});
