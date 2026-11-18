// `[[install.files]]`: the descriptor rules, the downloader against a local server (resume, checksum,
// redirects, the host list, free space), the remembered hashes, and hostd refusing to start a
// service whose files are missing. Nothing is downloaded from the internet.

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bytesToFetch,
  checkPlan,
  checkServiceFiles,
  DownloadError,
  downloadFile,
  fileDestIn,
  type InstallDeps,
  inspectService,
  installService,
  loadCatalog,
  loadHostConfig,
  planServices,
  presentFileHashes,
  type ResolveContext,
  verifiedCacheFile,
} from "../src/index.js";
import { type Fixture, startFixture } from "./download-fixture.js";
import { TMP } from "./fakes.js";

let root: string;
let fixture: Fixture;

beforeEach(async () => {
  mkdirSync(TMP, { recursive: true });
  root = mkdtempSync(join(TMP, "files-"));
  fixture = await startFixture();
});
afterEach(async () => {
  await fixture.close();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

function write(path: string, text: string | Buffer): string {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, text);
  return full;
}

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const DATA = Buffer.from("0123456789abcdef".repeat(4096)); // 64 KiB
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const URL_ = `https://huggingface.co/org/repo/resolve/${COMMIT}/model.onnx`;

type Fields = Record<string, string | number | boolean | undefined>;

/** One `[[install.files]]` table; `undefined` leaves a key out. */
function fileTable(over: Fields = {}): string {
  const fields: Fields = {
    path: "smart/model.onnx",
    url: URL_,
    sha256: sha(DATA),
    size: DATA.length,
    what: "一個模型",
    licence: "MIT",
    ...over,
  };
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k} = ${typeof v === "string" ? JSON.stringify(v) : String(v)}`);
  return `[[install.files]]\n${lines.join("\n")}\n`;
}

function service(files: string, name = "f"): string {
  return `name = "${name}"\nkind = "worker"\n[install]\nruntime = "none"\n${files}[run]\ncommand = ["x"]\n`;
}

function workspace(files: string = fileTable()) {
  write("workers/f/service.toml", service(files));
  write("host.toml", 'name = "h"\n[services.f]\n');
  const host = loadHostConfig(join(root, "host.toml"));
  const catalog = loadCatalog(root);
  const entry = catalog.services.get("f");
  return { host, catalog, entry };
}

function deps(over: Partial<InstallDeps> = {}): InstallDeps {
  return {
    root,
    platform: "linux",
    env: { PATH: "" },
    fetchImpl: fixture.fetch,
    freeBytes: () => 100 * 1024 ** 3,
    downloadTimings: { retryDelaysMs: [0, 0, 0], idleTimeoutMs: 5_000 },
    ...over,
  };
}

async function install(over: Partial<InstallDeps> = {}, noFiles = false) {
  const { host, entry } = workspace();
  if (entry === undefined) throw new Error("no service f");
  const result = await installService(entry, host, deps(over), { noFiles });
  return { host, entry, result, dest: join(host.state.models, "smart", "model.onnx") };
}

// ---- the descriptor ----------------------------------------------------------------------------

describe("[[install.files]] in service.toml", () => {
  const problems = (files: string) => {
    write("workers/f/service.toml", service(files));
    return loadCatalog(root)
      .problems.map((p) => p.message)
      .join("\n");
  };

  it("accepts a URL or a Hugging Face file at a commit, and reads the fields", () => {
    const hf = fileTable({
      url: undefined,
      hf: "org/repo",
      file: "sub/model.onnx",
      revision: COMMIT,
      sha256: sha(DATA).toUpperCase(),
      optional: true,
      path: "other/model.onnx",
    });
    write("workers/f/service.toml", service(fileTable() + hf));
    const catalog = loadCatalog(root);
    expect(catalog.problems).toEqual([]);
    const files = catalog.services.get("f")?.descriptor.install.files ?? [];
    expect(files[0]).toMatchObject({ url: URL_, optional: false, size: DATA.length });
    expect(files[1]).toMatchObject({ hf: "org/repo", sha256: sha(DATA), optional: true });
  });

  it("rejects unknown keys and missing checksums or sizes", () => {
    expect(problems(fileTable({ checksum: "x" }))).toMatch(/checksum/);
    expect(problems(fileTable({ sha256: undefined }))).toMatch(/install\.files\.0\.sha256/);
    expect(problems(fileTable({ sha256: "abc" }))).toMatch(/64 hex/);
    expect(problems(fileTable({ size: undefined }))).toMatch(/install\.files\.0\.size/);
    expect(problems(fileTable({ licence: undefined }))).toMatch(/licence/);
  });

  it("refuses a moving revision, http, a host off the list and a github.com page", () => {
    const hf = (revision: string) =>
      fileTable({ url: undefined, hf: "org/repo", file: "m.onnx", revision });
    expect(problems(hf("main"))).toMatch(/"main" is not a commit/);
    expect(problems(hf("v1.0"))).toMatch(/not a commit/);
    expect(problems(fileTable({ url: undefined, hf: "org/repo", file: "m.onnx" }))).toMatch(
      /needs revision/,
    );
    expect(problems(fileTable({ url: "http://huggingface.co/x/m.onnx" }))).toMatch(/https/);
    // An extension cannot add a host of its own.
    expect(problems(fileTable({ url: "https://models.example.com/m.onnx" }))).toMatch(
      /models\.example\.com is not on the list/,
    );
    expect(problems(fileTable({ url: "https://github.com/o/r/blob/main/m.onnx" }))).toMatch(
      /release asset/,
    );
    expect(problems(fileTable({ url: "https://github.com/o/r/releases/download/v1/m.onnx" }))).toBe(
      "",
    );
    expect(problems(fileTable({ hf: "org/repo", file: "m", revision: COMMIT }))).toMatch(
      /not both/,
    );
  });

  it("keeps every path inside the model folder", () => {
    for (const path of ["../outside.bin", "/abs/m.bin", "C:/m.bin", "a\\b.bin", "a//b", "hf/x"]) {
      expect(problems(fileTable({ path }))).toMatch(/path/);
    }
    expect(problems(fileTable() + fileTable())).toMatch(/listed twice/);
    const models = join(root, "models");
    expect(() => fileDestIn(models, "../x")).toThrow();
    expect(() => fileDestIn(models, "/etc/x")).toThrow();
    expect(fileDestIn(models, "a/b.bin")).toBe(join(models, "a", "b.bin"));
  });
});

// ---- downloading -------------------------------------------------------------------------------

describe("downloading install.files", () => {
  it("downloads into <state>/models/<path>, verifies it, and remembers the hash", async () => {
    fixture.route(URL_, { body: DATA });
    const { host, entry, result, dest } = await install();
    expect(result.files).toEqual([{ path: "smart/model.onnx", state: "downloaded" }]);
    expect(result.ok).toBe(true);
    expect(readFileSync(dest)).toEqual(DATA);
    expect(existsSync(`${dest}.part`)).toBe(false);
    const cache = JSON.parse(readFileSync(verifiedCacheFile(host.state.root), "utf8"));
    expect(cache.files["smart/model.onnx"].sha256).toBe(sha(DATA));

    // A second run finds it verified and does not ask the server again.
    const again = await installService(entry, host, deps());
    expect(again.files).toEqual([{ path: "smart/model.onnx", state: "present" }]);
    expect(fixture.hits).toHaveLength(1);
  });

  it("follows a redirect to the CDN, each hop checked", async () => {
    const cdn = "https://cdn-lfs.huggingface.co/blob/abc";
    fixture.route(URL_, { location: cdn });
    fixture.route(cdn, { body: DATA });
    const { result, dest } = await install();
    expect(result.files[0]?.state).toBe("downloaded");
    expect(readFileSync(dest)).toEqual(DATA);
    expect(fixture.hits.map((h) => h.host)).toEqual(["huggingface.co", "cdn-lfs.huggingface.co"]);
  });

  it("refuses a redirect to a host that is not on the list", async () => {
    fixture.route(URL_, { location: "https://evil.example/model.onnx" });
    fixture.route("https://evil.example/model.onnx", { body: DATA });
    const { result, dest } = await install();
    expect(result.ok).toBe(false);
    expect(result.files[0]?.detail).toMatch(/evil\.example 不在允許下載的主機清單上/);
    expect(fixture.hits.map((h) => h.host)).toEqual(["huggingface.co"]);
    expect(existsSync(dest)).toBe(false);
  });

  it("stops after a bounded number of redirects", async () => {
    fixture.route(URL_, { location: URL_ });
    const { result } = await install();
    expect(result.files[0]?.detail).toMatch(/轉址超過 5 次/);
    expect(fixture.hits).toHaveLength(6);
  });

  it("resumes an interrupted transfer with a Range request", async () => {
    fixture.route(URL_, { body: DATA, cut: 1 });
    const lines: string[] = [];
    const { host, entry } = workspace();
    if (entry === undefined) throw new Error("no f");
    const result = await installService(entry, host, deps(), { onLine: (l) => lines.push(l) });
    expect(result.files[0]?.state).toBe("downloaded");
    const dest = join(host.state.models, "smart", "model.onnx");
    expect(readFileSync(dest)).toEqual(DATA);
    expect(fixture.hits[0]?.range).toBe("full");
    expect(fixture.hits[1]?.range).toMatch(/^bytes=\d+-$/);
    expect(Number(/\d+/.exec(fixture.hits[1]?.range ?? "")?.[0])).toBeGreaterThan(0);
    expect(lines.some((l) => l.includes("重試"))).toBe(true);
    expect(lines[0]).toContain("授權 MIT");
  });

  it("continues a .part left by an earlier run, and starts over when the server ignores Range", async () => {
    fixture.route(URL_, { body: DATA });
    const { host, entry } = workspace();
    if (entry === undefined) throw new Error("no f");
    const dest = join(host.state.models, "smart", "model.onnx");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(`${dest}.part`, DATA.subarray(0, 1000));
    await installService(entry, host, deps());
    expect(fixture.hits.map((h) => h.range)).toEqual(["bytes=1000-"]);
    expect(readFileSync(dest)).toEqual(DATA);

    rmSync(dest);
    fixture.hits.length = 0;
    fixture.route(URL_, { body: DATA, ignoreRange: true });
    writeFileSync(`${dest}.part`, Buffer.from("garbage"));
    await installService(entry, host, deps());
    expect(readFileSync(dest)).toEqual(DATA);
  });

  it("does not keep a file whose checksum does not match, and does not retry it", async () => {
    fixture.route(URL_, { body: Buffer.from(DATA).fill(0x41, 0, 1) });
    const { result, dest } = await install();
    expect(result.ok).toBe(false);
    expect(result.files[0]?.state).toBe("failed");
    expect(result.files[0]?.detail).toMatch(/SHA-256 是 .*下載的檔案已刪除/);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(fixture.hits).toHaveLength(1);
  });

  it("retries a 503 and gives up on a 404", async () => {
    fixture.route(URL_, { body: DATA, unavailable: 2 });
    expect((await install()).result.files[0]?.state).toBe("downloaded");
    expect(fixture.hits).toHaveLength(3);

    rmSync(root, { recursive: true, force: true });
    mkdirSync(root, { recursive: true });
    fixture.hits.length = 0;
    fixture.route(URL_, { status: 404 });
    const missing = await install();
    expect(missing.result.files[0]?.detail).toMatch(/HTTP 404/);
    expect(fixture.hits).toHaveLength(1);
  });

  it("refuses to start when the drive lacks the size plus a margin, with the numbers", async () => {
    fixture.route(URL_, { body: DATA });
    const { result } = await install({ freeBytes: () => 10 * 1024 * 1024 });
    expect(result.ok).toBe(false);
    expect(result.files[0]?.detail).toMatch(
      /磁碟空間不夠:要下載 64\.0 KB,另外要留 512\.0 MB 的餘裕/,
    );
    expect(result.files[0]?.detail).toMatch(/只剩 10\.0 MB/);
    expect(fixture.hits).toHaveLength(0);
  });

  it("replaces a wrong file, and without downloads reports it missing and leaves it", async () => {
    fixture.route(URL_, { body: DATA });
    const { host, entry } = workspace();
    if (entry === undefined) throw new Error("no f");
    const dest = join(host.state.models, "smart", "model.onnx");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, DATA.subarray(1));

    const skipped = await installService(entry, host, deps(), { noFiles: true });
    expect(skipped.ok).toBe(true);
    expect(skipped.files[0]).toMatchObject({
      path: "smart/model.onnx",
      state: "missing",
      detail: expect.stringMatching(/大小是/),
    });
    expect(fixture.hits).toHaveLength(0);

    // The right size but other bytes: the download path hashes it and replaces it.
    writeFileSync(dest, Buffer.alloc(DATA.length, 1));
    const fixed = await installService(entry, host, deps());
    expect(fixed.files[0]?.state).toBe("downloaded");
    expect(readFileSync(dest)).toEqual(DATA);
  });

  it("only speaks https to hosts on the list", async () => {
    const dest = join(root, "m.bin");
    await expect(
      downloadFile("http://huggingface.co/x", dest, {
        sha256: sha(DATA),
        fetchImpl: fixture.fetch,
      }),
    ).rejects.toThrow(/不是 https/);
    await expect(
      downloadFile("https://example.org/x", dest, { sha256: sha(DATA), fetchImpl: fixture.fetch }),
    ).rejects.toBeInstanceOf(DownloadError);
    expect(fixture.hits).toHaveLength(0);
  });
});

// ---- adopting what the machine already has -----------------------------------------------------

describe("adopt_from: a file kept where it used to be", () => {
  const OLD = "workers/models/old/model.onnx";

  function setup(old: Buffer | null) {
    const made = workspace(fileTable({ adopt_from: OLD }));
    if (old !== null) write(OLD, old);
    if (made.entry === undefined) throw new Error("no service f");
    return {
      ...made,
      entry: made.entry,
      dest: join(made.host.state.models, "smart", "model.onnx"),
    };
  }

  it("reads adopt_from, and keeps it inside the workspace", () => {
    const problems = (files: string) => {
      write("workers/f/service.toml", service(files));
      return loadCatalog(root)
        .problems.map((p) => p.message)
        .join("\n");
    };
    expect(problems(fileTable({ adopt_from: OLD }))).toBe("");
    expect(loadCatalog(root).services.get("f")?.descriptor.install.files[0]?.adopt_from).toBe(OLD);
    for (const adopt_from of ["../x.bin", "/abs/x.bin", "C:/x.bin", "a\\b"]) {
      expect(problems(fileTable({ adopt_from }))).toMatch(/adopt_from/);
    }
  });

  it("links the old file in when its checksum matches, and downloads nothing", async () => {
    fixture.route(URL_, { body: DATA });
    const { host, entry, dest } = setup(DATA);
    const needs = await checkServiceFiles(entry, host, "cached");
    expect(needs[0]).toMatchObject({ state: "missing", adopt: join(root, OLD) });

    const lines: string[] = [];
    const result = await installService(entry, host, deps(), { onLine: (l) => lines.push(l) });
    expect(result.ok).toBe(true);
    expect(result.files).toEqual([
      { path: "smart/model.onnx", state: "present", detail: "沿用舊位置的檔案(硬連結)" },
    ]);
    expect(fixture.hits).toHaveLength(0);
    expect(readFileSync(dest)).toEqual(DATA);
    // A link: the same file, so the disk holds it once; the old one is where it was.
    expect(statSync(dest).ino).toBe(statSync(join(root, OLD)).ino);
    expect(readFileSync(join(root, OLD))).toEqual(DATA);
    expect(existsSync(`${dest}.adopt`)).toBe(false);
    expect(lines.some((l) => l.includes("沿用"))).toBe(true);

    // The next check finds it in place and verified.
    const again = await checkServiceFiles(entry, host, "cached");
    expect(again[0]).toMatchObject({ state: "verified", adopt: null });
  });

  it("counts an adopted file as nothing to download", async () => {
    const { host, entry } = setup(DATA);
    const [status] = await checkServiceFiles(entry, host, "cached");
    expect(status && bytesToFetch([status])).toBe(0);
  });

  it("downloads when the old file has other bytes or another size", async () => {
    for (const old of [Buffer.alloc(DATA.length, 7), DATA.subarray(1)]) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      fixture.hits.length = 0;
      fixture.route(URL_, { body: DATA });
      const { host, entry, dest } = setup(old);
      expect((await checkServiceFiles(entry, host, "cached"))[0]?.adopt).toBeNull();
      const result = await installService(entry, host, deps());
      expect(result.files[0]?.state).toBe("downloaded");
      expect(fixture.hits).toHaveLength(1);
      expect(readFileSync(dest)).toEqual(DATA);
      // What was there is never touched.
      expect(readFileSync(join(root, OLD))).toEqual(old);
    }
  });

  it("downloads when there is no old file, and never adopts without being asked to download", async () => {
    fixture.route(URL_, { body: DATA });
    const none = setup(null);
    expect((await checkServiceFiles(none.entry, none.host, "cached"))[0]?.adopt).toBeNull();

    write(OLD, DATA);
    const skipped = await installService(none.entry, none.host, deps(), { noFiles: true });
    expect(skipped.files[0]?.state).toBe("missing");
    expect(existsSync(none.dest)).toBe(false);
  });

  it("replaces a wrong file at the new place by the old one that is right", async () => {
    const { host, entry, dest } = setup(DATA);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, DATA.subarray(1));
    const result = await installService(entry, host, deps());
    expect(result.files[0]?.state).toBe("present");
    expect(readFileSync(dest)).toEqual(DATA);
    expect(fixture.hits).toHaveLength(0);
  });
});

// ---- the remembered hashes ---------------------------------------------------------------------

describe("checking install.files", () => {
  it("hashes a file once and trusts its size and time after that; --deep hashes again", async () => {
    const { host, entry } = workspace();
    if (entry === undefined) throw new Error("no f");
    expect(inspectService(entry, host, deps()).files[0]?.state).toBe("missing");
    const dest = join(host.state.models, "smart", "model.onnx");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, DATA);
    const when = 1_700_000_000; // whole seconds, so setting it again gives the same time
    utimesSync(dest, when, when);
    expect(inspectService(entry, host, deps()).files[0]?.state).toBe("present");
    expect((await checkServiceFiles(entry, host, "cached"))[0]?.state).toBe("verified");
    expect(inspectService(entry, host, deps()).files[0]?.state).toBe("verified");

    // The same size and time but other bytes: only a deep check reads it again.
    writeFileSync(dest, Buffer.alloc(DATA.length, 7));
    utimesSync(dest, when, when);
    expect((await checkServiceFiles(entry, host, "cached"))[0]?.state).toBe("verified");
    const deep = await checkServiceFiles(entry, host, "deep");
    expect(deep[0]?.state).toBe("wrong");
    expect(deep[0]?.detail).toMatch(/SHA-256/);
    // The deep result is remembered too.
    expect((await checkServiceFiles(entry, host, "cached"))[0]?.state).toBe("wrong");

    // A new time makes the cached check read it.
    writeFileSync(dest, DATA);
    utimesSync(dest, when + 60, when + 60);
    expect((await checkServiceFiles(entry, host, "cached"))[0]?.state).toBe("verified");

    writeFileSync(dest, DATA.subarray(1));
    expect((await checkServiceFiles(entry, host, "cached"))[0]).toMatchObject({
      state: "wrong",
      detail: expect.stringMatching(/大小是/),
    });
  });

  it("prints the hashes of the files and manual items present, folder by folder", async () => {
    write(
      "workers/f/service.toml",
      service(
        `${fileTable()}[[install.manual]]\npath = "workers/models/split"\nwhat = "x"\n[[install.manual]]\npath = "workers/models/code"\nwhat = "y"\n[[install.manual]]\npath = "{models}/turn/t.onnx"\nwhat = "z"\n`,
      ),
    );
    write("host.toml", 'name = "h"\n[services.f]\n');
    const host = loadHostConfig(join(root, "host.toml"));
    const entry = loadCatalog(root).services.get("f");
    if (entry === undefined) throw new Error("no f");
    write("workers/models/split/A.ckpt", DATA);
    write("workers/models/split/A.yaml", "dim: 1\n");
    write("workers/models/code/.git/HEAD", "ref\n");
    write("workers/models/code/x.py", "print(1)\n");
    write("data/host/models/turn/t.onnx", DATA);

    const { files, skipped } = await presentFileHashes(entry, host, root);
    expect(files.map((f) => [f.path, f.size])).toEqual([
      ["split/A.ckpt", DATA.length],
      ["split/A.yaml", 7],
      ["turn/t.onnx", DATA.length],
    ]);
    expect(files[0]?.sha256).toBe(sha(DATA));
    expect(skipped.map((s) => s.why)).toEqual(["不在這台", expect.stringMatching(/\.git/)]);
  });
});

// ---- starting --------------------------------------------------------------------------------

describe("starting a service without its files", () => {
  function ctx(state: string): ResolveContext {
    return {
      workspace: root,
      state,
      bind: "127.0.0.1",
      configPath: join(root, "miyoria.toml"),
      miyoria: [],
      node: process.execPath,
      env: {},
      platform: process.platform,
    };
  }

  it("is disabled with the missing file named; an optional file does not stop it", () => {
    const optional = fileTable({ path: "opt/o.bin", optional: true });
    const { host, catalog } = workspace(fileTable() + optional);
    const c = ctx(host.state.root);
    const [plan] = planServices(catalog, host, c);
    expect(plan?.disabled).toMatch(/缺少必要的檔案:smart\/model\.onnx/);
    expect(plan?.disabled).not.toMatch(/opt\/o\.bin/);
    expect(plan?.disabled).toContain("miyoria add f");

    const dest = join(host.state.models, "smart", "model.onnx");
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, DATA.subarray(10));
    if (plan === undefined) throw new Error("no plan");
    expect(checkPlan(plan, c)).toMatch(/smart\/model\.onnx/);
    writeFileSync(dest, DATA);
    expect(checkPlan(plan, c)).toBeNull();
  });
});
