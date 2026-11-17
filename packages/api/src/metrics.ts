// `GET /metrics` (Prometheus text format 0.0.4): the process-wide registry of `@miyoria/runtime/kernel`
// (bus, LLM, speech, agent turns, filled by those packages) plus what is read at scrape time:
// module states, process uptime and memory.
//
// It needs the bearer token (or a panel session) like `/api`, unless `[modules.api]
// metrics_public = true`.

import { MIYORIA_VERSION } from "@miyoria/llm/llm";
import {
  METRICS_CONTENT_TYPE,
  type MetricFamily,
  type ModuleStatus,
  metrics,
  renderMetrics,
  SupervisorKey,
} from "@miyoria/runtime/kernel";
import type { ModuleStateKind } from "@miyoria/types";
import type { Route } from "./route.js";
import type { ApiState } from "./state.js";

export const METRICS_PATH = "/metrics";

const MODULE_STATES: readonly ModuleStateKind[] = [
  "disabled",
  "starting",
  "running",
  "degraded",
  "stopping",
  "stopped",
  "failed",
];

function gauge(name: string, help: string, samples: MetricFamily["samples"]): MetricFamily {
  return { name, help, type: "gauge", samples };
}

/** One gauge per module and state: 1 for its current state, 0 for the others. */
function moduleFamilies(list: readonly ModuleStatus[]): MetricFamily[] {
  return [
    gauge(
      "miyoria_module_state",
      "Module state; 1 for the current state of each module.",
      list.flatMap((m) =>
        MODULE_STATES.map((state) => ({
          name: "miyoria_module_state",
          labels: { module: m.id, state },
          value: m.state === state ? 1 : 0,
        })),
      ),
    ),
    gauge(
      "miyoria_module_enabled",
      "Whether the module is enabled.",
      list.map((m) => ({
        name: "miyoria_module_enabled",
        labels: { module: m.id },
        value: m.enabled ? 1 : 0,
      })),
    ),
    gauge(
      "miyoria_module_recent_restarts",
      "Restarts of the module in the supervisor's restart window.",
      list.map((m) => ({
        name: "miyoria_module_recent_restarts",
        labels: { module: m.id },
        value: m.recent_restarts,
      })),
    ),
  ];
}

function processFamilies(nowMs: number): MetricFamily[] {
  const mem = process.memoryUsage();
  const uptime = process.uptime();
  const one = (name: string, help: string, value: number, labels = {}) =>
    gauge(name, help, [{ name, labels, value }]);
  return [
    one("miyoria_build_info", "Miyoria version; always 1.", 1, { version: MIYORIA_VERSION }),
    one("miyoria_process_uptime_seconds", "Seconds since the process started.", uptime),
    one(
      "process_start_time_seconds",
      "Start time of the process since the Unix epoch in seconds.",
      Math.round(nowMs / 1000 - uptime),
    ),
    one("process_resident_memory_bytes", "Resident memory size in bytes.", mem.rss),
    one("nodejs_heap_size_total_bytes", "V8 heap size in bytes.", mem.heapTotal),
    one("nodejs_heap_size_used_bytes", "Used V8 heap in bytes.", mem.heapUsed),
    one(
      "nodejs_external_memory_bytes",
      "Memory of C++ objects bound to JS, in bytes.",
      mem.external,
    ),
  ];
}

/** The full exposition. */
export function renderAll(state: ApiState): string {
  const supervisor = state.optional(SupervisorKey);
  const families = [
    ...processFamilies(state.now()),
    ...(supervisor ? moduleFamilies(supervisor.list()) : []),
    ...metrics.collect(),
  ];
  return renderMetrics(families);
}

export function metricsRoutes(state: ApiState, options: { public: boolean }): Route[] {
  return [
    {
      method: "GET",
      path: METRICS_PATH,
      public: options.public,
      handler: () =>
        new Response(renderAll(state), {
          headers: { "content-type": METRICS_CONTENT_TYPE, "cache-control": "no-store" },
        }),
    },
  ];
}
