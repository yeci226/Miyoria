// Capabilities that only need services every app has: `message.dm` (a DM through the platform
// sinks and the scheduler), `speak` (say a line in the voice channel she is in; the panel's
// "say") and the placeholder high-risk `test.high`.

import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/kernel";
import {
  type AccountRef,
  ActionSinkKey,
  HandleDirectoryKey,
  isEphemeralHandle,
  ModerationKey,
  MouthKey,
  newAction,
  newId,
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

/** The account a name she uses for someone (their handle) belongs to, or `null`. */
export type NameLookup = (name: string) => AccountRef | null;

/** Names resolved through the handle table: the names she sees for people in her prompts. */
export function handleLookup(services: ServiceLookup): NameLookup {
  return (name) => {
    if (isEphemeralHandle(name)) return null;
    const handles = services.get(HandleDirectoryKey);
    return handles?.resolve(name)?.account ?? null;
  };
}

/**
 * The account `to` names: `speaker` (default) is the person asking; otherwise a mention
 * (`<@123>`), a bare id on the requester's platform, or (with `names`) the name she knows them
 * by, `@` optional.
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
  const platform = principal.requester?.platform ?? principal.context?.platform ?? "discord";
  return { platform, id };
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
      description:
        "私訊某個人(Discord DM)。to 省略或填 speaker = 正在跟你說話的人;也可以填對方的名字(你看到的那個)" +
        "或 mention(<@id>)。已經在跟對方私訊時直接說就好,不用這個工具。不要私訊陌生人,也不要一直傳。",
      properties: {
        to: { type: "string", description: "speaker、對方的名字,或 mention <@id>" },
        text: { type: "string", description: "要私訊的內容(用你平常說話的方式)" },
      },
      required: ["text"],
    },
    target: (args, principal) => recipient(args.to, principal, names),
    check: (args, principal) =>
      recipient(args.to, principal, names) === null
        ? "`to` must be speaker, a name she knows, a mention or an id"
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
      const actions = ctx.services.get(ActionSinkKey);
      if (actions) {
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
    const sink = ctx.services.get(VoiceSinkKey);
    if (!sink) throw new CapabilityError("the voice module is not running");
    const turn = args.turn ?? newId();
    const { text, blocked } = safeOutgoing(ctx.services.get(ModerationKey), {
      path: "other",
      text: args.text,
      aloud: true,
      context: args.context,
      turn,
    });
    // V3: one mouth. The owner's line goes through the main line like every other.
    const mouth = ctx.services.get(MouthKey);
    if (mouth) {
      const emotion = args.emotion ?? null;
      await mouth.say({ context: args.context, text, emotion, turn, source: "panel", blocked });
      return { text: "speaking", data: { turn } };
    }
    // Speaking lasts as long as the playback; the caller only needs to know it started.
    void sink.speak(args.context, text, args.emotion ?? null, turn).catch((error: unknown) => {
      log.warn({ err: errorMessage(error) }, "speaking failed");
    });
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
