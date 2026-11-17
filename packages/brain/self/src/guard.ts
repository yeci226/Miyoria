// Guards that need nothing: one that lets everything through (tests, and an eval subject with no
// services), and several asked in order.

import type { ContextKey } from "@miyoria/types";
import {
  ALLOW,
  type Guard,
  type GuardCall,
  type GuardContext,
  type GuardVerdict,
} from "./types.js";

/** Allows every call and every line. */
export const permissiveGuard: Guard = {
  checkCall: async () => ALLOW,
  checkLine: async () => ALLOW,
};

/** `guards` asked in order: the first refusal is the answer. Results pass through each screen. */
export function composeGuards(...guards: readonly Guard[]): Guard {
  return {
    async checkCall(call: GuardCall, ctx: GuardContext): Promise<GuardVerdict> {
      for (const guard of guards) {
        const verdict = await guard.checkCall(call, ctx);
        if (!verdict.allow) return verdict;
      }
      return ALLOW;
    },
    async checkLine(place: ContextKey, line: string, ctx: GuardContext): Promise<GuardVerdict> {
      for (const guard of guards) {
        const verdict = await guard.checkLine(place, line, ctx);
        if (!verdict.allow) return verdict;
      }
      return ALLOW;
    },
    screenResult(text: string, ctx: GuardContext): string {
      return guards.reduce((out, guard) => guard.screenResult?.(out, ctx) ?? out, text);
    },
  };
}
