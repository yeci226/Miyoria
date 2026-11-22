// Spectating a room's round (「卡拉 OK 第二次實測留下的」): every singer's own pitch relayed to the
// people watching and to her stream's lanes without the song worker, the limits on it, the board
// on the estimate when the worker lags, the round's words on the stream before its files, cheers
// and who hears of them.

import { rm } from "node:fs/promises";
import type { KaraokeRoomEvent, KaraokeRoomView } from "@miyoria/contracts/api";
import type { AccountRef } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHEER_BURST,
  CHEER_GAP_MS,
  CHEER_WINDOW_MS,
  PITCH_PER_S,
  ROOM_CHEERS_PER_S,
} from "../src/rooms.js";
import {
  asSubmitted,
  decodeTrack,
  encodeTrack,
  fromBase64,
  TRACK_HZ,
  toBase64,
} from "../src/score/index.js";
import { KaraokeError } from "../src/service.js";
import { humanSinger } from "../src/testing.js";
import { ALICE, acc, BOB, CAROL, DAVE, makeRig, type Rig, song } from "./room-rig.js";

let rig: Rig;

beforeEach(async () => {
  rig = await makeRig();
});

afterEach(async () => {
  await rig.desk.idle();
  rig.raw.close();
  await rm(rig.dir, { recursive: true, force: true });
});

function refused(f: () => unknown, status: number): void {
  try {
    f();
  } catch (error) {
    expect(error).toBeInstanceOf(KaraokeError);
    expect((error as KaraokeError).status).toBe(status);
    return;
  }
  throw new Error(`expected a refusal ${status}`);
}

function follow(code: string, account: AccountRef): KaraokeRoomEvent[] {
  const got: KaraokeRoomEvent[] = [];
  rig.desk.follow(code, account, (e) => got.push(structuredClone(e)));
  return got;
}

const idOf = (view: KaraokeRoomView, name: string): string =>
  view.members.find((m) => m.name === name)?.id ?? "";

/** Alice and Bob sing (`latency` for Alice), Carol and Dave watch; the round has started. */
async function round(
  latency = 0,
): Promise<{ code: string; startAt: number; view: KaraokeRoomView }> {
  const room = await rig.desk.open(ALICE, "Alice", rig.songId, 0);
  await rig.desk.join(room.code, BOB, "Bob", "singer");
  await rig.desk.join(room.code, CAROL, "Carol", "spectator");
  await rig.desk.join(room.code, DAVE, "Dave", "spectator");
  rig.desk.ready(room.code, ALICE, { ready: true, latency_ms: latency, calibrated: true });
  rig.desk.ready(room.code, BOB, { ready: true, latency_ms: 0, calibrated: true });
  const started = await rig.desk.start(room.code, ALICE);
  const startAt = started.start_at_ms as number;
  rig.clock.t = startAt;
  await rig.desk.tick();
  return { code: room.code, startAt, view: rig.desk.view(room.code, CAROL) };
}

/** `n` frames of a steady note from frame `from`, as a pitch post's track. */
const sung = (n: number, midi = 64): string =>
  toBase64(encodeTrack(Array.from({ length: n }, () => midi)));

describe("the singers' pitch, relayed", () => {
  it("reaches the people watching and the stream's lanes with no song worker at all", async () => {
    rig.worker.streamMode = "down";
    const { code, startAt, view } = await round();
    const carol = follow(code, CAROL);
    const alice = follow(code, ALICE);
    // A quarter of a second at a time, as the browser posts it.
    for (let k = 1; k <= 8; k++) {
      rig.clock.t = startAt + k * 250;
      rig.desk.pitch(code, ALICE, (k - 1) * 12, sung(12));
      rig.desk.pitch(code, BOB, (k - 1) * 12, sung(12, 60));
      await rig.desk.tick();
      await rig.desk.idle();
    }
    const live = carol.filter((e) => e.type === "live");
    // About every quarter second, each with both singers' latest second.
    expect(live.length).toBeGreaterThanOrEqual(6);
    const last = live.at(-1);
    if (last?.type !== "live") throw new Error("no live");
    const lines = new Map(last.lines.map((l) => [l.member, l.pitch]));
    const a = lines.get(idOf(view, "Alice"));
    expect(a?.from).toBe(96 - 50);
    expect(decodeTrack(fromBase64(a?.track ?? "") ?? new Uint8Array())).toHaveLength(50);
    expect(lines.get(idOf(view, "Bob"))).toBeDefined();
    // A singer never gets it.
    expect(alice.some((e) => e.type === "live")).toBe(false);
    // The stream's scene has each singer's pitch, a board and a live estimate without the worker.
    await rig.desk.tick();
    const scene = rig.staged.scenes.at(-1);
    expect(scene?.state).toBe("singing");
    const line = scene?.board.find((l) => l.name === "Alice");
    expect(line?.pitch).not.toBeNull();
    expect(line?.source).toBe("estimate");
  });

  it("puts the round's words and notes on the stream at once, its files when they come", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    const file = rig.worker.file.bind(rig.worker);
    rig.worker.file = async (song, name, dest) => {
      await held;
      return file(song, name, dest);
    };
    await round();
    expect(rig.staged.lyrics).toHaveLength(1);
    const first = rig.staged.lyrics[0];
    expect(first?.notes.length).toBeGreaterThan(10);
    expect(first).toMatchObject({ video: null, backing: null });
    release();
    await rig.desk.idle();
    expect(rig.staged.lyrics).toHaveLength(2);
    expect(rig.staged.lyrics[1]?.backing).toMatchObject({ format: "pcm" });
    expect(rig.staged.lyrics[1]?.notes).toEqual(first?.notes);
  });

  it("is placed on the reference by the singer's latency", async () => {
    const { code, startAt } = await round(200);
    rig.clock.t = startAt + 2_000;
    rig.desk.pitch(code, ALICE, 50, sung(40));
    rig.clock.t += 250;
    await rig.desk.tick();
    const pitch = rig.staged.scenes.at(-1)?.board.find((l) => l.name === "Alice")?.pitch;
    const frames = decodeTrack(fromBase64(pitch?.track ?? "") ?? new Uint8Array());
    // Sung from frame 50 but 200 ms late: from frame 40 on the reference.
    expect((pitch?.from ?? 0) + frames.findIndex((m) => m !== null)).toBe(40);
  });

  it("is refused from anyone but the round's singers, ahead of Core's clock, past the song, or too fast", async () => {
    const { code, startAt } = await round();
    rig.clock.t = startAt + 1_000;
    // Watching is not singing.
    refused(() => rig.desk.pitch(code, CAROL, 0, sung(10)), 409);
    // Four seconds of pitch one second in: made beforehand.
    refused(() => rig.desk.pitch(code, ALICE, 0, sung(200)), 400);
    // A little ahead (clocks differ) is fine.
    rig.desk.pitch(code, ALICE, 0, sung(100));
    // Far past the song.
    rig.clock.t = startAt + 10 * 60_000;
    refused(() => rig.desk.pitch(code, ALICE, 29_000, sung(10)), 400);
    refused(() => rig.desk.pitch(code, ALICE, -1, sung(10)), 400);
    refused(() => rig.desk.pitch(code, ALICE, 0, "not base64!"), 400);
    // At most a few posts a second.
    rig.clock.t = startAt + 3_000;
    for (let k = 0; k < PITCH_PER_S; k++) rig.desk.pitch(code, BOB, k, sung(1));
    refused(() => rig.desk.pitch(code, BOB, 20, sung(1)), 429);
    rig.clock.t += 1_001;
    rig.desk.pitch(code, BOB, 21, sung(1));
  });

  it("runs the board on the estimate while the worker's live score lags far behind", async () => {
    const { code, startAt } = await round();
    const track = asSubmitted(humanSinger(song, { seed: 4 }));
    // The worker only ever gets the first second of Alice's voice.
    rig.worker.streamTracks.set(
      rig.desk.view(code, ALICE).me?.session?.session ?? "",
      track.slice(0, 50),
    );
    for (let ms = 200; ms <= 8_000; ms += 200) {
      rig.clock.t = startAt + ms;
      const at = (ms - 200) * 16;
      rig.desk.audio(code, ALICE, at, ms - 200, false, new Uint8Array(3_200).fill(0x9f));
      const from = Math.round(((ms - 200) / 1000) * TRACK_HZ);
      rig.desk.pitch(code, ALICE, from, toBase64(encodeTrack(track.slice(from, from + 10))));
      await rig.desk.tick();
      await rig.desk.idle();
    }
    const line = rig.staged.scenes.at(-1)?.board.find((l) => l.name === "Alice");
    expect(line?.total ?? 0).toBeGreaterThan(0);
    expect(line?.source).toBe("estimate");
  });
});

describe("cheers", () => {
  it("go to everyone watching, to the singer cheered and onto the stream, never to the other singers", async () => {
    const { code, startAt, view } = await round();
    const carol = follow(code, CAROL);
    const alice = follow(code, ALICE);
    const bob = follow(code, BOB);
    rig.clock.t = startAt + 1_000;
    const reply = rig.desk.cheer(code, DAVE, { member: idOf(view, "Bob"), kind: "wow" });
    expect(reply.wait_ms).toBe(CHEER_GAP_MS);
    const cheer = carol.find((e) => e.type === "cheer");
    expect(cheer).toMatchObject({
      type: "cheer",
      member: idOf(view, "Bob"),
      kind: "wow",
      by: { name: "Dave" },
    });
    expect(bob.some((e) => e.type === "cheer")).toBe(true);
    expect(alice.some((e) => e.type === "cheer")).toBe(false);
    const scene = rig.staged.scenes.at(-1);
    expect(scene?.cheers).toEqual([
      expect.objectContaining({
        kind: "wow",
        to: { name: "Bob", color: 1 },
        by: { name: "Dave", color: 3 },
      }),
    ]);
    // It stays on the scene a few seconds, and the singer's line counts it.
    for (let k = 0; k < 4; k++) {
      rig.clock.t += 1_000;
      await rig.desk.tick();
    }
    expect(rig.staged.scenes.at(-1)?.board.find((l) => l.name === "Bob")?.cheers).toBe(1);
    rig.clock.t += 3_000;
    await rig.desk.tick();
    expect(rig.staged.scenes.at(-1)?.cheers).toEqual([]);
  });

  it("are limited per person and per room, and only while the round is on, from who is not singing it", async () => {
    const { code, startAt, view } = await round();
    const bob = idOf(view, "Bob");
    rig.clock.t = startAt + 500;
    // Singers sing; a name not singing is nobody to cheer.
    refused(() => rig.desk.cheer(code, ALICE, { member: bob, kind: "cheer" }), 409);
    refused(() => rig.desk.cheer(code, CAROL, { member: idOf(view, "Dave"), kind: "cheer" }), 404);
    refused(() => rig.desk.cheer(code, acc("77"), { member: bob, kind: "cheer" }), 409);
    // One every gap; a burst at most in the window.
    rig.desk.cheer(code, CAROL, { member: bob, kind: "cheer" });
    refused(() => rig.desk.cheer(code, CAROL, { member: bob, kind: "nice" }), 429);
    for (let k = 1; k < CHEER_BURST; k++) {
      rig.clock.t += CHEER_GAP_MS;
      rig.desk.cheer(code, CAROL, { member: bob, kind: "nice" });
    }
    rig.clock.t += CHEER_GAP_MS;
    refused(() => rig.desk.cheer(code, CAROL, { member: bob, kind: "nice" }), 429);
    rig.clock.t = startAt + 500 + CHEER_WINDOW_MS + 1;
    rig.desk.cheer(code, CAROL, { member: bob, kind: "encore" });
    // Everyone together: a few a second.
    const crowd = Array.from({ length: ROOM_CHEERS_PER_S + 1 }, (_, i) => acc(`5${i}`));
    for (const a of crowd) await rig.desk.join(code, a, `Fan${a.id}`, "spectator");
    rig.clock.t += 5_000;
    for (const a of crowd.slice(0, ROOM_CHEERS_PER_S))
      rig.desk.cheer(code, a, { member: bob, kind: "cheer" });
    refused(
      () => rig.desk.cheer(code, crowd.at(-1) as AccountRef, { member: bob, kind: "cheer" }),
      429,
    );
    // Once the song is over, no more.
    rig.clock.t = startAt + 10 * 60_000;
    refused(() => rig.desk.cheer(code, DAVE, { member: bob, kind: "cheer" }), 409);
  });
});
