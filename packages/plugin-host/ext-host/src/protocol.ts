// The extension protocol as the host uses it (`docs/protocols/extension-rpc.md`). The shapes are
// the schemas in `@miyoria/contracts/ext`, the same ones the SDK's types are derived from; this
// file gives them the host's names and adds what only the host does with a tool's name.

import type { CommandSpec } from "@miyoria/commands";
import {
  EXT_LIMITS,
  EXT_PROTOCOL_VERSION,
  ExtCommandSpecSchema,
  type ExtContributions,
  ExtContributionsSchema,
  type ExtExecutorDecl,
  ExtExecutorDeclSchema,
  type ExtExtensionInfo,
  type ExtHostInfo,
  type ExtInitializeParams,
  type ExtInitializeResult,
  ExtInitializeResultSchema,
  type ExtToolDecl,
  ExtToolDeclSchema,
} from "@miyoria/contracts/ext";
import type { z } from "zod";

/** Protocol version sent in `initialize`. */
export const PROTOCOL_VERSION: number = EXT_PROTOCOL_VERSION;

/** `initialize` params (host to extension). */
export type InitializeParams = ExtInitializeParams;
export type HostInfo = ExtHostInfo;
export type ExtensionInfo = ExtExtensionInfo;

/** `tools.register` params and `contributions.tools` entries. */
export type ToolDecl = ExtToolDecl;
export const ToolDeclSchema = ExtToolDeclSchema;

/** `CommandSpec` as the extension protocol reads it (every field required). */
export const CommandSpecSchema = ExtCommandSpecSchema satisfies z.ZodType<CommandSpec>;

/** `tasks.register` params and `contributions.executor`: the extension's task executor. */
export const ExecutorDeclSchema = ExtExecutorDeclSchema;
export type ExecutorDecl = ExtExecutorDecl;

/** Everything registered during activation, applied by the host at once. */
export const ContributionsSchema = ExtContributionsSchema;
export type Contributions = ExtContributions;

/** `initialize` result (extension to host). */
export const InitializeResultSchema = ExtInitializeResultSchema;
export type InitializeResult = ExtInitializeResult;

/** Registry name of a tool's wire name. */
export function registryToolName(wire: string): string {
  return wire.replaceAll(".", "_");
}

/** Wire names: 1–64 chars of ASCII letters, digits, `_`, `-`, `.`. */
export function validToolName(wire: string): boolean {
  return EXT_LIMITS.TOOL_NAME.test(wire);
}
