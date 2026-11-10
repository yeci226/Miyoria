// Capabilities of the Stage node: `stage.scene` (switch the OBS scene by role or name, with the
// role's transition; she may do it herself, the scene director does it as `director`) and
// `stage.stream` (OBS start / stop streaming; commands and the panel only, her own tool is
// `stream.start`, the Go Live that OBS follows) and `stage.expression` (a gift expression on her
// model for a few seconds; the economy asks, she has no tool for it).
//
// Scene switches run one at a time (whoever asks), so two switches and their transitions never
// interleave. With the ActivityManager, a switch that does not come from the scene director (her
// tool, a command, the panel) is a timed override (`scene_override`, `manual_hold_ms` long) the
// director follows instead of fighting it.

import { type Capability, CapabilityError, defineCapability } from "@miyoria/actions";
import { SerialQueue } from "@miyoria/kernel";
import { actLane, type StreamCurtain } from "@miyoria/types";
import { z } from "zod";
import { GIFT_EXPRESSION_MAX_S, GIFT_EXPRESSIONS, type SceneTransition } from "../protocol.js";
import { sceneNames } from "./commands.js";
import type { StageLink } from "./link.js";
import { BUILTIN_ROLES, matchScene, ROLE_LABELS, type SceneRoles } from "./scenes.js";

const SceneArgs = z
  .object({
    name: z.string().trim().min(1).nullish(),
    role: z.string().trim().toLowerCase().min(1).nullish(),
  })
  .refine((a) => (a.name ?? a.role ?? null) !== null, { message: "give `role` or `name`" });
const StreamArgs = z.object({ action: z.enum(["start", "stop"]) });
const ExpressionArgs = z.object({
  expression: z.enum(GIFT_EXPRESSIONS),
  seconds: z.number().min(1).max(GIFT_EXPRESSION_MAX_S),
});
type SceneArgs = z.output<typeof SceneArgs>;
type ExpressionArgs = z.output<typeof ExpressionArgs>;
type StreamArgs = z.output<typeof StreamArgs>;

const STAGE_LANE = actLane("stage");

function requireNode(link: StageLink): void {
  if (!link.isConnected()) throw new CapabilityError("the stage node is not connected");
}

/** Where a `stage.scene` request goes. */
export type SceneCapabilityTarget =
  | { ok: true; scene: string; role: string | null; transition: SceneTransition | null }
  | { ok: false; why: string };

/**
 * Resolves `{role}` or `{name}` (a scene name, or a role name) against the roles and the scene
 * list the node reported. Without a list any name is passed on.
 */
export function sceneTarget(
  args: SceneArgs,
  link: StageLink,
  roles: SceneRoles | null,
): SceneCapabilityTarget {
  const known = sceneNames(link.status());
  const listed = (link.status()?.scenes.length ?? 0) > 0;
  const byRole = (role: string): SceneCapabilityTarget => {
    const scene = roles?.resolve(role) ?? null;
    if (scene === null) return { ok: false, why: `no scene is set for role \`${role}\`` };
    return { ok: true, scene, role, transition: roles?.transition(role) ?? null };
  };
  if (args.role) return byRole(args.role);
  const name = args.name ?? "";
  const scene = listed ? matchScene(known, name) : name;
  if (scene !== null) {
    const role = roles?.roleOf(scene) ?? null;
    return { ok: true, scene, role, transition: roles?.transition(role) ?? null };
  }
  const asRole = name.toLowerCase();
  if (roles?.resolve(asRole)) return byRole(asRole);
  return { ok: false, why: `unknown scene \`${name}\` (scenes: ${known.join(", ")})` };
}

const ROLE_HELP = BUILTIN_ROLES.map((r) => `${r}(${ROLE_LABELS[r]})`).join("、");

export interface StageCapabilityOptions {
  /** The role mapping (none: names only). */
  roles?: SceneRoles | null;
  /** Shows the ending scene before OBS stops streaming. */
  curtain?: StreamCurtain | null;
  /** How long a switch she (or a command, the panel) asked for holds (ms). Default 120 000. */
  overrideMs?: number;
}

export function stageCapabilities(
  link: StageLink,
  options: StageCapabilityOptions = {},
): Capability[] {
  const roles = options.roles ?? null;
  const switches = new SerialQueue();
  const overrideMs = options.overrideMs ?? 120_000;
  const scene = defineCapability<SceneArgs>({
    name: "stage.scene",
    summary: "切換 OBS 場景",
    risk: "low",
    args: SceneArgs,
    permission: "stream.scene",
    tool: {
      name: "stage_scene",
      description:
        `切換直播畫面(OBS)的場景。通常用 role 指定用途:${ROLE_HELP};` +
        "也可以用 name 指定直播機回報的場景名稱。開台、玩遊戲、暫離時導演會自動切換,只有你自己想換時才用。",
      properties: {
        role: { type: "string", description: `場景用途,例如 ${BUILTIN_ROLES.join("、")}` },
        name: { type: "string", description: "場景名稱(不知道就用 role)" },
      },
    },
    lane: () => STAGE_LANE,
    // Her (or a command's) choice is an override of the director's scene, for a while.
    activity(args, principal) {
      if (principal.kind === "director") return null;
      const target = sceneTarget(args, link, roles);
      return target.ok
        ? [{ type: "scene_override", scene: target.scene, duration_ms: overrideMs }]
        : null;
    },
    // Only scenes the node reported (when it reports a list at all) or mapped roles.
    check(args) {
      const target = sceneTarget(args, link, roles);
      return target.ok ? null : target.why;
    },
    async execute(args) {
      requireNode(link);
      const target = sceneTarget(args, link, roles);
      if (!target.ok) throw new CapabilityError(target.why);
      const status = await switches.run(() => link.setScene(target.scene, target.transition));
      const what = target.role ? `${target.scene} (${target.role})` : target.scene;
      return {
        text: `switched to scene ${what}`,
        data: { scene: status.scene, role: target.role },
      };
    },
  });

  const stream = defineCapability<StreamArgs>({
    name: "stage.stream",
    summary: "讓 OBS 開始或停止直播",
    risk: "medium",
    args: StreamArgs,
    permission: "stream.start",
    lane: () => STAGE_LANE,
    async execute(args, ctx) {
      requireNode(link);
      if (args.action === "stop") await options.curtain?.close(ctx.signal);
      const status = await link.stream(args.action);
      return {
        text: `OBS stream ${args.action}`,
        data: { streaming: status.streaming, scene: status.scene },
      };
    },
  });

  // A bought expression (economy): not a tool of hers, only the backend asks. It answers once the
  // expression is on (the node takes it off by itself), so it does not hold the lane for `seconds`.
  const expression = defineCapability<ExpressionArgs>({
    name: "stage.expression",
    summary: "讓她的模型短暫換上一個表情(禮物)",
    risk: "low",
    args: ExpressionArgs,
    permission: "stream.expression",
    lane: () => STAGE_LANE,
    async execute(args) {
      requireNode(link);
      await link.expression(args.expression, args.seconds);
      return {
        text: `expression ${args.expression} for ${args.seconds}s`,
        data: { expression: args.expression, seconds: args.seconds },
      };
    },
  });

  return [scene, stream, expression] as Capability[];
}
