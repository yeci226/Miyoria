// The artifact store: its tables' constraints, the blob layout against hostile names, sniffing,
// ingest (buffers, streams, files, the same bytes twice, failures halfway), reading and the
// visibility of each scope.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArtifactHashMismatchError,
  ArtifactInputError,
  ArtifactNotFoundError,
  ArtifactPathError,
  ArtifactTooLargeError,
  ArtifactTypeError,
  type ArtifactViewer,
  BlobLayout,
  cleanFilename,
  decideType,
  FILENAME_MAX_BYTES,
  isSha256,
  sniff,
} from "../src/index.js";
import {
  bytes,
  DAY,
  deferred,
  type Fixture,
  fixture,
  gatedStream,
  SAMPLES,
  T0,
} from "./artifact-fixtures.js";

const sha = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

async function readAll(stream: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name);
}

let f: Fixture;
beforeEach(() => {
  f = fixture();
});
afterEach(() => {
  f.close();
});

describe("the blob layout", () => {
  it("fans out by the first two bytes of the hash", () => {
    const layout = new BlobLayout(f.root);
    const hash = "ab".repeat(32);
    expect(layout.blobPath(hash)).toBe(join(f.root, "blobs", "ab", "ab", hash));
    expect(layout.tempPath().startsWith(join(f.root, "tmp") + sep)).toBe(true);
  });

  it.each([
    "../../../etc/passwd",
    "..",
    "/etc/passwd",
    "C:\\Windows\\system32",
    "C:",
    "\\\\server\\share",
    "CON",
    "AUX.txt",
    "a".repeat(64).toUpperCase(),
    `${"a".repeat(63)}/`,
    `${"a".repeat(64)}\0`,
    `${"a".repeat(62)}..`,
    "ａ".repeat(64),
    "a".repeat(65),
    "a".repeat(300),
    "",
  ])("refuses %j as a blob name", (name) => {
    const layout = new BlobLayout(f.root);
    expect(isSha256(name)).toBe(false);
    expect(() => layout.blobPath(name)).toThrow(ArtifactPathError);
  });

  it("takes only its own temporary names from a listing", () => {
    const layout = new BlobLayout(f.root);
    const own = layout.tempPath().split(sep).pop() as string;
    expect(layout.tempFile(own)).toBe(join(f.root, "tmp", own));
    for (const name of ["../x.part", "x.part", "..", `${own}/../../a`, "CON.part"]) {
      expect(layout.tempFile(name)).toBeNull();
    }
  });

  it("refuses an empty root", () => {
    expect(() => new BlobLayout("")).toThrow(ArtifactPathError);
    expect(() => new BlobLayout("a\0b")).toThrow(ArtifactPathError);
  });
});

describe("download names", () => {
  it.each([
    ["song.mp3", "mp3", "song.mp3"],
    ["../../etc/passwd", "txt", "passwd.txt"],
    ["C:\\Users\\x\\secret.env", "txt", "secret.txt"],
    ["report.html", "txt", "report.txt"],
    ["evil\u202etxt.exe", "png", "eviltxt.png"],
    ["zero\u200bwidth\ufeff.png", "png", "zerowidth.png"],
    ["CON", "txt", "_CON.txt"],
    ["nul.tar.gz", "txt", "_nul.tar.txt"],
    ["com1", "wav", "_com1.wav"],
    ["...hidden", "txt", "hidden.txt"],
    ["--rf", "txt", "rf.txt"],
    ["trailing. . .", "pdf", "trailing.pdf"],
    ["a\u0000b\u0007c\u009fd", "txt", "abcd.txt"],
    ["   ", "jpg", "artifact.jpg"],
    [null, "webm", "artifact.webm"],
    ["Cafe\u0301", "txt", "Café.txt"],
  ])("cleans %j", (name, ext, want) => {
    expect(cleanFilename(name, ext)).toBe(want);
  });

  it("cuts long names to the byte limit without splitting a character", () => {
    const long = cleanFilename(`${"翻唱".repeat(200)}.mp3`, "mp3");
    expect(Buffer.byteLength(long, "utf8")).toBeLessThanOrEqual(FILENAME_MAX_BYTES);
    expect(long.endsWith(".mp3")).toBe(true);
    expect(long).not.toContain("\ufffd");
    const emoji = cleanFilename("😀".repeat(100), "png");
    expect(Buffer.byteLength(emoji, "utf8")).toBeLessThanOrEqual(FILENAME_MAX_BYTES);
    expect([...emoji.replace(/\.png$/, "")].every((c) => c === "😀")).toBe(true);
  });
});

describe("media types", () => {
  it.each(Object.entries(SAMPLES))("sniffs %s", (mime, data) => {
    const head = data.subarray(0, 64);
    const text = mime === "text/plain";
    expect(decideType(head, text, null).mime).toBe(mime);
    if (!text) expect(sniff(head)?.mime).toBe(mime);
  });

  it("detects a bare MP3 frame and Theora video in OGG", () => {
    expect(sniff(bytes([0xff, 0xfb, 0x90, 0x64]))?.mime).toBe("audio/mpeg");
    expect(sniff(bytes("OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00\x80theora"))?.mime).toBe(
      "video/ogg",
    );
  });

  it("refuses what is none of hers: HTML is only ever text, QuickTime, Matroska, binary junk", () => {
    expect(() => decideType(bytes("\x00\x00\x00\x14ftypqt  "), false, null)).toThrow(
      ArtifactTypeError,
    );
    expect(() =>
      decideType(bytes([0x1a, 0x45, 0xdf, 0xa3, 0x42, 0x82, 0x88]), false, null),
    ).toThrow(ArtifactTypeError);
    expect(() => decideType(bytes([0x4d, 0x5a, 0x90, 0x00]), false, null)).toThrow(
      ArtifactTypeError,
    );
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    expect(decideType(html, true, "text/html").mime).toBe("text/plain");
  });

  it("refuses a declared type the content contradicts, and takes aliases", () => {
    const png = SAMPLES["image/png"] as Uint8Array;
    expect(() => decideType(png, false, "image/jpeg")).toThrow(ArtifactTypeError);
    expect(() => decideType(png, false, "text/html")).toThrow(ArtifactTypeError);
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>");
    expect(() => decideType(svg, true, "image/svg+xml")).toThrow(ArtifactTypeError);
    expect(decideType(SAMPLES["image/jpeg"] as Uint8Array, false, "image/jpg").mime).toBe(
      "image/jpeg",
    );
    expect(decideType(SAMPLES["audio/mpeg"] as Uint8Array, false, "audio/mp3").mime).toBe(
      "audio/mpeg",
    );
    expect(decideType(SAMPLES["audio/mp4"] as Uint8Array, false, "video/mp4").mime).toBe(
      "audio/mp4",
    );
    expect(decideType(png, false, "application/octet-stream; x=1").mime).toBe("image/png");
  });
});

describe("ingest", () => {
  const input = () => ({ source: "imagegen" as const, plugin: "imagegen", place: f.room });

  it("stores bytes by hash with a row and one artifact.created event in the artifact's scope", async () => {
    const data = SAMPLES["image/png"] as Uint8Array;
    const a = await f.store.ingest(data, { ...input(), filename: "../cat.jpeg", turn: "turn1" });
    expect(a).toMatchObject({
      sha256: sha(data),
      size: data.length,
      mime: "image/png",
      kind: "image",
      filename: "cat.png",
      scope: "room",
      space_id: f.room.space_id,
      room_id: f.room.room_id,
      origin_session: f.room.session,
      downloadable: true,
      review: "pending",
      kept_by: null,
      deleted_at: null,
      expires_at: new Date(T0 + 7 * DAY).toISOString(),
    });
    expect(readFileSync(f.store.layout.blobPath(a.sha256))).toEqual(Buffer.from(data));
    expect(files(f.store.layout.tmp)).toEqual([]);
    const events = f.t.events.query({ types: ["artifact.created"] });
    expect(events).toHaveLength(1);
    expect(events[0]?.envelope).toMatchObject({
      id: a.event_id,
      scope: "room",
      tier: "keep",
      source: "imagegen",
      turn: "turn1",
      session: f.room.session,
      key: `artifact:${a.id}`,
    });
    expect(events[0]?.envelope.data).toMatchObject({ artifact_id: a.id, sha256: a.sha256 });
  });

  it("stores the same bytes once, and every sample type", async () => {
    for (const [mime, data] of Object.entries(SAMPLES)) {
      const one = await f.store.ingest(data, { ...input(), mime });
      const two = await f.store.ingest(data, { ...input(), filename: "again" });
      expect(one.id).not.toBe(two.id);
      expect(one.sha256).toBe(two.sha256);
      expect(two.mime).toBe(mime);
    }
    const blobs = f.t.db.all("SELECT COUNT(*) AS n FROM artifact_blobs")[0]?.n;
    expect(blobs).toBe(Object.keys(SAMPLES).length);
    expect(files(f.store.layout.blobs)).toHaveLength(Object.keys(SAMPLES).length);
    expect(files(f.store.layout.tmp)).toEqual([]);
  });

  it("takes two ingests of the same bytes at once", async () => {
    const data = SAMPLES["audio/wav"] as Uint8Array;
    const [a, b] = await Promise.all([
      f.store.ingest(data, input()),
      f.store.ingest(data, input()),
    ]);
    expect(a.sha256).toBe(b.sha256);
    expect(files(f.store.layout.blobs)).toHaveLength(1);
    expect(files(f.store.layout.tmp)).toEqual([]);
  });

  it("reads a stream in chunks and copies a file, leaving it in place", async () => {
    const data = SAMPLES["video/mp4"] as Uint8Array;
    const chunks = [data.subarray(0, 3), data.subarray(3, 70), data.subarray(70)];
    const fromStream = await f.store.ingestStream(gatedStream(chunks, Promise.resolve()), input());
    expect(fromStream.mime).toBe("video/mp4");
    const source = join(f.root, "report.pdf");
    writeFileSync(source, SAMPLES["application/pdf"] as Uint8Array);
    const fromFile = await f.store.ingestFile(source, { ...input(), source: "doc" });
    expect(fromFile.mime).toBe("application/pdf");
    expect(readFileSync(source)).toEqual(Buffer.from(SAMPLES["application/pdf"] as Uint8Array));
  });

  it("refuses a link, a folder and a missing file", async () => {
    const dir = join(f.root, "folder");
    mkdirSync(dir);
    await expect(f.store.ingestFile(dir, input())).rejects.toThrow(ArtifactInputError);
    await expect(f.store.ingestFile(join(f.root, "nope"), input())).rejects.toThrow(
      ArtifactInputError,
    );
    const target = join(f.root, "real.png");
    writeFileSync(target, SAMPLES["image/png"] as Uint8Array);
    const link = join(f.root, "link.png");
    let linked = true;
    try {
      symlinkSync(target, link);
    } catch {
      linked = false; // Windows without the symlink right
    }
    if (linked) await expect(f.store.ingestFile(link, input())).rejects.toThrow(ArtifactInputError);
  });

  it("refuses unknown content, a contradicted type, empty content and a wrong announced hash", async () => {
    await expect(f.store.ingest(bytes([0x4d, 0x5a, 0, 0]), input())).rejects.toThrow(
      ArtifactTypeError,
    );
    await expect(
      f.store.ingest(SAMPLES["image/gif"] as Uint8Array, { ...input(), mime: "image/png" }),
    ).rejects.toThrow(ArtifactTypeError);
    await expect(f.store.ingest(new Uint8Array(0), input())).rejects.toThrow(ArtifactTypeError);
    await expect(
      f.store.ingest(SAMPLES["image/gif"] as Uint8Array, { ...input(), sha256: "0".repeat(64) }),
    ).rejects.toThrow(ArtifactHashMismatchError);
    const ok = SAMPLES["image/gif"] as Uint8Array;
    const a = await f.store.ingest(ok, { ...input(), sha256: sha(ok).toUpperCase() });
    expect(a.sha256).toBe(sha(ok));
    expect(f.t.db.all("SELECT COUNT(*) AS n FROM artifact_items")[0]?.n).toBe(1);
    expect(files(f.store.layout.blobs)).toHaveLength(1);
    expect(files(f.store.layout.tmp)).toEqual([]);
  });

  it("refuses a kind over its limit, halfway through the stream", async () => {
    const small = fixture({ limits: { image: 100, text: 50 } });
    try {
      const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 1000);
      let pulled = 0;
      const stream = {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < 1000; i += 64) {
            pulled++;
            yield png.subarray(i, i + 64);
          }
        },
      };
      await expect(
        small.store.ingestStream(stream, { source: "imagegen", plugin: "x", place: small.room }),
      ).rejects.toThrow(ArtifactTooLargeError);
      expect(pulled).toBeLessThan(16);
      await expect(
        small.store.ingest(new TextEncoder().encode("x".repeat(51)), {
          source: "doc",
          plugin: "x",
        }),
      ).rejects.toThrow(ArtifactTooLargeError);
      expect(files(small.store.layout.tmp)).toEqual([]);
      expect(files(small.store.layout.blobs)).toEqual([]);
    } finally {
      small.close();
    }
  });

  it("leaves nothing behind when the stream fails or is aborted halfway", async () => {
    const data = SAMPLES["audio/ogg"] as Uint8Array;
    const failing = {
      async *[Symbol.asyncIterator]() {
        yield data.subarray(0, 100);
        throw new Error("host went away");
      },
    };
    await expect(f.store.ingestStream(failing, input())).rejects.toThrow("host went away");
    const abort = new AbortController();
    const gate = deferred();
    const pending = f.store.ingestStream(
      gatedStream([data.subarray(0, 100), data.subarray(100)], gate.promise),
      {
        ...input(),
        signal: abort.signal,
      },
    );
    abort.abort();
    gate.resolve();
    await expect(pending).rejects.toThrow();
    expect(files(f.store.layout.tmp)).toEqual([]);
    expect(files(f.store.layout.blobs)).toEqual([]);
    expect(f.t.db.all("SELECT COUNT(*) AS n FROM artifact_items")[0]?.n).toBe(0);
    expect(f.t.events.query({ types: ["artifact.created"] })).toEqual([]);
  });

  it("removes the blob it placed when the transaction fails, and keeps one another row uses", async () => {
    const data = SAMPLES["image/webp"] as Uint8Array;
    // `derived_from` names no artifact: the foreign key fails the commit.
    await expect(
      f.store.ingest(data, { ...input(), derived_from: "01JZ0000000000000000000000" }),
    ).rejects.toThrow();
    expect(files(f.store.layout.blobs)).toEqual([]);
    expect(f.t.db.all("SELECT COUNT(*) AS n FROM artifact_blobs")[0]?.n).toBe(0);
    expect(f.t.events.query({ types: ["artifact.created"] })).toEqual([]);
    const kept = await f.store.ingest(data, input());
    await expect(
      f.store.ingest(data, { ...input(), derived_from: "01JZ0000000000000000000000" }),
    ).rejects.toThrow();
    expect(existsSync(f.store.layout.blobPath(kept.sha256))).toBe(true);
  });

  it("writes the derived copy's link to its original", async () => {
    const original = await f.store.ingest(SAMPLES["image/png"] as Uint8Array, input());
    const copy = await f.store.ingest(SAMPLES["image/jpeg"] as Uint8Array, {
      ...input(),
      derived_from: original.id,
    });
    expect(copy.derived_from).toBe(original.id);
  });

  it("never makes a song cover downloadable", async () => {
    const cover = await f.store.ingest(SAMPLES["audio/mpeg"] as Uint8Array, {
      source: "sing",
      plugin: "sing",
      place: f.room,
    });
    expect(cover.downloadable).toBe(false);
    expect(() =>
      f.t.db.run("UPDATE artifact_items SET downloadable = 1 WHERE id = $id", { id: cover.id }),
    ).toThrow(/CHECK/);
  });

  it("keeps from the start what goes into an album, and checks keep and expiry together", async () => {
    const card = await f.store.ingest(SAMPLES["image/png"] as Uint8Array, {
      source: "cards",
      plugin: "cards",
      place: f.room,
      keep: "album",
    });
    expect(card).toMatchObject({ kept_by: "album", expires_at: null });
    expect(() =>
      f.t.db.run("UPDATE artifact_items SET kept_by = NULL WHERE id = $id", { id: card.id }),
    ).toThrow(/CHECK/);
  });

  it("scopes by where it was made and refuses anything wider", async () => {
    const png = SAMPLES["image/png"] as Uint8Array;
    const base = { source: "imagegen" as const, plugin: "imagegen" };
    const dm = await f.store.ingest(png, { ...base, place: f.dm });
    expect(dm).toMatchObject({ scope: "dm", made_for: f.person, space_id: null });
    for (const scope of ["space", "room", "public"] as const) {
      await expect(f.store.ingest(png, { ...base, place: f.dm, scope })).rejects.toThrow(
        ArtifactInputError,
      );
    }
    const home = await f.store.ingest(png, base);
    expect(home).toMatchObject({ scope: "self", origin_session: null });
    await expect(f.store.ingest(png, { ...base, place: f.home, scope: "room" })).rejects.toThrow(
      ArtifactInputError,
    );
    const space = await f.store.ingest(png, { ...base, place: f.room, scope: "space" });
    expect(space.scope).toBe("space");
    await expect(
      f.store.ingest(png, { ...base, place: { ...f.room, space_id: null } }),
    ).rejects.toThrow(ArtifactInputError);
    await expect(f.store.ingest(png, { ...base, place: f.room, scope: "dm" })).rejects.toThrow(
      ArtifactInputError,
    );
  });
});

describe("reading", () => {
  async function make(
    scope: "public" | "space" | "room" | "dm" | "self" | "owner",
    place = f.room,
  ) {
    return f.store.ingest(SAMPLES["text/plain"] as Uint8Array, {
      source: "doc",
      plugin: "notebook",
      place,
      scope,
      made_for: f.person,
    });
  }

  const inRoom = (): ArtifactViewer => ({ person_id: f.other, ...f.room });
  const inOtherRoom = (): ArtifactViewer => ({ person_id: f.other, ...f.otherRoom });
  const inThread = (): ArtifactViewer => ({
    person_id: f.other,
    ...f.thread,
    parent_room_id: f.room.room_id,
  });
  const inDm = (): ArtifactViewer => ({ person_id: f.person, ...f.dm });
  const web = (person: string): ArtifactViewer => ({
    person_id: person,
    space_id: null,
    room_id: null,
  });

  it("opens the bytes by id for a viewer who may see them", async () => {
    const a = await make("room");
    const { artifact, stream } = await f.store.openFor(a.id, inRoom());
    expect(artifact.id).toBe(a.id);
    expect(await readAll(stream)).toEqual(Buffer.from(SAMPLES["text/plain"] as Uint8Array));
    await expect(f.store.openFor(a.id, inOtherRoom())).rejects.toThrow(ArtifactNotFoundError);
    await expect(
      f.store.openFor("../../etc/passwd", { owner: true, ...web(f.person) }),
    ).rejects.toThrow(ArtifactNotFoundError);
    expect(f.store.get("not-an-id")).toBeNull();
  });

  it("applies each scope's rule", async () => {
    const cases = {
      public: await make("public"),
      space: await make("space"),
      room: await make("room"),
      dm: await make("dm"),
      self: await make("self"),
      owner: await make("owner"),
    };
    const thread = await make("room", f.thread);
    const viewers: Record<string, ArtifactViewer> = {
      inRoom: inRoom(),
      inOtherRoom: inOtherRoom(),
      inThread: inThread(),
      inDm: inDm(),
      webPerson: web(f.person),
      webStranger: web(f.stranger),
      self: { person_id: null, space_id: null, room_id: null, self: true },
      owner: { person_id: null, space_id: null, room_id: null, owner: true },
      personInRoom: { person_id: f.person, ...f.room },
    };
    const expected: Record<string, string[]> = {
      public: Object.keys(viewers),
      space: ["inRoom", "inOtherRoom", "inThread", "owner", "personInRoom"],
      room: ["inRoom", "inThread", "owner", "personInRoom"],
      // Not in a group room, even for its person.
      dm: ["inDm", "webPerson", "owner"],
      self: ["self", "owner"],
      owner: ["owner"],
    };
    for (const [scope, artifact] of Object.entries(cases)) {
      const seen = Object.entries(viewers)
        .filter(([, v]) => f.store.find(artifact.id, v) !== null)
        .map(([name]) => name);
      expect(seen, scope).toEqual(expected[scope]);
    }
    // A thread's artifact is seen in the thread and its parent room, not in another room.
    const threadSeen = Object.entries(viewers)
      .filter(([, v]) => f.store.visibleTo(thread, v))
      .map(([name]) => name);
    expect(threadSeen).toEqual(["inRoom", "inThread", "owner", "personInRoom"]);
    // The listing applies the same rule.
    const listed = f.store.list({ viewer: inDm() }).map((a) => a.scope);
    expect(listed.sort()).toEqual(["dm", "public"]);
  });

  it("hides what expired, was taken down or deleted from everyone but the owner", async () => {
    const a = await make("public");
    const b = await make("public");
    expect(f.store.takeDown(b.id, "owner", "reported")).toBe(true);
    expect(f.store.find(b.id, web(f.stranger))).toBeNull();
    expect(f.store.find(b.id, { ...web(f.stranger), owner: true })).not.toBeNull();
    f.clock.advance(7 * DAY);
    expect(f.store.find(a.id, web(f.stranger))).toBeNull();
    expect(f.store.list({ viewer: web(f.stranger) })).toEqual([]);
  });

  it("says when the bytes are missing", async () => {
    const a = await make("public");
    const { rmSync } = await import("node:fs");
    rmSync(f.store.layout.blobPath(a.sha256));
    await expect(f.store.openFor(a.id, web(f.stranger))).rejects.toThrow(/missing/);
  });

  it("lists by person, space, source, kind, album and time, newest first, in pages", async () => {
    const png = SAMPLES["image/png"] as Uint8Array;
    const a = await f.store.ingest(png, { source: "imagegen", plugin: "imagegen", place: f.room });
    f.clock.advance(1000);
    const b = await f.store.ingest(SAMPLES["text/plain"] as Uint8Array, {
      source: "doc",
      plugin: "notebook",
      place: f.dm,
      keep: "album",
    });
    f.clock.advance(1000);
    const c = await f.store.ingest(png, { source: "cards", plugin: "cards", place: f.otherRoom });
    expect(f.store.list().map((x) => x.id)).toEqual([c.id, b.id, a.id]);
    expect(f.store.list({ made_for: f.person }).map((x) => x.id)).toEqual([b.id]);
    expect(f.store.list({ space_id: f.room.space_id as string }).map((x) => x.id)).toEqual([
      c.id,
      a.id,
    ]);
    expect(f.store.list({ room_id: f.room.room_id as string }).map((x) => x.id)).toEqual([a.id]);
    expect(f.store.list({ kind: "text" }).map((x) => x.id)).toEqual([b.id]);
    expect(f.store.list({ source: "cards" }).map((x) => x.id)).toEqual([c.id]);
    expect(f.store.list({ album: true }).map((x) => x.id)).toEqual([b.id]);
    expect(f.store.list({ kept: false }).map((x) => x.id)).toEqual([c.id, a.id]);
    expect(f.store.list({ since: new Date(T0 + 500).toISOString() }).map((x) => x.id)).toEqual([
      c.id,
      b.id,
    ]);
    expect(
      f.store.list({ expiresBy: new Date(T0 + 7 * DAY).toISOString() }).map((x) => x.id),
    ).toEqual([a.id]);
    expect(f.store.list({ limit: 1 }).map((x) => x.id)).toEqual([c.id]);
    expect(f.store.list({ limit: 1, before: c.id }).map((x) => x.id)).toEqual([b.id]);
  });

  it("keeps and releases", async () => {
    const a = await make("room");
    expect(f.store.keep(a.id, "album")).toBe(true);
    expect(f.store.get(a.id)).toMatchObject({ kept_by: "album", expires_at: null });
    f.clock.advance(DAY);
    expect(f.store.release(a.id)).toBe(true);
    expect(f.store.get(a.id)).toMatchObject({
      kept_by: null,
      expires_at: new Date(T0 + 8 * DAY).toISOString(),
    });
    expect(f.store.release(a.id)).toBe(false);
  });
});
