// The GitHub App's authentication: the JWT, the installation token and its renewal, the retry on
// a 401, the token fallback, and no secret anywhere it could leak. A throwaway RSA key made here;
// `fetch` is a fake, nothing reaches GitHub.

import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AppInstallationAuth,
  AppKeyError,
  appJwt,
  JWT_BACKDATE_S,
  readPrivateKey,
  StaticToken,
} from "../src/auth.js";
import { reportConfig } from "../src/config.js";
import { GitHubIssues } from "../src/github.js";
import type { FetchLike } from "../src/http.js";
import { githubAuth } from "../src/module.js";
import { T0 } from "./rig.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PEM_ONE_LINE = PEM.trim().replace(/\n/g, "\\n");
const MINUTE = 60_000;

interface Sent {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** A GitHub that hands out installation tokens `ghs_1`, `ghs_2`, ... good for an hour. */
function github(clock: { now: number }) {
  const sent: Sent[] = [];
  let minted = 0;
  const refused = new Set<string>();
  const fetch: FetchLike = async (url, init) => {
    const headers = new Headers(init?.headers as Record<string, string>);
    const method = init?.method ?? "GET";
    sent.push({
      method,
      url,
      authorization: headers.get("authorization"),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const path = new URL(url).pathname;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (method === "GET" && path === "/repos/owner/repo/installation") return json({ id: 77 });
    if (method === "POST" && /^\/app\/installations\/\d+\/access_tokens$/.test(path)) {
      // Let the waiting callers pile up before the answer comes.
      await new Promise((r) => setTimeout(r, 5));
      minted++;
      return json(
        { token: `ghs_${minted}`, expires_at: new Date(clock.now + 60 * MINUTE).toISOString() },
        201,
      );
    }
    if (path === "/repos/owner/repo/issues/1") {
      const bearer = headers.get("authorization");
      if (bearer !== null && refused.has(bearer)) return json({ message: "Bad credentials" }, 401);
      return json({ number: 1, state: "open", html_url: "u1" });
    }
    return json({ message: "Not Found" }, 404);
  };
  return {
    fetch,
    sent,
    minted: () => minted,
    refuse: (token: string) => {
      refused.add(`Bearer ${token}`);
    },
  };
}

function decode(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
}

describe("the App's JWT", () => {
  it("is RS256, issued by the App, a minute back and under ten minutes ahead, and verifies", () => {
    const jwt = appJwt("12345", readPrivateKey(PEM), T0);
    const [header, payload, signature] = jwt.split(".") as [string, string, string];
    expect(decode(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decode(payload);
    const now = Math.floor(T0 / 1000);
    expect(claims).toEqual({ iss: "12345", iat: now - JWT_BACKDATE_S, exp: expect.any(Number) });
    expect((claims.exp as number) - now).toBeLessThanOrEqual(600);
    expect((claims.exp as number) - now).toBeGreaterThan(0);
    const ok = verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("reads a key kept on one line with literal \\n", () => {
    expect(readPrivateKey(PEM_ONE_LINE).asymmetricKeyType).toBe("rsa");
  });

  it("refuses a key that is not the App's RSA key, saying nothing of it", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    for (const bad of ["not a key", ec, PEM.slice(0, 200)]) {
      const error = (() => {
        try {
          readPrivateKey(bad);
        } catch (e) {
          return e as Error;
        }
        return null;
      })();
      expect(error).toBeInstanceOf(AppKeyError);
      expect(error?.message).toBe(new AppKeyError().message);
    }
  });
});

describe("the installation token", () => {
  const make = (
    clock: { now: number },
    gh: ReturnType<typeof github>,
    installationId: string | null = null,
  ) =>
    new AppInstallationAuth({
      appId: "12345",
      installationId,
      privateKey: PEM,
      repo: "owner/repo",
      fetch: gh.fetch,
      now: () => clock.now,
    });

  it("finds the installation from the repo, asks for a token limited to it and issues: write", async () => {
    const clock = { now: T0 };
    const gh = github(clock);
    const auth = make(clock, gh);
    expect(await auth.token()).toBe("ghs_1");
    expect(gh.sent.map((s) => `${s.method} ${new URL(s.url).pathname}`)).toEqual([
      "GET /repos/owner/repo/installation",
      "POST /app/installations/77/access_tokens",
    ]);
    expect(gh.sent[1]?.body).toEqual({ repositories: ["repo"], permissions: { issues: "write" } });
    // Both calls as the App: a JWT, never the key.
    for (const s of gh.sent) expect(s.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("is kept, and renewed a few minutes before it expires", async () => {
    const clock = { now: T0 };
    const gh = github(clock);
    const auth = make(clock, gh, "77");
    expect(await auth.token()).toBe("ghs_1");
    clock.now += 50 * MINUTE;
    expect(await auth.token()).toBe("ghs_1");
    clock.now += 6 * MINUTE; // four minutes left: renewed
    expect(await auth.token()).toBe("ghs_2");
    expect(gh.minted()).toBe(2);
  });

  it("is renewed once however many calls wait for it", async () => {
    const clock = { now: T0 };
    const gh = github(clock);
    const auth = make(clock, gh, "77");
    const tokens = await Promise.all(Array.from({ length: 8 }, () => auth.token()));
    expect(new Set(tokens)).toEqual(new Set(["ghs_1"]));
    expect(gh.minted()).toBe(1);
  });

  it("is renewed and the call tried once more when GitHub answers 401", async () => {
    const clock = { now: T0 };
    const gh = github(clock);
    const issues = new GitHubIssues({
      auth: make(clock, gh, "77"),
      repo: "owner/repo",
      fetch: gh.fetch,
    });
    await issues.issue(1);
    gh.refuse("ghs_1");
    expect(await issues.issue(1)).toMatchObject({ number: 1 });
    expect(gh.minted()).toBe(2);
    // Still refused after the fresh token: the error, not a loop.
    gh.refuse("ghs_2");
    gh.refuse("ghs_3");
    await expect(issues.issue(1)).rejects.toMatchObject({ status: 401 });
  });

  it("keeps the key, the JWT and the token out of toJSON and errors", async () => {
    const clock = { now: T0 };
    const gh = github(clock);
    const auth = make(clock, gh, "77");
    const token = await auth.token();
    const jwt = gh.sent[0]?.authorization?.slice(7) ?? "";
    const issues = new GitHubIssues({ auth, repo: "owner/repo", fetch: gh.fetch });
    const error = (await issues.issue(404).catch((e: unknown) => e)) as Error;
    for (const text of [
      JSON.stringify(auth),
      JSON.stringify(issues),
      error.message,
      String(error.stack),
    ]) {
      expect(text).not.toContain(token);
      expect(text).not.toContain(jwt);
      expect(text).not.toContain("PRIVATE KEY");
    }
  });
});

describe("which way GitHub is called", () => {
  it("is the App when its settings are complete, else the token, else nothing", () => {
    const now = () => T0;
    const app = reportConfig({
      repo: "owner/repo",
      app_id: "12345",
      private_key: PEM_ONE_LINE,
      token: "fallback",
    });
    expect(githubAuth(app, now, undefined)?.kind).toBe("app");
    expect(
      githubAuth(
        reportConfig({ repo: "owner/repo", app_id: 12345, token: "fallback" }),
        now,
        undefined,
      ),
    ).toBeInstanceOf(StaticToken);
    expect(githubAuth(reportConfig({ repo: "owner/repo" }), now, undefined)).toBeNull();
    expect(
      githubAuth(reportConfig({ app_id: "1", private_key: PEM, token: "t" }), now, undefined),
    ).toBeNull();
  });

  it("falls back to the token when the App's key cannot be read, and says why without the key", () => {
    const said: string[] = [];
    const config = reportConfig({
      repo: "owner/repo",
      app_id: "1",
      private_key: "-----BEGIN nonsense",
      token: "fallback",
    });
    expect(
      githubAuth(
        config,
        () => T0,
        undefined,
        (m) => said.push(m),
      )?.kind,
    ).toBe("token");
    expect(said.join("\n")).toContain("private key cannot be read");
    expect(said.join("\n")).not.toContain("nonsense");
  });
});
