// `recorder`: writes every message (hers included, voice transcripts and her spoken lines too)
// to the message log, keeps the people table up to date and stores the agent's decision traces.

import { defineManifest, errorMessage, type Module, type ModuleContext } from "@miyoria/kernel";
import { logEntryFromIncoming, type Store } from "@miyoria/store";
import {
  type AccountRef,
  HandleDirectoryKey,
  type IncomingMessage,
  newId,
  type ProfileId,
  sameAccount,
  TURN_OUTCOME_TOPIC,
  type TurnId,
  v2Payload,
} from "@miyoria/types";

export class RecorderModule implements Module {
  static readonly ID = "recorder";
  readonly manifest = defineManifest(RecorderModule.ID, "Message recorder", {
    description: "Persists conversations and the people she meets",
  });
  readonly #store: Store;
  readonly #profile: ProfileId;

  constructor(store: Store, profile: ProfileId) {
    this.#store = store;
    this.#profile = profile;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const sub = ctx.subscribe([
      "platform.ready",
      "platform.message.created",
      "voice.utterance",
      "voice.playback",
      "agent.decision",
      TURN_OUTCOME_TOPIC,
    ]);
    const store = this.#store;
    const profile = this.#profile;
    const log = ctx.log;
    ctx.spawn("record", async () => {
      const own: AccountRef[] = [];
      for await (const env of sub) {
        const event = env.event;
        switch (event.type) {
          case "platform_ready": {
            const account = event.data.self_account;
            if (!own.some((a) => sameAccount(a, account))) own.push(account);
            break;
          }
          case "platform_message_created": {
            const msg = event.data;
            const isSelf = own.some((a) => sameAccount(a, msg.author.account));
            await record(ctx, store, profile, msg, isSelf, env.correlation);
            break;
          }
          case "voice_utterance": {
            const u = event.data;
            const msg: IncomingMessage = {
              id: { context: u.context, id: u.id },
              author: u.speaker,
              text: u.text,
              mentions_self: false,
              reply_to_self: false,
              attachments: [],
              ts: u.ended_at,
            };
            await record(ctx, store, profile, msg, false, env.correlation);
            break;
          }
          case "voice_playback": {
            const { context, turn, state, text } = event.data;
            if (state !== "started") break;
            const account = own.find((a) => a.platform === context.platform);
            if (!account) break;
            const msg: IncomingMessage = {
              id: { context, id: newId() },
              author: { account, display_name: "", is_bot: true },
              text,
              mentions_self: false,
              reply_to_self: false,
              attachments: [],
              ts: env.ts,
            };
            await record(ctx, store, profile, msg, true, turn);
            break;
          }
          case "agent_decision": {
            try {
              await store.decisions.append({ id: newId(), profile, ts: env.ts, trace: event.data });
            } catch (error) {
              log.warn({ err: errorMessage(error) }, "failed to record decision");
            }
            break;
          }
          case "custom": {
            // How a turn ended: "decided to reply but nothing was sent" becomes queryable.
            const outcome = v2Payload(event, TURN_OUTCOME_TOPIC);
            if (outcome === null || !store.decisions.appendOutcome) break;
            try {
              await store.decisions.appendOutcome(profile, outcome);
            } catch (error) {
              log.warn({ err: errorMessage(error) }, "failed to record turn outcome");
            }
            break;
          }
          default:
            break;
        }
      }
    });
  }
}

async function record(
  ctx: ModuleContext,
  store: Store,
  profile: ProfileId,
  msg: IncomingMessage,
  isSelf: boolean,
  turn: TurnId | null,
): Promise<void> {
  const entry = { ...logEntryFromIncoming(profile, msg, isSelf), turn };
  try {
    await store.messages.append(entry);
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error) }, "failed to record message");
  }
  if (isSelf) return;
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
