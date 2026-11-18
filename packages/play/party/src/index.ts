// @miyoria/play/party: module `party`, party games she hosts (docs/design/v4-plan.md §9.1,
// v5-play.md §5): song guessing in voice, turtle soup in voice or in a text channel. The framework
// (one game per channel, players, rounds, timers, scores, a clean end) is `Table`; each game is a
// `Game`; her tools are `party_start` / `party_host` / `party_play` / `party_ask`.

export { partyCapabilities, sessionOf, startPlace } from "./actions.js";
export {
  defaultPartyConfig,
  type PartyConfig,
  PartyConfigSchema,
  type PartyPermissions,
  PartyPermissionsSchema,
  PartyRewardsConfigSchema,
} from "./config.js";
export { SOUP_PUZZLES, type SoupPuzzle } from "./content.js";
export {
  type EndReason,
  GAME_IDS,
  GAME_TITLES,
  GAMES_AVAILABLE,
  type Game,
  type GameId,
  type Host,
  isGameId,
  type NoteOptions,
  PartyError,
  type Player,
  SELF_KEY,
  type StartOptions,
  shuffled,
} from "./game.js";
export { bareTitle, SongGame } from "./games/song.js";
export { SoupGame } from "./games/soup.js";
export {
  LlmSoupJudge,
  parseVerdict,
  SOUP_VERDICTS,
  type SoupCase,
  type SoupJudge,
  type SoupVerdict,
} from "./judge.js";
export {
  asksToStop,
  closeness,
  editDistance,
  fold,
  judgeAnswer,
  numbersIn,
  similarity,
  type Verdict,
} from "./match.js";
export { PartyModule, PartyTableKey } from "./module.js";
export { PartyPrompt, PROMPT_KEY } from "./prompt.js";
export {
  type PartyEnded,
  type PartyNote,
  type PartyOutput,
  realTimers,
  Session,
  type Speaker,
  Table,
  type TableDeps,
  type Timers,
} from "./table.js";
