// Files people send her (not images), read for the turn.
//
// Which files: those of the messages she answers (and what they forward), from people allowed
// `tools.file`, up to `files.max_files` per turn. Each goes to the `FileReader` service
// (module `sandbox`), which downloads and opens it only inside the code sandbox and hands back an
// untrusted data block, or a fixed, neutral reason why it did not. Nothing is read when there is
// no reader (sandbox off) or no authorizer; the history keeps `[附件: name]` for later turns.

import { FILE_READ } from "@miyoria/commands";
import { errorMessage } from "@miyoria/kernel";
import type { ContentPart } from "@miyoria/llm";
import {
  type Attachment,
  type Authorizer,
  accountRefString,
  type FileReader,
  type IncomingMessage,
  imageType,
  safeName,
} from "@miyoria/types";
import type { FilesConfig } from "./config.js";

/** A file chosen for a turn, before it is read. */
export interface FileCandidate {
  attachment: Attachment;
  message: IncomingMessage;
}

/**
 * The files of a turn, newest message first: not images (those are looked at), not from bots,
 * not from people without `tools.file`, a type the reader handles, each attachment once.
 */
export function selectFiles(
  inputs: readonly IncomingMessage[],
  reader: FileReader,
  authorizer: Authorizer | undefined,
  cfg: FilesConfig,
): FileCandidate[] {
  const out: FileCandidate[] = [];
  if (!cfg.enabled || authorizer === undefined) return out;
  const keys = new Set<string>();
  for (const message of [...inputs].reverse()) {
    if (message.author.is_bot || !authorizer.allows(message.author.account, FILE_READ)) continue;
    const all = [
      ...message.attachments,
      ...(message.forwarded ?? []).flatMap((f) => f.attachments),
    ];
    for (const attachment of all) {
      if (out.length >= cfg.max_files) return out;
      if (imageType(attachment) !== null || !reader.supports(attachment.filename)) continue;
      const key = attachment.id ? `id:${attachment.id}` : `url:${attachment.url.split("?")[0]}`;
      if (keys.has(key)) continue;
      keys.add(key);
      out.push({ attachment, message });
    }
  }
  return out;
}

/** The content parts of a turn's files: a label (who sent which file), then its data block. */
export async function fileParts(
  candidates: readonly FileCandidate[],
  reader: FileReader,
  signal: AbortSignal,
  onError: (name: string, error: string) => void = () => undefined,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = [];
  for (const { attachment, message } of candidates) {
    signal.throwIfAborted();
    const who = safeName(message.author.display_name);
    const name = safeName(attachment.filename, 60);
    let text: string;
    try {
      const outcome = await reader.read(
        {
          who: accountRefString(message.author.account),
          name: attachment.filename,
          url: attachment.url,
          size: attachment.size ?? null,
          id: attachment.id ?? null,
        },
        signal,
      );
      text =
        outcome.status === "read"
          ? `(${who} 傳的檔案 ${name})\n${outcome.text}`
          : `(${who} 傳了檔案 ${name},我沒有讀它:${outcome.reason})`;
    } catch (error) {
      if (signal.aborted) throw error;
      onError(name, errorMessage(error));
      text = `(${who} 傳了檔案 ${name},我沒有讀它:我現在沒辦法安全地打開檔案)`;
    }
    parts.push({ type: "text", text });
  }
  return parts;
}
