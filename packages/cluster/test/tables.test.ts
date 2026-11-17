// The hosts that joined and the codes to join with, on an in-memory store.

import { createHash } from "node:crypto";
import { type Db, SqliteStore, type StorePlugin } from "@miyoria/store";
import type { Clock } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ClusterError, type ClusterTables, clusterTables, InviteError } from "../src/index.js";

/** The connection itself, to look at the rows. */
const raw: StorePlugin<Db> = { schema: { plugin: "probe", migrations: [] }, open: ({ db }) => db };

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

const T0 = Date.UTC(2026, 10, 15, 12);

async function open(): Promise<{
  store: SqliteStore;
  tables: ClusterTables;
  clock: { t: number };
}> {
  const store = await SqliteStore.open(":memory:", { plugins: [clusterTables] });
  stores.push(store);
  const clock = { t: T0 };
  const fake: Clock = { now: () => clock.t };
  return { store, tables: store.plugin(clusterTables).withClock(fake), clock };
}

describe("hosts", () => {
  it("create a host and show its key once, keeping only the key's hash", async () => {
    const { store, tables } = await open();
    const { host, key } = tables.hosts.create({ name: "main-pc" });
    expect(Buffer.from(key, "base64url")).toHaveLength(32);
    expect(host).toMatchObject({
      name: "main-pc",
      status: "pending",
      capabilities: [],
      platform: null,
      last_seen_at: null,
      created_at: new Date(T0).toISOString(),
    });
    const rows = store.plugin(raw).all("SELECT key_hash FROM cluster_hosts");
    expect(rows).toEqual([{ key_hash: createHash("sha256").update(key).digest("hex") }]);
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(() => tables.hosts.create({ name: "main-pc" })).toThrow(ClusterError);
    expect(() => tables.hosts.create({ name: "has space" })).toThrow(ClusterError);
    expect(() => tables.hosts.create({ name: "" })).toThrow(ClusterError);
  });

  it("verify the key of a host that is not revoked", async () => {
    const { tables } = await open();
    const { host, key } = tables.hosts.create({ name: "pc" });
    expect(tables.hosts.verify(host.id, key)).toBe(true);
    expect(tables.hosts.verify(host.id, `${key}x`)).toBe(false);
    expect(tables.hosts.verify(host.id, "")).toBe(false);
    expect(tables.hosts.verify("no-such-id", key)).toBe(false);
    const other = tables.hosts.create({ name: "other" });
    expect(tables.hosts.verify(host.id, other.key)).toBe(false);
    expect(tables.hosts.revoke("pc")?.status).toBe("revoked");
    expect(tables.hosts.verify(host.id, key)).toBe(false);
  });

  it("approve for exactly the capabilities given; a revoked host joins again", async () => {
    const { tables } = await open();
    tables.hosts.create({ name: "pc" });
    expect(tables.hosts.approve("pc", ["asr", "tts", "asr", " "])).toMatchObject({
      status: "approved",
      capabilities: ["asr", "tts"],
    });
    expect(tables.hosts.approve("pc", ["sing"]).capabilities).toEqual(["sing"]);
    expect(() => tables.hosts.approve("nobody", ["asr"])).toThrow(/no host named/);
    tables.hosts.revoke("pc");
    expect(tables.hosts.byName("pc")?.capabilities).toEqual([]);
    expect(() => tables.hosts.approve("pc", ["asr"])).toThrow(/join again/);
    expect(tables.hosts.revoke("nobody")).toBeNull();
  });

  it("create one approved at once, remove it, and list by name", async () => {
    const { tables } = await open();
    const made = tables.hosts.create({ name: "zeta", approved: true, capabilities: ["core"] });
    expect(made.host).toMatchObject({ status: "approved", capabilities: ["core"] });
    tables.hosts.create({ name: "alpha" });
    expect(tables.hosts.list().map((h) => h.name)).toEqual(["alpha", "zeta"]);
    expect(tables.hosts.remove("zeta")?.name).toBe("zeta");
    expect(tables.hosts.remove("zeta")).toBeNull();
    expect(tables.hosts.verify(made.host.id, made.key)).toBe(false);
    expect(tables.hosts.list().map((h) => h.name)).toEqual(["alpha"]);
  });

  it("record when a host was seen and what it runs on", async () => {
    const { tables, clock } = await open();
    const { host } = tables.hosts.create({ name: "pc" });
    clock.t = T0 + 5_000;
    tables.hosts.seen(host.id, { platform: "linux", version: "0.2.0" });
    expect(tables.hosts.get(host.id)).toMatchObject({
      platform: "linux",
      version: "0.2.0",
      last_seen_at: new Date(T0 + 5_000).toISOString(),
    });
    expect(tables.hosts.get("missing")).toBeNull();
  });
});

describe("invites", () => {
  it("make a code that works once and creates a pending host", async () => {
    const { store, tables } = await open();
    const invite = tables.invites.invite({ by: "owner" });
    expect(invite.code).toMatch(/^[A-HJ-NP-Z]{4}-\d{4}$/);
    expect(invite.expires_at).toBe(new Date(T0 + 600_000).toISOString());
    expect(JSON.stringify(store.plugin(raw).all("SELECT * FROM cluster_invites"))).not.toContain(
      invite.code,
    );
    // Typed in lower case with spaces around it.
    const made = tables.invites.redeem(` ${invite.code.toLowerCase()} `, "friend-pc");
    expect(made.host).toMatchObject({ name: "friend-pc", status: "pending" });
    expect(tables.hosts.verify(made.host.id, made.key)).toBe(true);
    expect(() => tables.invites.redeem(invite.code, "again")).toThrow(InviteError);
    expect(tables.hosts.byName("again")).toBeNull();
  });

  it("fail the same way for a used, an expired and an unknown code", async () => {
    const { tables, clock } = await open();
    const used = tables.invites.invite({ by: "owner" });
    tables.invites.redeem(used.code, "a");
    const expired = tables.invites.invite({ by: "owner", ttl_s: 60 });
    clock.t = T0 + 60_000;
    const messages = [used.code, expired.code, "ZZZZ-0000"].map((code) => {
      try {
        tables.invites.redeem(code, "b");
      } catch (error) {
        expect(error).toBeInstanceOf(InviteError);
        return (error as Error).message;
      }
      throw new Error(`${code} worked`);
    });
    expect(new Set(messages).size).toBe(1);
    expect(tables.hosts.byName("b")).toBeNull();
  });

  it("keep the name an invite fixed, and leave a code unused when the name is taken", async () => {
    const { tables } = await open();
    const named = tables.invites.invite({ name: "friend-pc", by: "owner" });
    expect(() => tables.invites.redeem(named.code, "someone-else")).toThrow(/friend-pc/);
    expect(tables.invites.redeem(named.code, "").host.name).toBe("friend-pc");

    tables.hosts.create({ name: "taken" });
    const open1 = tables.invites.invite({ by: "owner" });
    expect(() => tables.invites.redeem(open1.code, "taken")).toThrow(/exists/);
    expect(tables.invites.redeem(open1.code, "free").host.name).toBe("free");
    expect(() => tables.invites.invite({ by: "owner", ttl_s: 0 })).toThrow(ClusterError);
    expect(() => tables.invites.invite({ by: "owner", name: "bad name" })).toThrow(ClusterError);
  });
});
