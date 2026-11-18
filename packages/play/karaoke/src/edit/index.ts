// @miyoria/play/karaoke/edit: the reference editor's edits (docs/design/karaoke.md 「做了什麼第六
// 步」), shared by the editor on the member page (apps/panel) and Core, which checks every save with
// the same rules. Plain TypeScript with no DOM and no Node, and no imports outside this folder
// except the reference format's types (`import type`).
//
// - `pieces.ts`: a line's text cut into pieces, keeping what an edit did not touch.
// - `ops.ts`: the edits (lines, pieces, notes, the whole song), each a new document.
// - `validate.ts`: what a save must hold (`validateEdit`), sentences for people.
// - `compose.ts`: the edit made into the reference everyone sings against.

export { composeReference, docOf, editedLines, markEdited } from "./compose.js";
export {
  addNote,
  deleteLine,
  deleteNotes,
  type EditDoc,
  ensureLyrics,
  fitLineToPieces,
  insertLine,
  markChecked,
  mergeLines,
  mergeNotes,
  moveNotes,
  type NoteEdit,
  piecesOf,
  setLineText,
  setLineTimes,
  setNote,
  setPiece,
  shiftLine,
  shiftLyrics,
  shiftSong,
  splitLine,
  splitNote,
  spreadPieces,
  timePieces,
} from "./ops.js";
export { piecesFromText, piecesTimed, type Repieced, repiece } from "./pieces.js";
export { EDIT_LIMITS, type EditContext, type EditProblem, validateEdit } from "./validate.js";
