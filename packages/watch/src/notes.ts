import type { WatchConfig } from "./config.js";
import { cutNote } from "./look.js";

/** What she saw and heard this watch. Memory only; it is dropped when the watch ends. */
export class WatchNotes {
  private readonly noteList: string[] = [];
  /** When the newest note was written; `null` before the first look. */
  lastNoteAt: number | null = null;
  private readonly lines: { at: number; text: string }[] = [];

  constructor(
    private readonly cfg: Pick<WatchConfig, "notes_keep" | "transcript_secs">,
    private readonly now: () => number,
  ) {}

  addNote(text: string): void {
    const t = cutNote(text);
    if (t === "") return;
    this.noteList.push(t);
    this.lastNoteAt = this.now();
    while (this.noteList.length > this.cfg.notes_keep) this.noteList.shift();
  }

  addLine(text: string): void {
    const t = cutNote(text);
    if (t === "") return;
    this.lines.push({ at: this.now(), text: t });
    this.prune();
  }

  notes(): string[] {
    return [...this.noteList];
  }

  transcript(): string[] {
    this.prune();
    return this.lines.map((l) => l.text);
  }

  private prune(): void {
    const oldest = this.now() - this.cfg.transcript_secs * 1000;
    while (this.lines.length > 0 && (this.lines[0] as { at: number }).at < oldest) {
      this.lines.shift();
    }
  }
}
