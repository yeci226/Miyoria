import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ClientError } from "@miyoria/api";
import { afterEach, describe, expect, it } from "vitest";
import { checkArgs, helpText, main, parseArgs, UsageError } from "../src/cli.js";
import { rpcClient } from "../src/commands/remote.js";
import { type Output, setOutput } from "../src/ui.js";

describe("argument parsing", () => {
  it("finds_subcommands_and_global_options_anywhere", () => {
    const p = parseArgs(["config", "set", "-c", "x/miyoria.toml", "core.log", "debug", "--yes"]);
    expect(p.path.map((c) => c.name)).toEqual(["miyoria", "config", "set"]);
    expect(p.ctx.config).toBe("x/miyoria.toml");
    expect(p.ctx.yes).toBe(true);
    expect(p.ctx.args).toEqual(["core.log", "debug"]);
    expect(parseArgs(["status"]).ctx.config).toBe("miyoria.toml");
  });

  it("allows_hyphen_values_where_legacy_did", () => {
    const p = parseArgs(["config", "set", "modules.x.offset", "-1"]);
    expect(p.ctx.args).toEqual(["modules.x.offset", "-1"]);
    const q = parseArgs(["config", "set", "--env", "LLM_API_KEY", "--weird-value"]);
    expect(q.ctx.options.env).toBe("LLM_API_KEY");
    expect(q.ctx.args).toEqual(["--weird-value"]);
    expect(() => parseArgs(["status", "--nope"])).toThrow(UsageError);
  });

  it("checks_positionals_and_conflicts", () => {
    const run = (argv: string[]) => {
      const p = parseArgs(argv);
      checkArgs(p.path, p.ctx);
      return p;
    };
    expect(() => run(["module", "enable"])).toThrow("缺少參數 <id>");
    expect(() => run(["config", "get", "--env", "X", "core.log"])).toThrow(/不能和/);
    expect(() => run(["status", "extra"])).toThrow(/多了參數/);
    expect(run(["events", "agent.*", "platform.*"]).ctx.args).toEqual(["agent.*", "platform.*"]);
    expect(run(["decisions", "-l", "5"]).ctx.options.limit).toBe("5");
    expect(run(["chat"]).ctx.options.name).toBe("你");
  });

  it("prints_traditional_chinese_help", () => {
    const root = helpText(parseArgs([]).path);
    expect(root).toContain("用法:");
    expect(root).toContain("指令:");
    expect(root).toContain("init");
    expect(root).toContain("-V, --version");
    const set = helpText(parseArgs(["config", "set"]).path);
    expect(set).toContain("<KEY 值>...");
    expect(set).toContain("--env <NAME>");
    expect(set).not.toContain("--version");
  });
});

describe("main", () => {
  let out: string[] = [];
  let restore: (() => void) | undefined;
  afterEach(() => restore?.());
  const capture = () => {
    out = [];
    const sink: Output = { out: (t) => out.push(t), err: (t) => out.push(t) };
    restore = setOutput(sink);
  };

  it("exit_codes_and_helpful_errors", async () => {
    capture();
    expect(await main(["--help"])).toBe(0);
    expect(out.join("")).toContain("Miyoria — AI waifu 框架");
    expect(await main(["--version"])).toBe(0);
    expect(out.join("")).toMatch(/miyoria \d+\.\d+\.\d+/);
    expect(await main(["nope"])).toBe(2);
    expect(out.join("")).toContain("未知的指令 `nope`");
    out.length = 0;
    expect(await main(["status", "-c", "does/not/exist/miyoria.toml"])).toBe(1);
    expect(out.join("")).toContain("先執行 `miyoria init`");
  });
});

describe("admin API client", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("sends_the_token_and_reports_api_errors", async () => {
    const seen: string[] = [];
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${req.headers.authorization}`);
      if (req.url === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", version: "0.1.0" }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "unknown module `x`" }));
      }
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const rpc = rpcClient(`http://127.0.0.1:${port}`, "tok");
    expect(await rpc.health()).toEqual({ status: "ok", version: "0.1.0" });
    await expect(
      rpc.modules.action({ params: { id: "platform.discord.bot", action: "enable" } }),
    ).rejects.toThrow("unknown module `x`");
    expect(seen).toEqual([
      "GET /api/health Bearer tok",
      "POST /api/modules/platform.discord.bot/enable Bearer tok",
    ]);
  });

  it("calls_the_route_table_with_its_input_and_reports_its_errors", async () => {
    const seen: string[] = [];
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        seen.push(`${req.method} ${req.url} ${req.headers["content-type"]} ${body}`);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid persona section key `a b`" }));
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const rpc = rpcClient(`http://127.0.0.1:${port}`, "tok");
    const failed = await rpc.persona
      .set({ params: { key: "a b" }, body: { body: "hi", edited_by: "cli" } })
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(ClientError);
    expect((failed as ClientError).status).toBe(400);
    expect((failed as ClientError).message).toContain("invalid persona section key `a b`");
    expect(seen).toEqual([
      'PUT /api/persona/a%20b application/json {"body":"hi","edited_by":"cli"}',
    ]);
    const down = await rpcClient("http://127.0.0.1:1", "tok")
      .health()
      .catch((error: unknown) => error);
    expect((down as ClientError).kind).toBe("transport");
  });
});
