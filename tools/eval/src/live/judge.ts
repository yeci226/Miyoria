// The judge of the live suites: the same router as the subject, purpose `chat`, thinking at
// `high`, and a JSON answer checked against a zod schema (`completeJson`: one repair retry, then
// `StructuredOutputError`). A judge only ever sees a scene and what she replied.

import {
  type Completer,
  completeJson,
  StructuredOutputError,
  systemMessage,
  userMessage,
} from "@miyoria/llm/llm";
import type { z } from "zod";
import { type Reply, replyText, type Scene } from "./subject.js";

export const JUDGE_PURPOSE = "chat";
/** Room for the thinking and a short JSON answer. */
const JUDGE_MAX_TOKENS = 4000;

export type Verdict<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Judge {
  /** Asks one question; an answer that is not the JSON asked for is `ok: false`, not a throw. */
  ask<S extends z.ZodType>(system: string, user: string, schema: S): Promise<Verdict<z.output<S>>>;
}

/** A judge on `router`. Provider errors (and the budget stop) are thrown as they are. */
export function routerJudge(router: Completer): Judge {
  return {
    async ask(system, user, schema) {
      try {
        const result = await completeJson(
          router,
          JUDGE_PURPOSE,
          {
            messages: [systemMessage(system), userMessage(user)],
            reasoning: "high",
            json_mode: true,
            temperature: 0,
            max_tokens: JUDGE_MAX_TOKENS,
          },
          schema,
        );
        return { ok: true, value: result.value };
      } catch (error) {
        if (error instanceof StructuredOutputError) return { ok: false, error: error.message };
        throw error;
      }
    },
  };
}

/** What stands for a reply with no line. */
export const SILENT_TEXT = "(她沒有說話)";

/** The scene as the judge reads it: where, who said what, her state. Never who is how close. */
export function sceneText(scene: Scene): string {
  const where = scene.place === "dm" ? "私訊" : "文字頻道";
  const chat = scene.lines.map((l) => `${l.who}:${l.text}`).join("\n");
  const state = scene.state === undefined ? "" : `\n她當時的狀態:${scene.state}`;
  return `地點:${where}\n${chat}${state}`;
}

/** Her reply as the judge reads it: the lines, and the tools she used (names only). */
export function replyBlock(reply: Reply): string {
  const text = reply.silent ? SILENT_TEXT : replyText(reply);
  const tools = [...new Set(reply.calls.map((c) => c.tool))];
  return `${text}\n(這回合她用的工具:${tools.length === 0 ? "沒有" : tools.join("、")})`;
}
