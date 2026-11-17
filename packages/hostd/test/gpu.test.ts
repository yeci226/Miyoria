// Reading the card: the parsers on outputs recorded on the owner's RTX 4070 SUPER (2026-11-16, the
// same moment through NVML and nvidia-smi), the choice between NVML and nvidia-smi, and the
// reading the arbiter gets. The real card is never read here.

import { describe, expect, it } from "vitest";
import {
  CardReader,
  cudaIndex,
  deviceReader,
  fromNvml,
  type GpuSample,
  type NvmlBinding,
  type NvmlRaw,
  nvmlLibraries,
  parseNvidiaSmi,
} from "../src/index.js";

/** What NVML filled in: `nvmlDeviceGetMemoryInfo` (v1) and `nvmlDeviceGetName`. */
function recordedNvml(): NvmlRaw {
  const name = new Uint8Array(96);
  name.set(Buffer.from("NVIDIA GeForce RTX 4070 SUPER", "utf8"));
  return { total: 12878610432, free: 1635667968, used: 11242942464, name };
}

/** `nvidia-smi --query-gpu=index,name,memory.total,memory.used,memory.free ...` at that moment. */
const RECORDED_SMI = "0, NVIDIA GeForce RTX 4070 SUPER, 12282, 10438, 1560\r\n";

describe("NVML", () => {
  it("counts whole MB as device_memory.py does, and takes the device's own free", () => {
    expect(fromNvml(recordedNvml())).toEqual({
      name: "NVIDIA GeForce RTX 4070 SUPER",
      total_mb: 12282,
      used_mb: 10722,
      free_mb: 1559,
    });
    const big = { ...recordedNvml(), total: 12878610432n, free: 1635667968n, used: 11242942464n };
    expect(fromNvml(big).free_mb).toBe(1559);
  });

  it("is looked for where device_memory.py looks", () => {
    expect(nvmlLibraries("linux", {})).toEqual(["libnvidia-ml.so.1"]);
    expect(nvmlLibraries("win32", { ProgramFiles: "D:\\Programs" })).toEqual([
      "nvml.dll",
      "D:\\Programs\\NVIDIA Corporation\\NVSMI\\nvml.dll",
    ]);
  });
});

describe("nvidia-smi", () => {
  it("reads free as the device's, used as total minus free", () => {
    expect(parseNvidiaSmi(RECORDED_SMI)).toEqual({
      name: "NVIDIA GeForce RTX 4070 SUPER",
      total_mb: 12282,
      used_mb: 10722,
      free_mb: 1560,
    });
  });

  it("takes the line of the card asked for; a name may hold commas", () => {
    const two = "0, Card A, 8192, 1000, 7000\n1, Card, Rev. B, 24576, 4000, 20000\n";
    expect(parseNvidiaSmi(two, 1)).toEqual({
      name: "Card, Rev. B",
      total_mb: 24576,
      used_mb: 4576,
      free_mb: 20000,
    });
    expect(parseNvidiaSmi(two, 2)).toBeNull();
    expect(parseNvidiaSmi("0, Card, [N/A], 1, [N/A]\n")).toBeNull();
    expect(parseNvidiaSmi("NVIDIA-SMI has failed\n")).toBeNull();
  });
});

describe("the card's index", () => {
  it("is the first of CUDA_VISIBLE_DEVICES when that is a number", () => {
    expect(cudaIndex({})).toBe(0);
    expect(cudaIndex({ CUDA_VISIBLE_DEVICES: "1,0" })).toBe(1);
    expect(cudaIndex({ CUDA_VISIBLE_DEVICES: " 2 " })).toBe(2);
    expect(cudaIndex({ CUDA_VISIBLE_DEVICES: "GPU-8f2e" })).toBe(0);
  });
});

describe("CardReader", () => {
  function binding(read: (index: number) => NvmlRaw | null) {
    const asked: number[] = [];
    let closed = 0;
    const nvml: NvmlBinding = {
      read: (index) => {
        asked.push(index);
        return read(index);
      },
      close: () => {
        closed += 1;
      },
    };
    return {
      nvml,
      asked,
      get closed() {
        return closed;
      },
    };
  }

  it("uses NVML when it loads, once, for the card asked for", async () => {
    let loads = 0;
    const b = binding(() => recordedNvml());
    let smi = 0;
    const reader = new CardReader({
      index: 1,
      nvml: async () => {
        loads += 1;
        return b.nvml;
      },
      smi: async () => {
        smi += 1;
        return null;
      },
    });
    expect(reader.kind).toBeNull();
    expect(await reader.read()).toMatchObject({ free_mb: 1559 });
    expect(await reader.read()).toMatchObject({ total_mb: 12282 });
    expect(reader.kind).toBe("nvml");
    expect(loads).toBe(1);
    expect(smi).toBe(0);
    expect(b.asked).toEqual([1, 1]);
    await reader.close();
    expect(b.closed).toBe(1);
  });

  it("falls back to nvidia-smi without NVML, and a failed load is not fatal", async () => {
    const sample: GpuSample = { name: "Card", total_mb: 8192, used_mb: 1000, free_mb: 7192 };
    for (const nvml of [async () => null, async () => Promise.reject(new Error("no koffi"))]) {
      const reader = new CardReader({ nvml, smi: async () => sample });
      expect(await reader.read()).toEqual(sample);
      expect(reader.kind).toBe("nvidia-smi");
      await reader.close();
    }
  });

  it("answers null when NVML says no or throws", async () => {
    const no = new CardReader({ nvml: async () => binding(() => null).nvml });
    expect(await no.read()).toBeNull();
    const broken = new CardReader({
      nvml: async () =>
        binding(() => {
          throw new Error("GPU is lost");
        }).nvml,
    });
    expect(await broken.read()).toBeNull();
  });
});

describe("the arbiter's reading", () => {
  it("is the whole device and throws when the card cannot be read", async () => {
    const reading = deviceReader(async () => fromNvml(recordedNvml()));
    expect(await reading()).toEqual({
      cuda: true,
      total_mb: 12282,
      free_mb: 1559,
      name: "NVIDIA GeForce RTX 4070 SUPER",
    });
    const older = deviceReader(async () => ({ name: "Card", total_mb: 8192, used_mb: 1000 }));
    expect((await older()).free_mb).toBe(7192);
    await expect(deviceReader(async () => null)()).rejects.toThrow(/cannot be read/);
  });
});
