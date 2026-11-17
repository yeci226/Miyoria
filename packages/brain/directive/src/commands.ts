// `admin directive list | add | remove`, the commands behind the rule pages of `/miyo` and `/admin`
// (`packages/commands/src/panels.ts`). The node only opens the door: what the person may do with a
// rule is the service's call, from their account, the same as for a tool or the panel.

import {
  ArgKind,
  argSpec,
  type CommandRegistry,
  type CommandReply,
  cardReply,
  commandSpec,
  type Invocation,
  notice,
} from "@miyoria/commands";
import {
  DIRECTIVE_EFFECTS,
  type DirectiveChange,
  type DirectiveRecord,
  type DirectiveScope,
  type Directives,
  isDirectiveEffect,
} from "@miyoria/types";

export const PATHS = ["admin directive list", "admin directive add", "admin directive remove"];

export const NODE_VIEW = "admin.directive.view";
export const NODE_ADD = "admin.directive.add";
export const NODE_REMOVE = "admin.directive.remove";

const EFFECT_LABELS = {
  deny: "禁止",
  require_approval: "要先問主人",
  avoid: "盡量不要",
  prefer: "偏好",
} as const;

const AUTHORITY_LABELS = {
  owner: "主人",
  moderator: "管理員",
  system: "系統",
  viewer: "觀眾",
} as const;

function ruleLine(rule: DirectiveRecord): string {
  const until = rule.expires === "until_revoked" ? "直到解除" : `到 ${rule.expires}`;
  const who = AUTHORITY_LABELS[rule.authority];
  return `\`${rule.id.slice(-6)}\` ${EFFECT_LABELS[rule.effect]}:${rule.text}(${who},${until})`;
}

function answer(change: DirectiveChange): CommandReply {
  switch (change.status) {
    case "added":
      return notice("success", `已建立規則:${change.directive.text}`, change.note);
    case "removed":
      return notice("success", `已解除規則:${change.directive.text}`);
    case "question":
      return notice("warn", change.question);
    case "refused":
      return notice("error", change.detail);
  }
}

function scopeOf(inv: Invocation): DirectiveScope {
  const scope: DirectiveScope = {};
  const capability = inv.str("capability");
  const activity = inv.str("activity");
  if (capability !== null) scope.capability = capability;
  if (activity !== null) scope.activity = activity;
  return scope;
}

/** Registers the commands; undo with `unregisterCommands`. */
export function registerCommands(
  registry: CommandRegistry,
  directives: () => Directives | undefined,
): void {
  const unavailable = () => notice("error", "規則功能現在無法使用。");
  registry.register(
    commandSpec("admin directive list", "列出現在的規則", {
      permission: NODE_VIEW,
      ephemeral: true,
    }),
    async () => {
      const service = directives();
      if (service === undefined) return unavailable();
      let rules: DirectiveRecord[];
      try {
        rules = await service.list();
      } catch {
        return notice("error", "規則現在讀不到,她的動作會先全部擋下。");
      }
      if (rules.length === 0) return notice("info", "目前沒有規則。");
      return cardReply([{ type: "text", text: rules.map(ruleLine).join("\n") }], {
        title: "規則",
      });
    },
  );
  registry.register(
    commandSpec("admin directive add", "建立一條規則", {
      permission: NODE_ADD,
      ephemeral: true,
      args: [
        argSpec("text", "規則內容", ArgKind.string),
        argSpec("effect", "效果", ArgKind.choice(DIRECTIVE_EFFECTS)),
        argSpec("capability", "動作,例如 game.start 或 game.*", ArgKind.string, {
          required: false,
        }),
        argSpec("activity", "事情,例如 minecraft", ArgKind.string, { required: false }),
        argSpec("minutes", "有效幾分鐘(主人可留空,就是直到解除)", ArgKind.integer, {
          required: false,
        }),
      ],
    }),
    async (inv) => {
      const service = directives();
      if (service === undefined) return unavailable();
      const effect = inv.str("effect");
      if (!isDirectiveEffect(effect)) {
        return notice("error", `效果要是 ${DIRECTIVE_EFFECTS.join("、")} 其中之一。`);
      }
      return answer(
        await service.add({
          by: { type: "account", subject: inv.subject() },
          text: inv.str("text") ?? "",
          effect,
          scope: scopeOf(inv),
          minutes: inv.int("minutes"),
          source_event: `command:${inv.path.join(" ")}`,
        }),
      );
    },
  );
  registry.register(
    commandSpec("admin directive remove", "解除一條規則", {
      permission: NODE_REMOVE,
      ephemeral: true,
      args: [argSpec("rule", "規則編號或規則裡的字", ArgKind.string)],
    }),
    async (inv) => {
      const service = directives();
      if (service === undefined) return unavailable();
      return answer(
        await service.remove({
          by: { type: "account", subject: inv.subject() },
          match: inv.str("rule"),
          source_event: `command:${inv.path.join(" ")}`,
        }),
      );
    },
  );
}

export function unregisterCommands(registry: CommandRegistry): void {
  for (const path of PATHS) registry.unregister(path);
}
