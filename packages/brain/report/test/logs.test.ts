// What the module writes in its log and its errors when GitHub fails, with the App's key, its JWT
// and its installation token in play: none of them. A throwaway key made here; nothing reaches
// GitHub.

import { generateKeyPairSync } from "node:crypto";
import { openTestDb } from "@miyoria/store/testing";
import { afterEach, describe, expect, it } from "vitest";
import { AppInstallationAuth } from "../src/auth.js";
import { reportConfig } from "../src/config.js";
import { GitHubIssues } from "../src/github.js";
import type { FetchLike } from "../src/http.js";
import { reportSchema } from "../src/migrations.js";
import { ReportService } from "../src/service.js";
import { ReportTables } from "../src/store.js";
import { ALICE, FIELDS, HERE, message, T0 } from "./rig.js";

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const TOKEN = "ghs_installation_TESTONLY";

const closers: (() => void)[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

describe("the log and the errors", () => {
  it("never carry the key, the JWT or the installation token", async () => {
    const db = openTestDb({ plugins: [reportSchema] });
    closers.push(() => db.close());
    const jwts: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      const auth = new Headers(init?.headers as Record<string, string>).get("authorization") ?? "";
      const path = new URL(url).pathname;
      if (path.endsWith("/access_tokens")) {
        jwts.push(auth.slice(7));
        return new Response(
          JSON.stringify({ token: TOKEN, expires_at: new Date(T0 + 3_600_000).toISOString() }),
          { status: 201 },
        );
      }
      // Every repository call fails, and GitHub's message echoes nothing secret.
      return new Response(JSON.stringify({ message: "Server Error" }), { status: 500 });
    };
    const auth = new AppInstallationAuth({
      appId: "1",
      installationId: "2",
      privateKey: PEM,
      repo: "owner/repo",
      fetch,
      now: () => T0,
    });
    const lines: string[] = [];
    const log = {
      warn: (obj: object, msg?: string) => lines.push(JSON.stringify({ obj, msg })),
      info: (obj: object, msg?: string) => lines.push(JSON.stringify({ obj, msg })),
    };
    const service = new ReportService({
      config: reportConfig({
        repo: "owner/repo",
        app_id: "1",
        private_key: PEM,
        client_secret: "cs-TESTONLY",
      }),
      store: new ReportTables(db.db),
      tracker: new GitHubIssues({ auth, repo: "owner/repo", fetch }),
      now: () => T0,
      log,
    });
    const outcome = await service.report({
      account: ALICE,
      context: HERE,
      message: message(),
      fields: FIELDS,
    });
    if (!outcome.ok) throw new Error("no draft");
    const refused = await service.approve(outcome.id, "api");
    expect(refused.ok).toBe(false);
    const texts = [
      ...lines,
      JSON.stringify(refused),
      JSON.stringify(service),
      JSON.stringify(service.get(outcome.id)),
    ];
    expect(jwts.length).toBeGreaterThan(0);
    for (const text of texts) {
      expect(text).not.toContain(TOKEN);
      for (const jwt of jwts) expect(text).not.toContain(jwt);
      expect(text).not.toContain("PRIVATE KEY");
      expect(text).not.toContain("cs-TESTONLY");
    }
  });
});
