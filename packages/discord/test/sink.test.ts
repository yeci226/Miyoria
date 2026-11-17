import type { ContextKey, ModerationService } from "@miyoria/types";
import { describe, expect, test } from "vitest";
import { DiscordSink, type RestLike, type RestRequest } from "../src/sink.js";

interface Call {
  method: "post" | "put";
  route: string;
  options: RestRequest | undefined;
}

class FakeRest implements RestLike {
  calls: Call[] = [];
  nextId = 1;
  failWith: Error | null = null;

  async post(route: `/${string}`, options?: RestRequest): Promise<unknown> {
    this.calls.push({ method: "post", route, options });
    if (this.failWith) throw this.failWith;
    return { id: String(this.nextId++) };
  }

  async put(route: `/${string}`, options?: RestRequest): Promise<unknown> {
    this.calls.push({ method: "put", route, options });
    if (this.failWith) throw this.failWith;
    return undefined;
  }
}

const channel: ContextKey = { platform: "discord", scope: "1", channel: "200", kind: "channel" };

describe("DiscordSink", () => {
  test("sends_and_replies_without_pinging", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest);
    expect(sink.platform).toBe("discord");
    const ref = await sink.send(channel, {
      text: "hello",
      reply_to: { context: channel, id: "999" },
    });
    expect(ref).toEqual({ context: channel, id: "1" });
    expect(rest.calls).toHaveLength(1);
    expect(rest.calls[0]?.route).toBe("/channels/200/messages");
    expect(rest.calls[0]?.options?.body).toEqual({
      content: "hello",
      allowed_mentions: { parse: ["users"], roles: [], replied_user: false },
      message_reference: { message_id: "999", channel_id: "200", fail_if_not_exists: false },
    });
  });

  test("unprompted_messages_are_sent_without_a_notification", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest);
    await sink.send(channel, { text: "在嗎", reply_to: null, proactive: true } as never);
    await sink.send(channel, { text: "好", reply_to: null });
    const [quiet, normal] = rest.calls.map((c) => c.options?.body as Record<string, unknown>);
    expect(quiet?.flags).toBe(1 << 12); // SUPPRESS_NOTIFICATIONS
    expect(normal).not.toHaveProperty("flags");
  });

  test("never_mentions_roles_everyone_or_here_and_masks_secrets", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest);
    await sink.send(channel, {
      text: "@everyone 開台囉 <@&42> @here,<@7> 快來 sk-abcdefghijklmnopqrstuvwx",
      reply_to: null,
    });
    const body = rest.calls[0]?.options?.body as Record<string, unknown>;
    expect(body.content).toBe("everyone 開台囉  here,<@7> 快來 [已遮蔽]");
    expect(body.allowed_mentions).toEqual({ parse: ["users"], roles: [], replied_user: false });
  });

  test("mention_markup_for_discord_users_only", () => {
    const sink = new DiscordSink(new FakeRest());
    expect(sink.mention({ platform: "discord", id: "1234" })).toBe("<@1234>");
    expect(sink.mention({ platform: "discord", id: "<@&1>" })).toBeNull();
    expect(sink.mention({ platform: "cli", id: "1234" })).toBeNull();
  });

  test("opens_dms_and_sends_cards_without_pings", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest);
    const dm = await sink.openDm({ platform: "discord", id: "900" });
    expect(dm).toEqual({ platform: "discord", scope: null, channel: "1", kind: "dm" });
    expect(rest.calls[0]?.route).toBe("/users/@me/channels");
    expect(rest.calls[0]?.options?.body).toEqual({ recipient_id: "900" });

    const ref = await sink.sendDirect(
      { platform: "discord", id: "900" },
      {
        text: "需要你的確認",
        card: { accent: "warn", title: "需要你的確認", blocks: [{ type: "text", text: "x" }] },
      },
    );
    expect(ref.context.kind).toBe("dm");
    const card = rest.calls.at(-1);
    expect(card?.route).toBe("/channels/2/messages");
    const body = card?.options?.body as Record<string, unknown>;
    expect(body.allowed_mentions).toEqual({ parse: [] });
    expect(Array.isArray(body.components)).toBe(true);
    expect(body.content).toBeUndefined();
    await expect(sink.openDm({ platform: "cli", id: "1" })).rejects.toThrow(/not on Discord/);
  });

  test("long_text_is_split_and_only_the_first_chunk_replies", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest);
    const sentence = "今天天氣很好,我們去散步吧。";
    const ref = await sink.send(channel, {
      text: sentence.repeat(300),
      reply_to: { context: channel, id: "5" },
    });
    expect(rest.calls.length).toBeGreaterThan(1);
    // The returned ref is the first chunk's.
    expect(ref.id).toBe("1");
    const bodies = rest.calls.map((c) => c.options?.body as Record<string, unknown>);
    expect(bodies[0]?.message_reference).toBeDefined();
    for (const body of bodies.slice(1)) expect(body.message_reference).toBeUndefined();
    for (const body of bodies) expect((body.content as string).length).toBeLessThanOrEqual(2000);
  });

  test("rejects_empty_text_and_foreign_contexts", async () => {
    const sink = new DiscordSink(new FakeRest());
    await expect(sink.send(channel, { text: "  \n", reply_to: null })).rejects.toThrow(
      "cannot send an empty message",
    );
    const other: ContextKey = { ...channel, platform: "twitch" };
    await expect(sink.send(other, { text: "x", reply_to: null })).rejects.toThrow(
      "is not a Discord context",
    );
    await expect(
      sink.send({ ...channel, channel: "abc" }, { text: "x", reply_to: null }),
    ).rejects.toThrow("invalid Discord channel id `abc`");
  });

  test("reacts_with_an_encoded_emoji", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest);
    await sink.react({ context: channel, id: "77" }, "👍");
    expect(rest.calls[0]?.method).toBe("put");
    expect(rest.calls[0]?.route).toBe(
      `/channels/200/messages/77/reactions/${encodeURIComponent("👍")}/@me`,
    );
  });

  test("typing_and_abort_signal_are_passed_on", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest);
    const controller = new AbortController();
    await sink.typing(channel, controller.signal);
    expect(rest.calls[0]).toMatchObject({ method: "post", route: "/channels/200/typing" });
    expect(rest.calls[0]?.options?.signal).toBe(controller.signal);
  });

  test("failures_name_where_they_happened", async () => {
    const rest = new FakeRest();
    rest.failWith = new Error("Missing Access");
    const sink = new DiscordSink(rest);
    const error = await sink.send(channel, { text: "x", reply_to: null }).catch((e: unknown) => e);
    expect((error as Error).message).toBe("sending message to discord:1:200");
    expect(((error as Error).cause as Error).message).toBe("Missing Access");
    await expect(sink.typing(channel)).rejects.toThrow("typing in discord:1:200");
    await expect(sink.react({ context: channel, id: "5" }, "x")).rejects.toThrow(
      "reacting to message 5 in discord:1:200",
    );
  });
});

describe("DiscordSink.setVoiceStatus", () => {
  const voice: ContextKey = { platform: "discord", scope: "1", channel: "200", kind: "voice" };

  test("puts the status, at most 500 characters; empty clears it", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest);
    await sink.setVoiceStatus(voice, `  🎤 ${"啦".repeat(600)}  `);
    await sink.setVoiceStatus(voice, "");
    expect(rest.calls.map((c) => [c.method, c.route])).toEqual([
      ["put", "/channels/200/voice-status"],
      ["put", "/channels/200/voice-status"],
    ]);
    const first = (rest.calls[0]?.options?.body as { status?: string } | undefined)?.status ?? "";
    expect([...first]).toHaveLength(500);
    expect(first.startsWith("🎤 啦")).toBe(true);
    expect(rest.calls[1]?.options?.body).toEqual({ status: "" });
  });

  test("names the channel when Discord refuses", async () => {
    const rest = new FakeRest();
    rest.failWith = new Error("Missing Permissions");
    await expect(new DiscordSink(rest).setVoiceStatus(voice, "x")).rejects.toThrow(
      /voice status of discord:1:voice:200/,
    );
  });
});

describe("DiscordSink.describe", () => {
  const voice: ContextKey = { platform: "discord", scope: "1", channel: "200", kind: "voice" };
  const names: Record<string, unknown> = {
    "/channels/200": { id: "200", name: "雜談" },
    "/guilds/1": { id: "1", name: "Miyoria" },
  };
  const rest = (answers: Record<string, unknown>): RestLike => ({
    post: async () => undefined,
    put: async () => undefined,
    get: async (route) => {
      if (!(route in answers)) throw new Error("404 Unknown Channel");
      return answers[route];
    },
  });

  test("names_server_and_channel", async () => {
    expect(await new DiscordSink(rest(names)).describe(voice)).toBe("Miyoria / 雜談");
    expect(await new DiscordSink(rest(names)).describe({ ...voice, scope: null })).toBe("雜談");
  });

  test("returns_null_when_unknown", async () => {
    expect(await new DiscordSink(rest({})).describe(voice)).toBeNull();
    expect(await new DiscordSink(new FakeRest()).describe(voice)).toBeNull();
    expect(await new DiscordSink(rest(names)).describe({ ...voice, platform: "cli" })).toBeNull();
    expect(await new DiscordSink(rest(names)).describe({ ...voice, channel: "x" })).toBeNull();
  });
});

describe("the last line of defence", () => {
  const moderation = (rule: string | null) =>
    ({
      filteredLine: "Filtered.",
      filteredVoiceLine: "Filtered.",
      screen: () => ({
        ok: rule === null,
        visible: null,
        voice: null,
        blocked:
          rule === null ? [] : [{ field: "visible", category: "custom", rule, layer: "rules" }],
      }),
    }) as unknown as ModerationService;

  test("a message moderation stops is the filtered line, and the answer says so", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest, () => moderation("test.word"));
    const sent = await sink.send(channel, { text: "什麼都好", reply_to: null });
    expect(rest.calls[0]?.options?.body).toMatchObject({ content: "Filtered." });
    expect(sent.blocked).toBe("test.word");
  });

  test("a leaked secret is not masked into a sentence: the review sees it first", async () => {
    const rest = new FakeRest();
    const seen: unknown[] = [];
    const service = moderation(null);
    service.screen = (check) => {
      seen.push(check.visible);
      return { ok: true, visible: null, voice: null, blocked: [] };
    };
    const secret = `sk-${"aB3dE6gH9jK2mN5pQ8".repeat(2)}`;
    await new DiscordSink(rest, () => service).send(channel, { text: secret, reply_to: null });
    expect(seen).toEqual([secret]);
  });

  test("the voice status too", async () => {
    const rest = new FakeRest();
    const sink = new DiscordSink(rest, () => moderation("test.word"));
    await sink.setVoiceStatus({ ...channel, kind: "voice" }, "什麼都好");
    expect(rest.calls[0]?.options?.body).toEqual({ status: "Filtered." });
  });

  test("without the service nothing changes", async () => {
    const rest = new FakeRest();
    const sent = await new DiscordSink(rest).send(channel, { text: "hi", reply_to: null });
    expect(sent.blocked).toBeUndefined();
  });
});
