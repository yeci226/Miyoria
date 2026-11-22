// @miyoria/play/karaoke: karaoke on the member page, the first milestone (docs/design/karaoke.md
// 「做了什麼(第一步)」).
//
// - `score/`: the score, shared with the panel (`@miyoria/play/karaoke/score`, no Node, no DOM).
// - `config.ts`: `[modules.karaoke]`.
// - `schema.ts`, `migrations.ts`, `store.ts`: the `karaoke` store plugin (songs, requests,
//   sessions, tracks, results) and its event (`events.ts`).
// - `service.ts`: `KaraokeService`: asking for a song, following its preparation, sessions and
//   their signed links (`signing.ts`), scoring a submitted track, her comment, and the reference
//   editor's saves (step 6, the rules in `edit/`, `@miyoria/play/karaoke/edit`).
// - `notes.ts`: what she hears of a finished song, and of a room's rounds.
// - `rooms.ts`: `RoomDesk`, the rooms of step 4 (「做了什麼第四步」): lobby, rounds on one clock,
//   the singers' live voices relayed to a song worker and scored, the board and the trends, the
//   coins; `trend.ts`: what a singer is told about themselves.
// - `module.ts`: module `karaoke`, `KaraokeKey` and `KaraokeRoomsKey`; `card.ts`: its card.

export { karaokeCard } from "./card.js";
export { commentContext, type KaraokeConfig, KaraokeConfigSchema } from "./config.js";
export { KARAOKE_SOURCE, karaokeScoredWrite } from "./events.js";
export { karaokeSchema } from "./migrations.js";
export {
  KaraokeKey,
  KaraokeModule,
  type KaraokeModuleOptions,
  KaraokeRoomsKey,
  NOT_SET_UP,
  NOT_THERE,
  ROOM_TICK_MS,
  roomPlaces,
  TICK_MS,
} from "./module.js";
export { type NoteInput, resultNote, roomOpenedNote, roundResultNote } from "./notes.js";
export { MAX_AUDIO_BYTES, type RoomDeps, RoomDesk, type RoomPlaces } from "./rooms.js";
export {
  COMMENT_WAIT_MS,
  EDIT_BACKING_ROUTE,
  FILES_KEEP_MS,
  failureText,
  KARAOKE_FILES,
  type KaraokeDeps,
  KaraokeError,
  type KaraokeNote,
  type KaraokeServed,
  KaraokeService,
  type KaraokeWho,
  type RoomLink,
  type Submission,
  sourceOf,
  TRACK_KEEP_MS,
} from "./service.js";
export { FILE_ROUTE, FileSigner, LINK_MS } from "./signing.js";
export {
  type CommentState,
  KaraokeStore,
  karaokeTables,
  type ResultRow,
  type SessionRow,
  type SongRow,
  type SongStatus,
} from "./store.js";
