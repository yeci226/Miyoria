// `/me profile | call | link` and `/admin person ...`.
//
// System text is neutral; the only line in her own voice is the flavour line of `/me profile`
// (how she feels about you).

import {
  type AnyComponentRoute,
  ArgKind,
  argSpec,
  type CardBlock,
  type CommandRegistry,
  type CommandReply,
  type CommandSpec,
  ComponentResult,
  cancelled,
  cardReply,
  commandSpec,
  componentId,
  confirm,
  defineRoute,
  type Invocation,
  notice,
  parseAccount,
} from "@miyoria/commands";
import { type AccountRef, accountRefString, type PersonId, toTimestamp } from "@miyoria/types";
import type { LinkOutcome, Social } from "./engine.js";
import { BLOCKED_TAG, type EventKind, isBlocked, label, OWNER_TAG } from "./rel.js";
import { classify } from "./rules.js";

/** Paths registered by `registerCommands`. */
export const PATHS: readonly string[] = [
  "me profile",
  "me call",
  "me link",
  "admin person show",
  "admin person tag",
  "admin person untag",
  "admin person block",
  "admin person unblock",
  "admin person reset",
  "admin person adjust",
];

const MAX_CALL_NAME_CHARS = 20;
const MAX_TAG_CHARS = 24;

/** Changing the `owner` tag needs this node besides `admin.person.tag`. */
export const NODE_OWNER_TAG = "owner.person.tag";
const NODE_ADJUST = "owner.person.adjust";

const R = {
  callEdit: "me:call:edit",
  callSubmit: "me:call:submit",
  callClear: "me:call:clear",
  linkCode: "me:link:code",
  resetYes: "admin:person:reset:yes",
  resetNo: "admin:person:reset:no",
} as const;

/** The `/me memory show` button (the memory module owns the route). */
const MEMORY_SHOW = "me:memory:show";

type AdminOp = "show" | "tag" | "untag" | "block" | "unblock" | "reset" | "adjust";

/** Registers the social commands. Undo with `unregisterCommands`. */
export function registerCommands(registry: CommandRegistry, social: Social): void {
  const callRoutes: AnyComponentRoute[] = [
    {
      route: R.callEdit,
      handle: () =>
        ComponentResult.modal({
          id: componentId(R.callSubmit),
          title: "設定稱呼",
          fields: [
            {
              id: "call",
              label: "想讓她怎麼稱呼你",
              placeholder: "例如：小明",
              maxLength: MAX_CALL_NAME_CHARS,
            },
          ],
        }),
    },
    {
      route: R.callSubmit,
      handle: async (inv) => {
        const result = await setCall(social, inv, inv.field("call"));
        if (result.tone === "warn" || result.tone === "error" || inv.messageId === null) {
          return ComponentResult.reply(result);
        }
        return ComponentResult.update(await profile(social, inv, result.text));
      },
    },
    {
      route: R.callClear,
      handle: async (inv) => {
        const result = await setCall(social, inv, "清除");
        if (result.tone === "warn" || result.tone === "error") return ComponentResult.reply(result);
        return ComponentResult.update(await profile(social, inv, result.text));
      },
    },
  ];

  registry.register(
    commandSpec("me profile", "查看她對你的印象與她怎麼稱呼你", {
      permission: "me.profile",
      ephemeral: true,
    }),
    (inv) => profile(social, inv),
  );

  registry.register(
    commandSpec("me call", "設定她怎麼稱呼你", {
      args: [argSpec("name", "想讓她怎麼稱呼你（輸入「清除」取消）", ArgKind.string)],
      permission: "me.call",
      ephemeral: true,
    }),
    (inv) => setCall(social, inv, inv.str("name") ?? ""),
    { components: callRoutes },
  );

  registry.register(
    commandSpec("me link", "把你的其他帳號連到同一個人（不帶代碼 = 取得代碼）", {
      args: [argSpec("code", "另一個帳號取得的連結代碼", ArgKind.string, { required: false })],
      permission: "me.link",
      ephemeral: true,
    }),
    (inv) => link(social, inv),
    {
      components: [
        {
          route: R.linkCode,
          handle: async (inv) => ComponentResult.reply(await issueCode(social, inv)),
        },
      ],
    },
  );

  const user = () => argSpec("user", "要管理的人（@提及、platform:id 或名字）", ArgKind.user);
  const tag = () => argSpec("tag", "標籤，例如 friend、regular、troll", ArgKind.string);
  const specs: Array<[AdminOp, CommandSpec]> = [
    [
      "show",
      commandSpec("admin person show", "查看她對某人的詳細數值", {
        args: [user()],
        permission: "admin.person.show",
      }),
    ],
    [
      "tag",
      commandSpec("admin person tag", "幫某人加上標籤", {
        args: [user(), tag()],
        permission: "admin.person.tag",
      }),
    ],
    [
      "untag",
      commandSpec("admin person untag", "移除某人的標籤", {
        args: [user(), tag()],
        permission: "admin.person.tag",
      }),
    ],
    [
      "block",
      commandSpec("admin person block", "讓她不再回應某人", {
        args: [user()],
        permission: "admin.person.block",
      }),
    ],
    [
      "unblock",
      commandSpec("admin person unblock", "解除封鎖", {
        args: [user()],
        permission: "admin.person.block",
      }),
    ],
    [
      "reset",
      commandSpec("admin person reset", "重置她對某人的印象（標籤保留）", {
        args: [user()],
        permission: "admin.person.reset",
      }),
    ],
    [
      "adjust",
      commandSpec("admin person adjust", "直接調整她對某人的好感（限擁有者）", {
        args: [user(), argSpec("affinity", "好感變化，-100 到 100", ArgKind.integer)],
        permission: NODE_ADJUST,
      }),
    ],
  ];
  for (const [op, spec] of specs) {
    const options =
      op === "reset"
        ? {
            components: [
              defineRoute<string>({
                route: R.resetYes,
                parse: (p) => p[0] ?? null,
                handle: async (inv, person) => {
                  const name = social.displayName(person) ?? person;
                  await social.reset(person, accountRefString(inv.invoker), social.clock.now());
                  return ComponentResult.update(
                    notice("success", `已重置她對 ${name} 的印象（標籤保留）。`),
                  );
                },
              }),
              { route: R.resetNo, handle: () => ComponentResult.update(cancelled()) },
            ],
          }
        : {};
    registry.register({ ...spec, ephemeral: true }, (inv) => admin(social, op, inv), options);
  }
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}

const UNAVAILABLE = "帳號連結目前無法使用。";

function linkReply(outcome: LinkOutcome): CommandReply {
  switch (outcome.type) {
    case "linked":
      return notice("success", "已連結：這兩個帳號現在屬於同一個人。");
    case "already_linked":
      return notice("info", "這兩個帳號已經連結過了。");
    case "same_account":
      return notice("warn", "請用另一個帳號輸入這個代碼。");
    case "invalid_code":
      return notice("warn", "代碼無效或已過期。");
    case "too_many_attempts":
      return notice("warn", "嘗試次數過多，請稍後再試。");
    case "unavailable":
      return notice("error", UNAVAILABLE);
  }
}

async function issueCode(social: Social, inv: Invocation): Promise<CommandReply> {
  const issued = await social.issueLinkCode(
    inv.invoker,
    inv.invoker_display_name,
    social.clock.now(),
  );
  if (issued === null) return notice("error", UNAVAILABLE);
  return cardReply(
    [
      { type: "text", text: `你的連結代碼：\`${issued}\`` },
      { type: "muted", text: `請在 10 分鐘內用另一個帳號執行 /me link code:${issued}` },
      // Game accounts (module `game.chat`) redeem it in game chat.
      { type: "muted", text: `遊戲帳號(例如 Minecraft):在遊戲聊天室輸入 !link ${issued}` },
    ],
    { title: "帳號連結", accent: "info", ephemeral: true },
  );
}

async function link(social: Social, inv: Invocation): Promise<CommandReply> {
  const code = inv.str("code")?.trim() ?? "";
  if (code === "") return issueCode(social, inv);
  const outcome = await social.redeemLinkCode(
    inv.invoker,
    inv.invoker_display_name,
    code,
    social.clock.now(),
  );
  return linkReply(outcome);
}

const NOT_RESPONDING = () => notice("warn", "她目前不會回應你。");
export const CLEAR_WORDS: ReadonlySet<string> = new Set(["清除", "取消", "reset", "clear", "-"]);

async function profile(
  social: Social,
  inv: Invocation,
  note: string | null = null,
): Promise<CommandReply> {
  const now = social.clock.now();
  const person = await social.resolve(inv.invoker, inv.invoker_display_name, now);
  if (person === null) return notice("error", "無法讀取你的資料。");
  const rel = social.relationship(person);
  if (rel !== null && isBlocked(rel)) return NOT_RESPONDING();
  const labelNow = rel === null ? "陌生人" : label(rel);
  const callName = rel?.call_name ?? null;
  const blocks: CardBlock[] = [
    {
      type: "text",
      text: [
        `關係：${labelNow}`,
        callName !== null ? `她怎麼稱呼你：「${callName}」` : "她怎麼稱呼你：尚未設定",
      ].join("\n"),
    },
    // Her own voice: the one place a system card quotes her.
    { type: "text", text: `> ${FEELINGS[labelNow] ?? "你誰啊？我們又不熟。"}` },
  ];
  if (note) blocks.push({ type: "muted", text: note });
  blocks.push({
    type: "buttons",
    buttons: [
      { id: componentId(R.callEdit), label: "設定稱呼", style: "primary" },
      ...(callName !== null
        ? [{ id: componentId(R.callClear), label: "清除稱呼", style: "secondary" as const }]
        : []),
      { id: componentId(R.linkCode), label: "取得連結代碼", style: "secondary" },
      { id: componentId(MEMORY_SHOW), label: "她記得的事", style: "secondary" },
    ],
  });
  return cardReply(blocks, {
    title: `${inv.invoker_display_name} 的資料`,
    accent: "brand",
    session: {},
  });
}

async function setCall(social: Social, inv: Invocation, rawCall: string): Promise<CommandReply> {
  const now = social.clock.now();
  const person = await social.resolve(inv.invoker, inv.invoker_display_name, now);
  if (person === null) return notice("error", "無法讀取你的資料。");
  const rel = social.relationship(person);
  if (rel !== null && isBlocked(rel)) return NOT_RESPONDING();
  const call = rawCall.trim();
  if (CLEAR_WORDS.has(call)) {
    await social.setCallName(person, null, now);
    return notice("success", "已清除稱呼，她會用一般的方式稱呼你。");
  }
  const why = checkCallName(call);
  if (why !== null) return notice("warn", why);
  const labelNow = rel === null ? "陌生人" : label(rel);
  if (labelNow === "很討厭") return notice("warn", "她目前不接受你設定稱呼。");
  await social.setCallName(person, call, now);
  return notice("success", `已設定：她會稱呼你「${call}」。`);
}

/** Her feelings by relationship label (persona voice; shown as a quote in `/me profile`). */
const FEELINGS: Readonly<Record<string, string>> = {
  很討厭: "……你自己心裡有數。",
  討厭: "老實說，我現在不太想理你。",
  摯友: "你、你是我最重要的朋友之一啦……這種話不要讓我說第二次！",
  好朋友: "哼，你算是我的好朋友……不准得意喔。",
  朋友: "勉、勉強算是朋友啦。",
  認識: "嗯……算是認識的人吧。",
};

const RUDE_KINDS: ReadonlySet<EventKind> = new Set([
  "rude",
  "insult",
  "harassment",
  "flirt_too_far",
]);

/** Rejects names she would not use: too long, links / mentions, rude words. */
export function checkCallName(call: string): string | null {
  const len = [...call].length;
  if (len === 0) return "稱呼不能是空的。";
  if (len > MAX_CALL_NAME_CHARS) return `稱呼最多 ${MAX_CALL_NAME_CHARS} 個字。`;
  if (/[\n@<>`]/.test(call) || call.includes("://")) {
    return "稱呼不能包含連結、提及或特殊符號。";
  }
  if (classify(call).some((k) => RUDE_KINDS.has(k))) return "這個稱呼不適合，請換一個。";
  return null;
}

async function admin(social: Social, op: AdminOp, inv: Invocation): Promise<CommandReply> {
  const now = social.clock.now();
  const user = inv.str("user") ?? "";
  const person = await findPerson(social, inv, user);
  if (person === null) return notice("warn", `找不到「${user.trim()}」這個人。`);
  const name = social.displayName(person) ?? user.trim();
  const by = accountRefString(inv.invoker);
  switch (op) {
    case "show":
      return show(social, person, name, now);
    case "tag":
    case "untag": {
      const on = op === "tag";
      const tag = normalizeTag(inv.str("tag") ?? "");
      if (tag === null) return notice("warn", "標籤只能使用小寫英數字、- 和 _，且不能太長。");
      if (tag === OWNER_TAG && !(await inv.allowed(NODE_OWNER_TAG))) {
        return notice("error", "只有擁有者可以變更 `owner` 標籤。", `需要權限：${NODE_OWNER_TAG}`);
      }
      const changed = await social.setTag(person, tag, on, by, now);
      if (changed) {
        return notice(
          "success",
          on ? `已為 ${name} 加上標籤 \`${tag}\`。` : `已移除 ${name} 的標籤 \`${tag}\`。`,
        );
      }
      return notice(
        "info",
        on ? `${name} 已經有標籤 \`${tag}\`。` : `${name} 沒有標籤 \`${tag}\`。`,
      );
    }
    case "block":
    case "unblock": {
      const on = op === "block";
      const changed = await social.setTag(person, BLOCKED_TAG, on, by, now);
      if (changed) {
        return notice(
          "success",
          on ? `已封鎖 ${name}，她不會再回應這個人。` : `已解除 ${name} 的封鎖。`,
        );
      }
      return notice("info", on ? `${name} 已經被封鎖。` : `${name} 沒有被封鎖。`);
    }
    case "reset":
      return confirm({
        title: "重置印象",
        text: `確定要重置她對 ${name} 的印象嗎？好感、信任、熟悉度與印象筆記都會歸零，標籤會保留。`,
        confirmId: componentId(R.resetYes, person),
        cancelId: componentId(R.resetNo),
        confirmLabel: "重置",
      });
    case "adjust": {
      const delta = inv.int("affinity") ?? 0;
      if (delta < -100 || delta > 100 || delta === 0) {
        return notice("warn", "好感變化必須介於 -100 到 100 之間，且不能是 0。");
      }
      const r = await social.adjust(person, delta, by, now);
      const signed = delta > 0 ? `+${delta}` : `${delta}`;
      return notice(
        "success",
        `已調整 ${name} 的好感 ${signed}，目前為 ${fixed1(r.affinity)}（${label(r)}）。`,
      );
    }
  }
}

/** Rust `{:.1}`. */
function fixed1(v: number): string {
  return v.toFixed(1);
}

/** `%Y-%m-%d %H:%M UTC`. */
function utcMinutes(ts: string): string {
  const iso = toTimestamp(Date.parse(ts));
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function show(social: Social, person: PersonId, name: string, now: number): CommandReply {
  const r = social.relationship(person);
  if (r === null) return notice("info", `她和 ${name} 還沒有任何互動。`);
  const lines = [
    `好感 ${fixed1(r.affinity)}／信任 ${fixed1(r.trust)}／熟悉 ${fixed1(r.familiarity)} → ${label(r)}`,
    `標籤：${r.tags.length === 0 ? "無" : r.tags.join("、")}`,
    `稱呼：${r.call_name ?? "未設定"}`,
    `互動 ${r.interactions} 次，最後一次：${r.last_interaction === null ? "從未" : utcMinutes(r.last_interaction)}`,
  ];
  const day = social.today(person, now);
  if (day !== null) {
    lines.push(
      `今天：好感 +${fixed1(day.affinity_gained)}／-${fixed1(day.affinity_lost)}，` +
        `信任 +${fixed1(day.trust_gained)}／-${fixed1(day.trust_lost)}`,
    );
  }
  const notes = r.notes.trim() === "" ? "（尚無）" : r.notes.trim();
  lines.push(`印象：${notes}`);
  return cardReply(
    [
      { type: "text", text: lines.join("\n") },
      { type: "muted", text: `person ${person}` },
    ],
    { title: name, accent: "neutral" },
  );
}

function normalizeTag(tag: string): string | null {
  const t = tag.trim().toLowerCase();
  const len = [...t].length;
  return len >= 1 && len <= MAX_TAG_CHARS && /^[a-z0-9_-]+$/.test(t) ? t : null;
}

/**
 * Resolves the `user` argument (mentions are already reduced to ids by the registry):
 * `platform:id`, a bare numeric id on the invoker's platform, or a unique display name she
 * knows.
 */
async function findPerson(social: Social, inv: Invocation, user: string): Promise<PersonId | null> {
  const s = user.trim();
  if (s === "") return null;
  let account: AccountRef | null = null;
  if (/^[0-9]+$/.test(s)) {
    account = { platform: inv.context.platform, id: s };
  } else if (s.includes(":")) {
    try {
      account = parseAccount(s);
    } catch {
      account = null;
    }
  }
  if (account !== null) return social.resolve(account, null, social.clock.now());
  const named = social.peopleNamed(s);
  return named.length === 1 ? (named[0] as PersonId) : null;
}
