// What members typed loses everything that could reach someone or something from a public issue.

import { describe, expect, it } from "vitest";
import { LIMITS, markdownText, normalizeTitle, plainText, REMOVED } from "../src/sanitize.js";

const clean = (text: string, extra: Partial<Parameters<typeof plainText>[1]> = {}) =>
  plainText(text, { max: 2000, ...extra });

describe("plainText", () => {
  it("neutralises @mentions so nobody is pinged", () => {
    const out = clean("@everyone 快來看 @here 還有 @octocat 跟 @some.one-else");
    expect(out).not.toMatch(/@/);
    expect(out).not.toContain("octocat");
    expect(out).toContain(REMOVED.mention);
  });

  it("removes Discord's mention, role, channel and time markup", () => {
    const out = clean(
      "<@123456789012345678> 在 <#223456789012345678> 被 <@&323456789012345678> 罵 <t:1700000000:R>",
    );
    expect(out).not.toMatch(/<[@#t]/);
    expect(out).not.toMatch(/\d{15,}/);
    expect(out).toContain(REMOVED.channel);
    expect(out).toContain(REMOVED.time);
  });

  it("keeps a custom emoji's name only", () => {
    expect(clean("壞了 <:sad_cat:423456789012345678>")).toBe("壞了 :sad_cat:");
  });

  it("makes issue references inert, full-width or ASCII", () => {
    const out = clean("跟 #12、owner/repo#34、GH-56 一樣,還有 ＃78");
    expect(out).not.toMatch(/#\d/);
    expect(out).not.toMatch(/GH-\d/i);
    expect(out).toContain("＃12");
  });

  it("strips links of every shape and keeps a Markdown link's text", () => {
    const out = clean(
      "看 https://evil.example/x?y=1 和 <http://a.b/c> 跟 www.foo.bar/baz 還有 [這裡](https://x.y) 和 discord.gg/abc 跟 javascript:alert(1)",
    );
    expect(out).not.toMatch(/https?:|www\.|discord\.gg|javascript:|evil|x\.y/);
    expect(out).toContain("這裡");
    expect(out).toContain(REMOVED.link);
  });

  it("removes e-mail addresses and long ids", () => {
    const out = clean("寄到 someone@example.com,我的 id 是 123456789012345678");
    expect(out).not.toContain("example.com");
    expect(out).not.toContain("123456789012345678");
    expect(out).toContain(REMOVED.email);
    expect(out).toContain(REMOVED.id);
  });

  it("replaces the reporter's names, whatever the case", () => {
    const out = clean("ALICE WONDER 說 alice_w 的語音壞了", {
      redact: ["Alice Wonder", "alice_w", "A"],
    });
    expect(out).toBe(`${REMOVED.name} 說 ${REMOVED.name} 的語音壞了`);
  });

  it("drops control, zero-width and direction characters", () => {
    const hidden = [0x0, 0x200b, 0x202e, 0xfeff, 0x7].map((c) => String.fromCharCode(c));
    const out = clean(`a${hidden[0]}b${hidden[1]}c${hidden[2]}d${hidden[3]}e${hidden[4]}f`);
    expect(out).toBe("abcdef");
  });

  it("catches a full-width @ typed to get past it", () => {
    expect(clean("＠everyone")).not.toContain("everyone");
  });

  it("caps the length by characters", () => {
    const out = plainText("語".repeat(500), { max: LIMITS.title });
    expect([...out]).toHaveLength(LIMITS.title);
    expect(out.endsWith("…")).toBe(true);
  });

  it("makes a title one line", () => {
    expect(plainText(" 第一行\n\n第二行\t結束 ", { max: 100, singleLine: true })).toBe(
      "第一行 第二行 結束",
    );
  });

  it("keeps at most one blank line between paragraphs", () => {
    expect(clean("a\n\n\n\n\nb")).toBe("a\n\nb");
  });
});

describe("markdownText", () => {
  it("shows HTML as text", () => {
    const out = markdownText(clean("<img src=x onerror=alert(1)> <script>x</script> & 好"));
    expect(out).not.toMatch(/<|>/);
    expect(out).toContain("&lt;img");
    expect(out).toContain("&amp;");
  });

  it("escapes emphasis, code, links, tables and line starts", () => {
    const out = markdownText("**粗** `code` [a] |x| ~~s~~\n- 清單\n1. 一\n===\n> 引言");
    expect(out).toContain("\\*\\*粗\\*\\*");
    expect(out).toContain("\\`code\\`");
    expect(out).toContain("\\[a\\]");
    expect(out).toContain("\\|x\\|");
    expect(out).toContain("\n\\- 清單");
    expect(out).toContain("\n1\\. 一");
    expect(out).toContain("\n\\===");
    expect(out).toContain("\n&gt; 引言");
  });
});

describe("normalizeTitle", () => {
  it("ignores case, spaces and punctuation", () => {
    expect(normalizeTitle("Voice  is BROKEN!")).toBe(normalizeTitle("voice is broken"));
  });
});
