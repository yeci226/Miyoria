import { ReplySinkKey } from "@miyoria/commands";
import { actuatorsFor } from "@miyoria/gate/actions";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  defineManifest,
  type Module,
  type ModuleContext,
  type ServiceLookup,
  sleep,
} from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  accountRefString,
  type ContextKey,
  contextKeyString,
  Events,
  is,
  newImpulse,
  PlatformSinksKey,
  PromptContributorsKey,
  safeName,
  VoiceFloorKey,
  WorldStateKey,
} from "@miyoria/types";
import { StreamHearingKey, VoiceLinkKey } from "@miyoria/voice/voice";
import {
  halt,
  NoticeBook,
  PendingStart,
  StartLog,
  streamers,
  watchCapabilities,
  watchLookCapability,
} from "./actions.js";
import { WatchConfigSchema } from "./config.js";
import { DiscordSource } from "./discord.js";
import { PROMPT_KEY, WatchPrompt } from "./prompt.js";
import type { WatchTarget } from "./source.js";
import { topicKey } from "./speak.js";
import { Watcher } from "./watcher.js";

/** A watch stuck on its way out does not hold up shutting down. */
const STOP_WAIT_MS = 3000;
/** The same thing on the stream is not worth a second line for this long. */
const REPEAT_AFTER_MS = 10 * 60_000;

export interface WatchModuleOptions {
  persona: (services: ServiceLookup) => string;
}

interface Running {
  close(): Promise<void>;
}

/**
 * Module `watch`: she watches a friend's Go Live, keeps notes, speaks up now and then, and decides
 * on her own whose stream to watch. Off unless `enabled = true`. Registers `watch.start`,
 * `watch.stop` and `watch.look` (tools `watch_start`, `watch_stop`, `watch_look`, always offered:
 * what cannot be done at the moment comes back as the reason) and the prompt section `watch`.
 * Something worth a line becomes an impulse of source `watch` for the Arbiter; the module never
 * writes her words. Services used (all optional): `VoiceLink` (without it the tools only say there
 * is no voice node), `StreamHearing`, `VoiceFloor`, `LlmRouter`, `WorldState`, `PlatformSinks`,
 * `PromptContributors`. `optional` does not restart this module with them, so services are looked
 * up on each use, never kept; one watch keeps the link that started it.
 */
export class WatchModule implements Module {
  static readonly ID = "watch";
  readonly manifest = defineManifest(WatchModule.ID, "Watching streams", {
    icon: "monitor",
    category: "play",
    description: "She watches a friend's Go Live and decides on her own when to speak",
    optional: ["voice.link", "voice", "llm", "world", "actions", "arbiter", "agent"],
    configSchema: WatchConfigSchema,
  });
  readonly #options: WatchModuleOptions;
  #running: Running | null = null;

  constructor(options: WatchModuleOptions) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config(WatchConfigSchema);
    const s = ctx.services;
    const link = () => s.get(VoiceLinkKey);
    const now = () => ctx.clock.now();
    const warn = (message: string, error?: unknown) =>
      ctx.log.warn({ error: String(error ?? "") }, message);
    // The registry's own instance: without a store its choices live only in there.
    const actuators = actuatorsFor(ctx);
    const watchAllowed = async (account: AccountRef) =>
      (await actuators.privacy.get(account)).watch;
    /** Guilds where her own line is playing. */
    const playing = new Set<string>();
    /** Streamers with `watch` off when the prompt last looked. */
    const hidden = new Set<string>();
    let source: DiscordSource | null = null;

    const canLook = () => {
      const router = s.get(LlmRouterKey);
      return router?.takesImages("watch") === true && router.budgetState() !== "exhausted";
    };
    /** She says a line about the stream: an impulse for the Arbiter, in the stream's voice room. */
    const speak = (target: WatchTarget, hint: string, topic: string): void => {
      const key = topicKey(topic);
      const where = contextKeyString(target.context);
      try {
        const impulse = newImpulse(
          {
            source: "watch",
            context: target.context,
            // A line about an old picture is not worth saying.
            ttlMs: cfg.snapshot_secs * 2000,
            why: `${safeName(target.name)} 的直播`,
            hint,
            coalesce_key: `watch:${where}`,
            attention: {
              key: key === "" ? `watch:${where}` : `watch:${where}:${key}`,
              repeat_after_ms: REPEAT_AFTER_MS,
            },
          },
          now(),
        );
        ctx.publish(Events.ArbiterImpulse, impulse);
      } catch (error) {
        warn("cannot publish what she wants to say about the stream", error);
      }
    };
    const watcher = new Watcher(cfg, {
      source: () => {
        const current = link();
        if (!current) throw new Error("no voice link");
        source = new DiscordSource(current);
        return source;
      },
      model: {
        complete: (purpose, request, signal) => {
          const router = s.get(LlmRouterKey);
          if (!router) throw new Error("no LLM router");
          return router.complete(purpose, request, signal);
        },
      },
      persona: () => this.#options.persona(s),
      canLook,
      watchAllowed,
      hearing: {
        allowed: async (account) => (await s.get(StreamHearingKey)?.allowed(account)) ?? false,
        transcribe: async (samples, signal) =>
          (await s.get(StreamHearingKey)?.transcribe(samples, signal)) ?? null,
      },
      busy: (guild) => playing.has(guild) || (s.get(VoiceFloorKey)?.holder(guild) ?? null) !== null,
      initiative: speak,
      now,
      sleep,
      warn,
      seen: ({ kind, text, topic, worth }) =>
        ctx.log.info({ kind, topic, worth, text }, "watch look"),
    });
    const pending = new PendingStart();
    const stopFor = (reason: string): void => {
      void halt({ pending, watcher }, reason).catch((error: unknown) =>
        warn("cannot stop watching", error),
      );
    };

    const unregister = [
      ...watchCapabilities({
        cfg,
        link: () => link() ?? null,
        watcher,
        notices: new NoticeBook(cfg.notice_hours, now),
        starts: new StartLog(cfg.starts_per_hour, now),
        pending,
        world: () => s.get(WorldStateKey),
        sink: (platform) => s.get(PlatformSinksKey)?.get(platform),
        cards: () => s.get(ReplySinkKey),
        canLook,
        watchAllowed,
        hidden: (account) => hidden.has(accountRefString(account)),
        now,
        warn,
      }),
      watchLookCapability(watcher, () => ctx.signal),
    ].map((capability) => actuators.register(capability));

    const prompts = s.get(PromptContributorsKey);
    prompts?.register(
      new WatchPrompt({
        view: () => watcher.view(),
        streams: async (context: ContextKey) => {
          const guild = context.scope;
          if (guild === null || link()?.channel(guild) !== context.channel) return [];
          const room = s
            .get(WorldStateKey)
            ?.snapshot()
            .voice_channels.find((c) => c.guild === guild && c.channel === context.channel);
          const live = room ? streamers(room) : [];
          const allowed = await Promise.all(
            live.map((m) => watchAllowed(m.account).catch(() => false)),
          );
          live.forEach((m, i) => {
            const key = accountRefString(m.account);
            if (allowed[i]) hidden.delete(key);
            else hidden.add(key);
          });
          return live.filter((_, i) => allowed[i]);
        },
        now,
      }),
    );

    /** Where she watches and where she is about to. */
    const places = () => [pending.where(), watcher.view()?.target].filter((p) => p != null);
    const events = ctx.subscribe([
      Events.VoiceWatch.type,
      Events.VoiceSpeaking.type,
      Events.VoicePlaybackEvent.type,
      Events.VoiceLeft.type,
      Events.VoiceJoined.type,
    ]);
    ctx.spawn("events", async () => {
      for await (const event of events) {
        try {
          if (is(Events.VoiceWatch, event)) {
            source?.onStatus(event.data);
          } else if (is(Events.VoiceSpeaking, event)) {
            const { speaking, account } = event.data;
            if (speaking && link()?.isSelf(account) === false) watcher.noteVoice(now());
          } else if (is(Events.VoicePlaybackEvent, event)) {
            const { context, state } = event.data;
            if (context.scope === null) continue;
            if (state === "started") playing.add(context.scope);
            else playing.delete(context.scope);
            if (state === "finished") watcher.noteSpoke(now());
          } else if (is(Events.VoiceLeft, event)) {
            const guild = event.data.context.scope;
            if (guild !== null) playing.delete(guild);
            if (places().some((p) => p.guild === guild)) stopFor("left voice");
          } else if (is(Events.VoiceJoined, event)) {
            // A move announces itself as joining the new channel.
            const { channel, scope } = event.data.context;
            if (places().some((p) => p.guild === scope && p.channel !== channel)) stopFor("moved");
          }
        } catch (error) {
          warn("watch event failed", error);
        }
      }
    });

    this.#running = {
      close: async () => {
        for (const off of unregister) off();
        prompts?.unregister(PROMPT_KEY);
        await Promise.race([halt({ pending, watcher }, "module stopped"), sleep(STOP_WAIT_MS)]);
      },
    };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    await running?.close();
  }
}
