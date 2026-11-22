// The auction's words come from the profile (docs/design/v5-profiles.md): her pick's rules and
// `/me auction` name the configured coins; with none they read as always, word for word.

import { CommandRegistry, Permissions } from "@miyoria/commands";
import { describe, expect, it } from "vitest";
import { registerCommands } from "../src/commands.js";
import { lotRules } from "../src/lots.js";

function texts(coin?: string, her?: string): string {
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1"]));
  registerCommands(registry, () => null, coin, her);
  return registry
    .specs()
    .flatMap((s) => [s.description, ...s.args.map((a) => a.description)])
    .join("\n");
}

describe("the auction's words", () => {
  it("are today's with no profile", () => {
    expect(
      lotRules(),
    ).toBe(`這週的拍賣由你決定要拍什麼。拍賣在一個頻道公開出價一天,得標的魚幣會燒掉。
從下面的選項挑一個,只輸出一個 JSON:{"lot": "<代號>", "why": "<一句話,20 字內>"}。
不用想錢,也不用想誰會得標;照你這週想拍什麼來挑。`);
    const all = texts();
    expect(all).toContain("出價(會先押住你的魚幣,被超過就退回)");
    expect(all).toContain("得標「她怎麼叫你」之後,想讓她怎麼叫你");
  });

  it("name another profile's coins and pronoun, never 魚幣", () => {
    expect(lotRules("貝殼")).toContain("得標的貝殼會燒掉");
    expect(lotRules("貝殼")).not.toContain("魚幣");
    const all = texts("貝殼", "牠");
    expect(all).toContain("出價(會先押住你的貝殼,被超過就退回)");
    expect(all).toContain("得標「牠怎麼叫你」之後,想讓牠怎麼叫你");
    expect(all).not.toContain("魚幣");
  });
});
