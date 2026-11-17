// `/api/sandbox/tools*`: the owners' view of the tools she wrote, and approving / rejecting one
// exact version.

import { Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import { MemorySettingsStore } from "@miyoria/store";
import { ProposedTools, ProposedToolsKey } from "@miyoria/workspace/sandbox";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
});

async function harness() {
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  const tools = new ProposedTools({
    store: new MemorySettingsStore(),
    profile: "p",
    sandbox: null,
    maxTools: 10,
    maxCodeBytes: 64 * 1024,
  });
  return { sup, base, tools };
}

const proposal = {
  name: "shout",
  description: "Repeats text in capitals",
  language: "python" as const,
  code: "print('HI')\n",
  args_schema: { type: "object", properties: { text: { type: "string" } } },
};

describe("sandbox routes", () => {
  it("need the token and the sandbox module", async () => {
    const h = await harness();
    expect((await raw(h.base, "GET", "/api/sandbox/tools")).status).toBe(401);
    const missing = await raw(h.base, "GET", "/api/sandbox/tools", { token: TOKEN });
    expect(missing.status).toBe(503);
  });

  it("list, show, approve and reject one version", async () => {
    const h = await harness();
    h.sup.services.provide("sandbox", ProposedToolsKey, h.tools);
    await h.tools.propose(proposal, "self");

    const list = await raw(h.base, "GET", "/api/sandbox/tools", { token: TOKEN });
    expect(list.status).toBe(200);
    const body = list.body as { sandbox: unknown; tools: Record<string, unknown>[] };
    expect(body.sandbox).toBeNull();
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ name: "shout", status: "pending", version: 1 });
    // The list leaves the code out; the detail has it.
    expect(body.tools[0]?.code).toBeUndefined();
    expect(body.tools[0]?.code_bytes).toBe(12);
    const one = await raw(h.base, "GET", "/api/sandbox/tools/shout", { token: TOKEN });
    expect((one.body as { code: string }).code).toBe("print('HI')\n");
    expect((await raw(h.base, "GET", "/api/sandbox/tools/nope", { token: TOKEN })).status).toBe(
      404,
    );

    // The version the owner looked at must still be the current one.
    const stale = await raw(h.base, "POST", "/api/sandbox/tools/shout/approve", {
      token: TOKEN,
      json: { version: 2 },
    });
    expect(stale.status).toBe(409);
    const bad = await raw(h.base, "POST", "/api/sandbox/tools/shout/approve", {
      token: TOKEN,
      json: { version: "one" },
    });
    expect(bad.status).toBe(422);
    const ok = await raw(h.base, "POST", "/api/sandbox/tools/shout/approve", {
      token: TOKEN,
      json: { version: 1, note: "looks fine" },
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      status: "approved",
      reviewer: "api",
      review_note: "looks fine",
    });
    expect(await h.tools.approvedSpecs()).toHaveLength(1);

    // Only pending tools can be reviewed.
    const again = await raw(h.base, "POST", "/api/sandbox/tools/shout/reject", {
      token: TOKEN,
      json: { version: 1 },
    });
    expect(again.status).toBe(409);
    await h.tools.propose({ ...proposal, code: "print('v2')\n" }, "self");
    const rejected = await raw(h.base, "POST", "/api/sandbox/tools/shout/reject", {
      token: TOKEN,
      json: { version: 2, note: "no" },
    });
    expect(rejected.body).toMatchObject({ status: "rejected", version: 2 });
  });
});
