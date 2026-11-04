import type { MemoryScope } from "@miyoria/store";
import type { ContextKey, TalkCeiling } from "@miyoria/types";
import { describe, expect, it, vi } from "vitest";
import { eligibleChannels, type MatchDeps, matchChannels } from "../src/channels.js";
import { ShareConfigSchema } from "../src/config.js";

const text = (channel: string, scope = "g1"): ContextKey => ({
  platform: "discord",
  scope,
  channel,
  kind: "channel",
});
const dm: ContextKey = { platform: "discord", scope: null, channel: "d", kind: "dm" };
const voice: ContextKey = { platform: "discord", scope: "g1", channel: "v", kind: "voice" };

const ceiling = (mode: string, blocked: string | null = null): TalkCeiling => ({
  mode,
  label: mode,
  blocked,
});
const open = () => ceiling("normal");
const config = (extra = {}) => ShareConfigSchema.parse(extra);

describe("eligibleChannels", () => {
  it("leaves out DMs and voice channels", () => {
    const out = eligibleChannels([text("a"), dm, voice], open, config());
    expect(out.map((c) => c.channel)).toEqual(["a"]);
  });

  it("leaves out channels the owner closed", () => {
    const levels: Record<string, TalkCeiling> = {
      a: ceiling("off"),
      b: ceiling("mention-only"),
      c: ceiling("quiet"),
    };
    const out = eligibleChannels(
      [text("a"), text("b"), text("c")],
      (c) => levels[c.channel] ?? null,
      config(),
    );
    expect(out.map((c) => c.channel)).toEqual(["c"]);
  });

  it("leaves out a channel where she may not start talking now", () => {
    const out = eligibleChannels([text("a")], () => ceiling("normal", "剛說過"), config());
    expect(out).toEqual([]);
  });

  it("uses only the configured channels when there are any", () => {
    const out = eligibleChannels([text("a"), text("b")], open, config({ channels: ["b"] }));
    expect(out.map((c) => c.channel)).toEqual(["b"]);
  });

  it("exclude wins over channels", () => {
    const out = eligibleChannels(
      [text("a"), text("b")],
      open,
      config({ channels: ["a", "b"], exclude: ["a"] }),
    );
    expect(out.map((c) => c.channel)).toEqual(["b"]);
  });

  it("lists a channel once", () => {
    expect(eligibleChannels([text("a"), text("a")], open, config()).length).toBe(1);
  });
});

function deps(hits: Record<string, string[]>, notes: Record<string, string> = {}): MatchDeps {
  return {
    recall: vi.fn(async (scopes: readonly MemoryScope[]) => {
      const channel = scopes.find((s) => s.type === "channel");
      const id = channel?.type === "channel" ? channel.context.channel : "";
      return (hits[id] ?? []).map((content) => ({ record: { content } }));
    }),
    notes: (c) => notes[c.channel] ?? "",
    name: async (c) => `#${c.channel}`,
  };
}

describe("matchChannels", () => {
  const NOW = Date.UTC(2026, 10, 4);

  it("takes the three best channels and drops those with no match", async () => {
    const d = deps({ a: ["喜歡貓"], b: ["喜歡貓", "養貓"], c: ["貓"], e: ["貓", "貓", "貓"] });
    const out = await matchChannels(
      [text("a"), text("b"), text("c"), text("d"), text("e")],
      "貓咪",
      d,
      NOW,
    );
    expect(out.map((m) => m.context.channel)).toEqual(["e", "b", "a"]);
    expect(out[0]?.name).toBe("#e");
    expect(out[0]?.memories.length).toBe(3);
  });

  it("returns nothing when nothing matches", async () => {
    expect(await matchChannels([text("a")], "貓咪", deps({}), NOW)).toEqual([]);
  });

  it("only looks at memories of that server and channel, with nobody present", async () => {
    const d = deps({});
    await matchChannels([text("a", "g7")], "貓咪", d, NOW);
    const [scopes, present] = vi.mocked(d.recall).mock.calls[0] ?? [];
    expect(scopes).toEqual([
      { type: "guild", platform: "discord", guild: "g7" },
      { type: "channel", context: text("a", "g7") },
    ]);
    expect(present).toEqual([]);
  });

  it("counts conversation notes that share words with the post", async () => {
    const d = deps({}, { a: "大家最近都在聊深海魚", b: "今天討論考試" });
    const out = await matchChannels([text("a"), text("b")], "深海魚好可愛", d, NOW);
    expect(out.map((m) => m.context.channel)).toEqual(["a"]);
    expect(out[0]?.notes).toContain("深海魚");
  });
});
