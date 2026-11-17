// Draws her Live2D model to PNGs in a headless browser on this machine: a small HTTP server on
// loopback serves the studio page (`dist/`), Live2D's files (`vendor/`) and the model folder, and
// Edge or Chrome (through playwright-core) opens the page and calls `studio.render`. The model
// never leaves the machine; only the PNG does.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import type { ParameterInfo, PoseSpec } from "./studio.js";

export type { ParameterInfo, PoseSpec };

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".frag": "text/plain; charset=utf-8",
  ".vert": "text/plain; charset=utf-8",
};

export interface StudioOptions {
  /** The folder holding the `.model3.json`, its `.moc3`, textures and physics. */
  modelDir: string;
  /** Browser channel for playwright-core: `msedge` (on every Windows) or `chrome`. */
  channel?: string;
}

/** Inside `base`, or `null` for a path that climbs out of it. */
function within(base: string, rel: string): string | null {
  const path = normalize(join(base, rel));
  return path === base || path.startsWith(base + sep) ? path : null;
}

export class CardStudio {
  #server: Server | null = null;
  #browser: Browser | null = null;
  #page: Page | null = null;
  #origin = "";
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: StudioOptions) {}

  async start(): Promise<void> {
    if (this.#page) return;
    const mounts: [string, string][] = [
      ["/vendor/", join(ROOT, "vendor")],
      ["/model/", resolve(this.options.modelDir)],
      ["/", join(ROOT, "dist")],
    ];
    this.#server = createServer(async (req, res) => {
      const url = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
      const mount = mounts.find(([prefix]) => url.startsWith(prefix));
      const rel = mount ? url.slice(mount[0].length) || "index.html" : "";
      const path = mount ? within(mount[1], rel) : null;
      try {
        if (path === null || !(await stat(path)).isFile()) throw new Error("not found");
        res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" });
        createReadStream(path).pipe(res);
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((ok) => this.#server?.listen(0, "127.0.0.1", ok));
    const { port } = this.#server.address() as AddressInfo;
    this.#origin = `http://127.0.0.1:${port}`;
    this.#browser = await chromium.launch({
      channel: this.options.channel ?? "msedge",
      headless: true,
      args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
    });
    this.#page = await this.#browser.newPage();
    this.#page.on("console", (m) => {
      if (!m.text().includes("404")) console.error(`[studio] ${m.type()} ${m.text()}`);
    });
    await this.#page.goto(`${this.#origin}/index.html`);
    await this.#page.waitForFunction(() => window.studio?.ready === true);
  }

  /** The picture as PNG bytes. One at a time: the page has one canvas. */
  render(spec: Omit<PoseSpec, "model"> & { model?: string }): Promise<Buffer> {
    const run = async () => {
      await this.start();
      const page = this.#page as Page;
      const full: PoseSpec = { ...spec, model: `${this.#origin}/model/${spec.model ?? ""}` };
      const url = await page.evaluate((s) => window.studio.render(s), full);
      return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  /** The model's parameters and their ranges. */
  async parameters(model: string): Promise<ParameterInfo[]> {
    await this.start();
    const page = this.#page as Page;
    return page.evaluate((url) => window.studio.parameters(url), `${this.#origin}/model/${model}`);
  }

  async stop(): Promise<void> {
    await this.#browser?.close();
    await new Promise<void>((ok) => (this.#server ? this.#server.close(() => ok()) : ok()));
    this.#browser = null;
    this.#page = null;
    this.#server = null;
  }
}
