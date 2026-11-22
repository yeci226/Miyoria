// Telling a reporter their problem was fixed: a follow-up in her memory about them, due now. The
// initiative picks due follow-ups up and wakes her in the place it names (where the report was
// made), through the same gates as any follow-up; whether and how she says it is hers. The text is
// written here (the area's name and the issue number only), never from what the member typed.

import { MemoryEngineKey, scopeForNew } from "@miyoria/memory/memory";
import type { ServiceLookup } from "@miyoria/runtime/kernel";
import { toTimestamp } from "@miyoria/types";
import { AREA_NAMES, type FixedNotice, type ReportNotifier } from "./service.js";

/** The follow-up she gets. */
export function fixedText(notice: FixedNotice): string {
  return `之前對方跟你回報的${AREA_NAMES[notice.area]}問題,維護的人已經處理好了(issue #${notice.issue} 關掉了);有機會可以跟對方說一聲。`;
}

/** The notifier over the memory module's engine; `null` without one. */
export function memoryNotifier(services: ServiceLookup): ReportNotifier | null {
  const engine = services.get(MemoryEngineKey);
  if (engine === undefined) return null;
  return {
    async fixed(notice, now) {
      const at = toTimestamp(now);
      const scope =
        notice.context === null
          ? ({ type: "person", person: notice.person } as const)
          : scopeForNew(engine.config, notice.context, notice.account, "followup", null);
      const stored = await engine.store(
        {
          kind: "followup",
          scope,
          subjects: [notice.person],
          content: fixedText(notice),
          importance: 0.5,
          confidence: 1,
          source_context: notice.context,
          due: at,
          origin: "experienced",
        },
        at,
      );
      return stored.type !== "refused";
    },
  };
}
