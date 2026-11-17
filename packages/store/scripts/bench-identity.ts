// Micro-benchmark of the two hottest identity lookups (account → person, handle → person),
// through Drizzle and through a raw prepared statement, on the same `:memory:` data.
//
//   pnpm --filter @miyoria/store bench:identity [calls]

import { DatabaseSync } from "node:sqlite";
import { systemClock } from "@miyoria/types";
import { and, eq, sql } from "drizzle-orm";
import { Db } from "../src/db.js";
import { StoredHandleDirectory } from "../src/handles.js";
import { Identity } from "../src/identity/identity.js";
import { identitySchema } from "../src/identity/migrations.js";
import { accounts, persons } from "../src/identity/schema.js";
import { migrate } from "../src/migrate.js";

const CALLS = Number(process.argv[2] ?? 100_000);
const PEOPLE = 1_000;

const db = new Db(new DatabaseSync(":memory:", { enableForeignKeyConstraints: true }), systemClock);
migrate(db, [identitySchema]);
const identity = new Identity(db);
const memory = new StoredHandleDirectory(null);
const refs = Array.from({ length: PEOPLE }, (_, i) => ({
  platform: "discord",
  id: `1${String(i).padStart(17, "0")}`, // snowflake-sized
}));
for (const [i, ref] of refs.entries()) {
  identity.see(ref, `Person ${i % 700}`);
  memory.ofAccount(ref, `Person ${i % 700}`);
}
const handles = identity.persons().map((p) => p.handle);

function time(name: string, fn: (i: number) => unknown): void {
  for (let i = 0; i < 10_000; i++) fn(i); // warm up
  const start = process.hrtime.bigint();
  let found = 0;
  for (let i = 0; i < CALLS; i++) if (fn(i)) found++;
  const ns = Number(process.hrtime.bigint() - start);
  const per = ns / CALLS;
  console.log(
    `${name.padEnd(46)} ${(ns / 1e6).toFixed(0).padStart(6)} ms  ${(per / 1000).toFixed(2).padStart(6)} µs/call  ${Math.round(
      1e9 / per,
    )
      .toString()
      .padStart(8)} calls/s  (${found} found)`,
  );
}

const ref = (i: number) => refs[(i * 7919) % PEOPLE] as { platform: string; id: string };
const handle = (i: number) => handles[(i * 7919) % PEOPLE] as string;

// ---- account → person (one statement, a join) -------------------------------------------
const JOIN =
  "SELECT p.* FROM accounts a JOIN persons p ON p.id = a.person_id " +
  "WHERE a.platform = $platform AND a.external_id = $id";
const preparedJoin = db.orm
  .select({ person: persons })
  .from(accounts)
  .innerJoin(persons, eq(persons.id, accounts.person_id))
  .where(
    and(
      eq(accounts.platform, sql.placeholder("platform")),
      eq(accounts.external_id, sql.placeholder("id")),
    ),
  )
  .prepare();

console.log(`${CALLS} calls each, ${PEOPLE} persons, node ${process.version}\n`);
console.log("account → person");
time("raw: Db.get (cached StatementSync)", (i) => db.get(JOIN, ref(i)));
time("drizzle: prepared once, .get(params)", (i) => preparedJoin.get(ref(i)));
time("drizzle: query builder per call", (i) => {
  const r = ref(i);
  return db.orm
    .select({ person: persons })
    .from(accounts)
    .innerJoin(persons, eq(persons.id, accounts.person_id))
    .where(and(eq(accounts.platform, r.platform), eq(accounts.external_id, r.id)))
    .get();
});
time("Identity.personOf (2 prepared, merge-aware)", (i) => identity.personOf(ref(i)));

// ---- handle → person ----------------------------------------------------------------------
const BY_HANDLE = "SELECT * FROM persons WHERE handle = $handle COLLATE NOCASE";
const preparedHandle = db.orm
  .select()
  .from(persons)
  .where(sql`${persons.handle} = ${sql.placeholder("handle")} COLLATE NOCASE`)
  .prepare();
console.log("\nhandle → person");
time("raw: Db.get (cached StatementSync)", (i) => db.get(BY_HANDLE, { handle: handle(i) }));
time("drizzle: prepared once, .get(params)", (i) => preparedHandle.get({ handle: handle(i) }));
time("drizzle: query builder per call", (i) =>
  db.orm
    .select()
    .from(persons)
    .where(sql`${persons.handle} = ${handle(i)} COLLATE NOCASE`)
    .get(),
);
time("V4: StoredHandleDirectory.resolve (a Map)", (i) => memory.resolve(handle(i)));

db.close();
