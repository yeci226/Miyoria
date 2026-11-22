// `share`: she hands a file she made to the person who asked for it, as an attachment of a
// message in the place of the turn (v5-architecture §11.2, v5-brain B9), and, while a file origin
// is configured (`FileLinksKey`), with a link `https://<file origin>/f/<token>` for as long as
// she says (`hours`, default 7 days). The link opens for the person who asked (`to` speaker) or,
// in a server, for its members (`to` here), never wider than where the thing was made; where the
// platform takes no attachment, the link alone goes. Without a file origin nothing here creates a
// share token, and the attachment works as before.
//
// The rules, each checked here before anything is sent:
//
// 1. Only artifacts of the store: the argument is an artifact id (a ULID), looked up as a row.
//    No argument is ever a path.
// 2. Only to the person who asked, where they asked: `to` must name the requester.
// 3. Never wider than where it was made: the place of the turn must be allowed to see the
//    artifact (`visibility.ts`: a DM-made artifact only in that DM, a room's in that room), and an
//    artifact made for one person does not go to another.
// 4. Song covers are never shared (source `sing`, `downloadable = false`).
// 5. Nothing withdrawn: deleted, expired, blocked or taken down.
// 6. A type allow-list by content, read again from the bytes: images, audio, video, PDF and plain
//    text; a zip only for the person it was made for. Text that is HTML, SVG, PHP or a script
//    with an interpreter line is refused, as are executables and anything unrecognised.
// 7. A size cap (`[modules.actions.share] max_bytes`, and what the platform takes there).
// 8. Text passes the outgoing checks first: a credential in it (a known format, or a protected
//    value such as the admin token) or any other moderation block refuses the share.
// 9. A limit per person and for everyone, per rolling 24 hours.
//
// Images go out as their cleaned copy (`ArtifactCleanerKey`, provided by the `api` module: decoded
// and encoded again, so EXIF, text chunks and anything else hidden in the file are gone). Without
// that service an image is sent as stored, and the result and the audit event say so
// (`metadata_stripped`).
//
// The platform sink resolves the id again when it sends and checks visibility for the destination
// once more (`AttachmentSource`), so a change between this check and the upload still stops it.
// What it refuses comes back here and becomes the tool's answer.
//
// A refusal is a result, not an error: `data.ok` is `false`, `data.refused` names the rule, and
// the text says why in her language. Every share that went out is one `artifact.shared` event.

import { getLogger, type ServiceLookup } from "@miyoria/runtime/kernel";
import {
  type Artifact,
  ArtifactBlobMissingError,
  ArtifactCleanerKey,
  type ArtifactSite,
  type ArtifactStore,
  ArtifactStoreKey,
  type FileLinkResult,
  FileLinksKey,
  SNIFF_BYTES,
  sniff,
  TextCheck,
} from "@miyoria/store";
import {
  type AccountRef,
  attachmentErrorOf,
  type Clock,
  type ContextKey,
  contextKeyEquals,
  Events,
  escapeData,
  type JsonValue,
  type MessageRef,
  ModerationKey,
  type ModerationService,
  MouthKey,
  maskSecrets,
  type PersonId,
  PlatformSinksKey,
  type Publish,
  sameAccount,
  systemClock,
  textLane,
} from "@miyoria/types";
import { z } from "zod";
import { handleLookup, type NameLookup, recipient } from "./builtin.js";
import { type ActionResult, type Capability, defineCapability } from "./capability.js";
import type { ShareConfig } from "./config.js";
import { RateLimiter } from "./rate.js";

const log = getLogger("actions.share");

export const SHARE = "share";

/** Why a share was refused (`data.refused`). */
export type ShareRefusalCode =
  | "unavailable"
  | "no_requester"
  | "other_person"
  | "not_found"
  | "song_cover"
  | "withdrawn"
  | "unknown_place"
  | "wider_than_origin"
  | "not_for_them"
  | "type_not_allowed"
  | "too_large"
  | "secret"
  | "moderation"
  | "limit"
  | "platform";

const ShareArgs = z.object({
  artifact: z.string().trim().min(1).max(64),
  to: z.string().nullish(),
  /** How long the link works, in hours (1 to 720); default 7 days. Only with a file origin. */
  hours: z.number().int().min(1).max(720).nullish(),
});
type ShareArgs = z.output<typeof ShareArgs>;

/** What a content check found. */
export type ContentVerdict =
  | { ok: true; mime: string }
  | { ok: false; code: "type_not_allowed"; what: string };

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const EXECUTABLES: readonly (readonly number[])[] = [
  [0x4d, 0x5a], // MZ: Windows PE
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0xfe, 0xed, 0xfa, 0xce], // Mach-O 32
  [0xfe, 0xed, 0xfa, 0xcf], // Mach-O 64
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe], // Mach-O universal, Java class
];

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return bytes.length >= prefix.length && prefix.every((b, i) => bytes[i] === b);
}

/** Markup a browser would run, at the start of a text (after a BOM, an XML header, comments). */
const ACTIVE_MARKUP =
  /^(?:<\?xml[^>]*\?>\s*|<!--[\s\S]*?-->\s*|<!doctype\s+svg[^>]*>\s*)*<(?:!doctype\s+html|html|head|body|svg)\b/i;
const SCRIPT_TAG = /<script\b/i;

/**
 * What kind of text `text` is, when it is one that must not be handed out: HTML, SVG, PHP or a
 * script with an interpreter line. `null`: plain text.
 */
export function activeText(text: string): string | null {
  const body = text.replace(/^﻿/, "").trimStart();
  if (body.startsWith("#!")) return "script";
  if (/^<\?php\b/i.test(body)) return "PHP";
  if (ACTIVE_MARKUP.test(body)) return /<svg\b/i.test(body.slice(0, 2048)) ? "SVG" : "HTML";
  if (SCRIPT_TAG.test(body)) return "HTML";
  return null;
}

/**
 * The type of `bytes` by content, against the allow-list. `owner`: the share goes to the person
 * the artifact was made for (a zip goes to nobody else).
 */
export function checkContent(bytes: Uint8Array, owner: boolean): ContentVerdict {
  const refuse = (what: string): ContentVerdict => ({ ok: false, code: "type_not_allowed", what });
  if (startsWith(bytes, ZIP)) {
    return owner ? { ok: true, mime: "application/zip" } : refuse("zip (only for its own person)");
  }
  const known = sniff(bytes.subarray(0, SNIFF_BYTES));
  if (known !== null) return { ok: true, mime: known.mime };
  const check = new TextCheck();
  check.push(bytes);
  if (!check.end()) {
    return refuse(EXECUTABLES.some((magic) => startsWith(bytes, magic)) ? "executable" : "binary");
  }
  const active = activeText(new TextDecoder("utf-8").decode(bytes));
  return active === null ? { ok: true, mime: "text/plain" } : refuse(active);
}

export interface ShareOptions {
  services: ServiceLookup;
  /** Read per call, so a config change applies at once. */
  config: () => ShareConfig;
  /** Publishes `artifact.shared`. */
  publish: Publish;
  clock?: Clock;
  /** The names she knows people by (default: the handle table). */
  names?: NameLookup | null;
}

function refused(code: ShareRefusalCode, text: string, extra: Record<string, JsonValue> = {}) {
  return { text, data: { ok: false, refused: code, ...extra } } satisfies ActionResult;
}

function personKey(account: AccountRef): string {
  return `${account.platform}:${account.id}`;
}

/** The secret or moderation rule a text trips, if any. */
function textBlock(
  moderation: ModerationService | undefined,
  text: string,
  context: ContextKey,
  turn: string | null,
): { code: "secret" | "moderation"; rule: string } | null {
  const verdict = moderation?.screen({ path: "other", visible: text, context, turn }) ?? null;
  const block = verdict?.blocked[0];
  if (block !== undefined) {
    return { code: block.category === "secrets" ? "secret" : "moderation", rule: block.rule };
  }
  // Without the moderation module the known credential formats are still caught.
  return maskSecrets(text) === text ? null : { code: "secret", rule: "secrets.known-format" };
}

/** The `share` capability over the app's artifact store (`ArtifactStoreKey`). */
export function shareCapability(options: ShareOptions): Capability<ShareArgs> {
  const { services, publish } = options;
  const clock = options.clock ?? systemClock;
  const names = options.names === undefined ? handleLookup(services) : options.names;
  const limiter = new RateLimiter();

  const send = async (
    store: ArtifactStore,
    artifact: Artifact,
    where: ContextKey,
    who: AccountRef,
    reply: MessageRef | null,
    signal: AbortSignal,
    text = "",
  ): Promise<ActionResult | MessageRef> => {
    const sink = services.get(PlatformSinksKey)?.get(where.platform);
    const platformLimit = sink?.attachmentLimit?.(where) ?? null;
    if (!sink || platformLimit === null) {
      return refused("platform", "這個地方收不了附件,所以沒辦法把檔案傳過去。");
    }
    const config = options.config();
    const cap = Math.min(config.max_bytes, platformLimit);
    if (artifact.size > cap) {
      return refused(
        "too_large",
        `這個檔案太大了(${artifact.size} bytes),這裡一次最多只能傳 ${cap} bytes。`,
        { size: artifact.size, max_bytes: cap },
      );
    }
    let bytes: Uint8Array;
    try {
      bytes = await store.readContent(artifact, signal);
    } catch (error) {
      if (!(error instanceof ArtifactBlobMissingError)) throw error;
      return refused("not_found", "這個檔案的內容已經不在了。");
    }
    const site = store.places.at(where, who);
    const owner = artifact.made_for !== null && artifact.made_for === site?.person_id;
    const content = checkContent(bytes, owner);
    if (!content.ok) {
      return refused(
        "type_not_allowed",
        `這種內容不能當附件傳出去(${content.what})。可以傳的是圖片、音訊、影片、PDF 和純文字。`,
        { what: content.what },
      );
    }
    if (content.mime !== artifact.mime) {
      return refused("type_not_allowed", "這個檔案的內容和它登記的型別不一樣,不能傳。", {
        what: "mismatch",
      });
    }
    if (content.mime === "text/plain") {
      const block = textBlock(
        services.get(ModerationKey),
        new TextDecoder("utf-8").decode(bytes),
        where,
        null,
      );
      if (block !== null) {
        return refused(
          block.code,
          block.code === "secret"
            ? "這個檔案裡有看起來像密鑰或密碼的內容,不能傳出去。先把那段拿掉再重新匯出。"
            : "這個檔案的內容沒有通過輸出檢查,不能傳出去。",
          { rule: block.rule },
        );
      }
    }
    const person = personKey(who);
    const exceeded = limiter.check(
      SHARE,
      person,
      {
        perDay: config.per_day,
        perPersonPerDay: config.per_person_per_day,
        cooldownMs: 0,
      },
      clock.now(),
    );
    if (exceeded !== null) {
      return refused("limit", "今天傳給這個人(或大家)的檔案已經到上限了,明天再傳。", {
        reason: exceeded,
      });
    }
    try {
      const sent = await sink.send(
        where,
        { text, reply_to: reply, attachments: [{ artifact_id: artifact.id }] },
        signal,
      );
      limiter.record(SHARE, person, clock.now());
      return { context: sent.context, id: sent.id };
    } catch (error) {
      const attachment = attachmentErrorOf(error);
      if (attachment === null) throw error;
      const text: Record<string, string> = {
        not_visible: "送出前再檢查了一次:這個地方不能看這個檔案,所以沒有傳。",
        not_found: "送出前再檢查了一次:這個檔案已經不在了(過期、刪除或被下架),所以沒有傳。",
        not_shareable: "這個檔案不能當附件傳出去。",
        too_large: "這個檔案對這裡來說太大了,平台不收。",
        too_many: "一則訊息放不下這麼多檔案。",
        damaged: "這個檔案的內容壞了或不見了,沒辦法傳。",
        unavailable: "這個地方現在收不了附件。",
        platform: "平台不讓我在這裡傳檔案(可能沒有附加檔案的權限)。",
      };
      const code: ShareRefusalCode =
        attachment.code === "not_visible"
          ? "wider_than_origin"
          : attachment.code === "not_found" || attachment.code === "damaged"
            ? "not_found"
            : attachment.code === "too_large"
              ? "too_large"
              : attachment.code === "not_shareable"
                ? "song_cover"
                : "platform";
      return refused(code, text[attachment.code] ?? "平台沒有收下這個檔案。", {
        at: "send",
        reason: attachment.code,
      });
    }
  };

  /** A link on the file origin, when one is configured and the audience can be opened there. */
  const issueLink = async (
    artifact: Artifact,
    here: boolean,
    site: ArtifactSite,
    turn: string | null,
    hours: number | null,
  ): Promise<Extract<FileLinkResult, { ok: true }> | null> => {
    const links = services.get(FileLinksKey);
    const audience = here ? "space" : "person";
    if (links === undefined || !links.available(audience) || site.person_id === null) return null;
    try {
      const result = await links.issue({
        artifact_id: artifact.id,
        audience,
        person_id: here ? null : site.person_id,
        space_id: here ? site.place.space_id : null,
        ...(hours === null ? {} : { ttlMs: hours * 3_600_000 }),
        requested_by: site.person_id,
        turn,
      });
      if (result.ok) return result;
      log.info({ artifact: artifact.id, refused: result.refused }, "no link for a share");
    } catch (error) {
      log.warn({ err: String(error), artifact: artifact.id }, "cannot issue a share link");
    }
    return null;
  };

  const revokeLink = (store: ArtifactStore, shareId: string, by: string | null) => {
    try {
      store.shares.revoke(shareId, "the hand-over did not go out", by as PersonId | null);
    } catch (error) {
      log.warn({ err: String(error) }, "cannot revoke an unused share link");
    }
  };

  /** The link alone, as a message, where no attachment fits; `null` without a sink. */
  const postLink = async (
    where: ContextKey,
    reply: MessageRef | null,
    url: string,
    signal: AbortSignal,
  ): Promise<MessageRef | null> => {
    const sink = services.get(PlatformSinksKey)?.get(where.platform);
    if (!sink) return null;
    const sent = await sink.send(where, { text: url, reply_to: reply, attachments: [] }, signal);
    return { context: sent.context, id: sent.id };
  };

  const linkData = (artifact: Artifact, link: Extract<FileLinkResult, { ok: true }>) => ({
    ok: true,
    artifact_id: artifact.id,
    filename: artifact.filename,
    mime: artifact.mime,
    size: artifact.size,
    message_id: null,
    metadata_stripped: link.metadata_stripped,
    url: link.url,
    link_expires_at: link.expires_at,
  });

  return defineCapability<ShareArgs>({
    name: SHARE,
    summary: "把她做出來的檔案當附件傳給開口要的人",
    risk: "low",
    args: ShareArgs,
    permission: null,
    tool: {
      name: "share",
      meta: { effect: "say", speed: "instant", group: "files" },
      description:
        "把你做出來的檔案(產物)當附件傳給開口要的那個人,就傳在現在這個頻道或私訊裡。" +
        "artifact 填產物的 id(workspace_export 或生圖回給你的那個 id,不是檔名也不是路徑)。" +
        "只能傳給現在跟你要的人:to 省略或填 speaker。私訊裡做的東西不能傳到頻道,幫別人做的不能給另一個人;" +
        "翻唱的成品不能傳;只收圖片、音訊、影片、PDF、純文字。不行的時候會告訴你原因,照原因跟對方說就好。" +
        "有檔案網域時也會附一條下載連結(結果裡的 url):to 是 speaker 時只有對方登入後打得開,在伺服器裡填 here 就是這個伺服器的成員都打得開;hours 是連結幾小時後失效(預設 7 天)。",
      properties: {
        artifact: { type: "string", description: "產物的 id" },
        to: {
          type: "string",
          description: "給誰:省略或 speaker(開口要的人);here(這個伺服器的成員,只在伺服器裡)",
        },
        hours: { type: "integer", description: "連結幾小時後失效,1 到 720;省略是 7 天" },
      },
      required: ["artifact"],
    },
    scope: (_args, principal) => principal.context?.scope ?? null,
    lane: (_args, principal) => (principal.context ? textLane(principal.context) : null),
    async execute(args, ctx): Promise<ActionResult> {
      const store = services.get(ArtifactStoreKey);
      if (!store) return refused("unavailable", "現在沒有產物庫,沒辦法傳檔案。");
      const who = ctx.principal.requester;
      const where = ctx.principal.context;
      if (who === null || where === null) {
        return refused("no_requester", "這次沒有人開口要檔案,也不知道要傳到哪裡,所以不傳。");
      }
      // One mouth: a file goes out only in a turn of the main line, like every other line.
      const mouth = services.get(MouthKey);
      if (!mouth?.owns(ctx.request.turn)) {
        return refused("unavailable", "現在不是你在說話的回合,所以不能傳檔案。");
      }
      const here = args.to?.trim().toLowerCase() === "here";
      const to = here ? who : recipient(args.to, ctx.principal, names);
      if (to === null || !sameAccount(to, who)) {
        return refused("other_person", "現在只能把檔案傳給開口要的那個人,不能傳給別人。");
      }
      const artifact = store.get(args.artifact);
      if (artifact === null) {
        return refused(
          "not_found",
          "產物庫裡沒有這個 id。要傳的東西得先存進產物庫(例如用 workspace_export),再用它回給你的 id。",
        );
      }
      if (artifact.source === "sing" || !artifact.downloadable) {
        return refused("song_cover", "翻唱的成品不開放下載,只能在語音和直播裡聽,所以不能傳。");
      }
      if (!store.isLive(artifact)) {
        return refused("withdrawn", "這個檔案已經不在了(過期、刪除或被下架),不能傳。", {
          review: artifact.review,
        });
      }
      const site = store.places.at(where, who, { create: true });
      if (site === null) {
        return refused("unknown_place", "我認不出這個地方或這個人,所以不傳。");
      }
      if (!store.visibleTo(artifact, site.viewer)) {
        return refused(
          "wider_than_origin",
          "這個檔案不是在這裡做的:私訊裡做的只能在那個私訊裡給,頻道裡做的只能在那個頻道給。",
          { scope: artifact.scope },
        );
      }
      if (artifact.made_for !== null && artifact.made_for !== site.person_id) {
        return refused("not_for_them", "這個檔案是幫另一個人做的,現在不能給別人。");
      }
      if (here && site.dm) {
        return refused("wider_than_origin", "私訊裡沒有「這個伺服器的成員」,所以只能給對方本人。");
      }
      const message = ctx.request.message ?? null;
      const reply = message !== null && contextKeyEquals(message.context, where) ? message : null;
      // An image leaves as its cleaned copy, when the cleaner is there.
      let handed: Artifact = artifact;
      let stripped = false;
      const cleaner = services.get(ArtifactCleanerKey);
      if (cleaner !== undefined) {
        try {
          ({ artifact: handed, stripped } = await cleaner.handOut(artifact, ctx.signal));
        } catch (error) {
          log.warn({ err: String(error), artifact: artifact.id }, "cannot clean an image to share");
          return refused("type_not_allowed", "這張圖沒辦法清掉藏在檔案裡的資料,所以不傳。");
        }
      }
      const link = await issueLink(artifact, here, site, ctx.request.turn, args.hours ?? null);
      let sent = await send(store, handed, where, who, reply, ctx.signal, link?.url ?? "");
      if ("text" in sent) {
        const code = (sent.data as { refused?: string }).refused;
        // Where no attachment fits, the link alone goes; any other refusal stops the link too.
        const linkOnly = link !== null && (code === "platform" || code === "too_large");
        if (!linkOnly) {
          if (link !== null) revokeLink(store, link.share_id, site.person_id);
          return sent;
        }
        const posted = await postLink(where, reply, link.url, ctx.signal);
        if (posted === null) return { text: `連結:${link.url}`, data: linkData(artifact, link) };
        sent = posted;
      }
      try {
        publish(
          Events.ArtifactShared,
          {
            artifact_id: artifact.id,
            sha256: artifact.sha256,
            size: artifact.size,
            mime: artifact.mime,
            filename: artifact.filename,
            source: artifact.source,
            requested_by: who,
            person_id: site.person_id,
            turn: ctx.request.turn,
            context: where,
            message_id: sent.id,
            metadata_stripped: stripped,
          },
          { turn: ctx.request.turn },
        );
      } catch (error) {
        log.warn({ err: String(error), artifact: artifact.id }, "cannot publish artifact.shared");
      }
      const linkText =
        link === null
          ? ""
          : ` 也附了一條連結(${link.audience === "space" ? "這個伺服器的成員" : "只有對方"}打得開):${link.url}`;
      return {
        text: `已經把 ${escapeData(artifact.filename)} 傳給對方了。${linkText}`,
        data: {
          ok: true,
          artifact_id: artifact.id,
          filename: artifact.filename,
          mime: artifact.mime,
          size: artifact.size,
          message_id: sent.id,
          metadata_stripped: stripped,
          ...(link === null ? {} : { url: link.url, link_expires_at: link.expires_at }),
        },
      };
    },
  });
}
