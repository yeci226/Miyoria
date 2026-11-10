import { MemorySettingsStore } from "@miyoria/store";
import type { JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  ProposedTools,
  type RunRequest,
  type RunResult,
  type Sandbox,
  SandboxError,
  TOOL_KEY_PREFIX,
  type ToolProposal,
} from "../src/index.js";

class FakeSandbox implements Sandbox {
  readonly requests: RunRequest[] = [];
  readonly workspace = null;
  readonly networkAllow: readonly string[] = [];
  readonly tools = {
    list: async () => [],
    read: async () => null,
    save: async () => {
      throw new Error("unused");
    },
    remove: async () => false,
  };

  async run(request: RunRequest): Promise<RunResult> {
    this.requests.push(request);
    return {
      run_id: "01J00000000000000000000000",
      language: request.language,
      exit_code: 0,
      stdout: `got ${request.stdin}`,
      stderr: "",
      stdout_truncated: false,
      stderr_truncated: false,
      files_out: [],
      files_out_truncated: false,
      duration_ms: 5,
      killed_reason: null,
      session: null,
    };
  }

  async listSessions() {
    return [];
  }

  async closeSession() {
    return false;
  }

  async health() {
    return { available: true, server_version: "29", error: null, checked_at: 0 };
  }
}

const SCHEMA = {
  type: "object",
  properties: { text: { type: "string" }, times: { type: "integer", minimum: 1 } },
  required: ["text"],
  additionalProperties: false,
};

function proposal(over: Partial<ToolProposal> = {}): ToolProposal {
  return {
    name: "shout",
    description: "Repeats text in capitals",
    language: "python",
    code: "import json,sys\na=json.load(sys.stdin)\nprint(a['text'].upper()*a.get('times',1))",
    args_schema: SCHEMA,
    ...over,
  };
}

function setup(maxTools = 10) {
  const store = new MemorySettingsStore();
  const sandbox = new FakeSandbox();
  const events: Array<[string, unknown]> = [];
  let now = Date.parse("2026-11-02T00:00:00Z");
  const tools = new ProposedTools({
    store,
    profile: "deepseek-chan",
    sandbox,
    clock: { now: () => now },
    publisher: (topic, payload) => events.push([topic, payload]),
    maxTools,
    maxCodeBytes: 1000,
  });
  return {
    store,
    sandbox,
    events,
    tools,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function kindOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SandboxError);
    return (error as SandboxError).kind;
  }
  throw new Error("expected a SandboxError");
}

describe("ProposedTools", () => {
  it("goes_pending_approved_and_invokes_with_json_stdin", async () => {
    const { tools, sandbox, events, store, advance } = setup();
    const proposed = await tools.propose(proposal(), "self");
    expect(proposed).toMatchObject({
      name: "shout",
      status: "pending",
      version: 1,
      proposed_by: "self",
      reviewer: null,
      reviewed_at: null,
      created_at: "2026-11-02T00:00:00.000Z",
    });
    expect(proposed.code_sha256).toMatch(/^[0-9a-f]{64}$/);
    // Persisted under its own settings key, every field present.
    const raw = await store.get("deepseek-chan", `${TOOL_KEY_PREFIX}shout`);
    expect(Object.keys(raw as object).sort()).toEqual(
      [
        "args_schema",
        "code",
        "code_sha256",
        "created_at",
        "description",
        "language",
        "name",
        "proposed_by",
        "review_note",
        "reviewed_at",
        "reviewer",
        "status",
        "updated_at",
        "version",
      ].sort(),
    );

    expect(await kindOf(tools.invoke("shout", { text: "hi" }))).toBe("wrong_state");
    expect(await tools.approvedSpecs()).toEqual([]);

    advance(60_000);
    const approved = await tools.approve("shout", { reviewer: "review", version: 1, note: "ok" });
    expect(approved).toMatchObject({
      status: "approved",
      reviewer: "review",
      review_note: "ok",
      reviewed_at: "2026-11-02T00:01:00.000Z",
    });
    expect(await tools.approvedSpecs()).toEqual([
      { name: "shout", description: "Repeats text in capitals", parameters: SCHEMA, version: 1 },
    ]);

    const run = await tools.invoke("shout", { text: "hi", times: 2 }, { timeout_ms: 5000 });
    expect(run.stdout).toBe('got {"text":"hi","times":2}');
    expect(sandbox.requests).toEqual([
      {
        language: "python",
        code: proposal().code,
        stdin: '{"text":"hi","times":2}',
        network: "none",
        timeout_ms: 5000,
      },
    ]);
    expect(events.map(([t]) => t)).toEqual(["sandbox.tool.proposed", "sandbox.tool.reviewed"]);
  });

  it("validates_invocation_arguments_against_the_schema", async () => {
    const { tools, sandbox } = setup();
    await tools.propose(proposal());
    await tools.approve("shout", { reviewer: "owner", version: 1 });
    const cases: JsonValue[] = [
      {},
      { text: 1 },
      { text: "x", times: 0 },
      { text: "x", extra: 1 },
      "x",
    ];
    for (const args of cases) {
      expect(await kindOf(tools.invoke("shout", args)), JSON.stringify(args)).toBe(
        "invalid_request",
      );
    }
    expect(sandbox.requests).toHaveLength(0);
  });

  it("binds_approval_to_one_version", async () => {
    const { tools } = setup();
    await tools.propose(proposal());
    // She re-proposes different code before the review lands.
    const v2 = await tools.propose(proposal({ code: "print('other')" }));
    expect(v2.version).toBe(2);
    expect(await kindOf(tools.approve("shout", { reviewer: "r", version: 1 }))).toBe("wrong_state");
    await tools.approve("shout", { reviewer: "r", version: 2 });
    // Changing an approved tool needs a new approval.
    const v3 = await tools.propose(proposal({ code: "print('third')" }));
    expect(v3).toMatchObject({ status: "pending", version: 3, reviewer: null });
    expect(await kindOf(tools.invoke("shout", { text: "x" }))).toBe("wrong_state");
    // Approved twice is wrong too.
    await tools.approve("shout", { reviewer: "r", version: 3 });
    expect(await kindOf(tools.approve("shout", { reviewer: "r", version: 3 }))).toBe("wrong_state");
  });

  it("rejects_removes_and_refuses_tampered_code", async () => {
    const { tools, store } = setup();
    await tools.propose(proposal());
    const rejected = await tools.reject("shout", { reviewer: "r", version: 1, note: "uses net" });
    expect(rejected).toMatchObject({ status: "rejected", review_note: "uses net" });
    expect(await kindOf(tools.invoke("shout", { text: "x" }))).toBe("wrong_state");
    expect((await tools.list({ status: "rejected" })).map((t) => t.name)).toEqual(["shout"]);
    expect(await tools.list({ status: "approved" })).toEqual([]);

    // Re-proposing a rejected tool starts a new review.
    await tools.propose(proposal());
    await tools.approve("shout", { reviewer: "r", version: 2 });
    const key = `${TOOL_KEY_PREFIX}shout`;
    const raw = (await store.get("deepseek-chan", key)) as Record<string, unknown>;
    await store.set("deepseek-chan", key, { ...raw, code: "import os; os.system('evil')" });
    expect(await kindOf(tools.invoke("shout", { text: "x" }))).toBe("wrong_state");

    expect(await tools.remove("shout")).toBe(true);
    expect(await tools.remove("shout")).toBe(false);
    expect(await tools.get("shout")).toBeNull();
    expect(await kindOf(tools.invoke("shout", {}))).toBe("not_found");
    expect(await kindOf(tools.approve("shout", { reviewer: "r", version: 1 }))).toBe("not_found");
  });

  it("refuses_bad_proposals", async () => {
    const { tools } = setup(1);
    for (const bad of [
      proposal({ name: "../evil" }),
      proposal({ name: "Upper" }),
      proposal({ code: "x".repeat(1001) }),
      proposal({ args_schema: { type: "string" } }),
      proposal({ description: "" }),
      proposal({ language: "ruby" as "python" }),
    ]) {
      expect(await kindOf(tools.propose(bad)), bad.name).toMatch(/invalid_request|invalid_path/);
    }
    await tools.propose(proposal());
    expect(await kindOf(tools.propose(proposal({ name: "second" })))).toBe("limit");
    // Updating an existing one is not over the limit.
    expect((await tools.propose(proposal())).version).toBe(2);
  });
});
