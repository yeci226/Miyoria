// TS-specific HTTP behaviour: axum's extractor rejections, 405s, HEAD, client errors, closing
// the event stream from the client, and panel file edge cases.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { PersonaHandle, PersonaHandleKey } from "@miyoria/agent";
import { Supervisor, SupervisorKey } from "@miyoria/kernel";
import { Profile, ProfileManifestSchema } from "@miyoria/profile";
import { RequestQueue, RequestQueueKey } from "@miyoria/queue";
import { PersonaOverrideStoreKey } from "@miyoria/store";
import type { JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiClient, ApiModule, ClientError } from "../src/index.js";
import { errorOf, raw, waitFor } from "./support/http.js";
import { TestStore } from "./support/stores.js";

const TOKEN = "test-token";

/** Status of a GET with `path` sent exactly as given. */
function rawStatus(base: string, path: string): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, path, method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

/** A GET (or `method`) sent with exactly `headers`, its body as sent (not decompressed). */
function rawGet(
  base: string,
  path: string,
  headers: Record<string, string>,
  method = "GET",
): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: hostname, port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

async function start(config: Record<string, JsonValue> = {}) {
  const sup = new Supervisor();
  const store = new TestStore();
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  sup.services.provide("kernel", PersonaOverrideStoreKey, store.personaOverrides);
  const profile = new Profile({
    dir: ".",
    manifest: ProfileManifestSchema.parse({ id: "p", display_name: "Test" }),
    sections: [{ key: "identity", body: "I am Test." }],
    examples: [],
    voice: null,
    avatar: null,
  });
  sup.services.provide("kernel", PersonaHandleKey, new PersonaHandle(profile));
  sup.services.provide("queue", RequestQueueKey, new RequestQueue());
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "", ...config }, true);
  await sup.startAll();
  cleanups.push(() => sup.stopAll());
  const base = api.url() ?? "";
  return { sup, base, client: new ApiClient(base, TOKEN) };
}

describe("http", () => {
  it("rejects bodies like axum's Json extractor", async () => {
    const { base } = await start();
    const put = (headers: Record<string, string>, body: string) =>
      fetch(`${base}/api/persona/style`, {
        method: "PUT",
        headers: { authorization: `Bearer ${TOKEN}`, ...headers },
        body,
      }).then(async (r) => ({ status: r.status, body: (await r.json()) as { error: string } }));

    const noType = await put({}, '{"body":"x"}');
    expect(noType.status).toBe(415);
    expect(noType.body.error).toContain("Content-Type: application/json");
    const syntax = await put({ "content-type": "application/json" }, "{");
    expect(syntax.status).toBe(400);
    expect(syntax.body.error).toMatch(/^Failed to parse the request body as JSON/);
    const shape = await put({ "content-type": "application/json" }, '{"body": 1}');
    expect(shape.status).toBe(422);
    expect(shape.body.error).toMatch(/^Failed to deserialize the JSON body/);
    const ok = await put({ "content-type": "application/json; charset=utf-8" }, '{"body":"x"}');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ key: "style", version: 1 });
  });

  it("rejects bad query strings with 400", async () => {
    const { base } = await start();
    const r = await raw(base, "GET", "/api/people?limit=abc", { token: TOKEN });
    // The people stores are missing, but the query is checked first.
    expect(r.status).toBe(400);
    expect((r.body as { error: string }).error).toMatch(/^Failed to deserialize query string/);
  });

  it("answers 405 for another method on a known path, after authentication", async () => {
    const { base } = await start();
    expect((await raw(base, "DELETE", "/api/queue")).status).toBe(401);
    const r = await raw(base, "DELETE", "/api/queue", { token: TOKEN });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET,HEAD");
    expect((await raw(base, "POST", "/api/health")).status).toBe(405);
  });

  it("serves HEAD for GET routes", async () => {
    const { sup, base } = await start();
    const r = await raw(base, "HEAD", "/api/health");
    expect(r.status).toBe(200);
    expect(r.text).toBe("");
    const before = sup.bus.subscriberCount;
    const events = await raw(base, "HEAD", "/api/events", { token: TOKEN });
    expect(events.status).toBe(200);
    expect(events.headers.get("content-type")).toBe("text/event-stream");
    expect(sup.bus.subscriberCount).toBe(before);
  });

  it("client errors carry the status and the server's message", async () => {
    const { base } = await start();
    const err = await errorOf(new ApiClient(base, "wrong").modules());
    expect(err).toBeInstanceOf(ClientError);
    expect(err.kind).toBe("api");
    expect(err.status).toBe(401);
    expect(err.message).toBe(
      "admin API returned 401 Unauthorized: missing or invalid bearer token",
    );

    const unreachable = await errorOf(new ApiClient("http://127.0.0.1:1", TOKEN).health());
    expect(unreachable.kind).toBe("transport");
    expect(unreachable.status).toBeNull();
    expect(unreachable.message).toMatch(/^cannot reach the admin API: /);
  });

  it("module JSON keeps the legacy shape", async () => {
    const { client } = await start();
    const [api] = await client.modules();
    expect(api).toEqual({
      id: "api",
      name: "Admin API",
      description: "HTTP + SSE API for the CLI and the admin panel",
      enabled: true,
      state: "running",
      reason: null,
      recent_restarts: 0,
    });
  });

  it("closing the client's event stream ends the server subscription", async () => {
    const { sup, client } = await start();
    const before = sup.bus.subscriberCount;
    const events = await client.events();
    expect(sup.bus.subscriberCount).toBe(before + 1);
    sup.bus.publish("test", { type: "custom", data: { topic: "test.ping", payload: 1 } });
    const first = await events.next();
    expect(first.value?.event).toEqual({
      type: "custom",
      data: { topic: "test.ping", payload: 1 },
    });
    events.close();
    expect((await events.next()).done).toBe(true);
    await waitFor(() => (sup.bus.subscriberCount === before ? true : null));
  });

  it("an aborted signal ends the event stream", async () => {
    const { sup, client } = await start();
    const controller = new AbortController();
    const events = await client.events(["test.*"], { signal: controller.signal });
    const next = events.next();
    controller.abort();
    expect((await next).done).toBe(true);
    void sup;
  });

  it("panel files: directories, traversal, conditional requests", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-panel-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Miyoria</title>");
    writeFileSync(join(dir, "docs/index.html"), "docs");
    const { base } = await start({ panel_dir: dir });

    const redirect = await raw(base, "GET", "/docs?x=1");
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("/docs/?x=1");
    const docs = await raw(base, "GET", "/docs/");
    expect(docs.text).toBe("docs");
    expect(docs.headers.get("x-content-type-options")).toBe("nosniff");

    // `fetch` normalizes dot segments, so send the raw paths.
    for (const path of [
      "/..%2Findex.html",
      "/../../package.json",
      "/%2e%2e/package.json",
      "/a%5c..%5cindex.html",
    ]) {
      expect(await rawStatus(base, path), path).toBe(404);
    }

    const index = await raw(base, "GET", "/index.html");
    // The page is rewritten per route, so it revalidates on what was sent, not on the file's date.
    const tag = index.headers.get("etag") ?? "";
    expect(tag).not.toBe("");
    const cached = await raw(base, "GET", "/index.html", { headers: { "if-none-match": tag } });
    expect(cached.status).toBe(304);
    expect(cached.headers.get("cache-control")).toBe("no-cache");

    expect((await raw(base, "POST", "/index.html")).status).toBe(405);

    // The panel's pages are routes in the page: they get index.html; a missing file stays a 404.
    for (const page of ["/card/MYR-AB12-CD34-EF56", "/people/01ABC", "/me", "/login?error=state"]) {
      const res = await raw(base, "GET", page);
      expect(res.status, page).toBe(200);
      expect(res.text, page).toContain("<title>Miyoria</title>");
      expect(res.headers.get("cache-control"), page).toBe("no-cache");
    }
    expect(await rawStatus(base, "/assets/missing-abc.js")).toBe(404);
    expect(await rawStatus(base, "/card-smile.local.webp")).toBe(404);
  });

  it("panel files: text is compressed, media and ranges are not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-panel-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const page = `<!doctype html><title>Miyoria</title>${"<p>她在這裡</p>".repeat(200)}`;
    const script = `export const x = ${JSON.stringify("miyoria ".repeat(500))};\n`;
    const video = Buffer.alloc(4096, 7);
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.html"), page);
    writeFileSync(join(dir, "assets/app.js"), script);
    writeFileSync(join(dir, "assets/tiny.css"), "a{}");
    writeFileSync(join(dir, "assets/clip.webm"), video);
    const { base } = await start({ panel_dir: dir });

    // Brotli when offered, else gzip; the bytes come back the same either way, again from cache.
    for (let i = 0; i < 2; i++) {
      const br = await rawGet(base, "/assets/app.js", { "accept-encoding": "gzip, deflate, br" });
      expect(br.status).toBe(200);
      expect(br.headers["content-encoding"]).toBe("br");
      expect(br.headers.vary).toBe("accept-encoding");
      expect(Number(br.headers["content-length"])).toBe(br.body.length);
      expect(br.body.length).toBeLessThan(script.length / 4);
      expect(brotliDecompressSync(br.body).toString()).toBe(script);
    }
    for (const accept of ["gzip", "br;q=0, gzip;q=0.5", "*;q=0, gzip"]) {
      const gz = await rawGet(base, "/assets/app.js", { "accept-encoding": accept });
      expect(gz.headers["content-encoding"], accept).toBe("gzip");
      expect(gunzipSync(gz.body).toString(), accept).toBe(script);
    }
    for (const accept of [undefined, "identity", "br;q=0, gzip;q=0"]) {
      const plain = await rawGet(
        base,
        "/assets/app.js",
        accept === undefined ? {} : { "accept-encoding": accept },
      );
      expect(plain.headers["content-encoding"], accept).toBeUndefined();
      expect(plain.body.toString(), accept).toBe(script);
      expect(plain.headers.vary, accept).toBe("accept-encoding");
    }

    // Video, and files too small to gain, go as they are.
    const clip = await rawGet(base, "/assets/clip.webm", { "accept-encoding": "br, gzip" });
    expect(clip.headers["content-encoding"]).toBeUndefined();
    expect(clip.headers.vary).toBeUndefined();
    expect(clip.body.equals(video)).toBe(true);
    const tiny = await rawGet(base, "/assets/tiny.css", { "accept-encoding": "br, gzip" });
    expect(tiny.headers["content-encoding"]).toBeUndefined();

    // A range is of the file as it is: never compressed.
    const part = await rawGet(base, "/assets/app.js", {
      "accept-encoding": "br, gzip",
      range: "bytes=0-5",
    });
    expect(part.status).toBe(206);
    expect(part.headers["content-encoding"]).toBeUndefined();
    expect(part.body.toString()).toBe(script.slice(0, 6));

    // The page: compressed with a weak tag, and either form of the tag revalidates it.
    const html = await rawGet(base, "/", { "accept-encoding": "br" });
    expect(html.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(html.body).toString()).toContain("<title>Miyoria</title>");
    const weak = String(html.headers.etag);
    expect(weak).toMatch(/^W\/"/);
    const strong = weak.slice(2);
    expect((await rawGet(base, "/", {})).headers.etag).toBe(strong);
    for (const tag of [weak, strong]) {
      expect(
        (await rawGet(base, "/", { "accept-encoding": "br", "if-none-match": tag })).status,
        tag,
      ).toBe(304);
    }
  });

  it("panel files: HEAD has the headers GET would send", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-panel-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "assets"));
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><title>Miyoria</title>${"<p>她</p>".repeat(300)}`,
    );
    writeFileSync(
      join(dir, "assets/app.js"),
      `export const x = ${JSON.stringify("miyoria ".repeat(500))};\n`,
    );
    const { base } = await start({ panel_dir: dir });
    const same = ["status", "content-encoding", "content-length", "etag", "vary", "last-modified"];
    for (const path of ["/", "/assets/app.js"]) {
      for (const accept of ["br, gzip", "gzip", "identity"]) {
        const get = await rawGet(base, path, { "accept-encoding": accept });
        const head = await rawGet(base, path, { "accept-encoding": accept }, "HEAD");
        expect(head.body.length, `${path} ${accept}`).toBe(0);
        for (const name of same) {
          const want = name === "status" ? get.status : get.headers[name];
          const got = name === "status" ? head.status : head.headers[name];
          expect(got, `${path} ${accept} ${name}`).toEqual(want);
        }
      }
    }
  });

  it("panel files: byte ranges", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-panel-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>Miyoria</title>");
    writeFileSync(join(dir, "clip.webm"), "0123456789");
    writeFileSync(join(dir, "empty.webm"), "");
    const { base } = await start({ panel_dir: dir });
    const get = (range: string, extra: Record<string, string> = {}) =>
      raw(base, "GET", "/clip.webm", { headers: { range, ...extra } });

    // An empty file has no part a suffix could name: sent whole; a start in it is outside.
    const emptySuffix = await raw(base, "GET", "/empty.webm", { headers: { range: "bytes=-5" } });
    expect(emptySuffix.status).toBe(200);
    expect(emptySuffix.text).toBe("");
    expect((await raw(base, "GET", "/empty.webm", { headers: { range: "bytes=0-" } })).status).toBe(
      416,
    );

    // One range: 206 with that part, the size after the slash.
    for (const [range, text, contentRange] of [
      ["bytes=0-3", "0123", "bytes 0-3/10"],
      ["bytes=7-", "789", "bytes 7-9/10"],
      ["bytes=-2", "89", "bytes 8-9/10"],
      ["bytes=8-99", "89", "bytes 8-9/10"],
      ["bytes=-99", "0123456789", "bytes 0-9/10"],
      ["bytes=0-0", "0", "bytes 0-0/10"],
    ] as const) {
      const res = await get(range);
      expect(res.status, range).toBe(206);
      expect(res.text, range).toBe(text);
      expect(res.headers.get("content-range"), range).toBe(contentRange);
      expect(res.headers.get("content-length"), range).toBe(String(text.length));
      expect(res.headers.get("content-type"), range).toBe("video/webm");
      expect(res.headers.get("accept-ranges"), range).toBe("bytes");
    }

    // A valid range outside the file: 416 with the size.
    for (const range of ["bytes=10-", "bytes=99-200", "bytes=-0"]) {
      const res = await get(range);
      expect(res.status, range).toBe(416);
      expect(res.headers.get("content-range"), range).toBe("bytes */10");
      expect(res.text, range).toBe("");
    }

    // Several ranges, another unit, or an invalid range (RFC 9110 §14.2): the whole file.
    for (const range of [
      "bytes=0-1,4-5",
      "items=0-1",
      "bytes=5-2",
      "bytes=abc",
      "bytes=-",
      "bytes=1-x",
    ]) {
      const res = await get(range);
      expect(res.status, range).toBe(200);
      expect(res.text, range).toBe("0123456789");
    }

    // `If-Range` naming the file as sent keeps the range; anything else gets the whole file.
    const whole = await raw(base, "GET", "/clip.webm");
    const modified = whole.headers.get("last-modified") ?? "";
    expect((await get("bytes=0-1", { "if-range": modified })).status).toBe(206);
    const stale = await get("bytes=0-1", { "if-range": "Thu, 01 Jan 1970 00:00:00 GMT" });
    expect(stale.status).toBe(200);
    expect(stale.text).toBe("0123456789");

    // HEAD and a fresh `If-Modified-Since` are as before: 200 with the whole length, and 304.
    const head = await raw(base, "HEAD", "/clip.webm", { headers: { range: "bytes=0-3" } });
    expect(head.status).toBe(200);
    expect(head.headers.get("content-length")).toBe("10");
    const cached = await get("bytes=0-3", { "if-modified-since": modified });
    expect(cached.status).toBe(304);
  });
});
