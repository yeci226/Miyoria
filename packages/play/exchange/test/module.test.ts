// Module `exchange` and the local stocks' signals: the module builds the book from the sources it
// is given, reads yesterday's count, puts the plain line on the local stock's
// line, and tells her the facts as escaped data in her own bucket, with no names in it.

import { heartTables } from "@miyoria/heart/person";
import { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import { type EventLog, EventLogKey, type Observation, type ObserveOptions } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { exchangeConfig } from "../src/config.js";
import { ExchangeKey, ExchangeModule } from "../src/module.js";
import { signalMove, taipeiDay } from "../src/real/local.js";
import { type CountSource, LocalSignalBook } from "../src/real/signals.js";
import { exchangeTables } from "../src/store.js";

/** Monday 2026-11-23 12:30 Taipei. */
const NOW = Date.UTC(2026, 10, 23, 4, 30);
const Y = taipeiDay(NOW) - 1;
const clock = { now: () => NOW };

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

const feeds: CountSource = {
  label: "test",
  missing: () => null,
  count: async (day) => {
    if (day > Y || day < Y - 14) return null;
    const v = day === Y ? 16 : 10;
    return { value: v, parts: { feeds: v } };
  },
};

describe("module exchange, the local stocks' signals", () => {
  it("moves today's open by yesterday's feedings, shows the line and tells her the facts", async () => {
    const store = await SqliteStore.open(":memory:", {
      plugins: [heartTables, exchangeTables],
      clock,
    });
    cleanup.push(() => store.close());
    const notes: { o: Observation; options: ObserveOptions | undefined }[] = [];
    const log = {
      observe: (o: Observation, options?: ObserveOptions) => {
        notes.push({ o, options });
        return {} as never;
      },
    } as unknown as EventLog;
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    sup.services.provide("app", StoreKey, store);
    sup.services.provide("app", EventLogKey, log);
    // Only the feeding stock (RICE) has a source: the other four are missing and stay neutral.
    await sup.register(
      new ExchangeModule({ clock, tickMs: 3_600_000, seed: "m", sources: { feeding: feeds } }),
      null,
      true,
    );
    await sup.startAll();
    const service = sup.services.require(ExchangeKey);
    // Her note: her own bucket, escaped as data, numbers only.
    const deadline = Date.now() + 2000;
    while (!notes.some((n) => n.o.attention_key === "exchange:local") && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    const note = notes.find((n) => n.o.attention_key === "exchange:local");
    expect(note?.o.summary).toContain(
      "白飯食品(RICE):昨天你被餵了 16 次,比平常多 → 今天開盤 +1.8%",
    );
    expect(note?.options?.buckets?.[0]).toMatchObject({
      writer: "exchange.local",
      untrusted: true,
    });
    expect(note?.o.from).toBeNull();
    await service.tick();
    const view = service.real.view();
    const rice = view.instruments.find((i) => i.code === "RICE");
    expect(rice?.local?.today).toBe("昨天她被餵了 16 次,比平常多 → 今天開盤 +1.8%");
    expect(view.instruments.find((i) => i.code === "DPSK")?.local?.today).toBe(
      "昨天沒有她的紀錄 → 今天開盤 +0.0%",
    );
  });

  it("looks for the sources at the first signal, not at start, and logs the missing ones once", async () => {
    const store = await SqliteStore.open(":memory:", {
      plugins: [heartTables, exchangeTables],
      clock,
    });
    cleanup.push(() => store.close());
    const lines: { obj: unknown; msg: string }[] = [];
    const logger = {
      fatal: () => undefined,
      error: () => undefined,
      warn: () => undefined,
      info: (obj: unknown, msg?: string) => {
        if (typeof msg === "string" && msg.includes("no source")) lines.push({ obj, msg });
      },
      debug: () => undefined,
      trace: () => undefined,
      child: () => logger,
    };
    // A source whose module is not there when the exchange starts, and comes up right after.
    let songsUp = false;
    const songs: CountSource = {
      label: "songs",
      missing: () => (songsUp ? null : "點歌券沒有開"),
      count: async (day) => (day <= Y && day >= Y - 14 ? { value: 2, parts: { songs: 2 } } : null),
    };
    const sup = new Supervisor({ logger: logger as never });
    cleanup.push(() => sup.stopAll());
    sup.services.provide("app", StoreKey, store);
    await sup.register(
      new ExchangeModule({
        clock,
        tickMs: 3_600_000,
        seed: "m",
        sources: { feeding: feeds, songs },
      }),
      null,
      true,
    );
    const start = sup.startAll();
    songsUp = true;
    await start;
    const service = sup.services.require(ExchangeKey);
    const deadline = Date.now() + 2000;
    while (lines.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 3; i++) await service.tick();
    // One line, naming the three with no source; WHLE's came up in time and is not in it.
    expect(lines).toHaveLength(1);
    expect(
      Object.keys((lines[0]?.obj as { missing: object } | undefined)?.missing ?? {}).sort(),
    ).toEqual(["CUBE", "DPSK", "NAPS"]);
    // The neutral path: no source, no signal, an open with nothing from her day.
    const view = service.real.view();
    expect(view.instruments.find((i) => i.code === "NAPS")?.local?.today).toBe(
      "昨天沒有她的紀錄 → 今天開盤 +0.0%",
    );
    expect(view.instruments.find((i) => i.code === "WHLE")?.local?.today).toContain("唱完 2 首歌");
  });
});

describe("the signal book", () => {
  it("asks whether each source is there at its first computation and tells what is missing once", async () => {
    let up = false;
    const told: Record<string, string>[] = [];
    const book = new LocalSignalBook({
      sources: {
        feeding: { ...feeds, missing: () => (up ? null : "錢包沒有開") },
        model: { ...feeds, missing: () => "模型路由沒有開" },
      },
      config: () => exchangeConfig(),
      onMissing: (m) => told.push(m as Record<string, string>),
    });
    // Built before the economy came up: nothing is told yet.
    expect(told).toEqual([]);
    up = true;
    await book.prepare([Y], NOW);
    await book.prepare([Y], NOW + 60_000);
    expect(told).toEqual([
      { songs: "沒有來源", silence: "沒有來源", game: "沒有來源", model: "模型路由沒有開" },
    ]);
    expect(book.signal("feeding", Y)?.signal).toBeGreaterThan(0);
    expect(book.signal("model", Y)).toBeNull();
    expect(signalMove(book.signal("model", Y))).toBe(0);
  });
});
