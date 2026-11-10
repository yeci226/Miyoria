import { describe, expect, it } from "vitest";
import type { PersonRef } from "../src/prompt.js";
import { personByRef } from "../src/snapshot.js";

const person = (ref: string, name: string, id: string): PersonRef => ({
  ref,
  account: { platform: "discord", id },
  person: `p-${id}`,
  name,
  relation: null,
  feeling: null,
  heart: null,
  doing: null,
});

const people = [
  person("Owen", "Owen", "1"),
  person("Owen#2", "Owen", "2"),
  person("Amy", "Amy", "3"),
];

describe("people refs in a snapshot are her stable names", () => {
  it("a reply names a person by handle", () => {
    expect(personByRef(people, "Owen#2")?.account.id).toBe("2");
    expect(personByRef(people, " Amy ")?.account.id).toBe("3");
  });

  it("falls back to an unambiguous name, then to a legacy u<N> of this snapshot", () => {
    expect(personByRef(people, "Owen")?.account.id).toBe("1"); // exact handle wins over the name
    expect(personByRef([person("Owen", "Owen", "1")], "Owen")?.account.id).toBe("1");
    expect(personByRef(people, "u3")?.account.id).toBe("3");
    expect(personByRef(people, "u9")).toBeUndefined();
    expect(personByRef(people, "nobody")).toBeUndefined();
    expect(personByRef(people, "")).toBeUndefined();
  });
});
