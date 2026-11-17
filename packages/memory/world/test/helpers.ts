import type {
  AccountRef,
  Attitude,
  ContextKey,
  IncomingMessage,
  PresenceActivity,
  PresenceStatus,
  PresenceUpdate,
  VoiceStateUpdate,
} from "@miyoria/types";
import { toTimestamp } from "@miyoria/types";
import type { Signals } from "../src/engine.js";

export const T0 = Date.parse("2026-11-02T12:00:00.000Z");
export const G = "100";
export const minutes = (m: number) => m * 60_000;

export const acct = (id: string): AccountRef => ({ platform: "discord", id });

export const textCtx = (channel = "c1", guild: string | null = G): ContextKey => ({
  platform: "discord",
  scope: guild,
  channel,
  kind: guild === null ? "dm" : "channel",
});

/** Attitudes by account id; anyone else is a stranger. */
export class FakeSocial implements Signals {
  readonly attitudes = new Map<string, Attitude>();

  set(id: string, affinity: number, familiarity = 0, blocked = false): this {
    this.attitudes.set(id, {
      person: `person-${id}`,
      affinity,
      trust: 10,
      familiarity,
      blocked,
      label: "朋友",
      call_name: null,
    });
    return this;
  }

  attitude(account: AccountRef): Attitude | null {
    return this.attitudes.get(account.id) ?? null;
  }

  /**
   * Whether she cares about `person`: the heart's 在意 in production; here someone with an
   * affinity of 30 or a familiarity of 40, so the tests read as they always did.
   */
  cares(person: string): boolean {
    for (const a of this.attitudes.values()) {
      if (a.person === person) return a.affinity >= 30 || a.familiarity >= 40;
    }
    return false;
  }
}

export function playing(name: string, startedAt: number | null = null): PresenceActivity {
  return {
    type: "playing",
    name,
    details: null,
    state: null,
    started_at: startedAt === null ? null : toTimestamp(startedAt),
    url: null,
  };
}

export function presence(
  id: string,
  status: PresenceStatus,
  activities: PresenceActivity[] = [],
  extra: Partial<PresenceUpdate> = {},
): PresenceUpdate {
  return {
    platform: "discord",
    guild: G,
    account: acct(id),
    display_name: `user${id}`,
    is_bot: false,
    status,
    activities,
    initial: false,
    ...extra,
  };
}

export function voice(
  id: string,
  channel: string | null,
  extra: Partial<VoiceStateUpdate> = {},
): VoiceStateUpdate {
  return {
    platform: "discord",
    guild: G,
    account: acct(id),
    display_name: `user${id}`,
    is_bot: false,
    channel,
    channel_name: channel === null ? null : `room-${channel}`,
    self_mute: false,
    self_deaf: false,
    server_mute: false,
    server_deaf: false,
    video: false,
    streaming: false,
    initial: false,
    ...extra,
  };
}

let seq = 0;

export function message(
  ctx: ContextKey,
  author: string,
  text: string,
  extra: Partial<IncomingMessage> = {},
): IncomingMessage {
  seq++;
  return {
    id: { context: ctx, id: `m${seq}` },
    author: { account: acct(author), display_name: `user${author}`, is_bot: false },
    text,
    mentions_self: false,
    reply_to_self: false,
    attachments: [],
    ts: toTimestamp(T0),
    ...extra,
  };
}
