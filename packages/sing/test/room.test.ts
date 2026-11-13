// 「語音頻道現場」 and the queue line: what she asked for on 2026-11-11 (who is listening, who came
// in or left, who asked for which song and in what order), read from voice events and the set list.

import type { ContextKey, PromptRequest, VoiceParticipant } from "@miyoria/types";
import { describe, expect, test } from "vitest";
import { queueLine } from "../src/prompt.js";
import { ROOM_RECENT_MS, roomLines, VoiceRoom, VoiceRoomPrompt } from "../src/room.js";
import type { SongEntry } from "../src/setlist.js";

const VOICE: ContextKey = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" };
const TEXT: ContextKey = { platform: "discord", scope: "g1", channel: "t1", kind: "channel" };

function person(id: string, name: string, extra: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return {
    account: { platform: "discord", id },
    display_name: name,
    is_self: false,
    muted: false,
    deafened: false,
    ...extra,
  };
}

const ME = person("0", "Miyo", { is_self: true });
const OWEN = person("1", "Owen");
const AMY = person("2", "Amy");
const BRIAN = person("3", "Brian");

function song(no: number, by: VoiceParticipant | null, state: SongEntry["state"], progress = 0) {
  return {
    no,
    requester: by?.account ?? null,
    requester_name: by?.display_name ?? "觀眾",
    state,
    progress,
  } as SongEntry;
}

function setup() {
  let now = 1_000_000;
  const room = new VoiceRoom(() => now);
  const move = (ms: number) => {
    now += ms;
  };
  const members = (list: VoiceParticipant[]) =>
    room.onEvent({ type: "voice_participants", data: { context: VOICE, participants: list } });
  room.onEvent({ type: "voice_joined", data: { context: VOICE, participants: [ME, OWEN, AMY] } });
  const lines = (songs: SongEntry[], voice = false) => {
    const r = room.room("g1");
    if (r === null) throw new Error("not in voice");
    return roomLines(r, songs, now, voice);
  };
  return { room, move, members, lines };
}

describe("VoiceRoom", () => {
  test("who_is_listening_and_each_coming_and_going_is_a_line", () => {
    const { move, members, lines } = setup();
    const songs = [song(2, OWEN, "playing"), song(3, AMY, "ready"), song(4, OWEN, "preparing")];
    // Those already there when she came in are not "came in".
    expect(lines(songs)).toEqual(["在聽(2 人):Owen(點了 #2(正在唱)、#4)、Amy(點了 #3)"]);
    move(60_000);
    members([ME, OWEN, AMY, BRIAN]);
    move(4 * 60_000);
    members([ME, OWEN, BRIAN]);
    move(30_000);
    expect(lines(songs)).toEqual([
      "在聽(2 人):Owen(點了 #2(正在唱)、#4)、Brian",
      "剛剛的進出:",
      "- 剛剛 Amy 離開了(點的 #3 還沒唱完)",
      "- 4 分鐘前 Brian 進來了",
      "點歌的人不在語音裡:#3(Amy)。要唱可以先問一聲或等對方回來。",
    ]);
    // Coming back clears "left"; after a while the moves are no longer mentioned.
    members([ME, OWEN, BRIAN, AMY]);
    move(ROOM_RECENT_MS);
    expect(lines(songs)).toEqual(["在聽(3 人):Owen(點了 #2(正在唱)、#4)、Brian、Amy(點了 #3)"]);
  });

  test("deafened_people_and_an_empty_channel", () => {
    const { members, lines } = setup();
    members([ME, OWEN, person("2", "Amy", { deafened: true })]);
    expect(lines([])).toEqual(["在聽(1 人):Owen", "關了喇叭、聽不到你:Amy"]);
    members([ME, person("1", "Owen", { deafened: true })]);
    expect(lines([])[0]).toBe("語音頻道裡的人都關了喇叭,現在沒人聽得到你。");
    members([ME]);
    expect(lines([])[0]).toBe("語音頻道裡除了你沒有別人,現在唱或說話都沒人聽得到。");
  });

  test("a_voice_turn_leaves_the_names_to_the_people_block", () => {
    const { lines } = setup();
    expect(lines([song(3, AMY, "ready")], true)).toEqual(["點了歌的人:Amy(點了 #3)"]);
    expect(lines([], true)).toEqual([]);
  });

  test("present_says_who_is_in_her_channel_and_null_when_it_cannot_tell", () => {
    const { room, members } = setup();
    expect(room.present("g1", AMY.account)).toBe(true);
    members([ME, OWEN]);
    expect(room.present("g1", AMY.account)).toBe(false);
    // A web viewer is never in a Discord channel; another guild she is not in is unknown.
    expect(room.present("g1", { platform: "web", id: "2" })).toBeNull();
    expect(room.present("g2", OWEN.account)).toBeNull();
  });

  test("the_block_shows_in_the_guilds_text_channels_until_she_leaves", async () => {
    const { room } = setup();
    const prompt = new VoiceRoomPrompt(room, { open: () => [] });
    const ask = (context: ContextKey) =>
      prompt.contribute({ context, voice: context.kind === "voice" } as PromptRequest);
    expect((await ask(TEXT))[0]).toMatchObject({ title: "語音頻道現場", key: "voice_room" });
    expect(await ask({ ...TEXT, scope: "other" })).toEqual([]);
    room.onEvent({ type: "voice_left", data: { context: VOICE, reason: null } });
    expect(await ask(TEXT)).toEqual([]);
  });
});

describe("queueLine", () => {
  test("whose_turn_is_next_in_request_order", () => {
    expect(
      queueLine([
        song(2, OWEN, "playing"),
        song(3, AMY, "ready"),
        song(4, OWEN, "preparing", 0.4),
        { ...song(5, null, "ready"), practice: true },
      ]),
    ).toBe(
      "點歌佇列(照點歌順序):正在唱 #2(Owen)→ 下一首 #3(Amy,準備好了) → 第 2 首 #4(Owen,準備中 40%)",
    );
    expect(queueLine([song(2, OWEN, "playing")])).toBeNull();
    expect(queueLine([])).toBeNull();
  });
});
