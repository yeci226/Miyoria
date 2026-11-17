// The raw record of conversation (docs/design/v5-data.md §2.3, §2.7): every chat line, people's
// text and voice and hers too (her echoed messages, her spoken sentences), written to the event
// log as one chat event each through the store's `ChatLogStore`.
//
// The facts module is the one writer from the bus to the event log: its lines (observations, her
// decisions, how each turn ended) and these chat lines all come from its subscriptions, so each
// line is stored once whatever publishes it (both Discord connections deliver the same message,
// the terminal chat, the voice room). Her observations of the same messages are hers, a derived
// view under the same key.
//
// Each LLM call's metadata and cost (`llm.call`, published by the `llm` module as the call ends)
// is recorded here too, as it is on the bus: through the log's buffer, so it reaches the store in
// the next flush with the lines, and nothing about a call ever waits on the database. Two more
// topics are recorded the same way, under their own types with the scope and tier their
// definitions give them (for the owner, kept): a live evaluation run (`eval.run`, published by the
// `eval` module after a nightly run) and each hand-over of an artifact as an attachment
// (`artifact.shared`, published by the gate's `share` capability).
//
// Also here, as they go with the lines:
// - "do not remember this" (`agent.message.excluded`): the message's events (its line and her
//   observations of it) are redacted, so every reader of the log stops seeing it;
// - the people table: whoever wrote or spoke is recorded, and her stable name for them is fixed
//   the first time she sees them.

import {
  type AnyEventDefinition,
  ArtifactShared,
  EvalRun,
  LlmCall,
  LlmCallSchema,
} from "@miyoria/contracts/events";
import { errorMessage, type ModuleContext, type Subscription } from "@miyoria/runtime/kernel";
import { type EventWrite, logEntryFromIncoming, type Store } from "@miyoria/store";
import {
  type AccountRef,
  type BusEnvelope,
  Events,
  HandleDirectoryKey,
  type IncomingMessage,
  is,
  isJsonObject,
  type JsonValue,
  type MessageRef,
  newId,
  type ProfileId,
  sameAccount,
  type TurnId,
} from "@miyoria/types";

/** What the chat record writes to: the chat events, or a message log without them (test doubles). */
export type ChatRecordStore = Pick<Store, "chat"> & Partial<Pick<Store, "messages" | "people">>;

/** The topics the chat record reads. */
export const CHAT_RECORD_TOPICS: readonly string[] = [
  "platform.ready",
  "platform.message.created",
  "voice.utterance",
  "voice.playback",
  Events.AgentMessageExcluded.type,
];

/** Writes every chat line `sub` delivers, one at a time, until it ends. */
export async function recordChat(
  ctx: ModuleContext,
  store: ChatRecordStore,
  profile: ProfileId,
  sub: Subscription,
): Promise<void> {
  const own: AccountRef[] = [];
  for await (const env of sub) {
    if (is(Events.PlatformReady, env)) {
      const account = env.data.self_account;
      if (!own.some((a) => sameAccount(a, account))) own.push(account);
    } else if (is(Events.PlatformMessageCreated, env)) {
      const msg = env.data;
      const isSelf = own.some((a) => sameAccount(a, msg.author.account));
      await line(ctx, async () => {
        const options = { self: isSelf, turn: env.turn, source: env.source };
        if (store.chat) await store.chat.message(msg, options);
        else await store.messages?.append(entry(profile, msg, isSelf, env.turn));
      });
      if (!isSelf) await person(ctx, store, msg);
    } else if (is(Events.VoiceUtteranceEvent, env)) {
      const u = env.data;
      const msg: IncomingMessage = {
        id: { context: u.context, id: u.id },
        author: u.speaker,
        text: u.text,
        mentions_self: false,
        reply_to_self: false,
        attachments: [],
        ts: u.ended_at,
      };
      await line(ctx, async () => {
        const options = { turn: env.turn, source: env.source };
        if (store.chat) await store.chat.utterance(u, options);
        else await store.messages?.append(entry(profile, msg, false, env.turn));
      });
      await person(ctx, store, msg);
    } else if (is(Events.VoicePlaybackEvent, env)) {
      const playback = env.data;
      if (playback.state !== "started") continue;
      const account = own.find((a) => a.platform === playback.context.platform);
      if (!account) continue;
      const speaker = { account, display_name: "", is_bot: true };
      await line(ctx, async () => {
        if (store.chat) {
          const options = { at: env.at, turn: playback.turn, source: env.source };
          await store.chat.playback({ ...playback, speaker }, options);
          return;
        }
        const msg: IncomingMessage = {
          id: { context: playback.context, id: newId() },
          author: speaker,
          text: playback.text,
          mentions_self: false,
          reply_to_self: false,
          attachments: [],
          ts: env.at,
        };
        await store.messages?.append(entry(profile, msg, true, playback.turn));
      });
    } else if (is(Events.AgentMessageExcluded, env)) {
      const message = excludedMessage(env.data);
      if (message === null || !store.chat) continue;
      try {
        const ids = await store.chat.redactMessage(message, "do not remember", env.source);
        ctx.log.info({ events: ids.length }, "a message she was asked not to remember");
      } catch (error) {
        ctx.log.warn({ err: errorMessage(error) }, "failed to redact an excluded message");
      }
    }
  }
}

/** A line as a `LogEntry`, for a store without chat events (test doubles). */
function entry(profile: ProfileId, msg: IncomingMessage, isSelf: boolean, turn: TurnId | null) {
  return { ...logEntryFromIncoming(profile, msg, isSelf), turn };
}

/** Stores one line; a failing store costs that line, never the loop. */
async function line(ctx: ModuleContext, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error) }, "failed to record message");
  }
}

/** Keeps the people table up to date for someone who wrote or spoke. */
async function person(
  ctx: ModuleContext,
  store: ChatRecordStore,
  msg: IncomingMessage,
): Promise<void> {
  if (!store.people) return;
  try {
    const person = await store.people.upsertAccount(msg.author.account, msg.author.display_name);
    // Her stable name for them is fixed the first time she sees them.
    ctx.services
      .get(HandleDirectoryKey)
      ?.ofAccount(msg.author.account, msg.author.display_name, person);
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error) }, "failed to record person");
  }
}

/** The message of an `agent.message.excluded` payload, when it names one. */
function excludedMessage(payload: unknown): MessageRef | null {
  if (!isJsonObject(payload) || !isJsonObject(payload.message)) return null;
  const { context, id } = payload.message;
  if (!isJsonObject(context) || typeof id !== "string") return null;
  if (typeof context.platform !== "string") return null;
  return payload.message as unknown as MessageRef;
}

/**
 * What the event log appends for an `llm.call` bus event: the payload as it is, under the bus
 * event's id and time (when the call ended) and the turn it belongs to. `null` for any other bus
 * event, or a payload that does not fit the type.
 */
export function llmCallWrite(env: BusEnvelope): EventWrite | null {
  if (!is(LlmCall, env)) return null;
  const data = LlmCallSchema.safeParse(env.data);
  if (!data.success) return null;
  return {
    draft: {
      id: env.id,
      at: env.at,
      type: LlmCall.type,
      v: LlmCall.v,
      parent: env.parent,
      turn: env.turn,
      data: data.data,
    },
    source: env.source,
  };
}

/** Bus topics the event log records as they are, besides `llm.call`. */
export const RECORDED_TOPICS: readonly AnyEventDefinition[] = [EvalRun, ArtifactShared];

/**
 * What the event log appends for a bus event it records as it is (`llm.call`, `eval.run`,
 * `artifact.shared`): the payload under the bus event's id and time, with its parent and turn.
 * The store stamps the scope and tier of the type's definition. `null` for any other bus event,
 * or a payload that does not fit its type.
 */
export function recordedWrite(env: BusEnvelope): EventWrite | null {
  const call = llmCallWrite(env);
  if (call !== null) return call;
  const definition = RECORDED_TOPICS.find((d) => d.type === env.type && d.v === env.v);
  if (definition === undefined) return null;
  const data = definition.data.safeParse(env.data);
  if (!data.success) return null;
  return {
    draft: {
      id: env.id,
      at: env.at,
      type: definition.type,
      v: definition.v,
      parent: env.parent,
      turn: env.turn,
      data: data.data as JsonValue,
    },
    source: env.source,
  };
}
