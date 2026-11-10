// Maps `CommandSpec`s to Discord application commands.
//
// Path depth 1 is a top-level command, depth 2 a subcommand, depth 3 a subcommand inside a
// subcommand group. Top-level commands carry the group's platform gates: `contexts` (servers
// only, or servers and the bot's DMs) and `default_member_permissions` (`/admin` needs Manage
// Server). Every body is validated before the bulk overwrite, because Discord rejects the whole
// request for one bad command.

import {
  type ArgSpec,
  type CommandSpec,
  type GroupInfo,
  MAX_MENUS_PER_TARGET,
  type MenuSpec,
} from "@miyoria/commands";
import { getLogger } from "@miyoria/kernel";
import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
  InteractionContextType,
  PermissionFlagsBits,
} from "discord.js";

const log = getLogger("discord.slash");

const MAX_DESCRIPTION = 100;
/** Discord allows 25 options, subcommands and choices per level. */
const MAX_ITEMS = 25;
const MAX_TOP_LEVEL = 100;
const MAX_DEPTH = 3;
/** Combined characters of names, descriptions and choice values of one command. */
const MAX_COMMAND_CHARS = 8000;

/** Platform-independent shape of one slash command level. */
export interface SlashNode {
  name: string;
  description: string;
  kind: SlashKind;
  /** Top-level nodes only: servers only (no DMs). */
  guildOnly?: boolean;
  /** Top-level nodes only: Discord's first gate. */
  memberPermission?: GroupInfo["member_permission"];
}

export type SlashKind =
  | { type: "leaf"; args: ArgSpec[] }
  | { type: "parent"; children: SlashNode[] };

/** JSON body of one application command (what the REST API accepts). */
export interface SlashCommandJson {
  /**
   * Absent for a slash command (chat input); `User` or `Message` for a context menu entry,
   * which has no description and no options.
   */
  type?: ApplicationCommandType.User | ApplicationCommandType.Message;
  name: string;
  description: string;
  options: SlashOptionJson[];
  /** Permission bits as a decimal string; `null` = everyone. */
  default_member_permissions: string | null;
  contexts: InteractionContextType[];
  integration_types: ApplicationIntegrationType[];
}

export interface SlashOptionJson {
  type: ApplicationCommandOptionType;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  choices?: { name: string; value: string }[];
  options?: SlashOptionJson[];
}

/** Group lookup: a full `GroupInfo`, or just a description (older callers). */
export type GroupLookup = (path: readonly string[]) => GroupInfo | string | null | undefined;

function info(lookup: GroupLookup, path: readonly string[]): GroupInfo | null {
  const found = lookup(path);
  if (found === null || found === undefined) return null;
  if (typeof found === "string") {
    return { description: found, guild_only: false, member_permission: null };
  }
  return found;
}

/**
 * Builds the command tree. `groups` supplies descriptions (and gates) of parent levels; missing
 * descriptions fall back to the path.
 */
export function buildTree(specs: readonly CommandSpec[], groups: GroupLookup): SlashNode[] {
  const roots: SlashNode[] = [];
  for (const spec of specs) {
    if (spec.path.length === 0 || spec.path.length > MAX_DEPTH) {
      log.warn({ command: spec.path.join(" ") }, "unsupported command depth, skipped");
      continue;
    }
    insert(roots, spec, 0, groups);
  }
  return roots;
}

function insert(level: SlashNode[], spec: CommandSpec, depth: number, groups: GroupLookup): void {
  const name = spec.path[depth] as string;
  const isLeaf = depth + 1 === spec.path.length;
  const existing = level.find((n) => n.name === name);
  const conflict = () =>
    log.warn({ command: spec.path.join(" ") }, "conflicts with another command, skipped");
  if (isLeaf) {
    if (existing) {
      conflict();
      return;
    }
    const node: SlashNode = {
      name,
      description: spec.description,
      kind: { type: "leaf", args: [...spec.args] },
    };
    if (depth === 0) {
      const group = info(groups, spec.path);
      node.guildOnly = group?.guild_only ?? false;
      node.memberPermission = group?.member_permission ?? null;
    }
    level.push(node);
    return;
  }
  let node = existing;
  if (!node) {
    const prefix = spec.path.slice(0, depth + 1);
    const group = info(groups, prefix);
    node = {
      name,
      description: group?.description ?? prefix.join(" "),
      kind: { type: "parent", children: [] },
    };
    if (depth === 0) {
      node.guildOnly = group?.guild_only ?? false;
      node.memberPermission = group?.member_permission ?? null;
    }
    level.push(node);
  }
  if (node.kind.type === "parent") insert(node.kind.children, spec, depth + 1, groups);
  else conflict();
}

function memberPermissions(permission: GroupInfo["member_permission"] | undefined): string | null {
  switch (permission) {
    case "manage_guild":
      return PermissionFlagsBits.ManageGuild.toString();
    default:
      return null;
  }
}

/** Converts the tree into the JSON bodies of a bulk overwrite. */
export function toCreateCommands(tree: readonly SlashNode[]): SlashCommandJson[] {
  if (tree.length > MAX_TOP_LEVEL) {
    log.warn({ count: tree.length }, "too many top-level commands, extra ones dropped");
  }
  return tree.slice(0, MAX_TOP_LEVEL).map((node) => ({
    name: node.name,
    description: truncate(node.description),
    options:
      node.kind.type === "leaf"
        ? argOptions(node.kind.args)
        : limited(node.kind.children, node.name).map(subOption),
    default_member_permissions: memberPermissions(node.memberPermission),
    contexts: node.guildOnly
      ? [InteractionContextType.Guild]
      : [InteractionContextType.Guild, InteractionContextType.BotDM],
    integration_types: [ApplicationIntegrationType.GuildInstall],
  }));
}

/**
 * The context menu entries as application commands. Discord shows them for servers only (a
 * menu acts on a message or a member of a guild) and takes no description or options; the entry
 * is told apart from a slash command of the same name by its type.
 */
export function toContextMenuCommands(menus: readonly MenuSpec[]): SlashCommandJson[] {
  return menus.map((menu) => ({
    type: menu.target === "message" ? ApplicationCommandType.Message : ApplicationCommandType.User,
    name: menu.name,
    description: "",
    options: [],
    default_member_permissions: null,
    contexts: [InteractionContextType.Guild],
    integration_types: [ApplicationIntegrationType.GuildInstall],
  }));
}

function subOption(node: SlashNode): SlashOptionJson {
  const description = truncate(node.description);
  if (node.kind.type === "leaf") {
    return {
      type: ApplicationCommandOptionType.Subcommand,
      name: node.name,
      description,
      options: argOptions(node.kind.args),
    };
  }
  return {
    type: ApplicationCommandOptionType.SubcommandGroup,
    name: node.name,
    description,
    options: limited(node.kind.children, node.name).map(subOption),
  };
}

function optionType(kind: ArgSpec["kind"]): ApplicationCommandOptionType {
  switch (kind.type) {
    case "string":
    case "choice":
      return ApplicationCommandOptionType.String;
    case "integer":
      return ApplicationCommandOptionType.Integer;
    case "boolean":
      return ApplicationCommandOptionType.Boolean;
    case "user":
      return ApplicationCommandOptionType.User;
    case "role":
      return ApplicationCommandOptionType.Role;
  }
}

/** Required options first (Discord rejects required after optional). */
function argOptions(args: readonly ArgSpec[]): SlashOptionJson[] {
  // Array.prototype.sort is stable: relative order within each group is kept.
  const sorted = [...args].sort((a, b) => Number(!a.required) - Number(!b.required));
  return sorted.slice(0, MAX_ITEMS).map((arg) => {
    const option: SlashOptionJson = {
      type: optionType(arg.kind),
      name: arg.name,
      description: arg.description.trim() === "" ? arg.name : truncate(arg.description),
      required: arg.required,
    };
    if (arg.kind.type === "choice") {
      option.choices = arg.kind.choices.slice(0, MAX_ITEMS).map((c) => ({ name: c, value: c }));
    } else if (arg.autocomplete && arg.kind.type === "string") {
      option.autocomplete = true;
    }
    return option;
  });
}

function limited(children: readonly SlashNode[], parent: string): readonly SlashNode[] {
  if (children.length > MAX_ITEMS) {
    log.warn({ parent }, `more than ${MAX_ITEMS} subcommands, extra ones dropped`);
    return children.slice(0, MAX_ITEMS);
  }
  return children;
}

/** At most `MAX_DESCRIPTION` characters (code points); longer text ends in `…`. */
export function truncate(s: string): string {
  const chars = Array.from(s);
  if (chars.length <= MAX_DESCRIPTION) return s;
  return `${chars.slice(0, MAX_DESCRIPTION - 1).join("")}…`;
}

// ---- validation ----------------------------------------------------------------------------

const NAME = /^[-_\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;

const len = (s: string) => Array.from(s).length;

function checkName(name: string, where: string, problems: string[]): void {
  if (!NAME.test(name) || name !== name.toLowerCase()) {
    problems.push(`${where}: invalid name \`${name}\``);
  }
}

function checkDescription(description: string, where: string, problems: string[]): void {
  const n = len(description);
  if (n < 1 || n > MAX_DESCRIPTION) problems.push(`${where}: description must be 1-100 characters`);
}

function isSub(option: SlashOptionJson): boolean {
  return (
    option.type === ApplicationCommandOptionType.Subcommand ||
    option.type === ApplicationCommandOptionType.SubcommandGroup
  );
}

function checkOptions(
  options: readonly SlashOptionJson[],
  where: string,
  depth: number,
  problems: string[],
): number {
  let chars = 0;
  if (options.length > MAX_ITEMS) problems.push(`${where}: more than ${MAX_ITEMS} options`);
  const names = new Set<string>();
  const subs = options.filter(isSub).length;
  if (subs > 0 && subs !== options.length) {
    problems.push(`${where}: subcommands mixed with other options`);
  }
  let optionalSeen = false;
  for (const option of options) {
    const at = `${where} ${option.name}`;
    checkName(option.name, at, problems);
    checkDescription(option.description, at, problems);
    if (names.has(option.name)) problems.push(`${at}: duplicate option name`);
    names.add(option.name);
    chars += len(option.name) + len(option.description);
    if (option.type === ApplicationCommandOptionType.SubcommandGroup) {
      if (depth > 0) problems.push(`${at}: subcommand group nested too deep`);
      if ((option.options ?? []).some((o) => o.type !== ApplicationCommandOptionType.Subcommand)) {
        problems.push(`${at}: a subcommand group may only hold subcommands`);
      }
      chars += checkOptions(option.options ?? [], at, depth + 1, problems);
      continue;
    }
    if (option.type === ApplicationCommandOptionType.Subcommand) {
      if ((option.options ?? []).some(isSub)) problems.push(`${at}: nested subcommand`);
      chars += checkOptions(option.options ?? [], at, depth + 1, problems);
      continue;
    }
    if (option.required) {
      if (optionalSeen) problems.push(`${at}: required option after an optional one`);
    } else {
      optionalSeen = true;
    }
    if (option.autocomplete && option.choices) {
      problems.push(`${at}: autocomplete and choices cannot be combined`);
    }
    for (const choice of option.choices ?? []) {
      if (len(choice.name) < 1 || len(choice.name) > 100 || len(choice.value) > 100) {
        problems.push(`${at}: choice \`${choice.name}\` is too long`);
      }
      chars += len(choice.name) + len(choice.value);
    }
    if ((option.choices?.length ?? 0) > MAX_ITEMS) problems.push(`${at}: more than 25 choices`);
  }
  return chars;
}

/** Problems Discord would reject one command body for; empty when it is fine. */
export function validateCommand(command: SlashCommandJson): string[] {
  const problems: string[] = [];
  if (command.type !== undefined) {
    // A context menu entry: any case and spaces, 1 to 32 characters, nothing else.
    const where = `menu ${command.name}`;
    if (len(command.name) < 1 || len(command.name) > 32)
      problems.push(`${where}: name must be 1-32 characters`);
    if (command.options.length > 0) problems.push(`${where}: a menu takes no options`);
    if (command.contexts.length === 0) problems.push(`${where}: no contexts`);
    return problems;
  }
  const where = `/${command.name}`;
  checkName(command.name, where, problems);
  checkDescription(command.description, where, problems);
  const chars =
    len(command.name) +
    len(command.description) +
    checkOptions(command.options, where, 0, problems);
  if (chars > MAX_COMMAND_CHARS)
    problems.push(`${where}: more than ${MAX_COMMAND_CHARS} characters`);
  if (command.contexts.length === 0) problems.push(`${where}: no contexts`);
  if (
    command.default_member_permissions !== null &&
    !/^\d+$/.test(command.default_member_permissions)
  ) {
    problems.push(`${where}: invalid default_member_permissions`);
  }
  return problems;
}

/** The commands that pass `validateCommand` (others are logged and left out). */
export function validCommands(commands: readonly SlashCommandJson[]): SlashCommandJson[] {
  // Names are unique per type: a slash command and a menu entry may share one.
  const names = new Set<string>();
  const menus = new Map<number, number>();
  const out: SlashCommandJson[] = [];
  for (const command of commands) {
    const problems = validateCommand(command);
    const key = `${command.type ?? 1}:${command.name}`;
    if (names.has(key)) problems.push(`/${command.name}: duplicate command`);
    if (command.type !== undefined) {
      const count = menus.get(command.type) ?? 0;
      if (count >= MAX_MENUS_PER_TARGET) problems.push(`menu ${command.name}: too many menus`);
      else menus.set(command.type, count + 1);
    }
    if (problems.length > 0) {
      log.error({ command: command.name, problems }, "invalid slash command left out of the sync");
      continue;
    }
    names.add(key);
    out.push(command);
  }
  return out;
}
