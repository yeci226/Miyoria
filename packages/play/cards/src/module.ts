// Module `cards`: the owner of the `cards` plugin's tables. It puts `[modules.cards]` in force and
// provides `CardsKey` (`CardService`), through which a daily card is issued and the odds, the pity,
// the dex and the wishlist are read. Coins go through `CardWalletKey`, which the economy provides;
// without it a card that costs anything is refused. The relationship a card shows is read from the
// heart's row of the person at the time.
//
// It listens to the heart for a bond entering a tier it never reached (`onTierEntered`) and gives a
// milestone card for each such tier (§6.1); her words for it come through `CardFacesKey`. A tier
// entered while this module is not running gets no card later: the cards are never handed out
// backwards. The people who came over from the old records get one keepsake card each instead
// (P5), issued by the api the first time they open their cards with facts only; her line for each
// is written later by a low-priority pass (a few cards every half hour, through `CardFacesKey`,
// only while there is a model and the day's budget is untouched). With `drops` on it watches the
// channels that opted in and now and then drops a card there (§6.2, `drops.ts`); `/me card` routes
// its button. A paid card that was charged and never written, and that nobody retried, gets its
// coins back from a pass over the kept serials at start and every few minutes (`settlePending`).
//
// The routes and the commands are the api's (`KeepsakesKey`, the `cards` route group). Config
// changes reach it the way they reach every module: the supervisor restarts it.

import { type HeartStore, heartTables, type TierEntered } from "@miyoria/heart/person";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleCard,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { type Store, StoreKey } from "@miyoria/store";
import {
  type Clock,
  CurrencyKey,
  DEFAULT_CURRENCY,
  EventLogKey,
  HandleDirectoryKey,
  type PersonId,
  serviceKey,
  toTimestamp,
} from "@miyoria/types";
import { type CardsConfig, CardsConfigSchema } from "./config.js";
import type { Random } from "./draw.js";
import { watchDrops } from "./drops.js";
import { CardFacesKey, type OccasionFace } from "./faces.js";
import { type Live2dPortrait, livePortrait } from "./live2d.js";
import { cardNotes } from "./notes.js";
import { CardPortraitKey } from "./portrait.js";
import { cardRelationship } from "./relationship.js";
import { CardService, dayStart } from "./service.js";
import { type CardStore, cardsTables, type IssuedCard } from "./store.js";
import { CardWalletKey } from "./wallet.js";

export const CardsKey = serviceKey<CardService>("Cards");

/** Her working-context bucket for the cards, and how many notes it keeps. */
const WRITER = "cards";
const MAX_ENTRIES = 6;

const DAY_MS = 86_400_000;

/**
 * A card worth a word (`notes.ts`) as a note she may react to: an observation on the event log,
 * not silent, once per card, in her working context. Names are untrusted.
 */
function tell(ctx: ModuleContext, issued: IssuedCard, cards: CardStore): void {
  const names = new Map(cards.catalogue().map((p) => [p.id, p.name]));
  const lines = cardNotes(issued, names);
  if (lines.length === 0) return;
  const handle = ctx.services.get(HandleDirectoryKey)?.ofPerson(issued.card.person) ?? null;
  ctx.services.get(EventLogKey)?.observe(
    {
      source: "cards.drawn",
      silent: false,
      salience: "notable",
      attention_key: `cards:${issued.card.serial}`,
      revision: 1,
      summary: lines.join("\n"),
      addressed_to_her: false,
      from: handle,
      context: null,
    },
    {
      buckets: [
        {
          op: "append-self",
          writer: WRITER,
          owner: CardsModule.ID,
          untrusted: true,
          max_entries: MAX_ENTRIES,
        },
      ],
      person: handle,
    },
  );
}

export interface CardsModuleOptions {
  /** Replaces the module context's clock (tests). */
  clock?: Clock;
  random?: Random;
  newSerial?: () => string;
  /** How often kept serials are settled after the pass at start; default `SETTLE_EVERY_MS`. */
  settleEveryMs?: number;
  /** How long after start the first pass over keepsake lines runs; default `KEEPSAKE_FIRST_MS`. */
  keepsakeFirstMs?: number;
  /** How often keepsake lines are looked for after that; default `KEEPSAKE_EVERY_MS`. */
  keepsakeEveryMs?: number;
}

/** How often the serials kept for paid cards are looked at again while the module runs. */
export const SETTLE_EVERY_MS = 5 * 60_000;

/**
 * Her line for keepsake cards issued with facts only: a pass this long after start, then every
 * `KEEPSAKE_EVERY_MS`, writing at most `KEEPSAKES_PER_PASS` lines a pass.
 */
export const KEEPSAKE_FIRST_MS = 3 * 60_000;
export const KEEPSAKE_EVERY_MS = 30 * 60_000;
export const KEEPSAKES_PER_PASS = 3;

export class CardsModule implements Module {
  static readonly ID = "cards";
  readonly manifest = defineManifest(CardsModule.ID, "Cards", {
    icon: "layers",
    category: "play",
    description:
      "Her cards for each person: the daily card (paid, at most a few a day), milestone cards for a new tier, cards dropped in a channel (off by default), the public odds, the pity, the dex with series titles, and wishlists",
    optional: ["heart", "economy"],
    configSchema: CardsConfigSchema,
  });
  readonly #options: CardsModuleOptions;
  readonly #pending = new Set<Promise<void>>();
  #stop: (() => void) | null = null;
  #stopped = false;
  #settling: Promise<void> | null = null;
  #settleTimer: ReturnType<typeof setInterval> | null = null;
  #keepsakeTimers: ReturnType<typeof setTimeout>[] = [];
  #writing: Promise<void> | null = null;
  #portrait: Live2dPortrait | null = null;
  /** What the card on the panel reads, while the module runs with a store. */
  #running: {
    cards: CardStore;
    config: CardsConfig;
    clock: Clock;
    /** The coins' name on the panel's card: the profile's (`CurrencyKey`). */
    coin: string;
  } | null = null;

  constructor(options: CardsModuleOptions = {}) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(CardsConfigSchema);
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: no cards");
      return;
    }
    const cards = store.plugin(cardsTables);
    try {
      const copied = cards.importLegacy();
      if (copied > 0)
        ctx.log.info({ copied }, "cards: the old collectibles were copied to the dex");
    } catch (error) {
      ctx.log.warn(
        { err: errorMessage(error) },
        "cards: cannot copy the old collectibles; the next start tries again",
      );
    }
    const heart = store.plugin(heartTables).people;
    const service = new CardService(cards, {
      config,
      clock: this.#options.clock ?? ctx.clock,
      // Looked up at each use: the economy may restart and provide a new one.
      wallet: () => ctx.services.get(CardWalletKey) ?? null,
      relationship: (person) => cardRelationship(heart.get(person)),
      onIssued: (issued) => {
        tell(ctx, issued, cards);
        // Her live picture is drawn now, so the card's page and preview find it ready.
        void this.#portrait?.render(issued.card);
      },
      // Came over from the old records: the heart's migration of the old relationships marks the
      // row (`legacy.migrated_at`), the import from a V4 database the person (`persons.legacy`).
      migrated: (person) =>
        typeof heart.get(person)?.legacy.migrated_at === "string" ||
        cards.importedLegacy(person) !== null,
      // A refund goes back to the person's wallet, so any account of theirs pays it back.
      account: async (person) => (await store.identity.accountsOf(person))[0]?.account ?? null,
      ...(this.#options.random === undefined ? {} : { random: this.#options.random }),
      ...(this.#options.newSerial === undefined ? {} : { newSerial: this.#options.newSerial }),
    });
    ctx.provide(CardsKey, service);
    this.#running = {
      cards,
      config,
      clock: this.#options.clock ?? ctx.clock,
      coin: ctx.services.get(CurrencyKey) ?? DEFAULT_CURRENCY,
    };
    // A paid card charged and never written (Core stopped in between, or the refund failed), that
    // nobody retried: its coins go back now and every few minutes while the module runs. The
    // economy starts in its own order, so a pass without the wallet leaves the row for the next.
    this.#stopped = false;
    const settle = () => {
      if (this.#stopped || this.#settling !== null) return;
      const run = service
        .settlePending()
        .then(() => undefined)
        .catch((error: unknown) => {
          ctx.log.warn(
            { err: errorMessage(error) },
            "cards: cannot settle the kept serials; the next pass tries again",
          );
        })
        .finally(() => {
          this.#settling = null;
        });
      this.#settling = run;
    };
    settle();
    this.#settleTimer = setInterval(settle, this.#options.settleEveryMs ?? SETTLE_EVERY_MS);
    this.#settleTimer.unref?.();
    // Her line for keepsake cards, issued with facts only: low priority, a few a pass, only while
    // the api writes card words, there is a model and the day's model budget is untouched.
    const write = () => {
      if (this.#stopped || this.#writing !== null) return;
      const faces = ctx.services.get(CardFacesKey);
      const router = ctx.services.get(LlmRouterKey);
      if (faces === undefined || router === undefined) return;
      if (router.budgetState() !== "ok") {
        ctx.log.debug(
          { budget: router.budgetState() },
          "cards: keepsake lines wait for the budget",
        );
        return;
      }
      const run = service
        .writeKeepsakeLines(faces, KEEPSAKES_PER_PASS)
        .then(({ written, tried }) => {
          if (tried > 0) ctx.log.info({ written, tried }, "cards: her lines for keepsake cards");
        })
        .catch((error: unknown) => {
          ctx.log.warn(
            { err: errorMessage(error) },
            "cards: cannot write keepsake lines; the next pass tries again",
          );
        })
        .finally(() => {
          this.#writing = null;
        });
      this.#writing = run;
    };
    const first = setTimeout(() => {
      write();
      const every = setInterval(write, this.#options.keepsakeEveryMs ?? KEEPSAKE_EVERY_MS);
      every.unref?.();
      this.#keepsakeTimers.push(every);
    }, this.#options.keepsakeFirstMs ?? KEEPSAKE_FIRST_MS);
    first.unref?.();
    this.#keepsakeTimers.push(first);
    // Her picture on a card from her Live2D model (cards.md §6), when this machine can draw it;
    // without `CardPortraitKey` every card uses the fixed portraits.
    this.#portrait = livePortrait(config, ctx.log);
    if (this.#portrait) ctx.provide(CardPortraitKey, this.#portrait);
    // A bond entering a tier it never reached: one milestone card per tier (§6.1).
    const off = heart.onTierEntered((entered) => {
      const run = milestones(ctx, service, store, heart, entered);
      this.#pending.add(run);
      void run.finally(() => this.#pending.delete(run));
    });
    this.#stop = off;
    // A card dropped in a lively channel that opted in (§6.2), when drops are on.
    const now = () => (this.#options.clock ?? ctx.clock).now();
    watchDrops(ctx, config, cards, this.#options.random ?? Math.random, now);
  }

  /**
   * Today's cards (her local day, `utc_offset_minutes`): issued, the coins their price took, the
   * drops she made and the pity's cards; next, the day's reset at her midnight.
   */
  async card(): Promise<ModuleCard> {
    const running = this.#running;
    if (running === null) return { facts: [] };
    const start = dayStart(running.clock.now(), running.config.utc_offset_minutes);
    const day = running.cards.daySummary(start);
    return {
      facts: [
        { label: "今天發出", value: day.cards, unit: "張" },
        { label: "今天收入", value: day.coins, unit: running.coin },
        { label: "今天掉落", value: day.drops, unit: "次" },
        { label: "保底觸發", value: day.pity, unit: "次" },
      ],
      next: { label: "每日重置", at: toTimestamp(start + DAY_MS) },
    };
  }

  async stop(): Promise<void> {
    this.#running = null;
    this.#stop?.();
    this.#stop = null;
    this.#stopped = true;
    if (this.#settleTimer !== null) clearInterval(this.#settleTimer);
    this.#settleTimer = null;
    // A timeout and an interval are cleared by either call.
    for (const timer of this.#keepsakeTimers.splice(0)) clearInterval(timer);
    const settling = this.#settling === null ? [] : [this.#settling];
    const writing = this.#writing === null ? [] : [this.#writing];
    await Promise.allSettled([...this.#pending, ...settling, ...writing]);
    await this.#portrait?.close();
    this.#portrait = null;
  }
}

/**
 * The milestone cards of `entered`, lowest tier first. Her words come from `CardFacesKey` (the api
 * module's) when it runs; without it the card carries the person's name and nothing she wrote.
 * Failures are logged: the heart's write is long committed.
 */
async function milestones(
  ctx: ModuleContext,
  service: CardService,
  store: Store,
  heart: HeartStore,
  entered: TierEntered,
): Promise<void> {
  const { person } = entered;
  for (const tier of entered.tiers) {
    try {
      const result = await service.issueMilestone(person, tier, async () => {
        const anchor = heart
          .get(person)
          ?.anchors.find((a) => a.tier === tier.min && a.by !== "migrate" && a.quote !== "");
        const faces = ctx.services.get(CardFacesKey);
        if (faces !== undefined) {
          return faces.face(person, {
            kind: "milestone",
            tier: tier.label,
            scene: anchor?.quote ?? null,
          });
        }
        return plainFace(store, heart, service, person);
      });
      if (!result.ok) {
        ctx.log.info(
          { person, tier: tier.label, reason: result.reason },
          "cards: no milestone card",
        );
      }
    } catch (error) {
      ctx.log.warn(
        { person, tier: tier.label, err: errorMessage(error) },
        "cards: cannot issue a milestone card",
      );
    }
  }
}

/** A card's face without the api: their name, nothing she wrote; `null` without an account. */
async function plainFace(
  store: Store,
  heart: HeartStore,
  service: CardService,
  person: PersonId,
): Promise<OccasionFace | null> {
  const [account] = await store.identity.accountsOf(person);
  if (account === undefined) return null;
  return {
    face: {
      name: account.display_name,
      avatar_url: null,
      call_name: null,
      line: null,
      stamp: null,
      fields: [],
      number: service.count(person) + 1,
    },
    // Her line for them only ever goes on a card through the api's screen.
    relationship: { ...cardRelationship(heart.get(person)), public_feeling: null },
  };
}
