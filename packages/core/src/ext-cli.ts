// What `miyoria ext ...` needs from the extension host. The
// adapter to `@miyoria/plugin-host/ext-host` lives in `modules.ts`.

import type { Config } from "@miyoria/runtime/kernel";

export interface ExtensionManifestInfo {
  id: string;
  version: string;
}

export interface ExtensionListing {
  dir: string;
  manifest: ExtensionManifestInfo | null;
  enabled: boolean;
  runs_on_core: boolean;
  problems: string[];
}

export interface InstalledExtension {
  id: string;
  dir: string;
  warnings: string[];
}

export interface ExtensionValidation {
  manifest: ExtensionManifestInfo | null;
  errors: string[];
  warnings: string[];
}

export interface NewExtensionOptions {
  /** `@miyoria/sdk` version spec: `workspace:*` inside the monorepo, `^0.2.0` elsewhere. */
  sdk: string;
  id: string | null;
}

export interface ExtensionsCli {
  /** Creates a TypeScript extension skeleton; returns its directory. */
  newExtension(parent: string, name: string, options: NewExtensionOptions): Promise<string>;
  list(config: Config, base: string): Promise<ExtensionListing[]>;
  /** From a local path or a git URL. */
  install(config: Config, base: string, source: string): Promise<InstalledExtension>;
  validate(dir: string): Promise<ExtensionValidation>;
}
