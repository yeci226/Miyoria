import type { JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  compactSchema,
  flattenResult,
  globMatch,
  MAX_TOOL_NAME,
  parseBind,
  registryName,
  ToolFilter,
  tokenMatches,
  truncateChars,
} from "../src/index.js";

describe("policy", () => {
  it("compacts_schemas_but_keeps_property_names", () => {
    const schema: JsonValue = {
      $schema: "http://json-schema.org/draft-07/schema#",
      $id: "https://example.com/args",
      title: "Args",
      type: "object",
      properties: {
        title: { type: "string", title: "T", examples: ["a"], description: "d" },
        tags: { type: "array", items: { type: "string", $comment: "c" } },
        pick: { anyOf: [{ type: "string", title: "S" }, { type: "null" }] },
        tuple: { type: "array", items: [{ type: "integer", title: "I" }] },
        ref: { $ref: "#/$defs/thing" },
      },
      $defs: { thing: { type: "object", title: "Thing", properties: { id: { type: "string" } } } },
      dependentSchemas: { a: { title: "A", required: ["b"] } },
      dependencies: { c: ["d"], e: { title: "E", required: ["f"] } },
      propertyNames: { title: "Name", pattern: "^[a-z]+$" },
      unevaluatedProperties: { title: "Rest", type: "string" },
      additionalProperties: false,
      required: ["title"],
    };
    expect(compactSchema(schema)).toEqual({
      $id: "https://example.com/args",
      type: "object",
      properties: {
        title: { type: "string", examples: ["a"], description: "d" },
        tags: { type: "array", items: { type: "string" } },
        pick: { anyOf: [{ type: "string" }, { type: "null" }] },
        tuple: { type: "array", items: [{ type: "integer" }] },
        ref: { $ref: "#/$defs/thing" },
      },
      $defs: { thing: { type: "object", properties: { id: { type: "string" } } } },
      dependentSchemas: { a: { required: ["b"] } },
      dependencies: { c: ["d"], e: { required: ["f"] } },
      propertyNames: { pattern: "^[a-z]+$" },
      unevaluatedProperties: { type: "string" },
      additionalProperties: false,
      required: ["title"],
    });
    expect(compactSchema("x")).toBe("x");
  });

  it("globs", () => {
    expect(globMatch("*", "anything")).toBe(true);
    expect(globMatch("read_*", "read_file")).toBe(true);
    expect(globMatch("read_*", "write_file")).toBe(false);
    expect(globMatch("*delete*", "bulk_delete_all")).toBe(true);
    expect(globMatch("a?c", "abc")).toBe(true);
    expect(globMatch("a?c", "ac")).toBe(false);
    expect(globMatch("a*b*c", "aXXbYYc")).toBe(true);
    expect(globMatch("a*b*c", "aXXbYY")).toBe(false);
    expect(globMatch("exact", "exact")).toBe(true);
    expect(globMatch("exact", "exactly")).toBe(false);
    expect(globMatch("", "")).toBe(true);
  });

  it("filter_deny_wins", () => {
    const f = new ToolFilter(["read_*", "list"], ["read_secret"]);
    expect(f.allows("read_file")).toBe(true);
    expect(f.allows("list")).toBe(true);
    expect(f.allows("read_secret")).toBe(false);
    expect(f.allows("write")).toBe(false);
    expect(new ToolFilter().allows("x")).toBe(true);
  });

  it("names_are_sanitized_and_bounded", () => {
    const none = new Set<string>();
    expect(registryName("fs", "read.file", none)).toBe("mcp_fs_read_file");
    const long = "t".repeat(100);
    const n = registryName("fs", long, none) as string;
    expect(n).toHaveLength(MAX_TOOL_NAME);
    expect(n.startsWith("mcp_fs_ttt")).toBe(true);
    // Stable, and distinct for distinct originals.
    expect(registryName("fs", long, none)).toBe(n);
    expect(registryName("fs", `${"t".repeat(99)}x`, none)).not.toBe(n);
    // Names that sanitize alike get disambiguated.
    const alt = registryName("fs", "a.b", new Set(["mcp_fs_a_b"])) as string;
    expect(alt).not.toBe("mcp_fs_a_b");
    expect(alt.length).toBeLessThanOrEqual(MAX_TOOL_NAME);
    // Non-ASCII is replaced.
    expect(registryName("fs", "查詢", none)).toBe("mcp_fs___");
  });

  it("hash_matches_legacy", () => {
    // FNV-1a 64 of "fs\0a.b", folded to 32 bits.
    const alt = registryName("fs", "a.b", new Set(["mcp_fs_a_b"])) as string;
    expect(alt).toBe("mcp_fs_a_b_d7150808");
  });

  it("truncation_is_char_safe", () => {
    expect(truncateChars("abc", 10)).toBe("abc");
    expect(truncateChars("abc", 3)).toBe("abc");
    expect(truncateChars("abc", 0)).toBe("abc");
    expect(truncateChars("你好世界!", 2).startsWith("你好\n[truncated: 3 more characters]")).toBe(
      true,
    );
  });

  it("flattens_parts", () => {
    const s = flattenResult({
      content: [
        { type: "text", text: "hello" },
        { type: "image", data: "AAAA", mimeType: "image/png" },
        { type: "resource", resource: { uri: "file:///a", text: "body" } },
      ],
    });
    expect(s).toContain("hello");
    expect(s).toContain("[image omitted: image/png]");
    expect(s).toContain("[resource file:///a]\nbody");
    expect(flattenResult({ content: [] })).toBe("(empty result)");
    expect(flattenResult({ content: [], structuredContent: { a: 1 } })).toBe('{"a":1}');
  });

  it("bearer_token_and_bind_address", () => {
    expect(tokenMatches("Bearer s3cret", "s3cret")).toBe(true);
    expect(tokenMatches("bearer s3cret", "s3cret")).toBe(true);
    expect(tokenMatches("Bearer nope", "s3cret")).toBe(false);
    expect(tokenMatches(undefined, "s3cret")).toBe(false);
    expect(tokenMatches("Bearer ", "")).toBe(false);
    expect(parseBind("127.0.0.1:7881")).toEqual({ host: "127.0.0.1", port: 7881 });
    expect(parseBind("[::1]:0")).toEqual({ host: "::1", port: 0 });
    expect(() => parseBind("nope")).toThrow();
  });
});
