// The daily quest she thinks of for someone (`QuestPickerKey` of `@miyoria/economy`,
// docs/design/v5-architecture.md §9.4: "一個她從記憶裡替你想的"). The economy asks once per person
// and local day, the first time they or she look at today's quests, and keeps what comes back.
//
// She is given what the member page already shows them (their bands, her line for them, the
// memories they may read) and writes one short thing for them to do today that they can do by
// talking to her: tell her how something she remembers went, share a little thing. Never anything
// that costs coins, needs buying, going out or proving, nothing about their body, money, a law case
// or an exam, and nobody else in it: a quest that names anyone but them (`other-names.ts`) is
// written once more without that memory, and one that still does, does not fit, or does not pass
// what the page passes is nothing. Nothing is also what comes when there are no memories to think
// from, no model, or no answer in time; the economy then gives one of its plain quests.

import type { MemberCard } from "@miyoria/contracts/api";
import { MAX_PICK_CHARS, type QuestPicker } from "@miyoria/economy";
import {
  completeJson,
  LlmRouterKey,
  systemMessage,
  userMessage,
  withLlmTag,
} from "@miyoria/llm/llm";
import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import { type AccountRef, type NameSplit, sameAccount } from "@miyoria/types";
import { z } from "zod";
import { herVoice, WRITTEN_NOT_CHAT, withoutMarkup } from "./her-voice.js";
import { cardView, loadMemberOf, namesFor, shown, shownMemories } from "./member.js";
import { nameScreen, otherNameIn } from "./other-names.js";
import type { ApiState } from "./state.js";

const log = getLogger("api.quest");

/** Memories she thinks from, at most (newest first). */
const MEMORIES = 5;
/** One answer, at most. */
const ASK_MS = 15_000;

/** What she knows of them for the quest: only what the member page shows them. */
export interface QuestContext {
  /** Their display name. */
  name: string;
  view: MemberCard;
  /** Memories they may read, newest first. */
  memories: readonly string[];
  /** Whose names are whose (`namesFor`); `null` when they cannot be read, and then no quest. */
  names: NameSplit | null;
}

const QuestSchema = z.object({ quest: z.string().nullable().catch(null).default(null) });

const RULES = `${WRITTEN_NOT_CHAT}

你要替下面這個人想一個今天的小任務,他本人會在會員頁和 Discord 看到,做到了你會算他完成。
只回傳 JSON:{"quest": 字串}
- quest:一句話,${MAX_PICK_CHARS} 個字以內,寫成他要做的事,例如「跟她說說新家整理好了沒」「告訴她那首歌練得怎樣」。
- 從下面你記得和他有關的事裡挑一件來想,讓他知道你記得;他只要在聊天裡跟你說、跟你聊,就能做到。
- 不要他花錢、買東西、出門、拍照、證明什麼,也不要他去找別人、幫你做事或叫別人來。
- 不寫身體和病痛、錢和借貸、官司、考試和成績;就算他的事裡提到,也換一件事。
- 不寫數字,不催他、不給壓力,不寫你心裡的盤算或秘密。
- 只寫你和他:他的事裡有別人(任何名字或綽號)時,那個人整個不寫,也不改寫成「朋友」「某人」;換一件事寫。
- 換一個人還能照用的句子就不要寫。`;

const AGAIN_NAMES =
  "你剛才寫的任務裡出現了別人。重寫一次:只有你和他,不寫別人的名字或綽號,也不用「朋友」「某人」代替。";

function about(c: QuestContext): string {
  const v = c.view;
  const lines = [
    `他:${c.name}${v.call_name ? `(你叫他 ${v.call_name})` : ""}`,
    `你們的關係:${v.relationship ?? "還不認識"}`,
  ];
  if (v.public_feeling) lines.push(`你之前寫給他的話:${v.public_feeling}`);
  lines.push(`你記得和他有關的事:\n${c.memories.map((m) => `- ${m}`).join("\n")}`);
  return lines.join("\n");
}

/** Her words flattened to one line, without chat markup or the quotes she may put around them. */
function flatQuest(text: string): string {
  return withoutMarkup(text)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[「『"“]+|[」』"”]+$/gu, "")
    .replace(/[。.!！]+$/u, "")
    .trim();
}

async function ask(state: ApiState, user: string, signal: AbortSignal): Promise<string | null> {
  const router = state.optional(LlmRouterKey);
  if (!router || signal.aborted) return null;
  try {
    const result = await withLlmTag({ module: "api", label: "quest" }, () =>
      completeJson(
        router,
        "chat",
        {
          messages: [systemMessage(`${herVoice(state)}\n\n${RULES}`), userMessage(user)],
          json_mode: true,
          reasoning_purpose: "quest",
          max_tokens: 200,
        },
        QuestSchema,
        { signal: AbortSignal.any([signal, AbortSignal.timeout(ASK_MS)]) },
      ),
    );
    return result.value.quest;
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "she could not think of a quest");
    return null;
  }
}

/**
 * Her quest for `c`, passed by `pass`; `null` when she cannot now: no memories to think from, no
 * model, a failure, too slow, too long, someone else named after one more try, or not passed.
 */
export async function writeQuest(
  state: ApiState,
  c: QuestContext,
  pass: (text: string) => string | null,
  signal: AbortSignal = new AbortController().signal,
): Promise<string | null> {
  if (!state.optional(LlmRouterKey) || c.names === null || c.memories.length === 0) return null;
  const screen = nameScreen(c.names, c.memories);
  let raw = await ask(state, about(c), signal);
  if (raw === null) return null;
  let hit = otherNameIn(screen, flatQuest(raw));
  if (hit !== null) {
    const from = new Set(hit.from);
    const told = { ...c, memories: c.memories.filter((_, i) => !from.has(i)) };
    log.info("her quest named someone else; she writes it again");
    raw =
      told.memories.length === 0
        ? null
        : await ask(state, `${about(told)}\n\n${AGAIN_NAMES}`, signal);
    if (raw === null) return null;
    hit = otherNameIn(screen, flatQuest(raw));
    if (hit !== null) return null;
  }
  const quest = flatQuest(raw);
  if (quest === "" || [...quest].length > MAX_PICK_CHARS) return null;
  return pass(quest);
}

/** `QuestPickerKey`: the quest she thinks of for the person behind an account. */
export class QuestPickService implements QuestPicker {
  constructor(private readonly state: ApiState) {}

  async pick(account: AccountRef, signal: AbortSignal): Promise<string | null> {
    const { state } = this;
    try {
      const who = await loadMemberOf(state, account);
      // Someone she will not say anything about gets nothing she wrote about them.
      if (who.hidden || who.person === null) return null;
      const names = await namesFor(state, who);
      const memories = (await shownMemories(state, who, names))
        .slice(0, MEMORIES)
        .map((m) => m.text);
      const name =
        who.person.accounts.find((a) => sameAccount(a.account, account))?.display_name ??
        who.person.accounts[0]?.display_name ??
        "";
      return await writeQuest(
        state,
        { name, view: cardView(state, who, names), memories, names },
        (text) => shown(state, text, names),
        signal,
      );
    } catch (error) {
      log.warn({ error: errorMessage(error) }, "cannot think of a quest");
      return null;
    }
  }
}
