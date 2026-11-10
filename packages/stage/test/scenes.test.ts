// Scene roles (classification, overrides, transitions), the scene director (switching rules,
// debounce, manual hold, the ending curtain), the gate routing of `stage.scene` and transitions
// on the Stage side with a fake OBS.

import { ActuatorRegistry } from "@miyoria/actions";
import { ServiceRegistry } from "@miyoria/kernel";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  LlmRouter,
  parseModelRef,
} from "@miyoria/llm";
import { MemorySettingsStore } from "@miyoria/store";
import { ToolRegistry } from "@miyoria/tools";
import { type JsonObject, Principals } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyByKeywords,
  defaultStageStatus,
  encodeMessage,
  type Obs,
  ObsConfigSchema,
  ObsController,
  parseClassification,
  parseCoreMessage,
  SCENE_ROLES_KEY,
  SceneDirector,
  SceneRoleError,
  SceneRoles,
  type ScenesConfig,
  ScenesConfigSchema,
  type StageLink,
  type StageStatus,
  sceneTarget,
  stageCapabilities,
} from "../src/index.js";
import { FakeObs } from "./common.js";

const SCENES = ["Just Chatting", "Gameplay", "BRB", "Starting Soon", "Ending", "Camera"];

class FnProvider implements ChatProvider {
  readonly name = "fn";
  readonly requests: ChatRequest[] = [];

  constructor(private readonly reply: (req: ChatRequest) => string) {}

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    const text = this.reply(request);
    return (async function* () {
      yield { type: "text_delta" as const, text };
      yield { type: "done" as const, finish_reason: "stop", usage: null };
    })();
  }
}

function router(provider: ChatProvider): LlmRouter {
  return new LlmRouter(
    new Map([[provider.name, provider]]),
    new Map([["fast", [parseModelRef(`${provider.name}:m`)]]]),
  );
}

function config(overrides: Partial<ScenesConfig> = {}): ScenesConfig {
  return { ...ScenesConfigSchema.parse({}), ...overrides };
}

function roles(
  cfg: ScenesConfig = config(),
  opts: { llm?: LlmRouter; store?: MemorySettingsStore } = {},
): SceneRoles {
  return new SceneRoles(cfg, {
    settings: () => opts.store,
    router: () => opts.llm,
    signal: new AbortController().signal,
  });
}

describe("scene roles", () => {
  it("classifies by keywords without an LLM", () => {
    expect(classifyByKeywords(SCENES)).toEqual({
      chat: "Just Chatting",
      game: "Gameplay",
      brb: "BRB",
      starting: "Starting Soon",
      ending: "Ending",
    });
    expect(classifyByKeywords(["雜談", "遊戲畫面", "休息一下", "開場", "下播"])).toEqual({
      chat: "雜談",
      game: "遊戲畫面",
      brb: "休息一下",
      starting: "開場",
      ending: "下播",
    });
    expect(classifyByKeywords(["Scene", "Scene 2"])).toEqual({});
  });

  it("only takes listed scenes from the model's answer", () => {
    const answer =
      'ok:\n```json\n{"chat":"just chatting","game":"Gameplay","brb":"Nope","starting":null,"evil":"Camera"}\n```';
    expect(parseClassification(answer, SCENES)).toEqual({
      chat: "Just Chatting",
      game: "Gameplay",
    });
    expect(() => parseClassification("no json here", SCENES)).toThrow(/not a JSON object/);
  });

  it("classifies a new scene list with the fast model once and stores it", async () => {
    const provider = new FnProvider(() =>
      JSON.stringify({
        chat: "Camera",
        game: "Gameplay",
        brb: "BRB",
        starting: null,
        ending: "Ending",
      }),
    );
    const store = new MemorySettingsStore();
    const r = roles(config(), { llm: router(provider), store });
    r.observe(SCENES);
    await r.idle();
    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0];
    expect(req?.json_mode).toBe(true);
    // The names are data in the prompt.
    expect(req?.messages[1]?.content).toContain("⟦資料 來源=obs");
    expect(req?.messages[1]?.content).toContain("- Gameplay");
    expect(r.resolve("chat")).toBe("Camera");
    expect(r.resolve("starting")).toBeNull();
    expect(r.view().classified_by).toBe("llm");
    expect(await store.get("_global", SCENE_ROLES_KEY)).toMatchObject({
      scenes: SCENES,
      by: "llm",
      auto: { chat: "Camera", game: "Gameplay" },
    });

    // The same list (in any order) is not classified again, also after a restart.
    r.observe([...SCENES].reverse());
    await r.idle();
    const again = roles(config(), { llm: router(provider), store });
    await again.load();
    again.observe(SCENES);
    await again.idle();
    expect(provider.requests).toHaveLength(1);
    expect(again.resolve("game")).toBe("Gameplay");

    // A changed list is.
    again.observe([...SCENES, "Intermission"]);
    await again.idle();
    expect(provider.requests).toHaveLength(2);
  });

  it("falls back to keywords when the model fails", async () => {
    const provider = new FnProvider(() => "I cannot do that");
    const r = roles(config(), { llm: router(provider) });
    r.observe(SCENES);
    await r.idle();
    expect(r.view().classified_by).toBe("heuristic");
    expect(r.resolve("game")).toBe("Gameplay");
  });

  it("the panel overrides the classification and config overrides both", async () => {
    const store = new MemorySettingsStore();
    const r = roles(config({ roles: { ending: "Camera", intermission: "BRB" } }), { store });
    r.observe(SCENES);
    await r.idle();
    expect(r.resolve("ending")).toBe("Camera");
    expect(r.resolve("intermission")).toBe("BRB");
    expect(r.roles()).toEqual([
      "chat",
      "game",
      "brb",
      "starting",
      "ending",
      "sing",
      "intermission",
    ]);

    await r.set("chat", "camera");
    expect(r.resolve("chat")).toBe("Camera");
    const chat = r.view().roles.find((v) => v.role === "chat");
    expect(chat).toEqual({
      role: "chat",
      label: "聊天",
      scene: "Camera",
      source: "panel",
      auto: "Just Chatting",
      locked: false,
    });
    expect(r.view().roles.find((v) => v.role === "ending")).toMatchObject({
      source: "config",
      locked: true,
    });
    await expect(r.set("ending", "BRB")).rejects.toThrow(SceneRoleError);
    await expect(r.set("chat", "Nope")).rejects.toThrow(/no scene `Nope`/);
    await expect(r.set("Bad Role", "BRB")).rejects.toThrow(/lower-case/);

    // Cleared: back to the classification. Stored for the next start.
    await r.set("chat", null);
    expect(r.resolve("chat")).toBe("Just Chatting");
    await r.set("game", "Camera");
    const next = roles(config(), { store });
    await next.load();
    next.observe(SCENES);
    await next.idle();
    expect(next.resolve("game")).toBe("Camera");
    expect(next.roleOf("Gameplay")).toBeNull();
    expect(next.roleOf("Camera")).toBe("game");
  });

  it("picks the role's transition, else the default", () => {
    const r = roles(
      config({
        transition: { name: "Fade", duration_ms: 300 },
        transitions: { game: { name: "Stinger", duration_ms: null } },
      }),
    );
    expect(r.transition("game")).toEqual({ name: "Stinger", duration_ms: null });
    expect(r.transition("chat")).toEqual({ name: "Fade", duration_ms: 300 });
    expect(r.transition(null)).toEqual({ name: "Fade", duration_ms: 300 });
    expect(roles().transition("game")).toBeNull();
  });
});

// ----- the gate -----

function fakeLink(scenes: string[]) {
  const calls: { name: string; transition: unknown }[] = [];
  let status: StageStatus = {
    ...defaultStageStatus(),
    obs: true,
    scene: scenes[0] ?? null,
    scenes,
  };
  const link = {
    isConnected: () => true,
    status: () => status,
    setScene: async (name: string, transition: unknown = null) => {
      calls.push({ name, transition });
      status = { ...status, scene: name };
      return status;
    },
    stream: async () => status,
  } as unknown as StageLink;
  return { link, calls };
}

describe("stage.scene through the gate", () => {
  it("accepts a role or a name and sends the role's transition", async () => {
    const { link, calls } = fakeLink(SCENES);
    const r = roles(config({ transition: { name: "Fade", duration_ms: 250 } }));
    r.observe(SCENES);
    await r.idle();
    expect(sceneTarget({ role: "game" }, link, r)).toMatchObject({
      ok: true,
      scene: "Gameplay",
      role: "game",
    });
    expect(sceneTarget({ name: "brb" }, link, r)).toMatchObject({
      ok: true,
      scene: "BRB",
      role: "brb",
    });
    expect(sceneTarget({ name: "camera" }, link, r)).toMatchObject({
      ok: true,
      scene: "Camera",
      role: null,
    });
    expect(sceneTarget({ role: "intermission" }, link, r)).toEqual({
      ok: false,
      why: "no scene is set for role `intermission`",
    });

    const registry = new ActuatorRegistry({
      services: new ServiceRegistry(),
      tools: new ToolRegistry(),
      builtins: false,
    });
    for (const c of stageCapabilities(link, { roles: r })) registry.register(c);
    const invoke = (principal: ReturnType<typeof Principals.director>, args: JsonObject) =>
      registry.invoke({ principal, capability: "stage.scene", args, why: "test", turn: null });

    const out = await invoke(Principals.director(null), { role: "game" });
    expect(out.status).toBe("done");
    expect(calls).toEqual([{ name: "Gameplay", transition: { name: "Fade", duration_ms: 250 } }]);
    expect((await invoke(Principals.director(null), { role: "nothing" })).status).toBe("denied");
    expect((await invoke(Principals.director(null), {})).status).toBe("denied");

    // Paused: the director stops, the panel still works.
    await registry.setPaused(true);
    const paused = await invoke(Principals.director(null), { role: "chat" });
    expect(paused.status === "denied" && paused.decision.stage).toBe("pause");
    expect((await invoke(Principals.panel("api"), { role: "chat" })).status).toBe("done");
    expect(calls.at(-1)?.name).toBe("Just Chatting");
  });
});

// ----- the director -----

interface Rig {
  director: SceneDirector;
  switches: string[];
  /** The scene OBS shows. */
  scene: () => string;
  /** OBS reports a scene (as if someone switched). */
  show: (scene: string, streaming?: boolean) => void;
  allow: { value: boolean };
}

async function rig(cfg: Partial<ScenesConfig> = {}, scenes: string[] = SCENES): Promise<Rig> {
  const r = roles(config(cfg));
  r.observe(scenes);
  await r.idle();
  const switches: string[] = [];
  const allow = { value: true };
  let current = scenes[0] ?? "";
  let streaming = false;
  // Declared first: the switcher below reports back to it.
  let director: SceneDirector;
  director = new SceneDirector({
    config: config(cfg),
    roles: r,
    switchRole: async (role) => {
      if (!allow.value) return false;
      const scene = r.resolve(role);
      if (scene === null) return false;
      switches.push(role);
      current = scene;
      director.onStatus({ obs: true, streaming, scene });
      return true;
    },
  });
  const show = (scene: string, live = streaming) => {
    current = scene;
    streaming = live;
    director.onStatus({ obs: true, streaming, scene });
  };
  show(current, false);
  return { director, switches, scene: () => current, show, allow };
}

async function ms(n: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(n);
}

describe("scene director", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.UTC(2026, 10, 2, 20, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives a game with a role of its own (threads) that scene, others the game scene", async () => {
    const t = await rig({ roles: { threads: "Camera" } });
    t.director.onGame(true, "threads");
    await ms(1_600);
    expect(t.switches).toEqual(["threads"]);
    expect(t.scene()).toBe("Camera");
    // Another game without a scene of its own: the game scene.
    t.director.onGame(true, "minecraft");
    await ms(10_000); // past the minimum gap between automatic switches
    expect(t.switches).toEqual(["threads", "game"]);
    expect(t.scene()).toBe("Gameplay");
    t.director.stop();
  });

  it("does nothing at boot and follows a game session", async () => {
    const t = await rig();
    await ms(60_000);
    expect(t.switches).toEqual([]);
    t.director.onGame(true);
    await ms(1_000);
    expect(t.switches, "debounced").toEqual([]);
    await ms(600);
    expect(t.switches).toEqual(["game"]);
    expect(t.scene()).toBe("Gameplay");
    t.director.onGame(false);
    await ms(10_000);
    expect(t.switches).toEqual(["game", "chat"]);
    expect(t.scene()).toBe("Just Chatting");
    t.director.stop();
  });

  it("never flaps: quick changes coalesce, switches keep their distance", async () => {
    const t = await rig();
    t.director.onGame(true);
    await ms(500);
    t.director.onGame(false);
    await ms(500);
    t.director.onGame(true);
    await ms(2_000);
    expect(t.switches).toEqual(["game"]);
    // Stopping right after: waits for `min_switch_ms` (8 s) since the last switch.
    t.director.onGame(false);
    await ms(3_000);
    expect(t.switches).toEqual(["game"]);
    await ms(6_000);
    expect(t.switches).toEqual(["game", "chat"]);
    t.director.stop();
  });

  it("goes live through starting, then chat, and ends on the ending scene", async () => {
    const t = await rig({ starting_ms: 30_000 });
    t.director.onGoLive("g1", "starting");
    await ms(10);
    expect(t.switches, "starting is urgent").toEqual(["starting"]);
    t.director.onGoLive("g1", "live");
    await ms(29_000);
    expect(t.switches).toEqual(["starting"]);
    await ms(2_000);
    expect(t.switches).toEqual(["starting", "chat"]);
    t.director.onGoLive("g1", "stopped");
    await ms(10);
    expect(t.switches).toEqual(["starting", "chat", "ending"]);
    // The ending scene stays up after the stream.
    await ms(60_000);
    expect(t.switches.at(-1)).toBe("ending");
    t.director.stop();
  });

  it("falls back to chat without a starting scene", async () => {
    const t = await rig({}, ["Talk", "Game"]);
    t.show("Game");
    t.director.onGoLive("g1", "starting");
    await ms(10);
    expect(t.switches).toEqual(["chat"]);
    t.director.stop();
  });

  it("going live while playing without a starting scene keeps the game scene", async () => {
    const t = await rig({}, ["Talk", "Game"]);
    t.director.onGame(true);
    await ms(2_000);
    expect(t.switches).toEqual(["game"]);
    t.director.onGoLive("g1", "starting");
    await ms(60_000);
    expect(t.switches).toEqual(["game"]);
    t.director.stop();
  });

  it("stays out of the way after a manual switch", async () => {
    const t = await rig({ manual_hold_ms: 60_000 });
    t.show("Camera");
    t.director.onGame(true);
    await ms(30_000);
    expect(t.switches).toEqual([]);
    await ms(31_000);
    expect(t.switches).toEqual(["game"]);
    t.director.stop();
  });

  it("goes to brb when nobody talks or she left voice, and comes back", async () => {
    const t = await rig({ starting_ms: 0, brb_after_ms: 120_000 });
    t.director.onVoice("discord:g1:voice:v1", true);
    t.show("Just Chatting", true);
    await ms(10);
    expect(t.switches).toEqual([]);
    await ms(100_000);
    t.director.onActivity();
    await ms(100_000);
    expect(t.switches, "activity resets the silence").toEqual([]);
    await ms(25_000);
    expect(t.switches).toEqual(["brb"]);
    t.director.onActivity();
    await ms(10_000);
    expect(t.switches).toEqual(["brb", "chat"]);
    // Leaving voice while live.
    t.director.onVoice("discord:g1:voice:v1", false);
    await ms(10_000);
    expect(t.switches).toEqual(["brb", "chat", "brb"]);
    t.director.onVoice("discord:g1:voice:v1", true);
    await ms(10_000);
    expect(t.switches).toEqual(["brb", "chat", "brb", "chat"]);
    // Playing is never brb.
    t.director.onGame(true);
    await ms(500_000);
    expect(t.switches.at(-1)).toBe("game");
    t.director.stop();
  });

  it("the curtain shows the ending scene before the stream stops", async () => {
    const t = await rig({ ending_ms: 5_000, starting_ms: 0 });
    t.show("Just Chatting", true);
    let closed = false;
    void t.director.close().then(() => {
      closed = true;
    });
    await ms(10);
    expect(t.switches).toEqual(["ending"]);
    expect(closed).toBe(false);
    await ms(5_000);
    expect(closed).toBe(true);
    // The stream then stops: nothing more to do.
    t.show("Ending", false);
    await ms(10_000);
    expect(t.switches).toEqual(["ending"]);
    t.director.stop();
  });

  it("the curtain does not wait without an ending scene, when not live or when refused", async () => {
    const none = await rig({}, ["Talk", "Game"]);
    none.show("Talk", true);
    await expect(none.director.close()).resolves.toBeUndefined();
    expect(none.switches).toEqual([]);
    none.director.stop();

    const off = await rig();
    await off.director.close();
    expect(off.switches).toEqual([]);
    off.director.stop();

    const refused = await rig({ starting_ms: 0 });
    refused.show("Just Chatting", true);
    refused.allow.value = false;
    await refused.director.close();
    expect(refused.switches).toEqual([]);
    refused.director.stop();
  });

  it("a refused switch (paused autonomy) is not retried in a loop", async () => {
    const t = await rig();
    t.allow.value = false;
    t.director.onGame(true);
    await ms(60_000);
    expect(t.switches).toEqual([]);
    t.allow.value = true;
    t.director.onGame(false);
    t.director.onGame(true);
    await ms(2_000);
    expect(t.switches).toEqual(["game"]);
    t.director.stop();
  });
});

// ----- the Stage side -----

describe("transitions on the stage node", () => {
  it("scene messages carry an optional transition", () => {
    const msg = parseCoreMessage({
      type: "scene",
      name: "Game",
      transition: "Fade",
      transition_ms: 300,
      id: 4,
    });
    expect(msg).toEqual({
      type: "scene",
      name: "Game",
      transition: "Fade",
      transition_ms: 300,
      id: 4,
    });
    const bare = parseCoreMessage({ type: "scene", name: "Game", transition: null });
    expect(bare).toEqual({ type: "scene", name: "Game" });
    expect(encodeMessage(bare)).toBe('{"type":"scene","name":"Game"}');
    expect(() => parseCoreMessage({ type: "scene", name: "x", transition_ms: 99_999 })).toThrow();
  });

  it("ObsController sets the transition for this switch only, never OBS's global one", async () => {
    const obs: FakeObs & {
      setTransition?: Obs["setTransition"];
      setSceneTransition?: Obs["setSceneTransition"];
    } = new FakeObs("Talk");
    const transitions: [string, string, number | null][] = [];
    let fail = false;
    obs.setTransition = async () => {
      throw new Error("the global transition must not change");
    };
    obs.setSceneTransition = async (scene: string, name: string, durationMs: number | null) => {
      if (fail) throw new Error("No transition named Nope");
      transitions.push([scene, name, durationMs]);
      obs.state.calls.push(`transition ${scene}=${name}`);
    };
    const controller = new ObsController(obs, ObsConfigSchema.parse({ poll_ms: 100_000 }));
    const abort = new AbortController();
    const running = controller.run(abort.signal);
    for (let i = 0; i < 100 && !controller.state().connected; i++)
      await new Promise((r) => setTimeout(r, 5));
    // Two switches at once: each one's transition goes with its own scene, in order.
    await Promise.all([
      controller.setScene("Game", { name: "Fade", duration_ms: 300 }),
      controller.setScene("Talk", { name: "Stinger", duration_ms: null }),
    ]);
    expect(transitions).toEqual([
      ["Game", "Fade", 300],
      ["Talk", "Stinger", null],
    ]);
    expect(obs.state.calls.slice(-4)).toEqual([
      "transition Game=Fade",
      "scene Game",
      "transition Talk=Stinger",
      "scene Talk",
    ]);
    await controller.setScene("Game", { name: "Fade", duration_ms: 300 });
    // A missing transition does not block the switch.
    fail = true;
    await controller.setScene("Talk", { name: "Nope", duration_ms: null });
    expect(obs.state.scene).toBe("Talk");
    await controller.setScene("Game");
    expect(obs.state.calls.at(-1)).toBe("scene Game");
    abort.abort();
    await running;
  });
});
