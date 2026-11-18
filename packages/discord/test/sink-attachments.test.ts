// Outgoing attachments: a message names artifacts by id; the sink resolves them through the app's
// `AttachmentSource` when it sends, uploads the bytes with the first chunk of the text, and posts
// nothing when one is refused. A card (`sendCard`) uploads the files of its reply, the picture its
// image block shows.

import { cardReply } from "@miyoria/commands";
import {
  AttachmentError,
  type AttachmentFile,
  type AttachmentSource,
  type ContextKey,
} from "@miyoria/types";
import { describe, expect, test } from "vitest";
import { MAX_MESSAGE_FILES } from "../src/index.js";
import { DiscordSink, type RestLike, type RestRequest } from "../src/sink.js";

class FakeRest implements RestLike {
  posts: { route: string; options: RestRequest | undefined }[] = [];
  failWith: unknown = null;

  async post(route: `/${string}`, options?: RestRequest): Promise<unknown> {
    this.posts.push({ route, options });
    if (this.failWith) throw this.failWith;
    return { id: String(this.posts.length) };
  }

  async put(): Promise<unknown> {
    return undefined;
  }
}

class FakeSource implements AttachmentSource {
  opened: { id: string; destination: ContextKey; maxBytes: number }[] = [];
  refuse: AttachmentError | null = null;
  size = 100;

  async open(
    id: string,
    destination: ContextKey,
    options: { maxBytes: number },
  ): Promise<AttachmentFile> {
    this.opened.push({ id, destination, maxBytes: options.maxBytes });
    if (this.refuse) throw this.refuse;
    return {
      artifact_id: id,
      filename: `${id}.txt`,
      content_type: "text/plain",
      size: this.size,
      data: new Uint8Array(this.size).fill(65),
    };
  }
}

const channel: ContextKey = { platform: "discord", scope: "1", channel: "200", kind: "channel" };

function make(maxBytes = 1000, withSource = true) {
  const rest = new FakeRest();
  const source = new FakeSource();
  const sink = new DiscordSink(rest, () => undefined, null, {
    source: () => (withSource ? source : undefined),
    maxBytes: () => maxBytes,
  });
  return { rest, sink, source };
}

describe("DiscordSink attachments", () => {
  test("uploads_the_resolved_bytes_with_the_first_chunk_and_names_them_in_the_body", async () => {
    const { rest, sink, source } = make();
    const ref = await sink.send(channel, {
      text: "給你",
      reply_to: null,
      attachments: [{ artifact_id: "A1" }, { artifact_id: "A2" }],
    });
    expect(ref).toEqual({ context: channel, id: "1" });
    expect(source.opened.map((o) => o.id)).toEqual(["A1", "A2"]);
    // Each file may take what the message has left.
    expect(source.opened.map((o) => o.maxBytes)).toEqual([1000, 900]);
    expect(source.opened.every((o) => o.destination === channel)).toBe(true);
    const request = rest.posts[0]?.options;
    expect(request?.files?.map((f) => [f.name, f.contentType, f.data.length])).toEqual([
      ["A1.txt", "text/plain", 100],
      ["A2.txt", "text/plain", 100],
    ]);
    expect(request?.body).toMatchObject({
      content: "給你",
      attachments: [
        { id: 0, filename: "A1.txt" },
        { id: 1, filename: "A2.txt" },
      ],
    });
  });

  test("a_file_alone_is_a_message_without_content", async () => {
    const { rest, sink } = make();
    await sink.send(channel, { text: "", reply_to: null, attachments: [{ artifact_id: "A1" }] });
    expect(rest.posts).toHaveLength(1);
    expect(rest.posts[0]?.options?.body).not.toHaveProperty("content");
    expect(rest.posts[0]?.options?.files).toHaveLength(1);
  });

  test("a_refused_file_stops_the_whole_message_before_anything_is_posted", async () => {
    const { rest, sink, source } = make();
    source.refuse = new AttachmentError("not_visible", "not for this place");
    await expect(
      sink.send(channel, { text: "hi", reply_to: null, attachments: [{ artifact_id: "A1" }] }),
    ).rejects.toMatchObject({ code: "not_visible" });
    expect(rest.posts).toEqual([]);
  });

  test("files_over_the_limit_together_are_refused_before_posting", async () => {
    const { rest, sink, source } = make(150);
    source.size = 100;
    await expect(
      sink.send(channel, {
        text: "x",
        reply_to: null,
        attachments: [{ artifact_id: "A1" }, { artifact_id: "A2" }],
      }),
    ).rejects.toMatchObject({ code: "too_large" });
    expect(rest.posts).toEqual([]);
  });

  test("too_many_files_are_refused", async () => {
    const { rest, sink } = make();
    const attachments = Array.from({ length: MAX_MESSAGE_FILES + 1 }, (_, i) => ({
      artifact_id: `A${i}`,
    }));
    await expect(
      sink.send(channel, { text: "x", reply_to: null, attachments }),
    ).rejects.toMatchObject({ code: "too_many" });
    expect(rest.posts).toEqual([]);
  });

  test("without_a_source_attachments_cannot_go_and_plain_messages_still_do", async () => {
    const { rest, sink } = make(1000, false);
    expect(sink.attachmentLimit(channel)).toBeNull();
    await expect(
      sink.send(channel, { text: "x", reply_to: null, attachments: [{ artifact_id: "A1" }] }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await sink.send(channel, { text: "plain", reply_to: null });
    expect(rest.posts).toHaveLength(1);
    expect(new DiscordSink(rest).attachmentLimit(channel)).toBeNull();
  });

  test("the_limit_is_the_configured_one_and_only_for_discord", () => {
    const { sink } = make(5_000_000);
    expect(sink.attachmentLimit(channel)).toBe(5_000_000);
    expect(sink.attachmentLimit({ ...channel, platform: "cli" })).toBeNull();
  });

  test("a_card_uploads_the_picture_it_shows_and_a_card_without_files_posts_none", async () => {
    const { rest, sink } = make();
    const png = new Uint8Array([137, 80, 78, 71]);
    await sink.sendCard(
      channel,
      cardReply(
        [
          { type: "image", name: "miyoria-auction.png", alt: "拍賣的一行摘要" },
          { type: "text", text: "每週拍賣" },
        ],
        { files: [{ name: "miyoria-auction.png", data: png, contentType: "image/png" }] },
      ),
    );
    const request = rest.posts[0]?.options;
    expect(request?.files).toEqual([
      { name: "miyoria-auction.png", data: Buffer.from(png), contentType: "image/png" },
    ]);
    expect(request?.body).toMatchObject({
      attachments: [{ id: 0, filename: "miyoria-auction.png" }],
      allowed_mentions: { parse: [] },
    });
    const gallery = JSON.stringify(
      (request?.body as { components?: unknown } | undefined)?.components,
    );
    expect(gallery).toContain("attachment://miyoria-auction.png");
    expect(gallery).toContain("拍賣的一行摘要");
    await sink.sendCard(channel, cardReply([{ type: "text", text: "只有字" }]));
    expect(rest.posts[1]?.options?.files).toBeUndefined();
    expect(rest.posts[1]?.options?.body).not.toHaveProperty("attachments");
  });

  test("discords_own_refusal_of_the_upload_becomes_a_clear_attachment_error", async () => {
    const { rest, sink } = make();
    const send = () =>
      sink.send(channel, { text: "x", reply_to: null, attachments: [{ artifact_id: "A1" }] });
    rest.failWith = Object.assign(new Error("too large"), { code: 40005 });
    await expect(send()).rejects.toMatchObject({ cause: { code: "too_large" } });
    rest.failWith = Object.assign(new Error("missing permissions"), { code: 50013 });
    await expect(send()).rejects.toMatchObject({ cause: { code: "platform" } });
  });
});
