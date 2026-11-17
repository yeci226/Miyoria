import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PersistentWorkspace, SandboxError } from "../src/index.js";

let base: string;
let dir: string;
/** A directory the workspace must never touch (stands for the host's secrets). */
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "miyoria-workspace-"));
  dir = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "host secret");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function ws(limits: Partial<ConstructorParameters<typeof PersistentWorkspace>[1]> = {}) {
  return new PersistentWorkspace(dir, {
    maxBytes: 1000,
    maxFiles: 5,
    maxFileBytes: 400,
    ...limits,
  });
}

async function kind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    return (error as SandboxError).kind;
  }
  return "no error";
}

/** A directory link (a junction on Windows, which needs no privilege). */
function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

describe("PersistentWorkspace files", () => {
  it("writes_reads_lists_and_removes_files_that_survive_a_new_instance", async () => {
    const a = ws();
    await a.write("notes/todo.md", "買牛奶");
    await a.write("scripts/hello.py", "print('hi')");
    // A new instance on the same directory (a new sandbox session) sees them.
    const b = ws();
    expect((await b.read("notes/todo.md")).text).toBe("買牛奶");
    const { entries } = await b.list();
    expect(entries.map((e) => e.path)).toEqual(["notes/todo.md", "scripts/hello.py"]);
    expect((await b.list("notes")).entries.map((e) => e.path)).toEqual(["notes/todo.md"]);
    expect(await b.remove("notes")).toBe(true);
    expect(await b.remove("notes")).toBe(false);
    expect((await b.list()).entries.map((e) => e.path)).toEqual(["scripts/hello.py"]);
  });

  it("appends_and_replaces", async () => {
    const w = ws();
    await w.write("a.txt", "one");
    await w.write("a.txt", "+two", { append: true });
    expect((await w.read("a.txt")).text).toBe("one+two");
    await w.write("a.txt", "new");
    expect((await w.read("a.txt")).text).toBe("new");
    expect((await w.usage()).files).toBe(1);
  });

  it("reads_in_slices_by_character", async () => {
    const w = ws();
    await w.write("long.txt", "你好世界".repeat(10));
    const first = await w.read("long.txt", { maxChars: 10 });
    expect(first.text).toHaveLength(10);
    expect(first.next_offset).toBe(10);
    const rest = await w.read("long.txt", { offset: 10, maxChars: 100 });
    expect(rest.text).toHaveLength(30);
    expect(rest.next_offset).toBeNull();
  });

  it("refuses_binary_and_missing_files", async () => {
    const w = ws();
    await w.ensure();
    await writeFile(join(dir, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0xc3]));
    expect(await kind(w.read("bin.dat"))).toBe("invalid_request");
    expect(await kind(w.read("nope.txt"))).toBe("not_found");
  });
});

describe("PersistentWorkspace quotas", () => {
  it("refuses_a_file_over_the_per_file_quota", async () => {
    const w = ws();
    expect(await kind(w.write("big.txt", "x".repeat(401)))).toBe("limit");
    await w.write("ok.txt", "x".repeat(400));
  });

  it("refuses_the_file_that_would_pass_the_file_count", async () => {
    const w = ws();
    for (let i = 0; i < 5; i++) await w.write(`f${i}.txt`, "x");
    expect(await kind(w.write("f5.txt", "x"))).toBe("limit");
    // Replacing an existing one is not a new file.
    await w.write("f0.txt", "yy");
  });

  it("refuses_the_write_that_would_pass_the_total_size_and_counts_a_replacement_once", async () => {
    const w = ws({ maxBytes: 600 });
    await w.write("a.txt", "x".repeat(300));
    await w.write("b.txt", "x".repeat(300));
    expect(await kind(w.write("c.txt", "x"))).toBe("limit");
    // Growing a by 1 byte pushes the total over, shrinking it does not.
    expect(await kind(w.write("a.txt", "x".repeat(301)))).toBe("limit");
    await w.write("a.txt", "x".repeat(100));
    await w.write("c.txt", "x".repeat(100));
    expect((await w.usage()).bytes).toBe(500);
  });
});

describe("PersistentWorkspace paths", () => {
  it("refuses_paths_that_leave_the_workspace_or_are_not_portable", async () => {
    const w = ws();
    const bad = [
      "../outside/secret.txt",
      "a/../../outside/secret.txt",
      "/etc/passwd",
      "C:/Windows/win.ini",
      "..\\outside\\secret.txt",
      "a//b",
      "./a",
      "",
      "con.txt",
      "a/b/c/d/e/f/g/h/i.txt",
      "name.",
      "a\u0000b",
    ];
    for (const path of bad) {
      expect(await kind(w.write(path, "x")), `write ${path}`).toBe("invalid_path");
      expect(await kind(w.read(path)), `read ${path}`).toBe("invalid_path");
      expect(await kind(w.remove(path)), `remove ${path}`).toBe("invalid_path");
    }
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("host secret");
  });

  it("does_not_follow_a_directory_link_for_read_write_list_or_remove", async () => {
    const w = ws();
    await w.ensure();
    try {
      linkDir(outside, join(dir, "escape"));
    } catch {
      return; // the platform cannot make links here
    }
    expect(await kind(w.read("escape/secret.txt"))).toBe("invalid_path");
    expect(await kind(w.write("escape/new.txt", "x"))).toBe("invalid_path");
    expect(await kind(w.write("escape/secret.txt", "overwritten"))).toBe("invalid_path");
    expect(await kind(w.remove("escape/secret.txt"))).toBe("invalid_path");
    expect(await kind(w.list("escape"))).toBe("invalid_path");
    expect(await kind(w.remove("escape"))).toBe("invalid_path");
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("host secret");
    expect((await lstat(join(outside, "secret.txt"))).isFile()).toBe(true);
    // The link is invisible to a listing too.
    expect((await w.list()).entries).toEqual([]);
  });

  it("does_not_follow_a_file_link_and_replaces_it_instead_of_writing_through", async () => {
    const w = ws();
    await w.ensure();
    try {
      symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"), "file");
    } catch {
      return; // needs developer mode or a privilege on Windows
    }
    expect(await kind(w.read("link.txt"))).toBe("invalid_path");
    await expect(w.write("link.txt", "mine")).rejects.toBeInstanceOf(SandboxError);
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("host secret");
  });
});

describe("approved scripts", () => {
  const ledger = () => join(base, "ledger.json");

  it("runs_only_the_text_that_was_saved_through_save_script", async () => {
    const w = new PersistentWorkspace(
      dir,
      { maxBytes: 1000, maxFiles: 5, maxFileBytes: 400 },
      ledger(),
    );
    await w.saveScript("scripts/a.py", "print(1)");
    expect(await w.approvedScript("scripts/a.py")).toEqual({
      language: "python",
      text: "print(1)",
    });
    // Saved by a plain write (what a program in the container can do): never approved.
    await w.write("scripts/b.py", "print(2)");
    expect(await w.approvedScript("scripts/b.py")).toBeNull();
    // Changed after the approval (a program rewrote it): not approved any more.
    await writeFile(join(dir, "scripts", "a.py"), "import os; os.system('x')");
    expect(await w.approvedScript("scripts/a.py")).toBeNull();
    // Saving again approves the new text.
    await w.saveScript("scripts/a.py", "print(3)");
    expect((await w.approvedScript("scripts/a.py"))?.text).toBe("print(3)");
  });

  it("keeps_approvals_in_a_file_outside_the_workspace_that_survives_a_new_instance", async () => {
    const limits = { maxBytes: 1000, maxFiles: 5, maxFileBytes: 400 };
    await new PersistentWorkspace(dir, limits, ledger()).saveScript("a.mjs", "console.log(1)");
    const again = new PersistentWorkspace(dir, limits, ledger());
    expect((await again.approvedScript("a.mjs"))?.language).toBe("node");
    // A program cannot approve its own script by writing into the workspace: the ledger is not there.
    expect((await again.list()).entries.map((e) => e.path)).toEqual(["a.mjs"]);
    expect(readFileSync(ledger(), "utf8")).toContain("a.mjs");
  });

  it("refuses_other_extensions_bad_paths_and_a_planted_link", async () => {
    const w = ws();
    expect(await kind(w.saveScript("notes.md", "x"))).toBe("invalid_request");
    expect(await kind(w.saveScript("../a.py", "x"))).toBe("invalid_path");
    expect(await w.approvedScript("../a.py")).toBeNull();
    expect(await w.approvedScript("missing.py")).toBeNull();
    await w.saveScript("a.py", "print(1)");
    await w.ensure();
    try {
      linkDir(outside, join(dir, "escape"));
      expect(await w.approvedScript("escape/secret.py")).toBeNull();
    } catch {
      // no links here
    }
  });
});

describe("PersistentWorkspace.enforce", () => {
  it("removes_links_and_files_over_the_per_file_quota_but_keeps_the_rest", async () => {
    const w = ws();
    await w.write("keep.txt", "ok");
    let linked = false;
    try {
      linkDir(outside, join(dir, "planted"));
      linked = true;
    } catch {
      // no links here
    }
    // A program can write bigger files than the tools allow (its own `fsize` is larger).
    await writeFile(join(dir, "huge.bin"), Buffer.alloc(500));
    const removed = await w.enforce(await w.snapshot());
    expect(removed.map((r) => r.reason)).toContain("file_too_large");
    if (linked) expect(removed.map((r) => r.reason)).toContain("link");
    expect((await w.read("keep.txt")).text).toBe("ok");
    expect(readFileSync(join(outside, "secret.txt"), "utf8")).toBe("host secret");
    await expect(lstat(join(dir, "huge.bin"))).rejects.toThrow();
  });

  it("trims_what_a_run_added_when_the_total_or_the_count_is_over_and_keeps_older_files", async () => {
    const w = ws({ maxFiles: 3, maxBytes: 250 });
    await w.write("old1.txt", "x".repeat(100));
    await w.write("old2.txt", "x".repeat(100));
    const before = await w.snapshot();
    // The "run" adds three files; together with the old ones that is over both quotas.
    for (const name of ["new1", "new2", "new3"]) {
      await writeFile(join(dir, `${name}.txt`), "y".repeat(100));
      await new Promise((r) => setTimeout(r, 5));
    }
    const removed = await w.enforce(before);
    expect(removed.every((r) => r.reason === "over_quota")).toBe(true);
    const usage = await w.usage();
    expect(usage.files).toBeLessThanOrEqual(3);
    expect(usage.bytes).toBeLessThanOrEqual(250);
    const left = (await w.list()).entries.map((e) => e.path);
    expect(left).toContain("old1.txt");
    expect(left).toContain("old2.txt");
  });

  it("removes_trees_deeper_than_a_path_may_be", async () => {
    const w = ws();
    await w.ensure();
    const deep = join(dir, "a", "b", "c", "d", "e", "f", "g", "h", "i");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "x.txt"), "x");
    const removed = await w.enforce();
    expect(removed.map((r) => r.reason)).toContain("too_deep");
    expect(
      await readFile(join(dir, "a", "b", "c", "d", "e", "f", "g", "x.txt")).catch(() => null),
    ).toBeNull();
  });

  it("reports_overflow_when_there_are_far_too_many_entries", async () => {
    const w = ws({ maxFiles: 2 });
    await w.ensure();
    for (let i = 0; i < 120; i++) writeFileSync(join(dir, `f${i}.txt`), "x");
    expect((await w.usage()).overflow).toBe(true);
    expect(await kind(w.write("new.txt", "x"))).toBe("limit");
  });
});
