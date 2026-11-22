// One name per person in her prompt (2026-11-22: members renamed their nicknames; the transcript
// named them by the new nickname, everything else by the handle, and nothing tied the two): the
// transcript, the wake line and the people block name people by handle, with the name shown now
// beside it. The names are made up.

import {
  type AccountRef,
  type HandleDirectory,
  HandleDirectoryKey,
  type HandleEntry,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { account, channel, line, mention, Rig, says, stopRigs, textOf, until } from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");

/** Nobu goes by "Model-9 Lumen" now, Kiri by "Kiri 10". */
function directory(): HandleDirectory {
  const rows: HandleEntry[] = [
    {
      handle: "Nobu",
      person: "p-nobu",
      account: account("nobu"),
      display_name: "Nobu",
      names: ["Model-9 Lumen"],
      created_at: "2026-11-01T00:00:00.000Z",
    },
    {
      handle: "Kiri",
      person: "p-kiri",
      account: account("kiri"),
      display_name: "Kiri",
      names: ["Kiri 10"],
      created_at: "2026-11-01T00:00:00.000Z",
    },
  ];
  return {
    ofAccount: (a: AccountRef, name: string) =>
      rows.find((r) => r.account?.id === a.id)?.handle ?? name,
    ofPerson: (p) => rows.find((r) => r.person === p)?.handle ?? null,
    resolve: (h) => rows.find((r) => r.handle === h) ?? null,
    list: () => rows,
  };
}

const as = (who: string, shown: string) => ({
  author: { account: account(who), display_name: shown, is_bot: false },
});

describe("people in her prompt", () => {
  it("are named by handle, with the name they go by now beside it", async () => {
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", HandleDirectoryKey, directory()),
    });
    rig.say(line(C1, "nobu", "早安", as("nobu", "Model-9 Lumen")));
    rig.model.push(says("嗨"));
    rig.say({
      ...mention(C1, "kiri", "@她 @Model-9 Lumen 剛剛說什麼?"),
      ...as("kiri", "Kiri 10"),
    });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    const text = textOf(rig.model.requests[0]);
    expect(text).toContain("Nobu(顯示名「Model-9 Lumen」): 早安");
    expect(text).toContain("Kiri(顯示名「Kiri 10」): @她 @Model-9 Lumen 剛剛說什麼?");
    expect(text).toContain('<person name="Nobu" shown_as="Model-9 Lumen"/>');
    expect(text).toContain("「Nobu」(現在叫「Model-9 Lumen」)");
    expect(text).toContain("<turn>Kiri 在叫你");
  });
});
