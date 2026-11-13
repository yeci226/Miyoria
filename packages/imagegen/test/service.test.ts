import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getLogger } from "@miyoria/kernel";
import type { Event, ImageJob } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ComfyClient } from "../src/comfy.js";
import { ImageGenConfigSchema } from "../src/config.js";
import { ImageGenService } from "../src/service.js";
import { JobStore } from "../src/store.js";
import { FakeComfy, PNG } from "./fake-comfy.js";

let comfy: FakeComfy;
let dir: string;
let stop: AbortController;
let events: Event[];
let now: number;
let runs: Promise<void>[];

function service(extra: Record<string, unknown> = {}): ImageGenService {
  const config = ImageGenConfigSchema.parse({
    url: comfy.url,
    poll_ms: 100,
    free_after_idle_s: 0,
    ...extra,
  });
  return new ImageGenService({
    config,
    baseDir: dir,
    client: new ComfyClient({ url: comfy.url, webSocket: null }),
    clock: { now: () => now },
    log: getLogger("imagegen.test"),
    publish: (e) => events.push(e),
    random: () => 1234,
  });
}

async function started(extra: Record<string, unknown> = {}): Promise<ImageGenService> {
  const s = service(extra);
  await s.load();
  runs.push(s.run(stop.signal).catch(() => undefined));
  return s;
}

const settled = (s: ImageGenService, job: ImageJob) => s.wait(job.id, AbortSignal.timeout(5_000));

beforeEach(async () => {
  comfy = new FakeComfy();
  await comfy.start();
  dir = await mkdtemp(join(tmpdir(), "imagegen-"));
  stop = new AbortController();
  events = [];
  runs = [];
  now = Date.parse("2026-11-12T04:00:00Z"); // 12:00 in Taipei
});

afterEach(async () => {
  stop.abort();
  await Promise.all(runs);
  await comfy.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("ImageGenService", () => {
  it("runs a Krea 2 job and keeps the picture with a sidecar that can remake it", async () => {
    const s = await started();
    const job = await s.submit(
      { prompt: "whale girl at a summer festival" },
      { purpose: "gacha", note: "test" },
    );
    expect(job.request).toMatchObject({
      model: "krea2",
      variant: "turbo",
      steps: 8,
      cfg: 1,
      seed: 1234,
    });
    const done = await settled(s, job);
    expect(done.state).toBe("done");
    expect(done.outputs).toHaveLength(1); // the temp preview is not an output
    const out = done.outputs[0];
    expect(out?.file).toBe(`2026-11/gacha/${job.id}-0.png`);
    expect(new Uint8Array(await readFile(out?.path as string))).toEqual(PNG);
    const sidecar = JSON.parse(
      await readFile(join(dir, "data/images/2026-11/gacha", `${job.id}.json`), "utf8"),
    );
    expect(sidecar.graph).toEqual(comfy.runs[0]?.graph);
    expect(sidecar.model_files.diffusion_model).toBe("krea2_turbo_fp8_scaled.safetensors");
    expect(comfy.runs[0]?.client).toBe(`miyoria-${job.id}`);
    const states = events.map((e) =>
      e.type === "custom" ? (e.data.payload as { state: string }).state : "",
    );
    expect(states).toEqual(["queued", "running", "done"]);
  });

  it("answers the same key with the same job, and keeps daily limits per purpose", async () => {
    const s = service({ daily_limits: { gacha: 1 } });
    await s.load();
    const a = await s.submit({ prompt: "x" }, { purpose: "gacha", key: "k1" });
    const b = await s.submit({ prompt: "y" }, { purpose: "gacha", key: "k1" });
    expect(b.id).toBe(a.id);
    await expect(s.submit({ prompt: "z" }, { purpose: "gacha" })).rejects.toMatchObject({
      status: 429,
    });
    await expect(s.submit({ prompt: "z" }, { purpose: "fortune" })).resolves.toBeTruthy();
  });

  it("refuses bad requests before anything is queued", async () => {
    const s = service();
    await s.load();
    await expect(s.submit({ prompt: "" }, { purpose: "gacha" })).rejects.toThrow(/empty/);
    await expect(s.submit({ prompt: "x", model: "nope" }, { purpose: "gacha" })).rejects.toThrow(
      /no image model/,
    );
    await expect(s.submit({ prompt: "x", variant: "fast" }, { purpose: "gacha" })).rejects.toThrow(
      /no variant/,
    );
    await expect(s.submit({ prompt: "x" }, { purpose: "Bad Purpose" })).rejects.toThrow(/slug/);
    await expect(
      s.submit({ prompt: "x", init_image: "../secret.png" }, { purpose: "a" }),
    ).rejects.toThrow(/input_dir/);
    await expect(s.submit({ prompt: "x", params: { a: 1 } }, { purpose: "a" })).rejects.toThrow(
      /workflow/,
    );
  });

  it("fails without retrying when a model file is missing or the graph is refused", async () => {
    comfy.files.diffusion_models = [];
    const s = await started();
    const missing = await settled(s, await s.submit({ prompt: "x" }, { purpose: "a" }));
    expect(missing.state).toBe("failed");
    expect(missing.error).toMatch(/no diffusion_model `krea2_turbo_fp8_scaled.safetensors`/);
    expect(comfy.runs).toHaveLength(0);

    comfy.files.diffusion_models = ["krea2_turbo_fp8_scaled.safetensors"];
    comfy.refuse = true;
    const s2 = await started({ check_files: false });
    const refused = await settled(s2, await s2.submit({ prompt: "x" }, { purpose: "b" }));
    expect(refused.state).toBe("failed");
    expect(refused.error).toMatch(/bad file/);
    expect(refused.attempts).toBe(1);
  });

  it("reports a run ComfyUI failed", async () => {
    comfy.failNext = true;
    const s = await started();
    const job = await settled(s, await s.submit({ prompt: "x", model: "anima" }, { purpose: "a" }));
    expect(job.state).toBe("failed");
    expect(job.error).toBe("KSampler: CUDA out of memory");
  });

  it("puts a job back when ComfyUI is down and runs it when it is back", async () => {
    comfy.down = true;
    const s = await started({ max_attempts: 3 });
    const job = await s.submit({ prompt: "x" }, { purpose: "a" });
    for (let i = 0; i < 50 && (await s.get(job.id))?.attempts === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const back = await s.get(job.id);
    expect(back).toMatchObject({ state: "queued", attempts: 1 });
    expect((await s.status()).held).toBe("unreachable");
    comfy.down = false;
    now += 11_000; // past the retry wait
    s.nudge();
    expect((await settled(s, job)).state).toBe("done");
  });

  it("holds jobs while she sings, yields a running batch job, and unloads ComfyUI for the song", async () => {
    comfy.auto = false;
    const s = await started();
    const job = await s.submit({ prompt: "x" }, { purpose: "a" });
    for (let i = 0; i < 50 && comfy.runs.length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(comfy.runs).toHaveLength(1);
    s.onSongCue({ state: "started", song: "1", title: "t" });
    for (let i = 0; i < 50 && (await s.get(job.id))?.state !== "queued"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(await s.get(job.id)).toMatchObject({ state: "queued", attempts: 0, prompt_id: null });
    expect(comfy.interrupts.length).toBeGreaterThan(0);
    expect(comfy.frees.length).toBeGreaterThan(0);
    expect((await s.status()).held).toBe("singing");
    comfy.auto = true;
    s.onSongCue({ state: "ended", song: "1", outcome: "done" });
    expect((await settled(s, job)).state).toBe("done");
    expect(comfy.runs).toHaveLength(2);
  });

  it("runs batch jobs only inside batch_hours, interactive ones any time", async () => {
    const s = await started({ batch_hours: "02:00-09:00" }); // it is 12:00 local
    const batch = await s.submit({ prompt: "x" }, { purpose: "a" });
    const now1 = await settled(
      s,
      await s.submit({ prompt: "y" }, { purpose: "a", priority: "interactive" }),
    );
    expect(now1.state).toBe("done");
    expect((await s.get(batch.id))?.state).toBe("queued");
    now = Date.parse("2026-11-12T19:00:00Z"); // 03:00 local
    s.nudge();
    expect((await settled(s, batch)).state).toBe("done");
  });

  it("cancels a queued job", async () => {
    const s = service();
    await s.load();
    const job = await s.submit({ prompt: "x" }, { purpose: "a" });
    expect((await s.cancel(job.id))?.state).toBe("cancelled");
    expect((await s.wait(job.id)).state).toBe("cancelled");
  });

  it("picks up a run ComfyUI finished while the core was down, without running it again", async () => {
    const first = service();
    await first.load();
    const job = await first.submit({ prompt: "x" }, { purpose: "a" });
    // As if the core stopped right after queueing on ComfyUI.
    comfy.runs.push({
      id: "pid-1",
      graph: { "9": { class_type: "SaveImage", inputs: { filename_prefix: "p" } } },
      client: "c",
      state: "success",
    });
    const store = new JobStore(join(dir, "data/images"));
    await store.save({
      ...((await first.get(job.id)) as ImageJob),
      state: "running",
      prompt_id: "pid-1",
      attempts: 1,
    });

    const second = await started();
    const done = await settled(second, job);
    expect(done.state).toBe("done");
    expect(done.attempts).toBe(2);
    expect(comfy.runs).toHaveLength(1); // nothing queued again
  });

  it("uploads a start picture from input_dir and fills a workflow file", async () => {
    await mkdir(join(dir, "data/imagegen/input"), { recursive: true });
    await writeFile(join(dir, "data/imagegen/input/start.png"), PNG);
    await mkdir(join(dir, "data/imagegen/workflows"), { recursive: true });
    await writeFile(
      join(dir, "data/imagegen/workflows/upscale.json"),
      JSON.stringify({
        description: "upscale a picture",
        params: {
          image: { node: "1", input: "image", type: "image" },
          factor: { node: "2", input: "scale_by", type: "float", min: 1, max: 4 },
        },
        graph: {
          "1": { class_type: "LoadImage", inputs: { image: "x.png" } },
          "2": {
            class_type: "ImageScaleBy",
            inputs: { image: ["1", 0], upscale_method: "lanczos", scale_by: 2 },
          },
          "3": {
            class_type: "SaveImage",
            inputs: { images: ["2", 0], filename_prefix: "ComfyUI" },
          },
        },
      }),
    );
    const s = await started();
    expect((await s.workflows()).map((w) => w.id)).toEqual(["upscale"]);
    const job = await s.submit(
      { prompt: "", workflow: "upscale", init_image: "start.png", params: { factor: 3 } },
      { purpose: "tools" },
    );
    const done = await settled(s, job);
    expect(done.state).toBe("done");
    const graph = comfy.runs[0]?.graph;
    expect(graph?.["1"]?.inputs.image).toBe(`miyoria/${job.id}-start.png`);
    expect(graph?.["2"]?.inputs.scale_by).toBe(3);
    expect(graph?.["3"]?.inputs.filename_prefix).toBe(`miyoria/tools/${job.id}`);
    expect(comfy.uploads).toEqual([`${job.id}-start.png`]);
    await expect(
      s.submit({ prompt: "", workflow: "upscale", params: { factor: 9 } }, { purpose: "tools" }),
    ).resolves.toBeTruthy(); // checked when it runs, not here
  });

  it("describes its models and ComfyUI", async () => {
    const s = service({
      models: { moss_image: { enabled: false }, anima: { default_variant: "turbo" } },
    });
    expect(s.models().map((m) => m.id)).toEqual(["krea2", "anima"]);
    expect(s.models().find((m) => m.id === "anima")?.default_variant).toBe("turbo");
    const status = await s.status();
    expect(status).toMatchObject({ reachable: true, version: "0.9.0", queued: 0 });
    expect(status.devices[0]?.vram_total_mb).toBe(24 * 1024);
    expect(existsSync(join(dir, "data/images"))).toBe(false); // nothing written before load
  });
});
