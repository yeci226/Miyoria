// @miyoria/party: module `party`, voice party games she hosts and plays (docs/design/v4-plan.md
// §9.1): turtle soup, song guessing, word and story chains, and quizzes. The framework (one game
// per voice channel, players, rounds, timers, scores, a clean end) is `Table`; each game is a
// `Game`; her tools are `party_start` / `party_host` / `party_play` / `party_ask`.

export { partyCapabilities, voiceOf } from "./actions.js";
export {
  defaultPartyConfig,
  type PartyConfig,
  PartyConfigSchema,
  type PartyPermissions,
  PartyPermissionsSchema,
  PartyRewardsConfigSchema,
} from "./config.js";
export {
  IDIOMS,
  QUIZ_QUESTIONS,
  type QuizQuestion,
  SOUP_PUZZLES,
  type SoupPuzzle,
  STARTER_WORDS,
} from "./content.js";
export {
  CHAIN_MODES,
  CHAIN_TITLES,
  type ChainMode,
  type EndReason,
  GAME_IDS,
  GAME_TITLES,
  type Game,
  type GameId,
  type Host,
  type NoteOptions,
  PartyError,
  type Player,
  SELF_KEY,
  type StartOptions,
  shuffled,
} from "./game.js";
export { ChainGame } from "./games/chain.js";
export { QuizGame } from "./games/quiz.js";
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
