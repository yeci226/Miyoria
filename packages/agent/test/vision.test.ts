// Image selection and downloading with a fake `fetch` (no network).

import type { Attachment, IncomingMessage } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  allowedUrl,
  defaultAgentConfig,
  type FetchLike,
  ImageLoader,
  imageParts,
  Session,
  selectImages,
} from "../src/index.js";
import { tctx, tmsg } from "./fixtures.js";

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

function message(id: string, who: string, ts: number, attachments: Attachment[]): IncomingMessage {
  return { ...tmsg("channel", who, "看", { ts }), id: { context: tctx(), id }, attachments };
}

const vision = () => defaultAgentConfig().vision;

describe("image selection", () => {
  it("trigger_then_parent_then_same_author_recent_images", () => {
    const t = 1_000_000;
    const s = new Session(tctx(), 50);
    const old = message("m0", "owen", t - 5 * 60_000, [image("old")]);
    const recent = message("m1", "owen", t - 60_000, [image("recent")]);
    const other = message("m2", "amy", t - 30_000, [image("amy")]);
    const trigger = message("m3", "owen", t, [image("now")]);
    for (const m of [old, recent, other, trigger]) s.recordMessage(m, false);
    const parent = { ...(s.entry("m2") as NonNullable<ReturnType<Session["entry"]>>) };
    const picked = selectImages([trigger], s, [parent], vision());
    expect(picked.map((c) => c.attachment.id)).toEqual(["now", "amy", "recent"]);
    expect(picked[0]?.key).toBe("id:now");
    expect(picked[0]?.author).toBe("owen");
    expect(picked.map((c) => c.source)).toEqual(["message", "parent", "earlier"]);
    expect(picked[2]?.ago_s).toBe(60);
  });

  it("a_reply_leaves_out_the_same_persons_earlier_images", () => {
    // 2026-11-08 14:22: a screenshot posted before was read as the answer to a reply.
    const t = 1_000_000;
    const s = new Session(tctx(), 50);
    const shot = message("m1", "owen", t - 60_000, [image("shot")]);
    const asked = message("m2", "amy", t - 30_000, [image("asked")]);
    const reply = {
      ...message("m3", "owen", t, []),
      reply_to: { context: tctx(), id: "m2" },
    };
    for (const m of [shot, asked, reply]) s.recordMessage(m, false);
    const parent = { ...(s.entry("m2") as NonNullable<ReturnType<Session["entry"]>>) };
    expect(selectImages([reply], s, [parent], vision()).map((c) => c.attachment.id)).toEqual([
      "asked",
    ]);
    // Without its parent (the fetch failed) a reply still gets no older image of theirs.
    expect(selectImages([reply], s, [], vision())).toEqual([]);
  });

  it("each_image_says_where_it_was", () => {
    const t = 1_000_000;
    const s = new Session(tctx(), 50);
    const recent = message("m1", "owen", t - 90_000, [image("recent")]);
    const trigger = message("m2", "owen", t, [image("now")]);
    for (const m of [recent, trigger]) s.recordMessage(m, false);
    const loaded = selectImages([trigger], s, [], vision()).map((candidate) => ({
      candidate,
      dataUrl: "data:image/png;base64,AA",
      bytes: 1,
    }));
    const labels = imageParts(loaded, "low")
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text);
    expect(labels).toEqual([
      "(owen 這則訊息附的圖片 now.png)",
      "(owen 1 分鐘前另外傳的圖片 recent.png,不是這則訊息附的)",
    ]);
  });

  it("skips_unsupported_large_and_foreign_images_and_caps_the_count", () => {
    const s = new Session(tctx(), 50);
    const trigger = message("m", "owen", 1000, [
      image("svg", { content_type: "image/svg+xml", filename: "a.svg" }),
      image("big", { size: 6_000_000 }),
      image("evil", { url: "https://evil.example/x.png" }),
      image("plain", { url: "http://cdn.discordapp.com/x.png" }),
      { url: `${CDN}/doc.pdf`, filename: "doc.pdf", content_type: "application/pdf" },
      image("a"),
      image("b", { content_type: null, filename: "b.webp" }),
      image("c"),
      image("d"),
    ]);
    const picked = selectImages([trigger], s, [], vision());
    expect(picked.map((c) => c.attachment.id)).toEqual(["a", "b", "c"]);
    expect(picked[1]?.type).toBe("image/webp");
    expect(allowedUrl("https://media.discordapp.net/x", ["media.discordapp.net"])).toBe(true);
    expect(allowedUrl("not a url", ["x"])).toBe(false);
  });
});

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
      return new Response(new Uint8Array(bytes).fill(7), {
        status: options.status ?? 200,
        headers,
      });
    },
  };
}

describe("image loader", () => {
  const signal = new AbortController().signal;
  const candidates = (ids: string[]) =>
    selectImages(
      [
        message(
          "m",
          "owen",
          1,
          ids.map((id) => image(id)),
        ),
      ],
      new Session(tctx(), 5),
      [],
      vision(),
    );

  it("downloads_as_data_urls_and_caches_by_attachment_id", async () => {
    const srv = server(3);
    const loader = new ImageLoader(srv.fetch);
    const [first] = await loader.load(candidates(["a"]), vision(), signal);
    expect(first?.dataUrl).toBe("data:image/png;base64,BwcH");
    expect(first?.bytes).toBe(3);
    // A fresh signed URL of the same attachment hits the cache.
    await loader.load(candidates(["a"]), vision(), signal);
    expect(srv.calls).toHaveLength(1);
    expect(loader.cached).toBe(1);
    const parts = imageParts([first as NonNullable<typeof first>], "low");
    expect(parts).toEqual([
      { type: "text", text: "(owen 這則訊息附的圖片 a.png)" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,BwcH", detail: "low" },
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
    const declared = new ImageLoader(server(10, { length: 999 }).fetch);
    expect(await declared.load(candidates(["y"]), cfg, signal)).toEqual([]);
    const errors: string[] = [];
    const down = new ImageLoader(server(10, { status: 403 }).fetch, (_k, e) => errors.push(e));
    expect(await down.load(candidates(["z"]), cfg, signal)).toEqual([]);
    expect(errors).toEqual(["HTTP 403"]);
    // A page instead of an image is skipped; an untyped body keeps the attachment's type.
    const html = new ImageLoader(server(10, { type: "text/html" }).fetch);
    expect(await html.load(candidates(["h"]), cfg, signal)).toEqual([]);
    const untyped = new ImageLoader(server(10, { type: "application/octet-stream" }).fetch);
    expect((await untyped.load(candidates(["u"]), cfg, signal))[0]?.dataUrl).toMatch(
      /^data:image\/png;base64,/,
    );
  });

  it("cache_is_bounded", async () => {
    const loader = new ImageLoader(server(1).fetch);
    const cfg = { ...vision(), cache_entries: 2 };
    for (const id of ["a", "b", "c"]) await loader.load(candidates([id]), cfg, signal);
    expect(loader.cached).toBe(2);
  });
});
