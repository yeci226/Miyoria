// The completions Core lends the cluster (docs/design/v5-hostd.md §5, H8): a service of a host
// asks through its hostd (`cluster.llm`) and the `cluster` module, once it allowed the request,
// runs it here through Core's own LLM router, so the key stays in Core and the call is counted in
// the budget and written to the call log like any other, labelled with the host and service.
// The router is looked up at every call (the `llm` module may restart), so the cluster package
// needs no LLM package.

import type { ClusterComplete } from "@miyoria/cluster";
import {
  assistantMessage,
  type ChatMessage,
  type ChatRequest,
  LlmRouterKey,
  systemMessage,
  userMessage,
  withLlmTag,
} from "@miyoria/llm/llm";

/** The `module` of the call log's tag for completions a host asked for. */
export const CLUSTER_LLM_MODULE = "cluster";

export const clusterComplete: ClusterComplete = async (services, request, signal) => {
  const router = services.get(LlmRouterKey);
  if (router === undefined) throw new Error("the llm module is not running");
  const messages: ChatMessage[] = request.messages.map((m) =>
    m.role === "system"
      ? systemMessage(m.content)
      : m.role === "assistant"
        ? assistantMessage(m.content)
        : userMessage(m.content),
  );
  const chat: ChatRequest = {
    messages,
    ...(request.max_tokens === undefined ? {} : { max_tokens: request.max_tokens }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    ...(request.json === true ? { json_mode: true } : {}),
  };
  const response = await withLlmTag(
    { module: CLUSTER_LLM_MODULE, label: `${request.host}/${request.service}` },
    () => router.complete(request.purpose, chat, signal),
  );
  return response.text;
};
