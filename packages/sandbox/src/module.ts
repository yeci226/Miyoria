import { resolve } from "node:path";
import { actuatorsFor } from "@miyoria/actions";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  sleep,
} from "@miyoria/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import { customEvent, FileReaderKey, type ProfileId } from "@miyoria/types";
import { SandboxConfigSchema } from "./config.js";
import { SandboxFileReader } from "./files.js";
import { SandboxGate } from "./gate.js";
import { ProposedTools, ProposedToolsKey } from "./proposed.js";
import { type DockerRunner, ProcessDockerRunner } from "./runner.js";
import { DockerSandbox } from "./sandbox.js";
import { SandboxKey } from "./types.js";

export interface SandboxModuleOptions {
  /** Directory `root` resolves against (the directory of `miyoria.toml`). */
  baseDir: string;
  /** Docker CLI runner; default spawns `config.docker` (tests inject a fake). */
  runner?: (executable: string) => DockerRunner;
}

/**
 * Module `sandbox`: provides `SandboxKey` (Docker code sandbox and the profile's tools
 * workspace) and, with the settings store, `ProposedToolsKey`. Opt-in (`enabled = true`).
 *
 * At start it checks Docker in the background, removes containers this instance left behind
 * (pooled and session ones too), prunes old run and session workspaces, then fills the warm pool
 * (only with `pool_size` > 0; it is off by default). Without Docker the module runs degraded:
 * `run` throws `unavailable` and the health shows why, until Docker comes back (re-checked on
 * use). Stopping it removes the pool's and her sessions' containers.
 *
 * While Docker is available it registers `code.run`, `code.session`, `tool.propose` and one
 * `sbx.<name>` per approved tool she wrote in the app's actuator registry (see `gate.ts`); they
 * are withdrawn when Docker goes away (re-checked every `recheck_ms`). `/admin autonomy status`
 * shows the sandbox, her sessions and the proposed tools.
 */
export class SandboxModule implements Module {
  static readonly ID = "sandbox";
  readonly manifest = defineManifest(SandboxModule.ID, "Code sandbox", {
    description: "Runs code she writes in disposable, offline Docker containers",
    configSchema: SandboxConfigSchema,
  });
  #sandbox: DockerSandbox | null = null;
  #gate: SandboxGate | null = null;
  #removeStatus: (() => void) | null = null;

  constructor(
    readonly profile: ProfileId,
    readonly options: SandboxModuleOptions,
  ) {}

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(SandboxConfigSchema);
    const runner = (this.options.runner ?? ((exe) => new ProcessDockerRunner(exe)))(config.docker);
    const publisher = (topic: string, payload: Parameters<typeof customEvent>[1]) =>
      ctx.publish(customEvent(topic, payload));
    const sandbox = new DockerSandbox(config, {
      root: resolve(this.options.baseDir, config.root),
      profile: this.profile,
      runner,
      clock: ctx.clock,
      publisher,
    });
    this.#sandbox = sandbox;
    ctx.provide(SandboxKey, sandbox);
    if (config.files.enabled) {
      ctx.provide(
        FileReaderKey,
        new SandboxFileReader({ sandbox, config: config.files, clock: ctx.clock }),
      );
    }
    const store = ctx.services.get(SettingsStoreKey);
    let tools: ProposedTools | null = null;
    if (store) {
      tools = new ProposedTools({
        store,
        profile: this.profile,
        sandbox,
        clock: ctx.clock,
        publisher,
        maxTools: config.max_proposed_tools,
        maxCodeBytes: config.caps.max_code_bytes,
      });
      ctx.provide(ProposedToolsKey, tools);
    } else {
      ctx.log.warn("no settings store; proposed tools are unavailable");
    }

    const registry = actuatorsFor(ctx);
    const gate = new SandboxGate(registry, {
      sandbox,
      tools,
      resultChars: config.result_chars,
      toolTimeoutMs: config.tool_timeout_ms,
    });
    this.#gate = gate;
    this.#removeStatus = registry.addStatus(SandboxModule.ID, () =>
      gate.statusLines(sandbox.lastHealth),
    );
    // Proposals and reviews (her own, the owners' API) change which tools are offered.
    const toolEvents = ctx.subscribe(["sandbox.tool.*"]);
    ctx.spawn("tools", async () => {
      for await (const _ of toolEvents) await gate.refreshTools();
    });

    ctx.spawn("startup", async (signal) => {
      // Leftovers of an earlier process go first, then the warm pool starts (once Docker answers).
      let reaped = false;
      const reapOnce = async () => {
        if (reaped) return;
        await sandbox.reap(signal);
        reaped = true;
        sandbox.warm();
      };
      try {
        const health = await sandbox.health({ signal, refresh: true });
        await gate.setAvailable(health.available);
        if (health.available) await reapOnce();
        await sandbox.prune();
      } catch (error) {
        if (!signal.aborted)
          ctx.log.warn({ err: errorMessage(error) }, "sandbox startup checks failed");
      }
      // Offer the capabilities only while Docker answers.
      while (!signal.aborted) {
        try {
          await sleep(config.recheck_ms, signal);
          const health = await sandbox.health({ signal, refresh: true });
          await gate.setAvailable(health.available);
          if (health.available) await reapOnce();
        } catch (error) {
          if (signal.aborted) return;
          ctx.log.warn({ err: errorMessage(error) }, "sandbox health check failed");
        }
      }
    });
  }

  async stop(): Promise<void> {
    this.#removeStatus?.();
    this.#removeStatus = null;
    this.#gate?.close();
    this.#gate = null;
    const sandbox = this.#sandbox;
    this.#sandbox = null;
    await sandbox?.close();
  }

  async health(): Promise<Health> {
    const sandbox = this.#sandbox;
    if (!sandbox) return { status: "unhealthy", reason: "not running" };
    const health = sandbox.lastHealth;
    if (health.checked_at === null) return { status: "degraded", reason: "checking docker" };
    if (!health.available) {
      return { status: "degraded", reason: `docker unavailable: ${health.error ?? "unknown"}` };
    }
    return HEALTHY;
  }
}
