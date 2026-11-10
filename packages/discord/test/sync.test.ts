import { CommandRegistry, CommandReply, commandSpec, registerPanels } from "@miyoria/commands";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  currentCommands,
  resetCommands,
  runSyncLoop,
  SYNC_DEBOUNCE_MS,
  type SyncRest,
  syncCommands,
  syncRunner,
} from "../src/sync.js";

afterEach(() => {
  vi.useRealTimers();
});

const handler = () => CommandReply.public("ok");

class FakeRest implements SyncRest {
  puts: { route: string; body: unknown }[] = [];
  failFor: string | null = null;

  async put(route: `/${string}`, options?: { body?: unknown }): Promise<unknown> {
    this.puts.push({ route, body: options?.body });
    if (this.failFor && route.includes(this.failFor)) throw new Error("Missing Access");
    return [];
  }
}

describe("syncCommands", () => {
  test("registers_globally_without_command_guilds", async () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("ping", "Ping"), handler);
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, []);
    expect(rest.puts).toEqual([
      {
        route: "/applications/app1/commands",
        body: [
          {
            name: "ping",
            description: "Ping",
            options: [],
            default_member_permissions: null,
            contexts: [0, 1],
            integration_types: [0],
          },
        ],
      },
    ]);
  });

  test("guild_mode_clears_the_global_set_and_other_guilds_once", async () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("help", "Help"), handler);
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, ["g1"], { cleanup: { guilds: ["g1", "g9"] } });
    expect(rest.puts).toEqual([
      { route: "/applications/app1/guilds/g1/commands", body: expect.any(Array) },
      { route: "/applications/app1/commands", body: [] },
      { route: "/applications/app1/guilds/g9/commands", body: [] },
    ]);
    // Later syncs only touch the command guilds.
    rest.puts = [];
    await syncCommands(rest, "app1", registry, ["g1"], { cleanup: null });
    expect(rest.puts.map((p) => p.route)).toEqual(["/applications/app1/guilds/g1/commands"]);
  });

  test("global_mode_clears_every_guild_set", async () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("help", "Help"), handler);
    const rest = new FakeRest();
    rest.failFor = "/guilds/g2/";
    await syncCommands(rest, "app1", registry, [], { cleanup: { guilds: ["g1", "g2", "g3"] } });
    expect(rest.puts.map((p) => [p.route, Array.isArray(p.body) && p.body.length])).toEqual([
      ["/applications/app1/commands", 1],
      ["/applications/app1/guilds/g1/commands", 0],
      ["/applications/app1/guilds/g2/commands", 0],
      ["/applications/app1/guilds/g3/commands", 0],
    ]);
  });

  test("invalid_commands_are_left_out_instead_of_failing_the_whole_put", async () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("help", "Help"), handler);
    registry.register(commandSpec("bad sub", "x"), handler);
    // A group description Discord rejects (empty).
    registry.setGroupDescription("bad", "");
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, []);
    const body = rest.puts[0]?.body as { name: string }[];
    expect(body.map((c) => c.name)).toEqual(["help"]);
  });

  test("reset_clears_the_global_set_and_every_guild", async () => {
    const rest = new FakeRest();
    rest.failFor = "/guilds/g2/";
    const report = await resetCommands(rest, "app1", ["g1", "g2"]);
    expect(rest.puts.every((p) => Array.isArray(p.body) && p.body.length === 0)).toBe(true);
    expect(report.cleared).toEqual(["global", "g1"]);
    expect(report.failed).toEqual([{ scope: "g2", error: "Missing Access" }]);
  });

  test("registers_in_each_command_guild_and_survives_failures", async () => {
    const registry = new CommandRegistry();
    registry.register(commandSpec("admin role list", "List"), handler);
    registry.setGroupDescription("admin", "管理");
    const rest = new FakeRest();
    rest.failFor = "/guilds/g1/";
    await syncCommands(rest, "app1", registry, ["g1", "g2"]);
    expect(rest.puts.map((p) => p.route)).toEqual([
      "/applications/app1/guilds/g1/commands",
      "/applications/app1/guilds/g2/commands",
    ]);
    const body = (rest.puts[1]?.body ?? []) as { description: string }[];
    expect(body[0]?.description).toBe("管理");
  });
});

describe("runSyncLoop", () => {
  test("syncs_once_then_debounces_bursts_of_changes", async () => {
    vi.useFakeTimers();
    const registry = new CommandRegistry();
    const controller = new AbortController();
    let syncs = 0;
    const loop = runSyncLoop({
      registry,
      signal: controller.signal,
      sync: async () => {
        syncs++;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(syncs).toBe(1);

    registry.register(commandSpec("a", "A"), handler);
    await vi.advanceTimersByTimeAsync(500);
    registry.register(commandSpec("b", "B"), handler);
    await vi.advanceTimersByTimeAsync(500);
    registry.unregister("a");
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS - 1001);
    expect(syncs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(syncs).toBe(2);

    // Quiet: nothing more.
    await vi.advanceTimersByTimeAsync(10 * SYNC_DEBOUNCE_MS);
    expect(syncs).toBe(2);

    registry.register(commandSpec("c", "C"), handler);
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
    expect(syncs).toBe(3);

    controller.abort();
    await loop;
  });

  test("stops_when_aborted_during_the_debounce", async () => {
    vi.useFakeTimers();
    const registry = new CommandRegistry();
    const controller = new AbortController();
    let syncs = 0;
    const loop = runSyncLoop({
      registry,
      signal: controller.signal,
      sync: async () => {
        syncs++;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    registry.register(commandSpec("a", "A"), handler);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await loop;
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS * 2);
    expect(syncs).toBe(1);
  });
});

/** Every command the repository registers (docs/design/v3-architecture.md §14.2). */
const TREE = [
  "help",
  "admin autonomy pause",
  "admin autonomy resume",
  "admin autonomy status",
  "admin directive add",
  "admin directive list",
  "admin directive remove",
  "admin memory wipe",
  "admin module disable",
  "admin module enable",
  "admin module list",
  "admin module restart",
  "admin perm allow",
  "admin perm clear",
  "admin perm deny",
  "admin persona show",
  "admin person adjust",
  "admin person block",
  "admin person reset",
  "admin person show",
  "admin person tag",
  "admin person unblock",
  "admin person untag",
  "admin role assign",
  "admin role list",
  "admin role map",
  "admin role revoke",
  "admin role unmap",
  "admin role whois",
  "channel activeness",
  "channel mode",
  "game goal",
  "game start",
  "game status",
  "game stop",
  "me call",
  "me checkin",
  "me feed",
  "me link",
  "me memory export",
  "me memory forget",
  "me memory show",
  "me privacy",
  "me profile",
  "me wallet",
  "queue add",
  "queue list",
  "queue manage clear",
  "queue manage done",
  "queue manage next",
  "queue manage pause",
  "queue manage priority",
  "queue manage remove",
  "queue manage resume",
  "queue manage skip",
  "queue song list",
  "queue song request",
  "queue song skip",
  "queue song stop",
  "queue song voteskip",
  "queue upvote",
  "queue vote end",
  "queue vote start",
  "stream scene",
  "stream start",
  "stream status",
  "stream stop",
  "voice consent",
  "voice golive start",
  "voice golive status",
  "voice golive stop",
  "voice join",
  "voice leave",
  "voice mode",
];

interface Option {
  name: string;
  type: number;
  required?: boolean;
  options?: Option[];
}

interface Body {
  name: string;
  default_member_permissions: string | null;
  contexts: number[];
  options: Option[];
}

/** The paths a command body lets someone run (a leaf is a subcommand, or the bare command). */
function runnable(command: Body): string[] {
  const walk = (options: Option[], prefix: string[]): string[] =>
    options.flatMap((o) => {
      if (o.type === 1) return [[...prefix, o.name].join(" ")];
      if (o.type === 2) return walk(o.options ?? [], [...prefix, o.name]);
      return [];
    });
  return command.options.some((o) => o.type <= 2)
    ? walk(command.options, [command.name])
    : [command.name];
}

describe("the slash surface", () => {
  function fullRegistry(paths: readonly string[] = TREE): CommandRegistry {
    const registry = new CommandRegistry();
    for (const path of paths) registry.register(commandSpec(path, `desc ${path}`), handler);
    registerPanels(registry);
    return registry;
  }

  test("discord_gets_the_whole_tree_and_the_panels", async () => {
    const registry = fullRegistry();
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, ["g1"], { cleanup: { guilds: ["g1", "g9"] } });
    const body = rest.puts[0]?.body as Body[];
    expect(body.map((c) => c.name).sort()).toEqual([
      "admin",
      "channel",
      "game",
      "help",
      "me",
      "miyo",
      "queue",
      "song",
      "stream",
      "voice",
    ]);
    const by = new Map(body.map((c) => [c.name, c]));
    // `/miyo` and `/song` have no subcommands and stay bare.
    expect(by.get("miyo")?.options).toEqual([]);
    expect(by.get("song")?.options).toEqual([]);
    // The others keep their subcommands (and groups); `i` is the first of them.
    const names = (c: string) => by.get(c)?.options.map((o) => o.name);
    expect(names("me")).toEqual([
      "i",
      "call",
      "checkin",
      "feed",
      "link",
      "memory",
      "privacy",
      "profile",
      "wallet",
    ]);
    expect(names("admin")?.[0]).toBe("i");
    expect(names("admin")).toEqual(
      expect.arrayContaining(["module", "role", "perm", "person", "persona", "memory", "autonomy"]),
    );
    expect(names("voice")).toEqual(
      expect.arrayContaining(["join", "leave", "mode", "consent", "golive"]),
    );
    expect(names("help")).toEqual([]);
    // Other scopes are emptied once.
    expect(rest.puts.slice(1)).toEqual([
      { route: "/applications/app1/commands", body: [] },
      { route: "/applications/app1/guilds/g9/commands", body: [] },
    ]);
  });

  test("everything_fits_discords_limits_and_nothing_is_left_out", () => {
    const registry = fullRegistry();
    const body = currentCommands(registry) as unknown as Body[];
    // `validCommands` drops a command with a problem: none was dropped.
    expect(new Set(body.map((c) => c.name))).toEqual(
      new Set(registry.slashSpecs().map((s) => s.path[0])),
    );
    for (const command of body) {
      expect(command.options.length).toBeLessThanOrEqual(25);
      expect(command.name).toMatch(/^[-_a-z0-9]{1,32}$/);
      for (const option of command.options) {
        expect((option.options ?? []).length).toBeLessThanOrEqual(25);
        // One level of groups: a group holds subcommands only.
        if (option.type === 2) {
          for (const inner of option.options ?? []) expect(inner.type).toBe(1);
        }
      }
      // Subcommands and groups are not mixed with plain options.
      const kinds = new Set(command.options.map((o) => (o.type <= 2 ? "sub" : "plain")));
      expect(kinds.size).toBeLessThanOrEqual(1);
    }
    // Every command of the tree is reachable, and `i` exists only where a panel needs it.
    const reachable = body.flatMap(runnable).sort();
    expect(reachable).toEqual([...TREE, "admin i", "me i", "miyo", "song"].sort());
  });

  test("a_level_over_25_keeps_i_and_drops_the_rest", () => {
    const paths = Array.from({ length: 30 }, (_, n) => `big c${String(n).padStart(2, "0")}`);
    const registry = fullRegistry(paths);
    registry.registerPanel(commandSpec("big", "panel"), handler);
    const big = (currentCommands(registry) as unknown as Body[]).find((c) => c.name === "big");
    expect(big?.options).toHaveLength(25);
    expect(big?.options[0]?.name).toBe("i");
  });

  test("admin_takes_an_optional_user_and_is_not_gated_by_manage_server", async () => {
    const registry = fullRegistry();
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, []);
    const body = rest.puts[0]?.body as Body[];
    const by = new Map(body.map((c) => [c.name, c]));
    expect(by.get("admin")?.default_member_permissions).toBeNull();
    // The user argument belongs to `i`, the panel.
    expect(by.get("admin")?.options[0]).toMatchObject({
      name: "i",
      type: 1,
      options: [expect.objectContaining({ name: "user", type: 6, required: false })],
    });
    // `/me` also works in DMs (privacy), the others only in servers.
    expect(by.get("me")?.contexts).toEqual([0, 1]);
    expect(by.get("miyo")?.contexts).toEqual([0]);
    expect(by.get("song")?.contexts).toEqual([0]);
  });

  test("an_empty_set_never_overwrites_what_discord_has", async () => {
    const registry = new CommandRegistry();
    const rest = new FakeRest();
    await syncCommands(rest, "app1", registry, ["g1"], { cleanup: { guilds: ["g1", "g9"] } });
    // Nothing is written to the command guild; only the scopes not in use are cleared.
    expect(rest.puts.map((p) => p.route)).toEqual([
      "/applications/app1/commands",
      "/applications/app1/guilds/g9/commands",
    ]);
  });

  test("the_runner_skips_a_sync_when_the_slash_set_did_not_change", async () => {
    const registry = fullRegistry();
    const rest = new FakeRest();
    const sync = syncRunner({
      rest,
      applicationId: "app1",
      registry,
      commandGuilds: ["g1"],
      guilds: () => ["g1", "g9"],
    });
    await sync(true);
    expect(rest.puts).toHaveLength(3);
    rest.puts = [];
    // A change Discord does not show (who sees the replies) is not sent.
    registry.setVisibility({ "me wallet": "private" });
    await sync(false);
    expect(rest.puts).toEqual([]);
    // A new command goes out, without the one-time cleanup.
    registry.register(commandSpec("ext hello", "hello"), handler);
    await sync(false);
    expect(rest.puts.map((p) => p.route)).toEqual(["/applications/app1/guilds/g1/commands"]);
    expect(JSON.stringify(rest.puts[0]?.body)).toContain("ext");
    // A change to a panel goes out too.
    rest.puts = [];
    registry.registerPanel(commandSpec("song", "點歌與歌單（新）"), handler);
    await sync(false);
    expect(rest.puts.map((p) => p.route)).toEqual(["/applications/app1/guilds/g1/commands"]);
    // The first sync of a run always goes out.
    rest.puts = [];
    await sync(true);
    expect(rest.puts).toHaveLength(3);
  });
});
