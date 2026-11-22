// Where she is in voice, for the rooms (a room opens only while she is): her joining, moving,
// the voice node coming back and leaving, and the rooms' answer following it at once.

import { rm } from "node:fs/promises";
import type { ContextKey } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoicePresence } from "../src/presence.js";
import { ALICE, makeRig, type Rig } from "./room-rig.js";

let rig: Rig;

beforeEach(async () => {
  rig = await makeRig();
});

afterEach(async () => {
  await rig.desk.idle();
  rig.raw.close();
  await rm(rig.dir, { recursive: true, force: true });
});

describe("where she is in voice", () => {
  const ctx = (guild: string, channel: string): ContextKey => ({
    platform: "discord",
    scope: guild,
    channel,
    kind: "voice",
  });

  it("follows her joining, moving, the voice node coming back and leaving", () => {
    let node = false;
    const p = new VoicePresence(() => node);
    expect(p.inVoice()).toBe(false);
    // Core started while she was in a channel: the voice node says so.
    node = true;
    expect(p.inVoice()).toBe(true);
    node = false;
    p.joined(ctx("g1", "c1"));
    expect(p.inVoice()).toBe(true);
    // Moved to another channel of the same server (a `joined` with no `left`), then left it.
    p.joined(ctx("g1", "c2"));
    p.left(ctx("g1", "c2"));
    expect(p.inVoice()).toBe(false);
    // A voice node that reconnects reports her channel with who is in it.
    p.participants(ctx("g1", "c3"));
    expect(p.inVoice()).toBe(true);
    // A late `left` of a channel she moved away from changes nothing.
    p.left(ctx("g1", "c1"));
    expect(p.inVoice()).toBe(true);
    p.left(ctx("g1", "c3"));
    expect(p.inVoice()).toBe(false);
  });

  it("lets rooms open again as soon as she is back, without anything else", async () => {
    rig.voice.on = false;
    expect(await rig.desk.overview(ALICE)).toMatchObject({ available: false });
    rig.voice.on = true;
    expect(await rig.desk.overview(ALICE)).toMatchObject({ available: true, reason: null });
  });
});
