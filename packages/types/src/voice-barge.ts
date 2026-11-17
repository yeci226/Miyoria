// Barge-in (docs/design/v2-architecture.md §3.9): what happened to her speech when somebody
// talked while she spoke, and why. Published by the voice module so the agent can record a
// cancelled turn as `cancelled{cause: "barge_in", by}` (`TurnOutcome`) and tell a short pause
// from a real interruption.
//
// Not everyone who talks over her stops her: only the turn's focus person, someone saying her
// name, or a transcript with substantive content for her. Others duck her volume; after a pause
// she resumes when it turns out nobody was talking to her.

import type { VoiceBargeInData } from "@miyoria/contracts/events";

/**
 * `duck`: her volume went down (somebody else is talking); `pause`: she holds her breath, the
 * rest of her line waits; `resume`: back to normal volume / the paused line goes on; `stop`:
 * the line is over and the rest of the turn's speech is dropped.
 */
export type VoiceBargeInAction = "duck" | "pause" | "resume" | "stop";

/**
 * Why. `focus`: the turn's focus person talks; `name`: somebody said her name; `substantive`:
 * the focus person's transcript is real content (not a short reply); `other`: somebody the turn
 * is not for; `no_focus`: no turn focus is known; `short_reply`: a backchannel ("嗯");
 * `echo`: the ASR transcript echoed the ASR prompt or her own voice; `music`: a song is playing;
 * `timeout`: no verdict arrived in time; `legacy`: `barge_in = "stop"`, anyone stops her;
 * `floor`: her line was dropped because a song / the GPU held the floor too long.
 */
export type VoiceBargeInReason =
  | "focus"
  | "name"
  | "substantive"
  | "other"
  | "no_focus"
  | "short_reply"
  | "echo"
  | "music"
  | "timeout"
  | "legacy"
  | "floor";

/** The payload (contract: `VoiceBargeInSchema` in @miyoria/contracts/events). */
export type VoiceBargeIn = VoiceBargeInData;
