// TS-specific HTTP behaviour: axum's extractor rejections, 405s, HEAD, client errors, closing
// the event stream from the client, and panel file edge cases.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
