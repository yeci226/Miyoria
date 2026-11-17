import { defineExtension, Events } from "@miyoria/sdk";

interface HelloConfig {
  greeting?: string;
  max_dice?: number;
}

export default defineExtension({
  async activate(ctx) {
    const config = ctx.config as HelloConfig;
    const greeting = config.greeting ?? "哈囉";
    const maxDice = config.max_dice ?? 10;

    await ctx.tools.register({
      name: "dice",
      description: "擲骰子。可以指定面數與顆數,回傳每顆的點數和總和。",
      params: {
        sides: { type: "integer", minimum: 2, maximum: 1000, description: "骰子面數,預設 6" },
        count: { type: "integer", minimum: 1, description: "擲幾顆,預設 1" },
      },
      optional: ["sides", "count"],
      run: ({ sides, count }) => {
        const s = clamp(Number(sides ?? 6), 2, 1000);
        const n = clamp(Number(count ?? 1), 1, maxDice);
        const rolls = Array.from({ length: n }, () => 1 + Math.floor(Math.random() * s));
        const total = rolls.reduce((a, b) => a + b, 0);
        return `擲了 ${n} 顆 ${s} 面骰:${rolls.join("、")}(總和 ${total})`;
      },
    });

    await ctx.commands.register({
      path: "hello",
      description: "跟 Miyoria 打招呼",
      args: [{ name: "name", description: "要打招呼的對象", required: false }],
      run: (inv) => {
        const name = typeof inv.args.name === "string" ? inv.args.name : inv.invoker_display_name;
        return `${greeting},${name}!`;
      },
    });

    // By definition: the handler gets `agent.turn.completed` with `data` typed as its payload.
    // The manifest grants it (`[permissions] events`).
    let turns = 0;
    ctx.events.on(Events.AgentTurnCompleted, (envelope) => {
      turns += 1;
      if (turns % 100 === 0) {
        ctx.log.info("she has talked a lot today", { turns, last: envelope.data.text.slice(0, 40) });
      }
    });

    ctx.log.info("hello extension activated", { greeting, maxDice });
  },
});

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
