import { resolve } from "node:path";
import { actuatorsFor } from "@miyoria/actions";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  type ServiceLookup,
  sleep,
} from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import { MemoryEngineKey } from "@miyoria/memory";
import { SettingsStoreKey } from "@miyoria/store";
import { ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  type ContextKey,
  ConversationStatesKey,
  IntentSinkKey,
  type JsonValue,
  newId,
  PlatformSinksKey,
  Principals,
  WorldStateKey,
} from "@miyoria/types";
import { shareCapability } from "./actions.js";
import { ShareConfigSchema } from "./config.js";
import { ThreadsFeed } from "./feed.js";
import { Sharer } from "./sharer.js";

const STORE_PROFILE = "_global";
const STATE_KEY = "share:state";
const TICK_MS = 60_000;
/** While paused, how often she looks whether Threads works again. */
const PROBE_MS = 6 * 3_600_000;
/** A round stuck in the browser does not hold up shutting down. */
const STOP_WAIT_MS = 3000;
/** The extension's tools need a place; nothing about this one is ever sent anywhere. */
const NOWHERE: ContextKey = { platform: "share", scope: null, channel: "threads", kind: "channel" };

export interface ShareModuleOptions {
  /** What `data/threads-share` is relative to (the directory of `miyoria.toml`). */
  baseDir: string;
  persona: (services: ServiceLookup) => string;
  /** `discord:<id>`: told when she has to stop scrolling. */
  owners: () => string[];
}

function account(raw: string): AccountRef | null {
  const at = raw.indexOf(":");
  return at <= 0 ? null : { platform: raw.slice(0, at), id: raw.slice(at + 1) };
}

/**
 * Module `share`: she scrolls Threads on her own and shares a post, with a picture of it and her
 * comment, in a channel whose people would care. Off unless `enabled = true`. Uses the tools of the
 * Threads extension (`internal.threads.*`); registers the capability `share.browse`. Services used
 * (all optional): `LlmRouter`, `MemoryEngine`, `ConversationStates`, `WorldState`, `IntentSink`
 * (the owner's level of a channel), `PlatformSinks`, `SettingsStore` (key `_global` /
 * `share:state`).
 */
export class ShareModule implements Module {
  static readonly ID = "share";
  readonly manifest = defineManifest(ShareModule.ID, "Threads sharing", {
    description: "She shares what she reads on Threads with the channels that would care",
    optional: ["llm", "memory", "conversation", "world", "agent", "actions"],
    configSchema: ShareConfigSchema,
  });
  readonly #options: ShareModuleOptions;
  #running: { sharer: Sharer; abort: AbortController; unregister: () => void } | null = null;

  constructor(options: ShareModuleOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config(ShareConfigSchema);
    const s = ctx.services;
    const abort = new AbortController();
    const now = () => ctx.clock.now();
    const sinks = () => s.get(PlatformSinksKey);
    const feed = new ThreadsFeed(() => s.get(ToolRegistryKey), {
      turn: newId(),
      context: NOWHERE,
      account: { platform: "share", id: "self" },
      principal: Principals.self(null),
      message: { context: NOWHERE, id: "share" },
      priority: "initiative",
      signal: abort.signal,
    });
    const settings = {
      load: async () => (await s.get(SettingsStoreKey)?.get(STORE_PROFILE, STATE_KEY)) ?? null,
      save: async (value: JsonValue) => {
        await s.get(SettingsStoreKey)?.set(STORE_PROFILE, STATE_KEY, value);
      },
    };
    const sharer = new Sharer(
      cfg,
      {
        model: {
          complete: (purpose, request, signal) => {
            const router = s.get(LlmRouterKey);
            if (!router) throw new Error("no LLM router");
            return router.complete(purpose, request, signal);
          },
        },
        persona: () => this.#options.persona(s),
        feed,
        contexts: () => [
          ...(s.get(WorldStateKey)?.snapshot().channels ?? []).map((c) => c.context),
          ...(s.get(ConversationStatesKey)?.list() ?? []).map((c) => c.context),
        ],
        lively: () =>
          (s.get(WorldStateKey)?.snapshot().channels ?? [])
            .filter((c) => c.lively)
            .map((c) => c.context),
        ceiling: (context) => s.get(IntentSinkKey)?.ceiling?.(context) ?? null,
        match: {
          recall: async (scopes, present, query, kinds, limit, at) =>
            (await s.get(MemoryEngineKey)?.recall(scopes, present, query, kinds, limit, at)) ?? [],
          notes: (context) => {
            const state = s.get(ConversationStatesKey)?.get(context);
            return state ? `${state.recap}\n${JSON.stringify(state.notes)}` : "";
          },
          name: async (context) =>
            (await sinks()?.get(context.platform)?.describe?.(context)) ?? null,
        },
        sink: (platform) => sinks()?.get(platform),
        owners: () => this.#options.owners().flatMap((o) => account(o) ?? []),
        settings,
        now,
        warn: (message, error) => ctx.log.warn({ error: String(error ?? "") }, message),
      },
      resolve(this.#options.baseDir, "data/threads-share"),
    );
    await sharer.restore();
    const unregister = actuatorsFor(ctx).register(shareCapability(sharer, now, () => abort.signal));
    ctx.spawn("tick", async (signal) => {
      let nextProbe = now() + PROBE_MS;
      while (!signal.aborted) {
        await sleep(TICK_MS, signal);
        await sharer.flush(abort.signal);
        if (now() >= nextProbe) {
          nextProbe = now() + PROBE_MS;
          await sharer.probe();
        }
      }
    });
    this.#running = { sharer, abort, unregister };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.abort.abort();
    running.unregister();
    await Promise.race([running.sharer.idle(), sleep(STOP_WAIT_MS)]);
  }
}
