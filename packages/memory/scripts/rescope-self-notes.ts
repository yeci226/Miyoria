// One-off: moves her old `global` notes that are about someone else out of `global`. Until
// 2026-11-11 every note of hers written in a server was `global`, so a note about someone there
// (「我懷疑木呱是機器人」, a card someone posted) could come back in anyone's DM. New notes are scoped
// by `noteAbout` / `scopeForNew`; this moves the old ones by the same rule (`rescoped`):
//
// * about her alone: stays `global`;
// * about one person alone (tagged or named, nobody else, no 大家 / 有人 / 別人): that `person`,
//   so it still comes back in their DM and, while they are there, in the server it was written in
//   (`source_context`, kept as it was), and nowhere else;
// * about anyone else: the server it was written in.
//
// SQLite only. Stop the node first (it holds the database), and back it up (scripts/backup.*).
//
//   pnpm --filter @miyoria/memory rescope-self-notes -- --db data/miyoria.db            (dry run)
//   pnpm --filter @miyoria/memory rescope-self-notes -- --db data/miyoria.db --apply
//
// Options: `--scope guild|channel` (default `guild`, like `memory.guild_scope`), `--samples N`
// (rows printed per group, default 8), `--profile ID` (default: every profile).
//
// A dry run opens the database read-only and changes nothing. A note about someone whose source
// is not a server place (none recorded, or a DM) cannot be placed: it is left as it is and counted.

import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import type { ContextKey, PersonId } from "@miyoria/types";
import { memoryConfig } from "../src/config.js";
import { type NamedPerson, noteAbout, rescoped } from "../src/scope.js";

interface Row {
  id: string;
  profile_id: string;
  subjects: string;
  content: string;
  source_context: string | null;
}

interface Move {
  row: Row;
  scope: string;
  subjects: string;
}

const GLOBAL_KEY = JSON.stringify({ type: "global" });

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: "string" },
      apply: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      scope: { type: "string", default: "guild" },
      samples: { type: "string", default: "8" },
      profile: { type: "string" },
    },
  });
  const path = values.db;
  if (path === undefined || path === "") fail("--db <path to the SQLite file> is required");
  if (values.apply && values["dry-run"]) fail("--apply and --dry-run exclude each other");
  if (values.scope !== "guild" && values.scope !== "channel") fail("--scope is guild or channel");
  const samples = Number.parseInt(values.samples ?? "8", 10);
  const apply = values.apply === true;
  const config = memoryConfig({ guild_scope: values.scope });

  const db = new DatabaseSync(path, { readOnly: !apply });
  const names = knownNames(db);
  const params = values.profile !== undefined ? [GLOBAL_KEY, values.profile] : [GLOBAL_KEY];
  const rows = db
    .prepare(
      "SELECT id, profile_id, subjects, content, source_context FROM memory_records " +
        "WHERE kind = 'self_note' AND scope_key = ? AND superseded_by IS NULL " +
        (values.profile !== undefined ? "AND profile_id = ? " : "") +
        "ORDER BY created_at",
    )
    .all(...params) as unknown[] as Row[];

  const stay: Row[] = [];
  const unplaced: Row[] = [];
  const toPerson: Move[] = [];
  const toServer: Move[] = [];
  for (const row of rows) {
    const subjects = JSON.parse(row.subjects) as PersonId[];
    const source =
      row.source_context === null ? null : (JSON.parse(row.source_context) as ContextKey);
    const note = { content: row.content, subjects, source_context: source };
    if (noteAbout(note.content, subjects, names).type === "self") {
      stay.push(row);
      continue;
    }
    const to = rescoped(config, note, names);
    if (to === null) {
      unplaced.push(row);
      continue;
    }
    const move = { row, scope: JSON.stringify(to.scope), subjects: JSON.stringify(to.subjects) };
    (to.scope.type === "person" ? toPerson : toServer).push(move);
  }

  const servers = new Map<string, number>();
  for (const m of toServer) servers.set(m.scope, (servers.get(m.scope) ?? 0) + 1);
  const people = new Set(toPerson.map((m) => m.scope));
  const untaggedToPerson = toPerson.filter((m) => m.row.subjects === "[]").length;

  console.log(`${apply ? "APPLY" : "DRY RUN"} on ${path}`);
  console.log(`known names: ${names.length}`);
  console.log(`global self notes: ${rows.length}`);
  console.log(`  about her alone, stay global: ${stay.length}`);
  console.log(
    `  about one person alone, to that person: ${toPerson.length} (${people.size} people; ` +
      `${untaggedToPerson} were untagged and get the person as subject)`,
  );
  console.log(`  about anyone else, to the server: ${toServer.length}`);
  for (const [scope, n] of servers) console.log(`    ${scope}: ${n}`);
  console.log(`  about someone, no server to move to (left as is): ${unplaced.length}`);

  const show = (title: string, list: readonly { row: Row; scope?: string }[]) => {
    console.log(`\n${title} (${list.length}, first ${Math.min(samples, list.length)}):`);
    for (const { row, scope } of list.slice(0, samples)) {
      console.log(`  ${row.id}  ${scope ?? ""}  ${row.subjects}  ${row.content}`);
    }
  };
  show("to a person", toPerson);
  show("to the server", toServer);
  show(
    "stay global",
    stay.map((row) => ({ row })),
  );
  show(
    "left as is (no server)",
    unplaced.map((row) => ({ row })),
  );

  if (!apply) {
    console.log(
      "\nNothing was changed. Run again with --apply (node stopped, database backed up).",
    );
    db.close();
    return;
  }
  const update = db.prepare(
    "UPDATE memory_records SET scope = ?, scope_key = ?, subjects = ? WHERE id = ?",
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const m of [...toPerson, ...toServer]) update.run(m.scope, m.scope, m.subjects, m.row.id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  console.log(`\nMoved ${toPerson.length + toServer.length} notes.`);
  db.close();
}

/** Every name she knows people by, and whose: handles, people and their accounts. */
function knownNames(db: DatabaseSync): NamedPerson[] {
  const out = new Map<string, NamedPerson>();
  const add = (name: string, person: PersonId | null) => {
    if (name.trim() === "") return;
    const had = out.get(name);
    // The same name for two people names neither for sure.
    if (had !== undefined && had.person !== person) out.set(name, { name, person: null });
    else out.set(name, { name, person });
  };
  const handles = db
    .prepare("SELECT value FROM profile_settings WHERE key LIKE 'handle:%'")
    .all() as { value: string }[];
  for (const { value } of handles) {
    const entry = JSON.parse(value) as { handle?: unknown; person?: unknown };
    if (typeof entry.handle !== "string") continue;
    add(entry.handle, typeof entry.person === "string" ? entry.person : null);
  }
  const people = db.prepare("SELECT id, display_name FROM people").all() as {
    id: string;
    display_name: string;
  }[];
  for (const p of people) add(p.display_name, p.id);
  const accounts = db.prepare("SELECT person_id, display_name FROM accounts").all() as {
    person_id: string;
    display_name: string;
  }[];
  for (const a of accounts) add(a.display_name, a.person_id);
  return [...out.values()];
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

main();
