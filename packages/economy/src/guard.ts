// The screen for what she may promise (docs/design/economy.md §12): bounties call it before she puts a
// task up. Text the moderation, an owner rule, a forbidden or gated capability or
// a missing permission stops is refused, so a snack never buys what is hers to decide.

import { ActuatorRegistryKey, capabilityMatches } from "@miyoria/gate/actions";
import { AuthorizerKey, type ContextKey, DirectivesKey, Principals } from "@miyoria/types";
import type { EconomyService, Member } from "./economy.js";
import { EconomyError } from "./types.js";

/** A promise the screen refuses (not the speaker's money or luck: what it is about). */
export class TaskRefusal extends EconomyError {
  readonly forbidden = true;

  constructor(message: string) {
    super(400, message);
  }
}

export const MAX_TASK_CHARS = 60;

/** Tasks that stand for something she can only do through a gated capability. */
const TASK_CAPABILITIES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/唱|歌|sing/i, ["sing.play"]],
  [/開台|開播|直播|stream/i, ["stream.start"]],
  [/語音|voice/i, ["voice.join"]],
  [/麥塊|minecraft|我的世界|遊戲|game/i, ["game.start"]],
  [/私訊|\bdm\b/i, ["message.dm"]],
  [/表情|臉紅|愛心眼|expression/i, ["stage.expression"]],
  [/場景|scene/i, ["stage.scene"]],
];

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** One line of at most `max` characters. */
export function cleanText(text: string, max: number): string {
  return [...text.replace(CONTROL, " ").replace(/\s+/g, " ").trim()].slice(0, max).join("");
}

/** One line of at most `MAX_TASK_CHARS` characters. */
export function cleanTask(task: string): string {
  return cleanText(task, MAX_TASK_CHARS);
}

/**
 * What she may promise (the gate of her bounties): the text
 * passes moderation, no owner rule forbids it, and what it stands for is something she may do.
 * `who` is the person it is for (their permissions are checked), `null` for her own promise.
 * Throws `TaskRefusal`.
 */
export async function guardTask(
  e: EconomyService,
  who: Member | null,
  task: string,
  context: ContextKey | null,
  about: { noun: string; why: string },
): Promise<void> {
  const s = e.services;
  if (!e.passes(who ?? { account: e.purse.account }, task)) {
    throw new TaskRefusal(`這個${about.noun}的內容不行`);
  }
  const directives = s.get(DirectivesKey);
  const forbids = directives?.forbids({
    what: task,
    why: about.why,
    steps: [task],
    person: who ? e.handleOf(who.person.id) : null,
    context,
  });
  if (forbids) throw new TaskRefusal(`有規則不允許:${forbids.text}`);
  const names = new Set<string>();
  for (const [pattern, capabilities] of TASK_CAPABILITIES) {
    if (pattern.test(task)) for (const name of capabilities) names.add(name);
  }
  if (names.size === 0) return;
  const registry = s.get(ActuatorRegistryKey);
  for (const name of names) {
    const capability = registry?.get(name);
    if (!registry || !capability) throw new TaskRefusal("這件事現在做不到");
    if (registry.paused) throw new TaskRefusal("她現在被暫停了,不能答應");
    if (registry.config.forbidden.some((p) => capabilityMatches(p, name))) {
      throw new TaskRefusal("這件事不允許做");
    }
    // Review and approval are for her own judgement and the owners: a snack does not buy them.
    if (capability.risk === "high") throw new TaskRefusal(`這件事要經過審核,不能用${about.noun}買`);
    if (who && capability.permission !== null) {
      const allowed = s.get(AuthorizerKey)?.allows(who.account, capability.permission);
      if (!allowed) throw new TaskRefusal("你本來就沒有權限要她做這件事");
    }
    // An owner rule on the capability itself: denied or waiting for approval, a snack buys neither.
    const verdict = await directives?.check({
      capability: name,
      args: {},
      principal: Principals.self(context, who?.account ?? null),
    });
    if (verdict && verdict.outcome !== "allow") throw new TaskRefusal("有規則不允許這件事");
  }
}
