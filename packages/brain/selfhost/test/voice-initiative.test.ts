// Her initiative and the voice channel she is in: a voice line counts in the gates' books like a
// text line, and someone joining the channel she is in is greeted there.

import { sleep } from "@miyoria/runtime/kernel";
import {
  type ContextKey,
  contextKeyString,
  Events,
  type JsonValue,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { account, Rig, says, stopRigs, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const VC: ContextKey = { platform: "test", scope: "guild", channel: "vc", kind: "voice" };
const VC2: ContextKey = { platform: "test", scope: "guild", channel: "vc2", kind: "voice" };
const HOUR = 3_600_000;

function member(id: string, self = false): VoiceParticipant {
  return { account: account(id), display_name: id, is_self: self, muted: false, deafened: false };
}

/**
 * The shift that puts the clock at the next noon (UTC+8) at least three hours away: outside her
 * quiet hours, at whatever hour this runs.
 */
function toNoon(): number {
  const now = Date.now();
  const day = 24 * HOUR;
  const local = now + 8 * HOUR;
  let noon = local - (local % day) + 12 * HOUR;
  while (noon - local < 3 * HOUR) noon += day;
  return noon - local;
}

async function voiceRig(config: Record<string, JsonValue> = {}): Promise<Rig> {
  const rig = await Rig.create({
    config: {
      voice: {
        default_mode: "normal",
        debounce_ms: 150,
        direct_debounce_ms: 80,
        turn_debounce_ms: 20,
        speculate: false,
        live_context_ms: 50,
      },
      ...config,
    },
  });
  rig.sup.bus.publish("voice.test", Events.VoiceJoined, {
    context: VC,
    participants: [member("owen"), member("amy"), member("her", true)],
  });
  await sleep(20);
  return rig;
}

function joined(context: ContextKey) {
  return {
    kind: "joined_voice",
    key: `joined_voice:test:amy:${context.channel}`,
    account: account("amy"),
    person: null,
    display_name: "amy",
    context,
    detail: "amy 進了語音頻道「vc」",
    score: 0.9,
    count: 1,
    first_at: toTimestamp(Date.now()),
    at: toTimestamp(Date.now()),
  } as never;
}

describe("a line in the voice channel", () => {
  it("counts in the gates' books: someone spoke, so her unanswered starts are over", async () => {
    const rig = await voiceRig();
    const host = rig.host;
    if (host === null) throw new Error("no host");
    const key = contextKeyString(VC);
    host.initiative.gates.spoke(key, Date.now());
    expect(host.initiative.gates.snapshot().places[key]?.unanswered).toBe(1);
    const now = Date.now();
    rig.sup.bus.publish("voice.test", Events.VoiceUtteranceEvent, {
      id: "u1",
      context: VC,
      speaker: { account: account("owen"), display_name: "owen", is_bot: false },
      text: "大家好",
      language: "zh",
      emotion: null,
      audio_events: [],
      started_at: toTimestamp(now - 800),
      ended_at: toTimestamp(now),
      asr_ms: 200,
    });
    await until(
      () => host.initiative.gates.snapshot().places[key]?.unanswered === 0,
      3_000,
      "the line in the books",
    );
  });
});

describe("someone joins the voice channel she is in", () => {
  it("is greeted there; a join of a channel she is not in is not", async () => {
    const rig = await voiceRig();
    rig.shift = toNoon();
    rig.model.push(says("嗨 amy,歡迎。"));
    rig.sup.bus.publish("world", Events.WorldSalient, joined(VC2));
    await sleep(300);
    expect(rig.model.requests).toHaveLength(0);
    rig.sup.bus.publish("world", Events.WorldSalient, joined(VC));
    await until(() => rig.model.requests.length === 1, 3_000, "her run in the voice channel");
    await until(
      () => rig.sink.actions.some((a) => a.payload.type === "speak"),
      3_000,
      "her greeting",
    );
    const speak = rig.sink.actions.find((a) => a.payload.type === "speak");
    expect(speak?.payload).toMatchObject({ type: "speak", context: VC });
  });
});
