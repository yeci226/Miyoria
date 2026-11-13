// HTTP and WebSocket client of a ComfyUI server (its built-in API, `server.py`): queue a graph in
// API format, follow it, fetch what it saved, upload input pictures, and manage the server's
// queue and memory. Everything the server sends back is untrusted and parsed with zod.
//
// * `POST /prompt` queues a graph; a graph the server cannot run comes back as `400` with
//   `node_errors`, which is a `ComfyError` with `kind: "invalid"` (retrying will not help).
// * Completion is read from `GET /history/{prompt_id}`; progress comes from the WebSocket
//   (`/ws?clientId=`), which is optional: when it cannot be opened the job still finishes.
// * `POST /free` unloads the models so the speech and song workers get the VRAM back.

import { errorMessage, sleep } from "@miyoria/kernel";
import type { JsonValue } from "@miyoria/types";
import { z } from "zod";

/** A graph in ComfyUI's API format: node id → `{ class_type, inputs }`. */
export type ComfyGraph = Record<string, ComfyNode>;

export interface ComfyNode {
  class_type: string;
  inputs: Record<string, JsonValue>;
  _meta?: { title?: string };
}

/** `unreachable`: no answer (retry later). `invalid`: the server refused the graph. */
export type ComfyErrorKind = "unreachable" | "invalid" | "failed" | "protocol";

export class ComfyError extends Error {
  override readonly name = "ComfyError";
  constructor(
    message: string,
    readonly kind: ComfyErrorKind,
    readonly status: number | null = null,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const QueuedSchema = z.object({
  prompt_id: z.string(),
  number: z.number().optional(),
  node_errors: z.record(z.string(), z.unknown()).optional(),
});

const ImageRefSchema = z.object({
  filename: z.string(),
  subfolder: z.string().catch(""),
  type: z.string().catch("output"),
});
export type ComfyImageRef = z.output<typeof ImageRefSchema>;

const HistoryEntrySchema = z.object({
  outputs: z
    .record(
      z.string(),
      z.looseObject({ images: z.array(ImageRefSchema).optional().catch(undefined) }),
    )
    .catch({}),
  status: z
    .object({
      status_str: z.string().catch(""),
      completed: z.boolean().catch(false),
      messages: z.array(z.unknown()).catch([]),
    })
    .optional()
    .catch(undefined),
});

/** What the history says about one run. */
export interface ComfyRun {
  /** `success` and `error` are final; `running` is in the history but not finished. */
  status: "success" | "error" | "running";
  /** Saved pictures by output node id, in node order. */
  images: { node: string; image: ComfyImageRef }[];
  /** The server's message when it failed (node, exception). */
  error: string | null;
}

const StatsSchema = z.object({
  system: z.looseObject({ comfyui_version: z.string().optional().catch(undefined) }).catch({}),
  devices: z
    .array(
      z.looseObject({
        name: z.string().catch(""),
        vram_total: z.number().catch(0),
        vram_free: z.number().catch(0),
      }),
    )
    .catch([]),
});

export interface ComfyStats {
  version: string | null;
  devices: { name: string; vram_total_mb: number; vram_free_mb: number }[];
}

const QueueEntrySchema = z.array(z.unknown());
const QueueSchema = z.object({
  queue_running: z.array(QueueEntrySchema).catch([]),
  queue_pending: z.array(QueueEntrySchema).catch([]),
});

/** Prompt ids the server is running and has waiting. */
export interface ComfyQueue {
  running: string[];
  pending: string[];
}

const UploadSchema = z.object({
  name: z.string(),
  subfolder: z.string().catch(""),
  type: z.string().catch("input"),
});

/** A progress message of the WebSocket, for one prompt. */
export type ComfyProgress =
  | { type: "executing"; node: string | null }
  | { type: "progress"; node: string | null; value: number; max: number }
  | { type: "cached"; nodes: string[] }
  | { type: "error"; message: string };

const WsMessageSchema = z.object({ type: z.string(), data: z.record(z.string(), z.unknown()) });

export interface ComfyClientOptions {
  /** Base URL, e.g. `http://127.0.0.1:8188`. */
  url: string;
  /** Extra headers on every request (a token for a reverse proxy in front of ComfyUI). */
  headers?: Record<string, string>;
  /** Per-request timeout of the plain HTTP calls (not of a run). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** WebSocket constructor; `null` turns progress off (tests, servers behind a plain proxy). */
  webSocket?: typeof WebSocket | null;
}

const MB = 1024 * 1024;

interface RequestOptions {
  method?: string;
  body?: FormData | string;
  json?: unknown;
  signal?: AbortSignal | undefined;
}

/** Joins ComfyUI's message list of a failed run into one line. */
function historyError(messages: unknown[]): string | null {
  for (const m of messages) {
    if (!Array.isArray(m) || m[0] !== "execution_error") continue;
    const data = m[1] as Record<string, unknown> | undefined;
    if (!data || typeof data !== "object") continue;
    const node = typeof data.node_type === "string" ? data.node_type : String(data.node_id ?? "?");
    const text =
      typeof data.exception_message === "string" ? data.exception_message.trim() : "failed";
    return `${node}: ${text}`.slice(0, 500);
  }
  return null;
}

/** First lines of a `node_errors` object, for a readable error. */
function nodeErrorText(errors: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [node, value] of Object.entries(errors)) {
    const v = value as { class_type?: unknown; errors?: unknown } | null;
    const list = Array.isArray(v?.errors) ? v.errors : [];
    const first = list[0] as { message?: unknown; details?: unknown } | undefined;
    const what = [first?.message, first?.details].filter((x) => typeof x === "string").join(": ");
    lines.push(`${node} (${String(v?.class_type ?? "?")}): ${what || "invalid"}`);
    if (lines.length >= 5) break;
  }
  return lines.join("; ");
}

export class ComfyClient {
  readonly url: string;
  readonly #headers: Record<string, string>;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #webSocket: typeof WebSocket | null;

  constructor(options: ComfyClientOptions) {
    this.url = options.url.replace(/\/+$/, "");
    this.#headers = options.headers ?? {};
    this.#timeoutMs = options.timeoutMs ?? 30_000;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#webSocket =
      options.webSocket === undefined ? (globalThis.WebSocket ?? null) : options.webSocket;
  }

  async #request(path: string, init: RequestOptions = {}): Promise<Response> {
    const signals = [AbortSignal.timeout(this.#timeoutMs)];
    if (init.signal) signals.push(init.signal);
    const headers: Record<string, string> = { ...this.#headers };
    let body = init.body;
    if (init.json !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(init.json);
    }
    try {
      return await this.#fetch(`${this.url}${path}`, {
        method: init.method ?? (body === undefined ? "GET" : "POST"),
        headers,
        ...(body === undefined ? {} : { body }),
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ComfyError(`ComfyUI is unreachable: ${errorMessage(error)}`, "unreachable", null, {
        cause: error,
      });
    }
  }

  async #json(path: string, init?: RequestOptions): Promise<unknown> {
    const res = await this.#request(path, init);
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 300);
      throw new ComfyError(
        `ComfyUI ${path} answered ${res.status}${text ? `: ${text}` : ""}`,
        res.status >= 500 ? "unreachable" : "protocol",
        res.status,
      );
    }
    try {
      return await res.json();
    } catch (error) {
      throw new ComfyError(`ComfyUI ${path} sent no JSON`, "protocol", res.status, {
        cause: error,
      });
    }
  }

  /** Version and devices (`GET /system_stats`). */
  async stats(signal?: AbortSignal): Promise<ComfyStats> {
    const raw = StatsSchema.parse(await this.#json("/system_stats", { signal }));
    return {
      version: raw.system.comfyui_version ?? null,
      devices: raw.devices.map((d) => ({
        name: d.name,
        vram_total_mb: Math.round(d.vram_total / MB),
        vram_free_mb: Math.round(d.vram_free / MB),
      })),
    };
  }

  /** Files ComfyUI has in one model folder (`GET /models/{folder}`), e.g. `loras`. */
  async models(folder: string, signal?: AbortSignal): Promise<string[]> {
    const raw = await this.#json(`/models/${encodeURIComponent(folder)}`, { signal });
    return z.array(z.string()).catch([]).parse(raw);
  }

  /** Node classes the server knows (`GET /object_info`), names only. */
  async nodeClasses(signal?: AbortSignal): Promise<Set<string>> {
    const raw = await this.#json("/object_info", { signal });
    return new Set(raw !== null && typeof raw === "object" ? Object.keys(raw) : []);
  }

  /** Queues a graph; returns ComfyUI's prompt id. */
  async queue(
    graph: ComfyGraph,
    clientId: string,
    options: { promptId?: string; signal?: AbortSignal } = {},
  ): Promise<string> {
    const res = await this.#request("/prompt", {
      json: {
        prompt: graph,
        client_id: clientId,
        ...(options.promptId ? { prompt_id: options.promptId } : {}),
      },
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (res.status === 400) {
      const b = (body ?? {}) as { error?: { message?: unknown }; node_errors?: unknown };
      const nodes =
        b.node_errors && typeof b.node_errors === "object"
          ? nodeErrorText(b.node_errors as Record<string, unknown>)
          : "";
      const message = typeof b.error?.message === "string" ? b.error.message : "invalid prompt";
      throw new ComfyError(
        `ComfyUI refused the graph: ${message}${nodes ? ` (${nodes})` : ""}`,
        "invalid",
        400,
      );
    }
    if (!res.ok) {
      throw new ComfyError(
        `ComfyUI /prompt answered ${res.status}: ${text.slice(0, 300)}`,
        res.status >= 500 ? "unreachable" : "protocol",
        res.status,
      );
    }
    const parsed = QueuedSchema.safeParse(body);
    if (!parsed.success) throw new ComfyError("ComfyUI /prompt sent no prompt_id", "protocol");
    return parsed.data.prompt_id;
  }

  /** What the history says about a run; `null` when it is not in the history (yet). */
  async run(promptId: string, signal?: AbortSignal): Promise<ComfyRun | null> {
    const raw = await this.#json(`/history/${encodeURIComponent(promptId)}`, { signal });
    if (raw === null || typeof raw !== "object") return null;
    const entry = (raw as Record<string, unknown>)[promptId];
    if (entry === undefined) return null;
    const parsed = HistoryEntrySchema.safeParse(entry);
    if (!parsed.success) throw new ComfyError("ComfyUI history entry has no outputs", "protocol");
    const { outputs, status } = parsed.data;
    const images: ComfyRun["images"] = [];
    const nodes = Object.keys(outputs).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
    for (const node of nodes) {
      for (const image of outputs[node]?.images ?? []) {
        if (image.type === "output") images.push({ node, image });
      }
    }
    const str = status?.status_str ?? "";
    const done = status?.completed ?? false;
    if (str === "error") {
      return {
        status: "error",
        images,
        error: historyError(status?.messages ?? []) ?? "ComfyUI reported an error",
      };
    }
    return { status: done || str === "success" ? "success" : "running", images, error: null };
  }

  /** The server's queue (`GET /queue`). */
  async queueState(signal?: AbortSignal): Promise<ComfyQueue> {
    const raw = QueueSchema.parse(await this.#json("/queue", { signal }));
    const id = (entry: unknown[]) => (typeof entry[1] === "string" ? entry[1] : null);
    return {
      running: raw.queue_running.map(id).filter((x): x is string => x !== null),
      pending: raw.queue_pending.map(id).filter((x): x is string => x !== null),
    };
  }

  /** Bytes of a saved picture (`GET /view`). */
  async view(image: ComfyImageRef, signal?: AbortSignal): Promise<Uint8Array> {
    const q = new URLSearchParams({
      filename: image.filename,
      subfolder: image.subfolder,
      type: image.type,
    });
    const res = await this.#request(`/view?${q}`, signal ? { signal } : {});
    if (!res.ok) {
      throw new ComfyError(`ComfyUI /view answered ${res.status}`, "protocol", res.status);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Uploads a picture into ComfyUI's `input` folder; returns the name a `LoadImage` takes. */
  async upload(
    bytes: Uint8Array,
    filename: string,
    options: { subfolder?: string; overwrite?: boolean; signal?: AbortSignal } = {},
  ): Promise<string> {
    const form = new FormData();
    form.append("image", new Blob([new Uint8Array(bytes)]), filename);
    form.append("type", "input");
    if (options.subfolder) form.append("subfolder", options.subfolder);
    form.append("overwrite", options.overwrite === false ? "false" : "true");
    const raw = UploadSchema.parse(
      await this.#json("/upload/image", {
        body: form,
        ...(options.signal ? { signal: options.signal } : {}),
      }),
    );
    return raw.subfolder ? `${raw.subfolder}/${raw.name}` : raw.name;
  }

  /** Stops the run now on the GPU (only that prompt when the server supports it). */
  async interrupt(promptId?: string, signal?: AbortSignal): Promise<void> {
    const res = await this.#request("/interrupt", {
      json: promptId ? { prompt_id: promptId } : {},
      ...(signal ? { signal } : {}),
    });
    await res.body?.cancel();
  }

  /** Takes waiting prompts off the server's queue. */
  async dequeue(promptIds: readonly string[], signal?: AbortSignal): Promise<void> {
    const res = await this.#request("/queue", {
      json: { delete: promptIds },
      ...(signal ? { signal } : {}),
    });
    await res.body?.cancel();
  }

  /** Unloads models and frees cached memory (`POST /free`). */
  async free(signal?: AbortSignal): Promise<void> {
    const res = await this.#request("/free", {
      json: { unload_models: true, free_memory: true },
      ...(signal ? { signal } : {}),
    });
    await res.body?.cancel();
    if (!res.ok)
      throw new ComfyError(`ComfyUI /free answered ${res.status}`, "protocol", res.status);
  }

  /**
   * Follows one run until its history says it ended, then returns it. Progress goes to
   * `onProgress` when the WebSocket opens; the history is polled every `pollMs` either way, so a
   * lost socket only loses the progress.
   */
  async follow(
    promptId: string,
    clientId: string,
    options: {
      onProgress?: (p: ComfyProgress) => void;
      pollMs?: number;
      signal: AbortSignal;
    },
  ): Promise<ComfyRun> {
    const socket = options.onProgress ? this.#socket(promptId, clientId, options.onProgress) : null;
    try {
      for (;;) {
        options.signal.throwIfAborted();
        const run = await this.run(promptId, options.signal).catch((error: unknown) => {
          if (error instanceof ComfyError && error.kind === "unreachable") return null;
          throw error;
        });
        if (run !== null && run.status !== "running") return run;
        await sleep(options.pollMs ?? 1_000, options.signal);
      }
    } finally {
      socket?.close();
    }
  }

  /** Opens the progress socket of one run; never throws (progress is optional). */
  #socket(
    promptId: string,
    clientId: string,
    onProgress: (p: ComfyProgress) => void,
  ): { close(): void } | null {
    const Ws = this.#webSocket;
    if (Ws === null) return null;
    const wsUrl = `${this.url.replace(/^http/, "ws")}/ws?clientId=${encodeURIComponent(clientId)}`;
    let ws: WebSocket;
    try {
      ws = new Ws(wsUrl);
    } catch {
      return null;
    }
    ws.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data !== "string") return; // binary frames are previews
      let parsed: z.output<typeof WsMessageSchema>;
      try {
        parsed = WsMessageSchema.parse(JSON.parse(event.data));
      } catch {
        return;
      }
      const { type, data } = parsed;
      if (data.prompt_id !== undefined && data.prompt_id !== promptId) return;
      const node = typeof data.node === "string" ? data.node : null;
      if (type === "executing") onProgress({ type: "executing", node });
      else if (
        type === "progress" &&
        typeof data.value === "number" &&
        typeof data.max === "number"
      ) {
        onProgress({ type: "progress", node, value: data.value, max: data.max });
      } else if (type === "execution_cached" && Array.isArray(data.nodes)) {
        onProgress({ type: "cached", nodes: data.nodes.map(String) });
      } else if (type === "execution_error") {
        const message =
          typeof data.exception_message === "string" ? data.exception_message : "failed";
        onProgress({ type: "error", message });
      }
    });
    ws.addEventListener("error", () => undefined);
    return {
      close: () => {
        try {
          ws.close();
        } catch {
          // already closed
        }
      },
    };
  }
}
