import { Events } from "@miyoria/types";
// Core → Stage: follow the voice node's Go Live with OBS.
//
// `@miyoria/voice/voice` publishes `voice.golive` whenever the node reports a state change. The Stage
// node starts / stops OBS from it, so `/golive start` is one command instead of "start the
// listener here, press OBS there".

/** Topic of the Go Live state events (the `GOLIVE_TOPIC` of `@miyoria/voice/voice`). */
export const VOICE_GOLIVE_TOPIC = Events.VoiceGoLive.type;

/** What OBS should do for a Go Live state: `null` = leave OBS alone. */
export type GoLiveFollow = "start" | "stop" | null;

/** Maps a `voice.golive` state to the OBS action. `live` needs nothing: OBS already runs. */
export function goliveFollow(state: unknown): GoLiveFollow {
  switch (state) {
    case "starting":
      return "start";
    case "stopped":
    case "failed":
      return "stop";
    default:
      return null;
  }
}
