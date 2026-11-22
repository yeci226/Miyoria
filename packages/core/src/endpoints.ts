// Where the modules find their workers (docs/design/v5-hostd.md §6.3, §6.4): the `cluster` module's
// endpoint registry, handed to them through their `endpoints` option.
//
// During the move to hostd the address keys of the modules' own config sections stay: Core reads
// them here, once, and adds each one the file sets to the registry as a static entry. The modules
// no longer read an address. A key the file does not set makes no entry (there are no default
// addresses: a setup that relied on one must write it, or have a hostd report the service).
//
// - `[speech.asr.<name>] url` of an `http-worker` provider: entry `speech.asr.<name>`, `asr`
//   (`[speech.tts.<name>]` likewise, `tts`); the provider calls its own entry.
// - `[modules.voice] turn_url`: entry `voice.turn`, `turn` and `vad`.
// - `[modules.sing] url`, then each of `fallback_urls`: entries `sing`, `sing.fallback.1`, ...,
//   `sing`, in this order (the same address twice is added once).
// - `[modules.imagegen] url` with its `headers`: entry `imagegen`, `imagegen`.
//
// The registry is the `cluster` module's (`ClusterKey`). When that module is not running (its port
// is taken, it is restarting), the modules use a registry of Core's own with the same static
// entries, so a working setup keeps working without it. Each module gets a source that looks the
// registry up at every call, so a restarted `cluster` module is picked up, watchers included.

import { ClusterKey, EndpointRegistry } from "@miyoria/cluster";
import { type Config, getLogger, type ServiceLookup } from "@miyoria/runtime/kernel";
import { SingConfigSchema, SingModule, workerUrls } from "@miyoria/sing";
import { isJsonObject } from "@miyoria/types";
import {
  type Endpoint,
  type EndpointQuery,
  type EndpointSource,
  SpeechConfigSchema,
  speechEntryName,
} from "@miyoria/voice/speech";
import { VoiceConfigSchema, VoiceModule } from "@miyoria/voice/voice";
import { ImageGenConfigSchema, ImageGenModule } from "@miyoria/workspace/imagegen";

const log = getLogger("core.endpoints");

/** A static entry made of a module's address key. */
export interface LegacyEndpoint {
  name: string;
  provides: string[];
  url: string;
  headers?: Record<string, string>;
}

/** The raw `[modules.<id>]` section without `enabled`, or `{}`. */
function moduleSection(config: Config, id: string): unknown {
  const raw = config.module(id).config;
  return isJsonObject(raw) ? raw : {};
}

/** The static entries the address keys of `config` make, in the order they are added. */
export function legacyEndpoints(config: Config): LegacyEndpoint[] {
  const out: LegacyEndpoint[] = [];

  const speech = SpeechConfigSchema.safeParse(config.section("speech") ?? {});
  if (speech.success) {
    for (const family of ["asr", "tts"] as const) {
      for (const [name, provider] of Object.entries(speech.data[family])) {
        const url = provider.settings.url;
        if (provider.kind !== "http-worker" || typeof url !== "string") continue;
        out.push({ name: speechEntryName(family, name), provides: [family], url });
      }
    }
  }

  const voice = VoiceConfigSchema.safeParse(moduleSection(config, VoiceModule.ID));
  if (voice.success && voice.data.turn_url !== undefined) {
    out.push({ name: "voice.turn", provides: ["turn", "vad"], url: voice.data.turn_url });
  }

  const sing = SingConfigSchema.safeParse(moduleSection(config, SingModule.ID));
  if (sing.success) {
    const urls = workerUrls(sing.data.url, sing.data.fallback_urls);
    const first = sing.data.url === undefined ? 1 : 0;
    urls.forEach((url, i) => {
      const n = i + first;
      out.push({ name: n === 0 ? "sing" : `sing.fallback.${n}`, provides: ["sing"], url });
    });
  }

  const imagegen = ImageGenConfigSchema.safeParse(moduleSection(config, ImageGenModule.ID));
  if (imagegen.success && imagegen.data.url !== undefined) {
    out.push({
      name: "imagegen",
      provides: ["imagegen"],
      url: imagegen.data.url,
      headers: imagegen.data.headers,
    });
  }
  return out;
}

/**
 * The `endpoints` option of the modules: the `cluster` module's registry (or Core's own when it
 * is not running), with the static entries of `legacy` added once to each registry it meets.
 */
export class CoreEndpoints {
  readonly #legacy: readonly LegacyEndpoint[];
  readonly #seeded = new WeakSet<EndpointRegistry>();
  #own: EndpointRegistry | null = null;

  constructor(legacy: readonly LegacyEndpoint[]) {
    this.#legacy = legacy;
  }

  /** Pass this as a module's `endpoints` option. */
  readonly option = (services: ServiceLookup): EndpointSource => this.source(services);

  /** The registry in use now, with the static entries added. */
  registry(services: ServiceLookup): EndpointRegistry {
    const registry = services.get(ClusterKey)?.registry ?? this.#ownRegistry();
    if (!this.#seeded.has(registry)) {
      this.#seeded.add(registry);
      for (const entry of this.#legacy) {
        try {
          registry.addStatic(entry.name, {
            provides: entry.provides,
            url: entry.url,
            ...(entry.headers === undefined ? {} : { headers: entry.headers }),
          });
        } catch (error) {
          log.warn(
            { entry: entry.name, err: error instanceof Error ? error.message : String(error) },
            "address key not added to the endpoint registry",
          );
        }
      }
    }
    return registry;
  }

  /** A source that looks the registry up at every call and moves its watchers along. */
  source(services: ServiceLookup): EndpointSource {
    const watchers = new Map<() => void, { capability: string; dispose: () => void }>();
    let last: EndpointRegistry | null = null;
    const current = (): EndpointRegistry => {
      const registry = this.registry(services);
      if (last !== null && registry !== last) {
        // The `cluster` module came or went: watch the registry there is now, and say so.
        for (const [onChange, w] of watchers) {
          w.dispose();
          w.dispose = registry.watch(w.capability, onChange);
        }
        last = registry;
        for (const onChange of [...watchers.keys()]) onChange();
      }
      last = registry;
      return registry;
    };
    return {
      pick: (capability: string, query?: EndpointQuery) => current().pick(capability, query),
      candidates: (capability: string, query?: EndpointQuery) =>
        current().candidates(capability, query),
      failed: (endpoint: Endpoint, error?: unknown) => current().failed(endpoint, error),
      request: (endpoint: Endpoint, path: string, init?: RequestInit) =>
        current().request(endpoint, path, init),
      reserve: (endpoint: Endpoint, unit?: { what?: string; sizeBytes?: number }) =>
        current().reserve(endpoint, unit),
      openSession: (capability: string, key: string) => current().openSession(capability, key),
      closeSession: (capability: string, key: string) => current().closeSession(capability, key),
      watch: (capability: string, onChange: () => void) => {
        const registry = current();
        // Each call is its own watch, even for the same function.
        const handler = () => onChange();
        watchers.set(handler, { capability, dispose: registry.watch(capability, handler) });
        return () => {
          watchers.get(handler)?.dispose();
          watchers.delete(handler);
        };
      },
    };
  }

  #ownRegistry(): EndpointRegistry {
    this.#own ??= new EndpointRegistry();
    return this.#own;
  }
}
