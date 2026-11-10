import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { knownNames, PeopleStoreKey } from "@miyoria/store";
import {
  ACTIVITY_CHANGED_TOPIC,
  ActivityManagerKey,
  AffectStateKey,
  customEvent,
  EventLogKey,
  HandleDirectoryKey,
  LIVE_TOUCH_TOPIC,
  type LiveFeed,
  LiveFeedKey,
  type LivePatter,
  ModerationKey,
  ParticipationKey,
  SocialSignalsKey,
  sameAccount,
} from "@miyoria/types";
import { LiveConfigSchema } from "./config.js";
import { LIVE_TOPICS, LiveState } from "./feed.js";
import { PAT_BUCKET, PatDesk, type PatWho } from "./pats.js";
import type { Screen } from "./privacy.js";
import { VideoWatch } from "./video.js";

/** How often the clock-driven parts move: the activity line, a batch of pats closing. */
const TICK_MS = 1_000;
/** How long the names of everyone are reused: reading them walks the people table. */
const NAMES_EVERY_MS = 60_000;
/** Moderation verdicts remembered, so a growing line is not judged from scratch each time. */
const MAX_VERDICTS = 2_000;

export interface LiveModuleOptions {
  /** Her own names (`Profile.names()`): a line may say them. */
  names?: readonly string[];
  /** For tests: the `fetch` that asks MediaMTX. */
  fetch?: typeof fetch;
}

/**
 * Who `by` is to her: someone she knows, a stranger, or blocked. Blocked is also the answer when
 * nothing can tell (no social tag and no cards): a pat must not reach her because a module is
 * down. Read only; nothing is counted or assigned here, no handle for a stranger either.
 */
export async function whoPats(ctx: ModuleContext, by: LivePatter): Promise<PatWho> {
  const s = ctx.services;
  const social = s.get(SocialSignalsKey);
  const affect = s.get(AffectStateKey);
  if (!social && !affect) return { kind: "blocked" };
  if (social?.attitude(by.account)?.blocked) return { kind: "blocked" };
  const person = (await s.get(PeopleStoreKey)?.personByAccount(by.account)) ?? null;
  if (person === null) return { kind: "stranger" };
  const card = affect?.card(person.id) ?? null;
  if (card?.blocked) return { kind: "blocked" };
  const own = person.accounts.find((a) => sameAccount(a.account, by.account));
  return {
    kind: "known",
    person: person.id,
    handle: s.get(HandleDirectoryKey)?.ofPerson(person.id) ?? card?.handle ?? null,
    name: own?.display_name ?? person.display_name,
  };
}

/**
 * Module `live`: the feed of the live page (docs/design/v4-plan.md §9.2) and its head-pats.
 * Provides `LiveFeedKey`, which the api serves at `GET /api/public/live` and
 * `POST /api/member/live/pat`. Reads the bus and her body state; writes only pat Observations
 * (with `pats = true`). Its only publication is the custom event `live.touch` (`{ x, y, part }`,
 * no names) for each accepted pat that came with a spot on the picture, for the stage to draw a
 * hand there; being watched changes nothing about her. With `[modules.live.video]` it also asks
 * MediaMTX whether OBS is publishing, so the page can show the picture.
 */
export class LiveModule implements Module {
  static readonly ID = "live";
  readonly manifest = defineManifest(LiveModule.ID, "Live page", {
    description: "Her state, face and public lines for the live page; head-pats as Observations",
    optional: ["facts", "moderation", "activity", "social", "self", "economy"],
    configSchema: LiveConfigSchema,
  });
  readonly #own: readonly string[];
  readonly #fetch: typeof fetch | undefined;

  constructor(options: LiveModuleOptions = {}) {
    this.#own = [...(options.names ?? [])];
    this.#fetch = options.fetch;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(LiveConfigSchema);
    const now = () => ctx.clock.now();

    let names: { at: number; others: readonly string[] | null } | null = null;
    const ownSet = new Set(this.#own.map((n) => n.trim().toLowerCase()));
    const refreshNames = async (): Promise<void> => {
      const known = await knownNames(ctx.services).catch(() => null);
      const others =
        known === null
          ? null
          : known.map((k) => k.name).filter((n) => !ownSet.has(n.trim().toLowerCase()));
      names = { at: now(), others };
    };
    const verdicts = new Map<string, boolean>();
    const screen: Screen = {
      names: () => names?.others ?? null,
      own: this.#own,
      moderate: (text) => {
        const moderation = ctx.services.get(ModerationKey);
        if (!moderation) return null;
        const seen = verdicts.get(text);
        if (seen !== undefined) return seen;
        const ok = moderation.screen({ path: "other", visible: text }).ok;
        if (verdicts.size >= MAX_VERDICTS) verdicts.clear();
        verdicts.set(text, ok);
        return ok;
      },
    };

    const desk = new PatDesk({
      config,
      now,
      who: (by) => whoPats(ctx, by),
      observe: ({ observation, person }) => {
        const log = ctx.services.get(EventLogKey);
        if (!log) {
          ctx.log.debug("no EventLog: a batch of pats goes unnoticed");
          return;
        }
        try {
          log.observe(observation, { buckets: [PAT_BUCKET], person });
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "cannot tell her about the pats");
        }
      },
      // Looked up per pat: the economy may start after this module, or not at all.
      award: (by, key) => {
        const participation = ctx.services.get(ParticipationKey);
        if (!participation) return;
        participation.award(by.account, "headpat", key).catch((error) => {
          ctx.log.debug({ err: errorMessage(error) }, "a pat could not be paid");
        });
      },
      changed: (pats, patted, touch) => state.setPats(pats, patted, touch),
      touched: (touch) =>
        ctx.publish(customEvent(LIVE_TOUCH_TOPIC, { x: touch.x, y: touch.y, part: touch.part })),
    });
    const state = new LiveState(
      {
        channels: config.channels,
        screen,
        maxViewers: config.max_viewers,
        pats: desk.pats(),
        video: { on: false, src: null },
      },
      now,
    );
    const body = () => state.setPresence(ctx.services.get(ActivityManagerKey)?.snapshot() ?? null);

    const videoConfig = config.video;
    // Without the secret MediaMTX's HLS wants cookies, which a proxy cannot carry: stay off.
    const videoOn = videoConfig.enabled && videoConfig.secret !== "";
    if (videoConfig.enabled && !videoOn) {
      ctx.log.warn(
        "live page: video.enabled needs video.secret (MIYORIA_HLS_SECRET); video stays off",
      );
    }
    const watch = new VideoWatch({
      config: videoConfig,
      fetch: this.#fetch,
      changed: (video) => state.setVideo(video),
      note: (on, reason) =>
        ctx.log.info({ reason }, on ? "live page: OBS is publishing" : "live page: OBS stopped"),
    });
    const feed: LiveFeed = {
      snapshot: () => state.snapshot(),
      follow: (listener) => state.follow(listener),
      pat: (by) => desk.pat(by),
      video: () =>
        videoOn
          ? {
              on: watch.on,
              upstream: videoConfig.hls,
              secret: videoConfig.secret,
              max_viewers: config.max_viewers,
            }
          : null,
    };
    ctx.provide(LiveFeedKey, feed);
    if (config.channels.length === 0) {
      ctx.log.info("live page: no channels listed, so it shows none of her words");
    }
    if (config.pats) ctx.log.info({ salience: config.pat_salience }, "live page: pats are on");

    await refreshNames();
    body();
    const events = ctx.subscribe([...LIVE_TOPICS, ACTIVITY_CHANGED_TOPIC]);
    ctx.spawn("feed", async () => {
      for await (const env of events) {
        if (env.event.type === "custom" && env.event.data.topic === ACTIVITY_CHANGED_TOPIC) {
          body();
          continue;
        }
        state.onEvent(env.event, now());
      }
    });
    if (videoOn) {
      ctx.log.info({ hls: videoConfig.hls }, "live page: video is on, watching MediaMTX");
      ctx.spawn("video", async (signal) => {
        await watch.poll(signal);
        for await (const _ of interval(videoConfig.poll_ms, signal)) await watch.poll(signal);
      });
    }
    ctx.spawn("tick", async (signal) => {
      for await (const _ of interval(TICK_MS, signal)) {
        state.tick(now());
        desk.tick();
        if (names === null || now() - names.at >= NAMES_EVERY_MS) await refreshNames();
      }
    });
  }
}
