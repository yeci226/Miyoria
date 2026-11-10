// Minimal extension speaking the Miyoria extension protocol without the SDK.
// Behaviour is driven by the config sent in `initialize`.
import process from "node:process";

let buffer = Buffer.alloc(0);
let nextId = 1;
const pending = new Map();
let extId = "";
let game = null;

function send(message) {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function request(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const match = /content-length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString("ascii"));
    const length = Number(match[1]);
    if (buffer.length < end + 4 + length) return;
    const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
    buffer = buffer.subarray(end + 4 + length);
    void handle(JSON.parse(body));
  }
});
process.stdin.on("end", () => process.exit(0));

async function handle(msg) {
  if (msg.method === undefined) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(msg.error);
    else p.resolve(msg.result);
    return;
  }
  if (msg.id === undefined) {
    notification(msg.method, msg.params);
    return;
  }
  try {
    const result = await onRequest(msg.method, msg.params);
    if (result !== NEVER) send({ id: msg.id, result });
  } catch (error) {
    send({ id: msg.id, error: { code: -32603, message: String(error?.message ?? error) } });
  }
}

const NEVER = Symbol("never");

function notification(method, params) {
  if (method === "event") {
    void request("events.publish", {
      topic: `ext.${extId}.seen`,
      payload: { topic: params.topic },
    });
  } else if (method === "shutdown") {
    process.exit(0);
  }
}

async function onRequest(method, params) {
  switch (method) {
    case "initialize": {
      extId = params.extension.id;
      game = params.extension.game ?? null;
      const config = params.config ?? {};
      if (config.hang_init) return NEVER;
      process.stderr.write(`fixture ${extId} initializing\n`);
      if (config.dynamic) {
        setTimeout(async () => {
          let outcome;
          try {
            await request("tools.register", {
              name: config.dynamic_name ?? "dyn.tool",
              description: "dynamic",
            });
            outcome = { ok: true };
          } catch (error) {
            outcome = { ok: false, code: error.code, message: error.message };
          }
          await request("events.publish", {
            topic: `ext.${extId}.register_result`,
            payload: outcome,
          });
        }, 10);
        return { contributions: {} };
      }
      return {
        contributions: {
          tools: [
            {
              name: "echo.say",
              description: "Echoes text",
              parameters: { type: "object", properties: { text: { type: "string" } } },
            },
            { name: "slow.wait", description: "Never answers" },
            { name: "crash.now", description: "Exits the process" },
            { name: "try.publish", description: "Publishes on a topic" },
            { name: "store.roundtrip", description: "Writes and reads storage" },
            { name: "env.get", description: "Reports its environment" },
            ...(game
              ? [{ name: `game.${game}.id`, description: "Echoes the declared game id" }]
              : []),
          ],
          commands: [
            {
              path: ["fixture", "echo"],
              description: "Echo command",
              args: [
                { name: "text", description: "Text", kind: { type: "string" }, required: true },
              ],
              permission: "",
              ephemeral: false,
            },
          ],
          prompts: ["facts"],
          subscriptions: config.subscriptions ?? ["*"],
          ...(config.executor
            ? {
                executor: {
                  name: "Fixture",
                  goals: [
                    { name: "echo", description: "Ends at once", budget_s: 5 },
                    { name: "hang", description: "Never ends" },
                    { name: "crash", description: "Exits the process" },
                  ],
                  guide: "just a fixture",
                },
              }
            : {}),
        },
      };
    }
    case "task.start": {
      const task = params.task;
      const at = new Date().toISOString();
      const event = (e) =>
        send({ method: "task.event", params: { event: { task: task.id, at, ...e } } });
      event({ type: "started", goal: task.goal });
      if (task.goal === "echo") {
        event({ type: "progress", progress: 0.5, detail: "half" });
        event({ type: "done", detail: `echo ${JSON.stringify(task.args)}`, data: task.args });
        // A stale word after the end: the host drops it.
        event({ type: "failed", code: "internal", detail: "late" });
      } else if (task.goal === "crash") {
        setTimeout(() => process.exit(4), 10);
      } else if (task.goal !== "hang") {
        event({ type: "failed", code: "invalid", detail: `unknown goal ${task.goal}` });
      }
      return {};
    }
    case "task.cancel": {
      const at = new Date().toISOString();
      send({
        method: "task.event",
        params: {
          event: { type: "failed", task: params.task, code: "cancelled", detail: "cancelled", at },
        },
      });
      return {};
    }
    case "task.observe":
      return {
        at: new Date().toISOString(),
        state: { fixture: true },
        task: null,
        summary: "fixture",
      };
    case "tools.call": {
      const { name, args, context } = params;
      switch (name) {
        case "echo.say":
          return { content: `echo: ${args.text} from ${context.account.id}` };
        case `game.${game}.id`:
          return String(game);
        case "slow.wait":
          return NEVER;
        case "crash.now":
          setTimeout(() => process.exit(3), 10);
          return { content: "bye" };
        case "try.publish":
          try {
            await request("events.publish", { topic: args.topic, payload: {} });
            return "ok";
          } catch (error) {
            return `denied: ${error.code}`;
          }
        case "store.roundtrip": {
          await request("storage.set", { key: args.key, value: args.value });
          const got = await request("storage.get", { key: args.key });
          return JSON.stringify(got.value);
        }
        case "env.get":
          return JSON.stringify({
            names: Object.keys(process.env).sort(),
            secret: process.env.MIYORIA_TEST_SECRET ?? null,
            passed: process.env.MIYORIA_TEST_PASSED ?? null,
            set: process.env.MIYORIA_TEST_SET ?? null,
            rpc: process.env.MIYORIA_RPC ?? null,
            path: Boolean(process.env.PATH),
          });
        default:
          throw new Error(`unknown tool ${name}`);
      }
    }
    case "commands.invoke":
      return {
        text: `fixture: ${params.args.text} by ${params.invoker_display_name}`,
        ephemeral: true,
      };
    case "prompt.contribute":
      return {
        sections: [
          { key: params.key, title: "事實", body: `query=${params.request.query}`, order: 5 },
        ],
      };
    default:
      throw new Error(`unknown method ${method}`);
  }
}
