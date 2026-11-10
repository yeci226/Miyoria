import { actuatorsFor } from "@miyoria/actions";
import { CommandRegistryKey } from "@miyoria/commands";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleContext,
} from "@miyoria/kernel";
import { SongPaymentsKey } from "@miyoria/sing";
import { ParticipationKey, PartyRewardsKey, type ProfileId, SONG_TOPIC } from "@miyoria/types";
import { agencyCapabilities } from "./agency-tools.js";
import { EconomyCommands } from "./commands.js";
import { EconomyConfigSchema } from "./config.js";
import { Earnings } from "./earn.js";
import { EconomyService } from "./economy.js";
import { songPayments } from "./songs.js";
import { giveCapability, speakerCapabilities } from "./tools.js";
import { EconomyKey } from "./types.js";
import { v2Capabilities } from "./v2-tools.js";
import { Economy2Key } from "./v2-types.js";

/** How often a finished voice window is paid when nobody speaks to end it. */
const VOICE_TICK_MS = 30_000;

/**
 * Module `economy` (docs/design/economy.md): coins people earn by being with her and spend on
 * feeding her and small gifts. Provides `EconomyKey` (the member routes and the Discord commands
 * use it) and registers `economy.give` (her tool `give_coins`) and the speaker's own
 * `economy.accept_food` / `economy.checkin` / `economy.look` and her deals `economy.make_deal` /
 * `economy.deal_done` / `economy.cancel_deal` (tools.ts, deals.ts), and her own money's tools
 * (`economy.treat`, `buy_self`, `propose_goal`, `cancel_goal`, `post_bounty`, `award_bounty`,
 * `cancel_bounty`; agency-tools.ts, purse.ts, goals.ts, bounties.ts). Also provides `Participation`
 * (the web page's head-pats) and `PartyRewards` (party games, party.ts). Uses `EconomyDocs` (collection,
 * bets, commissions, her room) and `LedgerStats` (the health table) when the app provides them, and `CoinLedgerStore`,
 * `DealStore`, `RelationshipEffects` (a hair of affinity per gift), `PersonNoteWriter`, `Directives`,
 * `PeopleStore`, `SocialSignals` / `AffectState` (who is blocked), `SelfState` (her hunger),
 * `Singer`, `CommandRegistry`, `ActuatorRegistry` (`stage.expression`), `Moderation` and `EventLog` when present.
 */
export class EconomyModule implements Module {
  static readonly ID = "economy";
  readonly manifest = defineManifest(EconomyModule.ID, "Economy", {
    description: "Coins earned by being with her, spent on feeding her and small gifts",
    optional: [
      "memory",
      "facts",
      "moderation",
      "actions",
      "social",
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
      publish: (event) => ctx.publish(event),
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
    ctx.provide(ParticipationKey, economy.v2.play);
    ctx.provide(Economy2Key, economy.v2);
    ctx.provide(PartyRewardsKey, economy.v2.party);
    if (!economy.docsAreDurable) {
      ctx.log.warn(
        "no store provides EconomyDocs: collection, bets, commissions and the room are kept in memory only",
      );
    }
    ctx.provide(SongPaymentsKey, songPayments(economy));
    const mount = () => {
      const registry = ctx.services.get(CommandRegistryKey);
      if (registry) this.#commands.install(registry, ctx.services);
    };
    mount();

    const events = ctx.subscribe([
      "platform.ready",
      "platform.message.created",
      "voice.joined",
      "voice.participants",
      "voice.left",
      "voice.utterance",
      SONG_TOPIC,
    ]);
    ctx.spawn("earn", async () => {
      for await (const env of events) await earnings.onEvent(env.event, ctx.clock.now());
    });
    // Deals she is owed run out here: a promise not kept becomes broken, escrow times out.
    // Her goals and bounties run out here too; her purse note is written once at the start.
    ctx.spawn("agency", async (signal) => {
      await economy.purse.refresh().catch((error: unknown) => {
        ctx.log.warn({ err: errorMessage(error) }, "cannot write her purse note");
      });
      for await (const _ of interval(Math.max(config.agency_sweep_s, 1) * 1000, signal)) {
        try {
          await economy.goalDesk.sweep();
          await economy.bountyDesk.sweep();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "the goal and bounty sweep failed");
        }
        try {
          await economy.v2.sweep();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "the economy 2.0 sweep failed");
        }
      }
    });
    ctx.spawn("deals", async (signal) => {
      for await (const _ of interval(Math.max(config.deal_sweep_s, 1) * 1000, signal)) {
        try {
          await economy.deals.sweep();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "the deal sweep failed");
        }
      }
    });
    ctx.spawn("voice", async (signal) => {
      for await (const _ of interval(VOICE_TICK_MS, signal)) {
        await earnings.settleVoice(ctx.clock.now());
        mount(); // the commands module may have been restarted with a new registry
      }
    });
  }

  async stop(): Promise<void> {
    this.#commands.uninstall();
    this.#unregister?.();
    this.#unregister = null;
  }
}
