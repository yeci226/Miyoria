// `/help`: the commands the invoker may run, by category. Also answers "is she awake?" (it
// replaced `/ping`).

import { type ComponentInvocation, ComponentResult, componentId } from "./components.js";
import type { CommandRegistry } from "./registry.js";
import { type CardBlock, type CommandReply, cardReply, notice } from "./reply.js";
import { type CommandSpec, commandSpec, type Invocation } from "./spec.js";
import { CATEGORY_ORDER } from "./tree.js";

export const HELP_NODE = "help";

const R = { category: "help:category", overview: "help:overview" } as const;

interface Category {
  name: string;
  description: string;
  specs: CommandSpec[];
}

function categories(registry: CommandRegistry, specs: readonly CommandSpec[]): Category[] {
  const byName = new Map<string, Category>();
  for (const spec of specs) {
    const name = spec.path[0] as string;
    let category = byName.get(name);
    if (!category) {
      const description =
        spec.path.length === 1 ? spec.description : (registry.groupDescription(name) ?? name);
      category = { name, description, specs: [] };
      byName.set(name, category);
    }
    category.specs.push(spec);
  }
  const rank = (name: string) => {
    const i = CATEGORY_ORDER.indexOf(name);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  return [...byName.values()].sort(
    (a, b) => rank(a.name) - rank(b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

function usage(spec: CommandSpec): string {
  const args = spec.args.map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
  return `\`/${spec.path.join(" ")}${args === "" ? "" : ` ${args}`}\``;
}

function selectBlock(list: readonly Category[], current: string | null): CardBlock {
  return {
    type: "select",
    select: {
      id: componentId(R.category),
      placeholder: "選擇分類",
      options: list.slice(0, 25).map((c) => ({
        label: `/${c.name}`,
        value: c.name,
        description: truncate(c.description, 100),
        default: c.name === current,
      })),
    },
  };
}

function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("")}…`;
}

const FOOTER = "她目前在線上。這裡只列出你可以使用的指令。";

function overview(list: readonly Category[]): CommandReply {
  if (list.length === 0) return notice("info", "目前沒有你可以使用的指令。");
  const lines = list.map((c) => `**/${c.name}**　${c.description}（${c.specs.length} 個指令）`);
  return cardReply(
    [
      { type: "text", text: lines.join("\n") },
      selectBlock(list, null),
      { type: "muted", text: FOOTER },
    ],
    { title: "指令說明", accent: "brand", session: {} },
  );
}

function categoryPage(list: readonly Category[], name: string): CommandReply {
  const category = list.find((c) => c.name === name);
  if (!category) return overview(list);
  const lines = category.specs.map((s) => `${usage(s)}\n-# ${s.description}`);
  return cardReply(
    [
      { type: "text", text: `${category.description}\n\n${lines.join("\n")}` },
      selectBlock(list, category.name),
      {
        type: "buttons",
        buttons: [{ id: componentId(R.overview), label: "回到總覽", style: "secondary" }],
      },
    ],
    { title: `/${category.name}`, accent: "brand", session: {} },
  );
}

/** Registers `/help`. */
export function registerHelp(registry: CommandRegistry): void {
  const list = async (inv: Invocation) =>
    categories(registry, await registry.permitted(inv, { panels: true }));
  registry.register(
    commandSpec("help", "列出你可以使用的指令，也可以確認她是否在線上", {
      permission: HELP_NODE,
    }),
    async (inv) => overview(await list(inv)),
    {
      components: [
        {
          route: R.overview,
          handle: async (inv: ComponentInvocation) =>
            ComponentResult.update(overview(await list(inv))),
        },
        {
          route: R.category,
          handle: async (inv: ComponentInvocation) =>
            ComponentResult.update(categoryPage(await list(inv), inv.values[0] ?? "")),
        },
      ],
    },
  );
}
