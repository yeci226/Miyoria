// One question, one followup (2026-11-09 to 11-10: ten reworded records of 「外掃區收得怎樣」 for
// one person; answered in a DM, she still asked it seven times in the channel and again in the DM
// nine minutes later).

import { MockProvider } from "@miyoria/llm";
import type { MemoryRecord, MemoryScope } from "@miyoria/store";
import type { ContextKey, PersonId } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { memoryConfig, memoryFilter, parseExtraction, sameMatter, storedId } from "../src/index.js";
import {
  acct,
  BACKENDS,
  closeAll,
  dmCtx,
  type Env,
  envWith,
  guildCtx,
  HOUR,
  MINUTE,
  plus,
  profile,
  SECOND,
  t0,
} from "./helpers.js";

afterEach(closeAll);

const SWEEP = [
  "問 Sakana2486 回來後外掃區收得怎樣，把最懶的兩個抓來當副組長那招有沒有用",
  "等他上線後問外掃區那題",
  "問他外掃區的那個問題",
  "追問外掃區後來收得怎樣、把最懶的兩個抓來當副組長那招有沒有用",
  "問他外掃區那兩個副組長後來有沒有繼續摸魚、這招還管不管用",
  "外掃區把最懶兩人當副組長那招，實際收得怎樣、有沒有用",
];

describe("sameMatter", () => {
  it("the same question reworded is the same matter", () => {
    for (const a of SWEEP) {
      for (const b of SWEEP) expect(sameMatter(a, b, ["Sakana2486"]), `${a} / ${b}`).toBe(true);
    }
  });

  it("other questions about the same person are not", () => {
    const others = [
      "問他作業到底是哪一題不會，需不需要我教他",
      "問他那首要給我聽的「好歌」到底是哪一首，請他把歌名講清楚",
      "問他到底講不講一句臺語，讓我決定要不要學",
      "問他單字到底背了沒",
      "問 Owen 期末考考得怎樣",
      "問 Owen 期中考考得怎樣",
      "問他要不要一起打遊戲",
      "問他要不要一起吃飯",
      "問他明天去南港的事（去辦什麼、順不順利）",
      "問 Sakana2486 明天去高雄玩得怎樣",
    ];
    for (let i = 0; i < others.length; i++) {
      for (let j = i + 1; j < others.length; j++) {
        const a = others[i] as string;
        const b = others[j] as string;
        expect(sameMatter(a, b, ["Owen", "Sakana2486"]), `${a} / ${b}`).toBe(false);
      }
      for (const s of SWEEP) expect(sameMatter(others[i] as string, s)).toBe(false);
    }
  });

  it("without Han characters it compares words", () => {
    expect(sameMatter("ask Owen whether the PR #7 merge went through", "PR #7 merge done?")).toBe(
      true,
    );
    expect(sameMatter("ask Owen about the exam", "ask Owen about dinner", ["Owen"])).toBe(false);
  });
});

describe("parseExtraction: pending followups", () => {
  it("reads same_as and answered_followups leniently", () => {
    const x = parseExtraction(`{
      "followups": [
        {"subject_name": "Owen", "about": "問 Owen 外掃區", "due_in_hours": 2, "same_as": "F2"},
        {"subject_name": "Owen", "about": "問 Owen 考試", "due_in_hours": 2, "same_as": null},
        {"subject_name": "Owen", "about": "問 Owen 晚餐", "due_in_hours": 2, "same_as": "晚餐那條"}
      ],
      "answered_followups": ["f1", "[f3]", 4, "f1", "nope", 0]
    }`);
    expect(x.followups.map((f) => f.same_as)).toEqual(["f2", null, null]);
    expect(x.answered_followups).toEqual(["f1", "f3", "f4"]);
    expect(parseExtraction(`{"facts": []}`).answered_followups).toEqual([]);
  });
});

const G1: MemoryScope = { type: "guild", platform: "discord", guild: "g1" };

async function followup(
  e: Env,
  scope: MemoryScope,
  subjects: PersonId[],
  content: string,
  context: ContextKey,
  at = t0(-2 * HOUR),
): Promise<string> {
  return storedId(
    await e.engine.store(
      {
        kind: "followup",
        scope,
        subjects,
        content,
        importance: 0.5,
        confidence: 1,
        source_context: context,
        source: null,
        origin: "experienced",
        source_events: [],
        due: plus(at, 12 * HOUR),
      },
      at,
    ),
  );
}

async function open(e: Env): Promise<MemoryRecord[]> {
  const all = await e.store.memories.list(profile(), memoryFilter(100, { kind: "followup" }));
  return all.filter((r) => !r.done);
}

const answer = (followups: string, answered = "[]") => `{
  "episode": null, "facts": [], "self_notes": [],
  "followups": ${followups},
  "answered_followups": ${answered}
}`;

describe.each(BACKENDS)("followups in consolidation (%s store)", (backend) => {
  async function dmSetup(llm: MockProvider) {
    const e = await envWith(backend, memoryConfig(), llm, null);
    const sakanaAcct = acct("7");
    const sakana = await e.person(sakanaAcct, "Sakana2486");
    const owen = await e.person(acct("2"), "Owen");
    const dm = dmCtx("d-sakana");
    const guild = guildCtx("g1", "c1");
    const dmScope: MemoryScope = { type: "dm", account: sakanaAcct };
    return { e, sakana, sakanaAcct, owen, dm, guild, dmScope };
  }

  it("shows what is pending, closes what the stretch answered and everything like it", async () => {
    const llm = new MockProvider("sum").reply(answer("[]", `["f1"]`));
    const { e, sakana, sakanaAcct, owen, dm, guild, dmScope } = await dmSetup(llm);
    await followup(e, G1, [sakana], SWEEP[0] as string, guild);
    // Named nobody ("問他"), from the channel.
    await followup(e, G1, [], SWEEP[2] as string, guild, t0(-HOUR));
    await followup(e, dmScope, [sakana], SWEEP[3] as string, dm, t0(-30 * MINUTE));
    // Something else for him, and the same matter for someone else, stay.
    await followup(e, G1, [sakana], "問他單字到底背了沒", guild);
    await followup(e, G1, [owen], "問 Owen 外掃區那招有沒有用", guild);

    const t = t0(-5 * MINUTE);
    await e.log(dm, sakanaAcct, "Sakana2486", "外掃區那招失敗了,老師不讓", t, false);
    await e.log(dm, acct("1"), "我", "原來是老師不讓", plus(t, 5 * SECOND), true);
    const report = await e.engine.consolidate(dm, t0());

    const user = llm.requests()[0]?.messages[1]?.content ?? "";
    expect(user).toContain("待追問");
    // Newest first, and only what may be shown to him: his DM one, his channel ones.
    expect(user).toContain(`[f1] ${SWEEP[3]}`);
    expect(user).toContain("單字");
    // A followup naming nobody from another place, and one about Owen, are not his.
    expect(user).not.toContain(SWEEP[2] as string);
    expect(user).not.toContain("Owen 外掃區");

    expect(report.closed).toBe(3);
    expect((await open(e)).map((r) => r.content).sort()).toEqual(
      ["問 Owen 外掃區那招有沒有用", "問他單字到底背了沒"].sort(),
    );
  });

  it("a reworded followup is not written again: same_as, an open one, or one answered lately", async () => {
    const llm = new MockProvider("sum")
      .reply(
        answer(
          `[{"subject_name": "Sakana2486", "about": "${SWEEP[4]}", "due_in_hours": 2, "same_as": "f1"}]`,
        ),
      )
      // No same_as, no name: in a DM it is him, and the open one holds it.
      .reply(answer(`[{"about": "${SWEEP[5]}", "due_in_hours": 2}]`))
      .reply(answer("[]", `["f1"]`))
      // Answered: the next stretch asking it again writes nothing either.
      .reply(answer(`[{"subject_name": "Sakana2486", "about": "${SWEEP[1]}", "due_in_hours": 3}]`))
      // Something new is written.
      .reply(
        answer(`[{"subject_name": "Sakana2486", "about": "問他單字背了沒", "due_in_hours": 3}]`),
      );
    const { e, sakana, sakanaAcct, dm, dmScope } = await dmSetup(llm);
    await followup(e, dmScope, [sakana], SWEEP[0] as string, dm);

    let t = t0(-10 * MINUTE);
    const said = async (text: string) => {
      t = plus(t, MINUTE);
      await e.log(dm, sakanaAcct, "Sakana2486", text, t, false);
      return e.engine.consolidate(dm, plus(t, SECOND));
    };
    expect((await said("我回來了")).reinforced).toBe(1);
    expect((await said("外掃區今天要掃")).reinforced).toBe(1);
    expect((await open(e)).map((r) => r.content)).toEqual([SWEEP[0]]);
    expect((await said("那招失敗了")).closed).toBe(1);
    expect(await open(e)).toEqual([]);
    const again = await said("嗯");
    expect(again.inserted).toBe(0);
    expect(again.skipped).toBe(1);
    expect((await said("我要去背單字")).inserted).toBe(1);
    expect((await open(e)).map((r) => r.content)).toEqual(["問他單字背了沒"]);
  });

  it("bringing one up closes the others about the same thing", async () => {
    const { e, sakana, owen, dm, guild, dmScope } = await dmSetup(new MockProvider("sum"));
    const first = await followup(e, G1, [sakana], SWEEP[0] as string, guild);
    await followup(e, dmScope, [sakana], SWEEP[4] as string, dm);
    await followup(e, G1, [], SWEEP[1] as string, guild);
    await followup(e, G1, [sakana], "問他單字到底背了沒", guild);
    await followup(e, G1, [owen], "問 Owen 外掃區那招有沒有用", guild);
    await e.engine.markDone(first);
    expect((await open(e)).map((r) => r.content).sort()).toEqual(
      ["問 Owen 外掃區那招有沒有用", "問他單字到底背了沒"].sort(),
    );
  });

  it("followup_repeat_hours = 0: only open ones hold a question", async () => {
    const llm = new MockProvider("sum").reply(
      answer(`[{"subject_name": "Sakana2486", "about": "${SWEEP[1]}", "due_in_hours": 3}]`),
    );
    const e = await envWith(backend, memoryConfig({ followup_repeat_hours: 0 }), llm, null);
    const sakanaAcct = acct("7");
    const sakana = await e.person(sakanaAcct, "Sakana2486");
    const dm = dmCtx("d-sakana");
    const first = await followup(
      e,
      { type: "dm", account: sakanaAcct },
      [sakana],
      SWEEP[0] as string,
      dm,
    );
    await e.engine.markDone(first);
    await e.log(dm, sakanaAcct, "Sakana2486", "外掃區", t0(-MINUTE), false);
    expect((await e.engine.consolidate(dm, t0())).inserted).toBe(1);
  });
});
