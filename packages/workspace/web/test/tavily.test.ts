import { DATA_OPEN } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { WebConfigSchema } from "../src/config.js";
import { WebError } from "../src/net.js";
import { SEARCH_DOWN, SEARCH_URL, TAVILY_URL, WebService } from "../src/web.js";
import { fixture } from "./helpers.js";

const KEY = "tvly-secret-key-123";
const ALICE = "discord:1";
const BOB = "discord:2";
const signal = () => new AbortController().signal;

const reply =
  (body: unknown, status = 200) =>
  () =>
    new Response(JSON.stringify(body), { status });

const good = {
  answer: "Opus 5.5 is out.",
  results: [
    {
      title: "Opus 5.5",
      url: "https://example.com/a",
      content: "It launched.",
      published_date: "2026-11-01",
    },
    { title: "bad", url: "javascript:alert(1)", content: "x" },
    { title: "Two", url: "https://example.com/b", content: "More." },
  ],
};

function rig(
  over: Record<string, unknown> = {},
  answer: () => Response | Promise<Response> = reply(good),
) {
  const sent: { url: string; init: RequestInit }[] = [];
  const waits: number[] = [];
  const notes: string[] = [];
  const clock = { at: 1_000_000 };
  const web = new WebService({
    config: WebConfigSchema.parse(over),
    clock: { now: () => clock.at },
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      sent.push({ url: String(url), init: init ?? {} });
      return await answer();
    }) as typeof fetch,
    sleep: async (ms) => {
      waits.push(ms);
      clock.at += ms;
    },
    note: (detail) => notes.push(detail),
  });
  return { web, sent, waits, notes };
}

describe("web_search with Tavily", () => {
  it("posts JSON with a bearer key, and maps results and the answer", async () => {
    const r = rig({ tavily_api_key: KEY, tavily_include_answer: true, tavily_topic: "news" });
    const out = await r.web.search(ALICE, " Opus  5.5 ", 4, signal());
    const [req] = r.sent;
    expect(req?.url).toBe(TAVILY_URL);
    expect(req?.url).toBe("https://api.tavily.com/search");
    expect(req?.init.method).toBe("POST");
    const headers = req?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(String(req?.init.body))).toEqual({
      query: "Opus 5.5",
      max_results: 4,
      search_depth: "basic",
      topic: "news",
      include_answer: true,
    });
    expect(out.hits).toEqual([
      {
        title: "Opus 5.5",
        url: "https://example.com/a",
        snippet: "It launched.",
        published: "2026-11-01",
      },
      { title: "Two", url: "https://example.com/b", snippet: "More." },
    ]);
    expect(out.answer).toBe("Opus 5.5 is out.");
    expect(out.text).toContain("摘要: Opus 5.5 is out.");
    expect(out.text).toContain("發布: 2026-11-01");
    expect(out.text).toContain(DATA_OPEN);
  });

  it("is the default with a key, DuckDuckGo without, and explicit duckduckgo wins", async () => {
    expect(rig({ tavily_api_key: KEY }).web.provider()).toBe("tavily");
    expect(rig({}).web.provider()).toBe("duckduckgo");
    expect(rig({ search_provider: "tavily" }).web.provider()).toBe("duckduckgo");
    const d = rig(
      { search_provider: "duckduckgo", tavily_api_key: KEY },
      () => new Response(fixture("ddg-results.html"), { status: 200 }),
    );
    expect(d.web.provider()).toBe("duckduckgo");
    await d.web.search(ALICE, "q", 5, signal());
    expect(d.sent[0]?.url).toBe(SEARCH_URL);
  });

  it("takes a key passed in from the environment", () => {
    const web = new WebService({
      config: WebConfigSchema.parse({}),
      clock: { now: () => 0 },
      tavilyKey: KEY,
    });
    expect(web.provider()).toBe("tavily");
  });

  it.each([401, 429, 432, 500])(
    "maps status %i to 'cannot search', key unlogged",
    async (status) => {
      const r = rig({ tavily_api_key: KEY }, reply({ detail: KEY }, status));
      const failure = await r.web.search(ALICE, "q", 5, signal()).catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(WebError);
      expect((failure as WebError).message).toBe(SEARCH_DOWN);
      expect(r.notes).toHaveLength(1);
      expect(r.notes[0]).toContain(String(status));
      expect(JSON.stringify([r.notes, (failure as WebError).reason])).not.toContain(KEY);
    },
  );

  it("maps a network failure or timeout the same way, key unlogged", async () => {
    const r = rig({ tavily_api_key: KEY }, () => {
      throw new Error(`boom ${KEY}`);
    });
    await expect(r.web.search(ALICE, "q", 5, signal())).rejects.toMatchObject({
      message: SEARCH_DOWN,
    });
    expect(r.notes.join()).not.toContain(KEY);
  });

  it("does not pace Tavily, and caches by provider", async () => {
    const r = rig({ tavily_api_key: KEY });
    await r.web.search(ALICE, "one", 5, signal());
    await r.web.search(BOB, "two", 5, signal());
    await r.web.search(BOB, "one", 5, signal());
    expect(r.waits).toEqual([]);
    expect(r.sent).toHaveLength(2);
  });
});
