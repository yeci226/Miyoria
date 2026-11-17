// A small stand-in for ComfyUI's HTTP API, enough for the service: it accepts graphs, "runs" each
// one when the test says so (or at once), and serves what the SaveImage nodes saved.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ComfyGraph } from "../src/comfy.js";

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

export interface FakeRun {
  id: string;
  graph: ComfyGraph;
  client: string;
  state: "pending" | "success" | "error";
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export class FakeComfy {
  readonly runs: FakeRun[] = [];
  readonly frees: number[] = [];
  readonly interrupts: string[] = [];
  readonly uploads: string[] = [];
  readonly files: Record<string, string[]> = {
    diffusion_models: [
      "krea2_turbo_fp8_scaled.safetensors",
      "moss_image_sft_int8_convrot.safetensors",
      "anima-base-v1.0.safetensors",
    ],
    text_encoders: [
      "qwen3vl_4b_fp8_scaled.safetensors",
      "qwen3.5_9b_w4a8_gptq.safetensors",
      "qwen_3_06b_base.safetensors",
    ],
    vae: ["qwen_image_vae.safetensors", "flux2-vae_small.safetensors"],
    loras: ["anima-turbo-lora-v0.2.safetensors", "her.safetensors"],
  };
  /** Finish runs as soon as they are queued. */
  auto = true;
  /** Answer every request with 503 (ComfyUI down). */
  down = false;
  /** Refuse the next graph with node_errors. */
  refuse = false;
  /** Fail the next run with an execution error. */
  failNext = false;
  #server: Server | null = null;
  url = "";

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      void this.#handle(req)
        .then(([status, payload, type]) => {
          res.writeHead(status, { "content-type": type });
          res.end(payload);
        })
        .catch((error: unknown) => {
          res.writeHead(500);
          res.end(String(error));
        });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, "127.0.0.1", resolve));
    const { port } = this.#server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  /** Finishes every pending run. */
  finish(state: "success" | "error" = "success"): void {
    for (const r of this.runs) if (r.state === "pending") r.state = state;
  }

  async #handle(req: IncomingMessage): Promise<[number, string | Uint8Array, string]> {
    const json = (v: unknown, status = 200): [number, string, string] => [
      status,
      JSON.stringify(v),
      "application/json",
    ];
    if (this.down) return [503, "down", "text/plain"];
    const url = new URL(req.url ?? "/", "http://x");
    const path = url.pathname;
    if (path === "/system_stats") {
      return json({
        system: { comfyui_version: "0.9.0" },
        devices: [{ name: "cuda:0", vram_total: 24 * 1024 ** 3, vram_free: 20 * 1024 ** 3 }],
      });
    }
    if (path.startsWith("/models/")) return json(this.files[path.slice(8)] ?? []);
    if (path === "/prompt" && req.method === "POST") {
      const b = JSON.parse((await body(req)).toString()) as {
        prompt: ComfyGraph;
        client_id: string;
        prompt_id?: string;
      };
      if (this.refuse) {
        this.refuse = false;
        return json(
          {
            error: { message: "Prompt outputs failed validation" },
            node_errors: { "1": { class_type: "UNETLoader", errors: [{ message: "bad file" }] } },
          },
          400,
        );
      }
      const id = b.prompt_id ?? `p${this.runs.length + 1}`;
      const run: FakeRun = { id, graph: b.prompt, client: b.client_id, state: "pending" };
      if (this.failNext) {
        this.failNext = false;
        run.state = "error";
      } else if (this.auto) run.state = "success";
      this.runs.push(run);
      return json({ prompt_id: id, number: this.runs.length, node_errors: {} });
    }
    if (path.startsWith("/history/")) {
      const id = decodeURIComponent(path.slice(9));
      const run = this.runs.find((r) => r.id === id);
      if (!run || run.state === "pending") return json({});
      const outputs: Record<string, unknown> = {};
      for (const [node, n] of Object.entries(run.graph)) {
        if (n.class_type !== "SaveImage") continue;
        outputs[node] = {
          images: [
            {
              filename: `${String(n.inputs.filename_prefix)}_00001_.png`,
              subfolder: "",
              type: "output",
            },
            { filename: "preview.png", subfolder: "", type: "temp" },
          ],
        };
      }
      const status =
        run.state === "error"
          ? {
              status_str: "error",
              completed: false,
              messages: [
                [
                  "execution_error",
                  { node_id: "5", node_type: "KSampler", exception_message: "CUDA out of memory" },
                ],
              ],
            }
          : { status_str: "success", completed: true, messages: [] };
      return json({ [id]: { outputs, status } });
    }
    if (path === "/queue" && req.method === "GET") {
      return json({
        queue_running: [],
        queue_pending: this.runs
          .filter((r) => r.state === "pending")
          .map((r, i) => [i, r.id, {}, {}, []]),
      });
    }
    if (path === "/queue" && req.method === "POST") {
      await body(req);
      return json({});
    }
    if (path === "/view") return [200, PNG, "image/png"];
    if (path === "/upload/image") {
      const raw = (await body(req)).toString("latin1");
      const name = /filename="([^"]+)"/.exec(raw)?.[1] ?? "x.png";
      this.uploads.push(name);
      return json({ name, subfolder: "miyoria", type: "input" });
    }
    if (path === "/free") {
      await body(req);
      this.frees.push(Date.now());
      return json({});
    }
    if (path === "/interrupt") {
      const b = (await body(req)).toString();
      this.interrupts.push(b);
      return json({});
    }
    return [404, "not found", "text/plain"];
  }
}
