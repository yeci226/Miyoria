// Who the arbiter deals with, from the service descriptors: `evictable` services are the tenants it
// may take offline (TTS, ASR: they need `offload` and `reload`), `on_demand` ones are the holders
// that may ask for a window (sing). `pinned` and `reserve` services are only less free memory on
// the card. The daemon passes the base URL it runs each service at.

import type { HostService } from "@miyoria/contracts/host";
import type { Tenant } from "./state.js";

export interface RunningService {
  service: Omit<HostService, "install">;
  /** Base URL, without a trailing slash. */
  url: string;
}

/** The evictable services, in the order given (it is the order they go offline and come back in). */
export function tenantsFrom(services: readonly RunningService[]): Tenant[] {
  const out: Tenant[] = [];
  for (const { service, url } of services) {
    const gpu = service.gpu;
    if (gpu?.policy !== "evictable" || gpu.offload === undefined || gpu.reload === undefined)
      continue;
    out.push({
      name: service.name,
      url: url.replace(/\/+$/, ""),
      offload: gpu.offload,
      reload: gpu.reload,
      busy: gpu.busy ?? "/busy",
      health: service.run?.health.http ?? "/health",
    });
  }
  return out;
}

/** The services that may hold a window (`on_demand`), by name. */
export function holdersFrom(services: readonly RunningService[]): string[] {
  return services
    .filter(({ service }) => service.gpu?.policy === "on_demand")
    .map(({ service }) => service.name);
}
