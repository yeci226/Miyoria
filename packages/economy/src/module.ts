import { CommandRegistryKey } from "@miyoria/commands";
import { actuatorsFor } from "@miyoria/gate/actions";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleCard,
  type ModuleCardAction,
  type ModuleCardFact,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { StoreKey } from "@miyoria/store";
import {
  CardWalletKey,
  Events,
  ExchangeWalletKey,
  KaraokeWalletKey,
  MarketWalletKey,
  ParticipationKey,
  PartyOutcomesKey,
  PartyRewardsKey,
  type Principal,
  type ProfileId,
} from "@miyoria/types";
import { agencyCapabilities } from "./agency-tools.js";
import { EconomyCardWallet } from "./card-wallet.js";
import { EconomyCommands } from "./commands.js";
import { EconomyConfigSchema } from "./config.js";
import { Earnings } from "./earn.js";
import { EconomyService } from "./economy.js";
import { EconomyExchangeWallet } from "./exchange-wallet.js";
import { giftTables } from "./gift-tables.js";
import { answerGiftCapability } from "./gift-tools.js";
import { FreeGiftsKey, GiftDesk } from "./gifts.js";
import { EconomyKaraokeWallet } from "./karaoke-wallet.js";
import { EconomyMarketWallet } from "./market-wallet.js";
import { WATCHED_TOPICS } from "./prediction-watch.js";
import { giveCapability, speakerCapabilities } from "./tools.js";
import { EconomyKey } from "./types.js";
import { v2Capabilities } from "./v2-tools.js";
import { Economy2Key } from "./v2-types.js";

/** How often a finished voice window is paid when nobody speaks to end it. */
const VOICE_TICK_MS = 30_000;
/** How often gift quotes and unanswered gifts are settled. */
const GIFT_TICK_MS = 15_000;
/** How often danmaku left in the middle are settled and her note is due. */
const DANMAKU_TICK_MS = 5_000;
/** The card's action that takes every danmaku line off the overlay. */
export const CLEAR_DANMAKU = "danmaku_clear";
const CLEAR_DANMAKU_ACTION: ModuleCardAction = {
  id: CLEAR_DANMAKU,
  label: "清空彈幕",
  confirm: "畫面上的彈幕會全部拿掉,還在排隊、沒顯示的會退回。要清空嗎?",
};

/**
 * Module `economy` (docs/design/economy.md): coins people earn by being with her and spend on
 * feeding her and small gifts. Provides `EconomyKey` (the member routes and the Discord commands
 * use it) and registers `economy.give` (her tool `give_coins`) and the speaker's own
 * `economy.accept_food` / `economy.checkin` / `economy.look` and her own money's tools
 * (`economy.treat`, `buy_self`, `post_bounty`, `award_bounty`,
 * `cancel_bounty`; agency-tools.ts, purse.ts, bounties.ts). Also provides `Participation`
 * (the web page's head-pats), `PartyRewards` (party games, party.ts) and `PartyOutcomes` (how a
 * game came out, for the predictions that settle by themselves, prediction-watch.ts). Uses `EconomyDocs` (bets,
 * her room) and `LedgerStats` (the health table) when the app provides them, and `CoinLedgerStore`,
 * `RelationshipEffects` (a hair of affinity per gift), `PersonNoteWriter`, `Directives`,
 * `PeopleStore`, `SocialSignals` / `AffectState` (who is blocked), `SelfState` (her hunger),
 * `Singer`, `CommandRegistry`, `ActuatorRegistry` (`stage.expression`), `Moderation` and `EventLog` when present.
 */
export class EconomyModule implements Module {
  static readonly ID = "economy";
  readonly manifest = defineManifest(EconomyModule.ID, "Economy", {
    icon: "coins",
    category: "play",
    description: "Coins earned by being with her, spent on feeding her and small gifts",
    optional: [
      "memory",
      "facts",
      "moderation",
      "actions",
      "heart",
      "self",
      "sing",
      "stage.link",
      "commands",
    ],
    configSchema: EconomyConfigSchema,
  });
  readonly #profile: ProfileId;
  #unregister: (() => void) | null = null;
  readonly #commands = new EconomyCommands();
  /** The running economy, for the card on the panel. */
  #economy: EconomyService | null = null;

  constructor(profile: ProfileId) {
    this.#profile = profile;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(EconomyConfigSchema);
    const economy = new EconomyService({
      config,
      services: ctx.services,
      profile: this.#profile,
      clock: ctx.clock,
      publish: ctx.publisher,
      log: ctx.log,
    });
    const earnings = new Earnings(economy, config, ctx.services, ctx.log);
    const actuators = actuatorsFor(ctx);
    const off = [
      giveCapability(economy, ctx.services),
      ...speakerCapabilities(economy, ctx.clock),
      ...agencyCapabilities(economy),
      ...v2Capabilities(economy),
    ].map((capability) => actuators.register(capability));
    this.#unregister = () => {
      for (const f of off) f();
    };
    ctx.provide(EconomyKey, economy);
    this.#economy = economy;
    // Gifts named in words (gifts.ts): their own tables, her answer, the sweep below.
    const store = ctx.services.get(StoreKey);
    const gifts = new GiftDesk(economy, () => store?.plugin(giftTables) ?? null);
    ctx.provide(FreeGiftsKey, gifts);
    off.push(actuators.register(answerGiftCapability(economy, gifts)));
    // Her cards are paid through it (`@miyoria/play/cards`).
    ctx.provide(CardWalletKey, new EconomyCardWallet(economy));
    // The weekly market is paid through it (`@miyoria/play/market`).
    ctx.provide(MarketWalletKey, new EconomyMarketWallet(economy));
    // The deep-sea exchange is paid through it (`@miyoria/play/exchange`).
    ctx.provide(ExchangeWalletKey, new EconomyExchangeWallet(economy));
    // Karaoke rooms are paid through it (`@miyoria/play/karaoke`).
    ctx.provide(KaraokeWalletKey, new EconomyKaraokeWallet(economy));
    ctx.provide(ParticipationKey, economy.v2.play);
    ctx.provide(Economy2Key, economy.v2);
    ctx.provide(PartyRewardsKey, economy.v2.party);
    // How a party game came out settles the predictions bound to it (prediction-watch.ts).
    ctx.provide(PartyOutcomesKey, economy.v2.prediction.watch);
    if (!economy.docsAreDurable) {
      ctx.log.warn("no store provides EconomyDocs: bets and the room are kept in memory only");
    }
    const mount = () => {
      const registry = ctx.services.get(CommandRegistryKey);
      if (registry) this.#commands.install(registry, ctx.services);
    };
    mount();

    const events = ctx.subscribe([
      Events.PlatformReady.type,
      Events.PlatformMessageCreated.type,
      Events.VoiceJoined.type,
      Events.VoiceParticipants.type,
      Events.VoiceLeft.type,
      Events.VoiceUtteranceEvent.type,
      Events.SingCue.type,
    ]);
    ctx.spawn("earn", async () => {
      for await (const env of events) await earnings.onEvent(env, ctx.clock.now());
    });
    // Her game goals settle the predictions bound to them (prediction-watch.ts).
    const games = ctx.subscribe([...WATCHED_TOPICS]);
    ctx.spawn("predictions", async () => {
      for await (const env of games) await economy.v2.prediction.watch.onEvent(env);
    });
    // Her bounties run out here; her purse note is written once at the start.
    ctx.spawn("agency", async (signal) => {
      await economy.purse.refresh().catch((error: unknown) => {
        ctx.log.warn({ err: errorMessage(error) }, "cannot write her purse note");
      });
      for await (const _ of interval(Math.max(config.agency_sweep_s, 1) * 1000, signal)) {
        try {
          await economy.bountyDesk.sweep();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "the bounty sweep failed");
        }
        try {
          await economy.v2.sweep();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "the economy 2.0 sweep failed");
        }
      }
    });
    // Gift quotes that ran out, gifts she did not answer in time, forgotten givers' gifts.
    ctx.spawn("gifts", async (signal) => {
      for await (const _ of interval(GIFT_TICK_MS, signal)) {
        try {
          await gifts.sweep();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "the gift sweep failed");
        }
      }
    });
    ctx.spawn("voice", async (signal) => {
      for await (const _ of interval(VOICE_TICK_MS, signal)) {
        await earnings.settleVoice(ctx.clock.now());
        mount(); // the commands module may have been restarted with a new registry
      }
    });
    // Danmaku (danmaku.ts): the stage's answers settle the charges; her broadcast ending clears the
    // overlay; what a restart left in the middle is settled at once and then every few seconds,
    // and she gets her note of the lines shown.
    const danmaku = economy.danmakuDesk;
    const stage = ctx.subscribe([
      Events.StageDanmaku.type,
      Events.StageStatus.type,
      Events.ActivityChanged.type,
    ]);
    ctx.spawn("danmaku", async () => {
      for await (const env of stage) await danmaku.onEvent(env);
    });
    ctx.spawn("danmaku-tick", async (signal) => {
      const tick = async () => {
        try {
          await danmaku.sweep(ctx.clock.now());
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "the danmaku sweep failed");
        }
        danmaku.note(ctx.clock.now());
      };
      await tick();
      for await (const _ of interval(DANMAKU_TICK_MS, signal)) await tick();
    });
  }

  /**
   * The health table's numbers (`health.ts`): the last seven days' recovery rate, and today's
   * coins issued and recovered, in the economy's currency; none without a store of ledger totals.
   * Next: the first of her open bounties to run out, which the sweep then settles.
   */
  async card(): Promise<ModuleCard> {
    const economy = this.#economy;
    if (economy === null) return { facts: [] };
    const currency = economy.config.currency;
    const facts: ModuleCardFact[] = [];
    const health = await economy.v2.health();
    if (health.available) {
      const today = health.days.at(-1);
      if (health.week.ratio !== null) {
        facts.push({ label: "七天回收率", value: Math.round(health.week.ratio * 100), unit: "%" });
      }
      facts.push({ label: "今天發出", value: today?.issued ?? 0, unit: currency });
      facts.push({ label: "今天收回", value: today?.recovered ?? 0, unit: currency });
    }
    // Danmaku shown today and what they took (lines given back are neither), while they are on.
    const danmakuOn = economy.config.danmaku_on;
    if (danmakuOn) {
      const today = await economy.danmakuDesk.today();
      facts.push({
        label: "今天彈幕",
        value: `${today.lines} 則 · ${today.coins}`,
        unit: currency,
      });
    }
    const due = (await economy.bountyDesk.view())
      .map((b) => b.expires_at)
      .sort()
      .at(0);
    return {
      facts,
      ...(due === undefined ? {} : { next: { label: "懸賞到期", at: due } }),
      ...(danmakuOn ? { actions: [CLEAR_DANMAKU_ACTION] } : {}),
    };
  }

  /** `danmaku_clear`: every danmaku line off the overlay (the waiting ones are given back). */
  async act(action: string, _by: Principal): Promise<void> {
    if (action !== CLEAR_DANMAKU) throw new Error(`unknown action ${action}`);
    const economy = this.#economy;
    if (economy === null) throw new Error("the economy is not running");
    economy.danmakuDesk.clear();
  }

  async stop(): Promise<void> {
    this.#economy = null;
    this.#commands.uninstall();
    this.#unregister?.();
    this.#unregister = null;
  }
}
