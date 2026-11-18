import { PartyConfigSchema } from "@miyoria/play/party";
import { Config } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { assertStartConfig } from "../src/config-schema.js";
import { removedConfigKeys, warnRemovedKeys } from "../src/removed-config.js";

const toml = (text: string): Config => Config.fromToml(text, () => "x");

describe("the party config of the quiz and the chains", () => {
  const old = toml(`
[modules.party]
quiz_rounds = 5
quiz_answer_secs = 30
chain_idle_secs = 20
story_turn_secs = 40
story_max_lines = 6
story_line_chars = 50
song_rounds = 3
soup_mins = 9
`);

  it("loads without an error, ignores the removed keys and keeps the others", () => {
    expect(() => assertStartConfig(old)).not.toThrow();
    const party = PartyConfigSchema.parse(old.section("modules.party"));
    for (const gone of [
      "quiz_rounds",
      "quiz_answer_secs",
      "chain_idle_secs",
      "story_turn_secs",
      "story_max_lines",
      "story_line_chars",
    ]) {
      expect(party).not.toHaveProperty(gone);
    }
    expect(party.song_rounds).toBe(3);
    expect(party.soup_mins).toBe(9);
  });

  it("names the removed keys in one warning, and not the ones still read", () => {
    const lines: string[] = [];
    const found = warnRemovedKeys(old, (m) => lines.push(m));
    expect(lines).toHaveLength(1);
    expect(found).toEqual([
      "modules.party.quiz_rounds",
      "modules.party.quiz_answer_secs",
      "modules.party.chain_idle_secs",
      "modules.party.story_turn_secs",
      "modules.party.story_max_lines",
      "modules.party.story_line_chars",
    ]);
    expect(lines[0]).not.toContain("song_rounds");
    expect(removedConfigKeys(toml(`[modules.party]\nsong_rounds = 3\n`))).toEqual([]);
  });
});
