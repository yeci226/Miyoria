// The song priority ticket's own rows (`market_song_tickets`): each charge is kept from before the
// wallet is asked until its song is sung or the coins went back, and the pass gives back a ticket
// that is neither used nor held by the singer's set list after the grace period. Each window the
// singer alone could lose a ticket in is played through a restart.

import { describe, expect, it } from "vitest";
import { SONG_TICKET_GRACE_MS } from "../src/service.js";
import { ALICE, BOB, MIN, rig, T0 } from "./rig.js";

async function priced() {
  const r = await rig({ lottery: false, auction: false });
  r.wallet.fund(ALICE, 200);
  return r;
}

type R = Awaited<ReturnType<typeof priced>>;

const refunds = (r: R) => r.wallet.rows.filter((x) => x.reason === "song_priority_refund").length;
const status = (r: R, key: string) => r.store.songTicket(key)?.status ?? null;
/** Past the grace period of a charge made at `T0`. */
const LATER = T0 + SONG_TICKET_GRACE_MS + MIN;

describe("a song priority ticket's row", () => {
  it("is written before the wallet is asked: charged, void when refused, charging when cut", async () => {
    const r = await priced();
    const p = r.service.songPriority;
    expect((await p.charge(ALICE, "song:a", "s")).ok).toBe(true);
    expect(r.store.songTicket("song:a")).toMatchObject({
      person: "p-alice",
      account: ALICE,
      amount: 40,
      status: "charged",
      settled_at: null,
    });
    expect((await p.charge(BOB, "song:b", "s")).ok).toBe(false);
    expect(status(r, "song:b")).toBe("void");
    // The Core stopped right after the ledger row: the row says the wallet was being asked.
    r.wallet.throwAfterCharge = true;
    await expect(p.charge(ALICE, "song:c", "s")).rejects.toThrow();
    expect(status(r, "song:c")).toBe("charging");
  });
});

describe("the pass gives back a ticket no song holds", () => {
  it("charged just before a stop, before the set list was saved", async () => {
    const r = await priced();
    expect((await r.service.songPriority.charge(ALICE, "song:a", "s")).ok).toBe(true);
    // A new process: the singer's stored list never had the song.
    r.restart();
    r.songs.read = false;
    r.clock.at = LATER;
    await r.service.tick();
    // Until the singer read its list back, it cannot tell: nothing is decided.
    expect(refunds(r)).toBe(0);
    r.songs.read = true;
    r.clock.at = T0 + SONG_TICKET_GRACE_MS - MIN;
    await r.service.tick();
    // Within the grace period a request may still be on its way to the list.
    expect(refunds(r)).toBe(0);
    r.clock.at = LATER;
    await r.service.tick();
    expect(refunds(r)).toBe(1);
    expect(r.wallet.balanceOf("p-alice")).toBe(200);
    expect(r.store.songTicket("song:a")).toMatchObject({ status: "refunded" });
    await r.service.tick();
    expect(refunds(r)).toBe(1);
  });

  it("whose refund failed between the charge and adding the song", async () => {
    const r = await priced();
    const p = r.service.songPriority;
    expect((await p.charge(ALICE, "song:a", "s")).ok).toBe(true);
    // The song could not be listed and the singer's refund did not go: nothing kept it.
    r.walletGone = true;
    await expect(p.refund(ALICE, "song:a")).rejects.toThrow();
    expect(status(r, "song:a")).toBe("charged");
    // Cut right after the ledger row too.
    r.walletGone = false;
    r.wallet.throwAfterCharge = true;
    await expect(p.charge(ALICE, "song:b", "s")).rejects.toThrow();
    r.wallet.throwAfterCharge = false;
    r.restart();
    r.clock.at = LATER;
    await r.service.tick();
    expect(refunds(r)).toBe(2);
    expect([status(r, "song:a"), status(r, "song:b")]).toEqual(["refunded", "refunded"]);
    expect(r.wallet.balanceOf("p-alice")).toBe(200);
  });

  it("of a song that ended unsung and left the history with its refund due", async () => {
    const r = await priced();
    const p = r.service.songPriority;
    expect((await p.charge(ALICE, "song:a", "s")).ok).toBe(true);
    r.songs.held.add("song:a");
    r.clock.at = LATER;
    await r.service.tick();
    // Listed and waiting: it is the song's.
    expect(refunds(r)).toBe(0);
    // It failed, its refund did not go, and it was trimmed from the history; then a restart.
    r.songs.held.delete("song:a");
    r.restart();
    await r.service.tick();
    expect(refunds(r)).toBe(1);
    // The singer's own retry later gives back nothing more.
    expect(await r.service.songPriority.refund(ALICE, "song:a")).toBe(0);
    expect(refunds(r)).toBe(1);
  });
});

describe("a ticket that is not given back", () => {
  it("is the one whose song started being sung, wherever the song went after", async () => {
    const r = await priced();
    const p = r.service.songPriority;
    expect((await p.charge(ALICE, "song:a", "s")).ok).toBe(true);
    r.songs.held.add("song:a");
    p.consume("song:a");
    expect(r.store.songTicket("song:a")).toMatchObject({ status: "consumed" });
    // Sung, then trimmed from the history, then a restart: still used.
    r.songs.held.delete("song:a");
    r.restart();
    r.clock.at = LATER;
    await r.service.tick();
    expect(refunds(r)).toBe(0);
    // A key from before the table, or one given back already, is left as it is.
    p.consume("song:old");
    expect(r.store.songTicket("song:old")).toBeNull();
  });

  it("is any while the singer is not running", async () => {
    const r = await priced();
    expect((await r.service.songPriority.charge(ALICE, "song:a", "s")).ok).toBe(true);
    r.songsGone = true;
    r.clock.at = LATER;
    await r.service.tick();
    expect(refunds(r)).toBe(0);
    expect(status(r, "song:a")).toBe("charged");
    r.songsGone = false;
    await r.service.tick();
    expect(refunds(r)).toBe(1);
  });
});
