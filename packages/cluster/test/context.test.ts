// `cluster.context`: Core tells the hosts that may run a GPU arbiter (an approved host with a `sing`,
// `tts` or `asr` service) who listens to her, through the real link client (`CoreLink`) into the
// daemon's `HostApi.setContext`; and catches a host up when it connects while songs are prepared.

import type {
  HostClusterContext,
  HostReport,
  HostServiceEvent,
  HostServiceStatus,
} from "@miyoria/contracts/host";
import {
  type ClusterClient,
  CoreLink,
  type GuardSource,
  type HostApi,
  HostRpcError,
} from "@miyoria/hostd/link";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_FRESH_MS } from "../src/link.js";
import { Harness, report, service, sleepMs, waitUntil } from "./helpers.js";

let harness: Harness | null = null;
const links: CoreLink[] = [];

afterEach(async () => {
  for (const link of links.splice(0)) await link.stop();
  await harness?.stop();
  harness = null;
});

/** A daemon's API that reports `services` and records every `cluster.context` it is given. */
class ContextApi implements HostApi {
  readonly got: HostClusterContext[] = [];
  reported = 0;

  constructor(readonly services: HostServiceStatus[]) {}

  report(): HostReport {
    this.reported += 1;
    return report(this.services, "pc");
  }

  async call(method: string): Promise<unknown> {
    throw new HostRpcError(-32601, `not here: ${method}`);
  }

  onEvent(_listener: (event: HostServiceEvent) => void): () => void {
    return () => {};
  }

  followLogs(): () => void {
    return () => {};
  }

  target(): null {
    return null;
  }

  setGuardSource(_source: GuardSource | null): void {}

  setClusterClient(_client: ClusterClient | null): void {}

  setContext(context: HostClusterContext): void {
    this.got.push(context);
  }
}

function dial(h: Harness, credentials: { id: string; key: string }, api: ContextApi): void {
  const link = new CoreLink(api, {
    url: h.url(),
    hostId: credentials.id,
    key: credentials.key,
    name: "pc",
    platform: "linux",
    version: "0.1.0",
    retryInitialMs: 20,
    retryMaxMs: 100,
  });
  links.push(link);
  link.start();
}

const CONTEXT: HostClusterContext = { in_voice: true, listeners: 2, live: false, urgent: ["j1"] };

describe("cluster.context", () => {
  it("goes to every approved host with a sing, tts or asr service, each time", async () => {
    harness = await Harness.start();
    const h = harness;
    const cluster = h.cluster();
    const make = (name: string, services: HostServiceStatus[], approved = true) => {
      const made = cluster.hosts.create({
        name,
        approved,
        capabilities: services.flatMap((s) => s.provides),
      });
      const api = new ContextApi(services);
      dial(h, { id: made.host.id, key: made.key }, api);
      return api;
    };
    const singPc = make("sing-pc", [service({ name: "sing" })]);
    const speechPc = make("speech-pc", [service({ name: "tts" }), service({ name: "asr" })]);
    const turnPc = make("turn-pc", [service({ name: "turn" })]);
    const offPc = make("off-pc", [service({ name: "sing", state: "disabled" })]);
    const pending = make("pending-pc", [service({ name: "sing" })], false);
    await waitUntil(() => cluster.hosts.connected().length === 5, "every host");
    await waitUntil(
      () => [singPc, speechPc, turnPc, offPc, pending].every((a) => a.reported > 0),
      "the reports",
    );
    await sleepMs(50);
    // Nothing was said yet: nobody is told anything on connect.
    expect(singPc.got).toEqual([]);

    cluster.context?.(CONTEXT);
    await waitUntil(() => singPc.got.length === 1 && speechPc.got.length === 1, "the context");
    expect(singPc.got[0]).toEqual(CONTEXT);
    expect(speechPc.got[0]).toEqual(CONTEXT);

    const later = { ...CONTEXT, listeners: 0, urgent: [] };
    cluster.context?.(later);
    await waitUntil(() => singPc.got.length === 2, "the next one");
    expect(singPc.got[1]).toEqual(later);
    await sleepMs(50);
    expect(turnPc.got).toEqual([]);
    expect(offPc.got).toEqual([]);
    expect(pending.got).toEqual([]);
  });

  it("catches up a host that connects while it is fresh, not after", async () => {
    const clock = { t: Date.now(), now: () => clock.t };
    harness = await Harness.start({}, { clock });
    const h = harness;
    const cluster = h.cluster();
    cluster.context?.(CONTEXT);
    const hostOf = (name: string) => {
      const made = cluster.hosts.create({ name, approved: true, capabilities: ["sing"] });
      const api = new ContextApi([service({ name: "sing" })]);
      dial(h, { id: made.host.id, key: made.key }, api);
      return api;
    };

    clock.t += CONTEXT_FRESH_MS;
    const late = hostOf("late-pc");
    await waitUntil(() => late.got.length === 1, "the catch-up");
    expect(late.got[0]).toEqual(CONTEXT);
    await sleepMs(100);
    expect(late.got).toHaveLength(1);

    // Songs stopped being prepared: the sing module sent nothing for longer than that.
    clock.t += 1;
    const later = hostOf("later-pc");
    await waitUntil(() => later.reported > 0 && cluster.hosts.connected().length === 2, "it");
    await sleepMs(100);
    expect(later.got).toEqual([]);
  });
});
