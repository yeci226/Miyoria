// `PersonNoteWriter` (provided as `PersonNoteWriterKey`): something she lived with one person,
// written as an episode in the person's own scope, so it comes back whenever they are present.
// It goes through `MemoryEngine.store` like every other memory: merged with a near-identical one,
// faded and tidied by the usual upkeep.

import { errorMessage, getLogger } from "@miyoria/kernel";
import type { PersonId, PersonNoteWriter, Timestamp } from "@miyoria/types";
import type { MemoryEngine } from "./engine.js";

const log = getLogger("memory");

export class PersonNotes implements PersonNoteWriter {
  constructor(private readonly engine: MemoryEngine) {}

  async note(
    person: PersonId,
    content: string,
    options: { importance: number; at: Timestamp },
  ): Promise<boolean> {
    try {
      const stored = await this.engine.store(
        {
          kind: "episode",
          scope: { type: "person", person },
          subjects: [person],
          content,
          importance: options.importance,
          confidence: 0.9,
          source_context: null,
          due: null,
          // She was there: it happened to her.
          origin: "experienced",
        },
        options.at,
      );
      return stored.type !== "refused";
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot write a note about a person");
      return false;
    }
  }
}
