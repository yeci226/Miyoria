// The API tidy (v5-architecture §11.1): three route groups on two listeners, the admin token's
// failure limit, and the static files' allow-list. Every listener is on 127.0.0.1.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonaHandle, PersonaHandleKey } from "@miyoria/brain/agent";
import { RequestQueue, RequestQueueKey } from "@miyoria/play/queue";
import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import { Profile, ProfileManifestSchema } from "@miyoria/runtime/profile";
import { PersonaOverrideStoreKey } from "@miyoria/store";
import type { JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryFailureLimiter } from "../src/admin-limit.js";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { privateAddress } from "../src/module.js";
import { staticAccess } from "../src/panel.js";
import { raw } from "./support/http.js";
import { TestStore } from "./support/stores.js";

const TOKEN = "test-token";
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
  return { api, base: api.url() ?? "", publicBase: api.publicUrl() };
}

function panelDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-panel-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "assets"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>Miyoria</title>");
  writeFileSync(join(dir, "assets/app-1a2b.js"), "console.log(1)");
  writeFileSync(join(dir, "assets/app-1a2b.js.map"), "{}");
  writeFileSync(join(dir, "favicon.svg"), "<svg/>");
  writeFileSync(join(dir, "background.local.jpg"), "game art");
  writeFileSync(join(dir, "notes.txt"), "not for the public");
  return dir;
}

describe("route groups and listeners", () => {
  it("serve everything on one listener when public_bind is not set, as before", async () => {
    const { base, publicBase } = await start();
    expect(publicBase).toBeNull();
    expect((await raw(base, "GET", "/api/queue", { token: TOKEN })).status).toBe(200);
    expect((await raw(base, "GET", "/api/health")).status).toBe(200);
  });

  it("never reach an admin or host route through the public listener", async () => {
    const { base, publicBase } = await start({ public_bind: "127.0.0.1:0" });
    const pub = publicBase ?? "";
    expect(pub).not.toBe("");
    // Admin: on the admin listener only; the public one has no such route at all.
    expect((await raw(base, "GET", "/api/queue", { token: TOKEN })).status).toBe(200);
    const hidden = await raw(pub, "GET", "/api/queue", { token: TOKEN });
    expect(hidden.status).toBe(404);
    expect(hidden.body).toEqual({ error: "no such endpoint" });
    expect((await raw(pub, "POST", "/api/queue/skip", { token: TOKEN })).status).toBe(404);
    // Host: a machine joins on the admin listener, never through the tunnel.
    const join = { json: { code: "x", name: "pc" } };
    expect((await raw(pub, "POST", "/api/cluster/join", join)).status).toBe(404);
    expect((await raw(base, "POST", "/api/cluster/join", join)).status).not.toBe(404);
    // Public and member routes: on both.
    expect((await raw(pub, "GET", "/api/health")).status).toBe(200);
    expect((await raw(pub, "GET", "/api/public/status")).status).toBe(200);
    expect((await raw(pub, "GET", "/api/member/session")).status).toBe(401);
  });

  it("refuse an admin listener on every address once the public side has its own", () => {
    for (const ok of ["127.0.0.1", "::1", "100.64.0.5", "100.127.1.1", "fd7a:115c:a1e0::5"]) {
      expect(privateAddress(ok), ok).toBe(true);
    }
    for (const ok of ["192.168.1.10", "10.0.0.2", "172.16.4.4", "fe80::1"]) {
      expect(privateAddress(ok), ok).toBe(true);
    }
    for (const bad of ["0.0.0.0", "::", "8.8.8.8", "100.128.0.1", "172.32.0.1", "2001:db8::1"]) {
      expect(privateAddress(bad), bad).toBe(false);
    }
  });
});

describe("the admin token's failure limit", () => {
  it("locks an address out after ten failures, then lets it try again, longer each time", () => {
    const limiter = new MemoryFailureLimiter();
    const MIN = 60_000;
    let now = 1_000_000;
    for (let i = 0; i < 9; i++) expect(limiter.failed("a", now++)).toBeNull();
    expect(limiter.failed("a", now)).toBe(15 * MIN);
    expect(limiter.blocked("a", now + 14 * MIN)).toBe(MIN);
    // Another address is not affected.
    expect(limiter.blocked("b", now)).toBeNull();
    now += 15 * MIN;
    expect(limiter.blocked("a", now)).toBeNull();
    // The next lockout is twice as long.
    for (let i = 0; i < 9; i++) limiter.failed("a", now + i);
    expect(limiter.failed("a", now + 9)).toBe(30 * MIN);
    // A right token clears the record.
    limiter.succeeded("a");
    expect(limiter.blocked("a", now + 10)).toBeNull();
  });

  it("forgets failures older than its window", () => {
    const limiter = new MemoryFailureLimiter({ maxFailures: 3, windowMs: 1000, blockMs: 5000 });
    limiter.failed("a", 0);
    limiter.failed("a", 1);
    expect(limiter.failed("a", 2000)).toBeNull();
    expect(limiter.failed("a", 2001)).toBeNull();
    expect(limiter.failed("a", 2002)).toBe(5000);
  });

  it("answers 429 to a locked-out address, the right token too", async () => {
    const { base } = await start();
    for (let i = 0; i < 9; i++) {
      expect((await raw(base, "GET", "/api/queue", { token: "wrong" })).status).toBe(401);
    }
    const locked = await raw(base, "GET", "/api/queue", { token: "wrong" });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await raw(base, "GET", "/api/queue", { token: TOKEN })).status).toBe(429);
    // Public routes need no token and are not locked.
    expect((await raw(base, "GET", "/api/health")).status).toBe(200);
  });
});

describe("static files", () => {
  it("go out to the public side by an allow-list", () => {
    expect(staticAccess("/")).toBe("public");
    expect(staticAccess("/index.html")).toBe("public");
    expect(staticAccess("/card/MYR-0001")).toBe("public");
    expect(staticAccess("/assets/app-1a2b.js")).toBe("public");
    expect(staticAccess("/assets/geist-latin.woff2")).toBe("public");
    expect(staticAccess("/favicon.svg")).toBe("public");
    expect(staticAccess("/background.local.jpg")).toBe("public");
    expect(staticAccess("/card-sit.local.webp")).toBe("public");
    for (const path of [
      "/assets/app-1a2b.js.map",
      "/assets/page.html",
      "/notes.txt",
      "/.env",
      "/assets/.hidden.js",
      "/docs/readme.md",
      "/..%2Fmiyoria.toml",
    ]) {
      expect(staticAccess(path), path).toBe("deny");
    }
  });

  it("keep other files off the public listener, and let the pages' own pictures through", async () => {
    const dir = panelDir();
    const { base, publicBase } = await start({ panel_dir: dir, public_bind: "127.0.0.1:0" });
    const pub = publicBase ?? "";
    expect((await raw(pub, "GET", "/")).status).toBe(200);
    expect((await raw(pub, "GET", "/assets/app-1a2b.js")).status).toBe(200);
    expect((await raw(pub, "GET", "/favicon.svg")).status).toBe(200);
    expect((await raw(pub, "GET", "/background.local.jpg")).status).toBe(200);
    expect((await raw(pub, "GET", "/notes.txt")).status).toBe(404);
    expect((await raw(pub, "GET", "/assets/app-1a2b.js.map")).status).toBe(404);
    // Directly on this machine, as before.
    expect((await raw(base, "GET", "/background.local.jpg")).status).toBe(200);
  });

  it("treat a request through the tunnel on one listener as the public side", async () => {
    const dir = panelDir();
    const { base } = await start({ panel_dir: dir });
    const tunnel = { headers: { "cf-connecting-ip": "203.0.113.7" } };
    expect((await raw(base, "GET", "/background.local.jpg", tunnel)).status).toBe(200);
    expect((await raw(base, "GET", "/notes.txt", tunnel)).status).toBe(404);
    expect((await raw(base, "GET", "/assets/app-1a2b.js", tunnel)).status).toBe(200);
    expect((await raw(base, "GET", "/", tunnel)).status).toBe(200);
    expect((await raw(base, "GET", "/notes.txt")).status).toBe(200);
  });
});

/** Reads a push stream until its `ready`, or gives up after `ms`. */
async function untilReady(res: Response, ms = 5_000): Promise<string> {
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  while (!text.includes('"kind":"ready"') && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  reader.releaseLock();
  return text;
}

describe("push streams over the wire", () => {
  it("are on both listeners, the admin stream only on bind, and a closed one frees its place", async () => {
    const { base, publicBase } = await start({ public_bind: "127.0.0.1:0" });
    const pub = publicBase ?? "";
    const open: AbortController[] = [];
    const connect = async () => {
      const ctl = new AbortController();
      const res = await fetch(`${pub}/api/public/stream?topics=status`, { signal: ctl.signal });
      return { ctl, res };
    };
    const first = await connect();
    expect(first.res.status).toBe(200);
    expect(first.res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    expect(first.res.headers.get("cache-control")).toBe("no-cache");
    expect(first.res.headers.get("x-accel-buffering")).toBe("no");
    const text = await untilReady(first.res);
    expect(text).toContain('"topic":"status"');
    expect(text).toMatch(/id: \S+\.\d+\.\S+/);
    open.push(first.ctl);
    for (let i = 1; i < 6; i++) {
      const next = await connect();
      expect(next.res.status).toBe(200);
      await untilReady(next.res);
      open.push(next.ctl);
    }
    // One address holds six; the seventh is refused until one goes away.
    const seventh = await connect();
    expect(seventh.res.status).toBe(429);
    open.shift()?.abort();
    let again = 429;
    for (let i = 0; i < 50 && again !== 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const tryAgain = await connect();
      again = tryAgain.res.status;
      if (again === 200) open.push(tryAgain.ctl);
      else await tryAgain.res.body?.cancel();
    }
    expect(again).toBe(200);
    for (const ctl of open) ctl.abort();

    // The admin stream: on bind only; the public listener has no such route.
    expect((await raw(pub, "GET", "/api/events", { token: TOKEN })).status).toBe(404);
    const head = await fetch(`${base}/api/events`, {
      method: "HEAD",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(head.status).toBe(200);
    // A member stream needs a session, on either listener.
    expect((await raw(pub, "GET", "/api/member/stream?topics=danmaku")).status).toBe(401);
    expect((await raw(base, "GET", "/api/member/stream?topics=danmaku")).status).toBe(401);
  });
});
