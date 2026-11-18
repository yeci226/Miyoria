// Who she is when she writes words that are not a chat turn (a card, a fortune slip): the same
// persona her chat prompt opens with (`PersonaHandle.corePrompt`: who she is, how she speaks) and
// her example dialogues as the chat prompt shows them (`examplesBlock`). Not the short character
// core of the Deliberate prompts: what she writes for someone to keep has to sound like her chat,
// and the persona is not trimmed for it. What a piece of writing asks of her comes after this.

import { exampleDialogues, examplesBlock, PersonaHandleKey } from "@miyoria/brain/agent";
import type { ApiState } from "./state.js";

/** The persona part of a writing prompt; who she is by name only when there is no persona. */
export function herVoice(state: ApiState): string {
  const persona = state.optional(PersonaHandleKey);
  if (!persona) return "你是她。";
  const core = persona.corePrompt().trim();
  const examples = examplesBlock(exampleDialogues(persona.examples()), persona.names());
  const parts = [core === "" ? `你是${persona.displayName()}。` : core];
  if (examples !== null) parts.push(examples);
  return parts.join("\n\n");
}

/**
 * What every piece of writing of hers is told first: the chat's own markup is not for paper. Her
 * persona and examples speak of `<emo:…>` and `<silence/>`; on a card or a slip there are only
 * her words.
 */
export const WRITTEN_NOT_CHAT =
  "上面是你聊天時的樣子和說話的示範。這次不是聊天,是寫在紙上的字:不寫 <emo:…>、<silence/>、括號裡的動作或旁白,顏文字最多一個。";

/** Chat markup a reply may still carry (`<emo:happy>`, `<silence/>`): taken out of written words. */
export function withoutMarkup(text: string): string {
  return text.replace(/<\/?[a-z_][^<>]{0,40}>/gi, "");
}
