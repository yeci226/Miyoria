// The guarded states Core gives the cluster (docs/design/v5-hostd.md §4): a host's voluntary
// restart waits while she sings or is live. They read the same sources as the public status
// route (`publicStatus` in `@miyoria/api`), through their service keys, so the cluster package
// needs neither `sing` nor `live` nor `voice`.

import type { ClusterGuard } from "@miyoria/cluster";
import { SingerKey } from "@miyoria/sing";
import { ActivityManagerKey } from "@miyoria/types";

/** `singing`: a song is playing, or her activity is singing (starting or running). */
export const singingGuard: ClusterGuard = (services) => {
  if (services.get(SingerKey)?.playing()) return "singing";
  const activity = services.get(ActivityManagerKey)?.snapshot().activity;
  const singing =
    activity?.type === "singing" && (activity.phase === "starting" || activity.phase === "running");
  return singing ? "singing" : null;
};

/** `live`: her broadcast is live (Go Live and OBS are what make it so). */
export const liveGuard: ClusterGuard = (services) =>
  services.get(ActivityManagerKey)?.snapshot().broadcast.type === "live" ? "live" : null;

/** Both, in the order `cluster.guard` lists them. */
export const CLUSTER_GUARDS: readonly ClusterGuard[] = [singingGuard, liveGuard];
