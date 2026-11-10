// Her working notes: what she chose to keep from a tool result for the rest of a conversation.
//
// A tool result lives for one turn: the next one sees only what she said. On 2026-11-09 she looked
// up a song's lyrics, and a turn later did not know the next line when someone sang it to her. She
// decides what is worth keeping (`keep_note`, in her own words) and lets it go (`drop_note`); each
// conversation shows its notes until they expire. Memory only: a restart forgets them, as it
// should forget a conversation's scratch paper. Long-term memory is something else.

import {
  type ContextKey,
  contextKeyString,
  type PromptContributor,
  type PromptRequest,
  type PromptSection,
} from "@miyoria/types";

export const NOTES_CONTRIBUTOR = "working_notes";
/** Notes per conversation; a new one past this pushes out the oldest. */
export const MAX_NOTES = 5;
/** Characters per note. */
export const MAX_NOTE_CHARS = 600;
export const DEFAULT_NOTE_MINUTES = 30;
export const MAX_NOTE_MINUTES = 180;

export interface WorkingNote {
  id: string;
  text: string;
  /** Epoch ms after which it is gone. */
  until: number;
  /** How long it was kept for. */
  minutes: number;
}

export class WorkingNotes {
  readonly #notes = new Map<string, WorkingNote[]>();
  #next = 1;

  constructor(private readonly now: () => number) {}

  /** Keeps `text` in `context` for `minutes`; returns the note. */
  keep(context: ContextKey, text: string, minutes = DEFAULT_NOTE_MINUTES): WorkingNote {
    const key = contextKeyString(context);
    const list = this.list(context);
    const mins = Math.min(Math.max(1, Math.round(minutes)), MAX_NOTE_MINUTES);
    const note = {
      id: `n${this.#next++}`,
      text: [...text.trim()].slice(0, MAX_NOTE_CHARS).join(""),
      until: this.now() + mins * 60_000,
      minutes: mins,
    };
    list.push(note);
    while (list.length > MAX_NOTES) list.shift();
    this.#notes.set(key, list);
    return note;
  }

  /** Lets a note go; whether it was there. */
  drop(context: ContextKey, id: string): boolean {
    const list = this.list(context);
    const i = list.findIndex((n) => n.id === id.trim());
    if (i < 0) return false;
    list.splice(i, 1);
    return true;
  }

  /** The live notes of `context`, oldest first (expired ones are forgotten here). */
  list(context: ContextKey): WorkingNote[] {
    const key = contextKeyString(context);
    const now = this.now();
    const live = (this.#notes.get(key) ?? []).filter((n) => n.until > now);
    if (live.length > 0) this.#notes.set(key, live);
    else this.#notes.delete(key);
    return live;
  }

  /** The prompt section of a conversation's notes. */
  contributor(): PromptContributor {
    return {
      key: NOTES_CONTRIBUTOR,
      contribute: async (request: PromptRequest): Promise<PromptSection[]> => {
        const notes = this.list(request.context);
        if (notes.length === 0) return [];
        const now = this.now();
        const body = notes
          .map(
            (n) =>
              `[${n.id}](還有 ${Math.max(1, Math.ceil((n.until - now) / 60_000))} 分鐘)${n.text}`,
          )
          .join("\n");
        return [
          {
            key: NOTES_CONTRIBUTOR,
            title: "你在這段對話記下的(用不到了就用 drop_note 丟掉)",
            body,
            order: 6,
          },
        ];
      },
    };
  }
}
