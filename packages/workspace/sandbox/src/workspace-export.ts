// `workspace.export`: one file of her workspace becomes an artifact (v5-architecture §11.2), the
// first step to handing it to someone (`share`).
//
// Only a path inside her workspace is taken (the same checks as `workspace.read`: no `..`, no
// links), and what comes out is a copy in the artifact store, made in this turn, for the person
// who asked, where the turn happens: a file made in a DM is seen in that DM only, one made in a
// channel in that channel only (the store never makes it wider). Whatever a program wrote there is
// untrusted: the store decides the type from the bytes and takes plain text, images, audio, video
// and PDF only; HTML, SVG and scripts come in as plain text and `share` refuses them again.

import { type ActionResult, type Capability, defineCapability } from "@miyoria/gate/actions";
import {
  ArtifactInputError,
  type ArtifactStore,
  ArtifactStoreKey,
  ArtifactTooLargeError,
  ArtifactTypeError,
} from "@miyoria/store";
import { escapeData } from "@miyoria/types";
import {
  WORKSPACE_EXPORT,
  type WorkspaceExportArgs,
  WorkspaceExportArgsSchema,
} from "./capabilities.js";
import { SandboxError } from "./types.js";
import type { WorkspaceApi } from "./workspace-store.js";

/** Permission node a `user` principal needs (the same as the other workspace tools). */
const NODE = "sandbox.workspace";

/** The largest file taken out of the workspace; the artifact kinds' own limits apply as well. */
const MAX_EXPORT_BYTES = 64 * 1024 * 1024;

function refused(text: string, code: string, path: string): ActionResult {
  return { text, data: { ok: false, refused: code, path } };
}

function baseName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export interface WorkspaceExportOptions {
  workspace: WorkspaceApi;
}

/** `workspace.export`, over her workspace and the app's artifact store. */
export function workspaceExportCapability(
  options: WorkspaceExportOptions,
): Capability<WorkspaceExportArgs> {
  const ws = options.workspace;
  return defineCapability<WorkspaceExportArgs>({
    name: WORKSPACE_EXPORT,
    summary: "把她工作區的一個檔案存成產物(之後才能用 share 傳給人)",
    risk: "low",
    args: WorkspaceExportArgsSchema,
    permission: NODE,
    tool: {
      name: "workspace_export",
      meta: { effect: "act", speed: "instant", group: "files" },
      description:
        "把工作區裡的一個檔案存成產物,回給你它的 id;要把檔案交給人,就用這個 id 呼叫 share。" +
        "產物是給現在開口要的人做的,只在現在這個頻道或私訊裡看得到。" +
        "只收圖片、音訊、影片、PDF 和純文字;其他東西(程式、壓縮檔、網頁)存不進去。",
      properties: { path: { type: "string", description: "工作區裡的檔案路徑,例如 report.txt" } },
      required: ["path"],
    },
    async execute(args, ctx): Promise<ActionResult> {
      const store: ArtifactStore | undefined = ctx.services.get(ArtifactStoreKey);
      if (!store) return refused("現在沒有產物庫,沒辦法匯出檔案。", "unavailable", args.path);
      const { context, requester } = ctx.principal;
      const site = context === null ? null : store.places.at(context, requester, { create: true });
      if (context !== null && site === null) {
        return refused("我認不出這個地方或這個人,所以不匯出。", "unknown_place", args.path);
      }
      let bytes: Uint8Array;
      try {
        bytes = await ws.readBytes(args.path, MAX_EXPORT_BYTES);
      } catch (error) {
        if (!(error instanceof SandboxError)) throw error;
        return refused(
          `沒辦法匯出 ${escapeData(args.path)}:${escapeData(error.message)}`,
          error.kind,
          args.path,
        );
      }
      try {
        const artifact = await store.ingest(bytes, {
          source: "sandbox",
          plugin: "sandbox",
          filename: baseName(args.path),
          place: site?.place ?? null,
          made_for: site?.person_id ?? null,
          turn: ctx.request.turn,
          signal: ctx.signal,
        });
        return {
          text:
            `已經存成產物 ${artifact.id}(${escapeData(artifact.filename)},${artifact.mime},` +
            `${artifact.size} bytes)。要給人就用 share,artifact 填這個 id。`,
          data: {
            ok: true,
            artifact_id: artifact.id,
            filename: artifact.filename,
            mime: artifact.mime,
            size: artifact.size,
            scope: artifact.scope,
          },
        };
      } catch (error) {
        if (error instanceof ArtifactTypeError) {
          return refused(
            "這個檔案的內容不是能存的類型(只收圖片、音訊、影片、PDF、純文字)。",
            "type_not_allowed",
            args.path,
          );
        }
        if (error instanceof ArtifactTooLargeError) {
          return refused("這個檔案太大了,存不進產物庫。", "too_large", args.path);
        }
        if (error instanceof ArtifactInputError) {
          return refused("在這個地方存不了產物。", "place", args.path);
        }
        throw error;
      }
    },
  }) as Capability<WorkspaceExportArgs>;
}
