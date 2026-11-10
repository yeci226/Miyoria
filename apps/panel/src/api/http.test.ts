import { describe, expect, it, vi } from "vitest";
import { mockFetch } from "../test/render";
import { createApi } from "./endpoints";
import { ApiClient, ApiError, buildQuery, describeError, isNotProvided, joinUrl } from "./http";
import type { ContextKey } from "./types";

const ctx: ContextKey = { platform: "discord", scope: "1", channel: "2", kind: "channel" };
const headersOf = (init: RequestInit | undefined) => (init?.headers ?? {}) as Record<string, string>;

describe("url helpers", () => {
  it("joins base and path without doubling slashes", () => {
    expect(joinUrl("", "/api/health")).toBe("/api/health");
    expect(joinUrl("http://127.0.0.1:7878/", "/api/health")).toBe("http://127.0.0.1:7878/api/health");
    expect(joinUrl("http://h/prefix//", "api/x")).toBe("http://h/prefix/api/x");
  });

  it("drops empty query values", () => {
    expect(buildQuery({ a: 1, b: undefined, c: null, d: "", e: false })).toBe("?a=1&e=false");
    expect(buildQuery({})).toBe("");
  });
});

describe("ApiClient", () => {
  it("sends the bearer token, but not to /api/health", async () => {
    const fetch = mockFetch((_m, url) =>
      url.pathname === "/api/health" ? { body: { status: "ok", version: "1.2.3" } } : { body: [] },
    );
    const api = createApi(new ApiClient({ baseUrl: "http://core:7878", token: " s3cret " }));
    expect((await api.health()).version).toBe("1.2.3");
    await api.modules();
    const [healthCall, modulesCall] = fetch.mock.calls;
    expect(String(healthCall?.[0])).toBe("http://core:7878/api/health");
    expect(headersOf(healthCall?.[1]).Authorization).toBeUndefined();
    expect(headersOf(modulesCall?.[1]).Authorization).toBe("Bearer s3cret");
  });

  it("sends the CSRF header and same-origin credentials on every request, token or not", async () => {
    const fetch = mockFetch((method, url) => {
      if (url.pathname === "/api/auth/session") return { body: { method: "discord", user: { id: "1", name: "Owen", avatar_url: null }, permissions: { write: false } } };
      if (method === "POST" && url.pathname === "/api/auth/logout") return { status: 204 };
      if (url.pathname === "/api/auth/methods") return { body: { token: true, discord: true } };
      return { body: [] };
    });
    const api = createApi(new ApiClient({ baseUrl: "", token: "" }));
    expect((await api.authMethods()).discord).toBe(true);
    const me = await api.session();
    expect(me.user?.name).toBe("Owen");
    await api.queuePause(true);
    await api.logout();
    expect(fetch.mock.calls).toHaveLength(4);
    for (const [, init] of fetch.mock.calls) {
      expect(headersOf(init)["X-Miyoria-Request"]).toBe("1");
      expect(headersOf(init).Authorization).toBeUndefined();
      expect(init?.credentials).toBe("same-origin");
    }
    expect(fetch.mock.calls[3]?.[1]?.method).toBe("POST");
  });

  it("builds the Discord login URL with the return path", () => {
    const api = createApi(new ApiClient({ baseUrl: "", token: "" }));
    expect(api.discordLoginUrl("/people")).toBe("/api/auth/oauth/login?next=%2Fpeople");
  });

  it("encodes the decisions context as JSON and passes the limit", async () => {
    const fetch = mockFetch(() => ({ body: [] }));
    const api = createApi(new ApiClient({ baseUrl: "", token: "t" }));
    await api.decisions({ limit: 200, context: ctx });
    const url = new URL(String(fetch.mock.calls[0]?.[0]), "http://x");
    expect(url.pathname).toBe("/api/decisions");
    expect(url.searchParams.get("limit")).toBe("200");
    expect(JSON.parse(url.searchParams.get("context") ?? "")).toEqual(ctx);
  });

  it("PUTs a persona section with a JSON body and an encoded key", async () => {
    const fetch = mockFetch((method, url) =>
      method === "PUT" && url.pathname === "/api/persona/my%20key" ? { body: { key: "my key", version: 3 } } : undefined,
    );
    const api = createApi(new ApiClient({ baseUrl: "", token: "t" }));
    const res = await api.setPersonaSection("my key", { body: "hi", edited_by: "panel" });
    expect(res.version).toBe(3);
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.method).toBe("PUT");
    expect(headersOf(init)["Content-Type"]).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toEqual({ body: "hi", edited_by: "panel" });
  });

  it("posts module actions to /api/modules/{id}/{action}", async () => {
    const fetch = mockFetch((m) => (m === "POST" ? { body: { id: "platform.discord.bot" } } : undefined));
    const api = createApi(new ApiClient({ baseUrl: "", token: "t" }));
    await api.moduleAction("platform.discord.bot", "restart");
    expect(String(fetch.mock.calls[0]?.[0])).toBe("/api/modules/platform.discord.bot/restart");
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("POST");
  });

  it("classifies the server fallback 404 as not provided", async () => {
    mockFetch(() => undefined);
    const api = createApi(new ApiClient({ baseUrl: "", token: "t" }));
    const err = await api.people().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("not_provided");
    expect(isNotProvided(err)).toBe(true);
    expect(describeError(err)).toContain("還沒有提供");
  });

  it("classifies a 404 for a missing item as not found", async () => {
    mockFetch(() => ({ status: 404, body: { error: "unknown module `nope`" } }));
    const api = createApi(new ApiClient({ baseUrl: "", token: "t" }));
    const err = (await api.moduleAction("nope", "enable").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("not_found");
    expect(err.message).toBe("unknown module `nope`");
  });

  it("treats a non-JSON 404 (static server, proxy) as not provided", async () => {
    mockFetch(() => ({ status: 404, text: "<html>Not Found</html>" }));
    const err = (await new ApiClient({ baseUrl: "", token: "t" }).get("/api/queue").catch((e: unknown) => e)) as ApiError;
    expect(err.kind).toBe("not_provided");
  });

  it("maps 401, 409 and 503", async () => {
    const client = new ApiClient({ baseUrl: "", token: "bad" });
    mockFetch(() => ({ status: 401, body: { error: "missing or invalid bearer token" } }));
    expect(((await client.get("/api/modules").catch((e: unknown) => e)) as ApiError).kind).toBe("unauthorized");

    mockFetch(() => ({ status: 409, body: { error: "module `x` is disabled; enable it instead" } }));
    const conflict = (await client.post("/api/modules/x/restart").catch((e: unknown) => e)) as ApiError;
    expect(conflict.kind).toBe("http");
    expect(conflict.status).toBe(409);
    expect(conflict.message).toContain("enable it instead");

    mockFetch(() => ({ status: 503, body: { error: "persona is not available" } }));
    expect(((await client.get("/api/persona").catch((e: unknown) => e)) as ApiError).kind).toBe("unavailable");
  });

  it("reports network failures and non-JSON success bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    const client = new ApiClient({ baseUrl: "", token: "t" });
    const net = (await client.get("/api/modules").catch((e: unknown) => e)) as ApiError;
    expect(net.kind).toBe("network");
    expect(net.status).toBe(0);

    mockFetch(() => ({ status: 200, text: "<!doctype html>" }));
    expect(((await client.get("/api/modules").catch((e: unknown) => e)) as ApiError).kind).toBe("bad_response");
  });

  it("passes AbortError through untouched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new DOMException("aborted", "AbortError"))));
    const err = await new ApiClient({ baseUrl: "", token: "t" }).get("/api/modules").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DOMException);
  });

  it("builds planned query strings", async () => {
    const fetch = mockFetch(() => ({ body: { items: [], next_cursor: null } }));
    const api = createApi(new ApiClient({ baseUrl: "", token: "t" }));
    await api.memory({ q: "拉麵", kind: "fact", include_superseded: true, limit: 20 });
    const url = new URL(String(fetch.mock.calls[0]?.[0]), "http://x");
    expect(url.pathname).toBe("/api/memory");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "拉麵", kind: "fact", include_superseded: "true", limit: "20" });
  });
});
