// The coins' name and her pronoun come from the profile (docs/design/v5-profiles.md). This walks
// every command the economy, the keepsakes and the `/me` panels register, with another profile's
// words: each description, argument, reply, card line and panel label it reaches names the
// configured coins, never 魚幣, and the transfer still carries its small print. With no profile
// the words are today's, byte for byte.

import {
  type Card,
  CommandRegistry,
  type CommandReply,
  Permissions,
  panelDefs,
  registerKeepsakes,
} from "@miyoria/commands";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  CharacterKey,
  type ContextKey,
  CurrencyKey,
  DEFAULT_CHARACTER,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyCommands, TRANSFER_SMALL_PRINT } from "../src/commands.js";
import { REFUSAL_TEXT, refusalText, ruleRefusal } from "../src/gift-words.js";
import { type Economy, EconomyKey, type WalletView } from "../src/types.js";
import { transferSmallPrint } from "../src/words.js";

const ctx: ContextKey = { platform: "discord", scope: null, channel: "9", kind: "dm" };
const acct = (id: string): AccountRef => ({ platform: "discord", id });

function view(currency: string): WalletView {
  return {
    currency,
    balance: 120,
    can_earn: true,
    today_earned: 30,
    checked_in_today: false,
    streak: 2,
    earn: [{ reason: "checkin", label: "每日簽到", amount: 10, earned_today: 0, cap: 10 }],
    shop: [
      { id: "rice", kind: "feed", label: "一碗白飯", price: 10, available: true, why: null },
      { id: "big_bowl", kind: "feed", label: "一大碗白飯", price: 40, available: true, why: null },
    ],
    frames: { owned: [], selected: null },
    hungry: "hungry",
    recent: [],
    on_board: true,
    transfer_fee: 0.05,
  };
}

function economy(currency: string): Economy {
  return {
    wallet: async () => view(currency),
    checkin: async () => ({ gained: 10, streak: 3, balance: 130 }),
    feed: async () => ({ accepted: true, eaten: 1, charged: 10, balance: 110, message: "吃了" }),
    transfer: async (_a: AccountRef, _to: AccountRef, amount: number) => ({
      sent: amount,
      fee: 2,
      balance: 90,
      to: "Bob",
    }),
    board: async () => [{ rank: 1, name: "Bob", spent: 40 }],
    screenMessage: async () => ({ accepted: true, charged: 30, balance: 90, message: "上去了" }),
    danmaku: async () => ({ accepted: true, charged: 5, balance: 115, message: "送出了" }),
    bounties: async () => [],
    spacesFor: async () => undefined,
    setOnBoard: async () => true,
  } as unknown as Economy;
}

/** A registry with the economy's, the keepsakes' commands, under `words` (none: the defaults). */
function setup(words?: { coin: string; her: string }) {
  const registry = new CommandRegistry(Permissions.fromStrings(["discord:1", "discord:5"]));
  const services = new ServiceRegistry();
  services.provide("test", EconomyKey, economy(words?.coin ?? "魚幣"));
  if (words) {
    services.provide("kernel", CurrencyKey, words.coin);
    services.provide("kernel", CharacterKey, { ...DEFAULT_CHARACTER, pronoun: words.her });
  }
  new EconomyCommands().install(registry, services);
  registerKeepsakes(registry, services);
  return { registry, services };
}

const ARGS: Record<string, string | number | boolean> = {
  user: "77",
  amount: 25,
  text: "嗨",
  item: "rice",
  prediction: "p1",
  option: "1",
};

/** Everything a command shows: its card's lines, or its text. */
function shown(reply: CommandReply): string {
  const blocks = (reply.card as Card | undefined)?.blocks ?? [];
  const lines = blocks.flatMap((b) =>
    b.type === "text" || b.type === "muted"
      ? [b.text]
      : b.type === "buttons"
        ? b.buttons.map((x) => x.label)
        : [],
  );
  return [reply.text, reply.card?.title ?? "", ...lines].join("\n");
}

async function walk(registry: CommandRegistry): Promise<{ specs: string; replies: string[] }> {
  const specs = registry
    .specs()
    .flatMap((s) => [s.description, ...s.args.map((a) => a.description)])
    .join("\n");
  const replies: string[] = [];
  for (const spec of registry.specs()) {
    const out = await registry.dispatch({
      path: spec.path,
      // Only the arguments the command has, filled in when it needs them.
      args: Object.fromEntries(
        spec.args.flatMap((a) => {
          const value = ARGS[a.name];
          return value === undefined ? [] : [[a.name, value] as const];
        }),
      ),
      invoker: acct("5"),
      invoker_display_name: "Alice",
      context: ctx,
      invoker_is_guild_admin: false,
    });
    replies.push(`${spec.path.join(" ")}:\n${shown(out)}`);
  }
  return { specs, replies };
}

describe("the profile's words", () => {
  it("name the configured coins on every command, reply and panel, never 魚幣", async () => {
    const { registry, services } = setup({ coin: "貝殼", her: "牠" });
    const { specs, replies } = await walk(registry);
    expect(registry.specs().length).toBeGreaterThan(10);
    expect(specs).toContain("貝殼");
    expect(specs).not.toContain("魚幣");
    for (const r of replies) expect(r).not.toContain("魚幣");
    // The walk reached real answers, not only refusals.
    const all = replies.join("\n");
    expect(all).toContain("**120 貝殼**");
    expect(all).toContain("簽到了，+10 貝殼");
    expect(specs).toContain("用貝殼餵牠一碗飯，或自己取名送牠一樣東西");
    expect(specs).toContain("牠給你的每日卡：今天還沒有就發一張（要花貝殼），有了就看今天的");
    // The transfer keeps its small print, in the profile's words.
    const give = replies.find((r) => r.startsWith("me give:")) ?? "";
    expect(give).toContain(`-# ${transferSmallPrint("貝殼")}`);
    expect(transferSmallPrint("貝殼")).toBe(
      "貝殼只是遊戲裡的點數,沒有現金價值。禁止用真錢或任何現實物品買賣、交換貝殼;違反者可能被凍結錢包,衍生的糾紛或損失請自行負責。",
    );
    const panels = JSON.stringify(panelDefs({ services }));
    expect(panels).toContain("貝殼、簽到、餵牠");
    expect(panels).toContain("出貝殼佈置牠的房間");
    expect(panels).not.toContain("魚幣");
  });

  it("are today's, word for word, with no profile", async () => {
    const { registry } = setup();
    const { specs, replies } = await walk(registry);
    for (const line of [
      "你的魚幣：餘額、今天還能賺多少，可以簽到和餵她",
      "每日簽到，領魚幣（可以加買今天的籤詩）",
      "順便抽今天的籤詩（要花魚幣；已經簽到過也能只買籤詩）",
      "用魚幣餵她一碗飯，或自己取名送她一樣東西",
      "把魚幣轉給她認識的另一個人（另收手續費，會燒掉）",
      "對方收到多少魚幣（手續費你另付）",
      "花魚幣在直播大螢幕上留一則短留言（60 字內）",
      "花魚幣在她直播的畫面上發一則彈幕（從右邊飄過的短句）",
      "押魚幣猜預測的結果（猜中的人平分大家押的）",
      "押多少魚幣",
      "看她的房間大家湊到哪了，或出魚幣一起佈置",
      "出多少魚幣",
      "她給你的每日卡：今天還沒有就發一張（要花魚幣），有了就看今天的",
      "新卡做成閃卡（要多花魚幣）",
    ])
      expect(specs.split("\n"), line).toContain(line);
    expect(TRANSFER_SMALL_PRINT).toBe(
      "魚幣只是遊戲裡的點數,沒有現金價值。禁止用真錢或任何現實物品買賣、交換魚幣;違反者可能被凍結錢包,衍生的糾紛或損失請自行負責。",
    );
    const give = replies.find((r) => r.startsWith("me give:")) ?? "";
    expect(give).toContain(`-# ${TRANSFER_SMALL_PRINT}`);
    const panels = JSON.stringify(panelDefs({}));
    for (const label of [
      "魚幣、簽到、餵她",
      "轉魚幣給別人（另收手續費，會燒掉）",
      "對方收到多少魚幣",
      "押魚幣猜結果",
      "押多少魚幣",
      "出魚幣佈置她的房間",
      "出多少魚幣",
    ])
      expect(panels, label).toContain(label);
  });

  it("refuse coins as a gift under the configured name, and 魚幣 as always", () => {
    expect(ruleRefusal("100 貝殼", "貝殼")).toBe("money");
    expect(ruleRefusal("貝殼", "貝殼")).toBe("money");
    expect(ruleRefusal("100 魚幣", "貝殼")).toBe("money");
    expect(ruleRefusal("50 coins")).toBe("money");
    expect(ruleRefusal("貝殼項鍊", "貝殼")).toBeNull();
    expect(ruleRefusal("100 貝殼")).toBeNull();
    expect(refusalText("money")).toBe(REFUSAL_TEXT.money);
    expect(REFUSAL_TEXT.money).toBe("真錢、點數和魚幣都不能當禮物送");
    expect(refusalText("money", "貝殼")).toBe("真錢、點數和貝殼都不能當禮物送");
    expect(refusalText("bond", "貝殼")).toBe(REFUSAL_TEXT.bond);
  });
});
