// Draws her Live2D model to PNGs in a headless browser on this machine: a small HTTP server on
// loopback serves the studio page (`dist/`), Live2D's files (`vendor/`) and the model folder, and
// Edge or Chrome (through playwright-core) opens the page and calls `studio.render`. The model
// never leaves the machine; only the PNG does.
//
// One browser is started on the first picture and kept warm for the next ones; pictures are drawn
// one at a time (the page has one canvas). A picture that takes longer than `timeoutMs` closes the
// browser, so a hung page cannot hold the queue: the next picture starts a new one. A browser that
// goes away on its own is started again the same way.
//
// Built two ways: the page with Vite (`dist/`), and this file for Node (`dist/node/render.js`),
// which the Core loads from this folder at run time (`packages/play/cards/src/live2d.ts`).

import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "playwright-core";
import type { ParameterInfo, PoseSpec } from "./studio.js";

export type { ParameterInfo, PoseSpec };

/** This package's folder (the one with `vendor.md`), from `src/` or from `dist/node/`. */
function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "vendor.md"))) return dir;
    dir = dirname(dir);
  }
  return resolve(fileURLToPath(new URL("..", import.meta.url)));
}

const ROOT = packageRoot();

/** What must be on this machine before a picture can be drawn, relative to this package. */
export const NEEDED_FILES = ["vendor/live2dcubismcore.min.js", "dist/index.html"] as const;

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
  /** A browser to run instead of a channel's (its executable). */
  executablePath?: string;
  /** Longest wait for one picture, including starting the browser. Default 60 s. */
  timeoutMs?: number;
  /** Where Live2D's files and the built page are; default this package's folder. */
  root?: string;
}

/** Why pictures cannot be drawn on this machine right now; `null` when they can be tried. */
export function missingFiles(options: Pick<StudioOptions, "modelDir" | "root">): string | null {
  const root = options.root ?? ROOT;
  const missing = NEEDED_FILES.filter((p) => !existsSync(join(root, p)));
  if (missing.length > 0) {
    return `card-studio is missing ${missing.join(", ")} (see tools/card-studio/vendor.md, then build it)`;
  }
  if (!existsSync(options.modelDir)) return `the model folder ${options.modelDir} does not exist`;
  return null;
}

/** Inside `base`, or `null` for a path that climbs out of it. */
function within(base: string, rel: string): string | null {
  const path = normalize(join(base, rel));
  return path === base || path.startsWith(base + sep) ? path : null;
}

/** A picture that took too long. */
export class StudioTimeout extends Error {
  override readonly name = "StudioTimeout";
}

/** Edge or Chrome cannot be started on this machine (not installed, or blocked). */
export class BrowserUnavailable extends Error {
  override readonly name = "BrowserUnavailable";
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new StudioTimeout(`${what} took longer than ${ms} ms`)), ms);
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

export class CardStudio {
  readonly #options: StudioOptions;
  #server: Server | null = null;
  #browser: Browser | null = null;
  #page: Page | null = null;
  #starting: Promise<Page> | null = null;
  #origin = "";
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: StudioOptions) {
    this.#options = options;
  }

  get #root(): string {
    return this.#options.root ?? ROOT;
  }

  /** Whether a browser is open and its page ready. */
  get warm(): boolean {
    return this.#page !== null && !this.#page.isClosed();
  }

  /** Starts the server and the browser (once); the page is ready when it resolves. */
  start(): Promise<Page> {
    if (this.#page && !this.#page.isClosed()) return Promise.resolve(this.#page);
    if (!this.#starting) {
      this.#starting = this.#launch().finally(() => {
        this.#starting = null;
      });
    }
    return this.#starting;
  }

  async #launch(): Promise<Page> {
    const missing = missingFiles({ modelDir: this.#options.modelDir, root: this.#root });
    if (missing !== null) throw new Error(missing);
    if (!this.#server) await this.#serve();
    let browser: Browser;
    try {
      browser = await chromium.launch({
        ...(this.#options.executablePath
          ? { executablePath: this.#options.executablePath }
          : { channel: this.#options.channel ?? "msedge" }),
        headless: true,
        args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
      });
    } catch (error) {
      throw new BrowserUnavailable(
        `cannot start ${this.#options.executablePath ?? this.#options.channel ?? "msedge"}: ${error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error)}`,
      );
    }
    try {
      this.#browser = browser;
      browser.on("disconnected", () => {
        if (this.#browser === browser) {
          this.#browser = null;
          this.#page = null;
        }
      });
      const page = await browser.newPage();
      page.on("console", (m) => {
        if (m.type() === "error" && !m.text().includes("404")) {
          console.error(`[studio] ${m.text()}`);
        }
      });
      await page.goto(`${this.#origin}/index.html`);
      await page.waitForFunction(() => window.studio?.ready === true);
      this.#page = page;
      return page;
    } catch (error) {
      await this.#closeBrowser();
      throw error;
    }
  }

  async #serve(): Promise<void> {
    const mounts: [string, string][] = [
      ["/vendor/", join(this.#root, "vendor")],
      ["/model/", resolve(this.#options.modelDir)],
      ["/", join(this.#root, "dist")],
    ];
    const server = createServer(async (req, res) => {
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
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const { port } = server.address() as AddressInfo;
    this.#server = server;
    this.#origin = `http://127.0.0.1:${port}`;
  }

  /** The picture as PNG bytes. One at a time: the page has one canvas. */
  render(spec: Omit<PoseSpec, "model"> & { model?: string }): Promise<Buffer> {
    const ms = this.#options.timeoutMs ?? 60_000;
    const run = async () => {
      try {
        return await withTimeout(this.#draw(spec), ms, "a card picture");
      } catch (error) {
        // A page that hung or broke is not used again: the next picture starts a new browser.
        await this.#closeBrowser();
        throw error;
      }
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  async #draw(spec: Omit<PoseSpec, "model"> & { model?: string }): Promise<Buffer> {
    const page = await this.start();
    const full: PoseSpec = { ...spec, model: `${this.#origin}/model/${spec.model ?? ""}` };
    const url = await page.evaluate((s) => window.studio.render(s), full);
    return Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  }

  /** The model's parameters and their ranges. */
  async parameters(model: string): Promise<ParameterInfo[]> {
    const page = await this.start();
    return page.evaluate((url) => window.studio.parameters(url), `${this.#origin}/model/${model}`);
  }

  async #closeBrowser(): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    this.#page = null;
    await browser?.close().catch(() => undefined);
  }

  async stop(): Promise<void> {
    await this.#starting?.catch(() => undefined);
    await this.#closeBrowser();
    const server = this.#server;
    this.#server = null;
    await new Promise<void>((ok) => (server ? server.close(() => ok()) : ok()));
  }
}
