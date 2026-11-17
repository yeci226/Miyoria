// The rules a contract schema follows, tried on schemas that break them.

import { oc } from "@orpc/contract";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  checkRules,
  contractId,
  contractSchemas,
  emitPart,
  emitRoutes,
  exportedSchemas,
  formatDocument,
  namedSchemas,
  partPrefix,
} from "../src/index.js";

const Point = z.object({ x: z.number(), y: z.number() }).meta({ id: "SampleKitPoint" });

describe("checkRules", () => {
  it("accepts named objects, enums and plain primitives", () => {
    const part = {
      PointSchema: Point,
      KindSchema: z.enum(["a", "b"]).meta({ id: "SampleKitKind" }),
      NameSchema: z.string().min(1).max(40),
      notASchema: 3,
    };
    expect(checkRules("sample-kit", part)).toEqual([]);
  });

  it("wants a name on an exported object", () => {
    expect(checkRules("sample-kit", { LooseSchema: z.object({ a: z.string() }) })).toEqual([
      'LooseSchema: an exported object needs .meta({ id: "SampleKit..." })',
    ]);
  });

  it("wants the name to start with the part's own", () => {
    const part = { OtherSchema: z.object({ a: z.string() }).meta({ id: "ElsewhereThing" }) };
    expect(checkRules("sample-kit", part)).toEqual([
      'OtherSchema: its id "ElsewhereThing" does not start with "SampleKit"',
    ]);
  });

  it("refuses a transform", () => {
    const part = {
      TrimSchema: z
        .object({ text: z.string().transform((s) => s.trim()) })
        .meta({ id: "SampleKitTrim" }),
    };
    const problems = checkRules("sample-kit", part);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^TrimSchema: no JSON Schema form \(output\)/);
  });

  it("refuses a refine, which JSON Schema would drop without a word", () => {
    const part = {
      PairSchema: z
        .object({ lo: z.number(), hi: z.number() })
        .refine((v) => v.lo <= v.hi)
        .meta({ id: "SampleKitPair" }),
    };
    expect(checkRules("sample-kit", part)).toEqual([
      "PairSchema: a custom check (.refine) does not reach JSON Schema",
    ]);
  });

  it("refuses what has no JSON form at all", () => {
    const part = { WhenSchema: z.object({ at: z.date() }).meta({ id: "SampleKitWhen" }) };
    expect(checkRules("sample-kit", part).length).toBeGreaterThan(0);
  });
});

describe("emitPart", () => {
  it("lists every named schema the exports reach, by name, each once", () => {
    const Line = z.object({ from: Point, to: Point }).meta({ id: "SampleKitLine" });
    const document = emitPart("sample-kit", { LineSchema: Line });
    expect(Object.keys(document?.$defs ?? {})).toEqual(["SampleKitLine", "SampleKitPoint"]);
    expect(document?.$defs.SampleKitLine).toEqual({
      type: "object",
      properties: {
        from: { $ref: "#/$defs/SampleKitPoint" },
        to: { $ref: "#/$defs/SampleKitPoint" },
      },
      required: ["from", "to"],
    });
    expect(document?.title).toBe("@miyoria/contracts/sample-kit");
  });

  it("is written for the reader of a message: defaults are not required, extra keys are allowed", () => {
    const Hello = z
      .object({ version: z.number().int(), features: z.array(z.string()).default([]) })
      .meta({ id: "SampleKitHello" });
    const hello = emitPart("sample-kit", { HelloSchema: Hello })?.$defs.SampleKitHello as {
      required: string[];
      additionalProperties?: unknown;
    };
    expect(hello.required).toEqual(["version"]);
    expect(hello.additionalProperties).toBeUndefined();
  });

  it("gives the same text every time, and nothing for a part without named schemas", () => {
    const part = { PointSchema: Point };
    const first = emitPart("sample-kit", part);
    const second = emitPart("sample-kit", part);
    expect(first).not.toBeNull();
    if (first === null || second === null) return;
    expect(formatDocument(first)).toBe(formatDocument(second));
    expect(formatDocument(first).endsWith("}\n")).toBe(true);
    expect(emitPart("sample-kit", { NameSchema: z.string() })).toBeNull();
  });

  it("refuses a recursive schema without a name", () => {
    const part = {
      BagSchema: z.object({ anything: z.json() }).meta({ id: "SampleKitBag" }),
    };
    expect(() => emitPart("sample-kit", part)).toThrow(/recursive schema has no name/);
  });
});

describe("route contracts", () => {
  const base = oc.$meta<{ audience: string }>({ audience: "admin" });
  const Item = z.object({ name: z.string() }).meta({ id: "SampleKitItem" });

  it("are skipped as exports but their schemas are found, each once", () => {
    const get = base
      .route({ method: "GET", path: "/items/{id}" })
      .input(z.object({ params: z.object({ id: z.string() }) }));
    const one = get.output(Item);
    const table = { items: { one }, again: one };
    const found = contractSchemas({ table, one, ItemSchema: Item });
    expect([...found.keys()]).toEqual(["one.input", "one.output"]);
    expect(exportedSchemas({ table, one }).size).toBe(0);
  });

  it("checks route schemas against the rules, without wanting a name on the input wrapper", () => {
    const ok = base.input(z.object({ query: z.object({ n: z.coerce.number().optional() }) }));
    expect(checkRules("sample-kit", { table: { ok: ok.output(Item) } })).toEqual([]);
    const bad = base.output(z.object({ at: z.date() }));
    const problems = checkRules("sample-kit", { table: { bad } });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems[0]).toMatch(/^table\.bad\.output: no JSON Schema form/);
    const refined = base.input(z.object({ n: z.number() }).refine((v) => v.n > 0));
    expect(checkRules("sample-kit", { table: { refined } })).toEqual([
      "table.refined.input: a custom check (.refine) does not reach JSON Schema",
    ]);
  });

  it("emits the named schemas the routes reach, and nothing else of them", () => {
    const list = base.output(z.array(Item));
    const document = emitPart("sample-kit", { table: { list } });
    expect(Object.keys(document?.$defs ?? {})).toEqual(["SampleKitItem"]);
    expect(emitPart("sample-kit", { table: { bare: base.output(z.string()) } })).toBeNull();
  });

  it("writes the tables out without their schemas, for a client that does not load them", () => {
    const one = base.route({ method: "GET", path: "/items/{id}" }).output(Item);
    expect(emitRoutes({ table: { items: { one } }, ItemSchema: Item, base })).toEqual({
      table: {
        items: {
          one: {
            "~orpc": {
              errorMap: {},
              meta: { audience: "admin" },
              route: { method: "GET", path: "/items/{id}" },
            },
          },
        },
      },
    });
    expect(emitRoutes({ ItemSchema: Item, base })).toBeNull();
  });
});

describe("names", () => {
  it("reads the name a schema was given", () => {
    expect(contractId(Point)).toBe("SampleKitPoint");
    expect(contractId(z.string())).toBeNull();
  });

  it("turns a part's folder name into its prefix", () => {
    expect(partPrefix("wire")).toBe("Wire");
    expect(partPrefix("voice-link")).toBe("VoiceLink");
  });

  it("lists exports in name order and skips what is not a schema", () => {
    const part = { b: z.string(), a: z.number(), c: "text", d: () => 1 };
    expect([...exportedSchemas(part).keys()]).toEqual(["a", "b"]);
  });

  it("does not let two schemas of a part share a name", () => {
    const part = {
      OneSchema: z.object({ a: z.string() }).meta({ id: "SampleKitTwin" }),
      TwoSchema: z.object({ b: z.string() }).meta({ id: "SampleKitTwin" }),
    };
    expect(() => namedSchemas(part)).toThrow(/two schemas are named "SampleKitTwin"/);
  });
});
