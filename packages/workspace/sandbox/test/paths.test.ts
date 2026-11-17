import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkName, normalizeRelativePath, SandboxError, safeJoin } from "../src/index.js";

function rejects(path: string): void {
  let error: unknown;
  try {
    normalizeRelativePath(path);
  } catch (e) {
    error = e;
  }
  expect(error, path).toBeInstanceOf(SandboxError);
  expect((error as SandboxError).kind, path).toBe("invalid_path");
}

describe("normalizeRelativePath", () => {
  it("accepts_plain_relative_paths", () => {
    expect(normalizeRelativePath("input.csv")).toBe("input.csv");
    expect(normalizeRelativePath("data/2026/a b.json")).toBe("data/2026/a b.json");
    expect(normalizeRelativePath(".hidden")).toBe(".hidden");
  });

  it("rejects_traversal_and_absolute_paths", () => {
    for (const path of [
      "",
      "..",
      "../x",
      "a/../../x",
      "a/..",
      "./a",
      "a/./b",
      "/etc/passwd",
      "//server/share",
      "a//b",
      "a/",
      "C:/Windows/x",
      "C:x",
      "..\\x",
      "a\\b",
      "file.txt:stream",
      "a\u0000b",
      "a\nb",
      "a<b",
      "a|b",
      "a?b",
      "a*b",
      'a"b',
    ]) {
      rejects(path);
    }
  });

  it("rejects_names_windows_would_alias", () => {
    for (const path of [
      "CON",
      "con.txt",
      "nul",
      "aux.json",
      "COM1",
      "lpt9.log",
      "a/prn",
      "x.",
      "x ",
      "a./b",
    ]) {
      rejects(path);
    }
  });

  it("rejects_deep_and_long_paths", () => {
    rejects(Array.from({ length: 9 }, () => "d").join("/"));
    rejects("x".repeat(101));
    rejects(`${"a/".repeat(100)}b`);
  });
});

describe("safeJoin", () => {
  it("stays_inside_the_base", () => {
    const base = resolve("/srv/sandbox/work");
    expect(safeJoin(base, "a/b.txt")).toBe(join(base, "a", "b.txt"));
    expect(() => safeJoin(base, "../work2/x")).toThrow(SandboxError);
    expect(() => safeJoin(base, "/etc/passwd")).toThrow(SandboxError);
  });
});

describe("checkName", () => {
  it("allows_simple_names_only", () => {
    expect(checkName("csv_stats")).toBe("csv_stats");
    expect(checkName("a-1")).toBe("a-1");
    for (const bad of ["", "A", "1abc", "a.b", "a/b", "../a", "a b", "x".repeat(49)]) {
      expect(() => checkName(bad), bad).toThrow(SandboxError);
    }
  });
});
