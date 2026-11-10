import {
  ArgKind,
  argSpec,
  CommandRegistry,
  CommandReply,
  type CommandSpec,
  commandSpec,
} from "@miyoria/commands";
import { ApplicationCommandOptionType, InteractionContextType } from "discord.js";
import { describe, expect, test } from "vitest";
import {
  buildTree,
  toCreateCommands,
  truncate,
  validateCommand,
  validCommands,
} from "../src/slash.js";

function specs(): CommandSpec[] {
  return [
    commandSpec("ping", "Ping"),
    commandSpec("admin module list", "List modules"),
    commandSpec("admin module enable", "Enable", {
      args: [argSpec("id", "Module id", ArgKind.string)],
    }),
    commandSpec("admin block", "Block someone", {
      args: [
        argSpec("reason", "Why", ArgKind.string, { required: false }),
        argSpec("mode", "Mode", ArgKind.choice(["soft", "hard"])),
      ],
    }),
    commandSpec("admin role map", "Map a role", {
      args: [
        argSpec("discord_role", "Discord role", ArgKind.role),
        argSpec("user", "Someone", ArgKind.user, { required: false }),
      ],
    }),
  ];
}

describe("slash commands", () => {
  test("builds_nested_tree", () => {
    const tree = buildTree(specs(), (p) => (p.join(" ") === "admin" ? "管理" : null));
    expect(tree).toHaveLength(2);
    expect(tree[0]?.name).toBe("ping");
    const admin = tree[1];
    expect(admin?.kind.type).toBe("parent");
    expect(admin?.description).toBe("管理");
    const children = admin?.kind.type === "parent" ? admin.kind.children : [];
    expect(children[0]?.name).toBe("module");
    expect(children[0]?.description).toBe("admin module");
    expect(children[0]?.kind.type === "parent" && children[0].kind.children.length).toBe(2);
    expect(children[1]?.kind.type === "leaf" && children[1].kind.args.length).toBe(2);
  });

  test("skips_conflicts", () => {
    const s = [
      ...specs(),
      commandSpec("ping sub", "conflicts with leaf ping"),
      commandSpec("admin", "conflicts with group admin"),
    ];
    const tree = buildTree(s, () => null);
    expect(tree).toHaveLength(2);
    expect(tree[0]?.kind.type).toBe("leaf");
  });

  test("serializes_to_discord_shape", () => {
    const json = toCreateCommands(buildTree(specs(), () => null));
    expect(json[0]?.name).toBe("ping");
    expect(json[0]?.options).toEqual([]);

    const admin = json[1];
    expect(admin?.name).toBe("admin");
    const module = admin?.options[0];
    expect(module?.type).toBe(2); // SUB_COMMAND_GROUP
    expect(module?.options?.[1]?.name).toBe("enable");
    expect(module?.options?.[1]?.type).toBe(1); // SUB_COMMAND
    expect(module?.options?.[1]?.options?.[0]?.name).toBe("id");
    expect(module?.options?.[1]?.options?.[0]?.required).toBe(true);
    expect(module?.options?.[1]?.options?.[0]?.type).toBe(3); // STRING

    const block = admin?.options[1];
    expect(block?.type).toBe(1);
    // Required `mode` is moved before optional `reason`.
    expect(block?.options?.[0]?.name).toBe("mode");
    expect(block?.options?.[0]?.choices?.[1]?.value).toBe("hard");
    expect(block?.options?.[0]?.choices?.[1]?.name).toBe("hard");
    expect(block?.options?.[1]?.name).toBe("reason");
    expect(block?.options?.[1]?.required).toBe(false);

    const map = admin?.options[2]?.options?.[0];
    expect(map?.name).toBe("map");
    expect(map?.options?.[0]?.type).toBe(8); // ROLE
    expect(map?.options?.[1]?.type).toBe(6); // USER
    // Plain JSON, ready for a REST body.
    expect(JSON.parse(JSON.stringify(json))).toEqual(json);
  });

  test("truncates_long_descriptions", () => {
    const long = "說".repeat(150);
    expect(Array.from(truncate(long))).toHaveLength(100);
    expect(truncate(long).endsWith("…")).toBe(true);
    expect(truncate("short")).toBe("short");
  });

  test("empty_arg_descriptions_fall_back_to_the_name_and_limits_apply", () => {
    const many = Array.from({ length: 30 }, (_, i) => commandSpec(`c${i}`, "x"));
    const [first] = toCreateCommands(
      buildTree(
        [commandSpec("g", "g", { args: [argSpec("a", " ", ArgKind.integer)] }), ...many],
        () => null,
      ),
    );
    expect(first?.options[0]?.description).toBe("a");
    expect(first?.options[0]?.type).toBe(4); // INTEGER
    const sub = toCreateCommands(
      buildTree(
        Array.from({ length: 30 }, (_, i) => commandSpec(`g s${i}`, "x")),
        () => null,
      ),
    );
    expect(sub[0]?.options).toHaveLength(25);
  });

  test("top_level_commands_carry_contexts_and_member_permissions", () => {
    const registry = new CommandRegistry();
    const ok = () => CommandReply.text("ok");
    registry.register(commandSpec("help", "Help"), ok);
    registry.register(commandSpec("admin module list", "List"), ok);
    registry.register(commandSpec("voice join", "Join"), ok);
    registry.register(
      commandSpec("stream scene", "Scene", { args: [argSpec("name", "n", ArgKind.string)] }),
      ok,
      { autocomplete: { name: () => [] } },
    );
    // The mapper still honours a Manage Server gate when a group declares one.
    const groups = (p: readonly string[]) =>
      p[0] === "admin"
        ? { description: "admin", guild_only: true, member_permission: "manage_guild" as const }
        : registry.groupInfo(p);
    const json = toCreateCommands(buildTree(registry.specs(), groups));
    const byName = new Map(json.map((c) => [c.name, c]));
    expect(byName.get("admin")?.default_member_permissions).toBe("32"); // Manage Server
    expect(byName.get("admin")?.contexts).toEqual([InteractionContextType.Guild]);
    expect(byName.get("voice")?.default_member_permissions).toBeNull();
    expect(byName.get("voice")?.contexts).toEqual([InteractionContextType.Guild]);
    expect(byName.get("help")?.contexts).toEqual([
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
    ]);
    expect(byName.get("stream")?.options[0]?.options?.[0]?.autocomplete).toBe(true);
    expect(validCommands(json)).toHaveLength(json.length);
  });

  test("validation_catches_what_discord_rejects", () => {
    const good = toCreateCommands(buildTree([commandSpec("ok", "fine")], () => null))[0];
    if (!good) throw new Error("no command");
    expect(validateCommand(good)).toEqual([]);
    expect(validateCommand({ ...good, name: "Bad Name" })).toEqual([
      "/Bad Name: invalid name `Bad Name`",
    ]);
    expect(validateCommand({ ...good, description: "" })[0]).toContain("description");
    const mixed = {
      ...good,
      options: [
        { type: ApplicationCommandOptionType.String, name: "b", description: "b", required: false },
        { type: ApplicationCommandOptionType.String, name: "a", description: "a", required: true },
        {
          type: ApplicationCommandOptionType.String,
          name: "c",
          description: "c",
          autocomplete: true,
          choices: [{ name: "x", value: "x" }],
        },
      ],
    };
    const problems = validateCommand(mixed);
    expect(problems.some((p) => p.includes("required option after an optional one"))).toBe(true);
    expect(problems.some((p) => p.includes("autocomplete and choices"))).toBe(true);
    expect(validCommands([good, good])).toHaveLength(1);
  });

  test("unsupported_depth_is_skipped", () => {
    const deep: CommandSpec = { ...commandSpec("a b c", "x"), path: ["a", "b", "c", "d"] };
    expect(buildTree([deep], () => null)).toEqual([]);
  });
});
