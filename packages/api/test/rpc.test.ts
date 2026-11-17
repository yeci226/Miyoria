// The shell around the route table (`rpc.ts`), on a table of its own: the response policy per
// audience and mode, the permission node, and the errors of a bad input or a failed handler. Who
// may call a route (authentication, CSRF) is the old shell's, tested with the real routes.

import { route } from "@miyoria/contracts/api";
import { AuthorizerKey } from "@miyoria/types";
import { implement } from "@orpc/server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { RpcContext } from "../src/contract.js";
import { ApiError } from "../src/errors.js";
import { extraKeys, type ResponseCheck, tableRoutes } from "../src/rpc.js";
import type { Principal } from "../src/session.js";
import type { ApiEnv } from "../src/state.js";

const Item = z.object({ name: z.string() });
const table = {
  open: route
    .meta({ audience: "public", permission: null })
    .route({ method: "GET", path: "/api/t/open" })
    .output(Item),
  admin: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/t/admin" })
    .output(z.array(Item)),
  item: route
    .meta({ audience: "admin", permission: "test.node" })
    .route({ method: "PUT", path: "/api/t/items/{id}" })
    .input(
      z.object({
        params: z.object({ id: z.string() }),
        query: z.object({ n: z.coerce.number<number | string>().optional() }),
        body: Item,
      }),
    )
    .output(z.object({ id: z.string(), name: z.string(), n: z.number().nullable() })),
  worded: route
    .meta({
      audience: "admin",
      permission: "test.node",
      refusal: "managing the thing needs `test.node`",
    })
    .route({ method: "POST", path: "/api/t/worded" })
    .input(z.object({ body: Item }))
    .output(Item),
  gone: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/t/gone" })
    .output(Item),
  limited: route
    .meta({ audience: "member", permission: null, limited: true })
    .route({ method: "POST", path: "/api/t/limited" })
    .input(z.object({ body: Item }))
    .output(Item),
  unlimited: route
    .meta({ audience: "member", permission: null })
    .route({ method: "POST", path: "/api/t/unlimited" })
    .input(z.object({ body: Item }))
    .output(Item),
};

/** What the admin route answers; a test sets it. */
let adminAnswer: unknown[] = [];

const os = implement(table).$context<RpcContext>();
const served = os.router({
  // Says more than the schema: the public answer must lose it.
  open: os.open.handler(() => ({ name: "a", secret: "x" }) as { name: string }),
  admin: os.admin.handler(() => adminAnswer as { name: string }[]),
  item: os.item.handler(({ input }) => ({
    id: input.params.id,
    name: input.body.name,
    n: input.query.n ?? null,
  })),
  worded: os.worded.handler(({ input }) => input.body),
  gone: os.gone.handler(() => {
    throw ApiError.notFound("no such thing");
  }),
  limited: os.limited.handler(({ input }) => input.body),
  unlimited: os.unlimited.handler(({ input }) => input.body),
});

const OWEN = { platform: "discord", id: "1" };
const session = (account = OWEN): Principal =>
  ({ kind: "session", record: { account }, write: true }) as never;

/** The member's limit: `allowed` asks, then 5 s to wait; `asked` counts every ask. */
function app(
  check: ResponseCheck,
  principal: Principal = { kind: "token" },
  limit = { allowed: Number.POSITIVE_INFINITY, asked: 0 },
) {
  const authorizer = {
    allows: (account: { id: string }, node: string) => account.id === "2" && node === "test.node",
  };
  const state = {
    optional: (key: unknown) => (key === AuthorizerKey ? authorizer : undefined),
    publicSide: {
      config: { enabled: true },
      admitMember: () => (++limit.asked > limit.allowed ? 5000 : null),
    },
  };
  const hono = new Hono<ApiEnv>();
  for (const r of tableRoutes(state as never, served, { responseCheck: check })) {
    hono.on(r.method, r.path, async (c) => {
      c.set("principal", principal);
      if (c.req.path.includes("limited")) c.set("member", { account: OWEN } as never);
      try {
        return await r.handler(c);
      } catch (error) {
        return error instanceof ApiError
          ? error.toResponse()
          : ApiError.internal(error).toResponse();
      }
    });
  }
  return async (method: string, path: string, init: RequestInit = {}) => {
    const response = await hono.request(path, { method, ...init });
    const text = await response.text();
    return { status: response.status, body: text === "" ? null : JSON.parse(text), response };
  };
}

const put = (body: string, type = "application/json") => ({
  body,
  headers: { "content-type": type },
});

describe("the response policy", () => {
  it("strips a public answer to its schema, in either mode", async () => {
    for (const check of ["strict", "production"] as const) {
      const r = await app(check)("GET", "/api/t/open");
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ name: "a" });
    }
  });

  it("fails an admin answer with a field the schema does not name, while strict", async () => {
    adminAnswer = [{ name: "a" }, { name: "b", extra: 1 }];
    const r = await app("strict")("GET", "/api/t/admin");
    expect(r.status).toBe(500);
    expect(r.body.error).toBe(
      "the response does not match its schema: 1.extra: not in the response schema",
    );
  });

  it("fails an admin answer of the wrong shape, while strict", async () => {
    adminAnswer = [{ name: 5 }];
    const r = await app("strict")("GET", "/api/t/admin");
    expect(r.status).toBe(500);
    expect(r.body.error).toMatch(/^the response does not match its schema: 0\.name: /);
  });

  it("lets an admin answer through as built in production, extra fields and all", async () => {
    const serve = app("production");
    adminAnswer = [{ name: "b", extra: 1 }];
    expect((await serve("GET", "/api/t/admin")).body).toEqual([{ name: "b", extra: 1 }]);
    adminAnswer = [{ name: 5 }];
    expect((await serve("GET", "/api/t/admin")).body).toEqual([{ name: 5 }]);
  });

  it("finds the fields a stripped value lost", () => {
    const raw = { a: 1, b: { c: 2, d: 3 }, e: [{ f: 1, g: 2 }], h: undefined };
    const parsed = { a: 1, b: { c: 2 }, e: [{ f: 1 }] };
    expect(extraKeys(raw, parsed)).toEqual([
      ["b", "d"],
      ["e", 0, "g"],
    ]);
  });
});

describe("the permission node", () => {
  const body = put('{"name":"x"}');

  it("is held by the token", async () => {
    expect((await app("strict")("PUT", "/api/t/items/7", body)).status).toBe(200);
  });

  it("is checked against the session's account", async () => {
    const without = await app("strict", session())("PUT", "/api/t/items/7", body);
    expect(without.status).toBe(403);
    expect(without.body).toEqual({ error: "this needs `test.node`" });
    const holder = session({ platform: "discord", id: "2" });
    expect((await app("strict", holder)("PUT", "/api/t/items/7", body)).status).toBe(200);
  });

  it("is refused in the words the route gives, when it gives some", async () => {
    const r = await app("strict", session())("POST", "/api/t/worded", put('{"name":"x"}'));
    expect(r.status).toBe(403);
    expect(r.body).toEqual({ error: "managing the thing needs `test.node`" });
  });

  it("comes before the body is read", async () => {
    const r = await app("strict", session())("PUT", "/api/t/items/7", put("{"));
    expect(r.status).toBe(403);
  });
});

describe("the input", () => {
  const serve = app("strict");

  it("arrives as params, query and body", async () => {
    const r = await serve("PUT", "/api/t/items/a%20b?n=3", put('{"name":"x"}'));
    expect(r.body).toEqual({ id: "a b", name: "x", n: 3 });
  });

  it("takes a +json body as JSON", async () => {
    const r = await serve(
      "PUT",
      "/api/t/items/7",
      put('{"name":"x"}', "application/merge-patch+json"),
    );
    expect(r.status).toBe(200);
  });

  it("is refused like an old route's: 415, 400, 422, and 400 for the query", async () => {
    const noType = await serve("PUT", "/api/t/items/7", put('{"name":"x"}', "text/plain"));
    expect(noType).toMatchObject({ status: 415 });
    expect(noType.body.error).toBe("Expected request with `Content-Type: application/json`");
    const syntax = await serve("PUT", "/api/t/items/7", put("{"));
    expect(syntax.status).toBe(400);
    expect(syntax.body.error).toMatch(/^Failed to parse the request body as JSON: /);
    const shape = await serve("PUT", "/api/t/items/7", put('{"name":1}'));
    expect(shape.status).toBe(422);
    expect(shape.body.error).toMatch(
      /^Failed to deserialize the JSON body into the target type: name: /,
    );
    const query = await serve("PUT", "/api/t/items/7?n=abc", put('{"name":"x"}'));
    expect(query.status).toBe(400);
    expect(query.body.error).toMatch(/^Failed to deserialize query string: n: /);
  });
});

describe("a failed handler", () => {
  it("answers with its own error, the way an old route does", async () => {
    const r = await app("strict")("GET", "/api/t/gone");
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: "no such thing" });
    expect(r.response.headers.get("content-type")).toBe("application/json");
  });

  it("serves HEAD for a GET route", async () => {
    const r = await app("strict")("HEAD", "/api/t/open");
    expect(r.status).toBe(200);
    expect(r.body).toBeNull();
  });
});

describe("the member's rate limit", () => {
  const good = put('{"name":"x"}');

  it("runs before the body is read: a limited caller gets 429 whatever the body is", async () => {
    const limit = { allowed: 0, asked: 0 };
    const serve = app("strict", { kind: "token" }, limit);
    for (const body of [good, put("{"), put('{"name":1}'), put("x", "text/plain")]) {
      const r = await serve("POST", "/api/t/limited", body);
      expect(r.status).toBe(429);
      expect(r.response.headers.get("retry-after")).toBe("5");
    }
  });

  it("counts a request with a malformed body", async () => {
    const limit = { allowed: 2, asked: 0 };
    const serve = app("strict", { kind: "token" }, limit);
    expect((await serve("POST", "/api/t/limited", put("{"))).status).toBe(400);
    expect((await serve("POST", "/api/t/limited", put('{"name":1}'))).status).toBe(422);
    expect((await serve("POST", "/api/t/limited", good)).status).toBe(429);
    expect(limit.asked).toBe(3);
  });

  it("is only asked of a route that says it is limited", async () => {
    const limit = { allowed: 0, asked: 0 };
    const r = await app("strict", { kind: "token" }, limit)("POST", "/api/t/unlimited", good);
    expect(r.status).toBe(200);
    expect(limit.asked).toBe(0);
  });
});
