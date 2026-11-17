// What the voice host writes for her to read (step B5), beside the runner's own texts
// (`self/src/rules.ts`) and the text host's (`texts.ts`). The owner has not read these yet; each
// is a candidate for rules.ts, where they move once reviewed.

import { safeName } from "@miyoria/types";

/** What a call of a tool a voice run may not use answers (it did not run). */
export function notInVoice(tool: string): string {
  return `${safeName(tool, 64)} 在語音裡不能用(太花時間,對方在等你開口),所以沒有執行。直接用說的回他;真的需要的話,請他到文字頻道找你。`;
}

/** Block 7's last part when someone in the voice channel called her, by why it is for her. */
export const VOICE_WAKE_LINES = {
  /** Her name, a mention in the voice chat, a question right after she spoke. */
  call: (name: string) => `${safeName(name)} 在語音裡跟你說話:對話紀錄最後那句是對你說的。`,
  /** Only the two of them in the channel: whatever is said is said to her. */
  alone: (name: string) =>
    `語音頻道裡只有你和 ${safeName(name)},他說的話都是對你說的(對話紀錄最後那句)。`,
  /** A line typed in the voice channel's chat that replies to hers. */
  reply: (name: string) =>
    `${safeName(name)} 在語音頻道的文字聊天回覆了你說的話(對話紀錄最後那句),你用說的回。`,
} as const;

/** Block 7: who is in the voice channel (her not counted), and who is talking right now. */
export function roomLines(members: readonly string[], speaking: readonly string[]): string {
  const names = (list: readonly string[]) => list.map((n) => safeName(n)).join("、");
  const lines = [
    members.length === 0 ? "語音頻道裡現在沒有別人。" : `語音頻道裡現在有:${names(members)}。`,
  ];
  if (speaking.length > 0) lines.push(`正在說話的人:${names(speaking)}(還沒說完)。`);
  return lines.join("\n");
}

/** Why a sentence was not said: nothing in it can be read aloud. */
export const UNSPOKEN = "裡面沒有能念出來的字";

/** Why a sentence of a run she was cut off in was not said. */
export const CUT_OFF = "你被打斷了,後面的話沒有說出來";

/** Why a link or a code block was not said (and there is no text chat to write it in). */
export const NO_ASIDE = "連結和程式碼念不出來,這裡也沒有地方寫給他們看";
