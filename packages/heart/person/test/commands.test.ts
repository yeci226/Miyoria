// `/me profile | call | link` and `/admin person ...` end to end on the heart (phase 4 step 5):
// through the command registry, on a real store with the heart's tables.

import { type ArgValue, CommandRegistry, type CommandReply, Permissions } from "@miyoria/commands";
import { SqliteStore } from "@miyoria/store";
import { type AccountRef, type Clock, type ContextKey, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { FEELINGS, heartTables, PeopleDirectory, registerCommands } from "../src/index.js";

const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);
const GUILD: ContextKey = { platform: "discord", scope: "g", channel: "c", kind: "channel" };
const OWNER = "1";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const account = (id: string): AccountRef => ({ platform: "discord", id });

async function setup() {
  const clock: Clock = { now: () => T0 };
  const store = await SqliteStore.open(":memory:", { plugins: [heartTables], clock });
  cleanup.push(() => store.close());
  const people = new PeopleDirectory(
    "p",
    "米優",
    [],
    {
      people: store.people,
      identity: store.identity ?? null,
      heart: store.plugin(heartTables).people,
    },
    clock,
  );
  const registry = new CommandRegistry(Permissions.fromStrings([`discord:${OWNER}`]));
  registerCommands(registry, people);
  const run = (path: string, who: string, args: Record<string, ArgValue> = {}) =>
    registry.dispatch({
      path: path.split(" "),
      args,
      invoker: account(who),
      invoker_display_name: who === OWNER ? "Owen" : `user${who}`,
      context: GUILD,
      invoker_is_guild_admin: false,
    });
  const click = (id: string, who: string) =>
    registry.dispatchComponent({
      custom_id: id,
      message_id: "m",
      invoker: account(who),
      invoker_display_name: `user${who}`,
      context: GUILD,
      invoker_is_guild_admin: false,
    });
  return { store, people, heart: people.heart, registry, run, click };
}

const textOf = (r: CommandReply) => r.text;

describe("/me", () => {
  it("profile names the tier by the ladder and quotes her line for it", async () => {
    const { run, heart, people } = await setup();
    const first = await run("me profile", "5");
    expect(textOf(first)).toContain("關係：陌生人");
    expect(textOf(first)).toContain(FEELINGS.陌生人);
    const amy = people.personOf(account("5")) as string;
    heart.adminSet(amy, "bond", 130);
    const close = await run("me profile", "5");
    // The tier with its stage (H10); her line goes by the tier.
    expect(textOf(close)).toContain("關係：知心 II");
    expect(textOf(close)).toContain(FEELINGS.知心);
    expect(textOf(close)).not.toContain("130");
  });

  it("call sets, refuses and clears what she calls them, on the heart's row", async () => {
    const { run, heart, people } = await setup();
    expect(textOf(await run("me call", "5", { name: "阿咪" }))).toContain("阿咪");
    const amy = people.personOf(account("5")) as string;
    expect(heart.get(amy)?.call_name).toBe("阿咪");
    expect((await run("me call", "5", { name: "@everyone" })).tone).toBe("warn");
    expect(heart.get(amy)?.call_name).toBe("阿咪");
    await run("me call", "5", { name: "清除" });
    expect(heart.get(amy)?.call_name).toBeNull();
    // Someone she cannot stand does not get to choose.
    heart.adminSet(amy, "bond", -80);
    expect((await run("me call", "5", { name: "小天使" })).tone).toBe("warn");
  });

  it("link gives a code and makes two accounts one person, rows and all", async () => {
    const { run, heart, people } = await setup();
    const issued = await run("me link", "5");
    const code = /`([0-9A-Z]+)`/.exec(textOf(issued))?.[1] ?? "";
    expect(code).not.toBe("");
    await run("me call", "6", { name: "小號" });
    const done = await run("me link", "6", { code });
    expect(done.tone).toBe("success");
    const keep = people.personOf(account("5")) as string;
    expect(people.personOf(account("6"))).toBe(keep);
    expect(heart.get(keep)?.call_name).toBe("小號");
    expect((await run("me link", "6", { code: "WRONG123" })).tone).toBe("warn");
  });
});

describe("/admin person", () => {
  it("show, tag, untag, block, unblock, reset and adjust act on the heart", async () => {
    const { run, click, heart, people } = await setup();
    await run("me call", "5", { name: "阿咪" });
    const amy = people.personOf(account("5")) as string;
    const user = "discord:5";
    // Only the owner.
    expect((await run("admin person adjust", "7", { user, affinity: 50 })).tone).toBe("error");

    expect(textOf(await run("admin person adjust", OWNER, { user, affinity: 50 }))).toContain(
      "50.0（好朋友）",
    );
    expect(heart.get(amy)?.bond).toBe(50);
    expect(heart.log.history(amy)[0]?.change).toMatchObject({ cause: "admin", delta: 50 });

    const shown = textOf(await run("admin person show", OWNER, { user }));
    expect(shown).toContain("羈絆 50.0");
    expect(shown).toContain("稱呼：阿咪");

    await run("admin person tag", OWNER, { user, tag: "regular" });
    expect(heart.get(amy)?.tags).toEqual(["regular"]);
    expect((await run("admin person tag", OWNER, { user, tag: "Bad Tag!" })).tone).toBe("warn");
    await run("admin person untag", OWNER, { user, tag: "regular" });
    expect(heart.get(amy)?.tags).toEqual([]);

    await run("admin person block", OWNER, { user });
    expect(heart.get(amy)?.tags).toEqual(["blocked"]);
    expect(textOf(await run("me profile", "5"))).toContain("不會回應你");
    await run("admin person unblock", OWNER, { user });
    expect(heart.get(amy)?.tags).toEqual([]);

    const asked = await run("admin person reset", OWNER, { user });
    const yes = (asked.card?.blocks ?? [])
      .flatMap((b) => (b.type === "buttons" ? b.buttons.map((x) => x.id) : []))
      .find((id) => id.includes("reset:yes"));
    expect(yes).toBeDefined();
    await click(yes as string, OWNER);
    expect(heart.get(amy)).toMatchObject({ bond: 0, call_name: null, tags: [] });
    expect(toTimestamp(T0)).toBe(heart.get(amy)?.updated_at);
  });
});

describe("`/me profile` in the profile's words", () => {
  const texts = (words?: { coin: string; her: string }) => {
    const registry = new CommandRegistry(Permissions.fromStrings([`discord:${OWNER}`]));
    registerCommands(
      registry,
      {} as PeopleDirectory,
      undefined,
      undefined,
      undefined,
      ...(words ? [words] : []),
    );
    const spec = registry.get(["me", "profile"]);
    return [spec?.description ?? "", ...(spec?.args.map((a) => a.description) ?? [])].join("\n");
  };

  it("are today's with no profile, and another profile's coins and pronoun with one", () => {
    expect(texts()).toBe(
      "查看她對你的印象與她怎麼稱呼你\n看你這一週的回顧（聊天、點歌、抽卡、魚幣）\n附上圖（預設附上；false 只要文字）",
    );
    const kuro = texts({ coin: "貝殼", her: "牠" });
    expect(kuro).toContain("查看牠對你的印象與牠怎麼稱呼你");
    expect(kuro).toContain("抽卡、貝殼）");
    expect(kuro).not.toContain("魚幣");
  });
});
