// What the weekly auction sells (docs/design/v5-play.md §4.5, owner 2026-11-17: "how she calls you
// this week" and a one-of-a-kind card frame; owner 2026-11-18: only the frame is offered unless the
// config adds the name) and how the week's lot is chosen: the owner's plan for the week first, else
// she picks from the kinds on offer with one small model call (none when only one kind is on
// offer), else (no model, a failure, an answer that is not one of them) a rotation by the week.

import { type LlmRouter, systemMessage, userMessage } from "@miyoria/llm/llm";
import { errorMessage } from "@miyoria/runtime/kernel";
import { DEFAULT_CURRENCY, dataBlock, safeName } from "@miyoria/types";
import type { LotKind } from "./config.js";

/** How each lot reads to people. */
export const LOT_TITLE: Readonly<Record<LotKind, { name: string; detail: string }>> = {
  call_name: {
    name: "這一週她怎麼叫你",
    detail: "得標的人給她一個稱呼,她接下來七天都這樣叫你;不雅的她會拒絕,可以換一個或退款。",
  },
  frame: {
    name: "只此一件的卡框",
    detail: "一個只有得標的人有的卡框,可以用在自己的卡上。",
  },
};

/** How each lot is described to her when she picks. */
const FOR_HER: Readonly<Record<LotKind, string>> = {
  call_name: "這一週你怎麼叫得標的人(他取一個稱呼,你這七天就這樣叫他;不雅的你可以拒絕)",
  frame: "一個只此一件的卡框(只有得標的人有,用在他的卡上)",
};

/** The rotation: one kind after another, by the week (a week is seven local days). */
export function rotationKind(kinds: readonly LotKind[], week: number): LotKind {
  const n = Math.max(kinds.length, 1);
  return kinds[((Math.floor(week / 7) % n) + n) % n] ?? "frame";
}

/** Her choice of the week's lot, with a short reason in her words (untrusted, for her note). */
export interface LotPick {
  kind: LotKind;
  why: string | null;
}

export interface LotPicker {
  /** Throws when it cannot tell (no model, a failure, an answer that is not a kind on offer). */
  pick(
    kinds: readonly LotKind[],
    recent: readonly LotKind[],
    signal?: AbortSignal,
  ): Promise<LotPick>;
}

/** What she is told before the options; `currency` is the profile's coin name. */
export function lotRules(currency: string = DEFAULT_CURRENCY): string {
  return `這週的拍賣由你決定要拍什麼。拍賣在一個頻道公開出價一天,得標的${currency}會燒掉。
從下面的選項挑一個,只輸出一個 JSON:{"lot": "<代號>", "why": "<一句話,20 字內>"}。
不用想錢,也不用想誰會得標;照你這週想拍什麼來挑。`;
}

/** The kind a reply names, if it is one on offer. */
export function parsePick(text: string, kinds: readonly LotKind[]): LotPick | null {
  let lot: unknown = null;
  let why: unknown = null;
  try {
    const parsed = JSON.parse(text) as { lot?: unknown; why?: unknown };
    lot = parsed.lot;
    why = parsed.why;
  } catch {
    lot = /"lot"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? null;
  }
  if (typeof lot !== "string" || !(kinds as readonly string[]).includes(lot)) return null;
  const reason = typeof why === "string" && why.trim() !== "" ? safeName(why.trim(), 40) : null;
  return { kind: lot as LotKind, why: reason };
}

/** Her pick as one model call of `purpose` (`[llm.purposes]`; the chat chain when unset). */
export class LlmLotPicker implements LotPicker {
  constructor(
    private readonly router: () => Pick<LlmRouter, "complete"> | null,
    private readonly purpose: string,
    private readonly timeoutMs: number,
    /** The coins' name of the running profile. */
    private readonly currency: () => string = () => DEFAULT_CURRENCY,
  ) {}

  async pick(
    kinds: readonly LotKind[],
    recent: readonly LotKind[],
    signal?: AbortSignal,
  ): Promise<LotPick> {
    const router = this.router();
    if (router === null) throw new Error("no model to pick with");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const options = kinds.map((k) => `- ${k}:${FOR_HER[k]}`).join("\n");
    const last = recent.length === 0 ? "還沒拍過。" : `最近幾週拍過(新的在前):${recent.join("、")}`;
    try {
      const response = await router.complete(
        this.purpose,
        {
          messages: [
            systemMessage(`${lotRules(this.currency())}\n\n選項:\n${options}`),
            userMessage(dataBlock("recent", "最近拍過的", last)),
          ],
          temperature: 0.8,
          max_tokens: 200,
          json_mode: true,
          thinking: false,
          session: "market-lot",
        },
        controller.signal,
      );
      const pick = parsePick(response.text, kinds);
      if (pick === null) throw new Error(`not a lot on offer: ${response.text.slice(0, 80)}`);
      return pick;
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error("the pick timed out");
      throw new Error(errorMessage(error));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
