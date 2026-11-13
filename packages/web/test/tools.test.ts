// The two tools through the real actuator registry and gate: registration, the `tools.web`
// permission, failures as plain answers, results as untrusted data, and the module itself.

import { ActionDeniedError, ActuatorRegistry, type CapabilityTool } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import {
  type AccountRef,
  AuthorizerKey,
  type ContextKey,
  DATA_CLOSE,
  DATA_OPEN,
  Principals,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { WebConfigSchema } from "../src/config.js";
import { WebModule } from "../src/index.js";
import { WEB_NODE, webCapabilities, whoKey } from "../src/tools.js";
import { SEARCH_DOWN, WebService } from "../src/web.js";
import { fakeTransport, fixture, html, resolver } from "./helpers.js";

const ctx: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const acct = (id: string): AccountRef => ({ platform: "discord", id });
const ALICE = acct("1"); // member
const BOB = acct("2"); // no tools.web
let message = 0;

function rig(
  answer: () => Response = () => new Response(fixture("ddg-results.html"), { status: 200 }),
) {
  const services = new ServiceRegistry();
  services.provide("test", AuthorizerKey, {
    allows: (a: AccountRef, node: string) => a.id === ALICE.id && node === WEB_NODE,
  } as never);
  const registered = new Map<string, unknown>();
  const registry = new ActuatorRegistry({
    services,
    builtins: false,
    tools: {
      register: (t: { spec: { name: string } }) => registered.set(t.spec.name, t),
      get: (n: string) => registered.get(n),
      unregister: (n: string) => registered.delete(n),
    } as never,
  });
  const clock = { at: 5_000_000 };
  const web = new WebService({
    config: WebConfigSchema.parse({}),
    clock: { now: () => clock.at },
    fetch: (async () => answer()) as typeof fetch,
    sleep: async () => undefined,
    resolve: resolver(),
    transport: fakeTransport({
      "https://example.com/post": () => html(fixture("page.html")),
    }),
  });
  for (const c of webCapabilities(web)) registry.register(c);
  const tool = (name: string) => {
    const found = registered.get(name);
    if (!found) throw new Error(`no tool ${name}`);
    return found as CapabilityTool;
  };
  const call = (name: string, who: AccountRef, args: Record<string, unknown>) =>
    tool(name).call(
      {
        turn: `t${message}`,
        context: ctx,
        account: who,
        principal: Principals.user(who, ctx),
        message: { context: ctx, id: `m${message++}` },
        priority: "request",
        signal: new AbortController().signal,
      },
      args as never,
    );
  return { registry, registered, call, clock };
}

describe("registration", () => {
  it("offers web_search and web_read as low-risk capabilities behind tools.web", () => {
    const r = rig();
    expect([...r.registered.keys()].sort()).toEqual(["web_read", "web_search"]);
    for (const name of ["web.search", "web.read"]) {
      const c = r.registry.get(name);
      expect(c?.risk).toBe("low");
      expect(c?.permission).toBe("tools.web");
    }
    const spec = (r.registered.get("web_search") as CapabilityTool).spec;
    expect(spec.parameters).toMatchObject({
      required: ["query"],
      properties: { query: { type: "string" }, max: { type: "integer" } },
    });
    const read = (r.registered.get("web_read") as CapabilityTool).spec;
    expect(read.parameters).toMatchObject({ required: ["url"] });
  });

  it("withdraws the tools when the capabilities are unregistered", () => {
    const r = rig();
    r.registry.unregister("web.search");
    r.registry.unregister("web.read");
    expect(r.registered.size).toBe(0);
  });
});

describe("the gate", () => {
  it("answers a member's search with an untrusted block", async () => {
    const r = rig();
    const text = await r.call("web_search", ALICE, { query: "Claude Opus 5.5" });
    expect(text).toContain("Introducing Claude Opus 5.5 & friends");
    expect(text).toContain("https://www.anthropic.com/news/claude-opus-5-5");
    expect(text).toContain(`${DATA_OPEN} source="web`);
    expect(text.trimEnd().endsWith(DATA_CLOSE)).toBe(true);
  });

  it("answers a member's page read", async () => {
    const r = rig();
    const text = await r.call("web_read", ALICE, { url: "https://example.com/post" });
    expect(text).toContain("Second paragraph.");
    expect(text).toContain(`${DATA_OPEN} source="web`);
  });

  it("refuses someone without tools.web", async () => {
    const r = rig();
    await expect(r.call("web_search", BOB, { query: "x" })).rejects.toBeInstanceOf(
      ActionDeniedError,
    );
    await expect(
      r.call("web_read", BOB, { url: "https://example.com/post" }),
    ).rejects.toBeInstanceOf(ActionDeniedError);
  });

  it("lets her search on her own (on_own) without the person's permission", async () => {
    const r = rig();
    const text = await r.call("web_search", BOB, { query: "x", on_own: true });
    expect(text).toContain("搜尋");
  });

  it("rejects bad arguments", async () => {
    const r = rig();
    for (const args of [
      {},
      { query: "" },
      { query: "x".repeat(201) },
      { query: "x", max: 9 },
      { query: "x", max: 0 },
    ]) {
      await expect(r.call("web_search", ALICE, args), JSON.stringify(args)).rejects.toThrow();
    }
    await expect(r.call("web_read", ALICE, {})).rejects.toThrow();
  });

  it("tells her plainly when DuckDuckGo cannot be used", async () => {
    const r = rig(() => new Response(fixture("ddg-challenge.html"), { status: 200 }));
    await expect(r.call("web_search", ALICE, { query: "x" })).rejects.toThrow(SEARCH_DOWN);
  });

  it("tells her why a page is refused", async () => {
    const r = rig();
    await expect(r.call("web_read", ALICE, { url: "http://127.0.0.1/" })).rejects.toThrow(/不能讀/);
    await expect(r.call("web_read", ALICE, { url: "file:///etc/passwd" })).rejects.toThrow(/http/);
  });

  it("counts limits per person", async () => {
    const r = rig();
    for (let i = 0; i < 6; i++) await r.call("web_search", ALICE, { query: `q${i}` });
    await expect(r.call("web_search", ALICE, { query: "q6" })).rejects.toThrow(/查太多次/);
  });

  it("keys the limits on the asker, else on her own", () => {
    expect(whoKey(Principals.user(ALICE, ctx))).toBe("discord:1");
    expect(whoKey(Principals.self(ctx))).toBe("self");
  });
});

describe("module", () => {
  it("is module web with the section's config schema, enabled by default", () => {
    const m = new WebModule();
    expect(m.manifest.id).toBe("web");
    expect(WebConfigSchema.parse({})).toMatchObject({
      region: "tw-tzh",
      read_chars: 12_000,
      result_chars: 12_000,
      search_chars: 3900,
      search_per_person: 6,
      read_per_person: 10,
      search_global: 30,
      read_global: 60,
      window_s: 600,
      cache_ttl_s: 600,
      max_redirects: 3,
      max_download_bytes: 2_000_000,
      allow_ports: [],
    });
  });
});
