// The GPU arbiter inside the daemon (docs/design/v5-gpu.md §12, v5-hostd.md §8): the pure
// `Arbiter` of `./arbiter` with the real clock and timers, the card reader, the HTTP calls to the
// speech services, a profile file in the state folder, and the services of this host as tenants
// (evictable: TTS, ASR) and holders (on_demand: the song worker).
//
// It runs only when `host.toml [gpu] arbiter = "hostd"`, a service of this host has a `[gpu]`
// policy of `on_demand` or `evictable`, and the card can be read. Otherwise every `gpu.*` call
// answers `Unavailable` with the reason, and the song worker decides by itself as before.
//
// The policy and the limits are the holder's own settings: the `SING_*` variables of its
// effective environment (descriptor `[run] env`, then `host.toml [services.<name>] env`), under
// exactly the names and parsing the song worker used (`policyFrom`, `limitsFrom`), plus
// `SING_RELOAD_TIMEOUT_S`, `SING_YIELD_POLL_MS` and `SING_YIELD_HOLD_MS`. A machine migrated from
// the old setup keeps its tuning without a new key. They are read when the arbiter is made (the
// first `gpu.*` call or the daemon's start); a change needs a daemon restart.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  HOST_ERROR_CODE,
  type HostClusterContext,
  HostGpuAcquireSchema,
  type HostGpuArbiterStatus,
  HostGpuBusySchema,
  type HostGpuLeaseStatus,
  HostGpuReleaseSchema,
  HostGpuRenewSchema,
  type HostService,
} from "@miyoria/contracts/host";
import type { Logger } from "pino";
import { type ZodType, z } from "zod";
import { HostRpcError } from "./api.js";
import {
  Arbiter,
  type ArbiterEvent,
  CardProfile,
  type CardProfileData,
  holdersFrom,
  limitsFrom,
  type ProfileStore,
  policyFrom,
  pyFloat,
  pyInt,
  type RunningService,
  type Settings,
  type Tenant,
  type Timers,
  tenantsFrom,
} from "./arbiter/index.js";
import { deviceReader, type GpuReader } from "./gpu.js";
import { HttpPeerClient, type ServiceTarget } from "./peers.js";
import { JSON_RPC } from "./server.js";

/** The file the learned card values live in, inside the state folder. */
export const GPU_PROFILE_FILE = "gpu-profile.json";

/** The tenants go offline in this order (TTS first, as the song worker did), the rest after. */
const TENANT_ORDER = ["tts", "asr"];

/** How long an unreadable card is not asked again by a `gpu.*` call. */
const RETRY_CARD_MS = 10_000;

/** One service of this host as the arbiter sees it. */
export interface ArbiterService {
  /** The descriptor, with the effective `[gpu] policy` (`host.toml` may override it). */
  service: Omit<HostService, "install">;
  /** `host.toml` enables it. */
  enabled: boolean;
  /** Where it runs now; `null` when it is not running. */
  url: string | null;
  /** Its `SING_*` settings: descriptor `[run] env`, then `host.toml` env. */
  settings: Settings;
}

export interface GpuArbitrationOptions {
  mode: "worker" | "hostd";
  read: GpuReader;
  target: ServiceTarget;
  /** The profile file. */
  profileFile: string;
  log: Logger;
  /** Something `host.info` shows changed (a lease, a decision). */
  changed: () => void;
  /** Wall clock, epoch ms (tests). */
  now?: () => number;
}

/** Seconds on a monotonic clock. */
const monotonic = { now: () => performance.now() / 1000 };

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/** Real timers in seconds; a sleep rejects at once when its signal is or becomes aborted. */
export const realTimers: Timers = {
  sleep(seconds, signal) {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(abortError());
      };
      const ms = Math.min(Math.max(0, seconds * 1000), 2 ** 31 - 1);
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      timer.unref?.();
      signal.addEventListener("abort", onAbort, { once: true });
    });
  },
};

/** The profile as a JSON file, written whole through a temporary file. */
export function jsonProfileStore(file: string, log: Logger): ProfileStore {
  return {
    load() {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as unknown;
      } catch {
        return null;
      }
    },
    save(data: CardProfileData) {
      try {
        mkdirSync(dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
        renameSync(tmp, file);
      } catch (error) {
        log.warn({ err: error, file }, "could not write the GPU profile");
      }
    },
  };
}

function parse<T>(schema: ZodType<T>, params: unknown): T {
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    throw new HostRpcError(
      JSON_RPC.InvalidParams,
      parsed.error.issues
        .map((i) => `${i.path.map(String).join(".") || "params"}: ${i.message}`)
        .join("; "),
    );
  }
  return parsed.data;
}

/** The settings the holders give the arbiter, merged in their order. */
function holderSettings(services: readonly ArbiterService[]): Settings {
  const out: Record<string, string> = {};
  for (const s of services) {
    if (s.enabled && s.service.gpu?.policy === "on_demand") Object.assign(out, s.settings);
  }
  return out;
}

/** `int(os.environ.get(name, default))` with the song worker's fallback on a bad value. */
function setting(settings: Settings, name: string, kind: "int" | "float", fallback: number) {
  const raw = settings[name];
  if (raw === undefined) return fallback;
  return (kind === "int" ? pyInt(raw) : pyFloat(raw)) ?? fallback;
}

export class GpuArbitration {
  readonly #o: GpuArbitrationOptions;
  /** Kept in place: the arbiter reads these arrays at every use. */
  readonly #tenants: Tenant[] = [];
  readonly #holders: string[] = [];
  #services: readonly ArbiterService[] = [];
  #arbiter: Arbiter | null = null;
  #making: Promise<Arbiter | null> | null = null;
  #triedAt = Number.NEGATIVE_INFINITY;
  #reason: string;
  #closed = false;
  /** Lease → the service that took it, when (epoch ms), and who went offline for it (base URLs). */
  readonly #leases = new Map<string, { holder: string; since: number; evict: string[] }>();
  #last: HostGpuArbiterStatus["last"] = null;

  constructor(options: GpuArbitrationOptions) {
    this.#o = options;
    this.#reason =
      options.mode === "worker"
        ? 'host.toml 的 [gpu] arbiter 是 "worker":歌聲 worker 自己決定'
        : "還沒讀過顯卡";
  }

  get mode(): "worker" | "hostd" {
    return this.#o.mode;
  }

  /** The arbiter, when it runs. */
  get arbiter(): Arbiter | null {
    return this.#arbiter;
  }

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** Whether `name` may hold a lease: its effective `[gpu] policy` is `on_demand`. */
  isHolder(name: string): boolean {
    return this.#services.some(
      (s) => s.service.name === name && s.service.gpu?.policy === "on_demand",
    );
  }

  /** Whether `name` holds a lease now. */
  holds(name: string): boolean {
    for (const lease of this.#leases.values()) if (lease.holder === name) return true;
    return false;
  }

  /**
   * The services as they are now: keeps the tenants (running evictable services, TTS then ASR
   * first) and the holders current. When a tenant appears while nothing holds the card, what a
   * holder may have left offline is asked back (`recover`).
   */
  update(services: readonly ArbiterService[]): void {
    this.#services = services;
    const running: RunningService[] = services
      .filter((s) => s.enabled && s.url !== null)
      .map((s) => ({ service: s.service, url: s.url as string }));
    const rank = (name: string) => {
      const i = TENANT_ORDER.indexOf(name);
      return i < 0 ? TENANT_ORDER.length : i;
    };
    const ordered = [...running].sort((a, b) => rank(a.service.name) - rank(b.service.name));
    const tenants = tenantsFrom(ordered);
    const holders = holdersFrom(
      services.filter((s) => s.enabled).map((s) => ({ service: s.service, url: s.url ?? "" })),
    );
    const known = new Set(this.#tenants.map((t) => t.name));
    const grew = tenants.some((t) => !known.has(t.name));
    if (JSON.stringify(tenants) !== JSON.stringify(this.#tenants)) {
      this.#tenants.splice(0, this.#tenants.length, ...tenants);
    }
    if (JSON.stringify(holders) !== JSON.stringify(this.#holders)) {
      this.#holders.splice(0, this.#holders.length, ...holders);
    }
    if (grew && this.#arbiter !== null) this.#recover();
  }

  /** Whether this host has anything to arbitrate. */
  #hasGpuService(): boolean {
    return this.#services.some(
      (s) =>
        s.enabled &&
        (s.service.gpu?.policy === "on_demand" || s.service.gpu?.policy === "evictable"),
    );
  }

  /**
   * Makes the arbiter when everything it needs is there; `null` (with `reason`) when not. An
   * unreadable card is asked again at most every ten seconds.
   */
  ensure(): Promise<Arbiter | null> {
    if (this.#arbiter !== null || this.#closed || this.#o.mode !== "hostd") {
      return Promise.resolve(this.#arbiter);
    }
    if (!this.#hasGpuService()) {
      this.#reason = "這台沒有 [gpu] policy 是 on_demand 或 evictable 的服務";
      return Promise.resolve(null);
    }
    if (this.#making !== null) return this.#making;
    if (Date.now() - this.#triedAt < RETRY_CARD_MS) return Promise.resolve(null);
    this.#making = this.#make().finally(() => {
      this.#making = null;
    });
    return this.#making;
  }

  async #make(): Promise<Arbiter | null> {
    this.#triedAt = Date.now();
    const sample = await this.#o.read().catch(() => null);
    if (this.#closed || this.#arbiter !== null) return this.#arbiter;
    if (sample === null) {
      this.#reason = "讀不到 NVIDIA 顯卡(沒有卡、沒有驅動,或 NVML 與 nvidia-smi 都失敗)";
      this.#o.log.warn("GPU arbiter: the graphics card cannot be read; gpu.* is unavailable");
      return null;
    }
    const settings = holderSettings(this.#services);
    const policy = policyFrom(settings);
    const limits = limitsFrom(settings);
    const arbiter = new Arbiter({
      clock: monotonic,
      timers: realTimers,
      readDevice: deviceReader(this.#o.read),
      peers: new HttpPeerClient(this.#o.target),
      tenants: this.#tenants,
      holders: this.#holders,
      policy,
      limits,
      profile: new CardProfile(jsonProfileStore(this.#o.profileFile, this.#o.log)),
      reloadTimeoutS: setting(settings, "SING_RELOAD_TIMEOUT_S", "float", 300.0),
      yieldPollS: setting(settings, "SING_YIELD_POLL_MS", "int", 100) / 1000,
      yieldHoldS: setting(settings, "SING_YIELD_HOLD_MS", "int", 300) / 1000,
      onEvent: (event) => this.#event(event),
    });
    this.#arbiter = arbiter;
    this.#o.log.info(
      {
        card: sample.name,
        total_mb: sample.total_mb,
        policy: policy.policy,
        policy_source: policy.source,
        tenants: this.#tenants.map((t) => t.name),
        holders: [...this.#holders],
      },
      "GPU arbiter running",
    );
    this.#recover();
    this.#o.changed();
    return arbiter;
  }

  /** Asks back a speech service a holder left offline, unless a lease is held now. */
  #recover(): void {
    const arbiter = this.#arbiter;
    if (arbiter === null || this.#tenants.length === 0) return;
    if (arbiter.state().jobs.length > 0) return;
    void arbiter.recover().then(
      (asked) => {
        if (asked.length > 0) {
          this.#o.log.info({ asked }, "GPU arbiter: asked speech left offline to reload");
        }
      },
      (error: unknown) => this.#o.log.warn({ err: error }, "GPU arbiter: recover failed"),
    );
  }

  #event(event: ArbiterEvent): void {
    if (event.type === "decision") {
      const e = event.entry;
      this.#last = {
        lease: event.job,
        stage: e.stage,
        mode: e.mode,
        code: e.code,
        reason: e.reason,
        at: this.#now(),
      };
      this.#o.log.info(
        {
          lease: event.job,
          stage: e.stage,
          mode: e.mode,
          code: e.code,
          reason: e.reason,
          free_mb: e.free_mb,
          need_mb: e.need_mb,
          people: e.people,
          urgent: e.urgent,
        },
        "gpu decision",
      );
    } else {
      this.#leases.delete(event.job);
      this.#o.log.warn(
        { lease: event.job, holder: event.holder, why: event.why },
        "GPU lease ended without a release; speech is brought back",
      );
    }
    this.#o.changed();
  }

  /** `cluster.context`: dropped while no arbiter runs (Core sends it again within seconds). */
  context(context: HostClusterContext): void {
    this.#arbiter?.context(context);
  }

  /** The holder's process is gone: what its jobs took offline comes back now. */
  holderGone(name: string): void {
    const arbiter = this.#arbiter;
    if (arbiter === null) return;
    for (const [lease, info] of this.#leases) if (info.holder === name) this.#leases.delete(lease);
    void arbiter
      .holderGone(name)
      .catch((error: unknown) =>
        this.#o.log.warn({ err: error, holder: name }, "GPU arbiter: bringing speech back failed"),
      );
  }

  /** Stops every loop of the arbiter (the daemon is stopping, before its services). */
  close(): void {
    this.#closed = true;
    this.#arbiter?.close();
    this.#leases.clear();
  }

  /** The lease's holder must be the caller. */
  #own(lease: string, holder: string): void {
    const known = this.#leases.get(lease);
    if (known !== undefined && known.holder !== holder) {
      throw new HostRpcError(
        HOST_ERROR_CODE.NotAllowed,
        `the lease ${lease} is ${known.holder}'s, not ${holder}'s`,
      );
    }
  }

  /** One `gpu.*` call. `holder` is the calling service (`null` for `gpu.state` from elsewhere). */
  async call(
    arbiter: Arbiter,
    method: string,
    params: unknown,
    holder: string | null,
  ): Promise<unknown> {
    switch (method) {
      case "gpu.acquire": {
        const p = parse(HostGpuAcquireSchema, params);
        const who = holder as string;
        this.#own(p.job, who);
        if (!this.#leases.has(p.job)) {
          this.#leases.set(p.job, { holder: who, since: this.#now(), evict: [] });
          this.#o.changed();
        }
        const result = await arbiter.acquire(who, p);
        const lease = this.#leases.get(p.job);
        if (lease !== undefined) {
          if (result.type === "wait" && result.announce) lease.evict = [...result.evict];
          if (result.type === "granted" && result.mode === "exclusive" && p.announced) {
            lease.evict = [...result.evicted];
          }
        }
        if (result.type === "refused") this.#o.changed();
        return result;
      }
      case "gpu.renew": {
        const p = parse(HostGpuRenewSchema, params);
        this.#own(p.lease, holder as string);
        const result = await arbiter.renew(p);
        const lease = this.#leases.get(p.lease);
        if (lease !== undefined && result.action?.type === "offload")
          lease.evict = [...result.evict];
        if (!result.ok) this.#leases.delete(p.lease);
        return result;
      }
      case "gpu.release": {
        const p = parse(HostGpuReleaseSchema, params);
        this.#own(p.lease, holder as string);
        const result = await arbiter.release(p);
        if (p.done) {
          this.#leases.delete(p.lease);
          this.#o.changed();
        }
        return result;
      }
      case "gpu.busy": {
        const p = parse(HostGpuBusySchema, params);
        this.#own(p.lease, holder as string);
        return arbiter.busy(p);
      }
      case "gpu.state":
        parse(z.object({}), params);
        return arbiter.state();
      default:
        throw new HostRpcError(JSON_RPC.MethodNotFound, `method not found: ${method}`);
    }
  }

  /** Why `gpu.*` is unavailable now. */
  get reason(): string {
    return this.#reason;
  }

  /** The short form for `host.info`. */
  status(): HostGpuArbiterStatus {
    const arbiter = this.#arbiter;
    if (arbiter === null) {
      return {
        mode: this.#o.mode,
        active: false,
        ...(this.#o.mode === "hostd" ? { reason: this.#reason } : {}),
        leases: [],
        last: this.#last,
      };
    }
    const state = arbiter.state();
    const nameOf = (url: string) => this.#tenants.find((t) => t.url === url)?.name ?? url;
    const leases: HostGpuLeaseStatus[] = state.jobs.map((j) => {
      const known = this.#leases.get(j.lease);
      const off =
        j.eviction === "offloading" || j.eviction === "active" || j.eviction === "reloading";
      return {
        lease: j.lease,
        holder: j.holder,
        stage: j.stage,
        mode: j.mode,
        code: j.code,
        since: known?.since ?? this.#now(),
        window: j.window,
        evicted: off ? (known?.evict ?? []).map(nameOf) : [],
      };
    });
    return {
      mode: this.#o.mode,
      active: true,
      policy: arbiter.policy,
      leases,
      last: this.#last,
    };
  }
}
