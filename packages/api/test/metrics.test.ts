// `GET /metrics`: auth (`metrics_public`), the text format and the scrape-time families.

import { metrics, Supervisor, SupervisorKey } from "@miyoria/runtime/kernel";
import type { JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { ApiModule, METRICS_PATH } from "../src/index.js";
import { Idle } from "./support/fakes.js";

const TOKEN = "test-token";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

async function start(config: Record<string, JsonValue> = {}) {
  const sup = new Supervisor();
  sup.services.provide("kernel", SupervisorKey, sup);
  const api = new ApiModule({ env: () => undefined });
  await sup.register(api, { bind: "127.0.0.1:0", token: TOKEN, panel_dir: "", ...config }, true);
  await sup.register(new Idle("idle"), {}, true);
  await sup.startAll();
  cleanups.push(() => sup.stopAll());
  return { sup, url: `${api.url() ?? ""}${METRICS_PATH}` };
}

describe("metrics", () => {
  it("needs the token unless metrics_public", async () => {
    const { url } = await start();
    expect((await fetch(url)).status).toBe(401);
    const wrong = await fetch(url, { headers: { authorization: "Bearer nope" } });
    expect(wrong.status).toBe(401);
    const ok = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    await ok.text();

    const open = await start({ metrics_public: true });
    const res = await fetch(open.url);
    expect(res.status).toBe(200);
    await res.text();
    // Other methods: 405 like every route.
    expect((await fetch(open.url, { method: "POST" })).status).toBe(405);
  });

  it("serves module states, process and registry metrics", async () => {
    const counter = metrics.counter("test_api_scrape_total", { help: "Test counter." });
    counter.inc();
    const { url, sup } = await start({ metrics_public: true });
    await sup.disable("idle");
    const text = await (await fetch(url)).text();
    const lines = text.split("\n");
    expect(lines).toContain("# TYPE miyoria_module_state gauge");
    expect(lines).toContain('miyoria_module_state{module="api",state="running"} 1');
    expect(lines).toContain('miyoria_module_state{module="api",state="failed"} 0');
    expect(lines).toContain('miyoria_module_state{module="idle",state="disabled"} 1');
    expect(lines).toContain('miyoria_module_enabled{module="idle"} 0');
    expect(lines).toContain('miyoria_module_recent_restarts{module="api"} 0');
    expect(text).toMatch(/^miyoria_process_uptime_seconds \d/m);
    expect(text).toMatch(/^process_resident_memory_bytes \d+$/m);
    expect(text).toMatch(/^nodejs_heap_size_used_bytes \d+$/m);
    expect(text).toMatch(/^miyoria_build_info\{version="[^"]+"\} 1$/m);
    expect(lines).toContain("test_api_scrape_total 1");
    // The bus counts what the supervisor published.
    expect(text).toMatch(/^miyoria_bus_events_published_total\{prefix="system"\} \d+$/m);
    // Every family has one HELP and TYPE header.
    const types = lines.filter((l) => l.startsWith("# TYPE "));
    expect(new Set(types).size).toBe(types.length);
    expect(text.endsWith("\n")).toBe(true);
  });
});
