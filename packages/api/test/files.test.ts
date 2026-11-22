// What she made, handed out (v5-architecture §11.2, owner 2026-11-22): tickets, links and every
// scope rule, the quota, the type allow-list, images re-encoded without their metadata, song covers
// refused, the file origin's headers, the member page's routes and the pass a scoped link goes
// through. All in memory: the file origin is a Hono app called directly, nothing listens.

import { ArtifactStoreKey, CLEAN_PLUGIN, PeopleStoreKey } from "@miyoria/store";
import type { AccountRef, PersonId } from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { Hono } from "hono";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { ImageCleaner, reencode } from "../src/files/clean.js";
import { FilesConfigSchema, parseOrigin } from "../src/files/config.js";
import { FileLinkService } from "../src/files/links.js";
import { filesAdminRpc, filesPassRoute, memberFilesRpc } from "../src/files/routes.js";
import { disposition, FILE_CSP, fileOriginApp } from "../src/files/serve.js";
import type { FilesSide } from "../src/files/side.js";
import { Tickets } from "../src/files/tickets.js";
import { tableRoutes } from "../src/rpc.js";
import type { ApiEnv } from "../src/state.js";
import {
  ACCOUNTS,
  contains,
  DAY,
  type FilesFixture,
  filesFixture,
  HIDDEN,
  jpegWithExif,
  pngWithTrailer,
} from "./support/files.js";

const ORIGIN = "https://files.miyoria.test";
const SITE = "https://miyoria.test";

let f: FilesFixture;
beforeEach(() => {
  f = filesFixture();
});
afterEach(() => {
  f.close();
});

function rig(options: { scoped?: boolean; perDay?: number } = {}) {
  const cleaner = new ImageCleaner(() => f.store);
  const tickets = new Tickets(() => f.clock.now());
  const links = new FileLinkService({
    store: () => f.store,
    cleaner,
    origin: ORIGIN,
    scoped: () => options.scoped ?? true,
    perPersonPerDay: options.perDay ?? 20,
    moderation: () => undefined,
    now: () => f.clock.now(),
  });
  const app = fileOriginApp({
    store: () => f.store,
    cleaner,
    tickets,
    site: () => SITE,
    isMember: (p, s) => f.store.shares.isMember(p, s),
    moderation: () => undefined,
    now: () => f.clock.now(),
    perIpPerMinute: 1000,
    perLinkPerMinute: 1000,
    publicCacheSecs: 300,
    clientIpHeader: "cf-connecting-ip",
  });
  const files: FilesSide = {
    config: FilesConfigSchema.parse({
      origin: ORIGIN,
      links_per_person_per_day: options.perDay ?? 20,
    }),
    origin: ORIGIN,
    site: SITE,
    tickets,
    links,
    cleaner,
  };
  return { cleaner, tickets, links, app, files };
}

const tokenOf = (url: string) => url.slice(`${ORIGIN}/f/`.length);
/** A request to the file origin, its body read at once (the blob root goes after each test). */
async function get(app: Hono<ApiEnv>, path: string, init?: RequestInit): Promise<Response> {
  const res = await app.request(`${ORIGIN}${path}`, init);
  const body = res.body === null ? null : await res.arrayBuffer();
  return new Response(body, { status: res.status, headers: res.headers });
}

async function picture(place = f.room, made_for: PersonId | null = f.person) {
  return f.store.ingest(await jpegWithExif(), {
    source: "imagegen",
    plugin: "imagegen",
    place,
    made_for,
  });
}

describe("tickets", () => {
  it("open one thing for one person, for two minutes, and nothing else", () => {
    const tickets = new Tickets(() => f.clock.now());
    const t = tickets.issue("s", "share-1", "p1" as PersonId);
    expect(tickets.verify(t, "s", "share-1")).toBe("p1");
    expect(tickets.verify(t, "s", "share-2")).toBeNull();
    expect(tickets.verify(t, "d", "share-1")).toBeNull();
    // Tampered payload or mac, or another key: refused.
    const [body, mac] = t.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(body, "base64url").toString()), p: "p2" }),
    ).toString("base64url");
    expect(tickets.verify(`${forged}.${mac}`, "s", "share-1")).toBeNull();
    expect(tickets.verify(`${body}.${mac.slice(1)}A`, "s", "share-1")).toBeNull();
    expect(new Tickets(() => f.clock.now()).verify(t, "s", "share-1")).toBeNull();
    expect(tickets.verify(undefined, "s", "share-1")).toBeNull();
    expect(tickets.verify("a.b.c", "s", "share-1")).toBeNull();
    f.clock.advance(119_000);
    expect(tickets.verify(t, "s", "share-1")).toBe("p1");
    f.clock.advance(1_000);
    expect(tickets.verify(t, "s", "share-1")).toBeNull();
  });
});

describe("share links", () => {
  it("are unguessable, stored only as a hash, and expire", async () => {
    const { links, app } = rig();
    const art = await f.store.ingest(new TextEncoder().encode("她寫的一段話。\n"), {
      source: "doc",
      plugin: "notebook",
      place: f.room,
      made_for: f.person,
      scope: "public",
    });
    const made = await links.issue({ artifact_id: art.id, audience: "link", ttlMs: DAY });
    if (!made.ok) throw new Error(made.message);
    const token = tokenOf(made.url);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = f.store.shares.get(made.share_id);
    expect(row?.token_hash).not.toContain(token);
    expect(JSON.stringify(f.t.db.all("SELECT * FROM artifact_shares"))).not.toContain(token);
    expect((await get(app, `/f/${token}`)).status).toBe(200);
    // One character off (never the same token: the first is swapped for a different one).
    const off = `${token[0] === "A" ? "B" : "A"}${token.slice(1)}`;
    expect((await get(app, `/f/${off}`)).status).toBe(404);
    f.clock.advance(DAY);
    expect((await get(app, `/f/${token}`)).status).toBe(404);
  });

  it("keep every scope inside where the thing was made", async () => {
    const { links } = rig();
    const dm = await picture(f.dm, null);
    const room = await picture();
    const issue = (artifact_id: string, rest: object) =>
      links.issue({ artifact_id, audience: "person", ...rest });
    // DM-made: the person; never the server, never another person, a link only widened.
    expect((await issue(dm.id, { person_id: f.person })).ok).toBe(true);
    expect(await issue(dm.id, { audience: "space", space_id: f.room.space_id })).toMatchObject({
      ok: false,
      refused: "audience",
    });
    expect(
      await issue(dm.id, { audience: "space", space_id: f.room.space_id, widen: true }),
    ).toMatchObject({ ok: false, refused: "audience" });
    expect(await issue(dm.id, { person_id: f.other, widen: true })).toMatchObject({
      ok: false,
      refused: "audience",
    });
    expect(await issue(dm.id, { audience: "link" })).toMatchObject({ ok: false });
    expect((await issue(dm.id, { audience: "link", widen: true })).ok).toBe(true);
    // Room-made: its members and its own server only.
    expect((await issue(room.id, { person_id: f.other })).ok).toBe(true);
    expect(await issue(room.id, { person_id: f.stranger })).toMatchObject({ ok: false });
    expect((await issue(room.id, { audience: "space", space_id: f.room.space_id })).ok).toBe(true);
    expect(await issue(room.id, { audience: "space", space_id: "elsewhere" })).toMatchObject({
      ok: false,
    });
  });

  it("need the Discord login for one person or a server", async () => {
    const { links } = rig({ scoped: false });
    const room = await picture();
    expect(
      await links.issue({ artifact_id: room.id, audience: "person", person_id: f.person }),
    ).toMatchObject({ ok: false, refused: "no_login" });
    expect(links.available("link")).toBe(true);
    expect(links.available("space")).toBe(false);
  });

  it("have a daily quota per person", async () => {
    const { links } = rig({ perDay: 2 });
    const room = await picture();
    const one = () =>
      links.issue({ artifact_id: room.id, audience: "person", person_id: f.person });
    expect((await one()).ok).toBe(true);
    expect((await one()).ok).toBe(true);
    expect(await one()).toMatchObject({ ok: false, refused: "quota" });
    f.clock.advance(DAY + 1);
    expect((await one()).ok).toBe(true);
  });

  it("refuse what is not on the type allow-list, and secrets in text", async () => {
    const { links } = rig();
    const html = await f.store.ingest(
      new TextEncoder().encode("<!doctype html><script>alert(1)</script>"),
      { source: "sandbox", plugin: "sandbox", place: f.room, made_for: f.person },
    );
    expect(html.mime).toBe("text/plain");
    expect(
      await links.issue({ artifact_id: html.id, audience: "person", person_id: f.person }),
    ).toMatchObject({ ok: false, refused: "type_not_allowed" });
    const secret = await f.store.ingest(
      new TextEncoder().encode("token = sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n"),
      { source: "sandbox", plugin: "sandbox", place: f.room, made_for: f.person },
    );
    expect(
      await links.issue({ artifact_id: secret.id, audience: "person", person_id: f.person }),
    ).toMatchObject({ ok: false, refused: "secret" });
    expect(await links.issue({ artifact_id: "../../.env", audience: "link" })).toMatchObject({
      ok: false,
      refused: "not_found",
    });
  });

  it("never open a song cover", async () => {
    const { links, app } = rig();
    const cover = await f.store.ingest(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), {
      source: "sing",
      plugin: "sing",
      place: f.room,
      made_for: f.person,
    });
    expect(
      await links.issue({ artifact_id: cover.id, audience: "person", person_id: f.person }),
    ).toMatchObject({ ok: false, refused: "song_cover" });
    // Even a share made around the link service is not served.
    const { token } = f.store.shares.create(cover.id, {
      audience: "space",
      space_id: f.room.space_id,
    });
    const res = await get(app, `/f/${token}`);
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("翻唱");
  });
});

describe("images", () => {
  it("are re-encoded without their metadata", async () => {
    const jpeg = await jpegWithExif();
    expect(contains(jpeg, HIDDEN)).toBe(true);
    const clean = await reencode(jpeg, "image/jpeg");
    expect(contains(clean, HIDDEN)).toBe(false);
    expect((await sharp(clean).metadata()).exif).toBeUndefined();
    const png = await pngWithTrailer();
    const cleanPng = await reencode(png, "image/png");
    expect(contains(cleanPng, HIDDEN)).toBe(false);
    expect((await sharp(cleanPng).metadata()).width).toBe(5);
  });

  it("go out as one cleaned copy, with the original's place, retention and take-down", async () => {
    const { links, app } = rig();
    const original = await picture();
    const made = await links.issue({
      artifact_id: original.id,
      audience: "space",
      space_id: f.room.space_id,
    });
    if (!made.ok) throw new Error(made.message);
    expect(made.metadata_stripped).toBe(true);
    const copy = f.store.get(made.artifact_id);
    expect(copy).toMatchObject({
      plugin: CLEAN_PLUGIN,
      derived_from: original.id,
      scope: original.scope,
      made_for: original.made_for,
      expires_at: original.expires_at,
    });
    const again = await links.issue({
      artifact_id: original.id,
      audience: "space",
      space_id: f.room.space_id,
    });
    expect(again.ok && again.artifact_id).toBe(made.artifact_id);
    f.store.takeDown(original.id, "owner", "test");
    expect(f.store.get(made.artifact_id)?.review).toBe("taken_down");
    expect((await get(app, `/f/${tokenOf(made.url)}`)).status).toBe(404);
  });
});

describe("the file origin", () => {
  it("answers with a type, a name, nosniff, a CSP that runs nothing, and no cookie", async () => {
    const { links, app } = rig();
    const original = await picture(f.dm, null);
    const made = await links.issue({ artifact_id: original.id, audience: "link", widen: true });
    if (!made.ok) throw new Error(made.message);
    const res = await get(app, `/f/${tokenOf(made.url)}`, {
      headers: { cookie: "miyoria_session=abc" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe(FILE_CSP);
    expect(FILE_CSP).toContain("default-src 'none'");
    expect(FILE_CSP).toContain("sandbox");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("content-disposition")).toMatch(/^inline; filename="/);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(contains(body, HIDDEN)).toBe(false);
    const dl = await get(app, `/f/${tokenOf(made.url)}?dl=1`);
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; /);
    const head = await get(app, `/f/${tokenOf(made.url)}`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect((await get(app, `/f/${tokenOf(made.url)}`, { method: "POST" })).status).toBe(405);
    const missing = await get(app, "/f/nope");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get(app, "/api/member/me")).status).toBe(404);
    expect(await (await get(app, "/robots.txt")).text()).toContain("Disallow: /");
  });

  it("sends a link for one person through the login, and opens it only for them", async () => {
    const { links, app, tickets } = rig();
    const room = await picture();
    const made = await links.issue({
      artifact_id: room.id,
      audience: "person",
      person_id: f.person,
    });
    if (!made.ok) throw new Error(made.message);
    const token = tokenOf(made.url);
    const away = await get(app, `/f/${token}`);
    expect(away.status).toBe(302);
    expect(away.headers.get("location")).toBe(`${SITE}/api/member/files/pass/${token}`);
    const mine = tickets.issue("s", made.share_id, f.person);
    const ok = await get(app, `/f/${token}?k=${encodeURIComponent(mine)}`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    const theirs = tickets.issue("s", made.share_id, f.other);
    expect((await get(app, `/f/${token}?k=${encodeURIComponent(theirs)}`)).status).toBe(403);
  });

  it("opens a server's link for its members only", async () => {
    const { links, app, tickets } = rig();
    const room = await picture();
    const made = await links.issue({
      artifact_id: room.id,
      audience: "space",
      space_id: f.room.space_id,
    });
    if (!made.ok) throw new Error(made.message);
    const token = tokenOf(made.url);
    const member = tickets.issue("s", made.share_id, f.other);
    expect((await get(app, `/f/${token}?k=${encodeURIComponent(member)}`)).status).toBe(200);
    const outsider = tickets.issue("s", made.share_id, f.stranger);
    expect((await get(app, `/f/${token}?k=${encodeURIComponent(outsider)}`)).status).toBe(403);
  });

  it("counts a use per request from the first byte, and serves ranges", async () => {
    const { app } = rig();
    const text = await f.store.ingest(new TextEncoder().encode("0123456789"), {
      source: "doc",
      plugin: "notebook",
      place: f.room,
      scope: "public",
    });
    const { share, token } = f.store.shares.create(text.id, { audience: "link", maxUses: 2 });
    const part = await get(app, `/f/${token}`, { headers: { range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(await part.text()).toBe("234");
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(f.store.shares.get(share.id)?.uses).toBe(0);
    expect((await get(app, `/f/${token}`)).status).toBe(200);
    expect((await get(app, `/f/${token}`)).status).toBe(200);
    expect((await get(app, `/f/${token}`)).status).toBe(404);
  });

  it("downloads a member's own item with a ticket, as an attachment", async () => {
    const { app, tickets } = rig();
    const room = await picture();
    const ticket = encodeURIComponent(tickets.issue("d", room.id, f.person));
    const res = await get(app, `/d/${room.id}?k=${ticket}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; /);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(contains(new Uint8Array(await res.arrayBuffer()), HIDDEN)).toBe(false);
    const other = encodeURIComponent(tickets.issue("d", room.id, f.other));
    expect((await get(app, `/d/${room.id}?k=${other}`)).status).toBe(404);
  });

  it("names files safely and limits each address", async () => {
    expect(disposition("attachment", '她的圖"\r\n.png')).toBe(
      `attachment; filename="______.png"; filename*=UTF-8''${encodeURIComponent("她的圖___.png")}`,
    );
    const limited = fileOriginApp({
      store: () => f.store,
      cleaner: new ImageCleaner(() => f.store),
      tickets: new Tickets(() => f.clock.now()),
      site: () => null,
      isMember: () => false,
      moderation: () => undefined,
      now: () => f.clock.now(),
      perIpPerMinute: 2,
      perLinkPerMinute: 100,
      publicCacheSecs: 0,
      clientIpHeader: "",
    });
    await get(limited, "/f/x");
    await get(limited, "/f/x");
    expect((await get(limited, "/f/x")).status).toBe(429);
    f.clock.advance(60_000);
    expect((await get(limited, "/f/x")).status).toBe(404);
  });

  it("takes only a bare https origin", () => {
    expect(parseOrigin("", "k")).toBeNull();
    expect(parseOrigin("https://files.example.com/", "k")).toBe("https://files.example.com");
    expect(parseOrigin("http://127.0.0.1:7886", "k")).toBe("http://127.0.0.1:7886");
    for (const bad of ["http://files.example.com", "https://x.com/f", "ftp://x", "nope"]) {
      expect(() => parseOrigin(bad, "k"), bad).toThrow();
    }
  });
});

// ---- the member page and the owner's view -------------------------------------------------------

function routes(files: FilesSide) {
  const audit: string[] = [];
  const people = {
    personByAccount: async (a: AccountRef) => {
      const p = f.t.identity?.personOf(a);
      return p ? { id: p.id } : null;
    },
  };
  const state = {
    files,
    publicSide: { config: { enabled: true }, admitMember: () => null },
    now: () => f.clock.now(),
    auditAs: async (_a: string, action: string) => {
      audit.push(action);
    },
    audit: async (_c: unknown, action: string) => {
      audit.push(action);
    },
    optional: (key: unknown) =>
      key === ArtifactStoreKey ? f.store : key === PeopleStoreKey ? people : undefined,
    service: (key: unknown, what: string) => {
      if (key === ArtifactStoreKey) return f.store;
      throw ApiError.unavailable(`${what} is not available`);
    },
  };
  const hono = new Hono<ApiEnv>();
  const who = (c: { req: { header(n: string): string | undefined } }) =>
    ACCOUNTS[(c.req.header("x-test-member") ?? "owen") as keyof typeof ACCOUNTS];
  const table: AnyRouter = { memberFiles: memberFilesRpc, filesAdmin: filesAdminRpc };
  const all = [
    ...tableRoutes(state as never, table, { responseCheck: "strict" }),
    filesPassRoute(state as never, {
      session: async (c) => (c.req.header("x-test-member") === "none" ? null : { account: who(c) }),
    }),
  ];
  for (const r of all) {
    hono.on(r.method, r.path, async (c) => {
      if (r.member) c.set("member", { account: who(c) } as never);
      else c.set("principal", { kind: "token" } as never);
      try {
        return await r.handler(c);
      } catch (error) {
        return error instanceof ApiError
          ? error.toResponse()
          : ApiError.internal(error).toResponse();
      }
    });
  }
  const call = async (method: string, path: string, body?: unknown, member = "owen") => {
    const res = await hono.request(path, {
      method,
      headers: {
        "x-test-member": member,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as never, res };
  };
  return { hono, call, audit };
}

describe("她做給我的", () => {
  it("lists only what she made for them, with what each may become", async () => {
    const { files } = rig();
    const { call } = routes(files);
    const dm = await picture(f.dm, null);
    const room = await picture();
    await picture(f.room, f.other);
    const list = await call("GET", "/api/member/files");
    expect(list.status).toBe(200);
    const body = list.body as {
      items: { id: string; allowed: string[]; made_in: string }[];
      links: unknown;
    };
    expect(body.links).toEqual({ available: true, scoped: true });
    expect(body.items.map((i) => i.id).sort()).toEqual([dm.id, room.id].sort());
    expect(body.items.find((i) => i.id === dm.id)).toMatchObject({
      made_in: "dm",
      allowed: ["none", "person", "link"],
    });
    expect(body.items.find((i) => i.id === room.id)?.allowed).toEqual([
      "none",
      "person",
      "space",
      "link",
    ]);
    const theirs = await call("GET", "/api/member/files", undefined, "mia");
    expect((theirs.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it("changes visibility, revoking the old link; never wider than where it was made", async () => {
    const { files } = rig();
    const { call } = routes(files);
    const dm = await picture(f.dm, null);
    const toServer = await call("POST", `/api/member/files/${dm.id}/visibility`, {
      visibility: "space",
    });
    expect(toServer.status).toBe(409);
    const mine = await call("POST", `/api/member/files/${dm.id}/visibility`, {
      visibility: "person",
    });
    expect(mine.status).toBe(200);
    const first = (mine.body as { url: string }).url;
    expect(first.startsWith(`${ORIGIN}/f/`)).toBe(true);
    const open = await call("POST", `/api/member/files/${dm.id}/visibility`, {
      visibility: "link",
      days: 3,
    });
    expect((open.body as { item: { visibility: string } }).item.visibility).toBe("link");
    expect(f.store.shares.lookup(tokenOf(first))).toEqual({ ok: false, reason: "revoked" });
    const none = await call("POST", `/api/member/files/${dm.id}/visibility`, {
      visibility: "none",
    });
    expect(none.body).toMatchObject({ url: null, item: { visibility: "none" } });
    // Not theirs: the same 404 as gone.
    expect(
      (await call("POST", `/api/member/files/${dm.id}/visibility`, { visibility: "person" }, "mia"))
        .status,
    ).toBe(404);
  });

  it("keeps, deletes and downloads their own items only", async () => {
    const { files } = rig();
    const { call } = routes(files);
    const room = await picture();
    const kept = await call("POST", `/api/member/files/${room.id}/keep`, { keep: true });
    expect(kept.body).toMatchObject({ kept: true, expires_at: null });
    const back = await call("POST", `/api/member/files/${room.id}/keep`, { keep: false });
    expect((back.body as { expires_at: string | null }).expires_at).not.toBeNull();
    const dl = await call("POST", `/api/member/files/${room.id}/download`);
    expect((dl.body as { url: string }).url).toMatch(new RegExp(`^${ORIGIN}/d/${room.id}\\?k=`));
    expect((await call("DELETE", `/api/member/files/${room.id}`, undefined, "mia")).status).toBe(
      404,
    );
    expect((await call("DELETE", `/api/member/files/${room.id}`)).body).toEqual({ deleted: true });
    expect((await call("GET", "/api/member/files")).body).toMatchObject({ items: [] });
  });

  it("refuses a download and a link for a song cover", async () => {
    const { files } = rig();
    const { call } = routes(files);
    const cover = await f.store.ingest(Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"), {
      source: "sing",
      plugin: "sing",
      place: f.room,
      made_for: f.person,
    });
    expect((await call("POST", `/api/member/files/${cover.id}/download`)).status).toBe(409);
    expect(
      (await call("POST", `/api/member/files/${cover.id}/visibility`, { visibility: "person" }))
        .status,
    ).toBe(409);
    const list = await call("GET", "/api/member/files");
    expect(
      (list.body as { items: { listen_only: boolean; allowed: string[] }[] }).items[0],
    ).toMatchObject({
      listen_only: true,
      allowed: ["none"],
    });
  });

  it("passes a scoped link's visitor through the login and back with a ticket", async () => {
    const { files, tickets } = rig();
    const { hono } = routes(files);
    const room = await picture();
    const made = await files.links?.issue({
      artifact_id: room.id,
      audience: "person",
      person_id: f.person,
    });
    if (!made?.ok) throw new Error("no link");
    const token = tokenOf(made.url);
    const anon = await hono.request(`/api/member/files/pass/${token}`, {
      headers: { "x-test-member": "none" },
    });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe(
      `/api/auth/oauth/login?next=${encodeURIComponent(`/api/member/files/pass/${token}`)}`,
    );
    const owen = await hono.request(`/api/member/files/pass/${token}`);
    expect(owen.status).toBe(302);
    const to = new URL(owen.headers.get("location") ?? "");
    expect(`${to.origin}${to.pathname}`).toBe(`${ORIGIN}/f/${token}`);
    expect(tickets.verify(to.searchParams.get("k"), "s", made.share_id)).toBe(f.person);
    const mia = await hono.request(`/api/member/files/pass/${token}`, {
      headers: { "x-test-member": "mia" },
    });
    expect(mia.status).toBe(403);
  });

  it("lets the owner see everything, read the trail and take something down", async () => {
    const { files } = rig();
    const { call } = routes(files);
    const room = await picture();
    await files.links?.issue({ artifact_id: room.id, audience: "person", person_id: f.person });
    const list = await call("GET", "/api/files");
    expect((list.body as { items: unknown[] }).items.length).toBeGreaterThanOrEqual(2);
    const down = await call("POST", `/api/files/${room.id}/takedown`, { reason: "檢舉" });
    expect(down.body).toMatchObject({ review: "taken_down" });
    const history = await call("GET", "/api/files/history");
    const types = (history.body as { type: string }[]).map((e) => e.type);
    expect(types).toContain("share.created");
    expect(types).toContain("artifact.taken_down");
  });
});
