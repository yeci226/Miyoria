// The check that keeps one person's name off another person's page.

import { describe, expect, it } from "vitest";
import {
  type KnownName,
  mentionsAnother,
  type PersonCard,
  renderPeople,
  splitNames,
} from "../src/index.js";

const names = { own: ["Alice", "小愛"], others: ["Bob", "鈴木", "Owen#2"] };

describe("mentionsAnother", () => {
  it("lets a line about the person alone through", () => {
    expect(mentionsAnother("小愛總是記得跟我打招呼。", names)).toBe(false);
    expect(mentionsAnother("Alice 最近常來。", names)).toBe(false);
    expect(mentionsAnother("", names)).toBe(false);
  });

  it("finds another name however it is written", () => {
    for (const text of ["妳和 Bob 很好", "妳和 bob 很好", "妳和 B o b 很好", "妳和 Ｂｏｂ 很好"]) {
      expect(mentionsAnother(text, names), text).toBe(true);
    }
    expect(mentionsAnother("鈴木說妳很好", names)).toBe(true);
  });

  it("finds a handle without its suffix", () => {
    expect(mentionsAnother("妳和 Owen 很好", names)).toBe(true);
    expect(mentionsAnother("妳和 Owen#2 很好", names)).toBe(true);
  });

  it("does not take the person's own longer name for someone else's shorter one", () => {
    const split = { own: ["Bobby"], others: ["Bob"] };
    expect(mentionsAnother("Bobby 今天很開心", split)).toBe(false);
    expect(mentionsAnother("Bobby 和 Bob 今天很開心", split)).toBe(true);
  });

  it("counts mentions and long ids as naming someone", () => {
    expect(mentionsAnother("妳和 <@123> 很好", names)).toBe(true);
    expect(mentionsAnother("妳和 1120284154957930588 很好", names)).toBe(true);
  });

  it("does not let a single letter stop every line", () => {
    expect(mentionsAnother("hello", { own: [], others: ["h", " "] })).toBe(false);
  });

  it("keeps a one-character name in CJK: dropping a line costs less than showing one", () => {
    expect(mentionsAnother("妳和光一起玩", { own: [], others: ["光"] })).toBe(true);
  });
});

describe("splitNames", () => {
  const known: KnownName[] = [
    { name: "Alice", person: "p1", account: null },
    { name: "Ally", person: null, account: { platform: "discord", id: "1" } },
    { name: "Bob", person: "p2", account: null },
    { name: "Carol", person: null, account: { platform: "discord", id: "3" } },
  ];

  it("sorts names by whose they are, by person or by account", () => {
    expect(splitNames(known, "p1", [{ platform: "discord", id: "1" }])).toEqual({
      own: ["Alice", "Ally"],
      others: ["Bob", "Carol"],
    });
  });

  it("gives someone unknown no names of their own", () => {
    expect(splitNames(known, null, []).own).toEqual([]);
  });
});

describe("prompts", () => {
  it("never carry the line written for the page", () => {
    const card: PersonCard = {
      person: "p1",
      handle: "Alice",
      call_name: null,
      affinity: 30,
      trust: 40,
      familiarity: 40,
      attachment: 0.4,
      emotions: {},
      feeling: "有點在意",
      public_feeling: "PUBLIC-LINE",
      label: "朋友",
      level: 6,
      owner: false,
      blocked: false,
      last_seen: null,
      last_together: null,
      updated_at: "",
    };
    expect(renderPeople([card]).join("\n")).not.toContain("PUBLIC-LINE");
  });
});
