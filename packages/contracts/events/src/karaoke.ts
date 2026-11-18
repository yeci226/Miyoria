// Karaoke's record on the event log (docs/design/karaoke.md 「做了什麼(第一步)」): a singing that
// Core scored is one `karaoke.scored`, appended in the transaction that stores the result. It is
// the singer's: their DM scope, kept a year like the cards. The pitch track and the full result
// are in the plugin's own tables; the track is deleted after a week. A singing whose recording is
// scored later (「做了什麼第三步」) has a second one, `source: "voice"`: the official score.

import { z } from "zod";
import {
  StageLinkKaraokeLyricsSchema,
  StageLinkKaraokeSceneSchema,
  StageLinkKaraokeVoiceSchema,
} from "../../stage-link/src/index.js";
import { defineEvent } from "./registry.js";

/** A `karaoke.scored` payload. */
export const KaraokeScoredSchema = z
  .object({
    session: z.string(),
    song: z.string(),
    /** Untrusted (from YouTube). */
    title: z.string(),
    person: z.string().nullable(),
    total: z.number(),
    pitch: z.number(),
    stability: z.number(),
    rhythm: z.number(),
    expression: z.number(),
    /** Flagged as not sung (§9): shown, never a best. */
    unranked: z.boolean(),
    /**
     * `estimate`: from the pitch the browser detected; `voice`: from the recording of the singer
     * (the official score, a second event of the same session). Older events: `estimate`.
     */
    source: z.enum(["estimate", "voice"]).default("estimate"),
  })
  .meta({ id: "EventsKaraokeScored" });
export type KaraokeScoredData = z.output<typeof KaraokeScoredSchema>;

export const KaraokeScored = defineEvent({
  type: "karaoke.scored",
  v: 1,
  data: KaraokeScoredSchema,
  scope: "dm",
  tier: "long",
});

export const KARAOKE_EVENTS = [KaraokeScored] as const;

// ---- the stream's karaoke scene (「做了什麼第五步」): bus topics only, never on the log ---------

/**
 * The karaoke room the stream shows, on every change and once a second while a round is sung
 * (`StageLinkKaraokeScene`); the stage link passes it to the stage node as `karaoke`.
 */
export const KaraokeStageSchema = StageLinkKaraokeSceneSchema.extend({}).meta({
  id: "EventsKaraokeStage",
});
export type KaraokeStageData = z.output<typeof KaraokeStageSchema>;

export const KaraokeStage = defineEvent({
  type: "karaoke.stage",
  v: 1,
  data: KaraokeStageSchema,
  tier: "ambient",
});

/** The words and picture of the round the stream shows, once per round (`karaoke_lyrics`). */
export const KaraokeStageLyricsSchema = StageLinkKaraokeLyricsSchema.extend({}).meta({
  id: "EventsKaraokeStageLyrics",
});
export type KaraokeStageLyricsData = z.output<typeof KaraokeStageLyricsSchema>;

export const KaraokeStageLyrics = defineEvent({
  type: "karaoke.stage.lyrics",
  v: 1,
  data: KaraokeStageLyricsSchema,
  tier: "ambient",
});

export const KaraokeStageVoiceSchema = StageLinkKaraokeVoiceSchema.extend({}).meta({
  id: "EventsKaraokeStageVoice",
});
export type KaraokeStageVoiceData = z.output<typeof KaraokeStageVoiceSchema>;

/**
 * A piece of the relayed singer's voice for the stream's scene (`karaoke_voice`), about four a
 * second while a voice is on; audio never stored or logged (not a recorded topic).
 */
export const KaraokeStageVoice = defineEvent({
  type: "karaoke.stage.voice",
  v: 1,
  data: KaraokeStageVoiceSchema,
  tier: "ambient",
});

/** The karaoke topics of the bus. */
export const KARAOKE_BUS_EVENTS = [KaraokeStage, KaraokeStageLyrics, KaraokeStageVoice] as const;
