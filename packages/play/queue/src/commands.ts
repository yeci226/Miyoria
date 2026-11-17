// `/queue add | list | upvote`, `/queue manage ...` and `/queue vote start | end`.
//
// The list is a public card with Next / Done / Skip / Pause buttons (they need the manage
// node); a vote is a public card with one button per option (they need the vote node).
// Removing an item and clearing the queue ask with a red confirm card first.

import {
  type AnyComponentRoute,
  ArgKind,
  argSpec,
  type CardBlock,
  type CommandHandler,
  type CommandRegistry,
  type CommandReply,
  type CommandSpec,
  ComponentResult,
  cancelled,
  cardReply,
  commandName,
  commandSpec,
  componentId,
  confirm,
  defineRoute,
  type Invocation,
  intParam,
  MAX_SESSION_TTL_MS,
  notice,
  type RegisterOptions,
} from "@miyoria/commands";
import type { RequestQueue } from "./queue.js";
import {
  type ItemId,
  QueueError,
  type QueueItem,
  tallies,
  type VoteResult,
  winnerOption,
} from "./types.js";

const LIST_LIMIT = 10;
/** Vote buttons per card (4 rows of 5, room left for the rest of the card). */
const MAX_VOTE_BUTTONS = 20;

type Handler = (queue: RequestQueue, inv: Invocation) => CommandReply | Promise<CommandReply>;

const R = {
  next: "queue:list:next",
  done: "queue:list:done",
  skip: "queue:list:skip",
  pause: "queue:list:pause",
  resume: "queue:list:resume",
  refresh: "queue:list:refresh",
  remove: "queue:remove:yes",
  clear: "queue:clear:yes",
  cancel: "queue:cancel",
  cast: "queue:vote:cast",
} as const;

/**
 * Registers the queue commands. Returns the registered paths (for unregistering).
 */
export function registerCommands(registry: CommandRegistry, queue: RequestQueue): string[] {
  const perms = queue.config.permissions;
  const paths: string[] = [];
  const add = (spec: CommandSpec, handler: Handler, options: RegisterOptions = {}): void => {
    paths.push(commandName(spec));
    const wrapped: CommandHandler = (inv) => handler(queue, inv);
    registry.register(spec, wrapped, options);
  };

  add(
    commandSpec("queue add", "排一個請求給她", {
      args: [
        argSpec("text", "想請她做的事", ArgKind.string),
        argSpec("kind", "種類，例如 song、game_goal", ArgKind.string, { required: false }),
      ],
      permission: perms.request,
    }),
    (q, inv) =>
      attempt(() => {
        const s = q.submit({
          requester: inv.invoker,
          requesterName: inv.invoker_display_name,
          kind: inv.str("kind") ?? "",
          text: inv.str("text") ?? "",
          context: inv.context,
        });
        return notice("success", `已加入佇列：#${s.item.id}，目前排第 ${s.position} 位。`);
      }),
  );

  const after = (q: RequestQueue, note: CommandReply): ComponentResult => {
    if (note.tone === "warn" || note.tone === "error") return ComponentResult.reply(note);
    return ComponentResult.update(listCard(q, note.text));
  };
  const listRoutes: AnyComponentRoute[] = [
    { route: R.refresh, handle: () => ComponentResult.update(listCard(queue)) },
    {
      route: R.next,
      permission: perms.manage,
      handle: () => after(queue, callNext(queue)),
    },
    {
      route: R.done,
      permission: perms.manage,
      handle: () => after(queue, finish(queue, null, "done")),
    },
    {
      route: R.skip,
      permission: perms.manage,
      handle: () => after(queue, finish(queue, null, "skip")),
    },
    {
      route: R.pause,
      permission: perms.manage,
      handle: () => {
        queue.pause();
        return after(queue, notice("success", "已暫停叫號。"));
      },
    },
    {
      route: R.resume,
      permission: perms.manage,
      handle: () => {
        queue.resume();
        return after(queue, notice("success", "已恢復叫號。"));
      },
    },
  ];
  add(
    commandSpec("queue list", "查看目前的佇列", { permission: "queue.list" }),
    (q) => listCard(q),
    { components: listRoutes },
  );

  add(
    commandSpec("queue upvote", "幫排隊中的項目加一票", {
      args: [argSpec("id", "項目編號", ArgKind.integer)],
      permission: perms.vote,
    }),
    (q, inv) =>
      attempt(() =>
        notice(
          "success",
          `已投票，#${itemId(inv)} 現在有 ${q.vote(itemId(inv), inv.invoker)} 票。`,
        ),
      ),
    // The buttons of a vote card belong here: everyone with the vote node may press them.
    {
      components: [
        defineRoute<number>({
          route: R.cast,
          parse: (p) => intParam(p[0]),
          handle: (inv, index) => {
            const vote = queue.voteStatus();
            const option = vote?.options[index];
            if (!vote || option === undefined) {
              return ComponentResult.reply(notice("warn", "這場投票已經結束。"));
            }
            try {
              queue.castVote(inv.invoker, String(index + 1));
            } catch (error) {
              return ComponentResult.reply(failure(error));
            }
            return ComponentResult.update(voteCard(queue, null));
          },
        }),
      ],
    },
  );

  // ---- manage ----

  const manage = (path: string, description: string, args = [] as CommandSpec["args"]) =>
    commandSpec(`queue manage ${path}`, description, {
      args,
      permission: perms.manage,
    });
  const optionalId = () =>
    argSpec("id", "項目編號（預設為進行中的項目）", ArgKind.integer, { required: false });

  add(manage("next", "叫下一個請求"), (q) => callNext(q));
  add(manage("done", "把項目標記為完成", [optionalId()]), (q, inv) =>
    finish(q, targetArg(inv), "done"),
  );
  add(manage("skip", "跳過項目", [optionalId()]), (q, inv) => finish(q, targetArg(inv), "skip"));
  add(
    manage("remove", "從佇列移除項目", [argSpec("id", "項目編號", ArgKind.integer)]),
    (q, inv) =>
      attempt(() => {
        const id = itemId(inv);
        const item = q.get(id);
        if (!item) throw QueueError.notFound(id);
        if (item.state !== "pending" && item.state !== "active") throw QueueError.wrongState(id);
        return confirm({
          title: "移除項目",
          text: `確定要移除 ${describe(item)} 嗎？`,
          confirmId: componentId(R.remove, id),
          cancelId: componentId(R.cancel),
          confirmLabel: "移除",
        });
      }),
    {
      components: [
        defineRoute<number>({
          route: R.remove,
          parse: (p) => intParam(p[0]),
          handle: (_inv, id) =>
            ComponentResult.update(
              attempt(() => notice("success", `已移除 #${queue.remove(id).id}。`)),
            ),
        }),
        { route: R.cancel, handle: () => ComponentResult.update(cancelled()) },
      ],
    },
  );
  add(
    manage("clear", "清空所有排隊中的項目"),
    (q) => {
      const waiting = q.list().filter((i) => i.state !== "active").length;
      if (waiting === 0) return notice("info", "沒有排隊中的項目。");
      return confirm({
        title: "清空佇列",
        text: `確定要清空 ${waiting} 個排隊中的項目嗎？進行中的項目不受影響。`,
        confirmId: componentId(R.clear),
        cancelId: componentId(R.cancel),
        confirmLabel: "清空",
      });
    },
    {
      components: [
        {
          route: R.clear,
          handle: () =>
            ComponentResult.update(notice("success", `已清空 ${queue.clear()} 個項目。`)),
        },
      ],
    },
  );
  add(manage("pause", "暫停叫號（仍可排隊）"), (q) => {
    q.pause();
    return notice("success", "已暫停叫號，仍可加入佇列，但不會叫下一個。");
  });
  add(manage("resume", "恢復叫號"), (q) => {
    q.resume();
    return notice("success", "已恢復叫號。");
  });
  add(
    manage("priority", "設定項目的優先度（數字越大越前面）", [
      argSpec("id", "項目編號", ArgKind.integer),
      argSpec("priority", "優先度（整數）", ArgKind.integer),
    ]),
    (q, inv) => {
      const raw = inv.int("priority");
      const priority = raw !== null && Number.isInteger(raw) && fitsI32(raw) ? raw : null;
      let id: ItemId;
      try {
        id = itemId(inv);
      } catch {
        return notice("warn", "編號或優先度不正確。");
      }
      if (priority === null) return notice("warn", "編號或優先度不正確。");
      return attempt(() => {
        q.setPriority(id, priority);
        return notice("success", `已將 #${id} 的優先度設為 ${priority}。`);
      });
    },
  );

  // ---- vote ----

  add(
    commandSpec("queue vote start", "開始投票，大家用按鈕投票", {
      args: [
        argSpec("options", "選項，用逗號分隔", ArgKind.string),
        argSpec("seconds", "投票秒數", ArgKind.integer),
      ],
      permission: perms.manage,
    }),
    (q, inv) => {
      const options = (inv.str("options") ?? "").split(/[,，、]/u).map((s) => s.trim());
      const seconds = inv.int("seconds");
      if (seconds === null || !Number.isInteger(seconds) || seconds <= 0) {
        return notice("warn", "秒數必須是正整數。");
      }
      if (options.filter((o) => o !== "").length > MAX_VOTE_BUTTONS) {
        return notice("warn", `選項最多 ${MAX_VOTE_BUTTONS} 個。`);
      }
      return attempt(() => {
        q.startVote(options, seconds * 1000);
        return voteCard(q, seconds);
      });
    },
  );

  add(commandSpec("queue vote end", "提前結束投票並公布結果", { permission: perms.manage }), (q) =>
    attempt(() => resultCard(q.endVote())),
  );

  return paths;
}

function fitsI32(n: number): boolean {
  return n >= -(2 ** 31) && n <= 2 ** 31 - 1;
}

/** A `QueueError` becomes a warning; anything else is a real failure. */
function failure(error: unknown): CommandReply {
  if (error instanceof QueueError) return notice("warn", errorText(error));
  throw error;
}

function attempt(body: () => CommandReply): CommandReply {
  try {
    return body();
  } catch (error) {
    return failure(error);
  }
}

/** Required `id` argument. Negative numbers are treated as unknown items. */
function itemId(inv: Invocation): ItemId {
  const raw = inv.int("id") ?? 0;
  if (!Number.isInteger(raw) || raw < 0) throw QueueError.notFound(0);
  return raw;
}

/** The optional `id` argument, or `null` for "the active item". */
function targetArg(inv: Invocation): number | null {
  return Object.hasOwn(inv.args, "id") ? (inv.int("id") ?? -1) : null;
}

function callNext(q: RequestQueue): CommandReply {
  const item = q.next();
  if (item) return notice("success", `輪到 ${describe(item)}`);
  return q.isPaused() ? notice("warn", "叫號已暫停。") : notice("info", "目前沒有人在排隊。");
}

/** Done / skip of `id`, or of the active item when `id` is `null`. */
function finish(q: RequestQueue, id: number | null, op: "done" | "skip"): CommandReply {
  const target = id ?? q.current()?.id ?? null;
  if (target === null) return notice("warn", "請指定編號，或先叫號讓一個項目進行中。");
  return attempt(() => {
    if (target < 0 || !Number.isInteger(target)) throw QueueError.notFound(0);
    return op === "done"
      ? notice("success", `#${q.complete(target).id} 已完成。`)
      : notice("success", `已跳過 #${q.skip(target).id}。`);
  });
}

function describe(item: QueueItem): string {
  const chars = [...item.text];
  const text = chars.slice(0, 30).join("");
  const ellipsis = chars.length > 30 ? "…" : "";
  return `#${item.id} [${item.kind}] ${item.requester_name}：${text}${ellipsis}`;
}

/** Plain-text list (also the card's text). */
export function formatList(q: RequestQueue): string {
  const items = q.list();
  if (items.length === 0) return "佇列是空的。";
  const lines: string[] = [];
  for (const item of items.slice(0, LIST_LIMIT)) {
    const place = item.state === "active" ? "**進行中**" : "排隊中";
    let line = `${place}　${describe(item)}`;
    if (item.votes > 0) line += `（${item.votes} 票）`;
    lines.push(line);
  }
  if (items.length > LIST_LIMIT) lines.push(`還有 ${items.length - LIST_LIMIT} 個項目未列出。`);
  return lines.join("\n");
}

function listCard(q: RequestQueue, note: string | null = null): CommandReply {
  const blocks: CardBlock[] = [{ type: "text", text: formatList(q) }];
  const vote = q.voteStatus();
  if (vote) {
    const counts = tallies(vote);
    const line = vote.options.map((o, i) => `${o} ${counts[i] ?? 0} 票`).join("／");
    blocks.push({ type: "text", text: `投票進行中：${line}` });
  }
  if (note) blocks.push({ type: "muted", text: note });
  const hasActive = q.current() !== null;
  blocks.push({
    type: "buttons",
    buttons: [
      { id: componentId(R.next), label: "下一個", style: "primary" },
      { id: componentId(R.done), label: "完成", style: "success", disabled: !hasActive },
      { id: componentId(R.skip), label: "跳過", style: "secondary", disabled: !hasActive },
      q.isPaused()
        ? { id: componentId(R.resume), label: "繼續叫號", style: "secondary" }
        : { id: componentId(R.pause), label: "暫停叫號", style: "secondary" },
      { id: componentId(R.refresh), label: "重新整理", style: "secondary" },
    ],
  });
  return cardReply(blocks, {
    title: q.isPaused() ? "請求佇列（暫停中）" : "請求佇列",
    accent: "brand",
    // Moderators share the panel; the buttons are disabled after a while (run /queue list again).
    session: { initiatorOnly: false },
  });
}

function voteCard(q: RequestQueue, seconds: number | null): CommandReply {
  const vote = q.voteStatus();
  if (!vote) return notice("info", "目前沒有進行中的投票。");
  const counts = tallies(vote);
  const blocks: CardBlock[] = [
    {
      type: "text",
      text: vote.options.map((o, i) => `${i + 1}. ${o}　${counts[i] ?? 0} 票`).join("\n"),
    },
  ];
  if (seconds !== null)
    blocks.push({ type: "muted", text: `投票時間 ${seconds} 秒，點按鈕投票。` });
  const buttons = vote.options.slice(0, MAX_VOTE_BUTTONS).map((o, i) => ({
    id: componentId(R.cast, i),
    label: o,
    style: "primary" as const,
  }));
  for (let i = 0; i < buttons.length; i += 5) {
    blocks.push({ type: "buttons", buttons: buttons.slice(i, i + 5) });
  }
  return cardReply(blocks, {
    title: "投票",
    accent: "brand",
    // Disable the buttons when the vote is over (up to the platform's limit).
    ...(seconds !== null && seconds * 1000 <= MAX_SESSION_TTL_MS
      ? { session: { ttlMs: seconds * 1000, initiatorOnly: false } }
      : {}),
  });
}

function resultCard(result: VoteResult): CommandReply {
  const lines = result.options.map((o, i) => `${o}　${result.tallies[i] ?? 0} 票`);
  const winner = winnerOption(result);
  return cardReply(
    [
      { type: "text", text: lines.join("\n") },
      {
        type: "text",
        text: winner !== null ? `結果：「${winner}」` : "沒有人投票。",
      },
    ],
    { title: "投票結束", accent: "success" },
  );
}

/** User-facing (Traditional Chinese) text of a queue error. */
export function errorText(error: QueueError): string {
  switch (error.kind) {
    case "blocked":
      return "這個請求無法受理。";
    case "empty_text":
      return "請輸入內容。";
    case "text_too_long":
      return `內容太長，最多 ${error.arg} 個字。`;
    case "user_limit":
      return `你已經有 ${error.arg} 個請求在排隊，請稍後再試。`;
    case "queue_full":
      return "佇列已滿，請稍後再試。";
    case "not_found":
      return `找不到 #${error.arg}。`;
    case "wrong_state":
      return `#${error.arg} 目前無法進行這個操作。`;
    case "vote_running":
      return "已經有投票正在進行。";
    case "no_vote":
      return "目前沒有進行中的投票。";
    case "bad_vote":
      return `投票設定有誤：${error.arg}`;
    case "unknown_option":
      return `沒有「${error.arg}」這個選項。`;
  }
}
