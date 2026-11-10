// Whether what she says she did really happened (v2 §1.8 #5: no string as protocol).
//
// What she did is structured: every body transition a tool of hers asked for is an
// ActivityManager task tagged with her turn (the `TransitionResult` her tool got back: started /
// queued / already / refused), and what came back later is an `agent.notice` with its task id.
// The snapshot says what is true now. A line of hers that says she joined voice, went live or
// started a game is fine when one of those backs it.
//
// Only the claim itself is still spotted in her text (`CLAIMS`): that is the one thing no
// structured signal carries, and without it she could tell someone "我游過去了" or "我重新進一
// 次" when nothing happens (the model does that). It is a safety net, not the protocol: it never
// decides what happened, and a claim backed by a task, a notice or the current state is never
// questioned.

import type { ActivityManager, ActivityRequestType, Notice, TurnId } from "@miyoria/types";
import type { ToolScope } from "./tool-scope.js";

/** A claim of something only a tool does, by the transition (and tool) it stands for. */
export interface Claim {
  tool: string;
  /** The body transition it stands for; `null` for a claim only its tool backs (coins). */
  request: ActivityRequestType | null;
  said: RegExp;
  /** Saying it is done (or that she is in that state). */
  finished: RegExp;
  /** Saying she is about to do it. */
  promised: RegExp;
  /** Her state already is what she says (nothing to do, nothing false). */
  holds(scope: ToolScope): boolean;
}

/** Not when she refuses it ("別再進語音了"). */
const NOT_REFUSED = "(?<!不要再|別再|不再|不要|別|不|沒)";
/** How she promises to do something right now ("我重新進一次"). */
const PROMISE = "(?:我|馬上|這就|現在就|重新|再試一次|再)(?:去|來|就|先)?";

/** Saying she did it (`done`), or that she is about to (`act`, after a `PROMISE`). */
function said(done: string, act: string): Pick<Claim, "said" | "finished" | "promised"> {
  return {
    said: new RegExp(`${NOT_REFUSED}(?:${done}|${PROMISE}(?:${act}))`),
    finished: new RegExp(`${NOT_REFUSED}(?:${done})`),
    promised: new RegExp(`${NOT_REFUSED}${PROMISE}(?:${act})`),
  };
}

export const CLAIMS: readonly Claim[] = [
  {
    tool: "voice_join",
    request: "ensure_voice",
    ...said(
      "游過去|游去了|進語音了|進去語音|加入語音了|過去語音|我(?:人)?(?:就|已經|現在)?在語音",
      "進語音|上語音|回語音|加入語音|進一次",
    ),
    holds: (s) => s.inVoice,
  },
  {
    tool: "voice_leave",
    request: "leave_voice",
    // 2026-11-09: 「那我先出去喔,要叫我再回來」 left her in the channel (asked to leave so the
    // others could talk): leaving in plain words counts, not only "語音".
    ...said(
      "離開語音了|退出語音了|游走了|先下語音|我(?:就|先)?(?:出去|離開|退出|下線)了|我先走了",
      "離開語音|下語音|退出語音|出去|離開|退出|下線|走人|閃人",
    ),
    holds: (s) => !s.inVoice,
  },
  {
    tool: "stream_start",
    request: "ensure_live",
    ...said("開台了|開播了|開始直播了", "開台|開播"),
    holds: (s) => s.live,
  },
  {
    tool: "stream_stop",
    request: "stop_live",
    ...said("關台了|下播了|結束直播了", "關台|下播"),
    holds: (s) => !s.live,
  },
  {
    tool: "game_stop",
    request: "stop",
    ...said("不玩了|先不玩|收掉|關掉遊戲|關遊戲了", "關遊戲|關麥塊|收麥塊"),
    holds: (s) => s.game === null,
  },
  {
    tool: "game_start",
    request: "start",
    ...said("開遊戲了|開始玩了|開好遊戲", "開遊戲|開麥塊|開 ?Minecraft"),
    holds: (s) => s.game !== null,
  },
];

/** A claim no promise stands for: only saying it is done counts. */
const NEVER = /(?!)/;

/** A claim about coins: only her tool call (or a recent result of it) backs it. */
function coins(tool: string, done: string): Claim {
  const finished = new RegExp(`${NOT_REFUSED}(?:${done})`);
  return { tool, request: null, said: finished, finished, promised: NEVER, holds: () => false };
}

/**
 * 2026-11-08 15:20-15:23: with the whole conversation in front of her she answered a wallet
 * question, took five bowls, made a deal and agreed to be paid, all in words, with no tool call.
 */
export const COIN_CLAIMS: readonly Claim[] = [
  coins(
    "accept_food",
    "收下了|[(（]收下[)）]|(?:飯|零食|甜點|這碗)(?:我)?(?:就)?收(?:下|了)|吃掉了|開動了|謝謝招待|扣吧|扣了|從你(?:的)?錢包扣",
  ),
  coins("make_deal", "一言為定|說定了|成交|約定成立|就這麼說好了?|一換一"),
  coins(
    "check_coins",
    "你(?:現在|目前|錢包裡)?(?:只|才|還)?(?:有|剩下?)\\s*\\d+\\s*(?:個|枚)?\\s*魚幣|你.{0,4}比我(?:少|多|窮)",
  ),
];

/**
 * Saying she will fetch or prepare a song: only her `sing_request` call backs it, and only once
 * someone brought up a song (`SONG_ASKED`), so 「我先把報告弄好」 is left alone. 「弄好了」 is a
 * song already prepared, with nothing left to ask for. Read by the reminder only, not the gate.
 */
export const SONG_CLAIM: Claim = coins(
  "sing_request",
  "(?:我|這首|那首)[^。!?!?\n]{0,12}(?:去抓|抓下來|抓來|去準備|去下載|弄好(?!了)|排進|排上|加進歌單)",
);
const SONG_ASKED = /唱|歌|https?:\/\//i;

/** Every claim the gate and the reminder read: the body's and the coins'. */
export const ALL_CLAIMS: readonly Claim[] = [...CLAIMS, ...COIN_CLAIMS];

const GAME_ASKED = new RegExp(
  `${NOT_REFUSED}(?:開|玩|打開|啟動)(?:一下|個)? ?(?:minecraft|麥塊|mc|遊戲)`,
  "i",
);

/** Whether a message asks her to start a game ("開麥塊"), not to stop ("不要再玩 Minecraft"). */
export function asksForGame(text: string): boolean {
  return GAME_ASKED.test(text);
}

/** What backs her claims in one turn. */
export interface Backing {
  /** Transitions her turn asked for that were accepted (tasks queued, running or done). */
  requests: ReadonlySet<ActivityRequestType>;
  /** Tools of this turn that answered without an error (no ActivityManager: the only signal). */
  tools: ReadonlySet<string>;
  /** Her state now (`null`: unknown). */
  scope: ToolScope | null;
  /** What the people she answers said (a song claim needs one of them to bring up a song). */
  heard?: readonly string[];
}

/**
 * The transitions `turn` asked for that were accepted, plus those an ok notice she was told
 * reports (by its task id).
 */
export function acceptedRequests(
  manager: ActivityManager | null,
  turn: TurnId,
  notices: readonly Notice[],
): Set<ActivityRequestType> {
  const out = new Set<ActivityRequestType>();
  if (manager === null) return out;
  for (const task of manager.tasks()) {
    if (task.turn === turn && task.status !== "failed") out.add(task.request.type);
  }
  for (const notice of notices) {
    if (!notice.ok || notice.task === null) continue;
    const task = manager.task(notice.task);
    if (task !== null && task.status === "done") out.add(task.request.type);
  }
  return out;
}

/**
 * The first claim in `text` (of a tool on offer) that nothing backs: no accepted transition of
 * this turn or notice, no successful tool call, and her state is not already what she says.
 */
export function unbackedClaim(
  text: string,
  offered: ReadonlySet<string>,
  backing: Backing,
): Claim | null {
  for (const claim of ALL_CLAIMS) {
    if (!offered.has(claim.tool) || !claim.said.test(text)) continue;
    if (claim.request !== null && backing.requests.has(claim.request)) continue;
    if (backing.tools.has(claim.tool)) continue;
    if (backing.scope !== null && claim.holds(backing.scope)) continue;
    return claim;
  }
  if (
    offered.has(SONG_CLAIM.tool) &&
    !backing.tools.has(SONG_CLAIM.tool) &&
    SONG_CLAIM.said.test(text) &&
    (backing.heard ?? []).some((t) => SONG_ASKED.test(t))
  ) {
    return SONG_CLAIM;
  }
  return null;
}

export function claimReminder(tool: string): string {
  return `(系統提醒,不是對方說的話)你剛才說的事要呼叫 ${tool} 才會真的發生,但這一回合還沒呼叫。要做就現在呼叫它;決定不做或做不到,就照實跟對方說。`;
}

/**
 * Tools she wrote as a tag (`Expression.tools`) instead of calling: those on offer that no native
 * call of hers names. A tag that also stands anywhere in her prompt is left alone: she may be
 * repeating what someone wrote or what she recalls, and that must not become an action.
 */
export function toolsWrittenAsText(
  written: readonly string[],
  offered: ReadonlySet<string>,
  called: readonly string[],
  prompt: string,
): string[] {
  const seen = prompt.toLowerCase();
  return [...new Set(written)].filter(
    (tool) => offered.has(tool) && !called.includes(tool) && !seen.includes(`<${tool}`),
  );
}

export function toolTextReminder(tools: readonly string[]): string {
  const names = tools.join("、");
  return `(系統提醒,不是對方說的話)你剛才把 ${names} 寫成文字,這樣不會執行。要做就現在用工具呼叫 ${names},剛才說過的話不用再說;不做就不要說你要做或做了。`;
}
