// Shared set-up of the artifact store tests: a migrated in-memory database with identity, a blob
// root in a temporary folder, a clock the test moves, a few places, and sample bytes of each kind.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ContextKey } from "@miyoria/types";
import { artifactSchema } from "../src/artifacts/migrations.js";
import { type ArtifactPlace, ArtifactStore, type ArtifactStoreOptions } from "../src/index.js";
import { openTestDb, type TestDb } from "../src/testing.js";

export const T0 = Date.parse("2026-11-15T00:00:00.000Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** Bytes that start with `head` (ASCII or bytes) and run to `size`. */
export function bytes(head: readonly number[] | string, size = 256): Uint8Array {
  const start = typeof head === "string" ? [...Buffer.from(head, "latin1")] : head;
  const out = new Uint8Array(Math.max(size, start.length));
  out.set(start);
  for (let i = start.length; i < out.length; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

const riff = (form: string) => [...Buffer.from("RIFF"), 0x24, 0, 0, 0, ...Buffer.from(form)];

/** A sample of every accepted type, by its sniffed mime. */
export const SAMPLES: Record<string, Uint8Array> = {
  "image/png": bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": bytes([0xff, 0xd8, 0xff, 0xe0]),
  "image/webp": bytes([...riff("WEBP"), ...Buffer.from("VP8 ")]),
  "image/gif": bytes("GIF89a"),
  "audio/wav": bytes([...riff("WAVE"), ...Buffer.from("fmt ")]),
  "audio/mpeg": bytes("ID3\x04\x00"),
  "audio/ogg": bytes("OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00OpusHead"),
  "video/mp4": bytes("\x00\x00\x00\x20ftypisom\x00\x00\x02\x00"),
  "audio/mp4": bytes("\x00\x00\x00\x20ftypM4A \x00\x00\x02\x00"),
  "video/webm": bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x84, ...Buffer.from("webm")]),
  "application/pdf": bytes("%PDF-1.7\n"),
  "text/plain": new TextEncoder().encode("她寫的一段話。\nA line of text.\n"),
};

export interface Fixture {
  t: TestDb;
  store: ArtifactStore;
  root: string;
  clock: { now(): number; set(ms: number): void; advance(ms: number): void };
  /** A guild room, its space, a thread of it, a DM and home. */
  room: ArtifactPlace;
  thread: ArtifactPlace;
  otherRoom: ArtifactPlace;
  dm: ArtifactPlace;
  home: ArtifactPlace;
  /** The person who wrote in the room and in the DM. */
  person: string;
  /** Someone else in the same space. */
  other: string;
  /** A person never seen in the space. */
  stranger: string;
  close(): void;
}

const channel = (id: string): ContextKey => ({
  platform: "discord",
  scope: "g1",
  channel: id,
  kind: "channel",
});

/** A fresh fixture; `close()` it in `afterEach`. */
export function fixture(options: Partial<ArtifactStoreOptions> = {}): Fixture {
  let now = T0;
  const clock = {
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
  const t = openTestDb({ identity: true, plugins: [artifactSchema], clock });
  const root = mkdtempSync(join(tmpdir(), "miyoria-artifacts-"));
  const identity = t.identity;
  if (identity === null) throw new Error("identity was asked for");
  const owen = { account: { platform: "discord", id: "100" }, display_name: "Owen" };
  const mia = { account: { platform: "discord", id: "200" }, display_name: "Mia" };
  const room = identity.resolve(channel("c1"), owen);
  identity.resolve(channel("c1"), mia);
  const otherRoom = identity.resolve(channel("c2"), owen);
  const thread = identity.resolve(
    { platform: "discord", scope: "g1", channel: "t1", kind: "thread" },
    owen,
    { parent: "c1" },
  );
  const dm = identity.resolve(
    { platform: "discord", scope: null, channel: "d1", kind: "dm" },
    owen,
  );
  const stranger = identity.see({ platform: "discord", id: "300" }, "Lee").id;
  const store = new ArtifactStore(t.db, t.events, { root, ...options });
  const place = (p: { session: string; space_id: string | null; room_id: string }) => ({
    session: p.session,
    space_id: p.space_id,
    room_id: p.room_id,
  });
  return {
    t,
    store,
    root,
    clock,
    room: place(room),
    thread: place(thread),
    otherRoom: place(otherRoom),
    dm: place(dm),
    home: { session: "home", space_id: null, room_id: null },
    person: room.person_id as string,
    other: identity.personOf(mia.account)?.id as string,
    stranger,
    close: () => {
      t.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** An async iterable over `chunks` that waits for `gate` before the last one. */
export function gatedStream(chunks: Uint8Array[], gate: Promise<void>): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; i < chunks.length; i++) {
        if (i === chunks.length - 1) await gate;
        yield chunks[i] as Uint8Array;
      }
    },
  };
}

/** A promise and the function that settles it. */
export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
