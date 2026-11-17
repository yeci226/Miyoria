// The artifact store's events: kept forever, share events a year, all but `artifact.created` for
// the owner; song covers and the other vocabularies are closed enums.

import { describe, expect, it } from "vitest";
import {
  ARTIFACT_EVENTS,
  ArtifactCreated,
  ArtifactSourceSchema,
  EventRegistry,
  readEventData,
  ShareModeSchema,
} from "../src/index.js";

describe("artifact events", () => {
  it("are kept as §2.5 says, scoped to the owner except the creation", () => {
    const registry = new EventRegistry().register(...ARTIFACT_EVENTS);
    expect(registry.defaults("artifact.created")).toEqual({ scope: null, tier: "keep" });
    for (const type of ["artifact.expired", "artifact.taken_down", "artifact.swept"]) {
      expect(registry.defaults(type)).toEqual({ scope: "owner", tier: "keep" });
    }
    for (const type of ["share.created", "share.revoked", "share.opened"]) {
      expect(registry.defaults(type)).toEqual({ scope: "owner", tier: "long" });
    }
  });

  it("read a creation back and refuse a malformed hash", () => {
    const data = {
      artifact_id: "01JZ0000000000000000000000",
      sha256: "a".repeat(64),
      size: 3,
      mime: "text/plain",
      kind: "text",
      filename: "note.txt",
      source: "doc",
      plugin: "notebook",
      made_for: null,
      derived_from: null,
      expires_at: "2026-11-22T00:00:00.000Z",
      kept_by: null,
      downloadable: true,
    };
    expect(readEventData(ArtifactCreated, { type: "artifact.created", v: 1, data })).toEqual(data);
    expect(() =>
      readEventData(ArtifactCreated, {
        type: "artifact.created",
        v: 1,
        data: { ...data, sha256: "../../etc" },
      }),
    ).toThrow();
  });

  it("name song covers and the two share modes", () => {
    expect(ArtifactSourceSchema.options).toContain("sing");
    expect(ShareModeSchema.options).toEqual(["stream", "download"]);
  });
});
