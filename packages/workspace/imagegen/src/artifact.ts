// A finished picture as an artifact (v5-architecture §11.2): the file the job left on this
// machine is copied into the artifact store (source `imagegen`), so it can be handed to someone
// with `share`. Nothing calls this yet: no tool of hers asks for a picture, so there is no turn
// to make one for; the first one that does passes the place and person of its turn here.
//
// Only a picture the job itself reports is taken (`job.outputs`), never a path from elsewhere, and
// the store decides the type from the bytes.

import { basename } from "node:path";
import type { Artifact, ArtifactPlace, ArtifactStore } from "@miyoria/store";
import type { ImageJob, ImageOutput, PersonId } from "@miyoria/types";

/** Where and for whom a picture is made. */
export interface ImageArtifactOptions {
  /** Where the turn happens (`ArtifactStore.places.at(...).place`); `null`: at home. */
  place?: ArtifactPlace | null;
  /** The person it is made for. */
  made_for?: PersonId | null;
  turn?: string | null;
  signal?: AbortSignal;
}

/** The picture is not one of this job's results. */
export class ImageArtifactError extends Error {
  override readonly name = "ImageArtifactError";
}

/** Stores `output` of the finished `job` as an artifact. */
export async function ingestImageOutput(
  store: ArtifactStore,
  job: ImageJob,
  output: ImageOutput,
  options: ImageArtifactOptions = {},
): Promise<Artifact> {
  if (job.state !== "done") throw new ImageArtifactError("the job has not finished");
  if (!job.outputs.some((o) => o.path === output.path && o.index === output.index)) {
    throw new ImageArtifactError("the picture is not one of the job's results");
  }
  return store.ingestFile(output.path, {
    source: "imagegen",
    plugin: "imagegen",
    filename: basename(output.file),
    mime: "image/png",
    place: options.place ?? null,
    made_for: options.made_for ?? null,
    turn: options.turn ?? null,
    signal: options.signal,
  });
}
