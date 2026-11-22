// Capabilities that only need services every app has: `message.dm` (a DM through the platform
// sinks and the scheduler), `speak` (say a line in the voice channel she is in; the panel's
// "say") and the placeholder high-risk `test.high`.

import { getLogger, type ServiceLookup } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  ActionSinkKey,
  directoryMatch,
  HandleDirectoryKey,
  HeartKey,
  isEphemeralHandle,
  ModerationKey,
  MouthKey,
  nameRefusal,
  newAction,
  newId,
  type PersonNameMatch,
  PlatformSinksKey,
  type Principal,
  type Priority,
  safeOutgoing,
  textLane,
  VoiceSinkKey,
} from "@miyoria/types";
import { z } from "zod";
import { type Capability, CapabilityError, defineCapability } from "./capability.js";

const log = getLogger("actions.builtin");

/** Longest DM she may send in one call. */
export const MAX_DM_CHARS = 1500;

/** Priority of output an action produces for `principal`. */
export function priorityFor(principal: Principal): Priority {
  switch (principal.kind) {
    case "self":
    case "director":
      return "initiative";
    case "user":
      return "request";
    default:
      return "system";
  }
}

/**
 * The account a name she uses for someone belongs to, or `null`; `why`, when it can tell, what
 * to tell her about a name that names nobody (who it may be).
 */
export type NameLookup = ((name: string) => AccountRef | null) & {
  why?: (name: string) => string | null;
};

/**
 * Names resolved through the handle table (`matchPersonName`): the handle she sees for people in
 * her prompts, or one person's whole name as their accounts go by now, the name at first sight or
 * what she calls them. Part of a name, or a name two people go by, is nobody.
 */
export function handleLookup(services: ServiceLookup): NameLookup {
  const match = (name: string): PersonNameMatch | null => {
    if (isEphemeralHandle(name)) return null;
    const calls = services.get(HeartKey)?.callNames?.() ?? [];
    return directoryMatch(services.get(HandleDirectoryKey), name, calls);
  };
  const lookup = (name: string): AccountRef | null => {
    const found = match(name);
    return found?.kind === "one" ? found.candidate.account : null;
  };
  return Object.assign(lookup, {
    why: (name: string): string | null => {
      const found = match(name);
      return found === null || found.kind === "one" ? null : nameRefusal(found);
    },
  });
}

/**
 * The account `to` names: `speaker` (default) is the person asking; otherwise a mention
 * (`<@123>`), a bare id on the requester's platform (or the place's; `null` when neither is
 * known), or (with `names`) the name she knows them by, `@` optional.
 */
export function recipient(
  to: string | null | undefined,
  principal: Principal,
  names: NameLookup | null = null,
): AccountRef | null {
  const raw = (to ?? "").trim();
  if (raw === "" || raw === "speaker") return principal.requester;
  const id = /^<@!?(\d+)>$/.exec(raw)?.[1] ?? (/^\d+$/.test(raw) ? raw : null);
  if (id === null) return names ? (names(raw) ?? names(raw.replace(/^@/, ""))) : null;
  // The requester's platform, else the place's; neither (a panel call): nobody (v5-architecture §6).
  const platform = principal.requester?.platform ?? principal.context?.platform ?? null;
  return platform === null ? null : { platform, id };
}

const DmArgs = z.object({
  to: z.string().nullish(),
  text: z.string().trim().min(1).max(MAX_DM_CHARS),
});
type DmArgs = z.output<typeof DmArgs>;

/** `message.dm`, resolving names with `names` when given. */
export function dmCapability(names: NameLookup | null = null): Capability<DmArgs> {
  return defineCapability<DmArgs>({
    name: "message.dm",
    summary: "私訊某個人",
    risk: "medium",
    args: DmArgs,
    permission: "chat.dm",
    consent: "dm",
    tool: {
      name: "message_dm",
      meta: { effect: "say", speed: "instant", group: "chat", core: true },
      description:
        "私訊某個人(Discord DM)。to 省略或填 speaker = 正在跟你說話的人;也可以填對方的名字(對話紀錄每行開頭那個;他現在的顯示名或你對他的稱呼也可以,要寫完整)" +
        "或 mention(<@id>)。已經在跟對方私訊時直接說就好,不用這個工具。不要私訊陌生人,也不要一直傳。",
      properties: {
        to: {
          type: "string",
          description: "speaker、對方的名字(對話紀錄每行開頭那個),或 mention <@id>",
        },
        text: { type: "string", description: "要私訊的內容(用你平常說話的方式)" },
      },
      required: ["text"],
    },
    target: (args, principal) => recipient(args.to, principal, names),
    check: (args, principal) =>
      recipient(args.to, principal, names) === null
        ? (names?.why?.((args.to ?? "").trim()) ??
          "`to` must be speaker, a name she knows, a mention or an id")
        : null,
    async execute(args, ctx) {
      const to = recipient(args.to, ctx.principal, names);
      if (to === null) throw new CapabilityError("no recipient");
      const sink = ctx.services.get(PlatformSinksKey)?.get(to.platform);
      if (!sink?.openDm) throw new CapabilityError(`cannot send DMs on ${to.platform}`);
      const { text, blocked } = safeOutgoing(ctx.services.get(ModerationKey), {
        path: "other",
        text: args.text,
        turn: ctx.request.turn,
      });
      if (text === "") throw new CapabilityError("nothing left to send after filtering");
      const context = await sink.openDm(to, ctx.signal);
      const mouth = ctx.services.get(MouthKey);
      const actions = ctx.services.get(ActionSinkKey);
      if (mouth) {
        // Through the main line like every line of hers: its moderation, the Floor of the DM, and
        // the delivery record with the recipient as its audience (the wish book reads it).
        const name = (args.to ?? "").trim();
        const label = name === "" || name === "speaker" || /^<@!?\d+>$/.test(name) ? to.id : name;
        const audience = ctx.services.get(HandleDirectoryKey)?.ofAccount(to, label);
        await mouth.say({
          context,
          text,
          turn: newId(),
          source: "self",
          blocked,
          ...(audience === undefined ? {} : { audience: [audience], to: [audience] }),
        });
      } else if (actions) {
        await actions.submit(
          newAction(
            textLane(context),
            priorityFor(ctx.principal),
            { type: "send_message", context, message: { text, reply_to: null } },
            { turn: ctx.request.turn, blocked },
          ),
        );
      } else {
        await sink.send(context, { text, reply_to: null }, ctx.signal);
      }
      return { text: "已私訊對方。", data: { platform: to.platform, id: to.id } };
    },
  });
}

/** `message.dm` with mentions and ids only (names need the handle table). */
export const messageDm: Capability<DmArgs> = dmCapability();

const ContextSchema = z.object({
  platform: z.string(),
  scope: z.string().nullable(),
  channel: z.string(),
  kind: z.enum(["channel", "thread", "dm", "voice"]),
});

const SpeakArgs = z.object({
  context: ContextSchema,
  text: z.string().trim().min(1).max(500),
  emotion: z.string().nullish(),
  turn: z.string().nullish(),
});
type SpeakArgs = z.output<typeof SpeakArgs>;

/** Says a line in a voice channel without the LLM (the panel's "say"); returns once started. */
export const speak: Capability<SpeakArgs> = defineCapability<SpeakArgs>({
  name: "speak",
  summary: "在語音頻道說一句話",
  risk: "low",
  args: SpeakArgs,
  permission: null,
  scope: (args) => args.context.scope,
  async execute(args, ctx) {
    if (!ctx.services.get(VoiceSinkKey))
      throw new CapabilityError("the voice module is not running");
    const turn = args.turn ?? newId();
    const { text, blocked } = safeOutgoing(ctx.services.get(ModerationKey), {
      path: "other",
      text: args.text,
      aloud: true,
      context: args.context,
      turn,
    });
    // One mouth: the owner's line goes through the main line like every other, so without the
    // agent module there is nothing to say it with.
    const mouth = ctx.services.get(MouthKey);
    if (!mouth) throw new CapabilityError("the agent module is not running");
    const emotion = args.emotion ?? null;
    await mouth.say({ context: args.context, text, emotion, turn, source: "panel", blocked });
    return { text: "speaking", data: { turn } };
  },
});

const NoteArgs = z.object({ note: z.string().trim().min(1).max(200) });
type NoteArgs = z.output<typeof NoteArgs>;

/**
 * Placeholder high-risk capability (`[modules.actions] test_capability = true`): does nothing but
 * goes through the self-review and, when uncertain, the owners' approval.
 */
export const testHigh: Capability<NoteArgs> = defineCapability<NoteArgs>({
  name: "test.high",
  summary: "測試用的高風險動作(什麼都不做)",
  risk: "high",
  args: NoteArgs,
  permission: "admin.autonomy.test",
  tool: {
    name: "test_high_risk",
    meta: { effect: "act", speed: "instant", group: "test" },
    description: "測試用的高風險動作:只會留下一筆紀錄,用來試審核流程。只有被要求測試時才用。",
    properties: { note: { type: "string", description: "要留下的紀錄" } },
    required: ["note"],
  },
  async execute(args) {
    log.info({ note: args.note }, "test.high ran");
    return `已執行測試動作:${args.note}`;
  },
});

/** Registered by every app registry; with `services`, `message.dm` also takes her names for people. */
export function builtinCapabilities(services: ServiceLookup | null = null): Capability[] {
  const dm = services ? dmCapability(handleLookup(services)) : messageDm;
  return [dm as Capability, speak as Capability];
}
