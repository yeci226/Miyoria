// The rooms' test rig (shared by the room tests and `/me play karaoke`'s): a real store (SQLite in
// memory), a song worker and a wallet in memory with the economy's rules, one ready song, and what
// went to her stream's scene and to the comment channel.

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  KaraokeStageLyrics,
  KaraokeStageScene,
  KaraokeStageVoice,
} from "@miyoria/contracts/stage-link";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { AccountRef, PersonId } from "@miyoria/types";
import { type KaraokeConfig, KaraokeConfigSchema } from "../src/config.js";
import { karaokeSchema } from "../src/migrations.js";
import { RoomDesk, type RoomNotice, type RoomPlaces } from "../src/rooms.js";
import { type KaraokeNote, KaraokeService } from "../src/service.js";
import { KaraokeStore } from "../src/store.js";
import { FakeKaraokeWallet, FakeKaraokeWorker, referenceOf, synthSong } from "../src/testing.js";

export const acc = (id: string): AccountRef => ({ platform: "discord", id });
export const ALICE = acc("1");
export const BOB = acc("2");
export const CAROL = acc("3");
export const DAVE = acc("4");
export const STRANGER = acc("9");
export const PEOPLE: Record<string, string | null> = {
  "1": "p-alice",
  "2": "p-bob",
  "3": "p-carol",
  "4": "p-dave",
};
export const CHANNEL = "discord:111111:222222";
export const T0 = Date.UTC(2026, 10, 18, 4, 0, 0);
export const song = synthSong(3, 4);
export const RATE = 16_000;

export interface Rig {
  desk: RoomDesk;
  service: KaraokeService;
  worker: FakeKaraokeWorker;
  wallet: FakeKaraokeWallet;
  store: KaraokeStore;
  notes: KaraokeNote[];
  clock: { t: number };
  voice: { on: boolean };
  hasWallet: { on: boolean };
  raw: TestDb;
  dir: string;
  config: KaraokeConfig;
  songId: string;
  /** What went to her stream's scene. */
  staged: {
    scenes: KaraokeStageScene[];
    lyrics: KaraokeStageLyrics[];
    voices: KaraokeStageVoice[];
  };
  /** The room notices posted in the comment channel (`announce`), by message id, in order. */
  notices: { id: string; channel: string; notice: RoomNotice }[];
  /** Another desk on the same store and wallet: Core after a restart. */
  restart(): RoomDesk;
}

/** Rooms in servers (phase 6): the desk's places, and her voice per server. */
export interface RigPlaces {
  places?: RoomPlaces;
  /** Whether she is in voice in `space` (`null`: anywhere); default: `voice.on`. */
  inVoice?: (space: string | null) => boolean;
}

export async function makeRig(
  overrides: Partial<KaraokeConfig> = {},
  where: RigPlaces = {},
): Promise<Rig> {
  const raw = openTestDb({ identity: true, plugins: [karaokeSchema] });
  const store = new KaraokeStore(raw.db, raw.events);
  const worker = new FakeKaraokeWorker();
  const notes: KaraokeNote[] = [];
  const clock = { t: T0 };
  const voice = { on: true };
  const hasWallet = { on: true };
  const dir = await mkdtemp(join(tmpdir(), "karaoke-rooms-"));
  const config = KaraokeConfigSchema.parse({ comment_channel: CHANNEL, ...overrides });
  const wallet = new FakeKaraokeWallet(PEOPLE, () => clock.t);
  for (const p of ["p-alice", "p-bob", "p-carol", "p-dave"]) wallet.balances.set(p, 100);
  const who = (account: AccountRef) => ({
    person: (PEOPLE[account.id] ?? null) as PersonId | null,
    blocked: false,
  });
  const log = { info: () => {}, warn: () => {} };
  const staged: Rig["staged"] = { scenes: [], lyrics: [], voices: [] };
  const notices: Rig["notices"] = [];
  const service = new KaraokeService({
    config,
    store,
    worker: () => worker,
    now: () => clock.t,
    cacheDir: dir,
    who,
    tell: (note) => notes.push(note),
    together: () => {},
    log,
  });
  const desk = (): RoomDesk => {
    const d = new RoomDesk({
      config,
      store,
      service,
      worker: () => worker,
      wallet: () => (hasWallet.on ? wallet : null),
      inVoice: where.inVoice ?? (() => voice.on),
      ...(where.places === undefined ? {} : { places: where.places }),
      who,
      tell: (note) => notes.push(note),
      together: () => {},
      now: () => clock.t,
      log,
      stage: {
        scene: (x) => staged.scenes.push(structuredClone(x)),
        lyrics: (x) => staged.lyrics.push(structuredClone(x)),
        voice: (x) => staged.voices.push(structuredClone(x)),
      },
      announce: {
        post: async (channel, notice) => {
          const id = `m${notices.length + 1}`;
          notices.push({ id, channel: channel.channel, notice: structuredClone(notice) });
          return id;
        },
        edit: async (channel, id, notice) => {
          notices.push({ id, channel: channel.channel, notice: structuredClone(notice) });
        },
      },
      random: (() => {
        let x = 0.1;
        return () => {
          x = (x * 9301 + 0.49297) % 1;
          return x;
        };
      })(),
    });
    service.attachRooms(d);
    return d;
  };
  const asked = await service.request(ALICE, "https://youtu.be/rooms", true);
  const job = store.song(asked.song.id)?.job as string;
  worker.finish(job, referenceOf(song, `k-${job}`));
  await service.tick(new AbortController().signal);
  return {
    desk: desk(),
    service,
    worker,
    wallet,
    store,
    notes,
    clock,
    voice,
    hasWallet,
    raw,
    dir,
    config,
    songId: asked.song.id,
    staged,
    notices,
    restart: desk,
  };
}
