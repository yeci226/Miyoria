// Build of the published `miyoria` package.
//
// Every `@miyoria/*` workspace package is bundled into `dist/` with esbuild, resolved from source
// through the `@miyoria/source` export condition (no per-package build needed). Third-party
// packages stay external and must be listed in this package's `dependencies`, so npm installs
// them (native ones like `@node-rs/jieba` included); the build fails if one is missing.
//
// Code splitting keeps the lazy `await import("@miyoria/core")` calls lazy: `miyoria --help`
// does not load the core. All chunks sit directly in `dist/`, so code that locates files
// relative to `import.meta.url` keeps working:
//   - `src/assets.ts`: `new URL("..", import.meta.url)` -> package root (`templates/`,
//     `assets/profiles/`, `package.json`)
// Database migrations are TypeScript strings inside the bundle; no files are copied for them.
//
// Copied next to the bundle:
//   - `assets/profiles/`  <- repo `profiles/` (without local-only third-party assets)
//   - `dist/panel/`       <- `apps/panel/dist/` (build it first: `pnpm --filter @miyoria/panel build`)
//   - `dist/overlay/`     <- `apps/overlay/dist/` (`pnpm --filter @miyoria/overlay build`)
//   - the service catalog <- `workers/`, `services/`, `packages/core`, `packages/stage` of the repo,
//     at the same relative paths (see `copyCatalog` below; hostd reads descriptors from the package)

import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { parse as parseToml } from "smol-toml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = new Set(Object.keys(pkg.dependencies ?? {}));

/** `@scope/name/sub` -> `@scope/name`, `name/sub` -> `name`. */
function packageName(spec) {
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

/** Keeps every bare import except `@miyoria/*` external. */
const externalThirdParty = {
  name: "external-third-party",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.kind === "entry-point" || args.path.startsWith("@miyoria/")) return undefined;
      if (/^[A-Za-z]:[\\/]/.test(args.path)) return undefined; // Windows absolute path
      return { path: args.path, external: true };
    });
  },
};

rmSync(join(root, "dist"), { recursive: true, force: true });

const result = await build({
  absWorkingDir: root,
  entryPoints: { main: "src/main.ts", index: "src/index.ts" },
  outdir: "dist",
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "node",
  target: "node24",
  conditions: ["@miyoria/source"],
  plugins: [externalThirdParty],
  chunkNames: "chunk-[hash]",
  sourcemap: "linked",
  sourcesContent: false,
  legalComments: "none",
  metafile: true,
  logLevel: "warning",
});

// Every external import must be a declared dependency (or a Node built-in).
const missing = new Set();
for (const output of Object.values(result.metafile.outputs)) {
  for (const imp of output.imports) {
    if (!imp.external) continue;
    if (imp.path.startsWith("node:")) continue;
    const name = packageName(imp.path);
    if (!declared.has(name)) missing.add(name);
  }
}
if (missing.size > 0) {
  console.error(
    `build: bundled code imports packages missing from packages/cli dependencies: ${[...missing].sort().join(", ")}`,
  );
  process.exit(1);
}
const unused = [...declared].filter(
  (name) =>
    !Object.values(result.metafile.outputs).some((o) =>
      o.imports.some((i) => i.external && packageName(i.path) === name),
    ),
);
if (unused.length > 0)
  console.warn(`build: dependencies not imported by the bundle: ${unused.join(", ")}`);

chmodSync(join(root, "dist", "main.js"), 0o755);

// Profiles. Third-party assets (Live2D models, voice samples) are local-only (see the root
// .gitignore) and never shipped.
const profiles = join(repo, "profiles");
if (!existsSync(profiles)) {
  console.error(`build: ${profiles} not found`);
  process.exit(1);
}
// A profile with its own character (docs/design/v5-profiles.md) also holds that character's
// config, secrets and database; none of those may ever enter the package.
const localOnly = (path) => {
  const p = path.replaceAll("\\", "/");
  return (
    /\/avatar\/model(\/|$)/.test(p) ||
    /\/voice\/[^/]+\.(wav|txt)$/.test(p) ||
    /\/profiles\/[^/]+\/(miyoria\.toml|host\.toml|routes\.toml|data|\.env[^/]*)(\/|$)/.test(p)
  );
};
rmSync(join(root, "assets", "profiles"), { recursive: true, force: true });
cpSync(profiles, join(root, "assets", "profiles"), {
  recursive: true,
  filter: (src) => !localOnly(src),
});

// Left over from builds that copied the store's `.sql` migrations next to the bundle.
rmSync(join(root, "migrations"), { recursive: true, force: true });

// Admin panel and stream overlay (optional: `miyoria core` / `miyoria stage` run without them).
for (const [app, what, pkg] of [
  ["panel", "the admin panel", "@miyoria/panel"],
  ["overlay", "the stream overlay", "@miyoria/overlay"],
]) {
  const built = join(repo, "apps", app, "dist");
  rmSync(join(root, "dist", app), { recursive: true, force: true });
  if (existsSync(join(built, "index.html"))) {
    cpSync(built, join(root, "dist", app), { recursive: true });
  } else {
    console.warn(
      `build: apps/${app}/dist not built; the package ships without ${what} (run \`pnpm --filter ${pkg} build\` first)`,
    );
  }
}

// The service catalog: what `miyoria add` and hostd need on a machine that has no repository.
// Descriptors, and for the Python workers their sources and the locked project; never models,
// voices, environments, tests, caches, Dockerfiles or requirement files. The folders are the
// catalog roots of packages/hostd/src/catalog.ts, at the same relative paths. The voice node
// (apps/voice-node) runs from source and is not packaged yet.
// These three folders of the package only ever hold what is copied here.
for (const dir of ["workers", "services", "packages"]) {
  rmSync(join(root, dir), { recursive: true, force: true });
}

const SKIP_DIRS = new Set(["__pycache__", "tests", "node_modules", ".pytest_cache", ".tmp-test"]);
const skipDir = (name) =>
  SKIP_DIRS.has(name) || name.startsWith(".venv") || name.startsWith(".tmp");

/** Every `.py` below `dir`, as paths relative to `dir`. */
function pythonSources(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDir(entry.name)) out.push(...pythonSources(full, base));
    } else if (entry.name.endsWith(".py")) out.push(relative(base, full));
  }
  return out;
}

/** The names a Python file imports (`import a`, `from a import b`, `from a.b import c`): `a`. */
function importedModules(file) {
  const names = new Set();
  for (const m of readFileSync(file, "utf8").matchAll(
    /^[ \t]*(?:from|import)[ \t]+([A-Za-z_]\w*)/gm,
  )) {
    names.add(m[1]);
  }
  return names;
}

function copyCatalog() {
  const copied = [];
  const copy = (from, to) => {
    mkdirSync(dirname(join(root, to)), { recursive: true });
    cpSync(join(repo, from), join(root, to));
    copied.push(to.replaceAll("\\", "/"));
  };

  // A descriptor's `[routing]` beside it (v5-hostd §15), when it has one.
  const copyRouting = (dir) => {
    const file = join(dir, "routing.toml");
    if (existsSync(join(repo, file))) copy(file, file);
  };

  // Descriptors that run from the package: core, stage and every `services/*`.
  for (const dir of [join("packages", "core"), join("packages", "stage")]) {
    copy(join(dir, "service.toml"), join(dir, "service.toml"));
    copyRouting(dir);
  }
  for (const entry of readdirSync(join(repo, "services"), { withFileTypes: true })) {
    const file = join("services", entry.name, "service.toml");
    if (entry.isDirectory() && existsSync(join(repo, file))) {
      copy(file, file);
      copyRouting(join("services", entry.name));
    }
  }

  // Workers: the Python ones with sources and the locked project, the others with their config.
  const workersDir = join(repo, "workers");
  // The Core image is built without `workers/` in its context (.dockerignore): it runs Core only
  // and needs no worker catalog. The packed npm package is checked for these files in CI.
  if (!existsSync(workersDir)) {
    console.warn("build: no workers/ folder here; the package will not carry the worker catalog");
    return copied;
  }
  const shared = readdirSync(workersDir)
    .filter((f) => f.endsWith(".py") && f !== "gen_contracts.py")
    .map((f) => f.slice(0, -3));
  const needed = new Set();
  const scan = (file) => {
    for (const name of importedModules(file)) if (shared.includes(name)) needed.add(name);
  };
  for (const entry of readdirSync(workersDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || skipDir(entry.name) || entry.name === "fake") continue;
    const dir = join("workers", entry.name);
    const descriptor = join(dir, "service.toml");
    if (!existsSync(join(repo, descriptor))) continue;
    copy(descriptor, descriptor);
    copyRouting(dir);
    const runtime = parseToml(readFileSync(join(repo, descriptor), "utf8")).install?.runtime;
    if (runtime === "python") {
      for (const file of ["pyproject.toml", "uv.lock"]) copy(join(dir, file), join(dir, file));
      for (const py of pythonSources(join(repo, dir))) {
        copy(join(dir, py), join(dir, py));
        scan(join(repo, dir, py));
      }
    } else {
      // A binary the user downloads (MediaMTX): its config only.
      for (const f of readdirSync(join(repo, dir))) {
        if (/\.ya?ml$/.test(f)) copy(join(dir, f), join(dir, f));
      }
    }
  }
  // The shared modules the workers import, and the ones those import.
  for (const name of [...needed]) scan(join(workersDir, `${name}.py`));
  for (const name of [...needed].sort())
    copy(join("workers", `${name}.py`), join("workers", `${name}.py`));
  return copied;
}
const catalogFiles = copyCatalog();

const files = Object.keys(result.metafile.outputs).filter((f) => f.endsWith(".js"));
console.log(
  `build: ${files.length} bundle files in dist/, assets/profiles, ${catalogFiles.length} catalog files`,
);
