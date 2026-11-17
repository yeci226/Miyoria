// The audience context the `sing` module hands Core's wiring goes to the cluster module.

import { ClusterKey, type ClusterService } from "@miyoria/cluster";
import { ServiceRegistry } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { clusterContext } from "../src/cluster-context.js";

type HostClusterContext = Parameters<NonNullable<ClusterService["context"]>>[0];

const CONTEXT = { in_voice: true, listeners: 3, live: true, urgent: ["j1", "j2"] };

describe("Core's cluster context sink", () => {
  it("passes the context to the cluster module", () => {
    const got: HostClusterContext[] = [];
    const services = new ServiceRegistry();
    services.provide("cluster", ClusterKey, {
      context: (c: HostClusterContext) => got.push(c),
    } as unknown as ClusterService);
    clusterContext(services, CONTEXT);
    expect(got).toEqual([CONTEXT]);
  });

  it("does nothing without the cluster module, or with one that cannot send it", () => {
    expect(() => clusterContext(new ServiceRegistry(), CONTEXT)).not.toThrow();
    const services = new ServiceRegistry();
    services.provide("cluster", ClusterKey, {} as unknown as ClusterService);
    expect(() => clusterContext(services, CONTEXT)).not.toThrow();
  });
});
