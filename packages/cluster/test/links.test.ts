// `cluster.links`: Core tells each approved host where its node links are, through the real link
// client (`CoreLink`): the voice link to a host approved for `voice-room`, the stage link to one
// approved for `renderer`, nothing to a pending host; on connect, on approval and on a change.

import type {
  HostLinks,
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
import { Harness, report, sleepMs, waitUntil } from "./helpers.js";

let harness: Harness | null = null;
const links: CoreLink[] = [];

afterEach(async () => {
  for (const link of links.splice(0)) await link.stop();
  await harness?.stop();
  harness = null;
});

/** A daemon's API that records every `cluster.links` it is given. */
class LinksApi implements HostApi {
  readonly got: Array<HostLinks["links"]> = [];
  client: ClusterClient | null = null;

  report(): HostReport {
    return report([] as HostServiceStatus[], "pc");
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

  setClusterClient(client: ClusterClient | null): void {
    this.client = client;
  }

  setLinks(links: HostLinks["links"]): void {
    this.got.push(links);
  }
}

const VOICE = { port: 7879, path: "/voice-link", token: "voice-secret" };
const STAGE = {
  url: "wss://core.example:7882/stage-link",
  port: 7882,
  path: "/stage-link",
  token: "s",
};

function dial(h: Harness, credentials: { id: string; key: string }): LinksApi {
  const api = new LinksApi();
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
  return api;
}

describe("cluster.links", () => {
  it("each approved host gets the links of what it is approved for, at once", async () => {
    let current: HostLinks["links"] = { voice: VOICE, stage: STAGE };
    harness = await Harness.start({}, { module: { links: () => current } });
    const h = harness;
    const cluster = h.cluster();
    const make = (name: string, capabilities: string[]) => {
      const made = cluster.hosts.create({ name, approved: true, capabilities });
      return dial(h, { id: made.host.id, key: made.key });
    };
    const voicePc = make("voice-pc", ["voice-room", "asr"]);
    const stagePc = make("stage-pc", ["renderer"]);
    const both = make("both-pc", ["voice-room", "renderer"]);
    const workerPc = make("worker-pc", ["sing"]);
    await waitUntil(
      () => voicePc.got.length + stagePc.got.length + both.got.length === 3,
      "the links",
    );
    expect(voicePc.got).toEqual([{ voice: VOICE }]);
    expect(stagePc.got).toEqual([{ stage: STAGE }]);
    expect(both.got).toEqual([{ voice: VOICE, stage: STAGE }]);
    await waitUntil(() => cluster.hosts.connected().length === 4, "every host");
    await sleepMs(50);
    expect(workerPc.got).toEqual([]);

    // A change reaches only the hosts whose share changed.
    current = { voice: { ...VOICE, token: "new" }, stage: STAGE };
    h.module.refreshLinks();
    await waitUntil(() => voicePc.got.length === 2 && both.got.length === 2, "the change");
    expect(voicePc.got[1]).toEqual({ voice: { ...VOICE, token: "new" } });
    expect(both.got[1]).toEqual({ voice: { ...VOICE, token: "new" }, stage: STAGE });
    await sleepMs(50);
    expect(stagePc.got).toHaveLength(1);
    // Nothing changed: nothing is sent.
    h.module.refreshLinks();
    await sleepMs(50);
    expect(voicePc.got).toHaveLength(2);

    // A link that is turned off is taken away.
    current = { stage: STAGE };
    h.module.refreshLinks();
    await waitUntil(() => voicePc.got.length === 3, "the removal");
    expect(voicePc.got[2]).toEqual({});
  });

  it("a pending host gets none until it is approved, and loses them when it is not any more", async () => {
    harness = await Harness.start(
      {},
      { module: { links: () => ({ voice: VOICE, stage: STAGE }) } },
    );
    const h = harness;
    const cluster = h.cluster();
    const made = cluster.hosts.create({ name: "new-pc" });
    const api = dial(h, { id: made.host.id, key: made.key });
    await waitUntil(() => cluster.hosts.connected().length === 1, "the connection");
    await sleepMs(50);
    expect(api.got).toEqual([]);

    cluster.hosts.approve("new-pc", ["voice-room"]);
    await waitUntil(() => api.got.length === 1, "the links after approval");
    expect(api.got[0]).toEqual({ voice: VOICE });

    cluster.hosts.approve("new-pc", ["renderer"]);
    await waitUntil(() => api.got.length === 2, "the links after a new approval");
    expect(api.got[1]).toEqual({ stage: STAGE });
  });

  it("sends nothing without the option", async () => {
    harness = await Harness.start();
    const cluster = harness.cluster();
    const made = cluster.hosts.create({ name: "pc", approved: true, capabilities: ["voice-room"] });
    const api = dial(harness, { id: made.host.id, key: made.key });
    await waitUntil(() => cluster.hosts.connected().length === 1, "the connection");
    await sleepMs(50);
    expect(api.got).toEqual([]);
  });
});
