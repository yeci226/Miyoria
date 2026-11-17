// `<state>/run/hostd.json`: how to reach the daemon of a workspace. Written when the local API
// listens, removed when the daemon exits; readable by this user only.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

export const RUN_FILE = "hostd.json";

export const RunInfoSchema = z.object({
  pid: z.number().int(),
  port: z.number().int(),
  /** The operator token: whoever can read this file may control the daemon. */
  token: z.string().min(1),
  /** RFC 3339. */
  started_at: z.string(),
  version: z.string(),
  workspace: z.string(),
});
export type RunInfo = z.output<typeof RunInfoSchema>;

/** The run file of a state folder (`<state>/run/hostd.json`). */
export function runFilePath(stateDir: string): string {
  return join(stateDir, "run", RUN_FILE);
}

/** The run file's contents, or `null` when it is missing or unreadable. */
export function readRunFile(file: string): RunInfo | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = RunInfoSchema.safeParse(JSON.parse(readFileSync(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeRunFile(file: string, info: RunInfo): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(info, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows keeps the folder's ACL; the file is in the user's own workspace.
  }
}

/** Removes the run file when it is still the one with `token` (a newer daemon's is kept). */
export function removeRunFile(file: string, token: string): void {
  const info = readRunFile(file);
  if (info !== null && info.token !== token) return;
  rmSync(file, { force: true });
}

/** Whether a process with this id exists (it may belong to someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
