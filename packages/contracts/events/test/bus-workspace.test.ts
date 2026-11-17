// The image job and sandbox topics: their tiers and scopes, and payloads as their publishers
// build them. The sandbox tests that reach these topics need Docker, so the payloads are written
// out here.

import { describe, expect, it } from "vitest";
import { checkBusEvent } from "../src/bus-check.js";
import { busEventRegistry } from "../src/index.js";

const registry = busEventRegistry();

function problems(topic: string, payload: unknown) {
  return checkBusEvent(registry, topic, payload).problems;
}

describe("tiers and default scopes", () => {
  it.each([
    ["imagegen.job", "owner", "short"],
    ["sandbox.tool.proposed", "owner", "keep"],
    ["sandbox.tool.reviewed", "owner", "keep"],
    ["sandbox.tool.removed", "owner", "keep"],
    ["sandbox.run.finished", "owner", "short"],
    ["sandbox.workspace.enforced", "owner", "short"],
    ["sandbox.session.started", "owner", "short"],
    ["sandbox.session.closed", "owner", "short"],
  ])("%s: scope %s, tier %s", (type, scope, tier) => {
    expect(registry.defaults(type)).toEqual({ scope, tier });
  });
});

describe("payloads as they are published", () => {
  it("an image job", () => {
    const job = {
      id: "j1",
      purpose: "avatar",
      state: "running",
      progress: 0.5,
      error: null,
      outputs: [],
    };
    expect(problems("imagegen.job", job)).toEqual([]);
    expect(problems("imagegen.job", { ...job, state: "paused" })).not.toEqual([]);
  });

  it("a tool proposal and its review", () => {
    const tool = {
      name: "dice",
      version: 2,
      status: "pending",
      language: "python",
      code_sha256: "ab".repeat(32),
      proposed_by: "self",
      reviewer: null,
    };
    expect(problems("sandbox.tool.proposed", tool)).toEqual([]);
    expect(
      problems("sandbox.tool.reviewed", { ...tool, status: "approved", reviewer: "discord:1" }),
    ).toEqual([]);
    expect(problems("sandbox.tool.proposed", { ...tool, code: "print(1)" })).not.toEqual([]);
    expect(problems("sandbox.tool.removed", { name: "dice", version: 2 })).toEqual([]);
  });

  it("a run, a workspace check and a session", () => {
    expect(
      problems("sandbox.run.finished", {
        run_id: "r1",
        language: "node",
        exit_code: null,
        duration_ms: 1200,
        killed_reason: "timeout",
        files_out: 0,
        session: null,
      }),
    ).toEqual([]);
    expect(problems("sandbox.workspace.enforced", { run_id: "r1", removed: 2 })).toEqual([]);
    expect(problems("sandbox.session.started", { name: "work", language: "python" })).toEqual([]);
    expect(problems("sandbox.session.closed", { name: "work", reason: "idle", runs: 4 })).toEqual(
      [],
    );
  });
});
