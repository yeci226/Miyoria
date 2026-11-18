// The background video follows the backing track: the logic is shared with the stream's karaoke
// scene (`@miyoria/play/karaoke/lyrics`); `StageBackground.tsx` applies its steps here.

export {
  catchUpRate,
  type SongNow,
  StallWatch,
  VIDEO_CHECK_MS,
  VIDEO_NEAR_S,
  VIDEO_RATE_SPAN,
  VIDEO_SEEK_S,
  VIDEO_STALL_S,
  type VideoNow,
  type VideoStep,
  videoStep,
  videoTarget,
} from "@miyoria/play/karaoke/lyrics";
