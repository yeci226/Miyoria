// The OpenAI-compatible embedder against a local HTTP mock.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildEmbedder,
  type EmbeddingConfig,
  embeddingConfig,
  memoryConfig,
  OpenAiCompatibleEmbedder,
} from "../src/index.js";
import { closeAll, envWith, t0 } from "./helpers.js";

interface Seen {
  bodies: { model?: unknown; dimensions?: unknown; input?: unknown }[];
  auth: (string | null)[];
}

const servers: Server[] = [];

async function serve(): Promise<[string, Seen]> {
  const seen: Seen = { bodies: [], auth: [] };
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.method !== "POST" || req.url !== "/v1/embeddings") {
        res.writeHead(404).end();
        return;
      }
      seen.auth.push(req.headers.authorization ?? null);
      const body = JSON.parse(raw) as { input: string[] };
      seen.bodies.push(body);
      res.setHeader("content-type", "application/json");
      if (body.input.includes("boom")) {
        res.writeHead(500).end(JSON.stringify({ error: "boom" }));
        return;
      }
      // Answer in reverse order with explicit indexes.
      const data = body.input
        .map((text, i) => ({ index: i, embedding: [[...text].length, 1] }))
        .reverse();
      res.writeHead(200).end(JSON.stringify({ data, model: "m" }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return [`http://127.0.0.1:${port}/v1/`, seen];
}

function config(baseUrl: string): EmbeddingConfig {
  return embeddingConfig({
    provider: "openai-compatible",
    base_url: baseUrl,
    api_key: "sk-test",
    model: "bge-m3",
    dimensions: 2,
    timeout_secs: 5,
    batch_size: 2,
  });
}

afterEach(async () => {
  await closeAll();
  for (const s of servers.splice(0)) await new Promise((resolve) => s.close(resolve));
});

describe("embedder", () => {
  it("embeds_in_batches_and_orders_by_index", async () => {
    const [url, seen] = await serve();
    const embedder = new OpenAiCompatibleEmbedder(config(url));
    const out = await embedder.embed(["a", "bb", "ccc"]);
    expect(out).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
    ]);

    expect(seen.bodies, "batch_size 2 → two requests").toHaveLength(2);
    expect(seen.bodies[0]?.model).toBe("bge-m3");
    expect(seen.bodies[0]?.dimensions).toBe(2);
    expect(seen.bodies[0]?.input).toEqual(["a", "bb"]);
    expect(seen.bodies[1]?.input).toEqual(["ccc"]);
    expect(seen.auth.every((a) => a === "Bearer sk-test")).toBe(true);

    await expect(embedder.embed(["boom"])).rejects.toThrow(/500/);
  });

  it("builds_from_config", async () => {
    expect(buildEmbedder(embeddingConfig()).enabled).toBe(false);
    expect(() => buildEmbedder(embeddingConfig({ provider: "openai-compatible" }))).toThrow();
    expect(() => buildEmbedder(embeddingConfig({ provider: "magic" }))).toThrow();

    // Engine-level: stored records get vectors; a failing server only costs the vector, not
    // the memory.
    const [url] = await serve();
    const embedder = buildEmbedder(config(url));
    expect(embedder.name).toBe("openai-compatible");
    const e = await envWith("fake", memoryConfig(), null, embedder);
    let id = await e.add("fact", { type: "global" }, [], "Owen 喜歡拉麵", 0.5, t0());
    expect((await e.rec(id))?.embedding).toEqual([9, 1]);
    id = await e.add("fact", { type: "global" }, [], "boom", 0.5, t0());
    expect((await e.rec(id))?.embedding).toBeNull();
  });

  it("never shows the api key", () => {
    const embedder = new OpenAiCompatibleEmbedder(config("http://127.0.0.1:1/v1"));
    expect(JSON.stringify(embedder)).not.toContain("sk-test");
    expect(inspect(embedder)).not.toContain("sk-test");
    expect(embedder.url).toBe("http://127.0.0.1:1/v1/embeddings");
  });

  it("stops when the signal aborts", async () => {
    const server = createServer(() => {
      // never answers
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const embedder = new OpenAiCompatibleEmbedder(config(`http://127.0.0.1:${port}/v1`));
    const controller = new AbortController();
    const pending = embedder.embed(["a"], controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow();
    server.closeAllConnections();
  });
});
