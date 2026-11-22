// `/me profile | call | link` and `/admin person ...`, on the heart's rows (phase 4 step 5; they
// were the `social` module's). System text is neutral; the one line in her own voice is the
// flavour line of `/me profile`: one per tier of the whole scale (`RELATIONSHIP_LABELS`), so a
// close tier never falls back to the line for a stranger.

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
  pictureParts,
  type ReplyFile,
} from "@miyoria/commands";
import {
  type AccountRef,
  type AdminProfilePicture,
  accountRefString,
  DEFAULT_CURRENCY,
  type PersonId,
  type Pictures,
  type RelationshipLabel,
  relationshipLabel,
  tierStanding,
  toTimestamp,
} from "@miyoria/types";
import type { LinkOutcome, PeopleDirectory } from "./directory.js";
import { BLOCKED_TAG, type HeartPerson, hasTag, OWNER_TAG } from "./model.js";
import { bondPlace } from "./place.js";
import { publicBond } from "./public.js";
import type { BondRingImageSpec, BondRingImages } from "./ring-image.js";
import { dayStart, localDay } from "./rules.js";

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

/** Whether a call name passes moderation; `null` when it does (or nothing can screen it). */
export type ScreenCallName = (call: string) => Promise<string | null>;

/** Where the ring's pictures come from, asked each time (the renderer may start after this). */
export type RingImages = () => BondRingImages | undefined;

/**
 * Where the picture messages come from (docs/design/v5-play.md §11.5): the personal card in place
 * of the bare ring, the week's review. Asked each time; without it the ring and the text stay.
 */
export type PictureSource = () => Pictures | undefined;

/** How far under the ring a member's picture draws a bond below 0 (they are only told it is). */
const PUBLIC_BELOW = 0.25;

/** The name of the ring's picture on a reply. */
const RING_FILE = "bond-ring.png";

/** The ring as a file block and the file to send with it; `null` without a renderer. */
async function ringFile(
  images: RingImages,
  spec: BondRingImageSpec,
): Promise<{ block: CardBlock; file: ReplyFile } | null> {
  const renderer = images();
  if (renderer === undefined) return null;
  try {
    const data = await renderer.png(spec);
    return {
      block: { type: "file", name: RING_FILE },
      file: { name: RING_FILE, data, contentType: "image/png" },
    };
  } catch {
    // A card without the picture is still the card.
    return null;
  }
}

/** Registers the people commands. Undo with `unregisterCommands`. */
export function registerCommands(
  registry: CommandRegistry,
  people: PeopleDirectory,
  screen: ScreenCallName = async () => null,
  images: RingImages = () => undefined,
  pictures: PictureSource = () => undefined,
  /** The profile's coin name and pronoun (the first character's by default). */
  words: { coin: string; her: string } = { coin: DEFAULT_CURRENCY, her: "她" },
): void {
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
        const result = await setCall(people, screen, inv, inv.field("call"));
        if (result.tone === "warn" || result.tone === "error" || inv.messageId === null) {
          return ComponentResult.reply(result);
        }
        return ComponentResult.update(await profile(people, images, inv, result.text, pictures));
      },
    },
    {
      route: R.callClear,
      handle: async (inv) => {
        const result = await setCall(people, screen, inv, "清除");
        if (result.tone === "warn" || result.tone === "error") return ComponentResult.reply(result);
        return ComponentResult.update(await profile(people, images, inv, result.text, pictures));
      },
    },
  ];

  registry.register(
    commandSpec("me profile", `查看${words.her}對你的印象與${words.her}怎麼稱呼你`, {
      args: [
        argSpec("week", `看你這一週的回顧（聊天、點歌、抽卡、${words.coin}）`, ArgKind.boolean, {
          required: false,
        }),
        argSpec("picture", "附上圖（預設附上；false 只要文字）", ArgKind.boolean, {
          required: false,
        }),
      ],
      permission: "me.profile",
      ephemeral: true,
    }),
    (inv) => {
      const drawn = inv.bool("picture") !== false;
      if (inv.bool("week") === true) return week(people, pictures, inv, drawn);
      return drawn
        ? profile(people, images, inv, null, pictures)
        : profile(people, () => undefined, inv, null);
    },
  );

  registry.register(
    commandSpec("me call", "設定她怎麼稱呼你", {
      args: [argSpec("name", "想讓她怎麼稱呼你（輸入「清除」取消）", ArgKind.string)],
      permission: "me.call",
      ephemeral: true,
    }),
    (inv) => setCall(people, screen, inv, inv.str("name") ?? ""),
    { components: callRoutes },
  );

  registry.register(
    commandSpec("me link", "把你的其他帳號連到同一個人（不帶代碼 = 取得代碼）", {
      args: [argSpec("code", "另一個帳號取得的連結代碼", ArgKind.string, { required: false })],
      permission: "me.link",
      ephemeral: true,
    }),
    (inv) => link(people, inv),
    {
      components: [
        {
          route: R.linkCode,
          handle: async (inv) => ComponentResult.reply(await issueCode(people, inv)),
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
      commandSpec("admin person adjust", "直接調整她對某人的羈絆（限擁有者）", {
        args: [user(), argSpec("affinity", "羈絆變化，-1000 到 1000", ArgKind.integer)],
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
                  const name = people.displayName(person) ?? person;
                  people.heart.reset(person, {
                    now: people.clock.now(),
                    quote: `reset by ${accountRefString(inv.invoker)}`,
                  });
                  return ComponentResult.update(
                    notice("success", `已重置她對 ${name} 的印象（標籤保留）。`),
                  );
                },
              }),
              { route: R.resetNo, handle: () => ComponentResult.update(cancelled()) },
            ],
          }
        : {};
    registry.register(
      { ...spec, ephemeral: true },
      (inv) => admin(people, images, op, inv, pictures),
      options,
    );
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

async function issueCode(people: PeopleDirectory, inv: Invocation): Promise<CommandReply> {
  const issued = await people.issueLinkCode(
    inv.invoker,
    inv.invoker_display_name,
    people.clock.now(),
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

async function link(people: PeopleDirectory, inv: Invocation): Promise<CommandReply> {
  const code = inv.str("code")?.trim() ?? "";
  if (code === "") return issueCode(people, inv);
  const outcome = await people.redeemLinkCode(
    inv.invoker,
    inv.invoker_display_name,
    code,
    people.clock.now(),
  );
  return linkReply(outcome);
}

const NOT_RESPONDING = () => notice("warn", "她目前不會回應你。");
export const CLEAR_WORDS: ReadonlySet<string> = new Set(["清除", "取消", "reset", "clear", "-"]);

/** The tier name of someone: the one ladder, 陌生人 before there is a row or anything done. */
export function labelOf(row: HeartPerson | null): RelationshipLabel {
  return row === null ? "陌生人" : relationshipLabel({ affinity: row.bond, met: metOf(row) });
}

/** Whether she has met `row`'s person: anything done with her, or a bond off 0. */
export function metOf(row: Pick<HeartPerson, "interactions" | "bond">): boolean {
  return row.interactions > 0 || row.bond !== 0;
}

/**
 * Her line for each tier, in her voice (shown as a quote in `/me profile`). Every tier of
 * `RELATIONSHIP_LABELS` has one: the record's type asks for all of them.
 */
export const FEELINGS: Readonly<Record<RelationshipLabel, string>> = {
  很討厭: "……你自己心裡有數。",
  討厭: "老實說，我現在不太想理你。",
  陌生人: "你誰啊？我們又不熟。",
  認識: "嗯……算是認識的人吧。",
  朋友: "勉、勉強算是朋友啦。",
  好朋友: "哼，你算是我的好朋友……不准得意喔。",
  摯友: "你、你是我最重要的朋友之一啦……這種話不要讓我說第二次！",
  知心: "跟你說話好像不用想太多……才、才不是在誇你！",
  知己: "你懂我在想什麼……有時候懂太多了，討厭。",
  至交: "這麼久了你還在，算你有毅力啦。……我也是。",
  莫逆之交: "我們之間不用客氣——但你還是要對我好一點喔。",
  心有靈犀: "我還沒說你就知道了……不准偷看我在想什麼！",
  形影不離: "你不在的時候總覺得少了點什麼……才、才沒有很想你！",
  宛若家人: "你已經跟家人差不多了啦……所以不准隨便消失。",
  生死之交: "不管發生什麼，我都站你這邊。……聽到就好，不准回答。",
  命運相連: "大概是註定要被你纏上吧。……嗯，不討厭就是了。",
  無可取代: "沒有人能取代你。這句話只說一次，給我記好。",
  心之所歸: "繞了一大圈，最後還是想回到你這裡。……笑什麼啦！",
  永恆羈絆: "就算過了很久很久，我也會在這裡。說好了，不准忘記。",
};

async function profile(
  people: PeopleDirectory,
  images: RingImages,
  inv: Invocation,
  note: string | null = null,
  pictures: PictureSource = () => undefined,
): Promise<CommandReply> {
  const now = people.clock.now();
  const person = await people.resolve(inv.invoker, inv.invoker_display_name, now);
  if (person === null) return notice("error", "無法讀取你的資料。");
  const row = people.heart.get(person);
  if (row !== null && hasTag(row, BLOCKED_TAG)) return NOT_RESPONDING();
  const tier = labelOf(row);
  // What they read is the tier with its stage (H10); her line goes by the tier.
  const shown = row === null ? tier : tierStanding({ affinity: row.bond, met: metOf(row) }).label;
  const callName = row?.call_name ?? null;
  const blocks: CardBlock[] = [];
  // Their card as a picture (the ring and the words of their member page); else the ring alone
  // (no number), when she has a row for them and a renderer is running.
  const files: ReplyFile[] = [];
  const card =
    row === null ? null : ((await memberPicture(pictures, inv, "profile"))?.file ?? null);
  if (card !== null) {
    const parts = pictureParts(card);
    blocks.push(...parts.blocks);
    files.push(...parts.files);
  } else if (row !== null) {
    const ring = publicBond(row).ring;
    const drawn = await ringFile(images, {
      lap: ring.lap,
      fraction: ring.fraction,
      full: ring.full,
      below: ring.below ? PUBLIC_BELOW : 0,
    });
    if (drawn !== null) {
      blocks.push(drawn.block);
      files.push(drawn.file);
    }
  }
  blocks.push(
    {
      type: "text",
      text: [
        `關係：${shown}`,
        callName !== null ? `她怎麼稱呼你：「${callName}」` : "她怎麼稱呼你：尚未設定",
      ].join("\n"),
    },
    // Her own voice: the one place a system card quotes her.
    { type: "text", text: `> ${FEELINGS[tier]}` },
  );
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
    files,
  });
}

/** A member picture of the invoker; `null` without the service or anything to draw. */
async function memberPicture(
  pictures: PictureSource,
  inv: Invocation,
  kind: "profile" | "week",
  draw = true,
): Promise<Awaited<ReturnType<Pictures["forMember"]>>> {
  const who = { account: inv.invoker, name: inv.invoker_display_name };
  try {
    return (await pictures()?.forMember(who, kind, { draw })) ?? null;
  } catch {
    // A card without the picture is still the card.
    return null;
  }
}

/**
 * `/me profile week:true`: their week as a picture (docs/design/v5-play.md §11.5), from what their
 * member page shows them; its one-line summary is the text, and all of it when it cannot be drawn
 * or `picture:false` asked for words only.
 */
async function week(
  people: PeopleDirectory,
  pictures: PictureSource,
  inv: Invocation,
  draw = true,
): Promise<CommandReply> {
  const now = people.clock.now();
  const person = await people.resolve(inv.invoker, inv.invoker_display_name, now);
  if (person === null) return notice("error", "無法讀取你的資料。");
  const row = people.heart.get(person);
  if (row !== null && hasTag(row, BLOCKED_TAG)) return NOT_RESPONDING();
  const result = await memberPicture(pictures, inv, "week", draw);
  if (result === null) return notice("info", "這一週的回顧現在看不到。");
  const title = `${inv.invoker_display_name} 的這一週`;
  const parts = pictureParts(result.file);
  if (parts.blocks.length === 0) {
    return cardReply([{ type: "text", text: result.alt }], { title, accent: "brand" });
  }
  // The picture says it all on Discord; a text platform reads its summary.
  const reply = cardReply(parts.blocks, { title, accent: "brand", files: parts.files });
  return { ...reply, text: `${title}\n${result.alt}` };
}

async function setCall(
  people: PeopleDirectory,
  screen: ScreenCallName,
  inv: Invocation,
  rawCall: string,
): Promise<CommandReply> {
  const now = people.clock.now();
  const person = await people.resolve(inv.invoker, inv.invoker_display_name, now);
  if (person === null) return notice("error", "無法讀取你的資料。");
  const row = people.heart.get(person);
  if (row !== null && hasTag(row, BLOCKED_TAG)) return NOT_RESPONDING();
  const call = rawCall.trim();
  if (CLEAR_WORDS.has(call)) {
    people.heart.edit(person, { call_name: null }, { now });
    return notice("success", "已清除稱呼，她會用一般的方式稱呼你。");
  }
  const why = checkCallName(call) ?? (await screen(call));
  if (why !== null) return notice("warn", why);
  if (labelOf(row) === "很討厭") return notice("warn", "她目前不接受你設定稱呼。");
  people.heart.edit(person, { call_name: call }, { now });
  return notice("success", `已設定：她會稱呼你「${call}」。`);
}

/** Rejects names she would not use by their shape: too long, links, mentions, markup. */
export function checkCallName(call: string): string | null {
  const len = [...call].length;
  if (len === 0) return "稱呼不能是空的。";
  if (len > MAX_CALL_NAME_CHARS) return `稱呼最多 ${MAX_CALL_NAME_CHARS} 個字。`;
  if (/[\n@<>`]/.test(call) || call.includes("://")) {
    return "稱呼不能包含連結、提及或特殊符號。";
  }
  return null;
}

/** What moderation says of a call name she would use: `null` passes. */
export const UNFIT_CALL_NAME = "這個稱呼不適合，請換一個。";

async function admin(
  people: PeopleDirectory,
  images: RingImages,
  op: AdminOp,
  inv: Invocation,
  pictures: PictureSource = () => undefined,
): Promise<CommandReply> {
  const now = people.clock.now();
  const user = inv.str("user") ?? "";
  const person = await findPerson(people, inv, user);
  if (person === null) return notice("warn", `找不到「${user.trim()}」這個人。`);
  const name = people.displayName(person) ?? user.trim();
  const by = accountRefString(inv.invoker);
  const heart = people.heart;
  switch (op) {
    case "show":
      return show(people, images, person, name, now, pictures);
    case "tag":
    case "untag": {
      const on = op === "tag";
      const tag = normalizeTag(inv.str("tag") ?? "");
      if (tag === null) return notice("warn", "標籤只能使用小寫英數字、- 和 _，且不能太長。");
      if (tag === OWNER_TAG && !(await inv.allowed(NODE_OWNER_TAG))) {
        return notice("error", "只有擁有者可以變更 `owner` 標籤。", `需要權限：${NODE_OWNER_TAG}`);
      }
      if (heart.setTag(person, tag, on, { now })) {
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
      if (heart.setTag(person, BLOCKED_TAG, on, { now })) {
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
        text: `確定要重置她對 ${name} 的印象嗎？羈絆、信任、熟悉度與她寫的文字都會回到剛認識的樣子，標籤會保留。`,
        confirmId: componentId(R.resetYes, person),
        cancelId: componentId(R.resetNo),
        confirmLabel: "重置",
      });
    case "adjust": {
      const delta = inv.int("affinity") ?? 0;
      if (delta < -1000 || delta > 1000 || delta === 0) {
        return notice("warn", "羈絆變化必須介於 -1000 到 1000 之間，且不能是 0。");
      }
      const bond = heart.get(person)?.bond ?? 0;
      const r = heart.adminSet(person, "bond", bond + delta, { now, quote: `adjust by ${by}` });
      const signed = delta > 0 ? `+${delta}` : `${delta}`;
      return notice(
        "success",
        `已調整 ${name} 的羈絆 ${signed}，目前為 ${fixed1(r.person.bond)}（${labelOf(r.person)}）。`,
      );
    }
  }
}

/** One decimal. */
function fixed1(v: number): string {
  return v.toFixed(1);
}

/** `%Y-%m-%d %H:%M UTC`. */
function utcMinutes(ts: string): string {
  const iso = toTimestamp(Date.parse(ts));
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

async function show(
  people: PeopleDirectory,
  images: RingImages,
  person: PersonId,
  name: string,
  now: number,
  pictures: PictureSource = () => undefined,
): Promise<CommandReply> {
  const r = people.heart.get(person);
  if (r === null) return notice("info", `她和 ${name} 還沒有任何互動。`);
  const lines = [
    `羈絆 ${fixed1(r.bond)}／信任 ${fixed1(r.trust)}／熟悉 ${fixed1(r.familiarity)} → ${labelOf(r)}`,
    `標籤：${r.tags.length === 0 ? "無" : r.tags.join("、")}`,
    `稱呼：${r.call_name ?? "未設定"}`,
    `互動 ${r.interactions} 次，最後一次：${r.last_interaction === null ? "從未" : utcMinutes(r.last_interaction)}`,
  ];
  const rules = people.heart.rules;
  const day = localDay(now, rules);
  const today = people.heart.log.changesBetween(
    person,
    toTimestamp(dayStart(day, rules)),
    toTimestamp(dayStart(day + 1, rules)),
  );
  if (today.length > 0) {
    const sum = (field: string, up: boolean) =>
      today
        .filter((e) => e.change.field === field && (up ? e.change.delta > 0 : e.change.delta < 0))
        .reduce((n, e) => n + Math.abs(e.change.delta), 0);
    lines.push(
      `今天：羈絆 +${fixed1(sum("bond", true))}／-${fixed1(sum("bond", false))}，` +
        `信任 +${fixed1(sum("trust", true))}／-${fixed1(sum("trust", false))}`,
    );
  }
  const impression = r.impression.trim() === "" ? "（尚無）" : r.impression.trim();
  lines.push(`印象：${impression}`);
  // The owner's card has the eight numbers and the bond on the ring's heart; else the ring alone.
  const place = bondPlace(r.bond);
  let picture: Awaited<ReturnType<Pictures["render"]>> = null;
  try {
    picture = (await pictures()?.render("profile", adminCard(r, name, place))) ?? null;
  } catch {
    picture = null;
  }
  const drawn = picture === null ? await ringFile(images, { ...place.ring, value: r.bond }) : null;
  const parts = pictureParts(picture);
  const blocks: CardBlock[] = [
    ...parts.blocks,
    ...(drawn === null ? [] : [drawn.block]),
    { type: "text", text: lines.join("\n") },
    { type: "muted", text: `person ${person}` },
  ];
  const files = drawn === null ? parts.files : [drawn.file];
  return cardReply(blocks, {
    title: name,
    accent: "neutral",
    ...(files.length === 0 ? {} : { files }),
  });
}

/** The owner's card of someone: the numbers of their row. */
function adminCard(
  r: HeartPerson,
  name: string,
  place: ReturnType<typeof bondPlace>,
): AdminProfilePicture {
  return {
    variant: "admin",
    name,
    bond: r.bond,
    ring: place.ring,
    tier_label: place.tier_label,
    next_label: place.next_label,
    tier_progress: place.tier_progress,
    values: {
      trust: r.trust,
      familiarity: r.familiarity,
      warmth: r.warmth,
      respect: r.respect,
      ease: r.ease,
      grudge: r.grudge,
      longing: r.longing,
      rapport: r.rapport,
    },
    call_name: r.call_name,
    tags: [...r.tags],
    interactions: r.interactions,
  };
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
async function findPerson(
  people: PeopleDirectory,
  inv: Invocation,
  user: string,
): Promise<PersonId | null> {
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
  if (account !== null) return people.resolve(account, null, people.clock.now());
  const named = people.peopleNamed(s);
  return named.length === 1 ? (named[0] as PersonId) : null;
}
