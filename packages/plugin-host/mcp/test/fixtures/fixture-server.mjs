// A tiny MCP server over stdio used by the integration tests.
//
// Tools: echo, big, slow, fail, crash, image, env, cwd, grow, read_a, danger_delete,
// dotted.name. `grow` adds the tool `extra` and sends `notifications/tools/list_changed`.
// With `FIXTURE_EXIT_AT_START=1` the process prints to stderr and exits before the handshake.

import process from "node:process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

if (process.env.FIXTURE_EXIT_AT_START) {
  process.stderr.write("fixture refuses to start\n");
  process.exit(1);
}

let grown = false;

const tool = (name, description, properties, extra = {}) => ({
  name,
  description,
  inputSchema: { type: "object", properties },
  ...extra,
});

const server = new Server(
  { name: "fixture", version: "0.0.1" },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools = [
    tool("echo", "Echoes `text`.", { text: { type: "string" } }),
    tool("big", "Returns `n` x characters.", { n: { type: "integer" } }),
    tool("slow", "Sleeps `ms` then answers.", { ms: { type: "integer" } }),
    tool("fail", "Always reports a tool error.", {}),
    tool("crash", "Exits the process.", {}),
    tool("image", "Returns text plus an image.", {}),
    tool("env", "Reads environment variable `name`.", { name: { type: "string" } }),
    tool("cwd", "Returns the working directory.", {}),
    tool("grow", "Adds the `extra` tool and notifies.", {}),
    tool(
      "read_a",
      "A read tool.",
      {},
      {
        inputSchema: {
          $schema: "http://json-schema.org/draft-07/schema#",
          title: "ReadA",
          type: "object",
          properties: {
            title: {
              type: "string",
              title: "Title",
              examples: ["x"],
              description: "What to read.",
            },
          },
        },
        annotations: { readOnlyHint: true },
      },
    ),
    tool("danger_delete", "A dangerous tool.", {}),
    tool("dotted.name", "Name needing sanitizing.", {}),
  ];
  if (grown) tools.push(tool("extra", "Appears after `grow`.", {}));
  return { tools };
});

const text = (s) => ({ content: [{ type: "text", text: s }] });

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = request.params.arguments ?? {};
  switch (request.params.name) {
    case "echo":
      return text(typeof args.text === "string" ? args.text : "");
    case "big":
      return text("x".repeat(Number(args.n ?? 0)));
    case "slow":
      await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 0)));
      return text("done");
    case "fail":
      return { content: [{ type: "text", text: "it broke" }], isError: true };
    case "crash":
      process.exit(3);
      break;
    case "image":
      return {
        content: [
          { type: "text", text: "caption" },
          { type: "image", data: "AAAA", mimeType: "image/png" },
        ],
      };
    case "env":
      return text(process.env[String(args.name ?? "")] ?? "<unset>");
    case "cwd":
      return text(process.cwd());
    case "grow":
      grown = true;
      await server.sendToolListChanged();
      return text("grown");
    default:
      return text(`called ${request.params.name}`);
  }
});

await server.connect(new StdioServerTransport());
