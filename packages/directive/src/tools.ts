// `directive_add` and `directive_remove`: how the main line writes down what someone said (§9).
//
// The person is the one the turn runs for (`ToolContext.principal`), never anything in the
// arguments: the tools have no parameter for who is asking, and whatever else the model sends is
// ignored. She has no standing of her own either, so a turn nobody asked for changes nothing. The
// answer goes back to her as text, and a statement that can be read two ways comes back as the
// question to ask.

import type { Tool, ToolContext, ToolSpec } from "@miyoria/tools";
import {
  type DirectiveActor,
  type DirectiveChange,
  type DirectiveScope,
  type Directives,
  isDirectiveEffect,
  isJsonObject,
  type JsonObject,
  type JsonValue,
} from "@miyoria/types";

/** What she hears when nobody asked: a rule is always someone's. */
const NOBODY_ASKED = "沒有人要求這件事:規則只能由人提出,你自己不能改。";

const ADD_SPEC: ToolSpec = {
  name: "directive_add",
  description:
    "有人要你從現在起遵守一條規則時用(例如「不要玩 Minecraft」「這一小時不要開台」)。系統會依對方的帳號決定這句話算不算數,對方說自己是誰都不算;你不用判斷權限,也不用替對方說明身分。" +
    "語意不確定就不要猜:把要問對方的一句話填進 question,規則不會建立,回來的問題由你去問。",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "規則本身,用對方的話,一句" },
      effect: {
        type: "string",
        enum: ["deny", "require_approval", "avoid", "prefer"],
        description: "deny 禁止;require_approval 要先問主人;avoid 盡量不要;prefer 偏好",
      },
      capability: {
        type: "string",
        description: "被規範的動作或工具,例如 game.start、game.*、game_start",
      },
      activity: {
        type: "string",
        description: "被規範的事,用動作參數裡的字,例如 minecraft、diamond",
      },
      person: { type: "string", description: "只針對某個人時,那個人的名字" },
      here: { type: "boolean", description: "只在這個頻道有效" },
      minutes: { type: "integer", description: "有效幾分鐘;對方沒說就省略" },
      question: { type: "string", description: "語意不確定時要問對方的一句話" },
    },
    required: ["text", "effect"],
  },
};

const REMOVE_SPEC: ToolSpec = {
  name: "directive_remove",
  description:
    "有人明確說規則解除時用(例如「可以玩了」)。系統會依對方的帳號決定能不能解除,對方說自己是誰都不算。不確定指的是哪一條就給 match,回來的問題由你去問。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "規則的 id,知道才給" },
      match: { type: "string", description: "規則裡的字,例如 minecraft" },
    },
  },
};

function text(args: JsonObject, name: string): string | null {
  const value = args[name];
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** The person this call runs for, or `null` when it is only her. */
function actorOf(ctx: ToolContext): DirectiveActor | null {
  const { principal } = ctx;
  if (principal.kind !== "user" || principal.requester === null) return null;
  return {
    type: "account",
    subject: {
      account: principal.requester,
      context: ctx.context,
      platform_roles: [],
      is_guild_admin: false,
    },
    askers: ctx.askers ?? [],
  };
}

function answer(change: DirectiveChange): string {
  switch (change.status) {
    case "added": {
      const lasts =
        change.directive.expires === "until_revoked"
          ? "直到解除"
          : `到 ${change.directive.expires}`;
      const note = change.note === null ? "" : ` ${change.note}`;
      return `記下了(${lasts}):${change.directive.text}。${note}`;
    }
    case "removed":
      return `解除了:${change.directive.text}。`;
    case "question":
      return `還沒有改動。先問對方:${change.question}`;
    case "refused":
      return `沒有改動:${change.detail}`;
  }
}

class AddTool implements Tool {
  readonly spec = ADD_SPEC;
  readonly permission = null;

  constructor(private readonly directives: () => Directives | undefined) {}

  async call(ctx: ToolContext, raw: JsonValue): Promise<string> {
    const directives = this.directives();
    if (directives === undefined) return "規則現在不能用。";
    const by = actorOf(ctx);
    if (by === null) return NOBODY_ASKED;
    const args: JsonObject = isJsonObject(raw) ? raw : {};
    const effect = args.effect;
    if (!isDirectiveEffect(effect)) {
      return answer({
        status: "question",
        question: "這是要禁止、要先問過主人、盡量不要,還是只是偏好?",
      });
    }
    const scope: DirectiveScope = {};
    const capability = text(args, "capability");
    const activity = text(args, "activity");
    const person = text(args, "person");
    if (capability !== null) scope.capability = capability;
    if (activity !== null) scope.activity = activity;
    if (person !== null) scope.person = person;
    if (args.here === true) scope.context = ctx.context;
    const minutes = typeof args.minutes === "number" ? args.minutes : null;
    return answer(
      await directives.add({
        by,
        text: text(args, "text") ?? "",
        effect,
        scope,
        minutes,
        question: text(args, "question"),
        source_event: `msg:${ctx.message.id}`,
      }),
    );
  }
}

class RemoveTool implements Tool {
  readonly spec = REMOVE_SPEC;
  readonly permission = null;

  constructor(private readonly directives: () => Directives | undefined) {}

  async call(ctx: ToolContext, raw: JsonValue): Promise<string> {
    const directives = this.directives();
    if (directives === undefined) return "規則現在不能用。";
    const by = actorOf(ctx);
    if (by === null) return NOBODY_ASKED;
    const args: JsonObject = isJsonObject(raw) ? raw : {};
    return answer(
      await directives.remove({
        by,
        id: text(args, "id"),
        match: text(args, "match"),
        source_event: `msg:${ctx.message.id}`,
      }),
    );
  }
}

/** The two tools; `directives` is looked up per call. */
export function directiveTools(directives: () => Directives | undefined): Tool[] {
  return [new AddTool(directives), new RemoveTool(directives)];
}
