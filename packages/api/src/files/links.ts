// Share links on the file origin (v5-architecture §11.2): `https://<file origin>/f/<token>`. The
// `share` tool asks for one when it hands a file over, and the member page when its person changes
// who may open their item. Every rule is checked here, before a token exists:
//
// - only what is in the artifact store, by id: never a path;
// - live (not expired, deleted, blocked or taken down); never a song cover;
// - a type of the allow-list (`allowedType`): images, audio, video, PDF, plain text, read again
//   from the bytes for text, which also passes the secret check (a credential refuses it);
// - an audience no wider than where it was made (`share-policy.ts` in the store);
// - a per-person quota of links in any rolling 24 hours;
// - an image is linked as its cleaned copy (`clean.ts`), never with its metadata.
//
// A link for one person or a server's members needs the Discord login to be opened, so without it
// only links anyone may open are issued.

import type { ShareAudience } from "@miyoria/contracts/events";
import { checkContent } from "@miyoria/gate/actions";
import {
  type Artifact,
  type ArtifactCleaner,
  ArtifactShareError,
  type ArtifactStore,
  type FileLinkRequest,
  type FileLinkResult,
  type FileLinks,
  MEDIA_TYPES,
} from "@miyoria/store";
import {
  type ContextKey,
  type ModerationService,
  maskSecrets,
  type PersonId,
  toTimestamp,
} from "@miyoria/types";

const DAY_MS = 86_400_000;

/** The types a link may open: what the store accepts, all of the allow-list. */
const ALLOWED = new Set(MEDIA_TYPES.map((t) => t.mime));

/** Whether a stored type may leave through the file origin. */
export function allowedType(mime: string): boolean {
  return ALLOWED.has(mime);
}

/** The place a secret check is made for (no platform: the web). */
const WEB: ContextKey = { platform: "web", scope: null, channel: "files", kind: "dm" };

/** Why a text may not leave, if it may not: a credential, or another output rule. */
export function textBlocked(
  text: string,
  moderation: ModerationService | undefined,
): string | null {
  const verdict = moderation?.screen({ path: "other", visible: text, context: WEB, turn: null });
  const block = verdict?.blocked[0];
  if (block !== undefined) return block.rule;
  return maskSecrets(text) === text ? null : "secrets.known-format";
}

/**
 * Checks an artifact's own bytes before they leave: the type again from the content, and a text
 * through the secret check. `null`: fine; else why not.
 */
export async function contentRefusal(
  store: ArtifactStore,
  artifact: Artifact,
  moderation: ModerationService | undefined,
  signal?: AbortSignal,
): Promise<"type_not_allowed" | "secret" | null> {
  if (!allowedType(artifact.mime)) return "type_not_allowed";
  if (artifact.kind !== "text") return null;
  const bytes = await store.readContent(artifact, signal);
  const verdict = checkContent(bytes, false);
  if (!verdict.ok || verdict.mime !== "text/plain") return "type_not_allowed";
  return textBlocked(new TextDecoder("utf-8").decode(bytes), moderation) === null ? null : "secret";
}

export interface FileLinkOptions {
  store: () => ArtifactStore | undefined;
  cleaner: ArtifactCleaner;
  /** The file origin, `https://files.example.com`. */
  origin: string;
  /** Whether links for one person or a server's members can be opened (the Discord login). */
  scoped: () => boolean;
  /** Links per person (the one an artifact was made for) in any rolling 24 hours. */
  perPersonPerDay: number;
  moderation: () => ModerationService | undefined;
  now: () => number;
}

const refuse = (
  refused: Extract<FileLinkResult, { ok: false }>["refused"],
  message: string,
): FileLinkResult => ({ ok: false, refused, message });

/** Issues links on one file origin. */
export class FileLinkService implements FileLinks {
  readonly #o: FileLinkOptions;

  constructor(options: FileLinkOptions) {
    this.#o = options;
  }

  get origin(): string {
    return this.#o.origin;
  }

  available(audience: ShareAudience): boolean {
    return audience === "link" || this.#o.scoped();
  }

  /** How many links were issued for `person` in the last 24 hours, and the quota. */
  quota(person: PersonId): { used: number; per_day: number } {
    const store = this.#o.store();
    const since = toTimestamp(this.#o.now() - DAY_MS);
    return {
      used: store === undefined ? 0 : store.shares.countFor(person, since),
      per_day: this.#o.perPersonPerDay,
    };
  }

  async issue(request: FileLinkRequest, signal?: AbortSignal): Promise<FileLinkResult> {
    const store = this.#o.store();
    if (store === undefined) return refuse("unavailable", "there is no artifact store");
    if (!this.available(request.audience)) {
      return refuse("no_login", "a link for one person or a server needs the Discord login");
    }
    const artifact = store.get(request.artifact_id);
    if (artifact === null || !store.isLive(artifact)) {
      return refuse("not_found", "no such artifact (or it is gone)");
    }
    if (artifact.source === "sing" || !artifact.downloadable) {
      return refuse("song_cover", "song covers are never downloadable");
    }
    const content = await contentRefusal(store, artifact, this.#o.moderation(), signal);
    if (content === "type_not_allowed") {
      return refuse("type_not_allowed", "this type is not handed out");
    }
    if (content === "secret") return refuse("secret", "the text holds what looks like a secret");
    if (artifact.made_for !== null) {
      const { used, per_day } = this.quota(artifact.made_for as PersonId);
      if (used >= per_day) return refuse("quota", "today's links for this person are used up");
    }
    let handed: Artifact;
    let stripped: boolean;
    try {
      ({ artifact: handed, stripped } = await this.#o.cleaner.handOut(artifact, signal));
    } catch {
      return refuse("type_not_allowed", "the image cannot be cleaned, so it is not handed out");
    }
    try {
      const { share, token } = store.shares.create(handed.id, {
        audience: request.audience,
        person_id: request.person_id ?? null,
        space_id: request.space_id ?? null,
        ttlMs: request.ttlMs === undefined ? undefined : request.ttlMs,
        requested_by: request.requested_by ?? null,
        turn: request.turn ?? null,
        widen: request.widen === true,
      });
      return {
        ok: true,
        url: `${this.#o.origin}/f/${token}`,
        share_id: share.id,
        artifact_id: handed.id,
        audience: share.audience,
        expires_at: share.expires_at,
        metadata_stripped: stripped,
      };
    } catch (error) {
      if (error instanceof ArtifactShareError) return refuse("audience", error.message);
      throw error;
    }
  }
}
