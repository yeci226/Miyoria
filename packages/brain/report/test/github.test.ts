// The REST calls as they leave: the endpoints, the headers, the token only in `Authorization`.
// `fetch` is a fake; nothing reaches GitHub.

import { describe, expect, it } from "vitest";
import { type FetchLike, GitHubError, GitHubIssues } from "../src/github.js";

const TOKEN = "github_pat_TESTONLY_not_a_real_token";

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

function fake(answer: (url: string, init?: RequestInit) => Response): {
  fetch: FetchLike;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  return {
    sent,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return answer(url, init);
    },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const headers = (s: Sent) => new Headers(s.init?.headers as Record<string, string>);

describe("GitHubIssues", () => {
  it("searches the repo's open issues by title and leaves pull requests out", async () => {
    const f = fake(() =>
      json({
        items: [
          { number: 7, title: "voice broken", html_url: "https://github.test/o/r/issues/7" },
          { number: 8, title: "voice pr", html_url: "u8", pull_request: {} },
        ],
      }),
    );
    const gh = new GitHubIssues({ token: TOKEN, repo: "o/r", fetch: f.fetch });
    expect(await gh.search(["voice", "broken"])).toEqual([
      { number: 7, title: "voice broken", url: "https://github.test/o/r/issues/7" },
    ]);
    const url = new URL(f.sent[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe("https://api.github.com/search/issues");
    expect(url.searchParams.get("q")).toBe("repo:o/r is:issue is:open in:title voice broken");
    expect(f.sent[0]?.url).not.toContain(TOKEN);
  });

  it("opens an issue with the labels and the headers GitHub documents", async () => {
    const f = fake(() => json({ number: 12, html_url: "https://github.test/o/r/issues/12" }, 201));
    const gh = new GitHubIssues({
      token: TOKEN,
      repo: "o/r",
      fetch: f.fetch,
      apiUrl: "https://ghe.test/api/v3/",
    });
    expect(await gh.open({ title: "t", body: "b", labels: ["bug"] })).toEqual({
      number: 12,
      url: "https://github.test/o/r/issues/12",
    });
    const sent = f.sent[0] as Sent;
    expect(sent.url).toBe("https://ghe.test/api/v3/repos/o/r/issues");
    expect(sent.init?.method).toBe("POST");
    expect(JSON.parse(String(sent.init?.body))).toEqual({ title: "t", body: "b", labels: ["bug"] });
    const h = headers(sent);
    expect(h.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(h.get("accept")).toBe("application/vnd.github+json");
    expect(h.get("x-github-api-version")).toBe("2022-11-28");
  });

  it("comments on an issue and reads one back", async () => {
    const f = fake((url) =>
      url.endsWith("/comments")
        ? json({ html_url: "https://github.test/o/r/issues/3#c1" }, 201)
        : json({
            number: 3,
            state: "closed",
            state_reason: "completed",
            closed_at: "2026-11-21T00:00:00Z",
            html_url: "u3",
          }),
    );
    const gh = new GitHubIssues({ token: TOKEN, repo: "o/r", fetch: f.fetch });
    expect(await gh.comment(3, "x")).toEqual({ url: "https://github.test/o/r/issues/3#c1" });
    expect(await gh.issue(3)).toEqual({
      number: 3,
      state: "closed",
      reason: "completed",
      closed_at: "2026-11-21T00:00:00Z",
      url: "u3",
    });
    expect(f.sent.map((s) => s.url)).toEqual([
      "https://api.github.com/repos/o/r/issues/3/comments",
      "https://api.github.com/repos/o/r/issues/3",
    ]);
  });

  it("says what GitHub refused, never the token", async () => {
    const f = fake(() => json({ message: `Bad credentials for ${TOKEN.slice(0, 4)}` }, 401));
    const gh = new GitHubIssues({ token: TOKEN, repo: "o/r", fetch: f.fetch });
    const error = await gh.open({ title: "t", body: "b", labels: [] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect((error as GitHubError).status).toBe(401);
    expect(String((error as Error).message)).not.toContain(TOKEN);
    expect(JSON.stringify(gh)).not.toContain(TOKEN);
  });

  it("turns a failed request into an error with no answer", async () => {
    const gh = new GitHubIssues({
      token: TOKEN,
      repo: "o/r",
      fetch: async () => {
        throw new TypeError(`fetch failed ${TOKEN}`);
      },
    });
    const error = (await gh.issue(1).catch((e: unknown) => e)) as GitHubError;
    expect(error.status).toBe(0);
    expect(error.message).not.toContain(TOKEN);
  });
});
