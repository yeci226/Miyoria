// `share.browse`: what her mind picks when she feels like scrolling Threads. No tool: nobody asks
// for it in a chat, it is hers to do when idle.

import { type Capability, CapabilityError, defineCapability } from "@miyoria/actions";
import { z } from "zod";
import type { Sharer } from "./sharer.js";

const NoArgs = z.object({}).loose();
const NOT_NOW = "現在不能滑 Threads";

export function shareCapability(
  sharer: Sharer,
  now: () => number,
  signal: () => AbortSignal,
): Capability<z.output<typeof NoArgs>> {
  return defineCapability<z.output<typeof NoArgs>>({
    name: "share.browse",
    summary: "去滑 Threads,看到想分享的就發",
    risk: "medium",
    args: NoArgs,
    permission: null,
    available: () => sharer.available(now()),
    check: () => (sharer.available(now()) ? null : NOT_NOW),
    // The round runs in the background: her mind does not wait for it.
    async execute() {
      if (!sharer.start(signal())) throw new CapabilityError(NOT_NOW);
      return "去滑 Threads 了";
    },
  });
}
