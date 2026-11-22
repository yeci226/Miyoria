// The `host.toml` that `miyoria init` writes: this machine's name and the services it runs
// (docs/design/v5-hostd.md §3). Planned in memory so the init summary can show it and nothing is
// written before the answer is confirmed. An existing file is edited in place (comments stay) and
// never loses what it has.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { dirname } from "node:path";
import { parseHostConfig } from "@miyoria/hostd";
import { TomlDocument } from "./toml-patch.js";

/** The OS host name as the name of this machine: lower case, never empty. */
export function hostName(): string {
  return osHostname().toLowerCase() || "host";
}

export interface HostTomlPlan {
  file: string;
  /** The file is there already (it is edited, not created). */
  exists: boolean;
  text: string;
  name: string;
  /** Services the plan adds (not the ones the file has already). */
  added: string[];
}

const HEADER =
  "# This machine's services for hostd. Written by `miyoria init`; `miyoria add` and `remove` edit it.\n";

/**
 * At the end of a new file: that the owner of the Core this machine joins may update it from the
 * panel, and how to turn that off (docs/design/v5-hostd.md §14). On unless the two lines are
 * uncommented.
 */
const UPDATE_HINT = [
  "",
  "# The owner of the Core this machine joins may update it from the panel: fast-forward this",
  "# checkout to Core's commit on the branch it tracks, install, restart what changed. Never with",
  "# uncommitted changes here, never downloads models. To turn it off, uncomment these two lines:",
  "# [update]",
  "# allow_remote = false",
  "",
].join("\n");

/** The services a file has enabled; `[]` for a file that is not there or cannot be read. */
export function enabledServices(file: string): string[] {
  if (!existsSync(file)) return [];
  try {
    const doc = TomlDocument.parse(readFileSync(file, "utf8"));
    const services = doc.get(["services"]);
    if (services === null || typeof services !== "object" || Array.isArray(services)) return [];
    return Object.entries(services)
      .filter(
        ([, v]) => v !== null && typeof v === "object" && !Array.isArray(v) && v.enabled !== false,
      )
      .map(([name]) => name);
  } catch {
    return [];
  }
}

/** `host.toml` with `[services.<name>] enabled = true` for each name; the machine's name is kept. */
export function planHostToml(file: string, services: readonly string[]): HostTomlPlan {
  const exists = existsSync(file);
  const doc = TomlDocument.parse(exists ? readFileSync(file, "utf8") : "");
  const current = doc.get(["name"]);
  const name = typeof current === "string" && current !== "" ? current : hostName();
  if (!exists) doc.set(["name"], name);
  const added: string[] = [];
  for (const service of services) {
    if (doc.get(["services", service, "enabled"]) === true) continue;
    doc.set(["services", service, "enabled"], true);
    added.push(service);
  }
  const body = doc.toString();
  const text = exists ? body : `${HEADER}${body}${UPDATE_HINT}`;
  parseHostConfig(file, text); // what is written must load
  return { file, exists, text, name, added };
}

/** Writes a planned file. Returns whether it changed anything. */
export function writeHostToml(plan: HostTomlPlan): boolean {
  if (plan.exists && readFileSync(plan.file, "utf8") === plan.text) return false;
  mkdirSync(dirname(plan.file), { recursive: true });
  writeFileSync(plan.file, plan.text, "utf8");
  return true;
}
