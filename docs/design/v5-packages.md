# V5 套件盤點:手寫的基礎設施對照現成套件

> 2026-11-14。唯讀盤點,沒有安裝或執行任何東西;每個套件的版本、維護狀況和已知問題都是當天查 npm registry、文件、原始碼和 issue 得到的。前半是結論和要 owner 決定的事;「Design detail」之後是每一項的證據(英文)。規則在 [TS-CONVENTIONS.md](../TS-CONVENTIONS.md) §1:套件做得比手寫好的地方就用套件;只有在說得出代價(原生編譯讓換機器難裝、沒人維護或還在 pre-release、我們走的路徑上有已知的 bug)而且代價比較大的時候才手寫。

## 為什麼做這份盤點

專案從 Rust 版移植時留下一條慣例:「第三方相依要明顯划算才加,優先用內建」。結果資料層是手寫 SQL、LLM client 是自己寫的 provider、路由表原本也打算手做。owner 把這條規則反過來之後,這份盤點把所有手寫的基礎設施逐項對照現成套件,給出「現在換」「那一塊重建時換」或「維持手寫(附理由)」。

## 結論

**現在就換(階段 1)**

| 項目 | 換成什麼 | 說明 |
|---|---|---|
| API 的路由層和它的 client | **oRPC 1.x**(contract-first,掛在現有的 Hono 上) | 取代原設計裡手做的 `defineRoute` 和通用 client。先做一個有四道關卡的小試驗(K8),過不了就退回手做的設計;zod schema 兩邊通用,不會白寫 |
| 語音節點讀 `.env` | Node 內建的 `process.loadEnvFile()` | 拿掉 `dotenv` 這個相依 |
| 管理 token 的失敗次數限制 | `rate-limiter-flexible` | 階段 6 拆開 admin / web、加上這個限制時採用。K8 做完後重看:公開路由現有的計數視窗只有 40 行,同步、時鐘可以注入、key 數有上限;這個套件是非同步的、靠計時器過期、不能注入時鐘,換過去沒有比較好,所以留著 |

**那一塊重建時換**

| 項目 | 換成什麼 | 什麼時候 |
|---|---|---|
| LLM 的連線層(自己的 OpenAI 相容 provider,811 行) | Vercel AI SDK 的 `@ai-sdk/deepseek`,指定自己的 `baseURL` | 階段 3 的第一步。router、預算和呼叫紀錄留著用自己的 |
| 大腦的主迴圈 | 自己寫一個很薄的迴圈,每一步呼叫 AI SDK 的 `streamText`;不用現成的 agent 框架 | 階段 3 |
| 排程(每日、每晚的反思) | `croner`,只拿來算下一次時間 | 階段 3、階段 5 |
| 研究用子代理讀網頁 | `defuddle`,或 `@mozilla/readability` 加 `linkedom` | 階段 3 |
| hostd 啟動子行程 | `execa` | 階段 2 |
| 面板和 CLI 的三個手寫 SSE parser | `eventsource-parser` | 搬 SSE 路由時(K8、K9) |
| 卡片和圖表的出圖 | 評估 `@takumi-rs/core` | 階段 5 做 `cards` 時 |
| 面板的設定編輯器 | `@rjsf/shadcn` | 做設定編輯器時 |

**維持手寫,理由**

- **模組核心和排程器**:會丟棄落後訂閱者的事件匯流排、有型別的 service 擁有權、說話的 lane,沒有套件做這幾件特定的事。
- **WebSocket 連線**:套件只能取代約 80 行的重連退避,其餘都是協定本身。階段 2 寫 hostd 的控制連線時共用一個連線輔助模組。
- **擴充協定的 JSON-RPC**:線上格式已經和 LSP 一樣;套件只能取代 framing 和編號,逾時、訊息大小上限、背壓還是要自己寫。做法是把 host 和 SDK 的兩份合成一份,並加一個對 `vscode-jsonrpc` 的相容性測試。
- **設定**:大部分的 TOML 編輯程式會在設定搬進資料庫時消失。
- **記憶搜尋**:約 1.5 萬筆向量時暴力比對夠快;`sqlite-vec` 還沒到 1.0、要原生編譯、維護得慢。jieba 留著。
- **Discord 指令**:現成的指令框架都綁死 Discord,和計畫裡平台中性的那一層相反。
- **面板的圖表**:有自己的設計系統,每張圖後面都有給輔助工具用的表格。
- **CLI 的參數解析**:所有說明文字都是繁體中文。
- **SSRF 防護、沙箱、技能、Python 的 NVML、唱歌的工作佇列**:小、剛好合用,或者是安全邏輯。

## 幾個重要的發現

1. **AI SDK 的 DeepSeek provider 已經做了我們量到的那幾件事**:工具回合會把 `reasoning_content` 帶回去、關閉思考是有型別的選項、會回報快取命中的 token 數。OpenAI Agents SDK 和 LangGraph 在這條路上都會弄丟 `reasoning_content`,兩個 bug 都還開著。(這是讀原始碼得到的,還沒有對 OpenCode 實際送過請求。)
2. **Hono 自己的方案過不了我們要的回應驗證**:`@hono/zod-openapi` 只給回應型別、不驗證;`hc` 不能給 SSE 型別;ts-rest 在 2026 年 10 月封存了。oRPC 是唯一每一項需求都符合的:契約不帶伺服器程式、回應預設會驗證並去掉多餘欄位、SSE 有型別、支援檔案和轉址、有 TanStack 的 client 和 OpenAPI 產生器,而且沒對上的請求會落回 Hono,舊路由可以照常回應。
3. **Drizzle 的 `node:sqlite` 驅動只在 1.0 的 pre-release 裡**,穩定版 0.45 沒有。採用它等於明知是 pre-release 而接受這個代價,所以版本鎖死。
4. transformers.js 需要的 `onnxruntime-node` 約 307 MB,在 Linux 上預設還會下載 CUDA;階段 3 選 embedding 模型時要算進去。

## 要 owner 決定的事

| # | 事 | 建議 |
|---|---|---|
| P1 | API 的路由層 | **2026-11-15 已決定:採用。** 用 oRPC 1.x,先做 K8 的小試驗。四道關卡:型別檢查花的時間、面板 bundle 的大小、API 測試結果一致(錯誤內容和狀態碼)、SSE 的做法。要接受的事:`contracts` 的 `api` 部分會依賴 `@orpc/contract`(「contracts 只依賴 zod」開一個例外);輸入錯誤預設回 400 而不是 422,要另外對應;停在 1.x,2.x 穩定後再升 |
| P2 | 擴充協定 | 維持手寫的 JSON-RPC,合成一份,加相容性測試。**已照此做完(K5)** |
| P3 | 資料層 | 一般的外掛資料表全面用 Drizzle(試用結果在 [v5-data.md](v5-data.md))。**2026-11-15 已決定:全面採用** |
| P4 | LLM 的連線層 | 階段 3 的第一步換成 `@ai-sdk/deepseek`,換之前先對 OpenCode 實測 |

## 沒有驗證的事

- 沒有編譯、安裝或執行任何東西;oRPC 的範例是照 1.16.2 的型別宣告和文件寫的,沒有做過型別檢查。
- oRPC:約 165 條契約時型別檢查要多久、面板 bundle 多大、掛在 Hono 上時和現有認證順序的實際行為。
- AI SDK:沒有對 OpenCode 送過請求;`reasoning_content` 來回和快取欄位是讀原始碼得到的。
- `vscode-jsonrpc` 和我們的 framing 能互通是從線上格式推論的,沒有測過。
- 安裝大小是 registry 上解開的 tarball 大小,不是完整相依樹。

## Design detail

Read-only audit of branch `v5` at `fae860d` (2026-11-14). Phases are those of
[v5-architecture.md](v5-architecture.md) §15. Method: code read in the worktree (line counts by
`wc -l`, no build, no tests run). Every package fact was read that day from the npm registry or
PyPI, and from the package's own docs, source or issue tracker; the link after a fact is where it
came from.

## Summary table

| # | Area | Hand-written today | Best candidate | Verdict | Phase | Move |
|---|---|---|---|---|---|---|
| 1 | Data access, migrations | `store` 7.3k (raw SQL 2.9k in `sqlite.ts`), runner `migrate.ts` 482 | Drizzle (trial running) | Trial decides; keep the runner | 1 | — |
| 2 | LLM client | provider + wire + SSE 811; router, budgets, call log 2.5k | `ai` 7 + `@ai-sdk/deepseek` 3 (custom `baseURL`) | Adopt the provider when that area is rebuilt; keep router, budgets, call log | 3 (first step) | M |
| 3 | Agent loop, tools, sub-agents | `brain/agent` 19.5k, `llm/tools` 134 | AI SDK `streamText` per step | Own thin loop over AI SDK steps; no agent framework | 3 | L (the rebuild itself) |
| 4 | HTTP route layer and clients | `Route` table + shell ~500, CLI client 756, view types 901, panel endpoints 428 + types 2,628 | oRPC 1.16 contract-first, mounted in Hono | **Adopt now** (K8, behind a spike with gates) | 1 | L total, M for K8 |
| 5 | Extension JSON-RPC | host `rpc.ts` 363, SDK `rpc.ts` 185 + `framing.ts` 61 | `vscode-jsonrpc` 10 | Keep hand-written, merge to one copy, add a conformance test against `vscode-jsonrpc` | 1 (K5) | S |
| 6 | WebSocket links | voice-node link 296, Core voice link 769, stage link 416 | `partysocket` 1.3 | Keep; one shared link helper when hostd's control link is written | 2 | S |
| 7 | Kernel | 1.9k (supervisor, bus, services, timers), scheduler 463 | `emittery`, `p-queue`, `croner` | Keep the kernel; adopt `croner` for wall-clock schedules | 3 (`schedule`), 5 (daily/weekly) | S |
| 8 | Config | kernel `config.ts` 212 on `smol-toml`; CLI `toml-patch.ts` 716, `settings.ts` 594 | `@decimalturn/toml-patch` 3.3 | Keep; most of the TOML editing disappears with config revisions | 1 (config step) | S |
| 9 | Memory search | jieba tokenizer 417, in-memory cosine, optional transformers.js | `sqlite-vec` 0.1.9 | Keep brute-force vectors; decide the embedder in phase 3 | 3 | — |
| 10 | Discord commands, Components V2 | `commands` 5.3k, `discord` 4.5k | Sapphire 5.5, Carbon 0.17 | Keep (platform-neutral layer is the plan) | — | — |
| 11 | Rendered images and charts | `card-face` 857 (React SVG, own CJK wrap), `og.ts` 364 | `satori` 0.63, `@takumi-rs/core` 2.20 | Keep for now; evaluate takumi when `cards` is built; chart images reuse the panel's chart components | 5 | M |
| 12 | CLI | parser in `cli.ts` 731, process code in `up.ts` 539, `system.ts` 181 | `commander` 15, `execa` 10 | Keep the parser; adopt `execa` for spawning in hostd | 2 | S |
| 13 | hostd | not written (kernel supervisor + `cli/stack/*` as seed) | none fits as a whole | Self-written (decided) on `execa`, `rotating-file-stream`, `schtasks` direct | 2 | — |
| 14 | Sandbox, web, skills | sandbox 6.5k, web 1.5k (HTML reader 404, SSRF guard 378), skills 555 | `defuddle` / `@mozilla/readability` + `linkedom` | Keep the SSRF guard and sandbox; adopt a readability extractor with the research sub-agent | 3 | S |
| 15 | Panel | charts 1,055, SSE parser 193, `http.ts` 240 | `eventsource-parser` 4, `@rjsf/shadcn` 6 | Keep charts; SSE parser goes with item 4; schema forms when the config editor is built | 1 (K8–K9), config step | S |
| 16 | Python workers | NVML via ctypes 128, engine subprocess 193, request models | `nvidia-ml-py`, `datamodel-code-generator` 0.96 | Generator already planned (K7); keep the rest | 1 (K7) | S |
| 17 | Smaller things | rate windows, backoff loops (37 files), `dotenv` in voice-node, fixed UTC offsets | `rate-limiter-flexible` 11, `process.loadEnvFile`, `Intl` | Adopt `process.loadEnvFile` now; `rate-limiter-flexible` with the HTTP shell; time zones with phase 6 | 1, 6 | S |

"Adopt now" items, in one place: item 4 (route layer, oRPC), and two small ones from item 17
(`voice-node`'s `dotenv` to `process.loadEnvFile`; `rate-limiter-flexible` for the admin token
failure limit when the shell is touched in K8).

---

## 1. Data access and migrations (`packages/store`)

**What is there.** `sqlite.ts` (2,894 lines) of raw SQL behind the store interfaces, `data.ts`
1,022, `stores.ts` 607, `records.ts` 577. The new migration runner `migrate.ts` (482 lines,
commit `7aedada`) applies plugin schemas in dependency order, one transaction per migration, records
a sha256 per migration, refuses old or foreign databases, and lints table prefixes and foreign keys.
128 source files and 97 test files import the store (v5-data.md, risks).

**Trial under way** (not repeated here): `drizzle-orm@1.0.0-rc.5` with `drizzle-orm/node-sqlite`,
`packages/store/scripts/schema-sql.ts` and `bench-identity.ts`.

**What the trial should watch for.**
- The `node-sqlite` driver exists only on the 1.0 pre-release line. The `latest` tag is
  `drizzle-orm@0.45.4` (2026-10-21) and its export map has no `./node-sqlite`; `1.0.0-rc.5` is
  tagged `rc`, and `drizzle-kit`'s `latest` is still 0.31.11
  ([registry](https://www.npmjs.com/package/drizzle-orm?activeTab=versions)). A pre-release is one of
  the costs the rule names, so the trial's write-up should state how long 1.0 has been in RC and pin
  exactly (the commit `fae860d` already locks it for the CLI bundle).
- Keep the hand-written runner. drizzle-kit's own migrator reads `.sql` files plus a journal from
  disk; the runner's TS-string migrations, checksums, plugin order and prefix lint are requirements of
  v5-data §3.1 that drizzle-kit does not have. The trial already uses drizzle-kit only to *generate*
  DDL and adds `STRICT` itself (`schema-sql.ts:2`), which is the right split.
- `node:sqlite` is synchronous; check that Drizzle's prepared statements on it keep the cost the
  bench measures, and that `.get()`/`.all()` typing matches `STRICT` column affinities.
- The esbuild-bundled CLI: check that only the `node-sqlite` entry is pulled in.

**Other candidates, briefly.** Kysely 0.29.9 (MIT, 2026-11-12,
[npm](https://www.npmjs.com/package/kysely)) is a query builder without schema ownership; it has no
`node:sqlite` dialect of its own (not verified whether a community dialect is maintained). Nothing
else beats the trial's candidate for this repo.

**Verdict.** Let the trial decide. Whatever it decides, keep `migrate.ts`.

## 2. LLM client and router (`packages/llm/llm`)

**What is there.** `openai/provider.ts` 573, `openai/wire.ts` 170, `openai/sse.ts` 68: an
OpenAI-compatible Chat Completions client with streaming, tool calls, retries, a thinking switch
merged into the body, `reasoning_effort` or a `max_tokens` cap per level, and lone-surrogate
stripping. Usage already reads `prompt_cache_hit_tokens` and `cached_tokens` (`wire.ts:120-169`).
Assistant messages never carry `reasoning_content` back (`wire.ts` comment on `requestBody`). Above
it, application logic: `router.ts` 573 (purpose chains, fallback, budget state), `cost.ts` 448,
`calls.ts` 762 (inspector ring), `call-writer.ts` 476 (JSONL), `structured.ts` 203. Dependents: every
module that calls a model through `LlmRouterKey`.

**Candidates** (all checked 2026-11-14):

| Package | Version, date, licence | `reasoning_content` in | sent back in tool rounds | arbitrary body fields | cache-hit tokens |
|---|---|---|---|---|---|
| `ai` | 7.0.173, 2026-11-13, Apache-2.0, Node ≥22, zod `^3.25.76 \|\| ^4.1.8` ([npm](https://www.npmjs.com/package/ai)) | via provider | via provider | via provider | via provider |
| `@ai-sdk/deepseek` | 3.0.87, 2026-11-13, Apache-2.0 ([npm](https://www.npmjs.com/package/@ai-sdk/deepseek)) | yes, whole and streamed ([model](https://github.com/vercel/ai/blob/main/packages/deepseek/src/chat/deepseek-chat-language-model.ts)) | yes; on V4-protocol model ids kept on every assistant turn ([converter](https://github.com/vercel/ai/blob/main/packages/deepseek/src/chat/convert-to-deepseek-chat-messages.ts)) | `thinking: {type}` and `reasoningEffort` are typed options ([options](https://github.com/vercel/ai/blob/main/packages/deepseek/src/chat/deepseek-chat-language-model-options.ts)); others only through a custom `fetch` | `prompt_cache_hit_tokens` mapped to `cacheRead`, plus `providerMetadata` hit and miss ([usage](https://github.com/vercel/ai/blob/main/packages/deepseek/src/chat/convert-to-deepseek-usage.ts)) |
| `@ai-sdk/openai-compatible` | 3.0.92, 2026-11-13, Apache-2.0 ([npm](https://www.npmjs.com/package/@ai-sdk/openai-compatible)) | yes ([model](https://github.com/vercel/ai/blob/main/packages/openai-compatible/src/chat/openai-compatible-chat-language-model.ts)) | yes, only when non-empty ([converter](https://github.com/vercel/ai/blob/main/packages/openai-compatible/src/chat/convert-to-openai-compatible-chat-messages.ts)) | unknown `providerOptions` keys are spread into the body; `transformRequestBody` hook ([provider](https://github.com/vercel/ai/blob/main/packages/openai-compatible/src/openai-compatible-provider.ts)) | only `cached_tokens`; `convertUsage` hook to map DeepSeek's ([usage](https://github.com/vercel/ai/blob/main/packages/openai-compatible/src/chat/convert-openai-compatible-chat-usage.ts)) |
| `@ai-sdk/openai` | 4.0.118, 2026-11-13 | no; reasoning parts dropped ([converter](https://github.com/vercel/ai/blob/main/packages/openai/src/chat/convert-to-openai-chat-messages.ts)) | no | no passthrough | `cached_tokens` |
| `openai` | 7.57.0, 2026-11-13, Apache-2.0, no runtime deps ([npm](https://www.npmjs.com/package/openai)) | untyped, reachable by cast | no | sent as-is with `@ts-expect-error` ([README](https://github.com/openai/openai-node)) | raw object |

Notes:
- `@ai-sdk/deepseek` takes `createDeepSeek({ baseURL, apiKey, headers, fetch })`
  ([provider](https://github.com/vercel/ai/blob/main/packages/deepseek/src/deepseek-provider.ts)).
  It picks the old or V4 protocol from the model id: only `deepseek-(chat|reasoner|v1–v3.x)` get the
  old one ([catalog](https://github.com/vercel/ai/blob/main/packages/deepseek/src/deepseek-model-catalog.ts)).
  The id in this repo's docs and tests is `deepseek-v4.1-flash`, so it gets V4 behaviour, which is
  what the measured gateway does (thinking on by default, `thinking: {type: "disabled"}` honoured).
- The OpenCode session header (`x-opencode-session`, `provider.ts`) goes through per-request
  `headers`.
- Logging for `call-writer.ts`: providers return the request body on every call, the response body
  only on non-streamed calls; streamed calls need `includeRawChunks` or rebuilding from stream
  parts, which `call-writer.ts` already does from its own stream events.
- `ai` ships several times a week; pin exact versions.
- No open issue on the `reasoning_content` round trip in the AI SDK tracker; the split-reasoning
  bug on empty `tool_calls` deltas was fixed ([#20203](https://github.com/vercel/ai/issues/20203),
  [#20546](https://github.com/vercel/ai/issues/20546)).

**Verdict: adopt when the area is rebuilt, phase 3, as its first step.** Replace `openai/*` (811
lines) with `@ai-sdk/deepseek` for the main gateway and `@ai-sdk/openai-compatible` for the other
purposes (vision, local servers). Keep `router.ts`, `cost.ts`, `calls.ts`, `call-writer.ts` and the
budget logic: they are the plan's guardrails, not transport. Not phase 1: sending
`reasoning_content` back changes token use and model behaviour, and phase 1 changes no behaviour
(v5 §17). It is the fix the plan asks for in §7.5 ("工具迴圈可能不會思考").

**Size and risk: M.** `ChatMessage`/`StreamEvent` map onto the AI SDK's message and stream-part
types; `structured.ts` can stay or move to `generateObject` later. What could break: the empty
`reasoning_content` edge case reported by a third party for openai-compatible
([PR in another project](https://github.com/anomalyco/opencode/pull/25110), not verified on the
current version), the retry and fallback semantics (`maxRetries` in the SDK versus the router's own
chain: set the SDK's to 0), and the lone-surrogate filter (`bodyJson`), which must move into a custom
`fetch` or message preprocessing.

## 3. Agent loop, tool registry, sub-agents (`packages/brain/agent`, `packages/llm/tools`)

**What is there.** `brain/agent` 19,487 lines (`turn.ts` alone 3,548): the coordinator, three loop
variants, at most 3 tool rounds. `llm/tools` 134 lines. Tool schemas are hand-written JSON Schema in
11 files (v5-contracts §1.9). Phase 3 replaces all of it with one Self loop (v5 §7.1–7.3).

**Requirements from the plan.** One owner of every decision; guardrails decide at call time and a
refusal is a tool result she sees (v5 §2 principle 2, §7.2 last line); a fixed tool list for prefix
caching; long actions return a job id and finish as inbox events; typed sub-agents with budgets;
compaction of L1; full control of the exact prompt.

**Candidates.**

| Candidate | Version, date, licence | Fit | Blocker |
|---|---|---|---|
| AI SDK loop (`streamText` + `stopWhen`, `prepareStep`, `ToolLoopAgent`) | `ai` 7.0.173 ([npm](https://www.npmjs.com/package/ai)) | `prepareStep` can replace the message list each step ([loop control](https://ai-sdk.dev/docs/agents/loop-control)); a throwing tool becomes a `tool-error` the model sees, `toModelOutput` shapes results ([tools](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)); sub-agents as tools ([subagents](https://ai-sdk.dev/docs/agents/subagents)); compaction recipe ([cookbook](https://ai-sdk.dev/cookbook/guides/agent-context-compaction)) | none on this path |
| Mastra `@mastra/core` | 1.83.0, 2026-11-14, Apache-2.0 ([npm](https://www.npmjs.com/package/@mastra/core)) | processors per step ([docs](https://mastra.ai/docs/agents/processors)) | 91 MB unpacked, ~30 deps; memory and processors inject context, against "full control of the exact prompt" |
| OpenAI Agents JS `@openai/agents` | 0.22.0, 2026-11-12, MIT ([npm](https://www.npmjs.com/package/@openai/agents)) | `callModelInputFilter`, `agent.asTool` | its Chat Completions path never reads or sends `reasoning_content`: open [#2110](https://github.com/openai/openai-agents-js/issues/2110); compaction is Responses-API only ([sessions](https://github.com/openai/openai-agents-js/blob/main/docs/src/content/docs/guides/sessions.mdx)); default tool error is a fixed string ([tool.ts](https://github.com/openai/openai-agents-js/blob/main/packages/agents-core/src/tool.ts)) |
| LangGraph JS `@langchain/langgraph` | 1.7.4, 2026-11-12, MIT ([npm](https://www.npmjs.com/package/@langchain/langgraph)) | full graph control, summarisation middleware ([docs](https://docs.langchain.com/oss/javascript/langchain/middleware/built-in)) | `@langchain/openai` reads `reasoning_content` but never sends it back: open [#10883](https://github.com/langchain-ai/langchainjs/issues/10883); `@langchain/deepseek` does not override it ([source](https://github.com/langchain-ai/langchainjs/blob/main/libs/providers/langchain-deepseek/src/chat_models.ts)) |
| VoltAgent `@voltagent/core` | 2.11.1, MIT ([npm](https://www.npmjs.com/package/@voltagent/core)) | — | pulls AI SDK v6-era providers and OpenTelemetry; not evaluated further |

**Verdict: adopt the AI SDK as the step, keep the loop hand-written (phase 3).** Write the Self loop
as our own code that calls `streamText` for one model step at a time (or uses `prepareStep` with the
message list we build), because the loop's real content is ours: inbox triage, the guardrail check
per tool call, job ids that finish as events, budgets per session, and a prompt layout fixed for
caching. Use AI SDK `tool()` definitions generated from our registry (which keeps side-effect class,
speed and risk per tool, v5 §7.3), and zod with `z.toJSONSchema` for tool parameters instead of the
11 hand-written JSON Schema files. No agent framework: two of the three are broken on exactly this
endpoint's reasoning path, and the third is too heavy and too opinionated about context.

**Size and risk: L**, but that is the phase 3 rebuild itself, not the package move. Risk: AI SDK
majors change step and message types (v6 to v7 was 2026-06-25); keep the loop's own message type and
convert at the edge so a major bump touches one file.

## 4. HTTP route layer and its clients (`packages/api`, `apps/panel`, CLI)

**What is there.**
- Server: `Route { method, path, handler, public?, member? }` (`api/src/route.ts`), 39 group arrays
  concatenated in `routes()` and mounted one by one on Hono (`server.ts:150-277`), with
  authentication by flag, 405 after authentication, a member wrapper that sets `no-store` and hides
  error text, and a JSON 404 for unknown `/api/*`. Requests are parsed by `readJson`/`readQuery`
  with 415/400/422 (`extract.ts`, 106 lines). Responses are not validated. About 166 routes.
- Copies of the response shapes: `api/src/types.ts` 901, CLI client `api/src/client.ts` 756 (with
  its own SSE parser), panel `api/types.ts` 2,628, `endpoints.ts` 428, `http.ts` 240, `sse.ts` 193.
- Two SSE routes: `/api/events` (`core.ts:192-233`) and the public live feed (`live.ts:59`). File
  and redirect responses in `og.ts`, `card.ts`, `member.ts`, `data.ts`, `meta.ts`, `panel.ts`.
- The design on the table: hand-made `defineRoute` + `handle()` + generic `call()` (v5-contracts
  §2.6, step K8). `packages/contracts` exists today with `wire`, `events`, `voice-link`,
  `stage-link`, `overlay`, `workers` and `kit`, depending only on zod; there is no `api` part yet.

**Requirements** (from the brief and v5-contracts C3): one declaration per route with zod 4 request
and response schemas; audience (admin, member, public) and permission per route; strict response
validation with stripping on public and member routes, log-only on admin; SSE routes; file and
redirect responses; typed clients for the panel (TanStack Query) and the CLI; plugin-contributed
routes later; ~165 routes migrated group by group beside the old ones.

**Candidates.**

| Candidate | Version, date, licence | Meets | Fails |
|---|---|---|---|
| Hono RPC `hc` (`hono` 4.13.18, 2026-11-11, MIT) | [npm](https://www.npmjs.com/package/hono) | typed client from `typeof app`, status codes ([docs](https://hono.dev/docs/guides/rpc)) | types come from server code, so the panel imports the server's type graph; only chained routes are typed; IDE and `tsc` slow down as routes grow ([docs](https://hono.dev/docs/guides/rpc), [#2489](https://github.com/honojs/hono/issues/2489), [#3869](https://github.com/honojs/hono/issues/3869)); SSE untyped, the proposal is an open draft ([PR #3957](https://github.com/honojs/hono/pull/3957)); runtime plugin routes untyped by design |
| `@hono/zod-validator` 0.9.1, 2026-08-31, MIT | [npm](https://www.npmjs.com/package/@hono/zod-validator) | request validation, zod 4 peer | not a contract layer |
| `@hono/zod-openapi` 1.6.3, 2026-09-04, MIT | [npm](https://www.npmjs.com/package/@hono/zod-openapi) | `createRoute`, OpenAPI document, per-route middleware ([README](https://github.com/honojs/middleware/blob/main/packages/zod-openapi/README.md)) | responses are typed, never validated: open since 2023 ([#181](https://github.com/honojs/middleware/issues/181)), `.strict()` not enforced ([#913](https://github.com/honojs/middleware/issues/913)); `createRoute` and `z` come from the package, so contracts would depend on it and on `hono`; client is still `hc` |
| `hono-openapi` 1.5.0, 2026-10-18, MIT | [npm](https://www.npmjs.com/package/hono-openapi) | OpenAPI from plain Hono routes | README says still in development ([repo](https://github.com/rhinobase/hono-openapi)); no typed client |
| **oRPC** `@orpc/contract`, `@orpc/server`, `@orpc/openapi`, `@orpc/openapi-client`, `@orpc/tanstack-query` 1.16.2, 2026-11-09, MIT | [npm](https://www.npmjs.com/package/@orpc/server) | contract package has no server code: deps `@orpc/client`, `@orpc/shared`, `openapi-types`, `@standard-schema/spec` (registry); `$meta`, `meta`, `route` on the contract builder ([d.ts](https://unpkg.com/@orpc/contract@1.16.2/dist/index.d.mts)); `Route` has `method`, `path`, `successStatus`, `inputStructure`, `outputStructure` ("detailed": params, query, headers, body in; status, headers, body out) ([d.ts](https://unpkg.com/@orpc/contract@1.16.2/dist/shared/contract.TuRtB1Ca.d.mts), [docs](https://orpc.dev/docs/openapi/input-output-structure)); middleware sees `procedure` and its meta ([d.ts](https://unpkg.com/@orpc/server@1.16.2/dist/shared/server.qKsRrdxW.d.mts)); output validation on by default and returns the parsed value, so `z.object` strips ([docs](https://orpc.dev/docs/openapi/advanced/disabling-output-validation)); typed SSE per event with resume ([docs](https://orpc.dev/docs/event-iterator)); `File`/`Blob` in and out ([docs](https://orpc.dev/docs/file-upload-download)); redirects via detailed output with 3xx and `location`; Hono mount that falls through to `next()` for unmatched requests ([docs](https://orpc.dev/docs/adapters/hono)); `customErrorResponseBodyEncoder` to keep today's error body ([d.ts](https://unpkg.com/@orpc/openapi@1.16.2/dist/shared/openapi.CdeSk3f7.d.mts)); TanStack Query utilities ([docs](https://orpc.dev/docs/integrations/tanstack-query)); OpenAPI generator | no "log only" output mode (needs a wrapper schema); client buffers binary responses, not for files over 100 MB ([#1575](https://github.com/middleapi/orpc/issues/1575)); "Body Already Used" if earlier Hono middleware reads the body ([docs](https://orpc.dev/docs/adapters/hono)); v2 is in beta (2.0.0-beta.50, 2026-11-09) and renames the meta and route APIs every declaration uses ([migration](https://orpc.dev/docs/migrations/from-v1)); orpc.dev now documents v2 |
| ts-rest 3.52.1, 2025-06-02 | [npm](https://www.npmjs.com/package/@ts-rest/core) | — | archived 2026-10-26, "no longer maintained"; zod 4 only in an RC ([repo](https://github.com/ts-rest/ts-rest)) |
| tRPC 11.28.2, 2026-11-14, MIT | [npm](https://www.npmjs.com/package/@trpc/server) | output validation strips ([docs](https://trpc.io/docs/server/validators)); SSE subscriptions ([docs](https://trpc.io/docs/server/subscriptions)) | client types come from the server router (no zod-only contract); no file outputs or redirects ([docs](https://trpc.io/docs/server/non-json-content-types)); REST paths need a third-party package |
| Zodios 10.9.6, 2023-08-22 | [npm](https://www.npmjs.com/package/@zodios/core) | — | dead |

**Verdict: adopt oRPC 1.x now, contract-first, at step K8**, behind a spike with explicit gates;
the hand-made `defineRoute` design is the fallback if a gate fails, and the zod schemas written for
K9 carry over to either. Reasons: it is the only candidate that meets every requirement natively
(server-free contracts, output validation with stripping, typed SSE, files and redirects, typed
TanStack client, OpenAPI), it is stable 1.x, MIT and released weekly, and the parts we would
hand-write (a typed client, query keys, SSE typing, an OpenAPI emitter) are exactly what it gives.

What stays ours, about 150 lines: the auth/permission/CSRF middleware reading
`procedure['~orpc'].meta`; the member wrapper's headers; an error encoder that keeps today's
`ApiError` body; an `adminOutput(schema)` wrapper that logs a mismatch and passes the raw value
(C3's log-only rule); the body-proxy workaround for the Hono mount; and one handler per plugin
prefix for plugin routes.

**v1 or v2.** Start on 1.16.2, pinned. The rule names pre-release as a cost, and v2 is still beta.
When v2 is stable, the `.meta`/`.route` change is mechanical across the contract files (an extension
restores `.route`, per the migration page).

**Gates for the K8 spike** (smallest group plus `/api/events` and one public route):
1. `tsc` time and memory of the panel and `api` with the contract router type (measure before and
   after; hc's known problem is type-instantiation cost, and oRPC has not been measured here).
2. Panel bundle growth from `@orpc/client`, `@orpc/openapi-client`, `@orpc/contract` plus zod
   (contracts risk R5).
3. Behaviour parity: the existing API test suites (auth order, CSRF, oauth, public) pass unchanged
   for migrated routes. Known differences to decide, not hide: input failures are 400 with an oRPC
   code, not 415/422 (map them in the error encoder if the panel depends on 422); a wrong method on a
   migrated path is 404, not 405, unless the Hono 405 handler is kept for those paths; path params
   are written `{id}`, not `:id`.
4. SSE: whether `/api/events` and the live feed move to oRPC event iterators (a wire change for the
   CLI's and panel's parsers) or stay plain Hono routes declared as a `sse` kind. Recommended: keep
   both as plain Hono routes until K9j, and parse with `eventsource-parser` (item 15).

**Sketch: one route declared, served and called.**

```ts
// packages/contracts/api/src/base.ts  (deps: zod, @orpc/contract)
import { oc } from "@orpc/contract";
export interface RouteMeta {
  surface: "admin" | "member" | "public";
  permission: string | null;              // e.g. "admin.channel.mode"
}
export const route = oc.$meta<RouteMeta>({ surface: "admin", permission: null });

// packages/contracts/api/src/people.ts
import { z } from "zod";
import { route } from "./base.js";
import { PersonDetailSchema, PersonQuerySchema } from "./people-schemas.js";

export const people = {
  get: route
    .meta({ surface: "admin", permission: null })
    .route({ method: "GET", path: "/api/people/{id}", inputStructure: "detailed" })
    .input(z.object({ params: z.object({ id: z.string() }), query: PersonQuerySchema }))
    .output(PersonDetailSchema),
};
export const contract = { people /* , health, auth, ... group by group */ };
```

```ts
// packages/api/src/orpc.ts  (server)
import { implement, ORPCError } from "@orpc/server";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { contract } from "@miyoria/contracts/api";

const os = implement(contract).$context<{ c: ApiContext; state: ApiState }>();

const guarded = os.use(async ({ context, procedure, next }) => {
  const { surface, permission } = procedure["~orpc"].meta;
  const { c, state } = context;
  if (surface === "member") c.set("member", await authenticateMember(state, c));
  else if (surface === "admin") {
    const principal = await authenticate(state, c);       // today's code, incl. CSRF on writes
    if (permission !== null) requirePermission(principal, permission);
  }
  return next();
});

export const router = guarded.router({
  people: {
    get: guarded.people.get.handler(async ({ input, context }) =>
      context.state.people.detail(input.params.id, input.query),   // stripped by the output schema
    ),
  },
});

const handler = new OpenAPIHandler(router, {
  customErrorResponseBodyEncoder: (error) => apiErrorBody(error),   // keeps ApiError's JSON body
});

// in createApp(), before the old routes are mounted:
app.use("/api/*", async (c, next) => {
  const { matched, response } = await handler.handle(c.req.raw, { context: { c, state } });
  if (matched) return c.newResponse(response.body, response);
  await next();                                                     // old routes still answer
});
```

```ts
// apps/panel/src/api/orpc.ts  (client; the CLI uses the same client without TanStack)
import { createORPCClient } from "@orpc/client";
import type { ContractRouterClient } from "@orpc/contract";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { contract } from "@miyoria/contracts/api";

const link = new OpenAPILink(contract, {
  url: () => connection.baseUrl,
  headers: () => connection.headers(),            // bearer or cookie + CSRF header, as http.ts today
});
export const api: ContractRouterClient<typeof contract> = createORPCClient(link);
export const q = createTanstackQueryUtils(api);

// in a page
const person = useQuery(q.people.get.queryOptions({ input: { params: { id }, query: {} } }));
```

Names `authenticate`, `authenticateMember`, `apiErrorBody`, `requirePermission` stand for today's
code in `server.ts` and `errors.ts`; the exact handler and link option names are from the 1.16.2
declarations linked above and are not compiled here.

**Size and risk.** K8 (mechanism plus the first group) M; K9 L in total, as already planned; K10
deletes `api/src/types.ts`, `client.ts`, the panel's `endpoints.ts` and `types.ts` (about 4,700
lines). What could break: the error body and status codes the panel checks (gate 3), stripping a
field a public page reads (contracts R4, unchanged by the choice of library), and type-check time
(gate 1). TS-CONVENTIONS §2 says contracts depend only on zod; the `api` part would add
`@orpc/contract`, and if `@miyoria/contracts` is published (C5) extension authors get it
transitively. That rule needs a one-line amendment, or the `api` part becomes its own package.

## 5. Extension protocol framing and RPC (`plugin-host/ext-host`, `packages/sdk`)

**What is there.** JSON-RPC 2.0 with LSP `Content-Length` framing and LSP's `$/cancelRequest`,
written twice: host `rpc.ts` 363 lines (symmetric `Peer`, concurrent incoming requests, per-request
timeout, 16 MB frame cap, notifications dropped past 8 MB queued, app error codes
`-32001..-32005`), SDK `rpc.ts` 185 + `framing.ts` 61 (zero runtime dependencies, published). The
plan adds the same protocol over WebSocket through hostd (v5 §4) in phase 2.

**Candidates.**
- `vscode-jsonrpc` 10.0.0, 2026-10-22, MIT, 0 deps, 228 kB unpacked, Node ≥14.17, CommonJS with
  `./node` and `./browser` entry points (registry: `exports`, `engines`;
  [npm](https://www.npmjs.com/package/vscode-jsonrpc)). It is the reference implementation of this
  exact wire (Content-Length framing, `$/cancelRequest`), with stream reader/writer and abstract
  reader/writer for other transports ([README](https://github.com/microsoft/vscode-languageserver-node/blob/main/jsonrpc/README.md)).
  It has no per-request timeout, and cancellation is a `CancellationToken`, not an `AbortSignal`.
- `json-rpc-2.0` 1.8.1, 2026-09-20, MIT, 0 deps, transport-agnostic, no cancellation
  ([repo](https://github.com/shogowada/json-rpc-2.0)).
- MCP SDK `@modelcontextprotocol/sdk` 1.32.2 (already a dependency): its `Protocol` class is abstract
  and tied to MCP capabilities and the initialize handshake
  ([API](https://ts.sdk.modelcontextprotocol.io/api/shared/protocol.html),
  [custom methods](https://ts.sdk.modelcontextprotocol.io/v2/advanced/custom-methods.md)). Not
  reusable for a non-MCP protocol.
- `birpc` 4.2.0, MIT: its own message format, not JSON-RPC
  ([dist](https://unpkg.com/birpc@4.2.0/dist/index.mjs)). Wrong protocol for a published SDK.

**Verdict: keep hand-written, merge to one copy, prove compatibility with `vscode-jsonrpc` in a
test.** Stated cost: `vscode-jsonrpc` would replace only the framing and id bookkeeping (about 200 of
~610 lines); the per-request timeout, the frame cap, notification backpressure, the permission error
codes, the `AbortSignal` adapters the conventions require (§4) and the WebSocket reader/writer would
still be ours, so it adds an API layer (`RequestType`, `CancellationToken`) without removing the
parts that carry risk. What to do in K5: move framing and `Peer` into one module the SDK exports and
the host imports, and add a dev-only conformance test that runs a `vscode-jsonrpc` connection
against our `Peer` over a stream pair (requests both ways, a cancel, a notification). If that test
passes, switching later is a drop-in, and any third-party extension can use the reference library.

**Size and risk: S.** What could break: subtle differences in how the two copies handle errors
today; the merge needs both test suites green.

## 6. WebSocket links

**What is there.** Voice node client `apps/voice-node/src/link.ts` 296 (reconnect with capped
exponential backoff and jitter, no retry on some close codes, reset after a healthy period, welcome
timeout, idle timeout). Core side `voice/voice/src/link/link.ts` 769 and stage
`stage/src/link/link.ts` 416 (accept, hello and version, ping every 15 s, heartbeat timeout close
4408). Messages are contracts already (`contracts/voice-link`, `stage-link`).

**Candidates.** `partysocket` 1.3.0, 2026-06-23, MIT: reconnect and backoff, takes `ws` in Node, no
heartbeat ([README](https://unpkg.com/partysocket@1.3.0/README.md)).
`reconnecting-websocket` 4.4.0 is abandoned (last release 2020-02, [repo](https://github.com/pladaria/reconnecting-websocket)).
`birpc` (above) is not needed: the links are message protocols, not calls.

**Verdict: keep.** Stated cost: the client reconnect logic is about 80 lines of the 296; the rest
(close-code policy, welcome and idle timeouts, protocol hello) is ours with or without `partysocket`,
and the Core side is a server, which no client library covers. When phase 2 writes hostd's control
link, extract one shared `link` helper (backoff, heartbeat, close codes) for the three clients
instead of a fourth copy. **S.**

## 7. Kernel (`packages/runtime`)

**What is there.** 1,866 lines: `supervisor.ts` 443 (topological start, restart with backoff 2–60 s,
give up after 5 failures in 10 min), `bus.ts` 223 (topic filters, per-subscriber buffer of 4096,
oldest dropped on lag, async iteration), `services.ts` 63 (typed keys with ownership), `async.ts` 83
(`sleep`, `interval`, `withTimeout`, `SerialQueue`, all on global timers so Vitest fakes them),
`log.ts` 183 on pino. `scheduler` 463: speech and action lanes with priorities and turn cancel. The
plan keeps the kernel (v5 §1.2).

**Candidates.** `emittery` 2.2.0 (MIT, [npm](https://www.npmjs.com/package/emittery)): no bounded
per-subscriber buffer with drop-oldest. `p-queue` 10.0.0 (MIT, priorities, no per-key concurrency,
v10 breaking changes, [README](https://unpkg.com/p-queue@10.0.0/readme.md)). `p-retry` 9.0.0.
`cockatiel` 4.0.0 (retry, circuit breaker, bulkhead, [repo](https://github.com/connor4312/cockatiel)).
`bottleneck` 2.19.5 is unmaintained (last release 2019-08, [repo](https://github.com/SGrondin/bottleneck)).
DI: `awilix` 13.0.5, `@needle-di/core` 1.2.1; `tsyringe` needs `emitDecoratorMetadata`, which
esbuild does not implement ([esbuild#3680](https://github.com/evanw/esbuild/issues/3680)).
`croner` 11.0.0, 2026-10-26, MIT, `timezone` option ([repo](https://github.com/Hexagon/croner)).

**Verdict: keep the kernel and the scheduler.** Stated cost: each candidate covers a generic version
of a piece whose specific behaviour is the point (bounded lag-dropping bus, typed service ownership
that clears on module stop, speech lanes that cancel by turn). A DI container would replace 63 lines
with a larger API. **Adopt `croner`** only as a calculator of next wall-clock times
(`new Cron(pattern, { timezone }).nextRun(from)`), never its own timers, when phase 3 adds the
`schedule` tool and nightly reflection and phase 5 adds daily and weekly events per Space. **S.**

## 8. Config

**What is there.** Kernel `config.ts` 212 (TOML via `smol-toml` 1.9.1, `${VAR}` interpolation,
`.env` via `node:util` `parseEnv`), per-module zod schemas, JSON Schema for the panel via
`z.toJSONSchema`. CLI: `toml-patch.ts` 716 (format-preserving edits re-parsed by smol-toml),
`settings.ts` 594, `validate.ts` 117. Planned: cluster config moves into the database
(`config_revisions`, v5-data §6), `host.toml` and `service.toml` are new files (phase 2).

**Candidates.** `smol-toml` stays (1.9.1, 2026-10-09, BSD-3, [npm](https://www.npmjs.com/package/smol-toml)).
`@decimalturn/toml-patch` 3.3.2, 2026-10-31, MIT, "patch, parse and stringify TOML while preserving
comments, whitespace and formatting", 5 open issues, pushed 2026-11-12 (registry;
[repo](https://github.com/DecimalTurn/toml-patch)).

**Verdict: keep.** Most of `toml-patch.ts` and `settings.ts` stop being needed when cluster config
lives in `config_revisions` and the panel edits it; delete rather than replace. For `host.toml`,
which `init` writes from scratch, `smol-toml`'s `stringify` is enough. Reconsider
`@decimalturn/toml-patch` only if the CLI keeps editing a hand-commented TOML file after phase 2 (its
behaviour on this repo's files not verified). **S.**

## 9. Memory: embeddings, vector search, full-text search

**What is there.** `tokenize.ts` 417 (OpenCC to simplified, `@node-rs/jieba` search mode, kana and
Latin runs), stored tokens in an FTS5 table; vectors stored per record and compared by cosine in
memory (`engine.ts`, `embed.ts` 179); `local-embed.ts` 243 runs transformers.js in a worker thread
when it is installed (not a dependency; v5 §7.5 says embeddings are off today). No reranker, no
chunker. 14,728 memory rows today (v5-data §1.1).

**Candidates.**
- `sqlite-vec` 0.1.9, 2026-03-31; alpha 0.1.10-alpha.4 adds ANN indexes; prebuilt win32-x64 and
  linux-x64 as optional dependencies; slow upkeep (250 open, last push 2026-05)
  ([releases](https://github.com/asg017/sqlite-vec/releases)). Loads into `node:sqlite` only when the
  database is opened with `allowExtension: true` ([Node docs](https://nodejs.org/download/release/v24.18.1/docs/api/sqlite.html)).
  Pre-1.0 and a native extension.
- FTS5 trigram tokenizer: compiled into Node's SQLite (`SQLITE_ENABLE_FTS5`,
  [sqlite.gyp](https://github.com/nodejs/node/blob/v24.x/deps/sqlite/sqlite.gyp); trigram since 3.34,
  [FTS5 docs](https://sqlite.org/fts5.html)); a 3-character CJK substring matched in a local probe on
  Node 24.2 (outside the repository; no project file touched). Queries under 3 characters do not match.
- `@huggingface/transformers` 4.3.2, 2026-10-27, Apache-2.0; hard-depends on `onnxruntime-node`
  1.30.0 and `sharp` ([npm](https://www.npmjs.com/package/@huggingface/transformers)).
  `onnxruntime-node` is about 307 MB unpacked (binaries for every platform in one package) and its
  install script downloads CUDA and TensorRT providers on linux-x64 by default
  ([install.js](https://unpkg.com/onnxruntime-node@1.31.1/script/install.js)).
- `@node-rs/jieba` 2.0.4, 2026-10-06, MIT, prebuilt for win32-x64 and linux-x64
  ([README](https://unpkg.com/@node-rs/jieba@2.0.4/README.md)).

**Verdict: keep, decide the embedder in phase 3.** Brute-force cosine over ~15k vectors is a few
milliseconds; `sqlite-vec` is pre-1.0, native and slowly maintained, which the rule names as costs.
Reconsider when one person's or one Space's searchable set passes ~100k vectors. Keep jieba
(trigram cannot segment words and fails on two-character Chinese words, which are most of them). For
the embedder, phase 3's benchmark (v5 §7.5) should include the install cost: transformers.js in Core
means 307 MB of ONNX runtime on every Core machine, while an `embed` worker (Python, already the
pattern for GPU work) or an OpenAI-compatible local server keeps Core small; this fits hostd's
`embed` capability (v5 §3).

## 10. Discord (`packages/commands`, `packages/discord`)

**What is there.** `commands` 5,314 lines: a platform-neutral command tree, component routes
`mi:<route>:<params>` with permission checks, replies as abstract cards. `discord` 4,498: rendering
to Components V2 with `discord-api-types` (`render.ts` 316), slash registration, interaction handling.

**Candidates.** `@sapphire/framework` 5.5.1, 2026-08-22, MIT; `discordx` 11.13.3, last release
2025-12-13; `@buape/carbon` 0.17.0, 2026-11-12, MIT, 0.x (registry for all three). `discord.js`
14.28.1 is already used.

**Verdict: keep.** Stated cost: the plan makes commands platform-neutral (`interaction` package,
phase 6, v5 §6 and §12), and every framework above is Discord-specific and would put Discord types
back into the domain layer. The renderer is already thin over `discord-api-types`.

## 11. Rendered images and charts

**What is there.** `card-face` 857 lines: a React component that emits SVG with hand layout and its
own em-based CJK line breaking with kinsoku rules (`index.tsx:44-48`); `og.ts` 364 renders it with
`@resvg/resvg-js` and makes the frosted background with `sharp` (resvg has no `backdrop-filter`,
`og.ts:145`). Charts as images are planned (v5 §9.5).

**Candidates.**
- `satori` 0.63.2, 2026-10-20, MPL-2.0, wasm: JSX with flexbox to SVG, real font metrics, WOFF2,
  CJK fonts on demand via `loadAdditionalAsset` ([README](https://unpkg.com/satori@0.63.2/README.md)).
  Still needs resvg for PNG.
- `@resvg/resvg-js`: last stable 2.6.2 on **2024-03-26**, `next` 2.7.0-alpha.2 (2026-01-28), 79 open
  ([repo](https://github.com/thx/resvg-js)). Slow upkeep of a native dependency already in use.
- `@takumi-rs/core` 2.20.0, 2026-11-08, MIT OR Apache-2.0: Rust renderer of JSX to PNG/WebP/SVG,
  Chromium-derived text layout, `lang` option for CJK, prebuilt win32-x64 and linux-x64, wasm
  fallback ([repo](https://github.com/kane50613/takumi)). Would replace both resvg and the hand
  layout; not a drop-in.
- Charts without a browser: `echarts` 6.1.0 `renderToSVGString` with `ssr: true`
  ([handbook](https://echarts.apache.org/handbook/en/how-to/cross-platform/server/)); `vega` 6.4;
  `@observablehq/plot` 0.6.19 with a `document` from `linkedom`; `d3-scale`/`d3-shape`.

**Verdict: keep for now; evaluate `@takumi-rs/core` when `cards` is built (phase 5).** The card
works and is the panel's own drawing; replacing the layout is a design change, not a cleanup. For
chart images, reuse the panel's chart components (`apps/panel/src/components/charts`, 1,055 lines)
through `renderToStaticMarkup` with a fixed width (they measure width with a `ResizeObserver`, which
needs a prop instead on the server) and render with the same resvg path; that keeps one chart look
for the panel and Discord, which is what `packages/ui` is for (v5 §11.1). The phase 5 evaluation
should compare takumi against satori + resvg on: CJK wrapping quality versus the current kinsoku
rules, the glass effect, and resvg's upkeep. **M** for the phase 5 move.

## 12. The CLI (`packages/cli`)

**What is there.** `cli.ts` 731 (a declarative command table with Traditional Chinese help and a
parser at `:559-690`), `@clack/prompts` 1.8 (latest 1.9.0), `up.ts` 539 (spawn services, health
probes, Ctrl+C stops what it started, `taskkill /T /F` on Windows), `stack/system.ts` 181 (runner;
`.cmd` shims go through `cmd.exe` with a hand-written quote that backslash-escapes `"` and leaves
`%` unquoted, safe today only because "arguments here are always fixed strings", `system.ts:26-44`).

**Candidates.** `commander` 15.1.0, 2026-11-09, ESM-only, Node ≥22.12
([npm](https://www.npmjs.com/package/commander)); `citty` 0.2.2 (0.x); `cac` 7.1.0; `util.parseArgs`
stable since Node 20 ([util.md](https://github.com/nodejs/node/blob/main/doc/api/util.md)), no
subcommands. `execa` 10.2.1, 2026-10-23, ESM, Node ≥22 ([repo](https://github.com/sindresorhus/execa)):
correct `cmd.exe` escaping for shims, tree kill with grace period, timeouts, `AbortSignal`.
`tree-kill` 1.2.2 is unmaintained and only force-kills on Windows
([npm](https://www.npmjs.com/package/tree-kill)).

**Verdict.** Parser: keep. Stated cost: the help is Traditional Chinese throughout, and commander's
built-in strings and layout would all be overridden; the parser is ~130 lines with tests.
Spawning: **adopt `execa` in phase 2**, when hostd starts running commands from `service.toml`
(arbitrary paths, often with spaces under a user folder), where the fixed-strings assumption stops
holding. **S.**

## 13. hostd (phase 2)

The owner decided to write it (v5 §5.7, §16 row 2). What exists to build on:
- **Spawning and stopping:** `execa` 10 (above). No maintained Node library supervises children with
  restart, backoff and health checks: `forever-monitor` is dead (2020-11), `pm2` 7.1.2 is AGPL-3.0
  and drives its own daemon ([npm](https://www.npmjs.com/package/pm2)), `node-windows` is still
  1.0.0-beta.8 from 2022 ([repo](https://github.com/coreybutler/node-windows)). process-compose
  (Go, v1.124.0, 2026-10-26, Windows builds) was considered and rejected in v5 §5.7.
- **Supervision logic:** the kernel `Supervisor` (backoff, give-up window) and `cli/stack/*`
  (roles, checks, builds, health probes) are the seed, as the plan says.
- **Logs:** `rotating-file-stream` 4.0.0, 2026-11-11, MIT, or `pino-roll` 4.0.0 (2025-10) for hostd's
  own log (registry).
- **Run at logon:** call `schtasks /create /sc onlogon` through `execFile`
  ([MS docs](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/schtasks-create));
  the npm wrappers are tiny or abandoned.
- **VRAM:** the NVML reading lives in Python today (`workers/device_memory.py`, ctypes). hostd is
  Node; options are `nvidia-smi --query-gpu=memory.used,memory.total --format=csv` per read (the CLI
  already shells out to `nvidia-smi`, `install.ts:392`), or NVML through the FFI package `koffi`
  3.3.8 (MIT, 2026-11-13, prebuilt; registry). Not verified which is fast enough for lease decisions.
- **Control link:** the same JSON-RPC as item 5 over the shared link helper of item 6.
- **Health checks:** `fetch` with `AbortSignal.timeout`, as the CLI does today.

## 14. Sandbox, web fetching and search, skills

- **Sandbox** (`workspace/sandbox`, 6,454 lines): Docker driven through CLI arguments (`args.ts`),
  an `--internal` network plus an egress proxy that resolves and pins addresses (`egress.ts`), a
  bounded semaphore with abort (`semaphore.ts`, 53). `dockerode` 5.0.1 (Apache-2.0, 2026-06-24,
  registry) would swap CLI calls for the Engine API. **Keep**: the CLI form works the same on Docker
  Desktop and Linux, and the security logic is the egress topology, not the client.
- **Web** (`workspace/web`, 1,483): SSRF guard with address pinning per redirect hop (`net.ts` 378),
  a linear HTML tokenizer and text extractor (`html.ts` 404), DuckDuckGo HTML search and Tavily.
  **Keep the SSRF guard** (security-critical, fits exactly; `request-filtering-agent` 3.2.1 exists
  but would have to match the pinning and per-hop rules, not verified). **Adopt a readability
  extractor in phase 3** with the research sub-agent: `defuddle` 0.19.6 (MIT, 2026-10-24) or
  `@mozilla/readability` 0.6.0 (Apache-2.0, last release 2025-03-03) on `linkedom` 0.18.15 (ISC,
  2026-11-01) (registry for all three). Main content extraction is where a hand tokenizer falls
  short on real pages. Keep the tokenizer as the fallback for hostile or huge pages. **S.**
- **Skills** (`workspace/skills`, 555): a store and capability list. No package fits "skills are
  data with versions and approval" (v5 §14). **Keep.**

## 15. The panel (`apps/panel`)

- **Charts** (`components/charts`, 1,055 lines): a hand-drawn design system (2 px lines, hairline
  grids, one tooltip per X with keyboard, a screen-reader table behind every chart). `recharts`
  3.10.1 and `@visx/shape` 4.0.0 exist (registry). **Keep**: the custom look and the accessibility
  table are the point; a library would be restyled back to this. Reuse for server images (item 11).
- **Tables:** already TanStack Table (`data-table.tsx` 134). Nothing to do.
- **SSE parser** (`api/sse.ts` 193): one of three SSE parsers in the repo (also
  `llm/openai/sse.ts` and the CLI client's `SseParser`). **Adopt `eventsource-parser`** 4.1.3
  (MIT, 2026-10-25, [npm](https://www.npmjs.com/package/eventsource-parser)) for the panel and CLI
  when K8/K9j touch the SSE routes; the LLM one disappears with item 2. **S.**
- **HTTP client** (`http.ts` 240, `endpoints.ts` 428): replaced by item 4.
- **Forms:** 12 hand forms; no schema-driven config form exists yet. When the config editor is built
  (the config step of phase 1 or later), **adopt `@rjsf/shadcn`** 6.11.1 (MIT, 2026-11-05) with
  `@rjsf/validator-ajv8` on the JSON Schema the kernel already emits (registry). Fit with the panel's
  shadcn components not verified. Hand forms stay as they are.

## 16. Python workers (`workers/`)

- **Request models:** K7 already plans `datamodel-code-generator` (0.96.0, 2026-11-13, MIT,
  [PyPI](https://pypi.org/project/datamodel-code-generator/)) from the checked-in JSON Schema; pydantic
  is 2.14.3 ([PyPI](https://pypi.org/project/pydantic/)). Nothing to add.
- **NVML** (`device_memory.py` 128): ctypes on one NVML call, deliberately standard-library only.
  `nvidia-ml-py` 13.615.71 (BSD, 2026-09-25, [PyPI](https://pypi.org/project/nvidia-ml-py/)) is the
  official binding. **Keep**: the binding is ~40 lines and the file's value is the "settled" reading
  logic; and the arbitration moves into hostd (item 13) anyway.
- **Engine subprocess** (`engine_process.py` 193): models in a child process so VRAM really returns.
  **Keep**; no library does this.
- **Job queue** (sing: `queue.Queue` and one worker thread): `arq` is maintenance-only and needs
  Redis ([repo](https://github.com/python-arq/arq)); `huey` 3.5.4 is thread-based. **Keep**; one
  queue in one process needs no library.

## 17. Smaller things

- **`dotenv` in the voice node** (`apps/voice-node/src/config.ts:2`, `import "dotenv/config"`): Node 24
  has `process.loadEnvFile()` and the kernel already uses `util.parseEnv`. **Adopt the built-in now**
  and drop the dependency (the rule keeps built-ins first). **S.**
- **Rate limiting:** `api/src/public.ts` `RateWindow` (per client, bounded client map, global and
  login windows); `gate/actions/src/rate.ts` (rolling 24 h windows per capability and person:
  domain logic, keep). The plan adds a failure limit on the admin token (v5 §11.1).
  `rate-limiter-flexible` 11.4.1 (ISC, 2026-11-10, `RateLimiterMemory`, consecutive-failure
  blocking; [repo](https://github.com/animir/node-rate-limiter-flexible)) fits that; `hono-rate-limiter`
  0.5.4 says it is still in development. **Adopt `rate-limiter-flexible` with the HTTP shell work
  (K8)** for the token lockout and the public windows. **S.**
- **Retries:** backoff appears in 37 files; most are state machines (supervisors, links) where a
  retry helper does not fit. For plain request retries written from now on, `p-retry` 9.0.0 or the
  AI SDK's `maxRetries` for model calls; no sweep.
- **Caches:** two bounded maps (`api/src/public.ts`, `memory/world`). `lru-cache` 11.5.3 is
  BlueOak-1.0.0 licensed (registry). Keep; the bounded maps are a few lines.
- **Time zones:** fixed `utc_offset_minutes` (`brain/arbiter/src/time.ts`, `memory/memory/src/dates.ts`).
  Per-Space time zones (phase 6) need IANA zones and DST: use the built-in `Intl.DateTimeFormat`
  (Node ships full ICU) first, `@date-fns/tz` 1.5.0 if arithmetic gets complicated. Temporal is not
  on by default in Node 24; Node 26 enables it ([release](https://nodejs.org/blog/release/v26.0.0)).
- **Ids:** `ulid` 3.0.2 already (monotonic factory, `types/src/ids.ts`). Nothing to do.
- **Logging:** pino 10.4.0 already. Nothing to do.
- **Text conversion:** `opencc-js` 1.4.2 (2026-08-22, maintained) already. Nothing to do.

---

## Decisions needed now

**D-A. The route layer (item 4), before K8 starts.** Recommendation: oRPC 1.16.2 contract-first
(`@orpc/contract` in `contracts/api`, `@orpc/server` + `@orpc/openapi` mounted in Hono,
`@orpc/openapi-client` + `@orpc/tanstack-query` in the panel, the same client in the CLI), as a K8
spike with four gates (type-check cost, panel bundle, API test parity including error bodies and
statuses, SSE plan); fall back to the hand-made `defineRoute` of v5-contracts §2.6 if a gate fails.
Consequences to accept with it: TS-CONVENTIONS §2's "contracts depend only on zod" gets an exception
for the `api` part; v5-contracts C3's log-only admin mode is a small wrapper; 400 instead of 422 for
bad input unless mapped; pin 1.x and move to 2.x once it is stable.

**D-B. Extension RPC (item 5), before K5.** Recommendation: keep the hand-written JSON-RPC, merge
the host and SDK copies into one module, and add a conformance test against `vscode-jsonrpc` as a
dev dependency. The wire (LSP framing, `$/cancelRequest`) stays as it is, so the phase 2 WebSocket
transport reuses it.

**D-C. Drizzle trial (item 1).** Not a new decision, but its write-up should state the pre-release
cost explicitly: the `node-sqlite` driver exists only in `1.0.0-rc.5`; stable `0.45.4` does not
have it. If the trial is adopted, the rule's "pre-release" cost is accepted knowingly, with an
exact pin.

**D-D. Phase 3 LLM transport (item 2), can wait for phase 3 but blocks nothing earlier.** Adopt
`@ai-sdk/deepseek` with a custom `baseURL` as phase 3's first step; that step is also the fix for
"no reasoning in tool rounds" in v5 §7.5.

## Not verified

- Nothing was compiled, installed or run against this repo; the sketches in item 4 are written from
  the 1.16.2 type declarations and docs, not type-checked.
- oRPC: type-check cost with ~165 contracts, panel bundle size, and the exact behaviour of the Hono
  mount with the existing auth middleware order. Whether orpc.dev pages describe v1 or v2 in every
  case (the site now serves v2 docs; v1 facts above were checked against the 1.16.2 `.d.mts` files).
- `hc` typing of `c.redirect`/`c.body`; whether `hono-openapi` validates responses.
- AI SDK: no request was sent to the gateway; the reasoning round trip and cache fields are read from
  source, not observed. The empty-`reasoning_content` edge case in openai-compatible is a third-party
  report. Mastra's tool-error behaviour.
- `openai` SDK stream helper accumulation of `reasoning_content` (inferred from source).
- `vscode-jsonrpc`: whether it caps message size; its 10.0 changelog. Interop with our framing is
  expected from the wire format, not tested.
- `sqlite-vec` loading on Node 24 on Windows; FTS5 trigram was probed on Node 24.2
  only, outside this repo.
- `@decimalturn/toml-patch` on this repo's TOML files; `@rjsf/shadcn` fit with the panel's
  components; `request-filtering-agent` against the pinning rules; `@nktkas/rews` (a newer reconnect
  package, not vetted).
- NVML from Node (`koffi` or `nvidia-smi`) speed for hostd's VRAM leases.
- Install sizes are unpacked tarball sizes from the registry, not full dependency trees.
- Line counts are from `wc -l` on `fae860d`; they drift as the branch moves.
