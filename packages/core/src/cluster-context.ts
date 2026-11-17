// Who listens to her and which songs are needed now, for the hosts' GPU arbiters (docs/design/
// v5-gpu.md §12.2): the `sing` module hands every audience context it tells its song worker to
// this sink, and it goes to the `cluster` module, which sends `cluster.context` to the approved
// hosts with a `sing`, `tts` or `asr` service. The cluster service is looked up at every call (the
// module may restart), so neither package needs the other.

import { ClusterKey } from "@miyoria/cluster";
import type { GpuContextSink } from "@miyoria/sing";

export const clusterContext: GpuContextSink = (services, context) => {
  services.get(ClusterKey)?.context?.({
    in_voice: context.in_voice,
    listeners: context.listeners,
    live: context.live,
    urgent: [...context.urgent],
  });
};
