// Outgoing attachments (v5-architecture §11.2, v5-brain B9): what a platform sink asks when a
// message carries artifact ids. Everything is checked at the moment of the send, whatever an
// earlier step decided:
//
// - the id is a ULID the store has a row for (an id is never a path: the content is found by the
//   row's hash, `paths.ts`);
// - the artifact is live (not deleted, expired, blocked or taken down) and may be downloaded
//   (a song cover may not);
// - the destination may see it: a DM-made artifact goes to that DM only, a room's to that room
//   (and its threads), a space's to that space (`visibility.ts`);
// - it fits what the platform takes there;
// - its bytes are the ones recorded (size and sha256).

import { createHash } from "node:crypto";
import {
  AttachmentError,
  type AttachmentFile,
  type AttachmentOpenOptions,
  type AttachmentSource,
  type ContextKey,
} from "@miyoria/types";
import { ArtifactBlobMissingError, type ArtifactStore } from "./store.js";

/** The `AttachmentSource` over an artifact store. */
export class ArtifactAttachments implements AttachmentSource {
  readonly #store: ArtifactStore;

  constructor(store: ArtifactStore) {
    this.#store = store;
  }

  async open(
    artifactId: string,
    destination: ContextKey,
    options: AttachmentOpenOptions,
  ): Promise<AttachmentFile> {
    const artifact = this.#store.get(artifactId);
    if (artifact === null) throw new AttachmentError("not_found", "no such artifact");
    if (!artifact.downloadable) {
      throw new AttachmentError("not_shareable", "this artifact is never sent as a file");
    }
    const site = this.#store.places.at(destination);
    if (site === null || !this.#store.visibleTo(artifact, site.viewer)) {
      // Gone and "not for this place" read the same from outside.
      const gone = !this.#store.isLive(artifact);
      throw new AttachmentError(
        gone ? "not_found" : "not_visible",
        gone
          ? "the artifact is gone (expired, deleted or taken down)"
          : "the artifact may not be seen where the message is going",
      );
    }
    if (artifact.size > options.maxBytes) {
      throw new AttachmentError(
        "too_large",
        `the file is ${artifact.size} bytes; at most ${options.maxBytes} can be sent there`,
      );
    }
    let data: Uint8Array;
    try {
      data = await this.#store.readContent(artifact, options.signal);
    } catch (error) {
      if (error instanceof ArtifactBlobMissingError) {
        throw new AttachmentError("damaged", "the artifact's bytes are missing", { cause: error });
      }
      throw error;
    }
    if (
      data.length !== artifact.size ||
      createHash("sha256").update(data).digest("hex") !== artifact.sha256
    ) {
      throw new AttachmentError("damaged", "the artifact's bytes are not the ones recorded");
    }
    return {
      artifact_id: artifact.id,
      filename: artifact.filename,
      content_type: artifact.mime,
      size: artifact.size,
      data,
    };
  }
}
