// `DiscordHistory` against a fake channel manager: no live Discord.

import type { ContextKey } from "@miyoria/types";
import { MessageType } from "discord.js";
import { describe, expect, test } from "vitest";
import { DiscordHistory, type FetchedLike, type HistoryClientLike } from "../src/history.js";

const ctx: ContextKey = { platform: "discord", scope: "300", channel: "200", kind: "channel" };

function fetched(id: string, ts: number, extra: Partial<FetchedLike> = {}): FetchedLike {
  return {
    id,
    type: MessageType.Default,
    channelId: "200",
    guildId: "300",
    author: { id: "42", username: "alice" },
    member: null,
    content: `msg ${id}`,
    createdTimestamp: ts,
    mentions: { users: new Map() },
    attachments: new Map(),
    reference: null,
    ...extra,
  };
}

function client(messages: FetchedLike[], calls: unknown[] = []): HistoryClientLike {
  const cache = new Map(messages.map((m) => [m.id, m]));
  return {
    channels: {
      fetch: async (id: string) => {
        if (id === "missing") throw new Error("Unknown Channel");
        if (id === "voice-only") return { type: 2 };
        return {
          messages: {
            cache: { get: (mid: string) => cache.get(mid) },
            fetch: async (options: string | { limit: number; before?: string }) => {
              calls.push(options);
              if (typeof options === "string") {
                const found = cache.get(options);
                if (!found) throw new Error("Unknown Message");
                return found;
              }
              // Newest first, like Discord.
              const list = [...messages]
                .filter((m) => options.before === undefined || m.id < options.before)
                .sort((a, b) => b.createdTimestamp - a.createdTimestamp)
                .slice(0, options.limit);
              return new Map(list.map((m) => [m.id, m]));
            },
          },
        };
      },
    },
  };
}

describe("DiscordHistory", () => {
  test("recent_is_oldest_first_skips_system_messages_and_maps_replies", async () => {
    const calls: unknown[] = [];
    const msgs = [
      fetched("1", 1000),
      fetched("2", 2000, { type: MessageType.UserJoin }),
      fetched("3", 3000, {
        type: MessageType.Reply,
        reference: { messageId: "1" },
        mentions: { users: new Map(), repliedUser: { id: "7" } },
      }),
      fetched("4", 4000, { content: "" }),
      fetched("9", 9000),
    ];
    const history = new DiscordHistory(client(msgs, calls), new Set(["7"]));
    const out = await history.recent(ctx, { before: "9", limit: 500 });
    // The limit is capped at Discord's 100.
    expect(calls).toEqual([{ limit: 100, before: "9" }]);
    expect(out.map((m) => m.id.id)).toEqual(["1", "3"]);
    const reply = out[1];
    expect(reply?.reply_to?.id).toBe("1");
    expect(reply?.reply_to_self).toBe(true);
    expect(reply?.referenced).toEqual({
      author: { platform: "discord", id: "42" },
      author_name: "alice",
      text: "msg 1",
    });
    expect(reply?.id.context).toEqual(ctx);
  });

  test("fetch_one_and_unreadable_channels", async () => {
    const history = new DiscordHistory(client([fetched("5", 5000)]), new Set());
    expect((await history.fetch({ context: ctx, id: "5" }))?.text).toBe("msg 5");
    expect(await history.fetch({ context: ctx, id: "6" })).toBeNull();
    const elsewhere = (channel: string): ContextKey => ({ ...ctx, channel });
    expect(await history.recent(elsewhere("missing"), { before: null, limit: 5 })).toEqual([]);
    expect(await history.recent(elsewhere("voice-only"), { before: null, limit: 5 })).toEqual([]);
    expect(await history.fetch({ context: elsewhere("missing"), id: "5" })).toBeNull();
    expect(await history.recent(ctx, { before: null, limit: 0 })).toEqual([]);
  });

  test("fetched_history_carries_who_the_message_is_for", async () => {
    const bob = { id: "50", username: "bob", globalName: "Bob" };
    const msgs = [
      fetched("1", 1000),
      fetched("2", 2000, {
        type: MessageType.Reply,
        reference: { messageId: "1" },
        content: "<@50> she repeats herself",
        mentions: { users: new Map([["50", bob]]), repliedUser: { id: "7" } },
      }),
    ];
    const history = new DiscordHistory(client(msgs), new Set(["7"]));
    const out = await history.recent(ctx, { before: null, limit: 10 });
    expect(out[0]?.mentions_others).toEqual([]);
    expect(out[1]?.opens_with_other_mention).toBe(true);
    expect(out[1]?.mentions_others?.map((m) => m.display_name)).toEqual(["Bob"]);
    const one = await history.fetch({ context: ctx, id: "2" });
    expect(one?.opens_with_other_mention).toBe(true);
  });

  test("a_reply_to_her_card_reads_what_the_card_says", async () => {
    // A slash command's answer (Components V2, no content), as her cards and receipts are.
    const card = fetched("8", 8000, {
      type: MessageType.ChatInputCommand,
      author: { id: "7", username: "miyo", bot: true },
      content: "",
      components: [
        {
          type: 17,
          components: [
            { type: 10, content: "## 收據" },
            { toJSON: () => ({ type: 10, content: "Owen 付了 30 魚幣" }) },
          ],
        },
      ],
    });
    const history = new DiscordHistory(client([card]), new Set(["7"]));
    const parent = await history.fetch({ context: ctx, id: "8" });
    expect(parent?.text).toBe("## 收據\nOwen 付了 30 魚幣");
    // Not in a channel's recent lines: those stay what people wrote.
    expect(await history.recent(ctx, { before: null, limit: 5 })).toEqual([]);
  });

  test("an_aborted_signal_stops_the_read", async () => {
    const history = new DiscordHistory(client([fetched("5", 5000)]), new Set());
    const controller = new AbortController();
    controller.abort();
    await expect(
      history.recent(ctx, { before: null, limit: 5 }, controller.signal),
    ).rejects.toThrow();
  });
});
