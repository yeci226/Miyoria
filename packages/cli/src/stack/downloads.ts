// Model files that `miyoria install` downloads, from the sources the READMEs name and nowhere
// else: the list is fixed here, no URL is ever taken from a config value or from the network.
// Each file goes to the path the worker already expects, is never overwritten, and is resumable
// (`<file>.part` plus a Range request).

import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface ModelFile {
  id: string;
  /** The worker that needs it. */
  service: string;
  what: string;
  url: string;
  /** Relative to the repository root. */
  dest: string;
  /** Shown before asking; README figures, not measured here. */
  size: string;
  license: string;
}

/** Hosts a model may come from. */
export const MODEL_HOSTS = ["huggingface.co", "raw.githubusercontent.com"] as const;

export const MODEL_FILES: readonly ModelFile[] = [
  {
    id: "smart-turn",
    service: "turn",
    what: "Smart Turn v3.2(判斷講完)",
    url: "https://huggingface.co/pipecat-ai/smart-turn-v3/resolve/main/smart-turn-v3.2-cpu.onnx?download=true",
    dest: "workers/models/smart-turn/smart-turn-v3.2-cpu.onnx",
    size: "約 9 MB",
    license: "BSD-2-Clause",
  },
  {
    id: "silero-vad",
    service: "turn",
    what: "Silero VAD",
    url: "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx",
    dest: "workers/models/silero-vad/silero_vad.onnx",
    size: "約 2 MB",
    license: "MIT",
  },
];

export function modelsFor(services: readonly string[]): ModelFile[] {
  return MODEL_FILES.filter((m) => services.includes(m.service));
}

export type Fetch = typeof fetch;

/**
 * Downloads `url` to `dest` (an absolute path), continuing a `.part` file from an earlier try.
 * Does nothing when `dest` exists. Throws on an unlisted host or a short download.
 */
export async function downloadFile(
  url: string,
  dest: string,
  fetchImpl: Fetch = fetch,
): Promise<"downloaded" | "exists"> {
  if (existsSync(dest)) return "exists";
  const host = new URL(url).hostname;
  if (!(MODEL_HOSTS as readonly string[]).includes(host)) {
    throw new Error(`${host} 不在允許下載的來源清單裡`);
  }
  mkdirSync(dirname(dest), { recursive: true });
  const part = `${dest}.part`;
  const have = existsSync(part) ? statSync(part).size : 0;
  const res = await fetchImpl(url, have > 0 ? { headers: { range: `bytes=${have}-` } } : {});
  if (!res.ok || !res.body) throw new Error(`下載失敗:HTTP ${res.status}`);
  const resumed = res.status === 206;
  const total = Number(res.headers.get("content-length") ?? "0") + (resumed ? have : 0);
  await pipeline(
    Readable.fromWeb(res.body as never),
    createWriteStream(part, { flags: resumed ? "a" : "w" }),
  );
  const size = statSync(part).size;
  if (total > 0 && size !== total)
    throw new Error(`下載不完整(${size} / ${total} 位元組);重跑會接著下載`);
  renameSync(part, dest);
  return "downloaded";
}
