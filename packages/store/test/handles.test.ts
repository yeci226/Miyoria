import { type AccountRef, isEphemeralHandle, isValidHandle } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_SETTINGS_PROFILE,
  HANDLE_PREFIX,
  MemorySettingsStore,
  type Person,
  StoredHandleDirectory,
} from "../src/index.js";

const acct = (id: string): AccountRef => ({ platform: "discord", id });

function person(id: string, name: string, accounts: AccountRef[]): Person {
  return {
    id,
    display_name: name,
    created_at: "2026-11-01T00:00:00.000Z",
    accounts: accounts.map((a) => ({
      account: a,
      display_name: name,
      first_seen: "2026-11-01T00:00:00.000Z",
      last_seen: "2026-11-01T00:00:00.000Z",
    })),
  };
}

describe("StoredHandleDirectory", () => {
  it("a handle is the display name; the same account always gets the same one", () => {
    const dir = new StoredHandleDirectory(null);
    expect(dir.ofAccount(acct("1"), "Owen")).toBe("Owen");
    // Renaming later does not rename the handle.
    expect(dir.ofAccount(acct("1"), "Owen the Great")).toBe("Owen");
    expect(dir.resolve("Owen")?.account).toEqual(acct("1"));
    expect(dir.resolve("Owen the Great")).toBeNull();
  });

  it("only a second person with the same name gets a suffix", () => {
    const dir = new StoredHandleDirectory(null);
    expect(dir.ofAccount(acct("1"), "Owen")).toBe("Owen");
    expect(dir.ofAccount(acct("2"), "Owen")).toBe("Owen#2");
    expect(dir.ofAccount(acct("3"), "Owen")).toBe("Owen#3");
    expect(dir.ofAccount(acct("4"), "御坂")).toBe("御坂");
    // The first one keeps its bare name however often it is asked for.
    expect(dir.ofAccount(acct("1"), "Owen")).toBe("Owen");
    // Case alone does not make two names different (the model cannot tell them apart either).
    expect(dir.ofAccount(acct("5"), "owen")).toBe("owen#4");
    expect(dir.list().map((e) => e.handle)).toEqual(["Owen", "Owen#2", "Owen#3", "御坂", "owen#4"]);
  });

  it("never hands out a per-call code as a handle", () => {
    const dir = new StoredHandleDirectory(null);
    for (const [i, name] of ["u1", "p2", "g3", "", "   "].entries()) {
      const handle = dir.ofAccount(acct(`x${i}`), name);
      expect(isEphemeralHandle(handle)).toBe(false);
      expect(isValidHandle(handle)).toBe(true);
    }
  });

  it("persists rows, and a new instance gives the same names (restart)", async () => {
    const settings = new MemorySettingsStore();
    const first = new StoredHandleDirectory(settings);
    expect(first.ofAccount(acct("1"), "Owen", "person-a")).toBe("Owen");
    expect(first.ofAccount(acct("2"), "Owen")).toBe("Owen#2");
    await first.flush();

    const rows = await settings.list(GLOBAL_SETTINGS_PROFILE, HANDLE_PREFIX);
    expect([...rows.keys()]).toEqual(["handle:discord:1", "handle:discord:2"]);

    const second = await StoredHandleDirectory.open(settings);
    // A different display name now, and a different order of arrival: nothing changes.
    expect(second.ofAccount(acct("2"), "Mikoto")).toBe("Owen#2");
    expect(second.ofAccount(acct("1"), "Someone")).toBe("Owen");
    expect(second.ofAccount(acct("3"), "Owen")).toBe("Owen#3");
    expect(second.ofPerson("person-a")).toBe("Owen");
    expect(second.resolve("Owen#2")?.display_name).toBe("Owen");
  });

  it("links accounts to people and answers ofPerson", () => {
    const dir = new StoredHandleDirectory(null);
    expect(dir.ofPerson("p-1")).toBeNull();
    dir.ofAccount(acct("1"), "Owen");
    dir.syncPeople([
      person("p-1", "Owen", [acct("1"), acct("9")]),
      person("p-2", "Amy", [acct("2")]),
    ]);
    expect(dir.ofPerson("p-1")).toBe("Owen");
    expect(dir.ofPerson("p-2")).toBe("Amy");
    // The second account of the same person is a handle of its own (suffix), the person's
    // handle stays the first one.
    expect(dir.list().map((e) => [e.handle, e.person])).toEqual([
      ["Owen", "p-1"],
      ["Owen#2", "p-1"],
      ["Amy", "p-2"],
    ]);
    expect(dir.ensurePerson(person("p-1", "Owen", [acct("1")]))).toBe("Owen");
  });

  it("ignores rows that are not valid handles", async () => {
    const settings = new MemorySettingsStore();
    await settings.set(GLOBAL_SETTINGS_PROFILE, "handle:discord:1", {
      handle: "u1",
      person: null,
      account: { ...acct("1") },
      display_name: "u1",
      created_at: "2026-11-01T00:00:00.000Z",
    });
    const dir = await StoredHandleDirectory.open(settings);
    expect(dir.list()).toEqual([]);
    expect(isEphemeralHandle(dir.ofAccount(acct("1"), "u1"))).toBe(false);
  });
});
