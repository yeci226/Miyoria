// `share`: a file she made goes to the person who asked, as an attachment, and only when every
// rule holds. On a real artifact store (a file database in a temporary folder) with a platform sink
// that resolves the attachment the way the Discord sink does (`ArtifactAttachments`).

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolRegistry } from "@miyoria/llm/tools";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type Artifact,
  ArtifactAttachments,
  type ArtifactCleaner,
  ArtifactCleanerKey,
  type ArtifactInput,
  ArtifactStoreKey,
  CLEAN_PLUGIN,
  type FileLinks,
  FileLinksKey,
  SqliteStore,
} from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  type MessageRef,
  ModerationKey,
  type ModerationService,
  MouthKey,
  type OutgoingMessage,
  type PlatformSink,
  PlatformSinks,
  PlatformSinksKey,
  type PublishedEvent,
  publishedInto,
  type SentMessage,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ActionResult,
  activeText,
  checkContent,
  type ExecContext,
  type ShareConfig,
  ShareConfigSchema,
  shareCapability,
} from "../src/index.js";
import { ActuatorRegistry } from "../src/registry.js";

const T0 = Date.parse("2026-11-16T00:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const OWEN: AccountRef = { platform: "discord", id: "100" };
const MIA: AccountRef = { platform: "discord", id: "200" };
const ROOM: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OTHER_ROOM: ContextKey = { platform: "discord", scope: "g1", channel: "c2", kind: "channel" };
const OWEN_DM: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };

const PNG = Uint8Array.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  ...Array(120).fill(7),
]);
const text = (s: string) => new TextEncoder().encode(s);

interface Sent {
  context: ContextKey;
  message: OutgoingMessage;
  files: { artifact_id: string; filename: string; content_type: string; size: number }[];
}

class FakeSink implements PlatformSink {
  readonly platform = "discord";
  limit: number | null = 10_000;
  readonly sent: Sent[] = [];
  /** Runs between the gate's checks and the upload (a take-down, a change of place). */
  before: (() => void) | null = null;
  failWith: Error | null = null;
  #n = 0;

  constructor(private readonly attachments: ArtifactAttachments) {}

  attachmentLimit(): number | null {
    return this.limit;
  }

  async send(context: ContextKey, message: OutgoingMessage): Promise<SentMessage> {
    this.before?.();
    if (this.failWith) throw this.failWith;
    const files: Sent["files"] = [];
    for (const { artifact_id } of message.attachments ?? []) {
      const file = await this.attachments.open(artifact_id, context, {
        maxBytes: this.limit ?? 0,
      });
      files.push({
        artifact_id: file.artifact_id,
        filename: file.filename,
        content_type: file.content_type,
        size: file.size,
      });
    }
    this.sent.push({ context, message, files });
    return { context, id: `m${++this.#n}` } as SentMessage;
  }

  async react(): Promise<void> {}
  async typing(): Promise<void> {}
}

let dir: string;
let store: SqliteStore;
let clockMs: number;
let services: ServiceRegistry;
let sink: FakeSink;
let events: PublishedEvent[];
let config: ShareConfig;
let mouthOwns: boolean;
let moderation: ModerationService | undefined;
let cap: ReturnType<typeof shareCapability> | undefined;
let ownerPerson: string;
let miaPerson: string;

function artifacts() {
  const a = store.artifacts;
  if (!a) throw new Error("no artifact store");
  return a;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-share-"));
  clockMs = T0;
  store = await SqliteStore.open(join(dir, "a.db"), { clock: { now: () => clockMs } });
  const identity = store.persons;
  identity.resolve(ROOM, { account: OWEN, display_name: "Owen" });
  identity.resolve(ROOM, { account: MIA, display_name: "Mia" });
  identity.resolve(OTHER_ROOM, { account: OWEN, display_name: "Owen" });
  identity.resolve(OWEN_DM, { account: OWEN, display_name: "Owen" });
  ownerPerson = artifacts().places.at(ROOM, OWEN)?.person_id as string;
  miaPerson = artifacts().places.at(ROOM, MIA)?.person_id as string;
  services = new ServiceRegistry();
  sink = new FakeSink(new ArtifactAttachments(artifacts()));
  const sinks = new PlatformSinks();
  sinks.register(sink);
  services.provide("test", ArtifactStoreKey, artifacts());
  services.provide("test", PlatformSinksKey, sinks);
  mouthOwns = true;
  services.provide("test", MouthKey, { owns: () => mouthOwns, say: async () => {} });
  moderation = undefined;
  cap = undefined;
  // The moderation module, when there is one, decides first; without a block the known credential
  // formats are still caught by the capability itself.
  services.provide("test", ModerationKey, {
    screen: (check: unknown) => moderation?.screen(check as never) ?? { blocked: [] },
  } as unknown as ModerationService);
  events = [];
  config = ShareConfigSchema.parse({});
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

/** One capability per test, as the registry keeps one: its daily counts live in it. */
function capability() {
  cap ??= shareCapability({
    services,
    config: () => config,
    publish: publishedInto(events),
    clock: { now: () => clockMs },
    names: null,
  });
  return cap;
}

/** An artifact made in `at` for whoever `as` is. */
async function make(
  data: Uint8Array,
  at: ContextKey,
  as: AccountRef | null,
  input: Partial<ArtifactInput> = {},
): Promise<Artifact> {
  const site = artifacts().places.at(at, as, { create: true });
  if (site === null) throw new Error("unknown place");
  return artifacts().ingest(data, {
    source: "sandbox",
    plugin: "sandbox",
    filename: "report.txt",
    place: site.place,
    made_for: site.person_id,
    turn: "T0",
    ...input,
  });
}

async function exec(
  who: AccountRef | null,
  where: ContextKey | null,
  args: { artifact: string; to?: string | null },
  message: MessageRef | null = null,
): Promise<ActionResult> {
  const cap = capability();
  const principal = { kind: "user", requester: who, context: where, override: false, actor: null };
  const ctx = {
    principal,
    request: { principal, capability: "share", args, why: null, turn: "T1", message },
    decision: {},
    services,
    signal: new AbortController().signal,
  } as unknown as ExecContext;
  return (await cap.execute(cap.args.parse(args), ctx)) as ActionResult;
}

function refusal(result: { data: unknown }): string | undefined {
  return (result.data as { refused?: string }).refused;
}

describe("share: the hand-over", () => {
  it("sends a text artifact to the person who asked, in the place of the turn, and records it", async () => {
    const a = await make(text("她寫的一段話。\n"), ROOM, OWEN);
    const reply: MessageRef = { context: ROOM, id: "q1" };
    const result = await exec(OWEN, ROOM, { artifact: a.id }, reply);
    expect(result.data).toMatchObject({
      ok: true,
      artifact_id: a.id,
      filename: "report.txt",
      mime: "text/plain",
      metadata_stripped: false,
    });
    expect(sink.sent).toHaveLength(1);
    const [sent] = sink.sent;
    expect(sent?.context).toEqual(ROOM);
    expect(sent?.message.attachments).toEqual([{ artifact_id: a.id }]);
    expect(sent?.message.reply_to).toEqual(reply);
    expect(sent?.files[0]).toMatchObject({ filename: "report.txt", content_type: "text/plain" });
    const shared = events.filter((e) => e.type === "artifact.shared");
    expect(shared).toHaveLength(1);
    expect(shared[0]?.data).toMatchObject({
      artifact_id: a.id,
      sha256: a.sha256,
      requested_by: OWEN,
      person_id: ownerPerson,
      turn: "T1",
      context: ROOM,
      message_id: "m1",
      source: "sandbox",
      metadata_stripped: false,
    });
  });

  it("sends an image as stored (its metadata is not stripped, and the result says so)", async () => {
    const a = await make(PNG, ROOM, OWEN, { filename: "cat.png" });
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(result.data).toMatchObject({ ok: true, mime: "image/png", metadata_stripped: false });
    expect(sink.sent[0]?.files[0]?.content_type).toBe("image/png");
  });

  it("a DM-made artifact goes back into that DM", async () => {
    const a = await make(text("secret plans\n"), OWEN_DM, OWEN);
    const result = await exec(OWEN, OWEN_DM, { artifact: a.id });
    expect(result.data).toMatchObject({ ok: true });
    expect(sink.sent[0]?.context).toEqual(OWEN_DM);
  });
});

describe("share: who and where", () => {
  it("refuses a DM-made artifact in a channel, and sends nothing", async () => {
    const a = await make(text("private\n"), OWEN_DM, OWEN);
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(refusal(result)).toBe("wider_than_origin");
    expect(sink.sent).toEqual([]);
    expect(events).toEqual([]);
  });

  it("refuses a channel artifact in another channel", async () => {
    const a = await make(text("here only\n"), ROOM, OWEN);
    const result = await exec(OWEN, OTHER_ROOM, { artifact: a.id });
    expect(refusal(result)).toBe("wider_than_origin");
    expect(sink.sent).toEqual([]);
  });

  it("refuses an artifact made for someone else, even in the same channel", async () => {
    const a = await make(text("for mia\n"), ROOM, MIA);
    expect(a.made_for).toBe(miaPerson);
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(refusal(result)).toBe("not_for_them");
    expect(sink.sent).toEqual([]);
  });

  it("refuses to hand it to anyone but the person who asked", async () => {
    const a = await make(text("mine\n"), ROOM, OWEN);
    for (const to of ["<@200>", "200", "speaker2", "@Mia"]) {
      const result = await exec(OWEN, ROOM, { artifact: a.id, to });
      expect(refusal(result), to).toBe("other_person");
    }
    expect(sink.sent).toEqual([]);
    const ok = await exec(OWEN, ROOM, { artifact: a.id, to: "speaker" });
    expect(ok.data).toMatchObject({ ok: true });
  });

  it("refuses without a requester or a place", async () => {
    const a = await make(text("x\n"), ROOM, OWEN);
    expect(refusal(await exec(null, ROOM, { artifact: a.id }))).toBe("no_requester");
    expect(refusal(await exec(OWEN, null, { artifact: a.id }))).toBe("no_requester");
  });

  it("refuses when it is not a turn of the main line", async () => {
    const a = await make(text("x\n"), ROOM, OWEN);
    mouthOwns = false;
    expect(refusal(await exec(OWEN, ROOM, { artifact: a.id }))).toBe("unavailable");
    expect(sink.sent).toEqual([]);
  });
});

describe("share: ids only", () => {
  it("takes an artifact id and nothing else: no path, no traversal", async () => {
    await make(text("x\n"), ROOM, OWEN);
    const writes: string[] = [];
    writeFileSync(join(dir, "secret.txt"), "do not send");
    for (const artifact of [
      "../a.db",
      "..\\..\\secret.txt",
      "..\\..\\miyoria.toml",
      "C:\\Windows\\win.ini",
      "/etc/passwd",
      "file:///etc/passwd",
      "report.txt",
      "01JABCDEFGHJKMNPQRSTVWXYZ0",
    ]) {
      const result = await exec(OWEN, ROOM, { artifact });
      expect(refusal(result), artifact).toBe("not_found");
      writes.push(artifact);
    }
    expect(sink.sent).toEqual([]);
    expect(writes).toHaveLength(8);
  });

  it("the attachment of a message is an id: a path in its place is refused by the source", async () => {
    await expect(
      new ArtifactAttachments(artifacts()).open("../a.db", ROOM, { maxBytes: 1000 }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("share: what may leave", () => {
  it("refuses a .png that is really HTML", async () => {
    const a = await make(
      text("<!doctype html><html><body><script>alert(1)</script></body></html>"),
      ROOM,
      OWEN,
      {
        filename: "cat.png",
        mime: "image/png",
      },
    ).catch(() => null);
    // The store does not take it as a PNG either; stored as the text it is, share still refuses.
    const b = await make(text("<!doctype html><html><body>hi</body></html>"), ROOM, OWEN, {
      filename: "cat.png",
    });
    expect(a).toBeNull();
    expect(b.mime).toBe("text/plain");
    const result = await exec(OWEN, ROOM, { artifact: b.id });
    expect(refusal(result)).toBe("type_not_allowed");
    expect(sink.sent).toEqual([]);
  });

  it("refuses SVG, PHP and script text, and executables", async () => {
    for (const body of [
      '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      "<svg onload=alert(1)></svg>",
      "<?php echo 1;",
      "#!/bin/sh\nrm -rf /\n",
      "intro\n<script src=x></script>\n",
    ]) {
      const a = await make(text(body), ROOM, OWEN);
      expect(refusal(await exec(OWEN, ROOM, { artifact: a.id })), body).toBe("type_not_allowed");
    }
    expect(sink.sent).toEqual([]);
  });

  it("checks content, not names: types, zip and executables", () => {
    expect(checkContent(PNG, false)).toEqual({ ok: true, mime: "image/png" });
    expect(checkContent(text("plain words\n"), false)).toEqual({ ok: true, mime: "text/plain" });
    // Plain text that happens to begin with `MZ` is text.
    expect(checkContent(text("MZ-100 notes\n"), false)).toEqual({ ok: true, mime: "text/plain" });
    const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);
    expect(checkContent(exe, true)).toEqual({
      ok: false,
      code: "type_not_allowed",
      what: "executable",
    });
    const elf = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]);
    expect(checkContent(elf, true)).toMatchObject({ ok: false, what: "executable" });
    expect(checkContent(Uint8Array.from([0, 1, 2, 3, 4]), true)).toMatchObject({
      ok: false,
      what: "binary",
    });
    const zip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(checkContent(zip, true)).toEqual({ ok: true, mime: "application/zip" });
    expect(checkContent(zip, false)).toMatchObject({ ok: false, code: "type_not_allowed" });
    expect(activeText("<HTML><body>")).toBe("HTML");
    expect(activeText("\uFEFF<svg></svg>")).toBe("SVG");
    expect(activeText("just <b>text</b>")).toBeNull();
  });

  it("refuses an artifact whose bytes are not the ones recorded", async () => {
    const a = await make(text("original\n"), ROOM, OWEN);
    writeFileSync(artifacts().layout.blobPath(a.sha256), "<html>swapped</html>");
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(refusal(result)).toBe("type_not_allowed");
    expect(sink.sent).toEqual([]);
  });

  it("refuses a text with a secret in it, and says why", async () => {
    const a = await make(text("notes\napi_key = abcdefgh12345678\n"), ROOM, OWEN);
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(refusal(result)).toBe("secret");
    expect(result.text).toContain("密");
    expect(sink.sent).toEqual([]);
  });

  it("applies the moderation module's rules to a text too", async () => {
    moderation = {
      screen: () => ({ blocked: [{ category: "secrets", rule: "secrets.admin-token" }] }),
    } as unknown as ModerationService;
    const a = await make(text("harmless words\n"), ROOM, OWEN);
    expect(refusal(await exec(OWEN, ROOM, { artifact: a.id }))).toBe("secret");
    moderation = {
      screen: () => ({ blocked: [{ category: "hate", rule: "hate.x" }] }),
    } as unknown as ModerationService;
    expect(refusal(await exec(OWEN, ROOM, { artifact: a.id }))).toBe("moderation");
    expect(sink.sent).toEqual([]);
  });

  it("never shares a song cover", async () => {
    const wav = Uint8Array.from([
      ...text("RIFF"),
      0x24,
      0,
      0,
      0,
      ...text("WAVEfmt "),
      ...Array(100).fill(1),
    ]);
    const a = await make(wav, ROOM, OWEN, {
      source: "sing",
      plugin: "sing",
      filename: "cover.wav",
    });
    expect(a.downloadable).toBe(false);
    expect(refusal(await exec(OWEN, ROOM, { artifact: a.id }))).toBe("song_cover");
    expect(sink.sent).toEqual([]);
  });

  it("refuses what was taken down or has expired", async () => {
    const a = await make(text("one\n"), ROOM, OWEN);
    expect(artifacts().takeDown(a.id, "owner", "test")).toBe(true);
    expect(refusal(await exec(OWEN, ROOM, { artifact: a.id }))).toBe("withdrawn");
    const b = await make(text("two\n"), ROOM, OWEN);
    clockMs += 8 * DAY;
    expect(refusal(await exec(OWEN, ROOM, { artifact: b.id }))).toBe("withdrawn");
    expect(sink.sent).toEqual([]);
  });

  it("refuses a file over the cap, the smaller of the config's and the platform's", async () => {
    const a = await make(text("x".repeat(500)), ROOM, OWEN);
    config = ShareConfigSchema.parse({ max_bytes: 100 });
    const byConfig = await exec(OWEN, ROOM, { artifact: a.id });
    expect(refusal(byConfig)).toBe("too_large");
    expect(byConfig.data).toMatchObject({ max_bytes: 100 });
    config = ShareConfigSchema.parse({});
    sink.limit = 200;
    const byPlatform = await exec(OWEN, ROOM, { artifact: a.id });
    expect(refusal(byPlatform)).toBe("too_large");
    expect(byPlatform.data).toMatchObject({ max_bytes: 200 });
    expect(sink.sent).toEqual([]);
  });

  it("fails clearly where the destination takes no attachments", async () => {
    const a = await make(text("x\n"), ROOM, OWEN);
    sink.limit = null;
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(refusal(result)).toBe("platform");
    expect(result.text).toContain("附件");
  });
});

describe("share: checked again at send time", () => {
  it("an artifact withdrawn between the gate's checks and the upload is refused by the source", async () => {
    const a = await make(text("x\n"), ROOM, OWEN);
    sink.before = () => {
      artifacts().takeDown(a.id, "owner", "test");
    };
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(refusal(result)).toBe("not_found");
    expect(result.data).toMatchObject({ at: "send" });
    expect(sink.sent).toEqual([]);
    expect(events).toEqual([]);
  });

  it("the source refuses an artifact the destination may not see, whatever asked", async () => {
    const a = await make(text("dm\n"), OWEN_DM, OWEN);
    const source = new ArtifactAttachments(artifacts());
    await expect(source.open(a.id, ROOM, { maxBytes: 1000 })).rejects.toMatchObject({
      code: "not_visible",
    });
    await expect(source.open(a.id, OWEN_DM, { maxBytes: 1000 })).resolves.toMatchObject({
      artifact_id: a.id,
    });
  });

  it("a platform error that is not an attachment's is not hidden", async () => {
    const a = await make(text("x\n"), ROOM, OWEN);
    sink.failWith = new Error("network down");
    await expect(exec(OWEN, ROOM, { artifact: a.id })).rejects.toThrow("network down");
    expect(events).toEqual([]);
  });
});

describe("share: the daily limit", () => {
  it("allows a number of files per person per rolling day, then again", async () => {
    config = ShareConfigSchema.parse({ per_person_per_day: 2, per_day: 100 });
    const a = await make(text("one\n"), ROOM, OWEN);
    expect(await exec(OWEN, ROOM, { artifact: a.id })).toMatchObject({ data: { ok: true } });
    clockMs += HOUR;
    expect(await exec(OWEN, ROOM, { artifact: a.id })).toMatchObject({ data: { ok: true } });
    clockMs += HOUR;
    const third = await exec(OWEN, ROOM, { artifact: a.id });
    expect(refusal(third)).toBe("limit");
    expect(sink.sent).toHaveLength(2);
    clockMs += 23 * HOUR;
    expect(await exec(OWEN, ROOM, { artifact: a.id })).toMatchObject({ data: { ok: true } });
  });

  it("has a limit for everyone together, and a refused share does not count", async () => {
    config = ShareConfigSchema.parse({ per_person_per_day: 10, per_day: 1 });
    const a = await make(text("one\n"), ROOM, OWEN);
    const b = await make(text("two\n"), ROOM, MIA);
    expect(refusal(await exec(OWEN, ROOM, { artifact: "01JABCDEFGHJKMNPQRSTVWXYZ0" }))).toBe(
      "not_found",
    );
    expect(await exec(OWEN, ROOM, { artifact: a.id })).toMatchObject({ data: { ok: true } });
    expect(refusal(await exec(MIA, ROOM, { artifact: b.id }))).toBe("limit");
  });
});

describe("share: the registered capability", () => {
  it("is a low-risk `say` tool of the `files` group in the app's registry", () => {
    const tools = new ToolRegistry();
    const registry = new ActuatorRegistry({ services, tools, publish: publishedInto(events) });
    const cap = registry.get("share");
    expect(cap?.risk).toBe("low");
    expect(cap?.tool?.meta).toMatchObject({ effect: "say", group: "files" });
    expect(tools.names()).toContain("share");
    expect(registry.config.share.max_bytes).toBe(10_485_760);
  });
});

describe("share: with a file origin and the image cleaner", () => {
  /** A link service over the real store's shares, as the `api` module's would issue them. */
  function links(scoped = true) {
    const asked: { audience: string; ttlMs?: number | null; person_id?: string | null }[] = [];
    const service: FileLinks = {
      available: (audience) => audience === "link" || scoped,
      issue: async (request) => {
        asked.push(request);
        const { share, token } = artifacts().shares.create(request.artifact_id, {
          audience: request.audience,
          person_id: request.person_id ?? null,
          space_id: request.space_id ?? null,
          ...(request.ttlMs == null ? {} : { ttlMs: request.ttlMs }),
        });
        return {
          ok: true,
          url: `https://files.test/f/${token}`,
          share_id: share.id,
          artifact_id: request.artifact_id,
          audience: share.audience,
          expires_at: share.expires_at,
          metadata_stripped: false,
        };
      },
    };
    services.provide("api", FileLinksKey, service);
    return asked;
  }

  it("attaches the file with a link for the person who asked, for as long as she says", async () => {
    const asked = links();
    const a = await make(text("她寫的一段話。\n"), ROOM, OWEN);
    const result = await exec(OWEN, ROOM, { artifact: a.id, hours: 48 } as never);
    const url = (result.data as { url?: string }).url ?? "";
    expect(url).toMatch(/^https:\/\/files\.test\/f\/[A-Za-z0-9_-]{43}$/);
    expect(result.text).toContain(url);
    expect(asked[0]).toMatchObject({
      audience: "person",
      person_id: ownerPerson,
      ttlMs: 48 * HOUR,
    });
    expect(sink.sent[0]?.message.text).toBe(url);
    expect(sink.sent[0]?.message.attachments).toEqual([{ artifact_id: a.id }]);
  });

  it("links for the server's members with `here`, and never from a DM", async () => {
    const asked = links();
    const a = await make(text("頻道裡做的。\n"), ROOM, OWEN);
    const result = await exec(OWEN, ROOM, { artifact: a.id, to: "here" });
    expect(result.data).toMatchObject({ ok: true });
    expect(asked[0]).toMatchObject({ audience: "space", person_id: null });
    const d = await make(text("私訊裡做的。\n"), OWEN_DM, OWEN);
    const fromDm = await exec(OWEN, OWEN_DM, { artifact: d.id, to: "here" });
    expect(refusal(fromDm)).toBe("wider_than_origin");
  });

  it("sends the link alone where no attachment fits", async () => {
    links();
    const a = await make(text("x\n"), ROOM, OWEN);
    sink.limit = null;
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(result.data).toMatchObject({ ok: true });
    expect(sink.sent[0]?.message.attachments).toEqual([]);
    expect(sink.sent[0]?.message.text).toMatch(/^https:\/\/files\.test\/f\//);
  });

  it("revokes the link when the hand-over is refused", async () => {
    links();
    const a = await make(
      text("token = sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"),
      ROOM,
      OWEN,
    );
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(refusal(result)).toBe("secret");
    expect(artifacts().shares.live(a.id)).toEqual([]);
  });

  it("makes no scoped link without the login, and still attaches", async () => {
    const asked = links(false);
    const a = await make(text("x\n"), ROOM, OWEN);
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(result.data).toMatchObject({ ok: true });
    expect((result.data as { url?: string }).url).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("sends an image's cleaned copy when the cleaner is there, and says it was stripped", async () => {
    const a = await make(PNG, ROOM, OWEN, { filename: "cat.png" });
    let copy: Artifact | null = null;
    const cleaner: ArtifactCleaner = {
      handOut: async (artifact) => {
        copy ??= await artifacts().ingest(PNG, {
          source: artifact.source,
          plugin: CLEAN_PLUGIN,
          filename: artifact.filename,
          place: {
            session: artifact.origin_session,
            space_id: artifact.space_id,
            room_id: artifact.room_id,
          },
          scope: artifact.scope,
          made_for: artifact.made_for as never,
          derived_from: artifact.id,
        });
        return { artifact: copy, stripped: true };
      },
    };
    services.provide("api", ArtifactCleanerKey, cleaner);
    const result = await exec(OWEN, ROOM, { artifact: a.id });
    expect(result.data).toMatchObject({ ok: true, artifact_id: a.id, metadata_stripped: true });
    expect(sink.sent[0]?.message.attachments).toEqual([
      { artifact_id: (copy as Artifact | null)?.id },
    ]);
    expect(events.find((e) => e.type === "artifact.shared")?.data).toMatchObject({
      metadata_stripped: true,
    });
  });
});
