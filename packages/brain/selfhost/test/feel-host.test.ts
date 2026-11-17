// Her `<feel>` block through the hosts as they run in production (docs/design/v5-heart.md §2.9):
// a text run and a voice run end, the block never reached the mouth, the voice or the transcript,
// and the heart (`HeartKey`) and the emotion engine (`AffectStateKey`) got it once, with the turn.

import { sleep } from "@miyoria/runtime/kernel";
import {
  type AffectInput,
  type AffectState,
  AffectStateKey,
  type Attitude,
  type ContextKey,
  Events,
  type FeelProposal,
  HeartKey,
  type HeartPeople,
  type HeartView,
  type PersonId,
  SocialSignalsKey,
  type TurnOutcomeRecord,
  toTimestamp,
  type VoiceParticipant,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { account, channel, mention, Rig, says, stopRigs, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const VC: ContextKey = { platform: "test", scope: "guild", channel: "vc", kind: "voice" };
const BLOCK =
  "<feel>\n我: 開心 中\nowen: 羈絆 + 「他記得我想吃布丁」\namy: 好感 + 「她也來了」\n</feel>";

interface Felt {
  person: PersonId;
  proposals: readonly FeelProposal[];
  turn: string | null;
}

function services(felt: Felt[], appraised: AffectInput[]) {
  const attitude = (id: string): Attitude => ({
    person: `person-${id}`,
    affinity: 20,
    trust: 10,
    familiarity: 10,
    blocked: false,
    label: "朋友",
    call_name: null,
    display_name: id,
  });
  return {
    provide: (sup: Rig["sup"]) => {
      sup.services.provide("app", SocialSignalsKey, {
        attitude: (a) => (a.id === "her" ? null : attitude(a.id)),
      });
      const heart: Pick<HeartPeople, "feel"> = {
        feel: (person, proposals, o) => {
          felt.push({ person, proposals, turn: o.turn });
          return proposals.length;
        },
      };
      sup.services.provide("app", HeartKey, heart as HeartPeople);
      const affect: Pick<AffectState, "appraise"> = {
        appraise: (input) => {
          appraised.push(input);
          return [];
        },
      };
      sup.services.provide("app", AffectStateKey, affect as AffectState);
    },
  };
}

const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);

describe("a feel block in production", () => {
  it("a text run: her words go out, the block reaches the heart once with the turn", async () => {
    const felt: Felt[] = [];
    const appraised: AffectInput[] = [];
    const rig = await Rig.create(services(felt, appraised));
    rig.model.push(says(`謝謝你記得!\n${BLOCK}`));
    rig.say({ ...mention(C1, "amy", "我也來了"), mentions_self: false });
    await sleep(30);
    rig.say(mention(C1, "owen", "@她 我帶了你上次說想吃的布丁"));
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(rig.sink.texts()).toEqual(["謝謝你記得!"]);
    const turn = outcomes(rig)[0]?.turn;
    expect(felt).toEqual([
      {
        person: "person-owen",
        proposals: [{ field: "bond", direction: "up", quote: "他記得我想吃布丁" }],
        turn,
      },
      {
        person: "person-amy",
        proposals: [{ field: "warmth", direction: "up", quote: "她也來了" }],
        turn,
      },
    ]);
    expect(appraised).toHaveLength(1);
    expect(appraised[0]?.events[0]).toMatchObject({ emotion: "joy", strength: "medium" });
    const own = rig.entries(C1).filter((e) => e.kind === "self");
    expect(own.map((e) => e.content)).toEqual(["謝謝你記得!"]);
  });

  it("a text run that is only a block is silent, with no fixed line, and still felt", async () => {
    const felt: Felt[] = [];
    const appraised: AffectInput[] = [];
    const rig = await Rig.create(services(felt, appraised));
    rig.model.push(says("<feel>\n我: 難過 弱\n</feel>"));
    rig.say(mention(C1, "owen", "@她 嗯"));
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    expect(rig.sink.texts()).toEqual([]);
    expect(outcomes(rig)[0]?.outcome).toEqual({ type: "silence" });
    expect(appraised[0]?.events[0]).toMatchObject({ emotion: "sorrow", strength: "weak" });
    expect(felt).toEqual([]);
  });

  it("block 7 says how she feels toward the people here now, from the heart", async () => {
    const felt: Felt[] = [];
    const appraised: AffectInput[] = [];
    const base = services(felt, appraised);
    const rig = await Rig.create({
      provide: (sup) => {
        base.provide(sup);
        const views: Pick<HeartPeople, "view" | "feel"> = {
          feel: () => 0,
          view: (p) =>
            p === "person-owen"
              ? ({
                  person: p,
                  bond: 60,
                  trust: 40,
                  familiarity: 30,
                  warmth: 0.5,
                  respect: 0,
                  ease: 0.2,
                  grudge: 0.4,
                  longing: 0,
                  rapport: 0,
                  stance: "",
                  impression: "",
                  call_name: null,
                  tags: [],
                  owner: false,
                  blocked: false,
                  last_seen: null,
                  last_together: null,
                } as HeartView)
              : null,
        };
        sup.services.provide("test", HeartKey, views as HeartPeople);
      },
    });
    rig.model.push(says("嗯?"));
    rig.say(mention(C1, "owen", "@她 欸"));
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    const now = String(rig.model.requests[0]?.messages.at(-1)?.content ?? "");
    expect(now).toContain(
      "你現在對在場的人的感覺:\n- owen:很有好感、有心結(你對他還有心結,還沒說開)",
    );
  });

  it("block 4 shows her new words about someone at the next run, not a stale copy", async () => {
    const felt: Felt[] = [];
    const appraised: AffectInput[] = [];
    const base = services(felt, appraised);
    let impression = "很會打遊戲";
    const view = (p: PersonId): HeartView =>
      ({
        person: p,
        bond: 60,
        trust: 40,
        familiarity: 30,
        warmth: 0.1,
        respect: 0,
        ease: 0.2,
        grudge: 0,
        longing: 0,
        rapport: 0,
        stance: "",
        impression,
        call_name: null,
        tags: [],
        owner: false,
        blocked: false,
        last_seen: null,
        last_together: null,
      }) as HeartView;
    const rig = await Rig.create({
      provide: (sup) => {
        base.provide(sup);
        const heart: Pick<HeartPeople, "view" | "feel"> = { feel: () => 0, view };
        sup.services.provide("test", HeartKey, heart as HeartPeople);
      },
    });
    rig.model.push(says("嗯?"), says("嗯嗯"));
    rig.say(mention(C1, "owen", "@她 欸"));
    await until(() => outcomes(rig).length === 1, 3_000, "the first outcome");
    impression = "其實很怕寂寞";
    rig.say(mention(C1, "owen", "@她 再一次"));
    await until(() => outcomes(rig).length === 2, 3_000, "the second outcome");
    const second = JSON.stringify(rig.model.requests[1]?.messages ?? []);
    expect(second).toContain("其實很怕寂寞");
    expect(second).not.toContain("很會打遊戲");
  });

  it("a voice run: the block is never said; the people in the channel may be named", async () => {
    const felt: Felt[] = [];
    const appraised: AffectInput[] = [];
    const rig = await Rig.create({
      ...services(felt, appraised),
      config: {
        voice: {
          default_mode: "normal",
          debounce_ms: 150,
          direct_debounce_ms: 80,
          turn_debounce_ms: 20,
          max_debounce_ms: 1_500,
          speculate: false,
          live_context_ms: 50,
        },
      },
    });
    const member = (id: string, self = false): VoiceParticipant => ({
      account: account(id),
      display_name: id,
      is_self: self,
      muted: false,
      deafened: false,
    });
    rig.sup.bus.publish("voice.test", Events.VoiceJoined, {
      context: VC,
      participants: [member("owen"), member("amy"), member("her", true)],
    });
    await sleep(20);
    rig.model.push(says(`<emo:happy>在喔!謝謝你。${BLOCK}`));
    const now = Date.now();
    rig.sup.bus.publish("voice.test", Events.VoiceUtteranceEvent, {
      id: "u-feel",
      context: VC,
      speaker: { account: account("owen"), display_name: "owen", is_bot: false },
      text: "小鯨魚我帶布丁來了",
      language: "zh",
      emotion: null,
      audio_events: [],
      started_at: toTimestamp(now - 800),
      ended_at: toTimestamp(now),
      asr_ms: 200,
    });
    await until(() => outcomes(rig).length === 1, 3_000, "the outcome");
    const said = rig.sink.actions.flatMap((a) =>
      a.payload.type === "speak" ? [a.payload.text] : [],
    );
    expect(said).toEqual(["在喔!", "謝謝你。"]);
    // amy never spoke: she is named because she is in the channel.
    expect(felt.map((f) => f.person)).toEqual(["person-owen", "person-amy"]);
    expect(appraised).toHaveLength(1);
  });
});
