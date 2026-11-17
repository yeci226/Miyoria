// Prompt pieces the runner's prompt (`@miyoria/brain/selfhost`) still takes from here: the titles
// of two data blocks, the time-and-place lines, and how a line she wrote is cleaned before it is
// said.

import type { ContextKey } from "@miyoria/types";
import { toTraditional } from "./script.js";
import { utf8Len } from "./util.js";

/** Data block titles. */
export const PRESENT_TITLE = "在場的人";
export const FEELING_TITLE = "你現在這份心情的由來";
/** Title of 「今天的她」 (v4 §6.2). */
export const LIFE_TITLE = "今天的你";
/** An emotion she feels at least this much counts as her mood for the lorebook. */
export const MOOD_MIN = 0.3;

const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** The two lines every prompt of hers has: the time and where she is. */
export function whenAndWhere(ctx: ContextKey, now: Date, utcOffsetMinutes: number): string {
  const local = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  const weekday = WEEKDAYS[(local.getUTCDay() + 6) % 7];
  const time =
    `${local.getUTCFullYear()}-${pad2(local.getUTCMonth() + 1)}-${pad2(local.getUTCDate())} ` +
    `${pad2(local.getUTCHours())}:${pad2(local.getUTCMinutes())}(星期${weekday})`;
  const place =
    ctx.kind === "dm"
      ? "私訊"
      : ctx.kind === "voice"
        ? `語音頻道 ${ctx.channel}`
        : ctx.kind === "thread"
          ? `討論串 ${ctx.channel}`
          : `頻道 ${ctx.channel}`;
  return `- 時間:${time}\n- 地點:${ctx.platform} 的${place}`;
}

function asciiEqualIgnoreCase(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x >= 65 && x <= 90) x += 32;
    if (y >= 65 && y <= 90) y += 32;
    if (x !== y) return false;
  }
  return true;
}

/**
 * Removes a leading `"{her name}:"` the model may copy from the history format, and writes what
 * she wrote in Simplified Chinese in Traditional (`script.ts`).
 */
export function cleanReply(text: string, names: readonly string[]): string {
  let t = text.trim();
  for (const name of names) {
    if (utf8Len(t) < utf8Len(name)) continue;
    const head = t.slice(0, name.length);
    if (!asciiEqualIgnoreCase(head, name)) continue;
    const rest = t.slice(name.length).trimStart();
    if (rest.startsWith(":")) {
      t = rest.slice(1).trimStart();
      break;
    }
  }
  return toTraditional(t.trim());
}
