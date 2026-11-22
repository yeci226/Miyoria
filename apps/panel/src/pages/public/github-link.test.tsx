import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import type { GithubLinkView } from "@miyoria/contracts/api";
import { mockFetch, renderPage } from "@/test/render";
import { CONSENT, GitHubLinkCard } from "./GitHubLink";

const linked = (mention: boolean): GithubLinkView => ({
  available: true,
  linked: { login: "octocat", mention, linked_at: "2026-11-21T12:00:00.000Z" },
});

afterEach(() => window.history.replaceState(null, "", "/"));

describe("連結 GitHub", () => {
  it("is not there where linking is not set up", async () => {
    const fetch = mockFetch((_m, url) => (url.pathname === "/api/member/github" ? { body: { available: false, linked: null } } : undefined));
    const { container } = renderPage(<GitHubLinkCard />);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(container.querySelector("[aria-label='GitHub']")).toBeNull();
  });

  it("says what naming means before linking, on by default, and the link carries the choice", async () => {
    const user = userEvent.setup();
    mockFetch((_m, url) => (url.pathname === "/api/member/github" ? { body: { available: true, linked: null } } : undefined));
    renderPage(<GitHubLinkCard />);
    const link = await screen.findByRole("link", { name: "連結 GitHub" });
    expect(screen.getByText(CONSENT)).toBeInTheDocument();
    expect(link.getAttribute("href")).toContain("/api/member/github/link?mention=1");
    await user.click(screen.getByRole("checkbox", { name: "在我回報的問題上標記我" }));
    expect(link.getAttribute("href")).toContain("mention=0");
  });

  it("turns the switch off and unlinks", async () => {
    const user = userEvent.setup();
    const posted: string[] = [];
    mockFetch((method, url, body) => {
      if (method === "GET" && url.pathname === "/api/member/github") return { body: linked(true) };
      if (method === "POST" && url.pathname === "/api/member/github/mention") {
        posted.push(`mention ${JSON.stringify(body)}`);
        return { body: linked(false) };
      }
      if (method === "POST" && url.pathname === "/api/member/github/unlink") {
        posted.push("unlink");
        return { body: { available: true, linked: null } };
      }
      return undefined;
    });
    renderPage(<GitHubLinkCard />);
    expect(await screen.findByText("@octocat")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "在我回報的問題上標記我" }));
    await waitFor(() => expect(posted).toEqual(['mention {"on":false}']));
    await user.click(screen.getByRole("button", { name: "解除連結" }));
    const confirm = await screen.findAllByRole("button", { name: "解除連結" });
    await user.click(confirm.at(-1) as HTMLElement);
    await waitFor(() => expect(posted).toEqual(['mention {"on":false}', "unlink"]));
    expect(await screen.findByRole("link", { name: "連結 GitHub" })).toBeInTheDocument();
  });

  it("says what came back from GitHub and takes it off the address", async () => {
    window.history.replaceState(null, "", "/me?github=taken");
    mockFetch((_m, url) => (url.pathname === "/api/member/github" ? { body: { available: true, linked: null } } : undefined));
    renderPage(<GitHubLinkCard />);
    expect(await screen.findByText(/已經連到另一個人了/)).toBeInTheDocument();
    expect(window.location.search).toBe("");
  });
});
