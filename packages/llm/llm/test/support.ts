// What a request looks like on the wire: the provider is run against a `fetch` that records the
// body and answers with a one-chunk stream.

import type { JsonValue } from "@miyoria/types";
import { type ChatRequest, collectResponse, OpenAiConfig, OpenAiProvider } from "../src/index.js";

const REPLY =
  'data: {"choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';

export interface Sent {
  /** The request body as it was sent. */
  json: string;
  body: Record<string, JsonValue>;
  headers: Headers;
}

/** Sends `request` through an `OpenAiProvider` of `config` and returns what left. */
export async function sendRequest(
  request: ChatRequest,
  config: OpenAiConfig = new OpenAiConfig("http://provider.invalid/v1"),
): Promise<Sent> {
  let sent: Sent | undefined;
  const fake: typeof fetch = async (_url, init) => {
    const json = String(init?.body);
    sent = { json, body: JSON.parse(json), headers: new Headers(init?.headers) };
    return new Response(REPLY, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const provider = new OpenAiProvider("test", config, { fetch: fake });
  await collectResponse(await provider.stream(request));
  if (!sent) throw new Error("no request was sent");
  return sent;
}

/** The body `request` is sent with. */
export async function wireBody(
  request: ChatRequest,
  config?: OpenAiConfig,
): Promise<Record<string, JsonValue>> {
  return (await sendRequest(request, config)).body;
}
