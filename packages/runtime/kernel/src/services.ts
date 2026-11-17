import type { ModuleId, ServiceKey } from "@miyoria/types";

/** Thrown by `require` when nobody provides the service. */
export class ServiceUnavailableError extends Error {
  override readonly name = "ServiceUnavailableError";

  constructor(readonly service: string) {
    super(`service \`${service}\` is not available`);
  }
}

/** Read-only view of the registry, given to modules as `ctx.services`. */
export interface ServiceLookup {
  get<T>(key: ServiceKey<T>): T | undefined;
  /** Like `get`, but throws `ServiceUnavailableError`. */
  require<T>(key: ServiceKey<T>): T;
  has<T>(key: ServiceKey<T>): boolean;
}

interface Entry {
  owner: ModuleId;
  value: unknown;
}

/**
 * Registry of service handles keyed by `ServiceKey<T>` tokens. Modules provide implementations
 * of shared interfaces and other modules look them up. A service is removed automatically when
 * its owning module stops, so look services up when you need them instead of caching them
 * across restarts of other modules.
 */
export class ServiceRegistry implements ServiceLookup {
  // Keyed by the key object (identity). `ServiceKey<T>` is invariant in `T`, hence `object`.
  readonly #entries = new Map<object, Entry>();

  /** Registers `service` under `key`, replacing any previous one. */
  provide<T>(owner: ModuleId, key: ServiceKey<T>, service: T): void {
    this.#entries.set(key, { owner, value: service });
  }

  get<T>(key: ServiceKey<T>): T | undefined {
    return this.#entries.get(key)?.value as T | undefined;
  }

  require<T>(key: ServiceKey<T>): T {
    const entry = this.#entries.get(key);
    if (!entry) throw new ServiceUnavailableError(key.id);
    return entry.value as T;
  }

  has<T>(key: ServiceKey<T>): boolean {
    return this.#entries.has(key);
  }

  ownerOf<T>(key: ServiceKey<T>): ModuleId | undefined {
    return this.#entries.get(key)?.owner;
  }

  removeOwnedBy(owner: ModuleId): void {
    for (const [key, entry] of this.#entries) {
      if (entry.owner === owner) this.#entries.delete(key);
    }
  }
}
