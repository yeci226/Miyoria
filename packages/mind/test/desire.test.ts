import type { AffectSnapshot, Goal, PersonCard } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type DesireInputs, rankDesires, renderDesire, type Whereabouts } from "../src/index.js";

function affect(p: Partial<AffectSnapshot> = {}): AffectSnapshot {
  return {
    at: "2026-11-02T12:00:00.000Z",
    drives: {
      social: 0.3,
      play: 0.2,
      attention: 0.1,
      rest: 0.1,
      curiosity: 0.1,
      esteem: 0.1,
      hunger: 0,
      longing: 0,
    },
    boredom: 0.2,
    top: [],
    mood: { valence: 0.2, arousal: 0.4, energy: 0.6 },
    mood_line: "心情普通",
    shown: null,
    biases: { talkativeness: 0, initiative: 0, wants: [] },
    ...p,
  };
}

type Card = Pick<PersonCard, "handle" | "attachment" | "emotions" | "blocked">;
const card = (handle: string, attachment: number, missing = 0): Card => ({
  handle,
  attachment,
  emotions: missing > 0 ? { missing } : {},
  blocked: false,
});

function inputs(
  p: Partial<DesireInputs> = {},
  where: Record<string, Whereabouts> = {},
): DesireInputs {
  return {
    affect: affect(),
    cards: [],
    where: (h) => where[h] ?? "offline",
    goals: [],
    fired: new Set(),
    capabilities: new Set(["chat.start", "chat.dm", "voice.join", "game.start", "sing.request"]),
    activity: null,
    inVoice: false,
    cared: 0.3,
    ...p,
  };
}

describe("the desire list", () => {
  it("puts finding someone she misses first when they are online, with the numbers", () => {
    const list = rankDesires(
      inputs(
        {
          affect: affect({
            top: [{ name: "missing", intensity: 0.6, cause: "", at: "", person: null }],
            biases: {
              talkativeness: 0,
              initiative: 0,
              wants: [
                { want: "find_person", weight: 0.75, person: "Owen", why: "想念Owen" },
                { want: "play", weight: 0.4, person: null, why: "想玩遊戲、有點無聊" },
              ],
            },
          }),
          cards: [card("Owen", 0.8, 0.6), card("Amy", 0.1)],
        },
        { Owen: "online", Amy: "online" },
      ),
    );
    expect(list[0]).toMatchObject({
      want: "find_person",
      label: "找 Owen 聊天",
      person: "Owen",
      capability: "chat.dm",
    });
    expect(renderDesire(list[0] as never)).toBe("找 Owen 聊天(想念 0.6 × 在意 0.8,他在線)");
    expect(list.find((d) => d.want === "play")?.capability).toBe("game.start");
    // Someone she hardly cares about is not suggested.
    expect(list.some((d) => d.person === "Amy")).toBe(false);
    for (let i = 1; i < list.length; i++) {
      expect((list[i - 1]?.weight ?? 0) >= (list[i]?.weight ?? 0)).toBe(true);
    }
  });

  it("weighs someone away less, and joins the voice channel someone is in", () => {
    const wants = {
      talkativeness: 0,
      initiative: 0,
      wants: [{ want: "find_person", weight: 0.7, person: "Owen", why: "想念Owen" }],
    };
    const cards = [card("Owen", 0.8, 0.55)];
    const away = rankDesires(inputs({ affect: affect({ biases: wants }), cards }, {}));
    const there = rankDesires(
      inputs({ affect: affect({ biases: wants }), cards }, { Owen: "voice" }),
    );
    expect(away[0]?.why).toContain("他不在線");
    expect(away[0]?.capability).toBeNull();
    expect(there[0]?.capability).toBe("voice.join");
    expect((there[0]?.weight ?? 0) > (away[0]?.weight ?? 0)).toBe(true);
  });

  it("lists her goals, fired ones near the top, and leaves out what she cannot do", () => {
    const goal = (id: string, what: string, kind: "whenever" | "when_online"): Goal => ({
      id,
      what,
      why: "",
      trigger: kind === "whenever" ? { kind } : { kind, person: "Owen" },
      steps: [],
      status: "pending",
      expires: "2026-11-03T12:00:00.000Z",
      person: kind === "when_online" ? "Owen" : null,
      context: null,
      source: "plan",
      created_at: "",
      updated_at: "",
      closed_at: null,
      close_reason: null,
    });
    const list = rankDesires(
      inputs(
        {
          goals: [goal("g-a", "整理筆記", "whenever"), goal("g-b", "問 Owen 報告", "when_online")],
          fired: new Set(["g-b"]),
          capabilities: new Set(["chat.start"]),
          affect: affect({
            biases: {
              talkativeness: 0,
              initiative: 0,
              wants: [{ want: "play", weight: 0.5, person: null, why: "想玩遊戲" }],
            },
          }),
        },
        { Owen: "online" },
      ),
    );
    expect(list[0]).toMatchObject({ want: "goal", goal: "g-b", label: "問 Owen 報告" });
    expect(list[0]?.why).toContain("觸發條件到了");
    expect(list.find((d) => d.goal === "g-a")?.weight).toBe(0.35);
    expect(list.find((d) => d.want === "play")?.capability).toBeNull();
  });

  it("is empty when she wants nothing in particular", () => {
    expect(rankDesires(inputs({ affect: null }))).toEqual([]);
  });
});

describe("wishes from her emotions", () => {
  const wants = (...w: AffectSnapshot["biases"]["wants"]) =>
    affect({ biases: { talkativeness: 0, initiative: 0, wants: w } });

  it("say which feeling it is", () => {
    const [top] = rankDesires(
      inputs(
        {
          affect: wants({
            want: "chat_with",
            weight: 0.7,
            person: "Owen",
            why: "難過,想有人陪",
            from: "sorrow",
          }),
          cards: [card("Owen", 0.8)],
        },
        { Owen: "online" },
      ),
    );
    expect(top).toMatchObject({ want: "chat_with", person: "Owen" });
    expect(top?.why).toContain("哀");
    expect(top?.why).not.toContain("寂寞");
  });

  it("an emotion's wish for something new is listed in words", () => {
    const [top] = rankDesires(
      inputs({
        affect: wants({
          want: "explore",
          weight: 0.5,
          person: null,
          why: "想換件事做",
          from: "disgust",
        }),
      }),
    );
    expect(top).toMatchObject({ want: "explore", label: "找點新鮮事", why: "想換件事做" });
  });

  it("missing someone without a card's feeling still counts", () => {
    const [top] = rankDesires(
      inputs(
        {
          affect: wants({
            want: "find_person",
            weight: 0.8,
            person: "Owen",
            why: "想念對方",
            from: "missing",
          }),
          cards: [card("Owen", 0.8)],
        },
        { Owen: "online" },
      ),
    );
    expect(top?.why).toContain("想念 0.7");
  });

  it("resentment takes her away from someone, not from what she decided", () => {
    const chat = {
      want: "chat_with",
      weight: 0.8,
      person: "Owen",
      why: "寂寞,想找人聊天",
      from: "lonely" as const,
    };
    const fine = inputs({ affect: wants(chat), cards: [card("Owen", 0.9)] }, { Owen: "online" });
    const cross = inputs(
      {
        affect: wants(chat),
        cards: [{ ...card("Owen", 0.9), emotions: { resentment: 1 } }],
      },
      { Owen: "online" },
    );
    const weight = (i: DesireInputs) => rankDesires(i)[0]?.weight ?? 0;
    expect(weight(cross)).toBeLessThan(weight(fine) * 0.5);

    const goal = {
      id: "G1",
      what: "問 Owen 那件事",
      person: "Owen",
      why: "",
      trigger: { kind: "whenever" },
    } as unknown as Goal;
    const kept = rankDesires({ ...cross, affect: affect(), goals: [goal] });
    expect(kept.find((d) => d.goal === "G1")?.weight).toBe(0.35);
  });

  it("no feeling lists someone blocked as who to go to", () => {
    const desires = rankDesires(
      inputs(
        {
          affect: wants({
            want: "chat_with",
            weight: 0.9,
            person: null,
            why: "寂寞,想找人聊天",
            from: "lonely",
          }),
          cards: [{ ...card("Troll", 0.9), blocked: true }],
        },
        { Troll: "voice" },
      ),
    );
    expect(desires.every((d) => d.person !== "Troll")).toBe(true);
  });
});
