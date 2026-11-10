// Paid screen messages: `economy.screen` becomes a `screen` message for the overlay, which the hub
// passes on as it is (the overlay queues them).

import { customEvent } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { Forwarder, OverlayHub, parseCoreMessage } from "../src/index.js";

describe("screen messages", () => {
  it("round-trips and is bounded", () => {
    const msg = { type: "screen", kind: "message", name: "Owen", text: "加油", song: null };
    expect(parseCoreMessage(msg)).toStrictEqual(msg);
    const ded = { ...msg, kind: "dedication", song: "春日影" };
    expect(parseCoreMessage(ded)).toStrictEqual(ded);
    for (const bad of [
      { ...msg, kind: "other" },
      { ...msg, name: "x".repeat(33) },
      { ...msg, text: "x".repeat(201) },
      { ...msg, song: undefined },
    ]) {
      expect(() => parseCoreMessage(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it("the forwarder turns economy.screen into screen, one per event, and drops junk", () => {
    const f = new Forwarder(false);
    const msg = { kind: "message", name: " Owen ", text: " 加油 ", song: null };
    const once = [{ type: "screen", kind: "message", name: "Owen", text: "加油", song: null }];
    expect(f.onEvent(customEvent("economy.screen", msg))).toStrictEqual(once);
    // Two in a row stay two (unlike gifts, nothing is merged).
    expect(f.onEvent(customEvent("economy.screen", msg))).toStrictEqual(once);
    expect(
      f.onEvent(
        customEvent("economy.screen", {
          kind: "dedication",
          name: "A",
          text: "給 B",
          song: " 春日影 ",
        }),
      ),
    ).toStrictEqual([
      { type: "screen", kind: "dedication", name: "A", text: "給 B", song: "春日影" },
    ]);
    // A message has no song, even if one is sent.
    expect(f.onEvent(customEvent("economy.screen", { ...msg, song: "x" }))).toStrictEqual(once);
    for (const bad of [
      { ...msg, name: "" },
      { ...msg, text: " " },
      { ...msg, kind: "party" },
      { ...msg, kind: "dedication", song: null },
      "nope",
    ]) {
      expect(f.onEvent(customEvent("economy.screen", bad as never)), JSON.stringify(bad)).toEqual(
        [],
      );
    }
  });

  it("the hub sends the card to every client and keeps none for a late one", () => {
    const hub = new OverlayHub();
    const seen: unknown[] = [];
    hub.listen((t) => seen.push(JSON.parse(t)));
    hub.screen({ type: "screen", kind: "message", name: "Owen", text: "加油", song: null });
    expect(seen).toEqual([
      { type: "screen", kind: "message", name: "Owen", text: "加油", song: null },
    ]);
    expect(hub.initial().some((t) => t.includes('"screen"'))).toBe(false);
  });
});
