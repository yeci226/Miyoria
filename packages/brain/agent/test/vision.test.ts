// Image downloading with a fake `fetch` (no network). Which images a run looks at is the text
// runner's (`@miyoria/brain/selfhost` around.ts).

import type { Attachment } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  allowedUrl,
  defaultAgentConfig,
  type FetchLike,
  type ImageCandidate,
  ImageLoader,
  imageParts,
} from "../src/index.js";

const CDN = "https://cdn.discordapp.com/attachments/1/2";

function image(id: string, extra: Partial<Attachment> = {}): Attachment {
  return {
    url: `${CDN}/${id}.png?ex=abc&is=def`,
    filename: `${id}.png`,
    content_type: "image/png",
    id,
    size: 1000,
    description: null,
    ...extra,
  };
}

/** What the downloader checks the bytes against. */
const PNG_HEAD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const vision = () => defaultAgentConfig().vision;

/** A fake `fetch` serving `bytes` bytes per URL, counting calls. */
function server(
  bytes: number,
  options: { type?: string; status?: number; length?: number } = {},
): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fetch: async (url) => {
      calls.push(url);
      const headers = new Headers({ "content-type": options.type ?? "image/png" });
      if (options.length !== undefined) headers.set("content-length", String(options.length));
      const body = new Uint8Array(bytes).fill(7);
      body.set(PNG_HEAD.subarray(0, Math.min(bytes, PNG_HEAD.length)));
      return new Response(body, {
        status: options.status ?? 200,
        headers,
      });
    },
  };
}

it("allows HTTPS on the allowed hosts only", () => {
  expect(allowedUrl("https://media.discordapp.net/x", ["media.discordapp.net"])).toBe(true);
  expect(allowedUrl("http://media.discordapp.net/x", ["media.discordapp.net"])).toBe(false);
  expect(allowedUrl("not a url", ["x"])).toBe(false);
});

describe("image loader", () => {
  const signal = new AbortController().signal;
  const candidates = (ids: string[]): ImageCandidate[] =>
    ids.map((id) => ({
      attachment: image(id),
      author: "owen",
      source: "message",
      key: `id:${id}`,
      type: "image/png",
    }));

  it("downloads_as_data_urls_and_caches_by_attachment_id", async () => {
    const srv = server(8);
    const loader = new ImageLoader(srv.fetch);
    const [first] = await loader.load(candidates(["a"]), vision(), signal);
    expect(first?.dataUrl).toBe("data:image/png;base64,iVBORw0KGgo=");
    expect(first?.bytes).toBe(8);
    // A fresh signed URL of the same attachment hits the cache.
    await loader.load(candidates(["a"]), vision(), signal);
    expect(srv.calls).toHaveLength(1);
    expect(loader.cached).toBe(1);
    const parts = imageParts([first as NonNullable<typeof first>], "low");
    expect(parts).toEqual([
      { type: "text", text: "(owen 這則訊息附的圖片 a.png)" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo=", detail: "low" },
        alt: "[圖片: a.png]",
      },
    ]);
  });

  it("respects_the_total_and_per_image_limits_and_skips_failures", async () => {
    const cfg = { ...vision(), max_total_bytes: 250, max_image_bytes: 200 };
    const loader = new ImageLoader(server(100).fetch);
    expect((await loader.load(candidates(["a", "b", "c"]), cfg, signal)).length).toBe(2);
    const big = new ImageLoader(server(300).fetch);
    expect(await big.load(candidates(["x"]), cfg, signal)).toEqual([]);
    const declared = new ImageLoader(server(16, { length: 999 }).fetch);
    expect(await declared.load(candidates(["y"]), cfg, signal)).toEqual([]);
    const errors: string[] = [];
    const down = new ImageLoader(server(16, { status: 403 }).fetch, (_k, e) => errors.push(e));
    expect(await down.load(candidates(["z"]), cfg, signal)).toEqual([]);
    expect(errors).toEqual(["HTTP 403"]);
    // A page instead of an image is skipped; an untyped body keeps the attachment's type.
    const html = new ImageLoader(server(16, { type: "text/html" }).fetch);
    expect(await html.load(candidates(["h"]), cfg, signal)).toEqual([]);
    const untyped = new ImageLoader(server(16, { type: "application/octet-stream" }).fetch);
    expect((await untyped.load(candidates(["u"]), cfg, signal))[0]?.dataUrl).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("goes_by_the_bytes_not_by_the_name_or_the_server", async () => {
    const cfg = vision();
    // A link preview's type is a guess from its name: the bytes decide.
    const guessed = candidates(["g"]).map((c) => ({ ...c, type: "image/jpeg" }));
    const png = new ImageLoader(server(16, { type: "image/jpeg" }).fetch);
    expect((await png.load(guessed, cfg, signal))[0]?.dataUrl).toMatch(/^data:image\/png;base64,/);
    // Something that says "image" and is not one is dropped.
    const fake: FetchLike = async () =>
      new Response(new TextEncoder().encode("<html>login</html>"), {
        headers: { "content-type": "image/png" },
      });
    expect(await new ImageLoader(fake).load(candidates(["h"]), cfg, signal)).toEqual([]);
  });

  it("cache_is_bounded", async () => {
    const loader = new ImageLoader(server(8).fetch);
    const cfg = { ...vision(), cache_entries: 2 };
    for (const id of ["a", "b", "c"]) await loader.load(candidates([id]), cfg, signal);
    expect(loader.cached).toBe(2);
  });
});
