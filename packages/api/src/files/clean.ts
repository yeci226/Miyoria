// The copy of an image that leaves the store (v5-architecture §11.2: 「圖片重新編碼(去掉 EXIF 和藏在圖
// 裡的東西)」). sharp decodes the picture and encodes its pixels again in the same format: nothing of
// the original file but the pixels survives (EXIF, XMP, ICC, PNG text chunks, comments, trailing
// bytes after the image), since sharp writes no metadata unless asked to. A JPEG's orientation is
// applied to its pixels first, so it still looks the right way up. An animated GIF or WebP keeps
// its frames.
//
// The copy is an artifact of its own (`handout.ts`): made once per original and found again the
// next time, with the original's place, scope, person and retention, so whoever could see the
// original sees the copy and nobody else.

import {
  type Artifact,
  type ArtifactCleaner,
  type ArtifactStore,
  CLEAN_PLUGIN,
  type HandOut,
  isCleanCopy,
} from "@miyoria/store";
import sharp from "sharp";

/** The largest picture decoded, in pixels (a decompression bomb stops here). */
const MAX_PIXELS = 64_000_000;

/** An image could not be decoded or encoded again: it is not handed out. */
export class ImageCleanError extends Error {
  override readonly name = "ImageCleanError";
}

/** `bytes` (an image of `mime`) decoded and encoded again, without any metadata. */
export async function reencode(bytes: Uint8Array, mime: string): Promise<Buffer> {
  const animated = mime === "image/gif" || mime === "image/webp";
  try {
    let image = sharp(bytes, { animated, limitInputPixels: MAX_PIXELS, failOn: "error" });
    switch (mime) {
      case "image/png":
        return await image.rotate().png({ compressionLevel: 9 }).toBuffer();
      case "image/jpeg":
        return await image.rotate().jpeg({ quality: 92 }).toBuffer();
      case "image/webp":
        image = image.webp({ quality: 92 });
        return await image.toBuffer();
      case "image/gif":
        return await image.gif().toBuffer();
      default:
        throw new ImageCleanError(`not an image type that is re-encoded: ${mime}`);
    }
  } catch (error) {
    if (error instanceof ImageCleanError) throw error;
    throw new ImageCleanError(`the image cannot be re-encoded: ${String(error)}`, {
      cause: error,
    });
  }
}

/** Makes and finds the cleaned copies of images in one artifact store. */
export class ImageCleaner implements ArtifactCleaner {
  readonly #store: () => ArtifactStore | undefined;
  /** Copies being made, by original: two hand-outs at once make one copy. */
  readonly #making = new Map<string, Promise<Artifact>>();

  constructor(store: () => ArtifactStore | undefined) {
    this.#store = store;
  }

  async handOut(artifact: Artifact, signal?: AbortSignal): Promise<HandOut> {
    if (artifact.kind !== "image") return { artifact, stripped: false };
    if (isCleanCopy(artifact)) return { artifact, stripped: true };
    const store = this.#store();
    if (store === undefined) throw new ImageCleanError("there is no artifact store");
    const found = store
      .list({ derived_from: artifact.id, plugin: CLEAN_PLUGIN, limit: 1 })
      .find((copy) => store.isLive(copy));
    if (found !== undefined) return { artifact: found, stripped: true };
    let making = this.#making.get(artifact.id);
    if (making === undefined) {
      making = this.#copy(store, artifact, signal).finally(() => {
        this.#making.delete(artifact.id);
      });
      this.#making.set(artifact.id, making);
    }
    return { artifact: await making, stripped: true };
  }

  async #copy(store: ArtifactStore, artifact: Artifact, signal?: AbortSignal): Promise<Artifact> {
    const bytes = await store.readContent(artifact, signal);
    const clean = await reencode(bytes, artifact.mime);
    return store.ingest(clean, {
      source: artifact.source,
      plugin: CLEAN_PLUGIN,
      filename: artifact.filename,
      mime: artifact.mime,
      place: {
        session: artifact.origin_session,
        space_id: artifact.space_id,
        room_id: artifact.room_id,
      },
      scope: artifact.scope,
      made_for: artifact.made_for,
      turn: artifact.turn,
      derived_from: artifact.id,
      keep: artifact.kept_by,
      expiresAtMs: artifact.expires_at === null ? null : Date.parse(artifact.expires_at),
      ...(signal === undefined ? {} : { signal }),
    });
  }
}
