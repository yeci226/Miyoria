// Whether she is streaming, from the bus: Discord Go Live (`voice.golive`) in any guild, or OBS
// (`stage.status`).

import { type BusEvent, Events, isJsonObject, type JsonValue } from "@miyoria/types";

/** Topics `LiveState` reads. */
export const LIVE_TOPICS = {
  golive: Events.VoiceGoLive.type,
  stage: Events.StageStatus.type,
} as const;

export class LiveState {
  readonly #golive = new Map<string, string>();
  #obs = false;

  live(): boolean {
    if (this.#obs) return true;
    for (const state of this.#golive.values()) {
      if (state === "starting" || state === "live") return true;
    }
    return false;
  }

  onEvent(env: BusEvent): void {
    const topic = env.type;
    const payload = env.data as JsonValue;
    const data = isJsonObject(payload) ? payload : {};
    if (topic === LIVE_TOPICS.golive && typeof data.state === "string") {
      const guild = typeof data.guild === "string" ? data.guild : "";
      if (data.state === "stopped" || data.state === "failed") this.#golive.delete(guild);
      else this.#golive.set(guild, data.state);
    } else if (topic === LIVE_TOPICS.stage) {
      // Without OBS (or the node) the stream state is unknown; keep the last one.
      if (data.connected === true && data.obs === true) this.#obs = data.streaming === true;
    }
  }
}
