// What she lives with one person is kept in their own scope (`PersonNoteWriterKey`).

import { afterEach, describe, expect, it } from "vitest";
import { PersonNotes } from "../src/index.js";
import { acct, BACKENDS, closeAll, env, guildCtx, t0 } from "./helpers.js";

afterEach(closeAll);

describe.each(BACKENDS)("person notes (%s)", (backend) => {
  it("writes an episode she recalls when that person is there, and only then", async () => {
    const e = await env(backend);
    const notes = new PersonNotes(e.engine);
    const owen = await e.person(acct("1"), "Owen");
    const amy = await e.person(acct("2"), "Amy");
    const text = "Owen 答應給我零食,我照做了卻沒給";
    expect(await notes.note(owen, text, { importance: 0.7, at: t0() })).toBe(true);
    // Said again, it is the same memory, not a second one.
    expect(await notes.note(owen, text, { importance: 0.7, at: t0(1000) })).toBe(true);

    const scopes = [{ type: "person" as const, person: owen }];
    const recalled = await e.engine.recall(scopes, [owen], "零食", ["episode"], 10, t0(2000));
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.record).toMatchObject({
      kind: "episode",
      origin: "experienced",
      subjects: [owen],
      scope: { type: "person", person: owen },
    });
    // Not recalled where Owen is not present.
    const elsewhere = [{ type: "person" as const, person: amy }];
    expect(await e.engine.recall(elsewhere, [amy], "零食", ["episode"], 10, t0(2000))).toEqual([]);
    const guild = [{ type: "channel" as const, context: guildCtx("g", "c") }];
    expect(await e.engine.recall(guild, [], "零食", ["episode"], 10, t0(2000))).toEqual([]);
  });

  it("says no when nothing was stored", async () => {
    const e = await env(backend);
    const notes = new PersonNotes(e.engine);
    const owen = await e.person(acct("1"), "Owen");
    expect(await notes.note(owen, "   ", { importance: 0.5, at: t0() })).toBe(false);
  });
});
