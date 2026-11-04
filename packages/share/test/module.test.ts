import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/actions";
import { Supervisor } from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import { MemorySettingsStore, SettingsStoreKey } from "@miyoria/store";
import { type Tool, ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import { Principals } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ShareModule } from "../src/module.js";

const OK = JSON.stringify({ logged_in: true, posts: [] });

function hanging(name: string, gate: Promise<string>, calls: string[]): Tool {
  return {
    spec: { name, description: name, parameters: { type: "object" } },
    call: async () => {
      calls.push(name);
      return gate;
    },
  };
}

class Rig {
  readonly sup = new Supervisor();
  readonly tools = new ToolRegistry();
  readonly registry: ActuatorRegistry;
  readonly calls: string[] = [];
  modelCalls = 0;
  release: (reply: string) => void = () => {};

  constructor() {
    const s = this.sup.services;
    this.registry = new ActuatorRegistry({ services: s, builtins: false });
    s.provide("app", ActuatorRegistryKey, this.registry);
    s.provide("app", ToolRegistryKey, this.tools);
    s.provide("store", SettingsStoreKey, new MemorySettingsStore());
    s.provide("llm", LlmRouterKey, {
      budgetState: () => "ok",
      complete: async () => {
        this.modelCalls++;
        throw new Error("no model here");
      },
    } as never);
  }

  addFeed(): void {
    const gate = new Promise<string>((resolve) => {
      this.release = resolve;
    });
    this.tools.register(hanging("internal_threads_feed", gate, this.calls));
    this.tools.register(hanging("internal_threads_close", Promise.resolve("closed"), this.calls));
  }

  async start(): Promise<void> {
    const module = new ShareModule({
      baseDir: mkdtempSync(join(tmpdir(), "miyoria-share-module-")),
      persona: () => "鯨魚娘",
      owners: () => [],
    });
    await this.sup.register(module, { quiet_hours: "" }, true);
    await this.sup.startAll();
  }

  browse() {
    return this.registry.invoke({
      principal: Principals.self(null, null),
      capability: "share.browse",
      args: {},
      why: null,
      turn: null,
    });
  }
}

describe("ShareModule", () => {
  let rig: Rig;

  afterEach(async () => {
    rig.release(OK);
    await rig.sup.stopAll();
  });

  it("share.browse is not offered to chat", async () => {
    rig = new Rig();
    await rig.start();
    const capability = rig.registry.get("share.browse");
    expect(capability?.tool ?? null).toBeNull();
    expect(capability?.risk).toBe("medium");
  });

  it("share.browse starts a round and returns at once", async () => {
    rig = new Rig();
    rig.addFeed();
    await rig.start();
    const outcome = await rig.browse();
    expect(outcome.status).toBe("done");
    await expect.poll(() => rig.calls).toContain("internal_threads_feed");
    expect(rig.calls).not.toContain("internal_threads_close");
  });

  it("refuses while not available", async () => {
    rig = new Rig();
    await rig.start();
    expect(rig.registry.get("share.browse")?.available?.()).toBe(false);
    expect((await rig.browse()).status).not.toBe("done");
  });

  it("is offered once the extension runs", async () => {
    rig = new Rig();
    await rig.start();
    rig.addFeed();
    expect(rig.registry.get("share.browse")?.available?.()).toBe(true);
  });

  it("a stopped module aborts its round", async () => {
    rig = new Rig();
    rig.addFeed();
    await rig.start();
    await rig.browse();
    await expect.poll(() => rig.calls).toContain("internal_threads_feed");
    const stopped = rig.sup.stopAll();
    rig.release(
      JSON.stringify({
        logged_in: true,
        posts: [
          { link: "/@a/post/1", author: "a", age: null, body: "夠長的一則貼文內容", images: 0 },
        ],
      }),
    );
    await stopped;
    expect(rig.modelCalls).toBe(0);
    expect(rig.calls).toContain("internal_threads_close");
  });
});
