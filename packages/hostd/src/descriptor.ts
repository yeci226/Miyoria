// The `service.toml` hostd reads: the shared descriptor of `@miyoria/contracts/host` with hostd's own
// `[[install.files]]` (docs/design/v5-hostd.md §2, §9). Each file names where it comes from (an
// https URL, or a Hugging Face repository at a pinned commit), its SHA-256 and size, what it is
// and its licence. What the schema cannot say (exactly one source, a path that stays inside the
// model folder, a host on the allowlist, a commit rather than a branch) is checked here too, so
// a descriptor that breaks a rule is a catalog problem with a readable message.

import { HostInstallSchema, HostServiceSchema } from "@miyoria/contracts/host";
import { z } from "zod";
import { DOWNLOAD_HOSTS, hostAllowed } from "./install/download.js";

const SHA256 = /^[0-9a-fA-F]{64}$/;
/** A full commit id: a branch or a tag would let the file change under the checksum. */
const COMMIT = /^[0-9a-f]{40}$/;
const HF_REPO = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;
/** A github.com URL may only be a release asset. */
const GITHUB_RELEASE = /^\/[^/]+\/[^/]+\/releases\/download\//;

/**
 * Why a relative path is not acceptable, or `null`. Used for `path` (below the model folder) and
 * for `file` (inside a Hugging Face repository).
 */
export function relativePathProblem(path: string): string | null {
  if (path.includes("\\")) return "use / between folders, not \\";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "must be relative, not absolute";
  if (path.includes("{")) return "may not hold placeholders";
  const parts = path.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) {
    return "may not have empty, . or .. parts";
  }
  return null;
}

export const InstallFileSchema = z
  .object({
    /** Where the file goes, relative to the host's model folder (`<state>/models`). */
    path: z.string().min(1),
    /** An https URL on the allowlist; or `hf` with `file` and `revision`. */
    url: z.string().min(1).optional(),
    /** A Hugging Face repository, `org/name`. */
    hf: z.string().regex(HF_REPO, "must be a Hugging Face repository, org/name").optional(),
    /** The file inside the repository. */
    file: z.string().min(1).optional(),
    /** The commit of the repository, 40 hex characters. */
    revision: z.string().min(1).optional(),
    sha256: z
      .string()
      .regex(SHA256, "must be 64 hex characters")
      .transform((s) => s.toLowerCase()),
    /** Bytes: for the progress, the free-space check and a quick check at start. */
    size: z.number().int().positive(),
    /** What it is, shown to the user (zh-TW). */
    what: z.string().min(1),
    /** An SPDX id or a short note, shown to the user before the download. */
    licence: z.string().min(1),
    /** The service also runs without it (it falls back): hostd starts it anyway. */
    optional: z.boolean().default(false),
    /**
     * Where a machine that fetched this file by hand keeps it, relative to the workspace (the
     * folder of `host.toml`), e.g. `workers/models/vocal-split/MelBandRoformer.ckpt`. When the
     * file is missing here and that one has the same checksum, it is linked in (or copied) instead
     * of downloaded again. Never moved or changed.
     */
    adopt_from: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((f, ctx) => {
    const issue = (message: string, path: string) =>
      ctx.addIssue({ code: "custom", message, path: [path] });
    if (f.path !== undefined) {
      const problem = relativePathProblem(f.path);
      if (problem !== null) issue(`${problem} (a path inside the model folder)`, "path");
      else if (f.path.split("/")[0] === "hf") issue("hf/ is the Hugging Face cache", "path");
      else if (f.path.endsWith(".part")) issue("may not end in .part", "path");
    }
    if (f.adopt_from !== undefined) {
      const problem = relativePathProblem(f.adopt_from);
      if (problem !== null) issue(`${problem} (a path inside the workspace)`, "adopt_from");
    }
    if (f.url !== undefined && f.hf !== undefined) {
      issue("give url or hf, not both", "url");
      return;
    }
    if (f.url === undefined && f.hf === undefined) {
      issue("needs url, or hf with file and revision", "url");
      return;
    }
    if (f.url !== undefined) {
      if (f.file !== undefined) issue("file goes with hf", "file");
      if (f.revision !== undefined) issue("revision goes with hf", "revision");
      let parsed: URL;
      try {
        parsed = new URL(f.url);
      } catch {
        issue("is not a URL", "url");
        return;
      }
      if (parsed.protocol !== "https:") issue("must be https", "url");
      else if (parsed.username !== "" || parsed.password !== "")
        issue("may not hold credentials", "url");
      else if (!hostAllowed(parsed.hostname)) {
        issue(
          `${parsed.hostname} is not on the list of hosts files may come from (${DOWNLOAD_HOSTS.join(", ")})`,
          "url",
        );
      } else if (parsed.hostname === "github.com" && !GITHUB_RELEASE.test(parsed.pathname)) {
        issue(
          "a github.com URL must be a release asset (/<owner>/<repo>/releases/download/...)",
          "url",
        );
      }
      return;
    }
    if (f.file === undefined) issue("hf needs file", "file");
    else {
      const problem = relativePathProblem(f.file);
      if (problem !== null) issue(`${problem} (a file inside the repository)`, "file");
    }
    if (f.revision === undefined)
      issue("hf needs revision (a commit, 40 hex characters)", "revision");
    else if (!COMMIT.test(f.revision)) {
      issue(
        `"${f.revision}" is not a commit: pin the 40-character commit id, not a branch or a tag`,
        "revision",
      );
    }
  });
export type InstallFile = z.output<typeof InstallFileSchema>;

export const ServiceInstallSchema = HostInstallSchema.extend({
  files: z.array(InstallFileSchema).default([]),
});
export type ServiceInstall = z.output<typeof ServiceInstallSchema>;

/** One `service.toml` as hostd reads it. */
export const ServiceDescriptorSchema = HostServiceSchema.extend({
  install: ServiceInstallSchema.default({
    runtime: "none",
    extras: [],
    system: [],
    models: [],
    files: [],
    manual: [],
    check_imports: [],
  }),
});
export type ServiceDescriptor = z.output<typeof ServiceDescriptorSchema>;

/** The URL a file is downloaded from. */
export function sourceUrl(file: InstallFile): string {
  if (file.hf !== undefined) {
    const inside = (file.file ?? "").split("/").map(encodeURIComponent).join("/");
    return `https://huggingface.co/${file.hf}/resolve/${file.revision ?? ""}/${inside}`;
  }
  return file.url ?? "";
}

/** Where a file comes from, for a person: `huggingface.co/org/name` or the URL's host. */
export function sourceLabel(file: InstallFile): string {
  if (file.hf !== undefined) return `huggingface.co/${file.hf}`;
  try {
    return new URL(file.url ?? "").hostname;
  } catch {
    return file.url ?? "";
  }
}
