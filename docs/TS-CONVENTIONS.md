# TypeScript conventions

How the TypeScript code is organised. Miyoria started as a Rust prototype (kept in git
history) and was ported module by module; module ids, config keys, event topics, JSON shapes and
defaults were kept as they were, and they are now a compatibility contract (stored data, config
files, the panel, voice node, Stage and extensions all depend on them).

Runtime: **Node 24**, **pnpm 9**, ESM only, strict TypeScript 5.9. Database: SQLite
(`node:sqlite`) only.

## 1. Workspace

| Path | Package | Notes |
|---|---|---|
| `packages/<name>` | `@miyoria/<name>` | a package of its own (`types`, `store`, `sing`, ...) |
| `packages/<group>/<part>` | `@miyoria/<group>/<part>` | a part of a group package (`runtime/kernel`, `brain/agent`, `llm/tools`, ...): one `package.json` for the group, one folder with `src/` and `test/` per part |
| `packages/cli` | `miyoria` | the CLI / npm package (`miyoria core`, `init`, ...), bundled with esbuild |
| `apps/<name>` | `@miyoria/<name>` | separately run apps (`panel`, `overlay`, `voice-node`) |
| `extensions/**` | `@miyoria/ext-<name>` | extensions (use `@miyoria/sdk` only) |

Root scripts: `pnpm typecheck` / `pnpm test` / `pnpm build` (each = `pnpm -r <script>`),
`pnpm lint` (Biome check), `pnpm format`, `pnpm test:watch` (all Node projects in one Vitest).

### Source resolution (no build needed for typecheck / test / dev)

Every workspace package exports a custom condition first:

```json
"exports": {
  ".": {
    "@miyoria/source": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  }
}
```

- `tsc --noEmit` (`typecheck`) uses `customConditions: ["@miyoria/source"]` from
  `tsconfig.base.json`, so dependencies are type-checked from their `src`.
- Vitest gets the same condition from `vitest.shared.ts` (`nodeProject()`).
- Dev: `tsx --conditions=@miyoria/source src/main.ts`.
- `build` (`tsconfig.build.base.json`) clears the condition and resolves dependencies to their
  `dist/*.d.ts`; `pnpm -r build` runs in dependency order. Plain `node` resolves `dist`.

### New package checklist

```
packages/<name>/
  package.json          # copy packages/sing/package.json: name, deps, same exports/scripts
  tsconfig.json         # { "extends": "../../tsconfig.base.json" }
  tsconfig.build.json   # { "extends": "../../tsconfig.build.base.json" }
  vitest.config.ts      # import { nodeProject } from "../../vitest.shared.ts"; export default nodeProject();
  src/index.ts          # the only entry point; explicit named re-exports
  test/*.test.ts        # (or src/**/*.test.ts, excluded from the build)
```

A new part of an existing group package needs no manifest of its own:

```
packages/<group>/
  package.json          # add "./<part>" to exports, pointing at ./<part>/src/index.ts and ./dist/<part>/src/index.*
  <part>/src/index.ts   # the part's only entry point
  <part>/test/*.test.ts
```

Other packages import a part as `@miyoria/<group>/<part>`. Parts of the same group import each
other by relative path (`../../<part>/src/index.js`), never by the group's own name. The group's
`tsconfig.json` includes `*/src` and `*/test`, and its build keeps the folders (`dist/<part>/src`).
`scripts/merge-packages.py` is what turned separate packages into groups.

Dependencies on other packages are `"@miyoria/<x>": "workspace:*"`.

**Use a package where it does the job better.** Before hand-writing a piece of infrastructure
(data access, migrations, an LLM client, an agent loop, a route table and its typed client, RPC
framing, scheduling, retries), look for a well-maintained package, check its current state in
its own documentation, and say in the design or the commit which ones were considered. Take the
package unless there is a stated cost that outweighs it: a native build that makes installing on
another machine harder, an unmaintained or pre-release package, a known bug on the path we use.
Node built-ins (`fetch`, `node:crypto`, `node:sqlite`, `util.parseEnv`, `AbortSignal`) stay the
first choice for what they cover. Run `pnpm install` from the root (one `pnpm-lock.yaml`).

## 2. Naming and shapes

- Files `kebab-case.ts`; types / classes `PascalCase`; functions / variables `camelCase`;
  constants `UPPER_SNAKE` only for true constants (`STOP_TIMEOUT_MS`). TS-side durations carry
  their unit (`timeoutMs`, `backoff_ms` log fields); JSON fields keep their existing name (`ttl`, `asr_ms`).
- Relative imports end in `.js` (`import { x } from "./bus.js"`); type-only imports use
  `import type` (`verbatimModuleSyntax`).
- **Wire / persisted data has a fixed JSON shape.** Any type that is serialized (events,
  actions, store records, API bodies, config sections, protocol messages) uses snake_case field
  names, and:
  - optional values are `T | null` with the key always present. Pure in-process option bags
    may use `?:` instead.
  - tagged unions are `{ type: "snake_case", data: ... }` (adjacently tagged) or
    `{ type: "snake_case", ...fields }` (internally tagged), whichever the type already uses;
    plain enums are string unions.
  - times are `Timestamp` (RFC 3339 string; compare with `Date.parse`); durations are a
    number of ms; ULIDs are `string` (`newId()`).
  - maps in return values are `Map` (sorted maps: keys ascending).
- **A shape that crosses a process boundary is written once, in `packages/contracts`**, as a zod
  schema (`export const FooSchema = z.object({...}).meta({ id: "<Part>Foo" })`); its type is
  `z.output<typeof FooSchema>`, and `packages/contracts/schema/<part>.json` is generated from the
  schemas (`pnpm contracts:gen`) and checked in. Parts: `wire` (accounts, contexts, messages),
  `events`, `voice-link`, `stage-link`, `overlay`, `workers`. The rules are in
  `packages/contracts/kit/src/index.ts` and a test holds every part to them: no `.transform`
  and no `.refine` (normalise after `parse`, in the receiver), a name on every exported object,
  union and enum, and a field added to a shape already in use is `.optional()` or has a
  `.default()`. `packages/types` re-exports the wire types under their old names; service keys
  and in-process logic stay there.
- **An HTTP route is declared once, in `packages/contracts/api`**, as an oRPC contract (method,
  path, input and output schemas, the audience `admin` / `member` / `public`, a permission node).
  `packages/api` implements it and mounts it in the Hono table; the shell there still owns
  authentication, CSRF, 405 and the body checks, and oRPC owns input and output validation. The
  panel and the CLI call it through the typed client. The panel takes only types from the contract
  and reads the generated `schema/api.routes.json` at run time, so zod stays out of its bundle.
  `packages/contracts` depends on zod and, for this part, on `@orpc/contract` (kept on 1.16.x).
  Routes that are not JSON (images, the OAuth redirects, `/metrics`, panel files) stay plain Hono
  routes.
- TS-only APIs (methods, constructor options, in-process classes) are camelCase:
  `store.dueFollowups(...)`, `new OpenAiConfig(...).timeoutMs`.
- **Module ids, config keys, event topics, service names, permission nodes, settings keys and
  JSON shapes are a compatibility contract.** Grep the existing packages (and
  `docs/protocols/`) before inventing a name; changing one needs a migration or a note in the
  docs.
- Language: code, comments, logs and errors in English. Only user-facing strings (chat
  replies, prompt text, CLI output, panel text) are Traditional Chinese.

## 3. Errors

- Throw `Error` subclasses with a `name` and a short, specific message
  (`` `unknown module \`${id}\`` ``). Keep data on the error (`code`, `status`, `path`), attach
  causes with `{ cause }`.
- No `any` (Biome errors on it). Use `unknown` + narrowing, zod for untrusted input.
- Never put secrets in messages, logs or `toJSON` / `util.inspect` output (see
  `OpenAiConfig`).
- `catch (error)` is `unknown`; use `errorMessage(error)` from `@miyoria/runtime/kernel` for text.

## 4. Async and cancellation

- Every cancellable or long-running call takes an `AbortSignal` (last parameter or in an
  options object) and passes it on (`fetch`, `sleep`, child calls). Module code uses
  `ctx.signal` / the task's signal.
- No floating promises (Biome `noFloatingPromises` is an error). Await, return, or hand the
  work to `ctx.spawn`. Fire-and-forget is only `void p.catch(log)` with a reason.
- Use `sleep(ms, signal)`, `interval(ms, signal)`, `withTimeout`, `SerialQueue` from
  `@miyoria/runtime/kernel`. They use global timers, so Vitest fake timers control them; do not use
  `node:timers/promises`.
- Streams are `AsyncIterable`s (`for await`, `break` to stop; implement `return()` cleanup).

## 5. Logging

- One pino root, configured once by the app (`configureLogging({ level })`; env
  `MIYORIA_LOG_LEVEL`; silent under Vitest).
- Module code logs with `ctx.log` (bound to `{ module }`); library code creates a scoped logger
  at import time: `const log = getLogger("llm.router")`.
- Structured fields first: `log.warn({ model, err }, "model failed, trying next in chain")`.
  Keep existing messages stable; people grep logs for them.

## 6. Config

- Loading: `loadDotenv(configPath)` (`.env` next to `miyoria.toml`, never overrides the
  environment), then `Config.load(path)`: TOML via `smol-toml`, `${VAR}` / `${VAR:-default}`
  interpolation, `config.module(id)` → `{ enabled, config }` (`enabled = false` disables).
- Every module exports a **zod** schema of its section with a default for every field (equal
  to `miyoria.example.toml`). `z.object` (unknown keys ignored) with `.default(...)` per field;
  nested sections use **`.prefault({})`** (zod 4's `.default({})` skips parsing and would drop
  the nested defaults).
- In `start`: `const cfg = ctx.config(MyConfigSchema)` (missing section = `{}`); an invalid
  config throws `ConfigError` and fails the start. Put the schema in the manifest
  (`configSchema`) so the panel gets a JSON Schema (`manifestJson`).
- **One schema for the whole file.** A top-level section (`[llm]`, `[speech]`, `[mcp]`, ...) has
  its zod schema next to the code that reads it, exported by that package; `[core]` is the
  kernel's `CoreSectionSchema`, `[stack]` and `[machine]` are the CLI's. Core composes the root
  (`rootConfigSchema` in `packages/core/src/config-schema.ts`, with the kernel's
  `composeConfigSchema`): each section, and each module's own `configSchema` under
  `modules.<id>` plus `enabled`. A new section or module goes into `CONFIG_SECTIONS` /
  `MODULE_CONFIG_SCHEMAS` there (a test checks the second against the real manifests). Core
  checks the file with it before anything starts, the store checks config revisions with it, and
  `miyoria config set` and the prompts check values with it (the CLI adds its two sections).
  Which problems stop the start is `startPolicy`'s: exactly what the readers stopped on before,
  so a file that loads keeps loading. `configJsonSchema` is the one JSON Schema emitter, for a
  module and for the whole file. A config schema follows the contract rules where they fit:
  avoid `.refine` (the check runs it, the JSON Schema cannot show it), but defaults and a
  `.transform` of the output are fine, since only the input is emitted.

## 7. Time

Never call `Date.now()` / `new Date()` in logic you want to test. Take a `Clock`
(`{ now(): number }`, `systemClock` by default; modules have `ctx.clock`) or use Vitest fake
timers (`vi.useFakeTimers()` also fakes `Date.now()` and the kernel timers).

## 8. Kernel API (what modules see)

```ts
import { defineManifest, type Module, type ModuleContext } from "@miyoria/runtime/kernel";

export const SchedulerConfigSchema = z.object({ text_rate_ms: z.number().default(1000) });

export class SchedulerModule implements Module {
  static readonly ID = "scheduler";
  readonly manifest = defineManifest(SchedulerModule.ID, "Scheduler", {
    requires: ["llm"], optional: ["voice"], configSchema: SchedulerConfigSchema,
  });

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config(SchedulerConfigSchema);
    ctx.provide(ActionSinkKey, new Scheduler(cfg));            // removed again on stop
    const sinks = ctx.services.require(PlatformSinksKey);      // throws ServiceUnavailableError
    const sub = ctx.subscribe(["platform.*", "agent.turn.completed"]); // closed on stop
    ctx.spawn("events", async (signal) => {
      for await (const env of sub) { /* narrow with is(Events.X, env); env.data is then typed */ }
    });
    ctx.publish(Events.ActionSettled, settled, { turn: action.turn });
  }

  async stop(): Promise<void> { /* optional; runs before tasks are aborted */ }
}
```

- `start` returns quickly; long work goes into `ctx.spawn(name, (signal) => ...)`. A task (or
  `start`) that rejects before stop marks the module `failed`; the supervisor restarts it with
  backoff 2 s, 4 s, 8 s ... (max 60 s), giving up after 5 failures in 10 minutes. Tasks must
  settle within 5 s of `signal` aborting.
- `Supervisor`: `register(module, config, enabled)`, `startAll()` (topological over
  `requires` + `optional`), `stopAll()`, `enable / disable / restart(id)`, `list()` →
  `ModuleStatus[]` (the JSON the API serves). Disabling a module stops everything that `requires` it.
  Every transition is published as `system.module.state` from source `kernel`. Never call the
  supervisor from inside `start` / `stop` (deadlock); from tasks is fine. The app provides it
  as `SupervisorKey` for admin modules.
- `EventBus`: `publish(source, Events.X, data, { turn, parent, ... })` (a module uses
  `ctx.publish(Events.X, data, meta)`; every type is a definition in `@miyoria/contracts/events`,
  re-exported as `Events` by `@miyoria/types`; `is(Events.X, env)` narrows `env.data`),
  `subscribe(filter)`
  (`"*"`, `"prefix.*"`, exact; string or list) → `Subscription` (`for await`, `recv()`,
  `tryRecv()`, `close()`); per-subscriber buffer of 4096, oldest dropped on lag.

### Services: `ServiceKey<T>`

Services are looked up with a typed token declared next to the interface:

```ts
export interface ActionSink { submit(action: Action): Promise<void>; cancelTurn(turn: TurnId): Promise<void> }
export const ActionSinkKey = serviceKey<ActionSink>("ActionSink"); // id = interface name

ctx.provide(ActionSinkKey, impl);          // owner = this module, removed when it stops
ctx.services.get(ActionSinkKey);           // ActionSink | undefined
ctx.services.require(ActionSinkKey);       // or throws ServiceUnavailableError
```

Keys exist for every core service: `ActionSinkKey`, `VoiceSinkKey`, `AuthorizerKey`,
`SocialSignalsKey`, `MoodSignalsKey`, `FollowupSourceKey`, `PlatformSinksKey`,
`PromptContributorsKey` (`@miyoria/types`), `SupervisorKey` (`kernel`), `LlmRouterKey`
(`llm`), `ToolRegistryKey` (`tools`), one per store area plus `StoreKey` (`store`). A module that
owns a new service exports its key from its own package. Look services up when needed; don't
cache another module's service across its restarts.

## 9. Tests

- Vitest, `test/*.test.ts` (or `src/**/*.test.ts`). Cover behaviour, cancellation and the JSON
  shapes of anything serialized.
- Time-dependent code: fake timers or an injected `Clock`. Restore with `vi.useRealTimers()`
  in `afterEach`.
- No real network. HTTP clients are tested against a local `node:http` server on
  `127.0.0.1:0` (see `packages/llm/llm/test/openai.test.ts`); other I/O through in-memory
  implementations (`MemorySettingsStore`, `MockProvider`).
- Module tests run the real `Supervisor`: register, `startAll()`, assert on services, events
  (`sub.tryRecv()`) and `list()`, then `stopAll()`.
- Temp files under `os.tmpdir()` (`mkdtempSync`), removed in `finally`.

## 10. Lint and format

Biome (`biome.json`): 2-space indent, 100 columns, double quotes, trailing commas, organized
imports, recommended rules plus `noExplicitAny`, `useImportType`, `noFloatingPromises`. Run
`pnpm format` before committing. The packages that were written before the rest of the TS workspace (`apps/panel`,
`apps/overlay`, `apps/voice-node`, `packages/sdk`, `extensions/minecraft/adapter`,
`extensions/examples/hello`) are lint-only with their
current violations switched off (see the override); new packages get the full rules.
