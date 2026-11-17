// The completions Core lends the cluster: they go through Core's own router, with the purpose the
// host asked for, and the call log names the host and the service.

import { LlmRouter, LlmRouterKey, MockProvider } from "@miyoria/llm/llm";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { CLUSTER_LLM_MODULE, clusterComplete } from "../src/cluster-llm.js";

function routed() {
  const provider = new MockProvider("p").reply('{"is_song": true, "songs": []}');
  const router = new LlmRouter(
    new Map([["p", provider]]),
    new Map([["fast", [{ provider: "p", model: "m" }]]]),
  );
  const services = new ServiceRegistry();
  services.provide("llm", LlmRouterKey, router);
  return { provider, router, services };
}

describe("clusterComplete", () => {
  it("runs the completion through Core's router and labels it with the host and service", async () => {
    const { provider, router, services } = routed();
    const text = await clusterComplete(
      services,
      {
        purpose: "fast",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "which song?" },
        ],
        max_tokens: 300,
        temperature: 0,
        json: true,
        host: "friend-pc",
        service: "sing",
      },
      new AbortController().signal,
    );
    expect(text).toBe('{"is_song": true, "songs": []}');
    const [request] = provider.requests();
    expect(request?.messages.map((m) => [m.role, m.content])).toEqual([
      ["system", "rules"],
      ["user", "which song?"],
    ]);
    expect(request).toMatchObject({ max_tokens: 300, temperature: 0, json_mode: true });
    const [call] = router.calls.list().items;
    expect(call).toMatchObject({
      purpose: "fast",
      module: CLUSTER_LLM_MODULE,
      label: "friend-pc/sing",
      status: "ok",
    });
  });

  it("fails when Core has no router", async () => {
    await expect(
      clusterComplete(
        new ServiceRegistry(),
        {
          purpose: "fast",
          messages: [{ role: "user", content: "x" }],
          host: "h",
          service: "s",
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/llm module/);
  });
});
