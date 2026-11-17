// `SpeechService` fallback chains and their request counters.

import { MetricsRegistry } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import {
  type AsrProvider,
  type AudioStream,
  NO_HINT,
  SpeechHttpError,
  SpeechService,
  type TtsProvider,
  ttsRequest,
} from "../src/index.js";

const audio = { sampleRate: 16_000, samples: new Int16Array(160) };

function asr(name: string, fail: boolean): AsrProvider {
  return {
    name,
    transcribe: async () => {
      if (fail) throw new Error(`${name} down`);
      return { text: "你好", language: "zh", emotion: null, audio_events: [] };
    },
  };
}

function tts(name: string, fail: boolean): TtsProvider {
  return {
    name,
    synthesize: async (): Promise<AudioStream> => {
      if (fail) throw new Error(`${name} down`);
      return (async function* () {})();
    },
  };
}

describe("SpeechService", () => {
  it("counts every attempt by provider and outcome", async () => {
    const registry = new MetricsRegistry();
    const service = new SpeechService(
      [asr("a", true), asr("b", false)],
      [tts("x", true), tts("y", false)],
      { metrics: registry },
    );
    expect((await service.transcribe(audio, NO_HINT))[0]).toBe("b");
    expect((await service.synthesize(ttsRequest("嗨")))[0]).toBe("y");

    const controller = new AbortController();
    controller.abort();
    const cancelled = new SpeechService([asr("a", true)], [], { metrics: registry });
    await expect(cancelled.transcribe(audio, NO_HINT, controller.signal)).rejects.toThrow("a down");

    const asrCount = registry.counter("miyoria_asr_requests_total", {
      help: "",
      labels: ["provider", "outcome"],
    });
    const ttsCount = registry.counter("miyoria_tts_requests_total", {
      help: "",
      labels: ["provider", "outcome"],
    });
    expect(asrCount.get({ provider: "a", outcome: "error" })).toBe(1);
    expect(asrCount.get({ provider: "a", outcome: "aborted" })).toBe(1);
    expect(asrCount.get({ provider: "b", outcome: "ok" })).toBe(1);
    expect(ttsCount.get({ provider: "x", outcome: "error" })).toBe(1);
    expect(ttsCount.get({ provider: "y", outcome: "ok" })).toBe(1);
  });

  it("starts at the next provider for a while after one failed", async () => {
    let now = 0;
    let calls: string[] = [];
    let aDown = true;
    const counted = (name: string, down: () => boolean): AsrProvider => ({
      name,
      transcribe: async () => {
        calls.push(name);
        if (down()) throw new Error(`${name} down`);
        return { text: "你好", language: "zh", emotion: null, audio_events: [] };
      },
    });
    const service = new SpeechService([counted("a", () => aDown), counted("b", () => false)], [], {
      metrics: new MetricsRegistry(),
      retryMs: 1_000,
      now: () => now,
    });
    expect((await service.transcribe(audio, NO_HINT))[0]).toBe("b");
    expect(calls).toEqual(["a", "b"]);
    calls = [];
    // `a` just failed: it is not waited for again.
    expect((await service.transcribe(audio, NO_HINT))[0]).toBe("b");
    expect(calls).toEqual(["b"]);
    calls = [];
    // Its time is up: it is first again.
    now = 1_000;
    aDown = false;
    expect((await service.transcribe(audio, NO_HINT))[0]).toBe("a");
    expect(calls).toEqual(["a"]);
  });

  it("still tries a provider that failed lately when it is the only one left", async () => {
    let calls = 0;
    const only: AsrProvider = {
      name: "a",
      transcribe: async () => {
        calls++;
        throw new Error("a down");
      },
    };
    const service = new SpeechService([only], [], { metrics: new MetricsRegistry() });
    await expect(service.transcribe(audio, NO_HINT)).rejects.toThrow("a down");
    await expect(service.transcribe(audio, NO_HINT)).rejects.toThrow("a down");
    expect(calls).toBe(2);
  });

  it("does not hold a request it turned down against it", async () => {
    let calls: string[] = [];
    let status = 400;
    const refusing: AsrProvider = {
      name: "a",
      transcribe: async () => {
        calls.push("a");
        throw new SpeechHttpError(`ASR worker answered ${status}`, status);
      },
    };
    const service = new SpeechService([refusing, asr("b", false)], [], {
      metrics: new MetricsRegistry(),
    });
    await service.transcribe(audio, NO_HINT);
    calls = [];
    // A 400 says the request was wrong, not the worker: it is still tried first.
    await service.transcribe(audio, NO_HINT);
    expect(calls).toEqual(["a"]);
    // A 503 says the worker is in trouble.
    status = 503;
    await service.transcribe(audio, NO_HINT);
    calls = [];
    await service.transcribe(audio, NO_HINT);
    expect(calls).toEqual([]);
  });

  it("does not hold an offloaded worker against it", async () => {
    let calls: string[] = [];
    const offloaded: AsrProvider = {
      name: "a",
      transcribe: async () => {
        calls.push("a");
        throw new Error("ASR worker answered 503: offloaded");
      },
    };
    const service = new SpeechService([offloaded, asr("b", false)], [], {
      metrics: new MetricsRegistry(),
    });
    await service.transcribe(audio, NO_HINT);
    calls = [];
    await service.transcribe(audio, NO_HINT);
    expect(calls).toEqual(["a"]);
  });
});
