// Module `exchange` (docs/design/exchange.md): the owner of the `exchange` plugin's tables. It
// puts `[modules.exchange]` in force and provides `ExchangeKey` (`ExchangeService`: the market,
// accounts, orders, portfolios, the boards and the owner's hand). Coins go through
// `ExchangeWalletKey`, which the economy provides; without it nothing that costs anything goes
// through, and nothing is paid out until it is back.
//
// v1: paper trading of real Taiwan and US stocks (quoted by Yahoo Finance) and the five local stocks
// tied to her, with fish coins, the house as counterparty. One pass at start and every poll: quotes
// of what is held, ordered or viewed are fetched, waiting orders fill, margins are checked, the
// wallets are paid; a member's notices go to them by DM (`ReplySink.sendDirect`, a neutral card with
// the small print; their page has them too). The market is off until the owner turns `open` on.
//
// The local stocks' signals (`real/signals.ts`) are built here from the event log
// (`real/sources.ts`): each company's module is looked up by a service key it provides (the
// economy's wallet, the song tickets, the delivery ledger, the game's resume, the model router), so
// nothing here imports another module. Whether a source is there is asked when the first signal is
// computed (the modules may start in any order), and again for each day; one that is missing is a
// neutral open and one log line. She hears her companies' opens as a quiet note of facts (escaped
// data, no names).

import { CommandMount, ReplySinkKey } from "@miyoria/commands";
import { heartTables, labelOf, PeopleDirectoryKey } from "@miyoria/heart/person";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleCard,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { AuditLogKey, PeopleStoreKey, type Store, StoreKey } from "@miyoria/store";
import {
  AuthorizerKey,
  BOND_LADDER,
  CharacterKey,
  type Clock,
  CurrencyKey,
  DEFAULT_CHARACTER,
  DEFAULT_CURRENCY,
  DeliveryLedgerKey,
  EventLogKey,
  ExchangeWalletKey,
  GameResumeKey,
  isOwnerAccount,
  newId,
  type PersonId,
  PicturesKey,
  PlacesKey,
  SongTicketsKey,
  serviceKey,
  toTimestamp,
} from "@miyoria/types";
import { card, registerCommands, unregisterCommands } from "./commands.js";
import { type ExchangeConfig, ExchangeConfigSchema, localCompaniesOf } from "./config.js";
import { HER_RULES, herNote } from "./her.js";
import { checkLocalCodes } from "./real/codes.js";
import { taipeiDay } from "./real/local.js";
import { HttpJsonProvider, type QuoteProvider } from "./real/provider.js";
import { LocalSignalBook, type LocalSources } from "./real/signals.js";
import { DEFAULT_KEEPING, eventLogSources } from "./real/sources.js";
import { YahooProvider } from "./real/yahoo.js";
import { ExchangeService, type Traders } from "./service.js";
import { exchangeTables } from "./store.js";

export const ExchangeKey = serviceKey<ExchangeService>("Exchange");

/** How often the pass runs. */
export const TICK_MS = 30_000;
const DAY_MS = 86_400_000;
/** The panel's write node: someone holding it sees what the panel shows and never trades. */
const INSIDER_NODE = "admin.panel.write";

export interface ExchangeModuleOptions {
  clock?: Clock;
  tickMs?: number;
  /** The seed of a new market (tests). */
  seed?: string;
  /** Quote providers in place of the configured ones (tests). */
  providers?: ReadonlyMap<string, QuoteProvider>;
  /** The local stocks' count sources in place of the event log's (tests). */
  sources?: LocalSources;
  /**
   * Days ambient observations stay whole on the event log (`[modules.facts] fold_after_days`,
   * which Core passes): songs are counted from them.
   */
  ambientDays?: number;
}

export class ExchangeModule implements Module {
  static readonly ID = "exchange";
  readonly manifest = defineManifest(ExchangeModule.ID, "Exchange", {
    icon: "chart-candlestick",
    category: "play",
    description:
      "The deep-sea exchange: paper trading of real Taiwan and US stocks and five local ones with fish coins, the house as counterparty, a daily payout cap, optional 2x with cross margin, the rich list",
    optional: ["economy", "heart", "commands"],
    configSchema: ExchangeConfigSchema,
  });
  readonly #options: ExchangeModuleOptions;
  #mount: CommandMount | null = null;
  #running: { service: ExchangeService; clock: Clock } | null = null;

  constructor(options: ExchangeModuleOptions = {}) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ExchangeConfigSchema);
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: no exchange");
      return;
    }
    const tables = store.plugin(exchangeTables);
    // The local stocks' codes are what their rows are kept under: a renamed code with rows under
    // the old one would leave them behind, so it is refused (docs/design/v5-profiles.md).
    const codes = checkLocalCodes(tables.real, localCompaniesOf(config));
    if (codes.error !== null) throw new Error(codes.error);
    for (const code of codes.stale) {
      tables.real.setInstrument(
        code,
        { status: "removed" },
        (this.#options.clock ?? ctx.clock).now(),
      );
      ctx.log.info({ code }, "exchange: a local code no longer named, never traded: unlisted");
    }
    const heart = store.plugin(heartTables).people;
    const clock = this.#options.clock ?? ctx.clock;
    // The sources are looked up when the first signal is computed, not now: the modules they read
    // (the economy, sing, the game, the model router) may start after this one.
    const book = new LocalSignalBook({
      sources: this.#options.sources ?? this.#sources(ctx, store, config),
      config: () => config,
      // Logged by the stocks' codes, the names the owner knows them by.
      onMissing: (missing) =>
        ctx.log.info(
          {
            missing: Object.fromEntries(
              localCompaniesOf(config)
                .filter((c) => missing[c.role] !== undefined)
                .map((c) => [c.code, missing[c.role]]),
            ),
          },
          "exchange: no source for some local stocks; their opens stay neutral",
        ),
    });
    let names: { at: number; map: Map<string, string> } | null = null;
    const traders: Traders = {
      about: async (account, person) => {
        const people = ctx.services.get(PeopleStoreKey);
        const row = people ? await people.personByAccount(account) : null;
        const since = row ? Date.parse(row.created_at) : clock.now();
        const label = labelOf(heart.get(person));
        const authorizer = ctx.services.get(AuthorizerKey);
        return {
          known_days: Math.max(0, (clock.now() - since) / DAY_MS),
          tier: BOND_LADDER.findIndex((t) => t.label === label),
          insider:
            !config.staff_may_trade &&
            (isOwnerAccount(authorizer, account) ||
              authorizer?.allows(account, INSIDER_NODE) === true),
          self: ctx.services.get(PeopleDirectoryKey)?.isSelf(account) ?? false,
        };
      },
      name: async (person) => {
        if (names === null || clock.now() - names.at > 60_000) {
          const all = (await ctx.services.get(PeopleStoreKey)?.all()) ?? [];
          names = { at: clock.now(), map: new Map(all.map((p) => [p.id, p.display_name])) };
        }
        return names.map.get(person) ?? null;
      },
    };
    const service = new ExchangeService({
      config,
      name: () => exchangeName(ctx),
      currency: () => currencyOf(ctx),
      pronoun: () => pronounOf(ctx),
      store: tables,
      wallet: () => ctx.services.get(ExchangeWalletKey) ?? null,
      traders,
      now: () => clock.now(),
      log: ctx.log,
      dm: (person, text) => dm(ctx, person, text),
      audit: (action, target, detail, by) => {
        void ctx.services
          .get(AuditLogKey)
          ?.append({
            id: newId(),
            at: toTimestamp(clock.now()),
            actor: by,
            action,
            target,
            detail: detail as never,
            ok: true,
          })
          .catch(() => undefined);
      },
      ...(this.#options.seed === undefined ? {} : { seed: this.#options.seed }),
      providers: this.#options.providers ?? providersOf(config),
      signals: book,
    });
    ctx.provide(ExchangeKey, service);
    this.#running = { service, clock };
    this.#mount = new CommandMount(
      "exchange",
      (registry) =>
        registerCommands(
          registry,
          () => service,
          () => ctx.services.get(PicturesKey) ?? null,
          () => exchangeName(ctx),
          () => ctx.services.get(PlacesKey),
          () => currencyOf(ctx),
          () => pronounOf(ctx),
        ),
      unregisterCommands,
    );
    this.#mount.attach(ctx);
    const every = this.#options.tickMs ?? Math.max(10, config.quote_poll_seconds) * 1000;
    let lastNote: string | null = null;
    let lastLocal: string | null = null;
    ctx.spawn("pass", async (signal) => {
      const pass = async () => {
        try {
          await service.tick();
          // What she may know of it: facts of people who did not hide, as a quiet note, when they change.
          const note = await herNote(service);
          if (note !== null && note !== lastNote) {
            lastNote = note;
            tell(ctx, note, "exchange:facts");
          }
          // Her own companies: what moved today's opens, from her day (numbers, never names).
          if (config.local_stocks) {
            const now = clock.now();
            await book.prepare([taipeiDay(now) - 1], now);
            const local = book.herNote((role) => {
              const l = service.real.localCompanies().find((c) => c.role === role);
              return { code: l?.code ?? role, name: l?.name ?? role };
            }, now);
            if (local !== null && local !== lastLocal) {
              lastLocal = local;
              tell(ctx, `你的五家公司今天開盤:${local}。${HER_RULES}`, "exchange:local", {
                writer: "exchange.local",
                untrusted: true,
              });
            }
          }
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "exchange: the pass failed");
        }
      };
      await pass();
      for await (const _ of interval(every, signal)) await pass();
    });
  }

  /** The five sources over the event log, each module found by a key it provides. */
  #sources(ctx: ModuleContext, store: Store, config: ExchangeConfig): LocalSources {
    return eventLogSources({
      events: () => store.events ?? null,
      present: {
        feeding: () => ctx.services.get(ExchangeWalletKey) !== undefined,
        songs: () => ctx.services.get(SongTicketsKey) !== undefined,
        silence: () => ctx.services.get(DeliveryLedgerKey) !== undefined,
        game: () => ctx.services.get(GameResumeKey) !== undefined,
        model: () => ctx.services.get(LlmRouterKey) !== undefined,
      },
      slowMs: () => config.local_signals.slow_call_seconds * 1000,
      keeping: {
        ...DEFAULT_KEEPING,
        ambient: this.#options.ambientDays ?? DEFAULT_KEEPING.ambient,
      },
    });
  }

  async card(): Promise<ModuleCard> {
    const running = this.#running;
    if (running === null) return { facts: [] };
    const v = running.service.real.view();
    const stale = v.sessions.filter((s) => s.stale).map((s) => s.market);
    return {
      facts: [
        { label: "狀態", value: !v.enabled ? "關" : v.house.buys_halted ? "今日停止買進" : "開" },
        { label: "今日淨支出", value: v.house.net_today, unit: v.currency },
        v.house.cap_daily > 0
          ? { label: "上限", value: v.house.cap_daily, unit: v.currency }
          : { label: "上限", value: "不限" },
        { label: "股票", value: v.instruments.length },
        { label: "報價", value: stale.length === 0 ? "正常" : `停滯:${stale.join("、")}` },
      ],
    };
  }

  async stop(): Promise<void> {
    this.#running = null;
    this.#mount?.detach();
    this.#mount = null;
  }
}

/** A neutral card by DM to the person's first account on a platform that can send one. */
/** The exchange's name in this profile (`[character] exchange_name`, docs/design/v5-profiles.md). */
function exchangeName(ctx: ModuleContext): string {
  return ctx.services.get(CharacterKey)?.exchange_name ?? DEFAULT_CHARACTER.exchange_name;
}

/** The coins' name in this profile (`[modules.economy] currency`, provided by Core). */
function currencyOf(ctx: ModuleContext): string {
  return ctx.services.get(CurrencyKey) ?? DEFAULT_CURRENCY;
}

/** How texts name her (`[character] pronoun`). */
function pronounOf(ctx: ModuleContext): string {
  return ctx.services.get(CharacterKey)?.pronoun ?? DEFAULT_CHARACTER.pronoun;
}

async function dm(ctx: ModuleContext, person: PersonId, text: string): Promise<boolean> {
  const sink = ctx.services.get(ReplySinkKey);
  const people = ctx.services.get(PeopleStoreKey);
  if (!sink || !people) return false;
  const all = await people.all();
  const account = all
    .find((p) => p.id === person)
    ?.accounts.find((a) => a.account.platform === sink.platform)?.account;
  if (!account) return false;
  try {
    // Every notice carries the small print; the ones about leverage add its line.
    await sink.sendDirect(
      account,
      card(exchangeName(ctx), [text], {
        real: true,
        leverage: /槓桿|保證金|斷頭|破產/.test(text),
        currency: currencyOf(ctx),
      }),
    );
    return true;
  } catch (error) {
    ctx.log.info({ err: errorMessage(error) }, "exchange: cannot send a DM");
    return false;
  }
}

/** Something she hears about the market (totals only), as a quiet note. */
function tell(
  ctx: ModuleContext,
  summary: string,
  key: string,
  { writer = "exchange", untrusted = false }: { writer?: string; untrusted?: boolean } = {},
): void {
  ctx.services.get(EventLogKey)?.observe(
    {
      source: "exchange",
      silent: true,
      salience: "ambient",
      attention_key: key,
      revision: 1,
      summary,
      addressed_to_her: false,
      from: null,
      context: null,
    },
    {
      buckets: [
        {
          op: "append-self",
          writer,
          owner: ExchangeModule.ID,
          untrusted,
          max_entries: 3,
        },
      ],
    },
  );
}

/** The providers the config names: `yahoo` always, and every JSON endpoint listed. */
export function providersOf(config: ExchangeConfig): Map<string, QuoteProvider> {
  const out = new Map<string, QuoteProvider>();
  out.set("yahoo", new YahooProvider(config.yahoo));
  for (const p of config.providers) out.set(p.id, new HttpJsonProvider(p));
  return out;
}
