import type {
  AnyEventDefinition,
  Clock,
  EnvelopeOf,
  EventPayload,
  JsonValue,
  ModuleId,
  Publish,
  PublishMetaArgs,
  ServiceKey,
} from "@miyoria/types";
import type { z } from "zod";
import { errorMessage } from "./async.js";
import type { EventBus, Subscription, TopicFilterLike } from "./bus.js";
import { parseSection } from "./config.js";
import type { Logger } from "./log.js";
import type { ServiceLookup, ServiceRegistry } from "./services.js";

/** A supervised task: receives the module's stop signal and must settle soon after it aborts. */
export type Task = (signal: AbortSignal) => Promise<void>;

/** @internal What a context reports back to the supervisor. */
export interface ContextHost {
  readonly id: ModuleId;
  readonly generation: number;
  readonly bus: EventBus;
  readonly services: ServiceRegistry;
  readonly config: JsonValue | null;
  readonly clock: Clock;
  readonly log: Logger;
  readonly controller: AbortController;
  readonly tasks: Set<Promise<void>>;
  fail(generation: number, error: string): void;
}

/**
 * Everything a module may use to interact with the rest of the system. One context per start;
 * after the module stops, its `signal` is aborted and its subscriptions are closed.
 */
export class ModuleContext {
  readonly #host: ContextHost;

  /** @internal Created by the supervisor. */
  constructor(host: ContextHost) {
    this.#host = host;
  }

  get id(): ModuleId {
    return this.#host.id;
  }

  get bus(): EventBus {
    return this.#host.bus;
  }

  get services(): ServiceLookup {
    return this.#host.services;
  }

  get clock(): Clock {
    return this.#host.clock;
  }

  /** Logger bound to `{ module: <id> }`. */
  get log(): Logger {
    return this.#host.log;
  }

  /** Aborted when the module is being stopped. Pass it to every cancellable call. */
  get signal(): AbortSignal {
    return this.#host.controller.signal;
  }

  /** Raw `[modules.<id>]` section (without `enabled`); `null` when missing. */
  get rawConfig(): JsonValue | null {
    return this.#host.config;
  }

  /**
   * Validates the module's config section with `schema` (a missing section validates as `{}`).
   * Throws `ConfigError`, which fails the start when called from `start`.
   */
  config<S extends z.ZodType>(schema: S): z.output<S> {
    return parseSection(schema, this.#host.config ?? undefined, `modules.${this.#host.id}`);
  }

  /**
   * Publishes one event of `definition` from this module: `ctx.publish(Events.SingCue, cue,
   * { turn })`. A family takes the concrete type in `meta.type`.
   */
  publish<D extends AnyEventDefinition>(
    definition: D,
    data: EventPayload<D>,
    ...meta: PublishMetaArgs<D>
  ): EnvelopeOf<D> {
    return this.#host.bus.publish(this.#host.id, definition, data, ...meta);
  }

  /** `publish` by definition from this module, for the parts the module hands it to. */
  get publisher(): Publish {
    return this.#host.bus.publisher(this.#host.id);
  }

  /** Subscription that closes automatically when the module stops. */
  subscribe(filter: TopicFilterLike, options: { capacity?: number } = {}): Subscription {
    return this.#host.bus.subscribe(filter, { ...options, signal: this.signal });
  }

  /** Provides a service owned by this module; it is removed when the module stops. */
  provide<T>(key: ServiceKey<T>, service: T): void {
    this.#host.services.provide(this.#host.id, key, service);
  }

  /**
   * Starts a supervised task. If it rejects (or throws) before the module is stopped, the
   * module is marked failed and restarted with backoff. The task must watch `signal` and
   * settle promptly once it aborts; the supervisor waits up to 5 s for it on stop.
   */
  spawn(name: string, task: Task): void {
    const host = this.#host;
    const signal = this.signal;
    const run = (async () => task(signal))().then(
      () => undefined,
      (error: unknown) => {
        if (signal.aborted) {
          host.log.debug({ task: name, err: error }, "task ended with an error after stop");
          return;
        }
        host.log.error({ task: name, err: error }, "module task ended abnormally");
        host.fail(host.generation, `task \`${name}\` failed: ${errorMessage(error)}`);
      },
    );
    host.tasks.add(run);
    void run.finally(() => host.tasks.delete(run));
  }
}
