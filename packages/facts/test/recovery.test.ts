// Reading the last run's end out of the log: a game left open comes back, one that was really
// closed does not, and what modules say while the core goes down does not count.

import type {
  ContextKey,
  JsonValue,
  LogEvent,
  ObservationBody,
  RestoredGame,
} from "@miyoria/types";
import { customEvent, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  BOOT_KEY,
  GAME_SESSION_SOURCE,
  LIFECYCLE_SOURCE,
  RESTORE_KEY_PREFIX,
  recoverGame,
  SHUTDOWN_KEY,
} from "../src/recovery.js";

const T0 = Date.UTC(2026, 10, 7, 12);
const VOICE: ContextKey = { platform: "discord", scope: "g", channel: "v", kind: "voice" };

let tick = 0;

function line(source: string, key: string, payload: JsonValue, extra: object = {}): LogEvent {
  tick++;
  const body: ObservationBody = {
    observation: {
      source,
      silent: true,
      salience: "ambient",
      attention_key: key,
      revision: 1,
      summary: "",
      addressed_to_her: false,
      from: null,
      context: null,
    },
    buckets: [],
    speech: false,
    origin: {
      module: "game",
      topic: "t",
      event: customEvent("t", payload) as unknown as JsonValue,
      turn: null,
    },
  };
  return {
    id: String(tick),
    at: toTimestamp(T0 + tick),
    kind: "observation",
    source,
    cause: null,
    context: null,
    person: null,
    body: { ...body, ...extra } as unknown as JsonValue,
  };
}

const boot = (restoring: RestoredGame | null = null) =>
  line(LIFECYCLE_SOURCE, BOOT_KEY, {}, { restoring });
const shutdown = () => line(LIFECYCLE_SOURCE, SHUTDOWN_KEY, {});
const session = (state: string, extra: object = {}) =>
  line(GAME_SESSION_SOURCE, "game:session:minecraft", {
    state,
    game: "minecraft",
    game_name: "Minecraft",
    context: { ...VOICE },
    ...extra,
  });
const restored = (outcome: string) =>
  line(LIFECYCLE_SOURCE, `${RESTORE_KEY_PREFIX}minecraft`, { game: "minecraft", outcome });

/** `recoverGame` reads newest first; these lists read like a log. */
const recover = (...lines: LogEvent[]) => recoverGame(lines.toReversed());

describe("the session the last run left open", () => {
  it("is nothing on a first start", () => {
    expect(recover()).toBeNull();
    expect(recover(boot())).toBeNull();
  });

  it("is the running session when the core was killed", () => {
    const started = session("started");
    expect(recover(boot(), started)).toEqual({
      game: "minecraft",
      name: "Minecraft",
      context: VOICE,
      since: started.at,
    });
  });

  it("survives a clean shutdown, whatever the modules said on their way down", () => {
    const left = recover(
      boot(),
      session("started"),
      shutdown(),
      // The extension stopped first, then the director closed.
      session("stopped", { code: "crashed", reason: "遊戲的擴充套件停止了" }),
      session("stopped"),
    );
    expect(left?.game).toBe("minecraft");
  });

  it("is nothing when the session was stopped before the shutdown", () => {
    expect(recover(boot(), session("started"), session("stopped"), shutdown())).toBeNull();
  });

  it("is nothing when the game really went away during the run", () => {
    const stopped = session("stopped", { code: "disconnected", reason: "斷線" });
    expect(recover(boot(), session("started"), stopped)).toBeNull();
  });

  it("is the newest session of the run", () => {
    const left = recover(boot(), session("started"), session("stopped"), session("started"));
    expect(left?.game).toBe("minecraft");
  });

  it("looks no further back than the last run", () => {
    expect(recover(boot(), session("started"), shutdown(), boot())).toBeNull();
  });

  it("outlives a second restart that had not found the game yet", () => {
    const first = recover(boot(), session("started"));
    expect(recover(boot(first), shutdown())?.game).toBe("minecraft");
    expect(recover(boot(first))?.game).toBe("minecraft");
  });

  it("does not outlive a run that found the game gone", () => {
    const first = recover(boot(), session("started"));
    expect(recover(boot(first), restored("gone"))).toBeNull();
    expect(recover(boot(first), restored("dropped"), shutdown())).toBeNull();
  });

  it("keeps a game that was picked up again", () => {
    const first = recover(boot(), session("started"));
    const left = recover(boot(first), session("started"), restored("resumed"));
    expect(left?.game).toBe("minecraft");
  });
});
