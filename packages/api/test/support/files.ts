// Shared set-up of the file tests: a migrated in-memory database with identity and the artifact
// tables, a blob root in a temporary folder, a clock the test moves, a guild room with two members,
// a DM, and real pictures made with sharp (one with EXIF, one with bytes after its end).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactPlace, ArtifactStore, artifactSchema } from "@miyoria/store";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { ContextKey, PersonId } from "@miyoria/types";
import sharp from "sharp";

export const T0 = Date.parse("2026-11-22T00:00:00.000Z");
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export interface FilesFixture {
  t: TestDb;
  store: ArtifactStore;
  clock: { now(): number; advance(ms: number): void };
  room: ArtifactPlace;
  dm: ArtifactPlace;
  /** Wrote in the room and in the DM. */
  person: PersonId;
  /** Wrote in the same room. */
  other: PersonId;
  /** Never seen in the space. */
  stranger: PersonId;
  close(): void;
}

const channel = (id: string): ContextKey => ({
  platform: "discord",
  scope: "g1",
  channel: id,
  kind: "channel",
});

export function filesFixture(): FilesFixture {
  let now = T0;
  const clock = {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
  const t = openTestDb({ identity: true, plugins: [artifactSchema], clock });
  const root = mkdtempSync(join(tmpdir(), "miyoria-files-"));
  const identity = t.identity;
  if (identity === null) throw new Error("identity was asked for");
  const owen = { account: { platform: "discord", id: "100" }, display_name: "Owen" };
  const mia = { account: { platform: "discord", id: "200" }, display_name: "Mia" };
  const room = identity.resolve(channel("c1"), owen);
  identity.resolve(channel("c1"), mia);
  const dm = identity.resolve(
    { platform: "discord", scope: null, channel: "d1", kind: "dm" },
    owen,
  );
  const stranger = identity.see({ platform: "discord", id: "300" }, "Lee").id as PersonId;
  const store = new ArtifactStore(t.db, t.events, { root });
  const place = (p: { session: string; space_id: string | null; room_id: string }) => ({
    session: p.session,
    space_id: p.space_id,
    room_id: p.room_id,
  });
  return {
    t,
    store,
    clock,
    room: place(room),
    dm: place(dm),
    person: room.person_id as PersonId,
    other: identity.personOf(mia.account)?.id as PersonId,
    stranger,
    close: () => {
      t.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The account of `person` in the fixture (Owen 100, Mia 200, Lee 300). */
export const ACCOUNTS = {
  owen: { platform: "discord", id: "100" },
  mia: { platform: "discord", id: "200" },
  lee: { platform: "discord", id: "300" },
} as const;

/** A secret written into the pictures' metadata: it must never come out. */
export const HIDDEN = "OWNER-GPS-25.0330N-121.5654E";

/** A JPEG with EXIF naming `HIDDEN`. */
export function jpegWithExif(): Promise<Buffer> {
  return sharp({ create: { width: 8, height: 6, channels: 3, background: "#c08040" } })
    .jpeg()
    .withExif({ IFD0: { Copyright: HIDDEN, Artist: HIDDEN } })
    .toBuffer();
}

/** A PNG with `HIDDEN` hidden after its end (`IEND`). */
export async function pngWithTrailer(): Promise<Buffer> {
  const png = await sharp({ create: { width: 5, height: 5, channels: 4, background: "#4080c0" } })
    .png()
    .toBuffer();
  return Buffer.concat([png, Buffer.from(HIDDEN, "latin1")]);
}

export const contains = (bytes: Uint8Array, text: string) =>
  Buffer.from(bytes).includes(Buffer.from(text, "latin1"));
