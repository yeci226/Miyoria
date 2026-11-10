// `/api/directives`: the panel says who is asking, and the rules decide what that person may do.

import { DirectiveService } from "@miyoria/directive";
import { ServiceRegistry, Supervisor, SupervisorKey } from "@miyoria/kernel";
import { openStore, type Store } from "@miyoria/store";
import {
  type AccountRef,
  AuthorizerKey,
  BaseAuthorizer,
  type Directive,
  DirectivesKey,
  type Subject,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { directiveRoutes } from "../src/directives.js";
import { ActiveProfileKey, ApiModule } from "../src/index.js";
import type { ApiContext, ApiState } from "../src/state.js";
import { raw } from "./support/http.js";

const TOKEN = "test-token";
const OWNER: AccountRef = { platform: "discord", id: "1" };
const MOD: AccountRef = { platform: "discord", id: "2" };
const VIEWER: AccountRef = { platform: "discord", id: "3" };

class Roles extends BaseAuthorizer {
  allowsSubject(subject: Subject, node: string): boolean {
    if (subject.account.id === OWNER.id) return true;
    if (subject.account.id === MOD.id) return node === "" || node === "admin.directive.add";
    return node === "";
  }
}

const sups: Supervisor[] = [];
const stores: Store[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  for (const s of stores.splice(0)) await s.close();
});

async function rules(services: ServiceRegistry) {
  const store = await openStore("memory://");
  stores.push(store);
  services.provide("test", AuthorizerKey, new Roles());
  const service = new DirectiveService({ services, store: store.directives, profile: "p" });
  await service.refresh();
  services.provide("kernel", DirectivesKey, service);
  return service;
}

async function harness() {
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", SupervisorKey, sup);
  sup.services.provide("kernel", ActiveProfileKey, "p");
  const service = await rules(sup.services);
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "" }, true);
  await sup.startAll();
  const base = api.url();
  if (!base) throw new Error("api is not running");
  const call = (method: string, path: string, body?: unknown) =>
    raw(base, method, path, { token: TOKEN, ...(body === undefined ? {} : { json: body }) });
  return { base, service, call };
}

/** A request of a panel session, for the routes that look at the account. */
function session(account: AccountRef, body: unknown, id = ""): ApiContext {
  return {
    get: () => ({ kind: "session", write: true, record: { account } }),
    req: {
      param: () => id,
      query: () => undefined,
      header: () => "application/json",
      text: async () => JSON.stringify(body),
    },
  } as unknown as ApiContext;
}

async function sessionRoutes() {
  const services = new ServiceRegistry();
  const service = await rules(services);
  const state = { service: () => service } as unknown as ApiState;
  const routes = directiveRoutes(state);
  const post = routes.find((r) => r.method === "POST");
  const del = routes.find((r) => r.method === "DELETE");
  if (!post || !del) throw new Error("no routes");
  return { service, post, del };
}

const NO_MINECRAFT = {
  text: "不要玩 Minecraft",
  effect: "deny",
  scope: { activity: "minecraft" },
};

describe("/api/directives", () => {
  it("needs a login", async () => {
    const h = await harness();
    expect((await raw(h.base, "GET", "/api/directives")).status).toBe(401);
    expect((await raw(h.base, "POST", "/api/directives")).status).toBe(401);
  });

  it("the bearer token makes, lists and removes rules", async () => {
    const h = await harness();
    const made = await h.call("POST", "/api/directives", NO_MINECRAFT);
    expect(made.status).toBe(201);
    const { directive } = made.body as { directive: Directive };
    expect(directive).toMatchObject({ authority: "owner", expires: "until_revoked" });

    const listed = await h.call("GET", "/api/directives");
    expect(listed.body).toMatchObject({ healthy: true, directives: [{ id: directive.id }] });

    expect((await h.call("DELETE", `/api/directives/${directive.id}`)).status).toBe(200);
    expect((await h.call("GET", "/api/directives")).body).toMatchObject({ directives: [] });
    const history = await h.call("GET", "/api/directives?history=1");
    expect(history.body).toMatchObject({ directives: [{ revoked_by: "api" }] });
    expect((await h.call("DELETE", `/api/directives/${directive.id}`)).status).toBe(404);
  });

  it("an unclear rule comes back as a question and nothing is made", async () => {
    const h = await harness();
    const r = await h.call("POST", "/api/directives", { text: "不要這樣", effect: "deny" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "question" });
    expect(await h.service.list()).toEqual([]);
  });

  it("rejects what is not a rule", async () => {
    const h = await harness();
    const r = await h.call("POST", "/api/directives", { text: "x", effect: "allow" });
    expect(r.status).toBe(422);
  });

  it("a moderator's session has a moderator's rights", async () => {
    const { post, del, service } = await sessionRoutes();
    const owner = await post.handler(session(OWNER, NO_MINECRAFT));
    const { directive } = (await owner.json()) as { directive: Directive };

    const open = await post.handler(session(MOD, NO_MINECRAFT));
    expect((await open.json()) as object).toMatchObject({ status: "question" });
    const timed = await post.handler(session(MOD, { ...NO_MINECRAFT, minutes: 30 }));
    expect(timed.status).toBe(201);
    expect((await timed.json()) as object).toMatchObject({ directive: { authority: "moderator" } });

    await expect(del.handler(session(MOD, null, directive.id))).rejects.toMatchObject({
      status: 403,
    });
    await expect(del.handler(session(VIEWER, null, directive.id))).rejects.toMatchObject({
      status: 403,
    });
    expect(await service.list()).toHaveLength(2);
  });

  it("a session's body cannot say who it is", async () => {
    const { post, service } = await sessionRoutes();
    await post.handler(
      session(VIEWER, { ...NO_MINECRAFT, authority: "owner", issuer: OWNER, by: "console" }),
    );
    expect(await service.list()).toMatchObject([
      { authority: "viewer", effect: "prefer", issuer: VIEWER },
    ]);
  });
});
