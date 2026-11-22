import { describe, expect, it } from "vitest";
import {
  assignHandle,
  describePerson,
  directoryCandidates,
  type HandleEntry,
  matchPersonName,
  namedIn,
  nameRefusal,
  type PersonCandidate,
  type PersonId,
  toTimestamp,
} from "../src/index.js";

const at = toTimestamp(0);
const row = (handle: string, person: string, first: string, names: string[] = []): HandleEntry => ({
  handle,
  person: person as PersonId,
  account: { platform: "discord", id: person },
  display_name: first,
  names,
  created_at: at,
});

// Made-up members: Nobu renamed to "Model-9 Lumen", Kiri to "Kiri 10", Sora kept her name.
const table = [
  row("Nobu", "p1", "Nobu", ["Model-9 Lumen"]),
  row("Kiri", "p2", "Kiri", ["Kiri 10"]),
  row("Sora", "p3", "Sora", ["Sora"]),
  row("Lumen", "p4", "Lumen", ["Lumen"]),
];
const people = directoryCandidates({ list: () => table }, [
  { person: "p2" as PersonId, call_name: "琪琪" },
]);
const one = (said: string, list: readonly PersonCandidate[] = people) => {
  const m = matchPersonName(said, list);
  return m.kind === "one" ? m.candidate.handle : m.kind;
};

describe("matchPersonName", () => {
  it("takes the handle, a name they go by now, the first name and her call name", () => {
    expect(one("Nobu")).toBe("Nobu");
    expect(one("@nobu")).toBe("Nobu");
    expect(one("model-9 lumen")).toBe("Nobu");
    expect(one("Model-9Lumen")).toBe("Nobu");
    expect(one("Kiri 10")).toBe("Kiri");
    expect(one("琪琪")).toBe("Kiri");
  });

  it("refuses part of a name, listing who it may be by handle and shown name", () => {
    const m = matchPersonName("Model", people);
    expect(m.kind).toBe("none");
    if (m.kind === "one") return;
    expect(m.candidates.map((c) => c.handle)).toEqual(["Nobu"]);
    expect(nameRefusal(m)).toContain("「Nobu」(現在叫「Model-9 Lumen」)");
  });

  it("knows nobody for a name nobody has", () => {
    const m = matchPersonName("Zed", people);
    expect(m).toEqual({ kind: "none", said: "Zed", candidates: [] });
    if (m.kind !== "one") expect(nameRefusal(m)).toBe("不知道「Zed」是誰");
  });

  it("refuses a name two people go by", () => {
    const twins = directoryCandidates({
      list: () => [row("Ame", "p5", "Ame", ["Rain"]), row("Kumo", "p6", "Kumo", ["Rain"])],
    });
    const m = matchPersonName("rain", twins);
    expect(m.kind).toBe("ambiguous");
    if (m.kind === "ambiguous") {
      expect(nameRefusal(m)).toContain("「Ame」");
      expect(nameRefusal(m)).toContain("「Kumo」");
    }
  });

  it("finds a person by the handle even when someone else renamed to it", () => {
    // Kiri renames to "Nobu": "Nobu" is still Nobu, never Kiri.
    const renamed = directoryCandidates({
      list: () => [
        row("Nobu", "p1", "Nobu", ["Model-9 Lumen"]),
        row("Kiri", "p2", "Kiri", ["Nobu"]),
      ],
    });
    expect(one("Nobu", renamed)).toBe("Nobu");
    // "Lumen" is someone's handle and part of Nobu's nickname: the handle wins.
    expect(one("Lumen")).toBe("Lumen");
  });

  it("does not find someone by a name they no longer go by", () => {
    const now = directoryCandidates({ list: () => [row("Kiri", "p2", "Kiri", ["Kiri 10"])] });
    expect(one("Kiri 9", now)).toBe("none");
  });

  it("describes a candidate by handle, what they go by now and her call name", () => {
    const kiri = people.find((c) => c.handle === "Kiri") as PersonCandidate;
    expect(describePerson(kiri)).toBe("「Kiri」(現在叫「Kiri 10」)(你叫他「琪琪」)");
    const sora = people.find((c) => c.handle === "Sora") as PersonCandidate;
    expect(describePerson(sora)).toBe("「Sora」");
  });
});

describe("namedIn", () => {
  it("finds whom a line names, spaces and @ or not", () => {
    const line = "順便問一下,Kiri 10,你上次說要去逛;逛得怎麼樣?";
    expect(namedIn(line, people).map((c) => c.handle)).toEqual(["Kiri"]);
    expect(namedIn("@Model-9 Lumen 早安", people).map((c) => c.handle)).toEqual(["Nobu"]);
    expect(namedIn("琪琪你好", people).map((c) => c.handle)).toEqual(["Kiri"]);
  });

  it("does not take a name inside another word, or an ordinary word without an @", () => {
    expect(namedIn("nobuddy here", people)).toEqual([]);
    const word = directoryCandidates({ list: () => [row("大家", "p7", "大家")] });
    expect(namedIn("大家晚安", word)).toEqual([]);
    expect(namedIn("@大家 晚安", word).map((c) => c.handle)).toEqual(["大家"]);
  });
});

describe("assignHandle", () => {
  it("gives a word that means nobody or everyone a suffix", () => {
    expect(assignHandle("大家", () => false)).toBe("大家#2");
    expect(assignHandle("Nobody", () => false)).toBe("Nobody#2");
    expect(assignHandle("speaker", () => false)).toBe("speaker#2");
    expect(assignHandle("大家好", () => false)).toBe("大家好");
  });
});
