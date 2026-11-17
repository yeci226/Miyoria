// `workspace.export`: one file of her workspace becomes an artifact, made in this turn for the
// person who asked, visible only where the turn happens. Everything in the workspace is untrusted.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ActionResult, ExecContext } from "@miyoria/gate/actions";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { ArtifactStoreKey, SqliteStore } from "@miyoria/store";
import type { AccountRef, ContextKey } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NODE_WORKSPACE, PersistentWorkspace, workspaceExportCapability } from "../src/index.js";
import { AMY, harness } from "./gate-helpers.js";

const OWEN: AccountRef = { platform: "discord", id: "100" };
const MIA: AccountRef = { platform: "discord", id: "200" };
const ROOM: ContextKey = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" };
const OTHER_ROOM: ContextKey = { platform: "discord", scope: "g1", channel: "c2", kind: "channel" };
const OWEN_DM: ContextKey = { platform: "discord", scope: null, channel: "d1", kind: "dm" };

let base: string;
let store: SqliteStore;
let workspace: PersistentWorkspace;
let services: ServiceRegistry;

beforeEach(async () => {
  base = mkdtempSync(join(tmpdir(), "miyoria-ws-export-"));
  workspace = new PersistentWorkspace(join(base, "workspace"), {
    maxBytes: 1_000_000,
    maxFiles: 50,
    maxFileBytes: 100_000,
  });
  await workspace.ensure();
  store = await SqliteStore.open(join(base, "a.db"));
  store.persons.resolve(ROOM, { account: OWEN, display_name: "Owen" });
  store.persons.resolve(ROOM, { account: MIA, display_name: "Mia" });
  store.persons.resolve(OTHER_ROOM, { account: OWEN, display_name: "Owen" });
  store.persons.resolve(OWEN_DM, { account: OWEN, display_name: "Owen" });
  services = new ServiceRegistry();
  services.provide("test", ArtifactStoreKey, store.artifacts as never);
});

afterEach(async () => {
  await store.close();
  rmSync(base, { recursive: true, force: true });
});

async function exportFile(
  path: string,
  who: AccountRef | null = OWEN,
  where: ContextKey | null = ROOM,
  withStore = true,
): Promise<ActionResult> {
  const cap = workspaceExportCapability({ workspace });
  const principal = { kind: "user", requester: who, context: where, override: false, actor: null };
  const ctx = {
    principal,
    request: { principal, capability: "workspace.export", args: { path }, turn: "T1" },
    decision: {},
    services: withStore ? services : new ServiceRegistry(),
    signal: new AbortController().signal,
  } as unknown as ExecContext;
  return (await cap.execute(cap.args.parse({ path }), ctx)) as ActionResult;
}

const refused = (r: ActionResult) => (r.data as { refused?: string }).refused;
const artifacts = () => store.artifacts as NonNullable<typeof store.artifacts>;

describe("workspace.export", () => {
  it("makes an artifact of the file, for the person who asked, in the place of the turn", async () => {
    await workspace.write("notes/report.txt", "她整理的報告\n");
    const result = await exportFile("notes/report.txt");
    const data = result.data as { ok: boolean; artifact_id: string };
    expect(data.ok).toBe(true);
    const a = artifacts().get(data.artifact_id);
    expect(a).toMatchObject({
      source: "sandbox",
      plugin: "sandbox",
      filename: "report.txt",
      mime: "text/plain",
      turn: "T1",
      scope: "room",
      downloadable: true,
    });
    const site = artifacts().places.at(ROOM, OWEN);
    expect(a?.made_for).toBe(site?.person_id);
    expect(a?.origin_session).toBe(site?.place.session);
    // Only that room sees it; not another room, a DM or the web.
    const room = artifacts().places.at(ROOM, MIA)?.viewer;
    expect(a && room && artifacts().visibleTo(a, room)).toBe(true);
    const other = artifacts().places.at(OTHER_ROOM, OWEN)?.viewer;
    expect(a && other && artifacts().visibleTo(a, other)).toBe(false);
    const dm = artifacts().places.at(OWEN_DM, OWEN)?.viewer;
    expect(a && dm && artifacts().visibleTo(a, dm)).toBe(false);
    expect(result.text).toContain(data.artifact_id);
    // The workspace file is still there, untouched.
    expect(await workspace.exists("notes/report.txt")).toBe(true);
  });

  it("in a DM it is that person's only", async () => {
    await workspace.write("a.txt", "private\n");
    const result = await exportFile("a.txt", OWEN, OWEN_DM);
    const a = artifacts().get((result.data as { artifact_id: string }).artifact_id);
    const site = artifacts().places.at(OWEN_DM, OWEN);
    expect(a).toMatchObject({ scope: "dm", made_for: site?.person_id });
    const room = artifacts().places.at(ROOM, OWEN)?.viewer;
    expect(a && room && artifacts().visibleTo(a, room)).toBe(false);
    const dm = site?.viewer;
    expect(a && dm && artifacts().visibleTo(a, dm)).toBe(true);
  });

  it("takes an image a program wrote, by what the bytes are", async () => {
    const png = Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...Array(80).fill(3),
    ]);
    await writeFile(join(workspace.dir, "plot.dat"), png);
    const result = await exportFile("plot.dat");
    expect(result.data).toMatchObject({ ok: true, mime: "image/png" });
    expect((result.data as { filename: string }).filename).toMatch(/\.png$/);
  });

  it("stores HTML and SVG as the plain text they are, never as a type a browser runs", async () => {
    await workspace.write("page.html", "<!doctype html><html><script>alert(1)</script></html>");
    const result = await exportFile("page.html");
    expect(result.data).toMatchObject({ ok: true, mime: "text/plain" });
    expect((result.data as { filename: string }).filename).not.toMatch(/\.html$/);
  });

  it("refuses an executable or other binary", async () => {
    await writeFile(
      join(workspace.dir, "tool.exe"),
      Uint8Array.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0]),
    );
    const result = await exportFile("tool.exe");
    expect(refused(result)).toBe("type_not_allowed");
  });

  it("is not a way out of the workspace: no traversal, no absolute path, no folder", async () => {
    await writeFile(join(base, "outside.txt"), "outside");
    mkdirSync(join(workspace.dir, "dir"));
    for (const path of [
      "../outside.txt",
      "..\\outside.txt",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "dir/../../outside.txt",
      "dir",
      "missing.txt",
    ]) {
      const result = await exportFile(path);
      expect(result.data, path).toMatchObject({ ok: false });
    }
    expect(artifacts().list({})).toEqual([]);
  });

  it("refuses without an artifact store, or from a place it does not know", async () => {
    await workspace.write("a.txt", "x\n");
    expect(refused(await exportFile("a.txt", OWEN, ROOM, false))).toBe("unavailable");
    // A DM that was never opened is not a place; someone else's DM is not theirs to export into.
    const unopened: ContextKey = { platform: "discord", scope: null, channel: "d9", kind: "dm" };
    expect(refused(await exportFile("a.txt", OWEN, unopened))).toBe("unknown_place");
    expect(refused(await exportFile("a.txt", MIA, OWEN_DM))).toBe("unknown_place");
  });

  it("is a low-risk file tool offered with the workspace tools, without Docker", () => {
    const h = harness();
    h.sandbox.workspace = workspace;
    h.grants.grant(AMY, NODE_WORKSPACE);
    h.gate.offerWorkspace();
    const tool = h.tools.get("workspace_export");
    expect(tool).toBeDefined();
    expect(tool?.meta).toMatchObject({ effect: "act", group: "files", risk: "low" });
  });
});
