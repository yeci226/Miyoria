// The Stage's check of OBS's scene collection (`[stage.obs] collection`): on another collection it
// creates nothing in OBS and says so in its state; once OBS is back (seen on going live) it does.

import { describe, expect, it } from "vitest";
import { collectionWarning, ObsConfigSchema, ObsController } from "../src/obs.js";
import { FakeObs } from "./common.js";

/** The common fake OBS, with a scene collection and a profile. */
class CollectionObs extends FakeObs {
  collection = "我的場景";
  profile = "未命名";
  failCollection = false;

  async sceneCollection(): Promise<string> {
    if (this.failCollection) throw new Error("NotReady");
    return this.collection;
  }

  async profileName(): Promise<string> {
    return this.profile;
  }
}

async function connected(controller: ObsController) {
  const run = new AbortController();
  const running = controller.run(run.signal);
  for (let i = 0; i < 100 && !controller.state().connected; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return async () => {
    run.abort();
    await running;
  };
}

const config = (over: Record<string, unknown> = {}) =>
  ObsConfigSchema.parse({ subtitle_source: "Subtitle", poll_ms: 100_000, ...over });

describe("ObsController scene collection check", () => {
  it("creates nothing on another collection and reports it, until OBS is back on going live", async () => {
    const obs = new CollectionObs();
    const controller = new ObsController(obs, config({ collection: "Miyoria" }));
    const stop = await connected(controller);
    expect(obs.state.calls).not.toContain("ensure Subtitle");
    expect(controller.state()).toMatchObject({
      collection: "我的場景",
      wrongCollection: "Miyoria",
    });
    expect(collectionWarning(controller.state())).toBe(
      "OBS 不在「Miyoria」這份場景集合上(現在是「我的場景」)",
    );

    // Still on it: a refresh does not look again (only connecting and going live do).
    obs.collection = "Miyoria";
    await controller.refresh();
    expect(controller.state().wrongCollection).toBe("Miyoria");

    // She goes live: OBS is on Miyoria's collection now, so the subtitle source is looked for.
    obs.state.streaming = true;
    await controller.refresh();
    expect(controller.state()).toMatchObject({ collection: "Miyoria", wrongCollection: null });
    expect(collectionWarning(controller.state())).toBeNull();
    expect(obs.state.calls.filter((c) => c === "ensure Subtitle")).toHaveLength(1);

    // Live again later on another collection: reported again, nothing created.
    obs.state.streaming = false;
    await controller.refresh();
    obs.collection = "別的";
    obs.state.streaming = true;
    await controller.refresh();
    expect(controller.state().wrongCollection).toBe("Miyoria");
    expect(obs.state.calls.filter((c) => c === "ensure Subtitle")).toHaveLength(1);
    await stop();
    // Disconnected: no warning.
    expect(collectionWarning(controller.state())).toBeNull();
  });

  it("creates the subtitle source on the right collection, or with no collection set", async () => {
    for (const [collection, current] of [
      ["Miyoria", "Miyoria"],
      [null, "我的場景"],
    ] as const) {
      const obs = new CollectionObs();
      obs.collection = current;
      const controller = new ObsController(obs, config({ collection }));
      const stop = await connected(controller);
      expect(obs.state.calls).toContain("ensure Subtitle");
      expect(controller.state()).toMatchObject({ collection: current, wrongCollection: null });
      await stop();
    }
  });

  it("creates nothing while the collection cannot be read", async () => {
    const obs = new CollectionObs();
    obs.failCollection = true;
    const controller = new ObsController(obs, config({ collection: "Miyoria" }));
    const stop = await connected(controller);
    expect(obs.state.calls).not.toContain("ensure Subtitle");
    // Unknown is not reported as wrong.
    expect(controller.state().wrongCollection).toBeNull();
    await stop();
  });

  it("only logs another profile, and still works", async () => {
    const obs = new CollectionObs();
    obs.collection = "Miyoria";
    const controller = new ObsController(
      obs,
      config({ collection: "Miyoria", profile: "Miyoria" }),
    );
    const stop = await connected(controller);
    expect(controller.state()).toMatchObject({ connected: true, wrongCollection: null });
    expect(obs.state.calls).toContain("ensure Subtitle");
    await stop();
  });
});
