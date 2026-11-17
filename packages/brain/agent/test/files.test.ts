// Files people send her: who may, which ones, how they reach the model (as untrusted data, with
// a fake reader: no sandbox, no network).

import {
  type Attachment,
  type Authorizer,
  dataBlock,
  type FileOutcome,
  type FileReader,
  type FileRequest,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultAgentConfig, fileParts, selectFiles } from "../src/index.js";
import { channel, incoming, stopHarnesses } from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

const CDN = "https://cdn.discordapp.com/attachments/1/2";

function file(id: string, name = `${id}.txt`, extra: Partial<Attachment> = {}): Attachment {
  return {
    url: `${CDN}/${name}?ex=1`,
    filename: name,
    content_type: "text/plain",
    id,
    size: 100,
    description: null,
    ...extra,
  };
}

const allowAll: Authorizer = { allows: () => true, allowsSubject: () => true };
const allowOnly = (id: string, node = "tools.file"): Authorizer => ({
  allows: (account, n) => account.id === id && n === node,
  allowsSubject: (s, n) => s.account.id === id && n === node,
});

/** Reads `.txt` and `.md` (the injection test file is a `.md`). */
class FakeReader implements FileReader {
  readonly requests: FileRequest[] = [];
  constructor(
    readonly outcome: (r: FileRequest) => FileOutcome = (r) => ({
      status: "read",
      text: `intro\n${dataBlock("file", r.name, `content of ${r.name}`)}`,
      chars: 10,
      truncated: false,
    }),
  ) {}

  supports(name: string): boolean {
    return /\.(txt|md|pdf)$/i.test(name);
  }

  async read(request: FileRequest): Promise<FileOutcome> {
    this.requests.push(request);
    return this.outcome(request);
  }
}

const cfg = () => defaultAgentConfig().files;
const signal = () => new AbortController().signal;

describe("file selection", () => {
  it("picks_supported_non_image_files_of_allowed_people_and_each_once", () => {
    const reader = new FakeReader();
    const m = {
      ...incoming(channel("c"), "owen", "看"),
      attachments: [
        file("a"),
        file("a"), // the same attachment twice
        file("img", "cat.png", { content_type: "image/png" }),
        file("exe", "run.exe", { content_type: "application/octet-stream" }),
        file("b"),
        file("c"),
      ],
    };
    const picked = selectFiles([m], reader, allowAll, cfg());
    // Images go to vision, unknown types are not offered, and at most `max_files` per turn.
    expect(picked.map((p) => p.attachment.id)).toEqual(["a", "b"]);
  });

  it("skips_people_without_the_node_bots_and_forwarded_files_follow_the_forwarder", () => {
    const reader = new FakeReader();
    const owen = { ...incoming(channel("c"), "owen", "看"), attachments: [file("a")] };
    const bot = {
      ...incoming(channel("c"), "bot", "看"),
      author: { ...incoming(channel("c"), "bot", "").author, is_bot: true },
      attachments: [file("b")],
    };
    const fwd = {
      ...incoming(channel("c"), "mini", "轉"),
      forwarded: [{ text: "", attachments: [file("f")], stickers: [], embeds: [] }],
    };
    expect(
      selectFiles([owen, bot, fwd], reader, allowOnly("mini"), cfg()).map((p) => p.attachment.id),
    ).toEqual(["f"]);
    expect(selectFiles([owen], reader, allowOnly("amy"), cfg())).toEqual([]);
    expect(selectFiles([owen], reader, undefined, cfg())).toEqual([]);
    expect(selectFiles([owen], reader, allowAll, { ...cfg(), enabled: false })).toEqual([]);
    expect(selectFiles([owen], reader, allowAll, { ...cfg(), max_files: 0 })).toEqual([]);
  });
});

describe("file parts", () => {
  it("labels_each_file_with_who_sent_it_and_gives_its_block", async () => {
    const reader = new FakeReader();
    const m = { ...incoming(channel("c"), "owen", "看"), attachments: [file("a", "notes.txt")] };
    const parts = await fileParts(selectFiles([m], reader, allowAll, cfg()), reader, signal());
    expect(parts).toHaveLength(1);
    expect(parts[0]).toMatchObject({ type: "text" });
    const text = (parts[0] as { text: string }).text;
    expect(text).toContain("owen 傳的檔案 notes.txt");
    expect(text).toContain("content of notes.txt");
    expect(reader.requests[0]).toMatchObject({
      who: "test:owen",
      name: "notes.txt",
      id: "a",
      size: 100,
    });
  });

  it("tells_her_why_a_file_was_not_read_and_survives_a_failing_reader", async () => {
    const m = { ...incoming(channel("c"), "owen", "看"), attachments: [file("a"), file("b")] };
    const declining = new FakeReader((r) =>
      r.id === "a"
        ? { status: "declined", code: "sandbox", reason: "我現在沒辦法安全地打開檔案" }
        : { status: "declined", code: "too_big", reason: "檔案太大了" },
    );
    const parts = await fileParts(
      selectFiles([m], declining, allowAll, cfg()),
      declining,
      signal(),
    );
    expect(parts.map((p) => (p as { text: string }).text)).toEqual([
      "(owen 傳了檔案 a.txt,我沒有讀它:我現在沒辦法安全地打開檔案)",
      "(owen 傳了檔案 b.txt,我沒有讀它:檔案太大了)",
    ]);
    const errors: string[] = [];
    const broken = new FakeReader(() => {
      throw new Error("boom");
    });
    const after = await fileParts(
      selectFiles([m], broken, allowAll, cfg()),
      broken,
      signal(),
      (_n, e) => errors.push(e),
    );
    expect(after).toHaveLength(2);
    expect((after[0] as { text: string }).text).toContain("我沒有讀它");
    expect(errors).toEqual(["boom", "boom"]);
  });
});
