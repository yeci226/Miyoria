import { MemorySettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  type Attitude,
  type Clock,
  type JsonValue,
  type PublishedEvent,
  publishedInto,
  publishedVia,
  type SocialSignals,
} from "@miyoria/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  guessKind,
  type QueueConfig,
  QueueConfigSchema,
  QueueError,
  RequestQueue,
  STATE_KEY,
  STATE_PROFILE,
  type SubmitRequest,
  tallies,
  winnerOption,
} from "../src/index.js";

afterEach(() => {
  vi.useRealTimers();
});

const acct = (id: string): AccountRef => ({ platform: "discord", id });

/** Every call advances 1 ms so items and ballots have distinct times; `advance` jumps further. */
class TestClock implements Clock {
  #ms = 0;
  now(): number {
    return 1_700_000_000_000 + this.#ms++;
  }
  advance(secs: number): void {
    this.#ms += secs * 1000;
  }
}

class FakeSocial implements SocialSignals {
  readonly affinity = new Map<string, number>();
  readonly blocked = new Set<string>();
  attitude(account: AccountRef): Attitude | null {
    const affinity = this.affinity.get(account.id);
    if (affinity === undefined) return null;
    return {
      person: "p",
      affinity,
      trust: 0,
      familiarity: 0,
      blocked: this.blocked.has(account.id),
      label: "",
      call_name: null,
    };
  }
}

function cfg(overrides: Partial<QueueConfig> = {}): QueueConfig {
  return { ...QueueConfigSchema.parse({}), ...overrides };
}

function queueWith(config: QueueConfig, clock: TestClock): RequestQueue {
  return new RequestQueue(config, { clock });
}

function req(who: string, text: string): SubmitRequest {
  return { requester: acct(who), requesterName: `user${who}`, kind: "chat", text };
}

function texts(q: RequestQueue): string[] {
  return q.list().map((i) => i.text);
}

function errorOf(fn: () => unknown): QueueError {
  try {
    fn();
  } catch (error) {
    if (error instanceof QueueError) return error;
    throw error;
  }
  throw new Error("expected a QueueError");
}

describe("RequestQueue ordering", () => {
  it("fair_round_robin_across_requesters", () => {
    const q = queueWith(cfg(), new TestClock());
    q.submit(req("a", "a1"));
    q.submit(req("a", "a2"));
    q.submit(req("b", "b1"));
    q.submit(req("c", "c1"));
    expect(texts(q)).toEqual(["a1", "b1", "c1", "a2"]);

    // A already had a turn: B and C go before A's next one.
    expect(q.next()?.text).toBe("a1");
    q.submit(req("a", "a3"));
    expect(texts(q)).toEqual(["a1", "b1", "c1", "a2", "a3"]);
    expect(q.next()?.text).toBe("b1");
    expect(q.next()?.text).toBe("c1");
    expect(q.next()?.text).toBe("a2");
    expect(q.next()?.text).toBe("a3");
    expect(q.next()).toBeNull();
  });

  it("newcomers_start_level_with_waiting_requesters", () => {
    const q = queueWith(cfg(), new TestClock());
    for (let n = 0; n < 4; n++) {
      q.submit(req("a", `a${n}`));
      q.next();
    }
    // C and B arrive while A (served 4 times) waits.
    q.submit(req("a", "a-next"));
    q.submit(req("c", "c1"));
    q.submit(req("b", "b1"));
    // Newcomers neither queue behind A's served history nor jump ahead of A's older item: they
    // start level with A and age decides.
    expect(q.next()?.text).toBe("a-next");
    expect(q.next()?.text).toBe("c1");
    expect(q.next()?.text).toBe("b1");
  });

  it("per_user_cap_and_validation", () => {
    const q = queueWith(cfg(), new TestClock());
    q.submit(req("a", "1"));
    q.submit(req("a", "2"));
    const limit = errorOf(() => q.submit(req("a", "3")));
    expect([limit.kind, limit.arg]).toEqual(["user_limit", 2]);
    // Another user is unaffected, and an active item no longer counts as pending.
    q.submit(req("b", "x"));
    q.next();
    q.submit(req("a", "3"));

    expect(errorOf(() => q.submit(req("z", "  "))).kind).toBe("empty_text");
    const long = "あ".repeat(201);
    const tooLong = errorOf(() => q.submit(req("z", long)));
    expect([tooLong.kind, tooLong.arg]).toEqual(["text_too_long", 200]);

    const small = queueWith(cfg({ max_pending: 2 }), new TestClock());
    small.submit(req("a", "1"));
    small.submit(req("b", "2"));
    const full = errorOf(() => small.submit(req("c", "3")));
    expect([full.kind, full.arg]).toEqual(["queue_full", 2]);
  });

  it("kind_is_normalized", () => {
    const q = queueWith(cfg(), new TestClock());
    expect(
      q.submit({ requester: acct("a"), requesterName: "a", kind: " Song ", text: "x" }).item.kind,
    ).toBe("song");
    expect(
      q.submit({ requester: acct("b"), requesterName: "b", kind: "", text: "y" }).item.kind,
    ).toBe("chat");
  });

  it("a_request_without_a_kind_that_asks_for_a_song_is_a_song", () => {
    expect(guessKind("唱歌 https://www.youtube.com/watch?v=PHhHFN3SlcA")).toBe("song");
    expect(guessKind("https://youtu.be/abc")).toBe("song");
    expect(guessKind("這首 https://music.youtube.com/watch?v=x")).toBe("song");
    expect(guessKind("點歌 夜に駆ける")).toBe("song");
    expect(guessKind("唱一首 Lemon")).toBe("song");
    expect(guessKind("可以去挖鑽石嗎")).toBe("chat");
    expect(guessKind("看這個 https://example.com/youtube.com/")).toBe("chat");
    const q = queueWith(cfg(), new TestClock());
    expect(
      q.submit({ requester: acct("a"), requesterName: "a", kind: "", text: "點歌 Lemon" }).item
        .kind,
    ).toBe("song");
  });

  it("affinity_weights_within_a_round_and_blocked_is_refused", () => {
    const social = new FakeSocial();
    social.affinity.set("friend", 80);
    social.affinity.set("stranger", 0);
    social.affinity.set("rival", -50);
    social.affinity.set("pest", -100);
    social.blocked.add("pest");
    const q = queueWith(cfg(), new TestClock()).withSocial(social);

    // The rival asked first, the friend last; weight reorders within the lap.
    q.submit(req("rival", "rival"));
    q.submit(req("stranger", "stranger"));
    const s = q.submit(req("friend", "friend"));
    expect(s.position).toBe(1);
    expect(texts(q)).toEqual(["friend", "stranger", "rival"]);
    expect(errorOf(() => q.submit(req("pest", "hi"))).kind).toBe("blocked");

    // Affinity does not beat fairness: the friend's second item waits.
    q.submit(req("friend", "friend2"));
    expect(texts(q)).toEqual(["friend", "stranger", "rival", "friend2"]);
  });

  it("upvotes_add_weight_once_per_account", () => {
    const q = queueWith(cfg(), new TestClock());
    const a = q.submit(req("a", "a")).item.id;
    const b = q.submit(req("b", "b")).item.id;
    expect(q.vote(b, acct("x"))).toBe(1);
    expect(q.vote(b, acct("x"))).toBe(1);
    expect(q.vote(b, acct("y"))).toBe(2);
    expect(texts(q)).toEqual(["b", "a"]);
    const missing = errorOf(() => q.vote(99, acct("x")));
    expect([missing.kind, missing.arg]).toEqual(["not_found", 99]);
    q.next();
    q.next();
    const wrong = errorOf(() => q.vote(a, acct("x")));
    expect([wrong.kind, wrong.arg]).toEqual(["wrong_state", a]);
  });

  it("priority_and_move", () => {
    const q = queueWith(cfg(), new TestClock());
    const a = q.submit(req("a", "a")).item.id;
    const b = q.submit(req("b", "b")).item.id;
    const c = q.submit(req("c", "c")).item.id;
    const d = q.submit(req("d", "d")).item.id;
    expect(texts(q)).toEqual(["a", "b", "c", "d"]);

    q.setPriority(c, 5);
    expect(texts(q)).toEqual(["c", "a", "b", "d"]);

    q.moveItem(d, 0);
    expect(texts(q)).toEqual(["d", "c", "a", "b"]);
    q.moveItem(d, 2);
    expect(texts(q)).toEqual(["c", "a", "d", "b"]);
    q.moveItem(c, 99);
    expect(texts(q)).toEqual(["a", "d", "b", "c"]);
    q.moveItem(b, 1);
    expect(texts(q)).toEqual(["a", "b", "d", "c"]);

    // The order is what `next` hands out.
    expect(q.next()?.id).toBe(a);
    expect(q.next()?.id).toBe(b);
    expect(q.next()?.id).toBe(d);
    expect(q.next()?.id).toBe(c);
    expect(errorOf(() => q.setPriority(a, 1)).kind).toBe("wrong_state");
    const nf = errorOf(() => q.moveItem(42, 0));
    expect([nf.kind, nf.arg]).toEqual(["not_found", 42]);
  });

  it("pause_blocks_next_but_not_submit", () => {
    const q = queueWith(cfg(), new TestClock());
    q.pause();
    expect(q.isPaused()).toBe(true);
    q.submit(req("a", "a"));
    expect(q.next()).toBeNull();
    q.resume();
    expect(q.isPaused()).toBe(false);
    expect(q.next()?.text).toBe("a");
  });

  it("lifecycle_states_and_history", () => {
    const q = queueWith(cfg({ history_limit: 3 }), new TestClock());
    const ids = ["a", "b", "c", "d", "e"].map((w) => q.submit(req(w, w)).item.id) as [
      number,
      number,
      number,
      number,
      number,
    ];
    expect(errorOf(() => q.complete(ids[0])).kind).toBe("wrong_state");
    const first = q.next();
    expect(first?.id).toBe(ids[0]);
    expect(q.current()?.id).toBe(ids[0]);
    expect(q.complete(ids[0]).state).toBe("done");
    expect(q.skip(ids[1]).state).toBe("skipped");
    expect(q.remove(ids[2]).state).toBe("removed");
    expect(q.clear()).toBe(2);
    expect(q.list()).toEqual([]);
    expect(q.clear()).toBe(0);
    // Only the last 3 finished items are kept.
    const history = q.history();
    expect(history).toHaveLength(3);
    expect(history[0]?.id).toBe(ids[2]);
    expect(q.get(ids[4])?.state).toBe("removed");
    expect(q.get(ids[0])).toBeNull();
    expect(errorOf(() => q.remove(ids[4])).kind).toBe("not_found");
  });

  it("clear_keeps_active_items", () => {
    const q = queueWith(cfg(), new TestClock());
    q.submit(req("a", "a"));
    q.submit(req("b", "b"));
    q.next();
    expect(q.clear()).toBe(1);
    expect(texts(q)).toEqual(["a"]);
    expect(q.list()[0]?.state).toBe("active");
  });
});

describe("RequestQueue voting", () => {
  it("voting_latest_ballot_wins_and_ties_go_to_the_earliest", () => {
    const q = queueWith(cfg(), new TestClock());
    expect(errorOf(() => q.castVote(acct("a"), "x")).kind).toBe("no_vote");
    expect(errorOf(() => q.startVote(["only"], 10_000)).kind).toBe("bad_vote");
    expect(errorOf(() => q.startVote(["a", "A"], 10_000)).kind).toBe("bad_vote");
    q.startVote(["左", "右", "上"], 30_000);
    expect(errorOf(() => q.startVote(["a", "b"], 5_000)).kind).toBe("vote_running");

    expect(q.castVote(acct("1"), "左")).toBe("左");
    expect(q.castVote(acct("2"), "2")).toBe("右");
    expect(q.castVote(acct("3"), "上")).toBe("上");
    expect(errorOf(() => q.castVote(acct("3"), "下")).kind).toBe("unknown_option");
    expect(tallies(q.voteStatus() as never)).toEqual([1, 1, 1]);

    // Account 1 changes their mind: the latest ballot replaces the old one.
    q.castVote(acct("1"), "右");
    expect(tallies(q.voteStatus() as never)).toEqual([0, 2, 1]);

    // Tie 2-2 between 右 and 上: 右 reached its second vote first, so it wins.
    q.castVote(acct("4"), "上");
    expect(tallies(q.voteStatus() as never)).toEqual([0, 2, 2]);
    const early = q.endVote();
    expect(winnerOption(early)).toBe("右");
    expect(early.total).toBe(4);
    expect(q.voteStatus()).toBeNull();

    // The reverse order flips the tie.
    q.startVote(["左", "右"], 30_000);
    q.castVote(acct("1"), "右");
    q.castVote(acct("2"), "左");
    q.castVote(acct("3"), "左");
    q.castVote(acct("4"), "右");
    expect(winnerOption(q.endVote())).toBe("左");
  });

  it("vote_expires_via_tick_and_enqueues_the_winner", () => {
    const clock = new TestClock();
    const q = queueWith(cfg(), clock);
    q.startVote(["挖鑽石", "蓋房子"], 10_000);
    q.castVote(acct("1"), "蓋房子");
    q.castVote(acct("2"), "蓋房子");
    q.castVote(acct("3"), "挖鑽石");
    expect(q.tick()).toBeNull();

    clock.advance(11);
    // Ballots after the deadline are refused even before the tick closes it.
    expect(errorOf(() => q.castVote(acct("9"), "挖鑽石")).kind).toBe("no_vote");
    const result = q.tick();
    expect(result).not.toBeNull();
    expect(winnerOption(result as never)).toBe("蓋房子");
    expect(result?.tallies).toEqual([1, 2]);
    expect(q.lastVote()).toEqual(result);
    expect(q.tick()).toBeNull();

    const item = q.next();
    expect([item?.kind, item?.text]).toEqual(["vote", "蓋房子"]);
    expect(item?.priority).toBe(100);
  });

  it("vote_without_ballots_has_no_winner", () => {
    const q = queueWith(cfg(), new TestClock());
    q.startVote(["a", "b"], 5_000);
    const result = q.endVote();
    expect(result.winner).toBeNull();
    expect(q.list()).toEqual([]);
    expect(errorOf(() => q.endVote()).kind).toBe("no_vote");
  });

  it("vote_limits_are_enforced", () => {
    const q = queueWith(cfg({ max_vote_options: 3, max_vote_seconds: 60 }), new TestClock());
    expect(errorOf(() => q.startVote(["a", "b", "c", "d"], 10_000)).kind).toBe("bad_vote");
    expect(errorOf(() => q.startVote(["a", "b"], 0)).kind).toBe("bad_vote");
    expect(errorOf(() => q.startVote(["a", "b"], 61_000)).kind).toBe("bad_vote");
    q.startVote(["a", "b"], 60_000);
  });
});

describe("RequestQueue events", () => {
  it("publishes_events", () => {
    const events: Array<[string, JsonValue]> = [];
    const publisher = (event: PublishedEvent): void => {
      events.push([event.type, event.data as JsonValue]);
    };
    const q = queueWith(cfg(), new TestClock()).withPublisher(publishedVia(publisher));
    q.submit(req("a", "唱歌"));
    q.pause();
    q.pause(); // no change, no event
    q.resume();
    q.next();
    q.startVote(["a", "b"], 5_000);
    q.castVote(acct("1"), "a");
    q.endVote();

    expect(events.map(([t]) => t)).toEqual([
      "queue.changed", // submit
      "queue.changed", // pause
      "queue.changed", // resume
      "queue.changed", // next
      "queue.item_activated",
      "queue.changed", // start_vote
      "queue.changed", // cast_vote
      "queue.changed", // end_vote
      "queue.vote_result",
    ]);
    // biome-ignore lint/suspicious/noExplicitAny: JSON poking in assertions
    const p = (i: number): any => events[i]?.[1];
    expect(p(0).paused).toBe(false);
    expect(p(0).items[0].text).toBe("唱歌");
    expect(p(0).items[0].position).toBe(1);
    expect(p(0).items[0].requester.id).toBe("a");
    expect(p(0)).not.toHaveProperty("vote");
    expect(p(1).paused).toBe(true);
    expect(p(4).state).toBe("active");
    expect(p(4).text).toBe("唱歌");
    expect(p(6).vote.options).toEqual(["a", "b"]);
    expect(p(6).vote.tallies).toEqual([1, 0]);
    expect(p(8).winner_option).toBe("a");
    // The winner was enqueued, so the last changed event lists it.
    expect(p(7).items).toHaveLength(2);
  });

  it("item_json_shape_matches_the_overlay_contract", () => {
    const events: PublishedEvent[] = [];
    const q = queueWith(cfg(), new TestClock()).withPublisher(publishedInto(events));
    q.submit({
      ...req("a", "x"),
      context: { platform: "discord", scope: "1", channel: "2", kind: "channel" },
    });
    const first = events[0];
    expect(first?.type).toBe("queue.changed");
    const payload = first?.data as { items: Array<Record<string, JsonValue>> };
    expect(Object.keys(payload.items[0] ?? {}).sort()).toEqual(
      [
        "context",
        "created_at",
        "id",
        "kind",
        "position",
        "priority",
        "requester",
        "requester_name",
        "state",
        "text",
        "votes",
      ].sort(),
    );
    expect(payload.items[0]?.created_at).toBe("2023-11-14T22:13:20.000Z");
  });
});

describe("RequestQueue persistence", () => {
  it("persistence_round_trip", async () => {
    const store = new MemorySettingsStore();
    const clock = new TestClock();
    const q = queueWith(cfg(), clock).withStore(store);
    expect(await q.restore()).toBe(false);

    q.submit(req("a", "a1"));
    q.submit(req("a", "a2"));
    const b = q.submit(req("b", "b1")).item.id;
    q.submit(req("d", "d1"));
    q.next(); // a1 active, A has been served once
    q.vote(b, acct("x"));
    q.setPriority(b, 3);
    q.pause();
    q.startVote(["x", "y"], 60_000);
    q.castVote(acct("1"), "y");
    q.skip(b);
    await q.persist();

    const stored = await store.get(STATE_PROFILE, STATE_KEY);
    expect(stored).not.toBeNull();

    const revived = queueWith(cfg(), clock).withStore(store);
    expect(await revived.restore()).toBe(true);
    expect(revived.list()).toEqual(q.list());
    expect(revived.history()).toEqual(q.history());
    expect(revived.isPaused()).toBe(true);
    expect(revived.voteStatus()).toEqual(q.voteStatus());
    expect(revived.current()?.text).toBe("a1");

    // Fairness credit survives (d1 is newer than a2 but goes first, as A was already served)
    // and so does the id counter.
    expect(texts(revived)).toEqual(["a1", "d1", "a2"]);
    revived.resume();
    const c = revived.submit(req("c", "c1"));
    expect(c.item.id).toBeGreaterThan(b);
    expect(revived.next()?.text).toBe("d1");
    expect(revived.next()?.text).toBe("c1");
    expect(revived.next()?.text).toBe("a2");
  });

  it("snapshot_json_mirrors_the_rust_serde_shape", async () => {
    const store = new MemorySettingsStore();
    const q = queueWith(cfg(), new TestClock()).withStore(store);
    q.submit(req("a", "a1"));
    q.next();
    await q.persist();
    const stored = (await store.get(STATE_PROFILE, STATE_KEY)) as Record<string, JsonValue>;
    // The Rust shape, the default Space's partition at the top, and every Space's (phase 6).
    expect(Object.keys(stored).sort()).toEqual(
      ["history", "items", "last_vote", "next_id", "paused", "served", "spaces", "vote"].sort(),
    );
    expect(stored.served).toEqual([[{ platform: "discord", id: "a" }, 1]]);
    expect(stored.vote).toBeNull();
    const items = stored.items as Array<Record<string, JsonValue>>;
    expect(items[0]).toMatchObject({ id: 1, state: "active", slot: null, votes: 0, voters: [] });
  });

  it("restores_a_snapshot_with_missing_optional_fields", async () => {
    const store = new MemorySettingsStore();
    await store.set(STATE_PROFILE, STATE_KEY, {
      next_id: 7,
      items: [
        {
          id: 7,
          requester: { platform: "discord", id: "a" },
          requester_name: "A",
          kind: "chat",
          text: "x",
          context: null,
          created_at: "2025-01-01T00:00:00Z",
          priority: 0,
          state: "pending",
        },
      ],
    });
    const q = new RequestQueue(cfg(), { store });
    expect(await q.restore()).toBe(true);
    expect(q.list()[0]).toMatchObject({ id: 7, slot: null, votes: 0, voters: [] });
    expect(q.submit(req("b", "y")).item.id).toBe(8);
  });

  it("corrupt_snapshot_is_an_error_and_leaves_the_queue_alone", async () => {
    const store = new MemorySettingsStore();
    await store.set(STATE_PROFILE, STATE_KEY, { items: "nope" });
    const q = queueWith(cfg(), new TestClock()).withStore(store);
    q.submit(req("a", "a"));
    await expect(q.restore()).rejects.toThrow();
    expect(texts(q)).toEqual(["a"]);
  });

  it("run_loop_saves_debounced_closes_votes_and_flushes_on_cancel", async () => {
    vi.useFakeTimers();
    const store = new MemorySettingsStore();
    let writes = 0;
    const realSet = store.set.bind(store);
    store.set = async (profile, key, value) => {
      writes++;
      await realSet(profile, key, value);
    };
    const q = new RequestQueue(cfg({ persist_debounce_ms: 60, tick_ms: 10 }), { store });
    const controller = new AbortController();
    const task = q.run(controller.signal);

    // A burst of changes becomes one write.
    for (let n = 0; n < 5; n++) q.submit(req(String(n), "x"));
    expect(writes).toBe(0);
    await vi.advanceTimersByTimeAsync(300);
    expect(writes).toBe(1);

    // A one second vote is closed by the loop on its own.
    q.startVote(["a", "b"], 1000);
    q.castVote(acct("1"), "a");
    await vi.advanceTimersByTimeAsync(1300);
    expect(q.voteStatus()).toBeNull();
    expect(winnerOption(q.lastVote() as never)).toBe("a");

    // A change right before shutdown is flushed.
    q.pause();
    controller.abort();
    await task;
    const stored = (await store.get(STATE_PROFILE, STATE_KEY)) as Record<string, JsonValue>;
    expect(stored.paused).toBe(true);
  });
});
