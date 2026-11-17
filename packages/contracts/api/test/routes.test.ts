// The route table holds together: every route says how it is called and who may call it, its
// path parameters are the ones its input declares, and no two routes share a method and path.

import { isContractProcedure } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { contract, type RouteMeta, routeMeta } from "../src/index.js";

interface Entry {
  name: string;
  method: string;
  path: string;
  meta: RouteMeta;
  input: z.ZodType | undefined;
}

function entries(router: object, at: string[] = []): Entry[] {
  return Object.entries(router).flatMap(([key, value]): Entry[] => {
    const path = [...at, key];
    if (!isContractProcedure(value)) return entries(value as object, path);
    const def = value["~orpc"];
    return [
      {
        name: path.join("."),
        method: def.route.method ?? "",
        path: def.route.path ?? "",
        meta: def.meta as RouteMeta,
        input: def.inputSchema as z.ZodType | undefined,
      },
    ];
  });
}

const all = entries(contract);

describe("the route table", () => {
  it("has routes", () => {
    expect(all.map((e) => e.name)).toContain("persona.set");
  });

  it.each(all)("$name says its method, path and audience", (e) => {
    expect(["GET", "POST", "PUT", "PATCH", "DELETE"]).toContain(e.method);
    expect(e.path).toMatch(/^\/api(\/[a-z0-9_.-]+|\/\{[a-z_]+\})+$/);
    expect(["admin", "member", "public"]).toContain(e.meta.audience);
    expect(e.meta.permission === null || typeof e.meta.permission === "string").toBe(true);
  });

  it.each(all)("$name declares exactly its path parameters, and a body only on a change", (e) => {
    const shape =
      e.input instanceof z.ZodObject ? (e.input.shape as Record<string, z.ZodType>) : {};
    expect(
      Object.keys(shape).every((k) => ["params", "query", "headers", "body"].includes(k)),
    ).toBe(true);
    const inPath = [...e.path.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]).sort();
    const params =
      shape.params instanceof z.ZodObject ? Object.keys(shape.params.shape).sort() : [];
    expect(params).toEqual(inPath);
    if (e.method === "GET") expect(shape.body).toBeUndefined();
  });

  it("gives no two routes the same method and path", () => {
    const lines = all.map((e) => `${e.method} ${e.path.replace(/\{[a-z_]+\}/g, "{}")}`);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("finds a route's metadata by its name", () => {
    expect(routeMeta(contract, ["health"])).toEqual({ audience: "public", permission: null });
    expect(routeMeta(contract, ["persona", "set"])?.audience).toBe("admin");
    expect(routeMeta(contract, ["persona"])).toBeNull();
    expect(routeMeta(contract, ["nope", "x"])).toBeNull();
  });
});
