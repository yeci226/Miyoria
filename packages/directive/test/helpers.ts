// The rules on a real SQLite store, a real EventLog and a real gate, with people whose roles come
// from the built-in role table. The only fakes are the capabilities themselves.

import {
  ActuatorRegistry,
  ActuatorRegistryKey,
  type Capability,
  defineCapability,
} from "@miyoria/actions";
import { builtinRole, granted } from "@miyoria/commands";
import { EventLogService } from "@miyoria/facts";
import { ServiceRegistry } from "@miyoria/kernel";
import { AuditLogKey, type DirectiveStore, SqliteStore, type Store } from "@miyoria/store";
import { type ToolContext, ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  AuthorizerKey,
  BaseAuthorizer,
  type ContextKey,
  type Directive,
  type DirectiveActor,
  DirectivesKey,
  EventLogKey,
  type JsonObject,
  type NewProposal,
  type Principal,
  Principals,
  ProposalBoardKey,
  type Subject,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { Proposals } from "../../agent/src/mainline/proposals.js";
import { DirectiveService } from "../src/index.js";

export const PROFILE = "miyoria";
export const CTX: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
export const ELSEWHERE: ContextKey = { ...CTX, channel: "c2" };
export const OWNER: AccountRef = { platform: "discord", id: "1" };
export const MOD: AccountRef = { platform: "discord", id: "2" };
export const VIEWER: AccountRef = { platform: "discord", id: "3" };
export const VIEWER2: AccountRef = { platform: "discord", id: "4" };
export const BLOCKED: AccountRef = { platform: "discord", id: "5" };
export const HER: AccountRef = { platform: "discord", id: "99" };
export const T0 = Date.UTC(2026, 10, 7, 12);
export const MINUTE = 60_000;

const ROLES: Readonly<Record<string, string>> = {
  [OWNER.id]: "owner",
  [MOD.id]: "moderator",
  [BLOCKED.id]: "blocked",
};

/** Roles by account id, with the grants of the real built-in roles. */
export class Roles extends BaseAuthorizer {
  allowsSubject(subject: Subject, node: string): boolean {
    const role = builtinRole(ROLES[subject.account.id] ?? "user");
    if (role === undefined) return false;
    if (node === "") return role.rank > 0;
    return granted(role.grants, role.denies, node);
  }
}

/** A store that stops answering when told to. */
export class FlakyStore implements DirectiveStore {
  fail = false;
  hang = false;

  constructor(readonly inner: DirectiveStore) {}

  #guard<T>(run: () => Promise<T>): Promise<T> {
    if (this.hang) return new Promise<T>(() => {});
    if (this.fail) return Promise.reject(new Error("database is locked"));
    return run();
  }

  insert: DirectiveStore["insert"] = (p, d) => this.#guard(() => this.inner.insert(p, d));
  active: DirectiveStore["active"] = (p, n) => this.#guard(() => this.inner.active(p, n));
  all: DirectiveStore["all"] = (p, l) => this.#guard(() => this.inner.all(p, l));
  revoke: DirectiveStore["revoke"] = (p, i, b, a) =>
    this.#guard(() => this.inner.revoke(p, i, b, a));
  prune: DirectiveStore["prune"] = (p, b) => this.#guard(() => this.inner.prune(p, b));
}

/** What ran past the gate. */
export interface Ran {
  capability: string;
  args: unknown;
}

function capabilities(ran: Ran[]): Capability[] {
  const record = async (capability: string, args: unknown) => {
    ran.push({ capability, args });
    return "ok";
  };
  const defaultGame = "minecraft";
  return [
    defineCapability({
      name: "game.start",
      summary: "開始玩遊戲",
      risk: "low",
      args: z.object({ game: z.string().optional() }),
      permission: null,
      tool: { name: "game_start", description: "開始玩", properties: {} },
      activity: (args) => [
        { type: "start", activity: "game", target: args.game ?? defaultGame, goal: null },
      ],
      execute: (args) => record("game.start", args),
    }),
    defineCapability({
      name: "game.stop",
      summary: "停止玩遊戲",
      risk: "low",
      args: z.object({}),
      permission: null,
      tool: { name: "game_stop", description: "停止", properties: {} },
      execute: (args) => record("game.stop", args),
    }),
    defineCapability({
      name: "game.goal",
      summary: "指定目標",
      risk: "low",
      args: z.object({ text: z.string() }),
      permission: null,
      tool: { name: "game_goal", description: "目標", properties: {} },
      execute: (args) => record("game.goal", args),
    }),
    defineCapability({
      name: "game.act",
      summary: "在遊戲裡做事",
      risk: "low",
      args: z.looseObject({ game: z.string() }),
      permission: null,
      execute: (args) => record("game.act", args),
    }),
    defineCapability({
      name: "stream.start",
      summary: "開台",
      risk: "low",
      args: z.object({}),
      permission: null,
      tool: { name: "stream_start", description: "開台", properties: {} },
      execute: (args) => record("stream.start", args),
    }),
  ] as Capability[];
}

export interface World {
  store: Store;
  flaky: FlakyStore;
  services: ServiceRegistry;
  rules: DirectiveService;
  log: EventLogService;
  board: Proposals;
  registry: ActuatorRegistry;
  tools: ToolRegistry;
  ran: Ran[];
  /** Moves the clock. */
  pass(ms: number): void;
  now(): number;
}

const open: Store[] = [];

export async function closeStores(): Promise<void> {
  for (const store of open.splice(0)) await store.close();
}

export async function world(path = ":memory:"): Promise<World> {
  let t = T0;
  const clock = { now: () => t };
  const store = await SqliteStore.open(path, { clock });
  open.push(store);
  const flaky = new FlakyStore(store.directives);
  const services = new ServiceRegistry();
  services.provide("test", AuthorizerKey, new Roles());
  services.provide("test", AuditLogKey, store.audit);
  const log = new EventLogService({ profile: PROFILE, store: null, clock });
  services.provide("test", EventLogKey, log);
  const board = new Proposals({ log: () => log, now: () => t, services });
  await log.project(board);
  services.provide("test", ProposalBoardKey, board);
  const tools = new ToolRegistry();
  services.provide("test", ToolRegistryKey, tools);
  const registry = new ActuatorRegistry({ services, tools, clock, builtins: false });
  services.provide("test", ActuatorRegistryKey, registry);
  const ran: Ran[] = [];
  for (const capability of capabilities(ran)) registry.register(capability);
  const rules = new DirectiveService({ services, store: flaky, profile: PROFILE, clock });
  await rules.refresh();
  services.provide("test", DirectivesKey, rules);
  return {
    store,
    flaky,
    services,
    rules,
    log,
    board,
    registry,
    tools,
    ran,
    pass: (ms) => {
      t += ms;
    },
    now: () => t,
  };
}

export function person(account: AccountRef, context: ContextKey = CTX): DirectiveActor {
  return {
    type: "account",
    subject: { account, context, platform_roles: [], is_guild_admin: false },
  };
}

/** A rule the owner made through the request path. */
export async function ownerRule(
  w: World,
  rule: { text: string; capability?: string; activity?: string; minutes?: number },
  effect: Directive["effect"] = "deny",
): Promise<Directive> {
  const scope = {
    ...(rule.capability === undefined ? {} : { capability: rule.capability }),
    ...(rule.activity === undefined ? {} : { activity: rule.activity }),
  };
  const change = await w.rules.add({
    by: person(OWNER),
    text: rule.text,
    effect,
    scope,
    minutes: rule.minutes ?? null,
    source_event: "msg:m1",
  });
  if (change.status !== "added") throw new Error(`no rule: ${JSON.stringify(change)}`);
  return change.directive;
}

/** What a tool sees in a turn: `principal` is who the turn runs for. */
export function toolContext(
  principal: Principal,
  account: AccountRef = principal.requester ?? HER,
  extra: Partial<ToolContext> = {},
): ToolContext {
  return {
    turn: "t1",
    context: CTX,
    account,
    principal,
    message: { context: CTX, id: "m1" },
    priority: "direct",
    signal: new AbortController().signal,
    ...extra,
  };
}

/** What a viewer's message turns into. */
export const viewerTurn = (who: AccountRef = VIEWER) => toolContext(Principals.user(who, CTX));

export function proposal(w: World, fields: Partial<NewProposal> & { what: string }): NewProposal {
  return {
    why: "想做",
    expires: toTimestamp(w.now() + 10 * MINUTE),
    source: "plan",
    context: CTX,
    about: null,
    person: null,
    goal: null,
    ...fields,
  };
}

export const self = () => Principals.self(CTX);

export const gameArgs = (fields: JsonObject = {}) => ({ game: "minecraft", ...fields });
