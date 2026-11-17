// Her lines for in-game chat: one short, inert line. Game chat runs commands (`/kill`, plugin
// `!` / `.` / `#` prefixes, Baritone's `#`), so a line never starts with a command character, and
// formatting codes and invisible characters are removed.

import { filterOutgoing, neutralize } from "@miyoria/types";

/** Longest line Minecraft accepts. */
export const GAME_CHAT_MAX = 256;

/** Characters that start commands in common games, servers and mods, plus spaces. */
const COMMAND_PREFIX = /^[\s/\\!@#.$%~^&*+=:;|>-]+/u;
/** Minecraft formatting codes (`§a`) and the section sign itself. */
const FORMATTING = /§[0-9a-z]?/giu;
/** Leftover reply tags (`<emo:happy>`, `<pause 300/>`). */
const TAGS = /<\/?(?:emo|pause|silence)[^<>]{0,40}>/giu;
const SENTENCE_END = /[。！？!?.…~～]/u;

/**
 * `text` as one in-game chat line of at most `maxChars` characters: filtered like every outgoing
 * message (no mass mentions, no secrets), neutralized, on one line, without a leading command
 * character, cut at a sentence end when it is too long. `""` when nothing is left.
 */
export function sanitizeGameChat(text: string, maxChars = 120): string {
  const max = Math.min(Math.max(Math.trunc(maxChars), 1), GAME_CHAT_MAX);
  const flat = neutralize(filterOutgoing(text))
    .replace(TAGS, "")
    .replace(FORMATTING, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(COMMAND_PREFIX, "");
  const chars = [...flat];
  if (chars.length <= max) return flat;
  const cut = chars.slice(0, max - 1);
  let end = -1;
  for (let i = cut.length - 1; i >= Math.floor(max / 2); i--) {
    if (SENTENCE_END.test(cut[i] ?? "")) {
      end = i;
      break;
    }
  }
  return end >= 0 ? cut.slice(0, end + 1).join("") : `${cut.join("").trimEnd()}…`;
}
