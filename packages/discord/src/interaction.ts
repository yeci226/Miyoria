// Interactions: slash commands, buttons / selects / modals and autocomplete.
//
// Every answer goes through `send` (the visibility rule and the deferral state in one place)
// or `respondError` (refusals and failures: a new ephemeral message, an ephemeral follow-up or
// an edit of the deferred reply, depending on the interaction's state, and never an edit of the
// message a control is on). Replies with a `session` are tracked in `PanelSessions`; when one
// expires its controls are disabled.

import {
  type ArgValue,
  type CommandRegistry,
  type CommandReply,
  type ComponentInvocationData,
  type ComponentOutcome,
  type InvocationData,
  notice,
  type PanelSessions,
  type ResolvedUser,
  replyEphemeral,
} from "@miyoria/commands";
import { errorMessage, getLogger, withTimeout } from "@miyoria/kernel";
import type { AccountRef, ContextKind } from "@miyoria/types";
import {
  type APIMessageTopLevelComponent,
  type APIModalInteractionResponseCallbackData,
  ApplicationCommandType,
  MessageFlags,
} from "discord.js";
import {
  account,
  commandPath,
  contextKey,
  displayName,
  isGuildAdmin,
  type MemberLike,
  memberNick,
  memberRoleIds,
  type OptionLike,
  type ResolvedLike,
  resolvedUsers,
  type UserLike,
} from "./mapping.js";
import {
  disableComponents,
  hasControls,
  type MessagePayload,
  NO_MENTIONS,
  renderModal,
  renderReply,
} from "./render.js";

const log = getLogger("discord.interaction");

/** Discord wants an interaction response within 3 s; defer after this. */
export const DEFER_AFTER_MS = 1_500;

/** Shown when a command or component handler throws. */
export const HANDLER_FAILED_TEXT = "執行指令時發生錯誤。";

/** The body of an edit (`editReply`, `update`, webhook edits): no `Ephemeral` flag. */
export interface EditPayload {
  components: APIMessageTopLevelComponent[];
  flags: number;
  files?: MessagePayload["files"];
  attachments?: never[];
  allowedMentions: typeof NO_MENTIONS;
}

type SentMessage = { id: string } | null | undefined;
type CallbackResponse = { resource?: { message?: SentMessage } | null } | null | undefined;

/** What every repliable interaction offers (a structural subset of discord.js). */
export interface RepliableLike {
  user: UserLike;
  guildId: string | null;
  channelId: string | null;
  /** The channel's type, when the channel is cached. */
  channel?: { type: number } | null;
  member?: MemberLike | null;
  replied: boolean;
  deferred: boolean;
  reply(options: MessagePayload & { withResponse: true }): Promise<CallbackResponse>;
  deferReply(options: { flags?: number }): Promise<unknown>;
  editReply(options: EditPayload): Promise<SentMessage>;
  followUp(options: MessagePayload): Promise<SentMessage>;
  deleteReply(): Promise<unknown>;
  /** Edits a message sent through this interaction (valid for 15 minutes). */
  webhook?: { editMessage(message: string, options: EditPayload): Promise<unknown> } | null;
}

/** The parts of a `ChatInputCommandInteraction` that command handling uses. */
export interface CommandInteractionLike extends RepliableLike {
  commandName: string;
  options: { data: readonly OptionLike[]; resolved?: ResolvedLike | null };
}

/** A button, select menu or modal submission. */
export interface ComponentInteractionLike extends RepliableLike {
  customId: string;
  /** Selected values (select menus). */
  values?: readonly string[];
  /** Submitted fields (modals). */
  fields?: { fields: { values(): Iterable<{ customId: string; value?: unknown }> } } | null;
  /** The message the control is on; modals opened from a slash command have none. */
  message?: { id: string; channelId?: string; flags?: { has(flag: number): boolean } } | null;
  /** Missing on modals submitted from a slash command. */
  update?: (options: EditPayload & { withResponse: true }) => Promise<CallbackResponse>;
  deferUpdate?: () => Promise<unknown>;
  /** Missing on modal submissions (a modal cannot open another one). */
  showModal?: (modal: APIModalInteractionResponseCallbackData) => Promise<unknown>;
}

/** An autocomplete interaction. */
export interface AutocompleteInteractionLike {
  commandName: string;
  user: UserLike;
  guildId: string | null;
  channelId: string | null;
  member?: MemberLike | null;
  responded: boolean;
  options: {
    data: readonly OptionLike[];
    getFocused(full: true): { name: string; value: string | number | boolean };
  };
  respond(choices: { name: string; value: string }[]): Promise<unknown>;
}

/**
 * A message or user context menu entry (`MessageContextMenuCommandInteraction`,
 * `UserContextMenuCommandInteraction`). `commandName` is the entry's name as the menu shows it.
 */
export interface ContextMenuInteractionLike extends RepliableLike {
  commandName: string;
  /** `ApplicationCommandType.User` (2) or `.Message` (3). */
  commandType: number;
  /** The id of the message or user the menu was used on. */
  targetId: string;
  /** Message menus: the message (its author, when the gateway delivered it). */
  targetMessage?: { author?: UserLike | null } | null;
  /** User menus: who, and their guild member data. */
  targetUser?: UserLike | null;
  targetMember?: MemberLike | null;
}

export type CommandDispatcher = Pick<
  CommandRegistry,
  "dispatch" | "dispatchComponent" | "autocomplete" | "get" | "menuByName"
>;

/** What the interaction handlers share. */
export interface InteractionEnv {
  registry: CommandDispatcher;
  sessions: PanelSessions;
  /** Defer when a handler takes longer than this. */
  deferAfterMs?: number;
  /** Edits a public message after its interaction token expired (REST). */
  editChannelMessage?: (channel: string, message: string, payload: EditPayload) => Promise<void>;
}

function invokerData(
  i: Pick<RepliableLike, "user" | "guildId" | "channelId" | "member">,
  kind: ContextKind,
) {
  const member = i.member ?? null;
  return {
    invoker: account(i.user.id),
    invoker_display_name: displayName(i.user, memberNick(member)),
    context: contextKey(i.guildId, i.channelId ?? "", kind),
    invoker_is_guild_admin: isGuildAdmin(member),
    platform_roles: memberRoleIds(member),
  };
}

/** Builds the invocation of an interaction. `kind` is the channel's context kind. */
export function invocationFromInteraction(
  interaction: Pick<CommandInteractionLike, "commandName" | "options"> &
    Pick<RepliableLike, "user" | "guildId" | "channelId" | "member">,
  kind: ContextKind,
): InvocationData {
  const { path, args } = commandPath(interaction.commandName, interaction.options.data);
  const argRecord: Record<string, ArgValue> = {};
  for (const [name, value] of args) argRecord[name] = value;
  const resolved: Record<string, ResolvedUser> = {};
  for (const [id, user] of resolvedUsers(interaction.options.resolved)) resolved[id] = user;
  return {
    path,
    args: argRecord,
    ...invokerData(interaction, kind),
    resolved_users: resolved,
  };
}

function modalFields(i: ComponentInteractionLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of i.fields?.fields.values() ?? []) {
    if (typeof field.value === "string") out[field.customId] = field.value;
  }
  return out;
}

/** Builds the component invocation of an interaction. */
export function componentInvocation(
  i: ComponentInteractionLike,
  kind: ContextKind,
  sessions: PanelSessions,
): ComponentInvocationData {
  const messageId = i.message?.id ?? null;
  return {
    custom_id: i.customId,
    values: [...(i.values ?? [])],
    fields: modalFields(i),
    message_id: messageId,
    session: sessions.get(messageId),
    ...invokerData(i, kind),
  };
}

function editPayload(payload: MessagePayload): EditPayload {
  const edit: EditPayload = {
    components: payload.components,
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: NO_MENTIONS,
  };
  if (payload.files) {
    edit.files = payload.files;
    edit.attachments = [];
  }
  return edit;
}

/** How an interaction was acknowledged so far. */
export type Ack =
  | { type: "none" }
  /** `deferReply` with this visibility. */
  | { type: "deferred"; ephemeral: boolean }
  /** `deferUpdate` (component interactions). */
  | { type: "update" }
  /** Answered with a message. */
  | { type: "replied" };

/** The acknowledgement state of one interaction (see `respondError`). */
export class InteractionState {
  ack: Ack = { type: "none" };
}

function failureReply(error: unknown): CommandReply {
  return notice("error", HANDLER_FAILED_TEXT, errorMessage(error));
}

function sessionFor(
  env: InteractionEnv,
  i: RepliableLike,
  invoker: AccountRef,
  messageId: string | null,
  reply: CommandReply,
  payload: MessagePayload | EditPayload,
  ephemeral: boolean,
): void {
  if (!reply.session || !messageId) return;
  const disabled: EditPayload = {
    components: disableComponents(payload.components),
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: NO_MENTIONS,
  };
  const channel = i.channelId;
  env.sessions.open(messageId, invoker, reply.session, async () => {
    try {
      if (!i.webhook) throw new Error("no interaction webhook");
      await i.webhook.editMessage(messageId, disabled);
    } catch (error) {
      if (!ephemeral && channel && env.editChannelMessage) {
        await env.editChannelMessage(channel, messageId, disabled);
        return;
      }
      log.debug({ message: messageId, error: errorMessage(error) }, "cannot disable panel");
    }
  });
}

/**
 * Sends a reply as a new message (or as the edit of a deferred reply), following the
 * visibility rule. Returns the id of the first message, if Discord told us.
 */
async function send(
  env: InteractionEnv,
  i: RepliableLike,
  state: InteractionState,
  invoker: AccountRef,
  reply: CommandReply,
  declaredEphemeral: boolean,
): Promise<void> {
  const ephemeral = replyEphemeral(declaredEphemeral, reply);
  const [first, ...rest] = renderReply(reply, ephemeral);
  if (!first) return;
  let id: string | null = null;
  const ack = state.ack;
  if (ack.type === "none") {
    const response = await i.reply({ ...first, withResponse: true });
    id = response?.resource?.message?.id ?? null;
    state.ack = { type: "replied" };
  } else if (ack.type === "deferred" && ack.ephemeral === ephemeral) {
    id = (await i.editReply(editPayload(first)))?.id ?? null;
    state.ack = { type: "replied" };
  } else if (ack.type === "deferred") {
    // A deferred public reply cannot become ephemeral: answer separately, drop the placeholder.
    id = (await i.followUp(first))?.id ?? null;
    await i.deleteReply();
    state.ack = { type: "replied" };
  } else {
    id = (await i.followUp(first))?.id ?? null;
  }
  for (const payload of rest) await i.followUp(payload);
  sessionFor(env, i, invoker, id, reply, first, ephemeral);
}

/**
 * The one place errors and refusals are answered: an ephemeral reply when nothing was sent
 * yet, otherwise an ephemeral follow-up (components: the message the control is on belongs to
 * someone, never overwrite it), or the edit of an ephemeral deferred reply. Never throws.
 */
export async function respondError(
  i: RepliableLike,
  reply: CommandReply,
  state: InteractionState = stateOf(i),
): Promise<void> {
  try {
    const [payload] = renderReply(reply, true);
    if (!payload) return;
    const ack = state.ack;
    if (ack.type === "none") {
      await i.reply({ ...payload, withResponse: true });
      state.ack = { type: "replied" };
    } else if (ack.type === "deferred" && ack.ephemeral) {
      await i.editReply(editPayload(payload));
      state.ack = { type: "replied" };
    } else if (ack.type === "deferred") {
      await i.followUp(payload);
      await i.deleteReply();
      state.ack = { type: "replied" };
    } else {
      await i.followUp(payload);
    }
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "cannot send the error response");
  }
}

/** A state guessed from discord.js flags (for errors outside the handlers). */
function stateOf(i: RepliableLike): InteractionState {
  const state = new InteractionState();
  if (i.replied) state.ack = { type: "replied" };
  else if (i.deferred) state.ack = { type: "update" };
  return state;
}

/** Acknowledges a command so a follow-up can be sent. */
async function ensureCommandAck(i: RepliableLike, state: InteractionState, ephemeral: boolean) {
  if (state.ack.type !== "none") return;
  await i.deferReply({ flags: ephemeral ? MessageFlags.Ephemeral : undefined });
  state.ack = { type: "deferred", ephemeral };
}

/**
 * Runs the command of `interaction` and replies. Fast commands are answered directly; slow ones
 * are deferred after `deferAfterMs` (with the command's declared visibility) and answered with
 * an edit once done. Never throws.
 */
export async function handleCommandInteraction(
  env: InteractionEnv,
  interaction: CommandInteractionLike,
  kind: ContextKind,
): Promise<void> {
  await runInvocation(env, interaction, invocationFromInteraction(interaction, kind));
}

/**
 * Builds the invocation of a context menu entry: the menu's command path `["menu", id]` with the
 * clicked message or person as its argument, or `null` when no registered menu has that name.
 */
export function invocationFromMenu(
  registry: Pick<CommandRegistry, "menuByName">,
  interaction: ContextMenuInteractionLike,
  kind: ContextKind,
): InvocationData | null {
  const target = interaction.commandType === ApplicationCommandType.User ? "user" : "message";
  const menu = registry.menuByName(target, interaction.commandName);
  if (!menu) return null;
  const base = { path: ["menu", menu.id], ...invokerData(interaction, kind) };
  if (target === "user") {
    const user = interaction.targetUser;
    const member = interaction.targetMember ?? null;
    const resolved: Record<string, ResolvedUser> = {};
    if (user) {
      resolved[user.id] = {
        display_name: displayName(user, memberNick(member)),
        platform_roles: memberRoleIds(member),
        is_guild_admin: isGuildAdmin(member),
      };
    }
    return { ...base, args: { target: interaction.targetId }, resolved_users: resolved };
  }
  const author = interaction.targetMessage?.author?.id;
  return {
    ...base,
    args: author ? { target: interaction.targetId, author } : { target: interaction.targetId },
  };
}

/**
 * Runs a context menu entry and replies like a slash command (always through the registry, so
 * the entry's permission, audit and visibility apply). An entry that is no longer registered
 * answers with a notice. Never throws.
 */
export async function handleContextMenuInteraction(
  env: InteractionEnv,
  interaction: ContextMenuInteractionLike,
  kind: ContextKind,
): Promise<void> {
  const invocation = invocationFromMenu(env.registry, interaction, kind);
  if (invocation === null) {
    await respondError(interaction, notice("warn", MENU_GONE_TEXT));
    return;
  }
  await runInvocation(env, interaction, invocation);
}

/** Shown when a menu entry was removed while Discord still listed it. */
export const MENU_GONE_TEXT = "這個選單項目已經不能用了。";

async function runInvocation(
  env: InteractionEnv,
  interaction: RepliableLike,
  invocation: InvocationData,
): Promise<void> {
  const name = invocation.path.join(" ");
  const declared = env.registry.get(invocation.path)?.ephemeral ?? true;
  const state = new InteractionState();
  log.debug({ command: name, user: interaction.user.id }, "command interaction");

  const followUp = async (reply: CommandReply) => {
    await ensureCommandAck(interaction, state, declared);
    const ephemeral = replyEphemeral(declared, reply);
    for (const payload of renderReply(reply, ephemeral)) await interaction.followUp(payload);
  };
  const settled = env.registry.dispatch(invocation, { followUp }).then(
    (reply): { reply: CommandReply } | { error: unknown } => ({ reply }),
    (error: unknown) => ({ error }),
  );
  try {
    let outcome = await withTimeout(settled, env.deferAfterMs ?? DEFER_AFTER_MS);
    if (outcome === undefined) {
      try {
        await ensureCommandAck(interaction, state, declared);
      } catch (error) {
        log.warn({ command: name, error: errorMessage(error) }, "cannot defer interaction");
      }
      outcome = await settled;
    }
    if ("error" in outcome) {
      log.warn({ command: name, error: errorMessage(outcome.error) }, "command handler failed");
      await respondError(interaction, failureReply(outcome.error), state);
      return;
    }
    if (outcome.reply.tone === "error" || outcome.reply.tone === "warn") {
      await respondError(interaction, outcome.reply, state);
      return;
    }
    await send(env, interaction, state, invocation.invoker, outcome.reply, declared);
  } catch (error) {
    log.warn({ command: name, error: errorMessage(error) }, "cannot respond to interaction");
  }
}

/**
 * Routes a button, select menu or modal submission through the registry and answers it:
 * `update` edits the message the control is on, `reply` sends a new message, `modal` opens a
 * modal. Ids Miyoria did not make are ignored. Never throws.
 */
export async function handleComponentInteraction(
  env: InteractionEnv,
  interaction: ComponentInteractionLike,
  kind: ContextKind,
): Promise<void> {
  const data = componentInvocation(interaction, kind, env.sessions);
  const state = new InteractionState();
  const hasMessage =
    interaction.message !== null &&
    interaction.message !== undefined &&
    interaction.update !== undefined &&
    interaction.deferUpdate !== undefined;
  const messageEphemeral = interaction.message?.flags?.has(MessageFlags.Ephemeral) ?? true;

  const followUp = async (reply: CommandReply) => {
    if (state.ack.type === "none") {
      if (hasMessage) {
        await interaction.deferUpdate?.();
        state.ack = { type: "update" };
      } else {
        await ensureCommandAck(interaction, state, true);
      }
    }
    for (const payload of renderReply(reply, replyEphemeral(true, reply))) {
      await interaction.followUp(payload);
    }
  };
  const settled = env.registry.dispatchComponent(data, { followUp }).then(
    (outcome): { outcome: ComponentOutcome | null } | { error: unknown } => ({ outcome }),
    (error: unknown) => ({ error }),
  );
  try {
    let done = await withTimeout(settled, env.deferAfterMs ?? DEFER_AFTER_MS);
    if (done === undefined) {
      try {
        if (state.ack.type === "none") {
          if (hasMessage) {
            await interaction.deferUpdate?.();
            state.ack = { type: "update" };
          } else {
            await ensureCommandAck(interaction, state, true);
          }
        }
      } catch (error) {
        log.warn({ id: data.custom_id, error: errorMessage(error) }, "cannot defer interaction");
      }
      done = await settled;
    }
    if ("error" in done) {
      log.warn({ id: data.custom_id, error: errorMessage(done.error) }, "component handler failed");
      await respondError(interaction, failureReply(done.error), state);
      return;
    }
    const outcome = done.outcome;
    if (outcome === null) return; // not ours
    const result = outcome.result;
    switch (result.type) {
      case "modal": {
        if (state.ack.type !== "none" || !interaction.showModal) {
          await respondError(interaction, notice("error", "無法開啟表單，請再試一次。"), state);
          return;
        }
        await interaction.showModal(renderModal(result.modal));
        state.ack = { type: "replied" };
        return;
      }
      case "update": {
        if (!hasMessage) {
          await send(env, interaction, state, data.invoker, result.reply, true);
          return;
        }
        const [payload] = renderReply(result.reply, false);
        if (!payload) return;
        const edit = editPayload(payload);
        if (state.ack.type === "none") {
          await interaction.update?.({ ...edit, withResponse: true });
          state.ack = { type: "replied" };
        } else if (state.ack.type === "update") {
          await interaction.editReply(edit);
        } else {
          await interaction.followUp(renderReply(result.reply, true)[0] as MessagePayload);
          return;
        }
        const id = interaction.message?.id ?? null;
        if (id === null) return;
        const previous = data.session ?? null;
        if (!hasControls(edit.components)) {
          // Nothing left to disable; an expiry must not bring the old controls back.
          env.sessions.close(id);
        } else if (result.reply.session) {
          sessionFor(env, interaction, data.invoker, id, result.reply, edit, messageEphemeral);
        } else if (previous) {
          // Keep the panel's owner and data, and disable the controls it shows now.
          const carried: CommandReply = {
            ...result.reply,
            session: { initiatorOnly: previous.initiator_only, data: previous.data ?? undefined },
          };
          sessionFor(env, interaction, previous.initiator, id, carried, edit, messageEphemeral);
        }
        return;
      }
      case "reply": {
        if (outcome.ephemeral && (result.reply.tone === "error" || result.reply.tone === "warn")) {
          await respondError(interaction, result.reply, state);
          return;
        }
        await send(env, interaction, state, data.invoker, result.reply, outcome.ephemeral);
        return;
      }
    }
  } catch (error) {
    log.warn({ id: data.custom_id, error: errorMessage(error) }, "cannot respond to interaction");
  }
}

/** Answers an autocomplete request; failures answer with no suggestions. Never throws. */
export async function handleAutocomplete(
  env: InteractionEnv,
  interaction: AutocompleteInteractionLike,
  kind: ContextKind,
): Promise<void> {
  try {
    const focused = interaction.options.getFocused(true);
    const { path, args } = commandPath(interaction.commandName, interaction.options.data);
    const argRecord: Record<string, ArgValue> = {};
    for (const [name, value] of args) {
      if (name !== focused.name) argRecord[name] = value;
    }
    const choices = await env.registry.autocomplete(
      { path, args: argRecord, ...invokerData(interaction, kind) },
      focused.name,
      String(focused.value),
    );
    await interaction.respond(choices);
  } catch (error) {
    log.debug(
      { command: interaction.commandName, error: errorMessage(error) },
      "autocomplete failed",
    );
    try {
      if (!interaction.responded) await interaction.respond([]);
    } catch {
      // the interaction expired
    }
  }
}
