// Danmaku (docs/design/v5-play.md §11.6) against a real ledger: the text rules, every refusal
// before the charge costs nothing, one charge per key and one line published, the stage's answer
// keeps or gives back the price once, what a restart leaves in the middle is settled, her note,
// and the stream ending clears the overlay.

import { defineCapability } from "@miyoria/gate/actions";
import {
  ActivityManagerKey,
  type AnyEventDefinition,
  type EventPayload,
  Events,
  eventEnvelope,
  HeartKey,
  type JsonValue,
  type PersonId,
  type PublishMetaArgs,
  toTimestamp,
} from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ANSWER_GRACE_MS,
  CHARGING_GRACE_MS,
  DANMAKU_KIND,
  DANMAKU_MUTED,
  DANMAKU_NO_LINKS,
  DANMAKU_NO_STAGE,
  DANMAKU_NOT_LIVE,
  DANMAKU_REFUSED,
  DANMAKU_SENT,
  danmakuText,
  NO_DANMAKU_TAG,
  NOTE_SOURCE,
} from "../src/danmaku.js";
import { STRANGER } from "../src/economy.js";
import { RECOVERED_REASONS } from "../src/health.js";
import { ledgerOf, walletOf } from "./ledger.js";
import {
  ALICE,
  ALICE_TWO,
  BOB,
  balance,
  CAROL,
  DAVE,
  fund,
  type Rig,
  rejects,
  rig,
} from "./rig.js";

const ev = <D extends AnyEventDefinition>(
  definition: D,
  data: EventPayload<D>,
  ...meta: PublishMetaArgs<D>
) => eventEnvelope("test", definition, data, ...meta);

interface Stage {
  live: { on: boolean };
  muted: Set<PersonId>;
}

/** The stage link is up, her broadcast is `live` while `live.on`, and `muted` people are tagged. */
function onStage(r: Rig): Stage {
  const live = { on: true };
  const muted = new Set<PersonId>();
  r.registry.register(
    defineCapability<unknown>({
      name: "stage.expression",
      summary: "expression",
      risk: "low",
      args: z.object({}),
      permission: null,
      execute: async () => "ok",
    }),
  );
  r.services.provide("test", ActivityManagerKey, {
    snapshot: () => ({ broadcast: live.on ? { type: "live" } : { type: "off" } }),
  } as never);
  r.services.provide("test", HeartKey, {
    view: (p: PersonId) => ({ tags: muted.has(p) ? [NO_DANMAKU_TAG] : [] }),
  } as never);
  return { live, muted };
}

const lines = (r: Rig) =>
  r.bus.flatMap((e) =>
    e.type === Events.EconomyDanmaku.type ? [e.data as Record<string, JsonValue>] : [],
  );

const rows = async (r: Rig, reasons: string[]) =>
  ledgerOf(r.store).entries("p", walletOf(r.store, ALICE), { reasons, limit: 100 });

const statusOf = async (r: Rig, id: string) =>
  (await r.economy.docs().get("p", DANMAKU_KIND, id))?.status ?? null;

describe("danmakuText", () => {
  it("makes one clean line and counts characters, not code units", () => {
    expect(danmakuText("  好\n可愛\t啊  ", 30)).toEqual({ ok: true, text: "好 可愛 啊" });
    const hidden = `a${String.fromCodePoint(0x200b)}b${String.fromCodePoint(0x202e)}c${String.fromCodePoint(0xe0041)}`;
    expect(danmakuText(hidden, 30)).toEqual({ ok: true, text: "abc" });
    expect(danmakuText("🐟".repeat(3), 3)).toEqual({ ok: true, text: "🐟🐟🐟" });
    expect(danmakuText("🐟".repeat(4), 3).ok).toBe(false);
    expect(danmakuText(" 　 ", 30)).toEqual({ ok: false, why: "彈幕要 1 到 30 個字" });
    expect(danmakuText(String.fromCodePoint(0x200b), 30).ok).toBe(false);
  });

  it("refuses mentions and links instead of cutting them out", () => {
    for (const bad of [
      "@everyone 看這裡",
      "<@123456> 好",
      "去 https://example.org",
      "www.example",
      "discord.gg/abc",
      "加我 abc.tw",
      "HELLO.COM",
    ]) {
      expect(danmakuText(bad, 30), bad).toEqual({ ok: false, why: DANMAKU_NO_LINKS });
    }
    expect(danmakuText("3.5 分好聽", 30).ok).toBe(true);
    expect(danmakuText("email 我", 30).ok).toBe(true);
  });
});

describe("sending", () => {
  it("charges once per key, publishes the line once, and labels the row", async () => {
    const r = await rig();
    onStage(r);
    await fund(r, ALICE, 100);
    const first = await r.economy.danmaku(ALICE, "  好可愛 ", "k1");
    expect(first).toEqual({ accepted: true, charged: 5, balance: 95, message: DANMAKU_SENT });
    const again = await r.economy.danmaku(ALICE, "好可愛", "k1");
    expect(again).toEqual(first);
    expect(await balance(r, ALICE)).toBe(95);
    const sent = lines(r);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      name: "Alice",
      text: "好可愛",
      max_on_screen: 12,
      queue_max: 20,
      max_wait_ms: 30_000,
    });
    const [charge] = await rows(r, ["danmaku"]);
    expect(charge).toMatchObject({ delta: -5, ref: sent[0]?.id, idem_key: "danmaku:k1" });
    expect(await statusOf(r, sent[0]?.id as string)).toBe("sent");
    const statement = await r.economy.statement(ALICE);
    expect(statement.ledger[0]).toMatchObject({ delta: -5, label: "直播彈幕" });
    // Burned: none of it goes to her purse, nothing is told to her per line.
    expect(r.observed).toEqual([]);
    expect(RECOVERED_REASONS).toContain("danmaku");
  });

  it("hides the name when names are off", async () => {
    const r = await rig({ danmaku_show_names: false });
    onStage(r);
    await fund(r, ALICE, 100);
    await r.economy.danmaku(ALICE, "嗨", "k");
    expect(lines(r)[0]?.name).toBeNull();
  });

  it("refuses before the charge, and every refusal costs nothing", async () => {
    const r = await rig({ danmaku_per_day: 2, danmaku_cooldown_s: 0 });
    const stage = onStage(r);
    await fund(r, ALICE, 100);
    await rejects(r.economy.danmaku(ALICE, "看 www.x.tw", "a"), 400, DANMAKU_NO_LINKS);
    await rejects(r.economy.danmaku(ALICE, "字".repeat(31), "b"), 400);
    await rejects(r.economy.danmaku(DAVE, "嗨", "c"), 403, STRANGER);
    await rejects(r.economy.danmaku(CAROL, "嗨", "d"), 403, STRANGER);
    const refused = await r.economy.danmaku(ALICE, "BADWORD", "e");
    expect(refused).toEqual({
      accepted: false,
      charged: 0,
      balance: 100,
      message: DANMAKU_REFUSED,
    });
    stage.live.on = false;
    await rejects(r.economy.danmaku(ALICE, "嗨", "f"), 409, DANMAKU_NOT_LIVE);
    stage.live.on = true;
    await r.economy.danmakuDesk.onEvent(ev(Events.StageStatus, { connected: false }));
    await rejects(r.economy.danmaku(ALICE, "嗨", "g"), 409, DANMAKU_NO_STAGE);
    await r.economy.danmakuDesk.onEvent(
      ev(Events.StageStatus, {
        connected: true,
        vts: true,
        obs: true,
        scene: null,
        streaming: true,
        scenes: [],
        hotkeys: [],
        overlay_url: null,
        obs_collection: null,
        obs_warning: null,
      }),
    );
    stage.muted.add(walletOf(r.store, ALICE));
    await rejects(r.economy.danmaku(ALICE_TWO, "嗨", "h"), 409, DANMAKU_MUTED);
    stage.muted.clear();
    expect(await balance(r, ALICE)).toBe(100);
    expect(lines(r)).toEqual([]);
    // The day's limit, then nothing more.
    await r.economy.danmaku(ALICE, "一", "i");
    await r.economy.danmaku(ALICE, "二", "j");
    await rejects(r.economy.danmaku(ALICE, "三", "k"), 429, /今天最多 2 則/);
    expect(await balance(r, ALICE)).toBe(90);
    await rejects(r.economy.danmaku(BOB, "嗨", "l"), 402);
  });

  it("waits the cooldown between two lines of one person, all their accounts together", async () => {
    const r = await rig();
    onStage(r);
    await fund(r, ALICE, 100);
    await r.economy.danmaku(ALICE, "一", "k1");
    r.clock.at += 5_000;
    await rejects(r.economy.danmaku(ALICE_TWO, "二", "k2"), 429, /每 20 秒只能發一則,還要等 15 秒/);
    r.clock.at += 15_000;
    expect((await r.economy.danmaku(ALICE, "二", "k3")).accepted).toBe(true);
  });

  it("says in the view why a line cannot go now", async () => {
    const r = await rig();
    const stage = onStage(r);
    await fund(r, ALICE, 100);
    expect(await r.economy.danmakuView(ALICE)).toEqual({
      open: true,
      live: true,
      currency: "魚幣",
      price: 5,
      max_chars: 30,
      cooldown_s: 20,
      per_day: 50,
      sent_today: 0,
      wait_s: 0,
      balance: 100,
      why: null,
    });
    await r.economy.danmaku(ALICE, "一", "k1");
    expect(await r.economy.danmakuView(ALICE)).toMatchObject({
      sent_today: 1,
      wait_s: 20,
      why: "每 20 秒只能發一則,還要等 20 秒",
    });
    stage.live.on = false;
    expect((await r.economy.danmakuView(ALICE)).why).toBe(DANMAKU_NOT_LIVE);
    expect((await r.economy.danmakuView(DAVE)).why).toBe(STRANGER);
    const off = await rig({ danmaku_on: false });
    onStage(off);
    expect(await off.economy.danmakuView(ALICE)).toMatchObject({ open: false });
    await rejects(off.economy.danmaku(ALICE, "嗨", "k"), 409);
  });
});

describe("settling", () => {
  it("keeps the price of a line that was shown and gives back one that was not, once", async () => {
    const r = await rig({ danmaku_cooldown_s: 0 });
    onStage(r);
    await fund(r, ALICE, 100);
    await r.economy.danmaku(ALICE, "看得到", "k1");
    await r.economy.danmaku(ALICE, "看不到", "k2");
    const [shown, lost] = lines(r).map((l) => l.id as string);
    const desk = r.economy.danmakuDesk;
    await desk.onEvent(ev(Events.StageDanmaku, { id: shown as string, outcome: "shown" }));
    await desk.onEvent(ev(Events.StageDanmaku, { id: lost as string, outcome: "queue_full" }));
    // A repeated or late answer changes nothing.
    await desk.onEvent(ev(Events.StageDanmaku, { id: lost as string, outcome: "too_late" }));
    await desk.onEvent(ev(Events.StageDanmaku, { id: shown as string, outcome: "lost" }));
    await desk.onEvent(ev(Events.StageDanmaku, { id: lost as string, outcome: "shown" }));
    expect(await balance(r, ALICE)).toBe(95);
    expect(await statusOf(r, shown as string)).toBe("shown");
    expect(await statusOf(r, lost as string)).toBe("refunded");
    const back = await rows(r, ["danmaku_refund"]);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ delta: 5 });
    const statement = await r.economy.statement(ALICE);
    expect(statement.ledger.map((l) => l.label)).toContain("彈幕沒顯示,退回");
    // A given-back line does not count toward the day; a retry of its key says so.
    expect((await r.economy.danmakuView(ALICE)).sent_today).toBe(1);
    expect(await r.economy.danmaku(ALICE, "看不到", "k2")).toMatchObject({ charged: 0 });
    expect(await r.economy.danmakuDesk.today()).toEqual({ lines: 1, coins: 5 });
  });

  it("gives back what a restart left in the middle, and keeps what was shown after it", async () => {
    const first = await rig({}, { durable: true });
    onStage(first);
    await fund(first, ALICE, 100);
    await first.economy.danmaku(ALICE, "一", "k1");
    first.clock.at += 25_000;
    await first.economy.danmaku(ALICE, "二", "k2");
    const [a, b] = lines(first).map((l) => l.id as string);
    // A request that died after the charge, before the line was marked sent.
    const docs = first.economy.docs();
    const at = toTimestamp(first.clock.at);
    await docs.create({
      id: "midway",
      kind: DANMAKU_KIND,
      owner: ALICE,
      status: "charging",
      version: 1,
      data: {
        idem: "danmaku:k3",
        name: "Alice",
        sender: "Alice",
        text: "三",
        price: 5,
        charge: null,
        outcome: null,
      },
      created_at: at,
      updated_at: at,
    });
    await ledgerOf(first.store).post({
      id: "charge-3",
      person: walletOf(first.store, ALICE),
      delta: -5,
      reason: "danmaku",
      ref: "midway",
      idem_key: "danmaku:k3",
      ts: at,
    });
    // One that died before the charge.
    await docs.create({
      id: "uncharged",
      kind: DANMAKU_KIND,
      owner: ALICE,
      status: "charging",
      version: 1,
      data: {
        idem: "danmaku:k4",
        name: "Alice",
        sender: "Alice",
        text: "四",
        price: 5,
        charge: null,
        outcome: null,
      },
      created_at: at,
      updated_at: at,
    });
    expect(await balance(first, ALICE)).toBe(85);

    // Core restarts: a new economy over the same store.
    const second = await rig({}, { store: first.store, durable: true });
    onStage(second);
    second.clock.at = first.clock.at + 10_000;
    await second.economy.danmakuDesk.sweep(second.clock.at);
    expect(await balance(second, ALICE)).toBe(85); // nothing is due yet
    // The node kept its answer for `a` while Core was away.
    await second.economy.danmakuDesk.onEvent(
      ev(Events.StageDanmaku, { id: a as string, outcome: "shown" }),
    );
    second.clock.at = first.clock.at + CHARGING_GRACE_MS + 1;
    await second.economy.danmakuDesk.sweep(second.clock.at);
    expect(await statusOf(second, "midway")).toBe("refunded");
    expect(await statusOf(second, "uncharged")).toBe("void");
    expect(await balance(second, ALICE)).toBe(90);
    // `b` never got an answer: given back once its wait and the grace are over.
    second.clock.at = first.clock.at + 30_000 + ANSWER_GRACE_MS + 1;
    await second.economy.danmakuDesk.sweep(second.clock.at);
    await second.economy.danmakuDesk.sweep(second.clock.at);
    expect(await statusOf(second, b as string)).toBe("refunded");
    expect(await statusOf(second, a as string)).toBe("shown");
    expect(await balance(second, ALICE)).toBe(95);
    // A late "shown" for a line already given back keeps it given back (the member is not charged twice).
    await second.economy.danmakuDesk.onEvent(
      ev(Events.StageDanmaku, { id: b as string, outcome: "shown" }),
    );
    expect(await balance(second, ALICE)).toBe(95);
    // Nothing was published again.
    expect(lines(second)).toEqual([]);
  });

  it("counts burned coins as recovered and given-back ones against it", async () => {
    const r = await rig({ danmaku_cooldown_s: 0 }, { durable: true });
    onStage(r);
    await fund(r, ALICE, 100);
    await r.economy.danmaku(ALICE, "一", "k1");
    await r.economy.danmaku(ALICE, "二", "k2");
    const [kept, back] = lines(r).map((l) => l.id as string);
    await r.economy.danmakuDesk.settle(kept as string, "shown");
    await r.economy.danmakuDesk.settle(back as string, "no_overlay");
    const health = await r.economy.v2.health();
    expect(health.days.at(-1)?.recovered).toBe(5);
  });
});

describe("her side", () => {
  it("tells her a few of the lines shown, at most once per interval, and nothing when none came", async () => {
    const r = await rig({ danmaku_cooldown_s: 0, danmaku_note_s: 60 });
    onStage(r);
    await fund(r, ALICE, 100);
    const desk = r.economy.danmakuDesk;
    expect(desk.note(r.clock.at)).toBe(false);
    for (const [i, text] of ["一", "二", "三", "四", "五"].entries()) {
      await r.economy.danmaku(ALICE, text, `k${i}`);
    }
    // Only shown lines count; one that was given back is not mentioned.
    const ids = lines(r).map((l) => l.id as string);
    for (const id of ids.slice(0, 4)) await desk.settle(id, "shown");
    await desk.settle(ids[4] as string, "cleared");
    expect(desk.note(r.clock.at)).toBe(true);
    expect(r.observed).toHaveLength(1);
    const note = r.observed[0] as { summary: string; source: string };
    expect(note.source).toBe(NOTE_SOURCE);
    expect(note.summary).toMatch(/飄過 4 則觀眾的彈幕,其中幾則/);
    expect(note.summary.match(/「/g)).toHaveLength(3);
    expect(note.summary).not.toMatch(/五|魚幣|付/);
    // Within the interval, or with nothing new: no note.
    await r.economy.danmaku(ALICE, "六", "k6");
    await desk.settle(lines(r).at(-1)?.id as string, "shown");
    expect(desk.note(r.clock.at + 30_000)).toBe(false);
    expect(desk.note(r.clock.at + 60_000)).toBe(true);
    expect(desk.note(r.clock.at + 200_000)).toBe(false);
    expect(r.observed).toHaveLength(2);
  });

  it("clears the overlay when her broadcast ends", async () => {
    const r = await rig();
    const stage = onStage(r);
    const desk = r.economy.danmakuDesk;
    const changed = () => desk.onEvent(ev(Events.ActivityChanged, {} as never));
    await changed();
    stage.live.on = false;
    await changed();
    await changed();
    const clears = r.bus.filter((e) => e.type === Events.EconomyDanmakuClear.type);
    expect(clears).toHaveLength(1);
  });
});
