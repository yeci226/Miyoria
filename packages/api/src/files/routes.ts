// The routes of what she made (contracts `files.ts`): the member page 「她做給我的」, the owner's list,
// audit trail and take-down, and the pass the file origin sends a scoped link's visitor through.
//
// A member only ever reaches what was made for them: every route looks the item up by id and
// answers `404` for anything else, gone or not theirs alike.

import type {
  AdminFile,
  FileHistoryEntry,
  FileVisibility,
  MemberFile,
  MemberFiles,
} from "@miyoria/contracts/api";
import type { ShareAudience } from "@miyoria/contracts/events";
import {
  type Artifact,
  type ArtifactStore,
  ArtifactStoreKey,
  audienceAllowed,
  CLEAN_PLUGIN,
  PeopleStoreKey,
} from "@miyoria/store";
import type { AccountRef, PersonId } from "@miyoria/types";
import { os } from "../contract.js";
import { ApiError } from "../errors.js";
import type { Route } from "../route.js";
import { type ApiContext, type ApiState, actorOf } from "../state.js";
import type { FilesSide } from "./side.js";

const DAY_MS = 86_400_000;

/** Wider first. */
const WIDTH: Record<FileVisibility, number> = { none: 0, person: 1, space: 2, link: 3 };

function storeOf(state: ApiState): ArtifactStore {
  return state.service(ArtifactStoreKey, "the artifact store");
}

async function personOf(state: ApiState, c: ApiContext): Promise<PersonId | null> {
  const person = await state.optional(PeopleStoreKey)?.personByAccount(c.get("member").account);
  return (person?.id as PersonId | undefined) ?? null;
}

async function requirePerson(state: ApiState, c: ApiContext): Promise<PersonId> {
  const person = await personOf(state, c);
  if (person === null) throw ApiError.notFound("她還沒有做過東西給你");
  return person;
}

/** The person's own item, live; `404` for anything else. */
function ownItem(store: ArtifactStore, id: string, person: PersonId): Artifact {
  const artifact = store.get(id);
  if (
    artifact === null ||
    artifact.made_for !== person ||
    artifact.plugin === CLEAN_PLUGIN ||
    !store.isLive(artifact)
  ) {
    throw ApiError.notFound("找不到這個檔案");
  }
  return artifact;
}

/** The item and its cleaned copies: the links of an image are on its copy. */
function withCopies(store: ArtifactStore, artifact: Artifact): Artifact[] {
  return [artifact, ...store.list({ derived_from: artifact.id, plugin: CLEAN_PLUGIN, limit: 10 })];
}

const isListenOnly = (a: Artifact) => a.source === "sing" || !a.downloadable;

/** The visibilities an item may take: never wider than where it was made. */
function allowedOf(store: ArtifactStore, artifact: Artifact, person: PersonId): FileVisibility[] {
  if (isListenOnly(artifact)) return ["none"];
  const member = (p: PersonId, s: string) => store.shares.isMember(p, s);
  const out: FileVisibility[] = ["none"];
  const targets: { v: FileVisibility; audience: ShareAudience }[] = [
    { v: "person", audience: "person" },
    { v: "space", audience: "space" },
    { v: "link", audience: "link" },
  ];
  for (const { v, audience } of targets) {
    const verdict = audienceAllowed(
      artifact,
      { audience, person_id: person, space_id: artifact.space_id },
      member,
      audience === "link",
    );
    if (verdict.ok) out.push(v);
  }
  return out;
}

function memberFile(store: ArtifactStore, artifact: Artifact, person: PersonId): MemberFile {
  let visibility: FileVisibility = "none";
  let linkExpires: string | null = null;
  for (const item of withCopies(store, artifact)) {
    for (const share of store.shares.live(item.id)) {
      const v = share.audience as FileVisibility;
      if (WIDTH[v] > WIDTH[visibility]) {
        visibility = v;
        linkExpires = share.expires_at;
      }
    }
  }
  return {
    id: artifact.id,
    filename: artifact.filename,
    kind: artifact.kind,
    mime: artifact.mime,
    size: artifact.size,
    source: artifact.source,
    made_at: artifact.created_at,
    expires_at: artifact.expires_at,
    kept: artifact.kept_by !== null,
    made_in: artifact.space_id !== null ? "server" : artifact.scope === "dm" ? "dm" : "elsewhere",
    visibility,
    link_expires_at: linkExpires,
    listen_only: isListenOnly(artifact),
    allowed: allowedOf(store, artifact, person),
  };
}

function filesSide(state: ApiState): FilesSide | null {
  return state.files;
}

/** Why a link was refused, in her members' words. */
const LINK_REFUSALS: Record<string, string> = {
  unavailable: "現在拿不到檔案,晚點再試。",
  no_login: "這裡沒有開 Discord 登入,所以只能做「有連結的人都能看」的連結。",
  not_found: "找不到這個檔案。",
  song_cover: "翻唱的成品不開放下載,只在語音和直播裡聽。",
  type_not_allowed: "這種檔案不能做成連結。",
  audience: "這個檔案不能給這麼多人看:私訊裡做的只給你,伺服器裡做的最多給那個伺服器的成員。",
  quota: "今天能做的連結已經用完了,明天再試。",
  secret: "這個檔案裡有看起來像密碼或密鑰的內容,不能做成連結。",
};

export const memberFilesRpc = {
  list: os.memberFiles.list.handler(async ({ context: { state, c } }): Promise<MemberFiles> => {
    const side = filesSide(state);
    const person = await personOf(state, c);
    const links = {
      available: side?.links != null,
      scoped: side?.links?.available("person") ?? false,
    };
    const perDay = side?.config.links_per_person_per_day ?? 0;
    if (person === null) return { links, quota: { used: 0, per_day: perDay }, items: [] };
    const store = storeOf(state);
    const items = store
      .list({ made_for: person, limit: 200 })
      .filter((a) => a.plugin !== CLEAN_PLUGIN && store.isLive(a))
      .map((a) => memberFile(store, a, person));
    const quota = side?.links?.quota(person) ?? { used: 0, per_day: perDay };
    return { links, quota, items };
  }),

  keep: os.memberFiles.keep.handler(async ({ input, context: { state, c } }) => {
    const person = await requirePerson(state, c);
    const store = storeOf(state);
    const artifact = ownItem(store, input.params.id, person);
    if (input.body.keep) {
      if (artifact.kept_by === null) store.keep(artifact.id, "person");
    } else if (artifact.kept_by === "person") {
      store.release(artifact.id);
    } else if (artifact.kept_by !== null) {
      throw ApiError.conflict("這個檔案是別的原因留著的(相簿或卡片),這裡不能取消。");
    }
    return memberFile(store, ownItem(store, artifact.id, person), person);
  }),

  remove: os.memberFiles.remove.handler(async ({ input, context: { state, c } }) => {
    const person = await requirePerson(state, c);
    const store = storeOf(state);
    const artifact = ownItem(store, input.params.id, person);
    const deleted = store.deleteFor(artifact.id, person);
    return { deleted };
  }),

  visibility: os.memberFiles.visibility.handler(async ({ input, context: { state, c } }) => {
    const person = await requirePerson(state, c);
    const store = storeOf(state);
    const artifact = ownItem(store, input.params.id, person);
    const want = input.body.visibility;
    if (isListenOnly(artifact) && want !== "none") {
      throw ApiError.conflict(LINK_REFUSALS.song_cover as string);
    }
    let url: string | null = null;
    let keep: string | null = null;
    if (want !== "none") {
      const links = filesSide(state)?.links ?? null;
      if (links === null) throw ApiError.conflict("檔案網域還沒設定,現在不能做連結。");
      const result = await links.issue({
        artifact_id: artifact.id,
        audience: want,
        person_id: want === "person" ? person : null,
        space_id: want === "space" ? artifact.space_id : null,
        ttlMs: (input.body.days ?? 7) * DAY_MS,
        requested_by: person,
        // Only its own person reaches this route: they may make their own item public.
        widen: want === "link",
      });
      if (!result.ok) {
        throw ApiError.conflict(LINK_REFUSALS[result.refused] ?? "做不出這個連結。");
      }
      url = result.url;
      keep = result.share_id;
    }
    // The old links stop: only the new one (if any) opens it now.
    for (const item of withCopies(store, artifact)) {
      for (const share of store.shares.live(item.id)) {
        if (share.id !== keep)
          store.shares.revoke(share.id, "its person changed who may open it", person);
      }
    }
    await state.auditAs(
      `person:${person}`,
      "member.files.visibility",
      artifact.id,
      { visibility: want },
      true,
    );
    return { item: memberFile(store, artifact, person), url };
  }),

  download: os.memberFiles.download.handler(async ({ input, context: { state, c } }) => {
    const person = await requirePerson(state, c);
    const store = storeOf(state);
    const artifact = ownItem(store, input.params.id, person);
    if (isListenOnly(artifact)) throw ApiError.conflict(LINK_REFUSALS.song_cover as string);
    const side = filesSide(state);
    if (side?.origin == null) throw ApiError.conflict("檔案網域還沒設定,現在不能下載。");
    const ticket = side.tickets.issue("d", artifact.id, person);
    return { url: `${side.origin}/d/${artifact.id}?k=${encodeURIComponent(ticket)}` };
  }),
};

function adminFile(store: ArtifactStore, a: Artifact): AdminFile {
  return {
    id: a.id,
    filename: a.filename,
    kind: a.kind,
    mime: a.mime,
    size: a.size,
    source: a.source,
    plugin: a.plugin,
    derived_from: a.derived_from,
    made_for: a.made_for,
    scope: a.scope,
    space_id: a.space_id,
    review: a.review,
    created_at: a.created_at,
    expires_at: a.expires_at,
    kept_by: a.kept_by,
    deleted_at: a.deleted_at,
    downloadable: a.downloadable,
    live_links: store.shares.live(a.id).length,
  };
}

export const filesAdminRpc = {
  list: os.filesAdmin.list.handler(async ({ input, context: { state } }) => {
    const store = storeOf(state);
    const q = input.query;
    const items = store
      .list({
        ...(q.person ? { made_for: q.person as PersonId } : {}),
        ...(q.source ? { source: q.source as Artifact["source"] } : {}),
        ...(q.before ? { before: q.before } : {}),
        limit: q.limit ?? 50,
        includeDeleted: q.deleted === "1",
      })
      .map((a) => adminFile(store, a));
    return { origin: state.files?.origin ?? null, items };
  }),

  history: os.filesAdmin.history.handler(async ({ input, context: { state } }) => {
    const store = storeOf(state);
    return store
      .history({
        limit: input.query.limit ?? 100,
        ...(input.query.before ? { before: input.query.before } : {}),
      })
      .map(
        ({ envelope: e }): FileHistoryEntry => ({
          id: e.id,
          at: e.at,
          type: e.type,
          person_id: e.person_id ?? null,
          turn: e.turn ?? null,
          data: (e.data ?? {}) as Record<string, unknown>,
        }),
      );
  }),

  takedown: os.filesAdmin.takedown.handler(async ({ input, context: { state, c } }) => {
    const store = storeOf(state);
    const artifact = store.get(input.params.id);
    if (artifact === null) throw ApiError.notFound("no such artifact");
    const done = store.takeDown(artifact.id, actorOf(c), input.body.reason);
    await state.audit(c, "files.takedown", artifact.id, { reason: input.body.reason }, done);
    return adminFile(store, store.get(artifact.id) ?? artifact);
  }),

  revoke: os.filesAdmin.revoke.handler(async ({ input, context: { state, c } }) => {
    const store = storeOf(state);
    const revoked = store.shares.revoke(input.params.id, input.body.reason, null);
    await state.audit(
      c,
      "files.share.revoke",
      input.params.id,
      { reason: input.body.reason },
      revoked,
    );
    return { revoked };
  }),
};

// ---- the pass ----------------------------------------------------------------------------------

/** What the pass route needs of the server's shell. */
export interface PassDeps {
  /** The logged-in session's account, or `null` (by cookie only, like every member route). */
  session(c: ApiContext): Promise<{ account: AccountRef } | null>;
}

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

const PASS_PATH = "/api/member/files/pass";

/**
 * `GET /api/member/files/pass/{token}`: the file origin sends the visitor of a link for one person
 * or a server's members here. Not logged in: to the Discord login, and back. Logged in and the
 * link is for them: back to the file origin with a ticket for this share. Otherwise a refusal; a
 * link anyone may open goes straight back.
 */
export function filesPassRoute(state: ApiState, deps: PassDeps): Route {
  return {
    method: "GET",
    path: `${PASS_PATH}/:token`,
    public: true,
    group: "public",
    handler: async (c) => {
      const side = state.files;
      if (side === null || side.origin === null) return text(404, "這裡沒有開檔案連結。");
      const store = state.optional(ArtifactStoreKey);
      if (store === undefined) return text(503, "現在拿不到檔案,晚點再試。");
      const token = c.req.param("token") ?? "";
      const found = store.shares.lookup(token);
      if (!found.ok) return text(404, "這個連結打不開:可能已經過期、被收回,或是網址不完整。");
      const back = `${side.origin}/f/${encodeURIComponent(token)}`;
      const share = found.share;
      if (share.audience === "link") return Response.redirect(back, 302);
      const session = await deps.session(c);
      if (session === null) {
        const next = `${PASS_PATH}/${encodeURIComponent(token)}`;
        return new Response(null, {
          status: 302,
          headers: {
            location: `/api/auth/oauth/login?next=${encodeURIComponent(next)}`,
            "cache-control": "no-store",
            "referrer-policy": "no-referrer",
          },
        });
      }
      const person = (await state.optional(PeopleStoreKey)?.personByAccount(session.account))?.id as
        | PersonId
        | undefined;
      const allowed =
        person !== undefined &&
        (share.audience === "person"
          ? share.person_id === person
          : share.space_id !== null && store.shares.isMember(person, share.space_id));
      if (!allowed || person === undefined) return text(403, "這個檔案不是給你的。");
      const ticket = side.tickets.issue("s", share.id, person);
      return new Response(null, {
        status: 302,
        headers: {
          location: `${back}?k=${encodeURIComponent(ticket)}`,
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    },
  };
}
