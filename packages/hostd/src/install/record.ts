// What was installed into an environment, written next to it: `<state>/envs/<service>/
// .miyoria-install.json`. `update` and `doctor` compare it with the lock file, the extras and the
// descriptor's `[install]` section to tell a current environment from a stale one.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostInstall } from "@miyoria/contracts/host";
import { z } from "zod";
import { pythonIn } from "../resolve.js";

export const INSTALL_RECORD_FILE = ".miyoria-install.json";

export const InstallRecordSchema = z.object({
  /** SHA-256 of the project's `uv.lock`. */
  lock_sha256: z.string(),
  /** The extras that were synced, sorted. */
  extras: z.array(z.string()),
  /** SHA-256 of the descriptor's `[install]` section. */
  install_sha256: z.string(),
  installed_at: z.string(),
});
export type InstallRecord = z.output<typeof InstallRecordSchema>;

/** JSON with sorted keys, so equal values give equal text. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** An `[install]` section, whichever shape its `files` have. */
export type InstallSection = Omit<HostInstall, "files"> & { files: readonly unknown[] };

/**
 * The hash of a descriptor's `[install]` section. `install.files` is left out (as an empty list, so
 * a section without files hashes as before): a file is checked by its own checksum, and adding or
 * pinning one does not make the environment stale.
 */
export function installSectionHash(install: InstallSection): string {
  return createHash("sha256")
    .update(stable({ ...install, files: [] }))
    .digest("hex");
}

/** The hash of `<project>/uv.lock`; `null` when there is none. */
export function lockHash(projectDir: string): string | null {
  const file = join(projectDir, "uv.lock");
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function readInstallRecord(envDir: string): InstallRecord | null {
  const file = join(envDir, INSTALL_RECORD_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = InstallRecordSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeInstallRecord(envDir: string, record: InstallRecord): void {
  writeFileSync(join(envDir, INSTALL_RECORD_FILE), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

/** What an environment is, compared with what would be installed now. */
export interface EnvironmentState {
  state: "missing" | "stale" | "ready";
  /** Why it is stale or missing, one reason per item. */
  reasons: string[];
}

export interface EnvironmentWanted {
  envDir: string;
  projectDir: string;
  extras: readonly string[];
  install: InstallSection;
  platform: NodeJS.Platform;
}

/** Whether the environment exists and its record matches the lock, extras and descriptor. */
export function environmentState(wanted: EnvironmentWanted): EnvironmentState {
  if (!existsSync(pythonIn(wanted.envDir, wanted.platform))) {
    return { state: "missing", reasons: ["the environment does not exist"] };
  }
  const record = readInstallRecord(wanted.envDir);
  if (record === null) return { state: "stale", reasons: ["it has no install record"] };
  const reasons: string[] = [];
  const lock = lockHash(wanted.projectDir);
  if (lock !== record.lock_sha256) reasons.push("uv.lock changed");
  const extras = [...wanted.extras].sort();
  if (extras.join("\n") !== [...record.extras].sort().join("\n")) {
    reasons.push(
      `extras changed (${record.extras.join(", ") || "none"} → ${extras.join(", ") || "none"})`,
    );
  }
  if (installSectionHash(wanted.install) !== record.install_sha256) {
    reasons.push("the descriptor's [install] section changed");
  }
  return reasons.length === 0 ? { state: "ready", reasons } : { state: "stale", reasons };
}
