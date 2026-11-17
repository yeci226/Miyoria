// What her reflection may do to her memory (`MemoryCuratorKey`).

import { afterEach, describe, expect, it } from "vitest";
import { Curator } from "../src/index.js";
import { acct, BACKENDS, closeAll, DAY, dmCtx, env, guildCtx, t0 } from "./helpers.js";

afterEach(closeAll);

describe.each(BACKENDS)("curator (%s)", (backend) => {
  it("merges notes of one scope into an insight, supersedes contradictions, never shows DMs", async () => {
    const e = await env(backend);
    const curator = new Curator(e.engine);
    const owen = await e.person(acct("1"), "Owen");
    const guild = { type: "guild" as const, platform: "discord", guild: "g1" };
    const a = await e.add("fact", guild, [owen], "Owen 喜歡拉麵", 0.5, t0());
    const b = await e.add("fact", guild, [owen], "Owen 每週五都去吃一蘭", 0.6, t0(1000));
    const old = await e.add("fact", guild, [owen], "Owen 住在台北市區", 0.5, t0(2000));
    const newer = await e.add("fact", guild, [owen], "Owen 上個月搬去台中了", 0.5, t0(3000));
    const dm = await e.add(
      "fact",
      { type: "dm", account: acct("1") },
      [owen],
      "私訊裡的秘密",
      0.9,
      t0(4000),
    );
    const channel = await e.add(
      "fact",
      { type: "channel", context: guildCtx("g2", "c2") },
      [owen],
      "別的伺服器頻道的事",
      0.5,
      t0(5000),
    );
    const dmChannel = await e.add(
      "fact",
      { type: "channel", context: dmCtx("d1") },
      [owen],
      "私訊頻道的事",
      0.5,
      t0(6000),
    );
    const notes = await curator.notes(t0(-DAY), 50);
    const ids = notes.map((n) => n.id);
    expect(ids).not.toContain(dm);
    expect(ids).not.toContain(dmChannel);
    expect(ids).toEqual(expect.arrayContaining([a, b, old, newer, channel]));

    const insight = await curator.insight(
      { content: "Owen 超愛拉麵,每週五固定去一蘭", kind: "fact", from: [a, b], importance: 0.7 },
      t0(7000),
    );
    expect((await e.rec(a))?.superseded_by).toBe(insight);
    expect((await e.rec(b))?.superseded_by).toBe(insight);
    const merged = await e.rec(insight);
    expect(merged?.scope).toEqual(guild);
    expect(merged?.subjects).toEqual([owen]);
    // Different privacy scopes are never merged; DMs are not even reachable.
    await expect(
      curator.insight(
        { content: "x", kind: "fact", from: [newer, channel], importance: 0.5 },
        t0(),
      ),
    ).rejects.toThrow(/scopes/);
    await expect(
      curator.insight({ content: "x", kind: "fact", from: [dm], importance: 0.5 }, t0()),
    ).rejects.toThrow(/unknown/);

    expect(await curator.supersede(old, newer, t0(8000))).toBe(true);
    expect((await e.rec(old))?.superseded_by).toBe(newer);
    // Only a newer note supersedes an older one.
    expect(await curator.supersede(newer, insight, t0(9000))).toBe(true);
    const live = (await curator.notes(t0(-DAY), 50)).map((n) => n.id);
    expect(live).not.toContain(old);
    expect(live).not.toContain(a);
  });
});
