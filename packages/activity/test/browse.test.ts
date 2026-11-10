// Browsing (docs/design/v4-plan.md §8.1 逛網路): no longer the closed Threads extension, but her own
// web reading. It shows while she searches or reads on her own and ends a while after her last
// page, so the public page and the stage can tell what she is doing.

import {
  type ActivityRequest,
  customEvent,
  type Principal,
  Principals,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { CHAT, FakeWorld, OWEN, tick, until } from "./fake.js";

const IDLE_MS = 60;
const MC: ActivityRequest = { type: "start", activity: "game", target: "minecraft", goal: null };

function playing(w: FakeWorld): boolean {
  const a = w.service.snapshot().activity;
  return a.type === "game" && a.phase === "running";
}

function world(): FakeWorld {
  return new FakeWorld({ config: { browse_idle_ms: IDLE_MS } });
}

function decided(
  w: FakeWorld,
  capability: string,
  args: Record<string, string>,
  principal: Principal = Principals.self(CHAT),
  allowed = true,
): void {
  w.emit(
    customEvent("gate.decision", {
      id: "d1",
      at: toTimestamp(Date.now()),
      capability,
      risk: "low",
      principal: JSON.parse(JSON.stringify(principal)),
      args,
      why: null,
      turn: null,
      allowed,
      stage: allowed ? "allowed" : "rate",
      reason: "",
      reviewer: null,
    }),
  );
}

describe("browsing", () => {
  it("her own search shows as browsing, and ends a while after her last page", async () => {
    const w = world();
    decided(w, "web.search", { query: "Minecraft 1.22 新生物" });
    expect(w.service.snapshot().activity).toMatchObject({
      type: "browse",
      target: "Minecraft 1.22 新生物",
      phase: "running",
    });
    await tick(IDLE_MS / 2);
    // Reading a page keeps it going (and keeps what she was looking for).
    decided(w, "web.read", { url: "https://minecraft.wiki/w/Mob" });
    await tick(IDLE_MS / 2 + 10);
    expect(w.service.snapshot().activity).toMatchObject({ type: "browse" });
    await until(() => w.service.snapshot().activity.type === "idle");
  });

  it("a search for someone else, a refused one, or one during a game is not her browsing", async () => {
    const w = world();
    decided(w, "web.search", { query: "天氣" }, Principals.user(OWEN, CHAT));
    decided(w, "web.search", { query: "天氣" }, Principals.self(CHAT), false);
    decided(w, "economy.look", { query: "x" });
    expect(w.service.snapshot().activity.type).toBe("idle");
    const r = await w.service.request(w.transition(MC));
    await until(() => playing(w));
    decided(w, "web.search", { query: "苦力怕怎麼打" });
    expect(w.service.snapshot().activity).toMatchObject({ type: "game", target: "minecraft" });
    expect(r.status).toBe("started");
  });

  it("can be started and stopped on purpose; a game takes over", async () => {
    const w = world();
    const start = await w.service.request(
      w.transition({ type: "start", activity: "browse", target: "動畫新番", goal: null }),
    );
    expect(start.status).toBe("started");
    await until(() => w.service.snapshot().activity.type === "browse");
    expect(w.service.snapshot().activity).toMatchObject({ target: "動畫新番" });
    const again = await w.service.request(
      w.transition({ type: "start", activity: "browse", target: "動畫新番", goal: null }),
    );
    expect(again.status).toBe("already");
    const stop = await w.service.request(w.transition({ type: "stop", activity: "browse" }));
    expect(stop.status).toBe("started");
    await until(() => w.service.snapshot().activity.type === "idle");

    decided(w, "web.search", { query: "osu 譜面" });
    await w.service.request(w.transition(MC));
    await until(() => playing(w));
    await w.service.request(w.transition({ type: "stop", activity: "game" }));
    // The game ended browsing too: she is idle, not back on the web.
    await until(() => w.service.snapshot().activity.type === "idle");
  });

  it("a browse start while a game runs is refused", async () => {
    const w = world();
    await w.service.request(w.transition(MC));
    await until(() => playing(w));
    const browse = await w.service.request(
      w.transition({ type: "start", activity: "browse", target: null, goal: null }),
    );
    expect(browse).toMatchObject({ status: "refused", code: "precondition" });
  });

  it("publishes the change so the stage and the public page see it", () => {
    const w = world();
    decided(w, "web.search", { query: "新聞" });
    const changes = w.published("activity.changed");
    expect(changes.at(-1)?.activity).toMatchObject({ type: "browse", target: "新聞" });
  });
});
