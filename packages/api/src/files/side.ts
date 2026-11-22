// The running file side of an `api` module: the file origin (when one is configured), the tickets
// the member site hands to it, the link service and the image cleaner.

import type { ArtifactCleaner } from "@miyoria/store";
import type { FilesConfig } from "./config.js";
import type { FileLinkService } from "./links.js";
import type { Tickets } from "./tickets.js";

export interface FilesSide {
  config: FilesConfig;
  /** The file origin, `https://files.example.com`; `null`: links are off. */
  origin: string | null;
  /** The member site a scoped link's visitor logs in on; `null`: none (no Discord login). */
  site: string | null;
  tickets: Tickets;
  /** `null` without a file origin. */
  links: FileLinkService | null;
  cleaner: ArtifactCleaner;
}
