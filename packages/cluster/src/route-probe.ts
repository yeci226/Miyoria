// Probing the routes of the route table (docs/design/v5-hostd.md §16). `tick` sends the probes
// that are due: per route a small `GET` (the gateway's `/_miyoria/probe`, or a service's `/health`
// on a `tailnet` route) every `probe_secs`, one right after a failed route's rest is over, and on
// gateway routes a throughput sample of `sample_kib` every `sample_secs`. The relay is measured by
// the control link's own ping. At most `PARALLEL` probes are in flight at once; a host costs about
// one small request per route every five minutes and a quarter of a megabyte every half hour.
//
// A gateway probe counts only when the gateway itself answered (`x-miyoria-route: gateway`): a
// tunnel's edge that answers for a gateway that is down is a failure.

import { HOST_ROUTE } from "@miyoria/contracts/host";
import type { Clock } from "@miyoria/types";
import type { RouteTable } from "./routes.js";

/** Probes in flight at once. */
const PARALLEL = 4;

export interface RouteProberOptions {
  table: RouteTable;
  clock: Clock;
  /** Default the global `fetch`. */
  fetch?: typeof fetch;
  log?: { debug(fields: object, message: string): void };
}

export class RouteProber {
  readonly #o: RouteProberOptions;
  readonly #fetch: typeof fetch;
  #running: Promise<void> | null = null;

  constructor(options: RouteProberOptions) {
    this.#o = options;
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Sends the probes that are due; a tick while one runs waits for that one. */
  tick(): Promise<void> {
    this.#running ??= this.#tick().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #tick(): Promise<void> {
    const tasks = this.#o.table.due();
    for (let i = 0; i < tasks.length; i += PARALLEL) {
      await Promise.all(tasks.slice(i, i + PARALLEL).map((task) => this.#probe(task)));
    }
  }

  async #probe(task: ReturnType<RouteTable["due"]>[number]): Promise<void> {
    const { table, clock } = this.#o;
    table.probed(task.host, task.route);
    const started = clock.now();
    const gatewayRoute = task.url.includes(HOST_ROUTE.PROBE_PATH);
    try {
      const response = await this.#fetch(task.url, {
        headers: task.headers,
        redirect: "manual",
        signal: AbortSignal.timeout(table.config.timeout_ms),
      });
      const head = clock.now() - started;
      if (gatewayRoute && response.headers.get(HOST_ROUTE.GATEWAY_HEADER) !== "gateway") {
        await response.body?.cancel().catch(() => undefined);
        table.failed(task.host, task.route, `不是 hostd 的閘道回的(HTTP ${response.status})`);
        return;
      }
      if (gatewayRoute && response.status !== 200) {
        await response.body?.cancel().catch(() => undefined);
        table.failed(
          task.host,
          task.route,
          response.status === 401
            ? "閘道不認得這台的 token(位址是不是指到別台?)"
            : `閘道回了 HTTP ${response.status}`,
        );
        return;
      }
      if (task.kind === "ping") {
        await response.body?.cancel().catch(() => undefined);
        // On a tailnet route any answer of the service shows the route works.
        table.ok(task.host, task.route, head);
        return;
      }
      const bytes = (await response.arrayBuffer()).byteLength;
      if (task.bytes !== undefined && bytes !== task.bytes) {
        table.failed(task.host, task.route, `測速只收到 ${bytes} / ${task.bytes} bytes`);
        return;
      }
      const ms = clock.now() - started - head;
      table.ok(task.host, task.route);
      table.sample(task.host, task.route, bytes, ms);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.#o.log?.debug({ host: task.host, route: task.route, err: reason }, "route probe failed");
      table.failed(task.host, task.route, `連不上:${reason}`);
    }
  }
}
