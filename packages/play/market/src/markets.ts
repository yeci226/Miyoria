// The market of every Space (docs/design/v5-places.md, phase 6): one `MarketService` per Space she
// is in, each with that Space's settings (`PlaceConfig`, read at each use, so a Space's change
// applies without a restart) and its own rows (`MarketStore.forSpace`), and one more that is
// everyone's: the song priority ticket, whose price and daily limit are the same everywhere.
//
// * A Space runs an auction only with an auction channel in that Space (`PlaceConfig` drops a
//   channel that is in another Space), and a lottery: a Space with a lottery channel of its own,
//   and the primary without one only while the cluster names no channel at all (the one server of
//   before, set up without a channel). So a server where nobody set the market up runs nothing,
//   and a cluster channel that is in one server runs the lottery there only, not also, channel-less,
//   in the primary: two servers she was already in never both run the one lottery of before.
// * A Space she left keeps its rows; a lot or a draw of it that is not settled yet is settled with
//   both off (every hold and ticket goes back), and nothing new opens there.
// * Rows from before there was any Space go to the primary Space once there is one (`adopt`).
// * Without identity's `Places` (a store without Core's services) there is one market for
//   everything, the one server of before phase 6.

import { errorMessage } from "@miyoria/runtime/kernel";
import type { ContextKey, PlaceConfig, Places, SongPriority, SpaceRef } from "@miyoria/types";
import { lotteryChannel, type MarketConfig } from "./config.js";
import type { CommandReplyLike } from "./notices.js";
import { type MarketDeps, MarketService } from "./service.js";
import type { MarketStore } from "./store.js";

/** What `MarketKey` provides: the market of a Space. */
export interface Markets {
  /**
   * The market of `space` (identity's `spaces.id`); without one, the primary Space's (else the
   * first she is in). `null` when that Space is not one she is in, or she is in none.
   */
  of(space?: string | null): MarketService | null;
  /** The market of where a command was used: its Space; a DM's is the primary's. */
  at(context: ContextKey | null): MarketService | null;
  /** The song priority ticket, the same in every Space. */
  readonly songPriority: SongPriority;
}

/** What every market shares; the registry adds the config, the rows and where to post. */
export type SharedMarketDeps = Omit<
  MarketDeps,
  "config" | "store" | "secondary" | "trades" | "songs" | "post"
>;

export interface MarketRegistryOptions {
  shared: SharedMarketDeps;
  /** The tables, every row (the registry takes each Space's view of them). */
  store: MarketStore;
  /** `[modules.market]` per place. */
  config: PlaceConfig<MarketConfig>;
  /** Identity's Spaces; `null`: one market for everything. */
  places: Places | null;
  /** Posts a notice in a channel of `space` (`null`: the one server of before phase 6). */
  post: (
    space: SpaceRef | null,
    channel: string,
    reply: CommandReplyLike,
  ) => Promise<string | null>;
}

export class MarketRegistry implements Markets {
  readonly #o: MarketRegistryOptions;
  readonly #bySpace = new Map<string, MarketService>();
  /** The song priority tickets (and, without `Places`, the whole market). */
  readonly #common: MarketService;
  /** The rows with no Space were given to the primary. */
  #adopted = false;

  constructor(options: MarketRegistryOptions) {
    this.#o = options;
    const single = options.places === null;
    this.#common = new MarketService({
      ...options.shared,
      config: () => options.config.base(),
      store: options.store,
      trades: single,
      songs: true,
      post: (channel, reply) => options.post(null, channel, reply),
    });
  }

  get songPriority(): SongPriority {
    return this.#common.songPriority;
  }

  of(space?: string | null): MarketService | null {
    const places = this.#o.places;
    if (places === null) return this.#common;
    const id = space ?? places.primary()?.id ?? places.spaces()[0]?.id ?? null;
    if (id === null) return null;
    const ref = places.space(id);
    return ref === null ? null : this.#market(ref);
  }

  at(context: ContextKey | null): MarketService | null {
    const places = this.#o.places;
    if (places === null) return this.#common;
    if (context === null || context.scope === null) return this.of(null);
    const space =
      places.at(context)?.space_id ?? places.ofGuild(context.platform, context.scope)?.id;
    return space == null ? null : this.of(space);
  }

  /** The market of an active Space, made on first use. */
  #market(space: SpaceRef): MarketService {
    const found = this.#bySpace.get(space.id);
    if (found !== undefined) return found;
    const made = this.#make(space, () => this.#o.config.for({ space_id: space.id }));
    this.#bySpace.set(space.id, made);
    return made;
  }

  #make(space: SpaceRef, config: () => MarketConfig): MarketService {
    return new MarketService({
      ...this.#o.shared,
      config,
      store: this.#o.store.forSpace(space.id),
      // The default Space keeps a channel-less lottery only when the cluster set no channel.
      secondary: !space.primary || lotteryChannel(this.#o.config.base()) !== "",
      trades: true,
      songs: false,
      post: (channel, reply) => this.#o.post(space, channel, reply),
    });
  }

  /**
   * One pass of every market: each Space she is in, each Space she left with something not
   * settled (with the auction and the lottery off), then the song priority tickets.
   */
  async tick(signal?: AbortSignal): Promise<void> {
    const places = this.#o.places;
    if (places !== null) {
      this.#adopt(places);
      const active = places.spaces();
      for (const space of active) {
        if (signal?.aborted) return;
        await this.#market(space).tick(signal);
      }
      const known = new Set(active.map((s) => s.id));
      for (const id of this.#o.store.unsettledSpaces()) {
        if (known.has(id) || signal?.aborted) continue;
        await this.#closing(id).tick(signal);
      }
    }
    await this.#common.tick(signal);
  }

  /**
   * The market of a Space she left: whatever is open there is settled with both off, and nothing
   * is posted (she is no longer there to post in).
   */
  #closing(id: string): MarketService {
    this.#bySpace.delete(id);
    const off = (): MarketConfig => ({
      ...this.#o.config.base(),
      auction: false,
      lottery: false,
      auction_channel: "",
      lottery_channel: "",
    });
    return new MarketService({
      ...this.#o.shared,
      config: off,
      store: this.#o.store.forSpace(id),
      secondary: true,
      trades: true,
      songs: false,
      post: async () => null,
    });
  }

  #adopt(places: Places): void {
    if (this.#adopted) return;
    const primary = places.primary();
    if (primary === null) return;
    try {
      const moved = this.#o.store.adopt(primary.id);
      if (moved > 0) {
        this.#o.shared.log.info(
          { rows: moved, space: primary.id },
          "market: rows given to the primary Space",
        );
      }
      this.#adopted = true;
    } catch (error) {
      this.#o.shared.log.warn(
        { err: errorMessage(error) },
        "market: cannot give rows to the primary Space",
      );
    }
  }
}
