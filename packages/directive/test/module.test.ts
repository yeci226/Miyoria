// The module: what it serves, what it follows on the log, and what stays when it stops.

import {
  CommandRegistry,
  CommandRegistryKey,
  type InvocationData,
  Permissions,
} from "@miyoria/commands";
import { Supervisor } from "@miyoria/kernel";
import { ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import { DirectivesKey, EventLogKey, ProposalBoardKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { DirectiveModule } from "../src/index.js";
import {
  CTX,
  closeStores,
  MOD,
  OWNER,
  ownerRule,
  proposal,
  self,
  VIEWER,
  world,
} from "./helpers.js";

const sups: Supervisor[] = [];
afterEach(async () => {
  for (const s of sups.splice(0)) await s.stopAll();
  await closeStores();
});

async function running() {
  const w = await world();
  const sup = new Supervisor();
  sups.push(sup);
  sup.services.provide("kernel", DirectivesKey, w.rules);
  sup.services.provide("kernel", EventLogKey, w.log);
  sup.services.provide("kernel", ProposalBoardKey, w.board);
  const tools = new ToolRegistry();
  sup.services.provide("kernel", ToolRegistryKey, tools);
  const commands = new CommandRegistry(Permissions.fromStrings([`discord:${OWNER.id}`]), {
    services: w.services,
  });
  sup.services.provide("kernel", CommandRegistryKey, commands);
  const module = new DirectiveModule();
  await sup.register(module, { viewer_ttl_mins: 3 }, true);
  await sup.startAll();
  return { w, sup, tools, commands };
}

const command = (path: string, invoker: typeof OWNER, args: InvocationData["args"] = {}) => ({
  path: path.split(" "),
  args,
  invoker,
  invoker_display_name: invoker.id,
  context: CTX,
  invoker_is_guild_admin: false,
});

describe("module directive", () => {
  it("serves the tools and applies its config", async () => {
    const h = await running();
    expect(h.tools.names()).toEqual(["directive_add", "directive_remove"]);
    expect(h.w.rules.config.viewer_ttl_mins).toBe(3);
  });

  it("drops a proposal the moment it reaches the log", async () => {
    const h = await running();
    await ownerRule(h.w, { text: "不要玩 Minecraft", activity: "minecraft" });
    // Whoever wrote it: a line on the log is enough, it need not come through `propose`.
    h.w.log.append({
      kind: "proposal",
      source: "plan",
      context: CTX,
      body: {
        proposal: { ...proposal(h.w, { what: "想開遊戲", capability: "game.start" }), id: "p1" },
      } as never,
    });
    expect(h.w.board.open().map((p) => p.id)).toEqual(["p1"]);
    await Promise.resolve();
    expect(h.w.board.open()).toEqual([]);
    expect(h.w.log.recent().find((e) => e.kind === "result")?.body).toMatchObject({
      proposal: "p1",
      state: "dropped",
    });
  });

  it("stopping it takes the tools away and leaves the rules standing", async () => {
    const h = await running();
    await ownerRule(h.w, { text: "不要玩 Minecraft", activity: "minecraft" });
    await h.sup.stopAll();
    expect(h.tools.names()).toEqual([]);
    expect(await h.w.rules.check({ capability: "game.start", principal: self() })).toMatchObject({
      outcome: "deny",
    });
  });
});

describe("the commands", () => {
  it("make a rule, and the list shows it", async () => {
    const h = await running();
    const asked = await h.commands.dispatch(
      command("admin directive add", OWNER, {
        text: "不要玩 Minecraft",
        effect: "deny",
        activity: "minecraft",
      }),
    );
    expect(asked.text).toContain("已建立規則");
    expect(await h.w.rules.list()).toMatchObject([{ authority: "owner" }]);
    const listed = await h.commands.dispatch(command("admin directive list", OWNER));
    expect(listed.text).toContain("不要玩 Minecraft");
  });

  it("a moderator is asked for a time, and cannot touch the owner's rule", async () => {
    const h = await running();
    await ownerRule(h.w, { text: "不要玩 Minecraft", activity: "minecraft" });
    const add = (minutes?: number) =>
      h.commands.dispatch(
        command("admin directive add", MOD, {
          text: "不要開台",
          effect: "deny",
          capability: "stream.start",
          ...(minutes === undefined ? {} : { minutes }),
        }),
      );
    expect((await add()).text).toContain("要維持多久");
    expect((await add(30)).text).toContain("已建立規則");
    const refused = await h.commands.dispatch(
      command("admin directive remove", MOD, { rule: "minecraft" }),
    );
    expect(refused.text).toContain("只有主人");
    expect(await h.w.rules.list()).toHaveLength(2);
  });

  it("a person without the node does not get past the door, and the rule stays", async () => {
    const h = await running();
    await ownerRule(h.w, { text: "不要玩 Minecraft", activity: "minecraft" });
    const refused = await h.commands.dispatch(
      command("admin directive remove", VIEWER, { rule: "minecraft" }),
    );
    expect(refused.text).not.toContain("已解除");
    expect(await h.w.rules.list()).toHaveLength(1);
  });

  it("removes by the short number the list shows", async () => {
    const h = await running();
    const rule = await ownerRule(h.w, { text: "不要玩 Minecraft", activity: "minecraft" });
    const done = await h.commands.dispatch(
      command("admin directive remove", OWNER, { rule: rule.id.slice(-6) }),
    );
    expect(done.text).toContain("已解除規則");
    expect(await h.w.rules.list()).toEqual([]);
  });

  it("answers a blank list and a broken store in neutral words", async () => {
    const h = await running();
    expect((await h.commands.dispatch(command("admin directive list", OWNER))).text).toContain(
      "目前沒有規則",
    );
    h.w.flaky.fail = true;
    expect((await h.commands.dispatch(command("admin directive list", OWNER))).text).toContain(
      "讀不到",
    );
  });
});
