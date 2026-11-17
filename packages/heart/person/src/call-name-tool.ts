// `social.set_call_name` (tool `set_call_name`): someone tells her in chat how they want to be
// called, and she saves it into their 稱呼 on the heart's row (the `/me profile` button and the
// panel do the same). It only ever changes the speaker's own: the person the call acts for
// (`for_whom` when several called her at once), never a name in its arguments. The capability
// keeps its old name: permissions, limits and the audit refer to it.

import { type Capability, CapabilityError, defineCapability } from "@miyoria/gate/actions";
import { z } from "zod";
import { CLEAR_WORDS, checkCallName, labelOf, type ScreenCallName } from "./commands.js";
import type { PeopleDirectory } from "./directory.js";
import { BLOCKED_TAG, hasTag } from "./model.js";

const NO_SPEAKER = "沒有正在跟你說話的人:這只能在有人親自跟你說的時候用";

const Args = z.strictObject({ name: z.string().max(200) });
type Args = z.output<typeof Args>;

export function callNameCapability(
  people: PeopleDirectory,
  screen: ScreenCallName = async () => null,
): Capability {
  return defineCapability<Args>({
    name: "social.set_call_name",
    summary: "把說話的人想被怎麼稱呼存起來",
    risk: "medium",
    args: Args,
    permission: null,
    limits: { per_day: 1_000, per_person_per_day: 10, cooldown_ms: 0 },
    tool: {
      name: "set_call_name",
      meta: { effect: "act", speed: "instant", group: "memory" },
      description:
        "有人說想被怎麼稱呼(或不要被某個稱呼)時,把「說話的這個人」的稱呼存起來;只能改說話者自己的," +
        "不能幫別人改(「叫他小胖」不行)。name 填稱呼;不要再用某個稱呼時填「清除」。不要設 on_own。",
      properties: {
        name: { type: "string", description: "稱呼本身(最多 20 個字);「清除」或留空就是清掉" },
      },
      required: ["name"],
    },
    check: (_args, principal) =>
      principal.kind === "user" && principal.requester !== null ? null : NO_SPEAKER,
    async execute(args, ctx) {
      const account = ctx.principal.kind === "user" ? ctx.principal.requester : null;
      if (account === null) throw new CapabilityError(NO_SPEAKER);
      const now = people.clock.now();
      const person = await people.resolve(account, null, now);
      if (person === null) throw new CapabilityError("不認識這個人,沒有存。");
      const row = people.heart.get(person);
      if (row !== null && hasTag(row, BLOCKED_TAG)) {
        throw new CapabilityError("對方目前不能設定稱呼。");
      }
      const call = args.name.trim();
      if (call === "" || CLEAR_WORDS.has(call)) {
        people.heart.edit(person, { call_name: null }, { now });
        return {
          text: "已清除對方的稱呼,之後用一般的方式稱呼他。",
          data: { call_name: null },
        };
      }
      const bad = checkCallName(call) ?? (await screen(call));
      if (bad !== null) throw new CapabilityError(`沒有存:${bad}`);
      if (labelOf(row) === "很討厭") {
        throw new CapabilityError("你現在不想理對方,不接受他設定稱呼。");
      }
      people.heart.edit(person, { call_name: call }, { now });
      return { text: `存好了:之後稱呼對方「${call}」。`, data: { call_name: call } };
    },
  }) as Capability;
}
