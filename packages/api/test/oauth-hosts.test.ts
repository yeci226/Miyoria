import { describe, expect, it } from "vitest";
import {
  DiscordOAuthConfigSchema,
  loginCookiePath,
  OAuth,
  OAuthConfigError,
} from "../src/oauth.js";

const LOCAL = "http://127.0.0.1:7878/api/auth/oauth/callback";
const PUBLIC = "https://panel.example.com/api/auth/oauth/callback";

function client(): OAuth {
  const config = DiscordOAuthConfigSchema.parse({
    client_id: "cid",
    client_secret: "secret",
    redirect_uri: LOCAL,
    redirect_uris: [PUBLIC],
  });
  const oauth = OAuth.fromConfig(config, { now: () => 0 } as never);
  if (oauth === null) throw new Error("login should be on");
  return oauth;
}

const sentTo = (url: URL) => url.searchParams.get("redirect_uri");

describe("the callback follows the address the login started on", () => {
  it("returns to a configured host", () => {
    expect(sentTo(client().begin("/", "panel.example.com", "b"))).toBe(PUBLIC);
  });

  it("stays local on the local host", () => {
    expect(sentTo(client().begin("/", "127.0.0.1:7878", "b"))).toBe(LOCAL);
  });

  it("never redirects to a host nobody configured", () => {
    expect(sentTo(client().begin("/", "evil.example.net", "b"))).toBe(LOCAL);
    expect(sentTo(client().begin("/", null, "b"))).toBe(LOCAL);
  });

  it("exchanges the code with the address the login used", () => {
    const oauth = client();
    const url = oauth.begin("/", "panel.example.com", "b");
    const pending = oauth.take(url.searchParams.get("state") ?? "");
    expect(pending?.redirect.href).toBe(PUBLIC);
  });
});

describe("the login cookie's path", () => {
  it("is the callback's directory, prefix included", () => {
    expect(loginCookiePath(new URL(LOCAL))).toBe("/api/auth/oauth");
    expect(loginCookiePath(new URL("https://x.example/m/api/auth/oauth/callback"))).toBe(
      "/m/api/auth/oauth",
    );
    expect(loginCookiePath(new URL("https://x.example/cb"))).toBe("/");
  });

  it("refuses a redirect_uri whose path would end the cookie early", () => {
    const config = DiscordOAuthConfigSchema.parse({
      client_id: "cid",
      client_secret: "secret",
      redirect_uri: "https://x.example/a;b/api/auth/oauth/callback",
    });
    expect(() => OAuth.fromConfig(config, { now: () => 0 } as never)).toThrow(OAuthConfigError);
  });
});
