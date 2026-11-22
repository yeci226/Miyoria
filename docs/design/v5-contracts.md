# V5 契約層:階段 1 的設計

> 狀態(2026-11-21):**已實作**,在階段 1 合併(PR #53,2026-11-15),之後的階段都建在它上面;套件在 `packages/contracts`。下面是 2026-11-14 寫的設計,實作時的出入以程式為準。
>
> 2026-11-14。唯讀調查寫成的設計,當時還沒有實作。前半是結論和要 owner 決定的事;「Design detail」之後是實作用的細節(英文)。上層的規劃見 [v5-architecture.md](v5-architecture.md) 的 §4、§11、§12;事件的信封和資料表見 [v5-data.md](v5-data.md)。

## 現在的樣子

每個跨行程的資料形狀都是手寫的,通常寫兩份以上:

- **匯流排事件**:TypeScript 有四份;另外 `{type, data}` 這個 JSON 形式在八個地方被讀或被寫,沒有一個讀的地方會驗證它。
- **voice link**(Core 和語音節點):兩份。
- **stage link、嘴型音量、overlay**:型別和 schema 分開寫,產生端和接收端各寫各的。
- **擴充協定**:host 的 schema、SDK 的鏡像、task 契約的抄本,三份。
- **管理 API**:伺服器的 view 型別、CLI 的 client、面板的型別,三份。面板那份有 2,628 行、221 個 interface,只有 71 個對得上 API 自己的 view 型別,其他是回應裡帶出去的領域型別。
- **Python worker**:Python 這邊是 pydantic 的請求模型,TypeScript 這邊是另外寫的 zod 或手寫檢查,文件裡的規格已經過時。

現在實際對不上的地方很少(羈絆範圍那個 bug 在階段 0 修掉了)。剩下的是:面板和 SDK 沒宣告的欄位、voice link 的幾個邊角(pong、關閉碼 4408、encoder 的列舉)、overlay 一個沒有人送的 `queue` 訊息、文件裡過時的唱歌 worker 段落。執行時沒有東西是壞的。所以這一步不是修 bug,而是讓下一次改動不會再對不上,並且讓回應也被驗證。

## 設計的結論

- **新的 `packages/contracts`**,和 `packages/types` 並排(見 C1)。一個資料夾一類契約:`wire`(基本形狀)、`events`、`voice-link`、`stage-link`、`overlay`、`ext`(擴充協定)、`workers`、`api`(路由表)。它只依賴 zod。
- **只有一套機制**:schema 用 zod 4 寫;TypeScript 型別從 schema 推出來;JSON Schema 用 zod 內建的 `z.toJSONSchema` 產生,commit 進 repo;Python worker 的 pydantic 模型再從 JSON Schema 產生,也 commit 進 repo。CI 會重新產生一次,有差異就失敗。
- **寫 schema 的規則**,用測試強制:不用 `.transform`、`z.custom`、`z.date`;正規化(裁切、夾範圍)寫在接收端 `parse` 之後;Python 會收到的東西不用 `.refine`,因為它不會出現在 JSON Schema 裡;新欄位一律 `.default()` 或 `.optional()`,舊的節點才能忽略它。
- **路由表**:一條路由只宣告一次 method、路徑、請求和回應的 schema、給誰用(admin、member、public)、需要的權限。伺服器、面板和 CLI 都從這張表出發;面板 428 行的 endpoints 和 2,628 行的型別檔最後刪掉。
- **事件**:`contracts/events` 提供信封(v5-data.md §2.2)、`defineEvent` 和型別登記表。把兩種事件形式併成一種,和資料層的 `events` 表在同一步做,因為所有讀事件的地方要一起改。
- **worker 是小的一塊**:它們的協定大多不是 JSON(multipart 的 WAV、串流 PCM、header、WebSocket 上的文字),只有大約 15 個 JSON body 需要 schema。
- **大的是管理 API**(約 165 條路由,分成約 10 組),其次是事件併一(15 種有型別的事件,加上約 70 個 topic)。

## 要 owner 決定的事

**2026-11-14:owner 全部照建議決定。**

| # | 事 | 建議 |
|---|---|---|
| C1 | `contracts` 取代 `types`,還是並排 | 並排。約 700 個檔案 import `types`,而它大部分的內容(76 個 service key、領域邏輯)不是連線契約。連線形狀搬到 `contracts`,`types` 轉出同名的型別,那些檔案就不用改 |
| C2 | Python 模型怎麼來 | 用 `datamodel-code-generator` 從 commit 進來的 JSON Schema 產生,鎖版本,CI 比對。只有約 15 個小模型 |
| C3 | 正式環境要不要驗證回應 | 測試和開發時全部嚴格驗證。正式環境:public 和 member 路由嚴格,多出來的欄位直接拿掉;admin 路由只記 log,不讓一個 schema 的疏漏把面板的頁面弄空 |
| C4 | 併一之後事件叫什麼 | 現有的事件沿用現在的 topic 名稱(`platform.message.created` 這類),擴充的權限、面板的篩選和 replay 的檔案都不用改字串。v5-data.md 裡的新名字只給 V5 新增的型別用 |
| C5 | 發佈出去的 SDK 怎麼帶契約型別 | 把 `@miyoria/contracts` 也發佈成 npm 套件,SDK 依賴它。事件併一時擴充協定升到 2,不保留 v1,因為已知的擴充都在這個 repo 裡 |

## 工作順序

每一步都要 lint、typecheck、測試、build 和 Python 的 CI 全綠;除了註明的以外不改行為。

**進度(2026-11-14)**:K1、K2、K3、K4、K6、K11 已完成。K4 只做了 Core 這邊:overlay 這個 app 和語音節點的嘴型 client 還在用自己手寫的形狀。K3 沒有對真的 Discord 語音測過,合併前要在線上那台機器實際進出一次語音頻道。K5 也已完成(協定寫成契約,兩份 JSON-RPC 合成一份放在 SDK,加了對 `vscode-jsonrpc` 的相容性測試;`@miyoria/contracts` 可以和 SDK 一起發佈)。

**K8 改用 oRPC 做完了(2026-11-15)**,取代下面原設計裡手做的 `defineRoute`;理由在 [v5-packages.md](v5-packages.md)。試驗搬了 8 條路由,四道關卡都過:

- 型別檢查:165 條路由的 client 檢查約 0.7 秒,成本隨路由數線性成長;編輯器裡重新檢查一個用到三條路由的頁面約 0.3 秒。
- 面板 bundle(用 esbuild 估):總量從 574 KiB 變 584 KiB(gzip)。面板只拿契約的型別,執行時讀產生出來的 `schema/api.routes.json`,所以 zod 不會進 bundle。
- 測試:API、面板、CLI 現有的測試全過,沒有改任何期望值。
- SSE:有清楚、有型別的做法(`eventIterator`),但要等事件信封有 schema 之後(K12)才搬。

採用的條件:認證、CSRF、405 和 body 的檢查留在 Hono 的外殼,oRPC 只管輸入輸出的驗證和 client;面板執行時不 import 契約;`@orpc/*` 停在 1.16.x;不是 JSON 的路由(圖片、OAuth 轉址、`/metrics`、面板的檔案,約 6 條)維持一般的 Hono 路由。剩下約 155 條照 K9 逐組搬。

**K9 的進度**:第一批(public、member、wallet、agency、fortune,24 條)已搬完;`/api/member/export` 是下載,維持一般的 Hono 路由。對照時以伺服器實際送出的為準:面板的型別把 12 個一定會送的欄位標成可有可無,還少了一個欄位。K4 剩下的兩處(overlay 這個 app、語音節點的嘴型 client)也改成用契約的型別了。

**K9、K10、K12 的進度(2026-11-15)**:

- **K9 做完**:約 155 條 JSON 路由都宣告在契約裡。管理 API 的事件串流(`GET /api/events`)也搬了,用 oRPC 的 `eventIterator`,送的是匯流排信封。公開直播頁的串流(`/api/public/live`)維持一般路由:它用具名的 SSE 事件、先送 `retry`、滿了回 503,oRPC 的串流做不到這幾件。下載、圖片、OAuth 轉址、`/metrics` 也維持一般路由。
- **K10 做完**:API 手寫的 view 型別檔刪了;手寫的 client 只剩錯誤型別;面板的型別檔只剩契約還沒有的東西(查詢參數、紀錄內文的幾個型別),108 個檔案改成直接從契約拿型別。面板的 `endpoints.ts` 留著,放不是 JSON 的幾條路由。
- **K12a 做完**:每個匯流排 topic 都有 payload schema,測試可以開嚴格檢查(`MIYORIA_BUS_CHECK=strict`)。
- **K12b 做完**:匯流排只有一種信封(`BusEnvelopeSchema`)。程式裡一律用事件定義發布和讀取。離開程序的四個地方都送同一個信封:管理 API 的事件串流、擴充的通知(協定第 2 版,新舊互相拒絕)、重播紀錄的每一行、事實寫入讀的欄位。
- **K12c 進行中**:刪掉舊的輔助函式、信封上的舊欄位和只測舊形式的測試。

這幾步之後,外面看得到的差別:

- 事件串流的每一筆是 `{id, at, type, v, parent, turn, session, …, source, data}`,不再是 `{id, ts, source, causation, correlation, event: {type, data}}`;每筆前面多一行 `event: message`。`miyoria tail` 每行顯示「時間、型別、data」。
- 擴充:要用 `@miyoria/sdk` 0.2.0 重新 build;自己的事件一定要放在 `ext.<擴充 id>.` 底下,隨便取的 topic 會被拒絕;處理函式拿到的是新信封。詳細在 [extension-rpc.md](../protocols/extension-rpc.md)。
- 重播紀錄:一行一個信封;舊格式的檔案讀到會報錯,不轉換。
- 沒有對真的行程驗證過的:neuro、osu、threads、minecraft 四個擴充沒有實際啟動對著 host 跑;面板的串流只用測試驗過,沒有開瀏覽器接真的 Core。

| 步 | 做什麼 | 大小 | 備註 |
|---|---|---|---|
| K1 | 套件骨架、規則測試、產生器、CI 的差異檢查 | 小 | 定下慣例 |
| K2 | 基本連線形狀搬進 `contracts`,`types` 轉出 | 小到中 | 多半是機械式搬移 |
| K3 | voice link 兩個方向寫成 schema;語音節點手寫的 parser 刪掉 | 中 | 語音節點的啟動方式和其他套件不同,弄錯會讓語音壞掉;要在本機實際進出一次語音頻道 |
| K4 | stage link、嘴型音量、overlay 改成以 schema 為準 | 小到中 | transform 搬進 parse 函式時要對過輸出 |
| K5 | 擴充協定搬進 `contracts`;SDK 的型別從它來 | 中 | 動到已發佈的 API(C5) |
| K6 | worker 的 JSON schema(TypeScript 這邊);修正 worker 協定文件 | 小 | 機械式 |
| K7 | 產生的 pydantic 模組;手寫的請求模型換掉;回應的契約測試 | 中 | 先拿唱歌 worker 的兩個模型試產生器 |
| K8 | 路由表的機制、面板和 CLI 的通用 client,拿最小的一組路由當範本 | 中 | 認證的順序和 CSRF 檢查不能變 |
| K9 | 約 10 組路由逐組搬,public 和 member 先做 | 每組小到中,合計大 | 寫 schema 是機械式;對齊每個型別的兩三份抄本要小心 |
| K10 | 刪掉 API 的 view 型別、CLI client、面板的 endpoints 和型別檔 | 小 | |
| K11 | 事件信封、`defineEvent`、登記表 | 小 | 資料層 `events` 那一步之前要有 |
| K12 | 事件的 payload schema;和資料層一起把兩種事件形式併成一種;刪掉舊的輔助函式 | 大 | 所有讀事件的地方一起改 |

- 資料層 `events` 那一步之前要做完:K1、K2、K11。
- 和資料層無關,K2 之後可以平行做:K3、K4、K5、K6 再 K7、K8 再 K9 再 K10。
- 和資料層一起做:K12。
- 「一份設定 schema」是相鄰的另一步,用 K1 的產生器和規則;外掛的設定 schema 留在外掛裡。

## 風險

- 語音節點、overlay、面板各有自己的 tsconfig 和工具版本,現在都不 import workspace 的套件;加進去對它們是新的事。
- public 和 member 路由嚴格去掉多餘的欄位,可能拿掉某個頁面在讀、但 schema 漏寫的欄位。所以先做 public 那幾組,每一頁打開看過。
- 面板的 bundle 會多出 zod 和 schema,大小還沒量,K8 時量。
- SDK 已經發佈;K5 和 K12 的形狀改動會到 repo 外面(如果外面有人在用)。K12 之後 SDK 是 0.2.0、`@miyoria/contracts` 是 0.2.0。
- 還沒驗證的事:Python 產生器沒有實際跑過;沒有跑任何 build 或測試;面板和伺服器型別的比對只比了名字,沒有比欄位的型別。

## Design detail

Read on branch `v5` at `1797979` (2026-11-14). Paths are as found at that commit; things are
also named by what they are, since later steps move files.

Marks: **[V]** verified by reading both sides (or running the stated check); **[I]** inferred.
Nothing was installed, built or started. Two read-only `node -e` probes ran against the installed
zod (§2.2).

---

## 0. Summary

- Every cross-process shape is written by hand today, usually twice. The places: the bus event
  (four TypeScript copies plus a JSON wire form in eight places), the voice link (two copies), the
  stage link (one file, but type and schema written separately), the levels and overlay feeds
  (producer and consumer by hand), the extension protocol (host schemas plus the SDK's mirror plus
  the task-contract copy), the admin API (server views, CLI client, panel types: three copies,
  about 300 types on the panel side), the public live feed (two copies), and the Python workers
  (pydantic request models on the Python side, separate zod or hand checks on the TS side, a
  prose spec in a doc that has drifted).
- Live drift is small today. Phase 0 fixed the bond-range bug the earlier review found. What
  remains is fields one side doesn't declare, edge cases in the voice link, a dead overlay message
  and a stale worker doc. Nothing is broken at runtime right now. So most steps can land with
  no behaviour change. Their job is to stop the next drift and to validate responses.
- **What makes this step big is the admin API, not the protocols.** The panel's wire types cover
  the transitive closure of the domain types that responses carry: 221 interfaces, of which only
  71 match the API's own view types and 84 match `packages/types` / `packages/store` names. Some
  wire shapes exist only as a private type inside the producer.
- **The event fold is the second big piece**, and it belongs with the data layer's `events`
  table step: 15 typed variants plus about 70 custom topics, eight wire readers, the SDK protocol
  and the replay fixtures all change together.
- **The workers are a small piece.** Most of their protocols are not JSON: multipart WAV in,
  streamed PCM out, headers, and text float frames on a WebSocket. Only about 15 JSON bodies need
  schemas.
- Proposal: a new `packages/contracts` group package beside `packages/types`. Schemas are written
  in zod 4. Types are `z.infer`'d from them. JSON Schema is emitted with zod's built-in
  `z.toJSONSchema` and checked in. Pydantic models for the workers are generated from that JSON
  Schema and checked in. One route table declares method, path, schemas, surface and permission.
  JSON Schema is the only interchange format, and every generated artifact has a CI diff check.

---

## 1. Inventory of hand-copied contracts

### 1.1 `packages/types`

| Fact | Evidence |
|---|---|
| 66 files, 10,355 lines; no zod dependency (only `ulid`) | `packages/types/package.json:24-26`; `wc -l` [V] |
| Contents: wire shapes (platform, voice, event, live, task), 76 `serviceKey` declarations in 45 files, domain logic (affect tables, `contextKeyString`, text helpers), feature types (economy, party, wish, keepsakes, game) | `grep serviceKey<` [V]; A-platform §2.1 |
| Imported by about 650 source files in 23 packages and one extension | `grep -rl "@miyoria/types"`: brain 117, memory 88, api 73, heart 70, economy 47, play 37, workspace 36, stage 31, gate 30, voice 29, ... [V] |
| Not imported by the panel, overlay, voice node or SDK | panel and overlay have no `@miyoria/types` dependency; the SDK only mentions it in comments (`packages/sdk/src/task.ts:3`) [V] |
| Ids are plain aliases, not brands (`TurnId = string`, `Timestamp = string`) | `packages/types/src/ids.ts:5-20`, `time.ts:6` [V] |

Only the wire shapes are contracts. Service keys and domain logic are in-process and should not
move into `contracts`. They go to their owning plugins over later phases. Because the ids are not
branded, a `z.infer` type can replace a hand interface without breaking assignability [V].

### 1.2 The two event forms and the `{type, data}` wire form

The typed form is `Event` in `packages/types/src/event.ts:38-111`: 15 variants plus
`{type:"custom", data:{topic, payload}}`. The topic table is at `event.ts:120-136`,
`customEvent` at `event.ts:149` and the `Envelope` at `event.ts:154-163` [V]. In source
(tests excluded) there are 69 `customEvent(` calls in 41 files, 16 `v2Event(`, 10 `v2Payload(`,
13 `type === "custom"` checks, and 70 distinct `*_TOPIC` constants [V by grep; counts
approximate]. `packages/types/src/v2-topics.ts` gives payload types for 13 of the topics.

| # | Where the wire form is produced or parsed | Copy of the shape | Drift | Who breaks if it differs |
|---|---|---|---|---|
| 1 | In-process bus (`Envelope`) | source of truth `packages/types/src/event.ts:38-163` | — | — |
| 2 | Admin SSE `GET /api/events` writes `JSON.stringify(env)` | `packages/api/src/core.ts:192-233` | — | panel event list, CLI `tail` |
| 3 | Panel SSE parser and event list | `apps/panel/src/api/types.ts:121-166` (`BusEvent`, `Envelope`); topic table copy `apps/panel/src/lib/events.ts:5-21` ("Mirrors `eventTopic()`"); per-variant rendering `lib/events.ts:66-113` | Panel `voice_playback.data` lacks `emotion`, `heard_ms`, `total_ms`, `blocked` (`types.ts:142-144` vs `event.ts:73-92`); `IncomingMessage`, `Attachment` and `VoiceUtterance` lack the optional fields added since (reply_to, stickers, embeds, forwarded, mentions_others, turn_complete, card; id/size/description; turn) [V] | Panel shows less; nothing crashes |
| 4 | CLI client `SseParser` / `EventStream` | `packages/api/src/client.ts:113-140, 628-633` (casts `JSON.parse(data) as Envelope`) | uses the real type [V] | CLI |
| 5 | Extension `event` notification sends `{...env, topic}` | `packages/plugin-host/ext-host/src/extension.ts:431-443` | — | every extension |
| 6 | SDK copy | `packages/sdk/src/types.ts:98-150` (`Event`, `Envelope` with `topic`), header "Hand-written: keep in sync" (`types.ts:1-2`) | Same missing optional fields as row 3 (`sdk/src/types.ts:37-56, 82-93` vs `types/src/platform.ts:67-77, 121-150`, `voice.ts:17-34`); `payload: unknown` vs `JsonValue` [V] | Published SDK users; extensions see fields they cannot type |
| 7 | Extension `events.publish` `{topic, payload, correlation}` becomes `customEvent` | `extension.ts:353-357, 579` | — | — |
| 8 | Task events as custom topics `taskTopic(owner, type)` | `extension.ts:537`; contract `types/src/task.ts:72-122`, SDK copy `sdk/src/task.ts` checked by a parity test `plugin-host/ext-host/test/tasks.test.ts:268-273` | in sync (tested) [V] | game adapters |
| 9 | Reserved topic prefixes include `V2_TOPIC_PREFIXES` | `types/src/v2-topics.ts:65`, `extension.ts:83-93` | — | extension publish permission |
| 10 | Replay log format `{at, source, event}` | `packages/runtime/replay-log/src/log.ts:3, 23-27, 125-141, 171` (checks only that `type` is a string and that custom has `data.topic`) | — | replay harness |
| 11 | Replay fixtures | `tools/replay/test/fixtures/*.jsonl`: 8 files, 341 lines, 48 custom events [V] | — | replay tests |
| 12 | Facts writer turns both forms into `log_events` | `packages/memory/facts/src/bus.ts:269-303` | — | DB contents |

Neither form is validated when parsed anywhere on this list. Every reader casts [V for rows 3, 4,
6, 10].

### 1.3 Voice link (Core and the voice node)

| Side | File | Form |
|---|---|---|
| Core | `packages/voice/voice/src/protocol.ts` | zod `NodeMessageSchema` (`:52-102`, what Core receives), hand TS union `CoreMessage` (`:106-139`, what Core sends), binary helpers (`:146-166`) |
| Node | `apps/voice-node/src/protocol.ts` | hand TS unions `CoreMessage` (`:30-45`), `NodeMessage` (`:260-287`), hand parser `parseCoreMessage` (`:97-201`), binary helpers (`:296-332`) |
| Spec | `docs/protocols/voice-link.md:1-116` | prose |

Differences [V unless marked]:
- Core sends `pong` in answer to a node `ping` (`voice/src/link/link.ts:595-596`). The node's
  `CoreMessage` has no `pong`, and its parser would report it as an unknown, ignorable type. The
  node never sends `ping`, so this never happens today. Core pings the node and the node answers
  (`apps/voice-node/src/link.ts:252-253`).
- Core closes with `4408` on a heartbeat timeout (`protocol.ts:16`, `link.ts:537`). The node's
  close-code list stops at 4400, 4401 and 4409 (`apps/voice-node/src/protocol.ts:22-24`).
- Core types `golive_start.encoder` as `string` (`protocol.ts:133`). The node accepts only
  `auto | nvenc | software` (`:47, 233-239`).
- The node enforces bounds that Core's types do not express: `sample_rate` 8k–192k, ids of at
  most 64 characters, `source` of at most 2048 characters, `fade_ms` clamped to 10 s
  (`:69-71, 81-90, 142-149, 203`). Core enforces nothing on what it sends.
- `hello.self_account.platform` is the literal `"discord"` on the node (`:266`) and `z.string()`
  on Core (`:34`).
- Optional strings: Core parses absent as `null` (`.nullable().default(null)`). The node omits
  them. The two are compatible.
- Dependencies: the voice node has no zod and no workspace dependency. Its `tsconfig.json` does
  not extend `tsconfig.base.json`, so it lacks the `@miyoria/source` condition, and `pnpm start`
  is plain `tsx src/main.ts` (`apps/voice-node/package.json:10-13`).

Who breaks: Discord voice and Go Live. A schema mismatch drops a frame, with a log line on Core
or an "ignorable" error on the node.

### 1.4 Stage link, lip-sync levels, overlay feed

- **Stage link** (Core and the stage node). There is one file, `packages/stage/src/protocol.ts`,
  and both sides import it. That is good. But each message is written twice: once as a TS union
  (`StageMessage :176-183`, `CoreMessage :205-278`) and once as a zod schema (`:185-202`,
  `:280-381`), with no `satisfies` tying them together [V]. Several fields are
  `.nullish().transform(...)` (`:285-289`, `:313-330`), and transforms cannot be emitted as JSON
  Schema in output mode (§2.2).
- **Levels** (voice node to the stage node's `ws://…:7883/levels`): the producer is
  `apps/voice-node/src/levels/client.ts:20-26`, which builds a string by hand. The consumer is
  `packages/stage/src/protocol.ts:427-451`. The two are in sync on `t`, `rms` and `bands` [V].
- **Overlay feed** (stage node to the OBS browser source, `GET /overlay/ws`): the producer is
  `packages/stage/src/overlay.ts:53-175`, with inline `JSON.stringify` and no type. The consumer
  is `apps/overlay/src/feed.ts:4-19` (prose) and `:101-118` (`FeedMessage`). The overlay accepts a
  `queue` message (`feed.ts:238`) that nothing produces; only `demo.ts:85` emits it [V]. Note that
  `gift` on the overlay feed is `{text}`, while `gift` on the stage link is
  `{name, item, count, label}`. These are different protocols that share a word [V].

Who breaks: the avatar, subtitles and overlay on stream. Failures are silent: the overlay ignores
what it can't parse.

### 1.5 Extension protocol and SDK

- **Host side**: `packages/plugin-host/ext-host/src/protocol.ts` has TS interfaces for what the
  host sends (`InitializeParams :12-33`, `ToolDecl :36-52`) and zod schemas for what it receives
  (`ToolDeclSchema`, `CommandSpecSchema`, `ExecutorDeclSchema`, `ContributionsSchema`,
  `InitializeResultSchema :56-126`). Method params are parsed with local schemas in
  `extension.ts:349-363`.
- **SDK** (`packages/sdk`): published to npm (`package.json` root `release:publish`). It has zero
  runtime dependencies. `src/types.ts` (342 lines) mirrors the protocol by hand, and `src/task.ts`
  copies the task contract. A parity test covers the task copy only (§1.2 row 8).
- **Drift** [V]: the SDK's `ExtensionInfo.game?` is optional while the host's is `string | null`
  (`sdk/src/types.ts:284` vs `protocol.ts:32`). The SDK has `ToolDecl.permission?` and
  `read_only?` (`sdk/src/types.ts:196-198`) where the host sends them required; the host fills defaults on receipt, so this is
  harmless. The event shapes differ as in §1.2.
- **Protocol doc**: `docs/protocols/extension-rpc.md` (368 lines) is a third description.
- **Extension config** already uses JSON Schema. `config.schema.json` files (for example
  `extensions/osu/config.schema.json`) are turned into zod by `z.fromJSONSchema`
  (`extension.ts:144-151`) [V].
- **Minecraft adapter to Fabric mod** (`extensions/minecraft/adapter/src/bridge.ts`, 64 Java
  files under `mod/src`, spec `extensions/minecraft/PROTOCOL.md`): a third-language protocol
  owned by the extension. It is not part of this step. A JSON Schema could document it later; no
  Java generation is proposed.
- **Neuro SDK** (`extensions/neuro`): an external protocol. It is out of scope until phase 7.

Who breaks: extension authors, and the in-repo extensions neuro, osu, threads, minecraft and
hello.

### 1.6 Admin, member and public API, and the panel

**How routes are declared today** [V]:
- `Route { method, path, handler, public?, member? }` is in `packages/api/src/route.ts:12-18`.
  `routes()` concatenates 39 group arrays (`server.ts:150-191`) mounted on Hono
  (`server.ts:221`). There are about 166 `method:` declarations in 40 files (grep).
- Request validation: `readJson` / `readQuery` with 415/400/422 (`packages/api/src/extract.ts`),
  called 63 times in 25 files. Member bodies are `z.strictObject`. Shared request schemas
  `AccountRefSchema`, `ContextKeySchema` and `AuthScopeSchema` sit in
  `packages/api/src/schemas.ts:7-20`. `ContextKeySchema` is another copy of the `ContextKey`
  interface.
- **Responses are not validated.** Handlers return `json(value)` (`route.ts:21-26`).
- Permissions are ad hoc in three handlers: `channels.ts:44`, `data.ts:125-130` and
  `goals-admin.ts:28`. Everything else is "admin", "member" or "public" (`route.ts:7-11`).
  Writes need `admin.panel.write` and the CSRF header, checked in the server shell.

**Copies of the response shapes**:

| Copy | Size | Notes |
|---|---|---|
| `packages/api/src/types.ts` | 901 lines, 87 interfaces; imports 39 domain types from 7 packages (`@miyoria/types` 27, `store` 6, `llm` 2, others) | "`apps/panel/src/api/*types.ts` mirror these" (`types.ts:1-2`) |
| `packages/api/src/client.ts` | 756 lines | typed client "used by the CLI" (`client.ts:1`); only `packages/cli/src/commands/remote.ts` uses it |
| `apps/panel/src/api/types.ts` | 2628 lines, 299 exports, 221 interfaces | "Keep this file in sync when the API changes" (`:1-3`) |
| `apps/panel/src/api/endpoints.ts` | 428 lines | one function per route; with `public/live` and `card.tsx` it is the only place the panel calls the API (`http.ts:151-218` generic `request<T>`) [V] |
| Public live feed `LiveEvent` | `packages/types/src/live.ts:101-110` vs `apps/panel/src/pages/public/live/feed.ts:56-64` | in sync [V] |

**Drift found by a field-name diff** [V]. The script compared field names of same-named
interfaces, so types declared with `extends` are skipped. Values were not compared.
- Panel vs `api/types.ts`: 71 common interfaces. One field is missing on the panel
  (`MemoryItem.score`). Six types differ in optionality (the panel marks fields optional "for an
  older Core").
- Panel vs `packages/types` and `packages/store`: 84 common names, 16 differ. The panel lacks
  fields that the server sends: `AgendaItem.blocked`, `VoiceChannelState.activity`,
  `ThoughtEffects.emotions`, `LedgerLimits.waiting_for_response`, `PersonCard.public_feeling`, and
  the platform fields from §1.2.
- The panel has `DirectorThoughtBody.observation / want / held` (`apps/panel/src/api/types.ts:2245-2250`),
  which the domain type lacks (`types/src/mind.ts:207-218`). The producer adds them through a
  private type (`packages/play/game/src/director.ts:334-340`). The wire shape has no public
  definition at all.
- `Goal` and `MemoryQuery` are different types that happen to share a name on the two sides.

Who breaks: the panel shows stale or missing data. Public and member responses are built field by
field and pinned by tests (`packages/api/test/public.test.ts`), not by a schema.

### 1.7 Python workers

All workers are FastAPI. Local venvs run pydantic 2.14 and FastAPI 0.162 [V: `site-packages` of
the seven `workers/.venv*` in the main checkout]. Requirements do not pin pydantic. Shared modules
at `workers/` are imported with `sys.path.insert(0, parent.parent)` (`asr/server.py:76`). CI runs
`pytest` in a Python 3.12 job against the fake worker (`.github/workflows/ci.yml` job
`workers-python`). The spec is `docs/protocols/voice-link.md:117-180`.

| Worker | Endpoints | Python models | TS client | JSON part | Drift |
|---|---|---|---|---|---|
| asr | `POST /asr` multipart WAV + form; `GET /busy`, `/health`; `POST /offload`, `/reload` (`asr/server.py:422-597`) | `OffloadRequest` (`:505`); responses are dicts | `packages/voice/speech/src/asr.ts:61-66` zod `WorkerReplySchema` (ignores `duration_ms`) | response; offload req/resp; health | none found |
| tts | `POST /tts` JSON → streamed PCM, headers `X-Sample-Rate`, `X-Tts-Queue-Ms`, `X-Tts-Reference`; `/voices`, `/busy`, `/offload`, `/reload`, `/health` (`tts/server.py:1086-1336`) | `TtsRequest` (`:1077-1083`), `OffloadRequest` with `drain_s` (`:1208-1211`) | `speech/src/tts.ts:25-80, 120` (body built from config; headers read by name) | request; offload; voices; health | fake worker has its own `TtsRequest` copy (`fake/fake_server.py:110-116`) [V] |
| turn | `POST /turn` raw PCM + `X-Sample-Rate` → JSON; `WS /vad` binary 512-sample frames → text float frames; `/health` (`turn/server.py:99-155`) | none | `packages/voice/voice/src/turn.ts:71-74` hand check; VAD client `voice/src/silero.ts` | `/turn` response; health | none found |
| sing | `/jobs` (POST, GET, DELETE `:1828`), `/jobs/{id}/exclusive`, `/songs`, `/songs/{id}`, `/songs/{id}/lyrics`, `/songs/{id}/files/{name}` (files, PCM), `/gpu/context`, `/cache`, `/cache/prune`, `/library`, `/health` (`sing/server.py:1773-1960`) | `JobRequest` (`:563-576`), `LyricsRequest`, `GpuContext`, `PruneRequest`; job and song JSON are dicts | `packages/sing/src/client.ts:13-91` zod with `.catch()` everywhere (tolerates older workers) | most of it | doc lacks `backing` in the job request (`voice-link.md:168` vs `server.py:572`), `shared` in `exclusive` (`:169` vs `sing/exclusive.py:69`), and `gpu` in the job; doc still says Demucs / Seed-VC (`:166`) [V] |
| lyrics | `POST /lyrics` multipart (`hints` JSON in a form field, optional WAV); `GET /health` → `{"ok": true}` (`lyrics/server.py:47-79`) | none | **Python only**: `sing/lyrics_remote.py:49-68` | `hints`; response | health breaks the common `{"status":"ok",...}` (`voice-link.md:179`) [V]; the CLI only checks HTTP 200, so nothing breaks |
| fake | asr + tts + turn + vad for tests | copies of the request models | — | — | duplicate models |
| imagegen | ComfyUI's own API (`packages/workspace/imagegen/src/comfy.ts:39-122` zod at the edge) | — | — | — | third party: not ours |
| embeddings | OpenAI-format `/embeddings` (`packages/memory/memory/src/embed.ts:44-64`) | — | — | — | third party |

There is also a JSON-free WebSocket protocol, MediaMTX, configured by file. It is not a contract.

Who breaks: her voice and singing. Failures are mostly a logged error plus a fallback.

### 1.8 Config

There is no root schema. Today the same `miyoria.toml` is described in five places [V for the
files, A-platform §5 for the overview]:
1. Each module's zod `configSchema` (35 `configSchema:` declarations). The kernel already emits
   JSON Schema from them for the panel (`packages/runtime/kernel/src/module.ts:57-61`, with
   `io: "input", unrepresentable: "any"`).
2. The CLI's field specs and validators (`packages/cli/src/settings.ts`, 606 lines;
   `validate.ts`; `toml-patch.ts`).
3. The CLI's `[stack]` schema (`packages/cli/src/stack/config.ts:59-118`).
4. Top-level sections parsed ad hoc (`[core]`, `[llm]`, `[speech]`, ...).
5. The lyrics service parsed `miyoria.toml` `[llm]` itself in Python (`workers/sing/lyricsllm.py:24, 71-84`). Fixed (v5-hostd H8): a worker under hostd gets its completions from Core through `cluster.llm`, and without hostd it reads only `SING_LYRICS_LLM_URL` / `_KEY` / `_MODEL` from its environment; no worker reads `miyoria.toml` any more. The line numbers above are those of the old file.

Other config worlds: the voice node's env-only loader (`apps/voice-node/src/config.ts`), worker
env defaults, `deploy/miyoria.docker.toml`, and the extension `config.schema.json` files.

How it relates to contracts: the plan's "one config schema" (v5 §5.6, data doc §6) is composed
from **plugin** schemas, and plugins own them (§3 principle 3). So cluster config schemas do not
belong in `contracts`. `contracts` supplies the one emitter (zod to JSON Schema) and the rules
(§2.2), so the composed schema's JSON Schema, the example file, the docs table and the panel form
all come from the same mechanism. Only config read by **another process** belongs in `contracts`:
`host.toml` and `service.toml` for hostd in phase 2. When the lyrics service stops reading
`miyoria.toml` (phase 2, it asks Core), the Python copy goes away.

### 1.9 Out of scope (not ours, or not a contract)

- ComfyUI, OpenAI-compatible embeddings and LLM providers: keep zod at the client edge.
- MCP: an external spec, handled by the SDK.
- The Neuro Game SDK: phase 7.
- The Minecraft bridge: owned by the extension (§1.5).
- LLM tool parameter schemas: written by hand as JSON Schema in 11 files. These belong to the
  phase 3 tool registry. If they move to zod they can use the same emitter.

---

## 2. The proposed `contracts` package

### 2.1 Layout and relation to `packages/types`

`packages/contracts` is a group package (TS-CONVENTIONS §1): one `package.json`, one folder per
part, exports `./<part>`. It **sits beside `packages/types`** (decision C1).

```
packages/contracts/
  package.json            # deps: zod only. exports ./wire ./events ./voice-link ./stage-link ./overlay ./ext ./workers ./api
  wire/src/               # ids, Timestamp, JsonValue, AccountRef, ContextKey, MessageRef, Author, Attachment,
                          # IncomingMessage (+ parts), VoiceParticipant, VoiceUtterance, PlaybackState, ModuleStateKind
  events/src/             # envelope (v5-data §2.2), defineEvent(), the registry, payload schemas by owner (§2.8)
  voice-link/src/         # NodeMessage, CoreMessage, close codes, frame tags, VERSION
  stage-link/src/         # StageMessage, CoreMessage, LevelFrame, limits
  overlay/src/            # OverlayMessage (the overlay feed)
  ext/src/                # extension JSON-RPC: initialize, contributions, tools, commands, tasks, event notification
  workers/src/            # JSON bodies of asr, tts, turn, sing, lyrics; WorkerHealth
  api/src/                # defineRoute(), the route table, request and response schemas per group
  scripts/gen.ts          # emits JSON Schema (and runs the Python generator when present)
  schema/<part>/*.json    # generated, checked in
  */test/                 # round-trip and conversion tests
```

- `packages/types` keeps service keys and domain logic. For each wire shape that moves, `types`
  deletes its interface and adds `export type { X } from "@miyoria/contracts/wire"`, so the
  roughly 650 importers don't change. `types` depends on `contracts`, and `contracts` depends on
  nothing in the repo.
- Binary framing helpers (`encodeAudio`, `decodeBinaryFrame`) and the frame tag constants move
  with their link as plain TS. They are not schemas.
- Plugin event payloads: see §2.8.

### 2.2 How schemas are written (zod 4, verified)

The installed version is `zod@4.6.7`, the only zod in `node_modules/.pnpm` [V]. The repo already
uses `z.toJSONSchema` (kernel `module.ts:57`) and `z.fromJSONSchema` (ext-host `extension.ts:147`,
`workspace/sandbox/src/proposed.ts:103`).

Checked in `node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/to-json-schema.d.ts`,
in `json-schema-processors.js`, and with two `node -e` probes:
- `z.toJSONSchema(schema | registry, params)` (`json-schema-processors.d.ts:59-64`). Params:
  `target` (`draft-2020-12` default, `draft-07`, `draft-04`, `openapi-3.0`), `io`
  (`input` | `output`), `unrepresentable` (`throw` | `any` | a handler), `override`, `cycles`,
  `reused`, `metadata`. The registry form takes a `uri` and returns `{ schemas: {id: ...} }` [V].
- `.meta({ id, description })` puts a schema in `$defs` under that id [V probe]. `z.json()`
  becomes a recursive `$defs.__schema0` unless it gets its own id [V probe].
- `z.discriminatedUnion` becomes `oneOf`. A plain `z.union` becomes `anyOf` [V probe].
- **`io: "output"` writes `additionalProperties: false` on every `z.object`. `io: "input"` writes
  none, and treats fields with `.default()` as not required** [V probe]. Wire schemas for
  receivers must be emitted in **input** mode. Otherwise generated pydantic models would reject
  newer fields, which breaks the "older node ignores it" compatibility the links rely on.
- **Transforms throw in output mode** ("Transforms cannot be represented"). In input mode a pipe
  emits its input side. Dynamic `.catch` throws, while a static `.catch(v)` becomes
  `default: v`. `z.custom`, `z.date`, bigint, Map, Set, symbol and undefined literals are
  unrepresentable (`json-schema-processors.js:187-346, 715-737`) [V].
- `.refine` is **silently dropped** from JSON Schema [V probe]. A rule only zod enforces is
  invisible to Python.
- Parsing a `z.object` strips unknown keys [V probe]. This is what makes response validation
  enforce "field by field" on public routes.
- `z.coerce.number()` emits as a number in input mode [V probe]. It is fine for query strings.
- Also present but not needed now: `zod/compile` (an AOT fast path, `compile.d.ts`) and Standard
  JSON Schema (`standard-schema.d.ts`).

Rules for schemas in `contracts`, enforced by a test that converts every exported schema in both
io modes with `unrepresentable: "throw"`:
1. No `.transform`, `z.custom`, `z.date`, dynamic `.catch`, `z.bigint`. Normalisation (trim,
   clamp, `null` to `undefined`) is the receiver's code after `parse`.
2. No `.refine` on anything a Python worker receives. Use JSON-Schema-expressible checks
   (`min`, `max`, `regex`, `int`, `enum`).
3. Every exported schema has `.meta({ id: "<Part><Name>" })`, which becomes the `$defs` name and
   the Python class name.
4. New fields are added with `.default(...)` or `.optional()`. This is the compatibility rule the
   links already follow by hand (comments at `stage/src/protocol.ts:285-286`).
5. Follow TS-CONVENTIONS §2 for wire shapes: snake_case, and `T | null` when the key is always
   present. Keep `?:` (optional, omitted) where a protocol already omits keys, as the voice link's
   Core messages do (`protocol.ts:105`). The schema states which.

### 2.3 TypeScript types

For each `FooSchema`, export `type Foo = z.output<typeof FooSchema>`. Where defaults make the
sides differ, also export `type FooIn = z.input<typeof FooSchema>`. Senders type what they send
as `FooIn`, and receivers get `Foo` from `parse`. There is no generated `.d.ts` and no second type
generator: one mechanism.

### 2.4 JSON Schema output and the drift check

- `pnpm contracts:gen` (in `packages/contracts`) emits one registry per part with
  `target: "draft-2020-12"`, `io: "input"`, into `packages/contracts/schema/<part>/*.json`, with
  stable key order. The output is checked in.
- CI, node job: `pnpm --filter @miyoria/contracts contracts:check` regenerates into a temp dir and
  fails on any difference. A changed schema without regenerated JSON fails the build.
- The checked-in JSON is what Python, docs and any outside reader use. `docs/protocols/*.md` keep
  their prose and link to the JSON. The message tables in those docs can be generated later.

### 2.5 Python models for the workers

- **Generator**: `datamodel-code-generator` (decision C2), pinned. It runs on
  `schema/workers/*.json` with pydantic v2 output into one checked-in module,
  `workers/contracts.py`, which starts with a "generated; do not edit" header. Workers import it
  the same way they import `device_memory` and `engine_process` (`asr/server.py:76-79`).
  - The generator is not installed in any local venv, and neither is `jsonschema` [V]. Its exact
    flags and its output for `oneOf` and `default: null` are not verified here [I].
- **CI**: the `workers-python` job installs the pinned generator next to `fake/requirements.txt`,
  regenerates, and runs `git diff --exit-code workers/contracts.py`. Then `pytest` runs:
  - request models in `tts`, `asr`, `sing` and `fake` are the generated ones (the hand copies
    are deleted);
  - a new contract test validates every JSON response the fake worker and the unit-tested
    handlers return against the generated response models.
- **Responses**: handlers keep building dicts in this step. Returning models through FastAPI's
  `response_model` would turn absent keys into `null` (for example ASR `language`, `emotion`),
  which is a wire change [I]. If a handler adopts the models later, it returns
  `model.model_dump(exclude_unset=True)`.
- Not generated: multipart forms, raw PCM bodies, headers and the `/vad` text frames. Header names
  and the frame format become constants in `contracts/workers` and prose in the doc.

### 2.6 The route table

One entry per route, in `contracts/api`:

```ts
export const getPerson = defineRoute({
  id: "people.get",
  method: "GET",
  path: "/api/people/:id",
  surface: "admin",                    // "admin" | "member" | "public"   (later: "host")
  permission: null,                    // or a node, e.g. "admin.channel.mode" (today channels.ts:30)
  params: z.object({ id: z.string() }),
  query: PersonQuerySchema,            // or null
  body: null,                          // or a schema (JSON body), parsed with the existing 415/400/422 rules
  response: PersonDetailSchema,        // or { kind: "empty" } | { kind: "sse", event: Schema } | { kind: "file" } | { kind: "redirect" }
});
```

- **Server**: the `api` package gets `handle(route, async ({ params, query, body, c }) => value)`.
  It produces today's `Route` (`route.ts:12`), so old and new routes mount side by side during
  the move. The shell does auth by `surface` (today's `public` and `member` flags), checks
  `permission` (replacing the three ad hoc checks), does the CSRF check for writes, parses input
  with the existing `extract.ts` semantics, calls the handler, applies the response policy
  (decision C3), and serialises.
- **Responses**: every `response` schema is a contract schema, so the transitive domain shapes
  (`Thought`, `PersonCard`, `ModuleStatus`, `CostReport`, ...) become schemas too. The owning
  package's interface is replaced by the inferred type the same way as in §2.1. Where a producer
  extends the shape privately, as `DirectorTrace` does in `director.ts:334`, the contract becomes
  the type.
- **Panel**: a generic `call(route, input)` in `apps/panel/src/api/http.ts` replaces the 428-line
  `endpoints.ts`. During the move, `apps/panel/src/api/types.ts` becomes a re-export barrel, so
  pages don't change. The panel imports the table at runtime (method, path, schemas), which puts
  zod and the schemas in the bundle. Size not measured (risk R5). In dev builds it validates
  responses and logs mismatches. Type checking needs the `@miyoria/contracts` path alias in
  `apps/panel/tsconfig.app.json` and `vite.config.ts`, the way `card-face` is wired today
  (`tsconfig.app.json:23`, `vite.config.ts:35`).
- **CLI**: the same generic client replaces `packages/api/src/client.ts`.
- Later, without changing the shape: plugin-contributed routes (the `http` shell, v5 §11.1), the
  public/admin split (phase 6) driven by `surface`, and an OpenAPI document generated from the
  table if wanted (zod has an `openapi-3.0` target).

### 2.7 Links

The voice link, stage link, levels and overlay feed each get two schemas, one per direction,
plus `VERSION`. Within version 1, changes are additive only: `.default()` or `.optional()` per
§2.2 rule 4. Unknown `type`s stay ignorable on both sides: the receiver checks `type` against the
union's tags before `parse`. Phase 2 adds the contract version and `requires` range in the hello
(v5 §4) on top.

### 2.8 Events

What `contracts/events` supplies for the data layer (`docs/design/v5-data.md` §2.2):
- `EventEnvelopeSchema`: `id, at, type, v, source, parent, turn, session, space_id, room_id,
  person_id, account_id, scope, tier, key, data`. A draft form without `source`, `seq` and `tier`
  is what remote producers send, because Core stamps those.
- `defineEvent({ type, v, data: Schema, scope?, tier? })` and a registry, giving the data doc's
  "type registry with defaults".
- Payload schemas for every type that crosses a process boundary. On today's bus that is all of
  them: the admin SSE and extensions with `"*"` subscriptions see everything. That means 15
  variants plus about 70 topics.

Where plugin payload schemas live: in `contracts/events/<owner>.ts` for phase 1, because the
panel, the SDK and the replay format all read them and every plugin is in this repo. When
third-party plugins exist, `defineEvent` from a plugin package registers the same way. Only the
file location changes.

The fold itself (one envelope, `type` dotted, the `custom` wrapper and `V2_TOPIC_PREFIXES` gone)
is done together with the data layer's `events` table step, because every reader in §1.2 moves at
once.

### 2.9 SDK

The SDK's `types.ts` and the type half of `task.ts` are replaced by `contracts/ext` and
`contracts/events` (decision C5 settles how a published package carries them). `TaskRunner`, the
framing and the RPC code stay in the SDK. The task parity test is no longer needed once both
sides import one schema.

---

## 3. Step order

Size: S under about 300 changed lines, M about 300–1500, L more than that or several PRs. Every
step lands with `pnpm lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` and the Python
job green. Steps change no behaviour unless stated. "Mech." means mechanical once the pattern
exists. "Care" needs someone who reads both sides.

| # | Step | Touches | Size | Kind | What could go wrong | Proof |
|---|---|---|---|---|---|---|
| K1 | Package skeleton, rules test, emitter, `contracts:check` in CI | new `packages/contracts`, `ci.yml`, root scripts | S | Care (sets the conventions) | Non-deterministic JSON output; Biome or tsconfig details for a new group package | CI regenerates with no diff; the conversion test fails on a planted `.transform` |
| K2 | Wire primitives (§2.1 `wire`); `types` re-exports; `api/src/schemas.ts` uses them | `contracts/wire`, `types/src/{platform,voice,event,ids,time,json}.ts`, `api/src/schemas.ts` | S–M | Mech. plus one careful check | Inferred types differ subtly (`?:` vs `\| undefined`, readonly); a cycle if anything in `contracts` imports `types` | Before deleting each interface, a test `expectTypeOf<Old>().toEqualTypeOf<New>()`; whole-repo typecheck unchanged |
| K3 | Voice link: both directions as schemas; Core and node import them; the node's hand parser goes; bounds become schema checks, clamping stays in node code | `contracts/voice-link`, `voice/voice/src/{protocol,link/*}.ts`, `apps/voice-node/src/{protocol,link,node,...}.ts`, voice-node `package.json`, `tsconfig.json`, `start` script (`--conditions=@miyoria/source`) | M | Care | The voice node starts from source in a different way: a mistake breaks voice on the live machine. Behaviour edges: `pong` becomes known (harmless), `4408` known, `encoder` enum now enforced on the sender | Existing link and node tests; a new round-trip test: every example message is accepted by both parsers; an old-node hello without `capabilities` still parses; `miyoria up` and a real join and leave on the dev machine |
| K4 | Stage link, levels, overlay feed: drop the hand unions, infer from schemas, move transforms into `parseCoreMessage` / `parseStageMessage`; type the overlay producer; remove the dead `queue` message from the overlay or document it as demo-only | `contracts/{stage-link,overlay}`, `stage/src/{protocol,overlay}.ts`, `apps/overlay/src/feed.ts` (+ tsconfig alias), voice-node levels client | S–M | Mech. except the transforms (care) | `nullish().transform` semantics change when moved (`""` scene names, `null` vs absent); the overlay is a Vite app with its own tsconfig | Stage and overlay tests; a fixture of every message through the old and new parse gives identical output |
| K5 | Extension protocol: host schemas move; SDK types derive from contracts per C5; task copy deleted | `contracts/ext`, `plugin-host/ext-host/src/{protocol,extension}.ts`, `packages/sdk/src/{types,task}.ts`, `docs/protocols/extension-rpc.md` links | M | Care (published API) | SDK consumers' types change shape (optional vs `\| null`); the publish packaging (C5) | ext-host and SDK tests; every in-repo extension typechecks and its tests pass; `pnpm --dir packages/sdk pack` and install the tarball in a temp dir; `tsc` an example extension against it |
| K6 | Worker JSON schemas (TS side); speech, turn and sing clients parse with them; worker doc corrected (`backing`, `shared`, `gpu`, RoFormer, lyrics health) | `contracts/workers`, `voice/speech/src/{asr,tts}.ts`, `voice/voice/src/turn.ts`, `sing/src/client.ts`, `docs/protocols/voice-link.md:117-180` | S | Mech. | The sing client's `.catch` leniency must survive (static catches convert, dynamic do not) | speech, voice and sing tests unchanged |
| K7 | Python side: pinned generator, `workers/contracts.py` checked in, hand request models replaced, contract test on responses; lyrics `/health` gets the common shape (**behaviour change**: the body only; nothing reads it today) | `workers/{contracts.py,tts,asr,sing,fake,lyrics}`, `workers/tests`, `ci.yml` | M | Care | Generated models differ from the hand ones (`max_length` and `ge`/`le` on `JobRequest :564-576`, `Literal` for `backing`); `default: null` semantics; Python 3.11–3.13 across venvs | `git diff --exit-code` after generation in CI; `pytest` green; the TTS/ASR contract test against a real worker on the dev machine (`WORKER_ASR_URL=... pytest tests/test_contract.py`, per `tests/conftest.py:3-7`) |
| K8 | Route table mechanism: `defineRoute`, `handle()`, `surface`/`permission`, response policy hook; generic panel and CLI clients; migrate the smallest group (`/api/health`, `/api/auth/methods`, `/api/auth/session`) as the pattern | `contracts/api`, `api/src/{route,server,extract}.ts`, panel `api/http.ts`, CLI `remote.ts` | M | Care | Auth order changes (405 after auth today, E-panel-api §8); the CSRF check; Hono path params | API tests incl. oauth and public suites unchanged; one panel page uses `call()` |
| K9a–j | Migrate route groups, about 10 PRs: (a) public, card, board, live, og; (b) member, wallet, fortune, agency; (c) people, people-wallet, affect; (d) memory, notebook; (e) mind, inner, plan, directives, learning; (f) body, prompts, facts, turn metrics, LLM calls, telemetry; (g) ops, control, channels; (h) data, sandbox, goals, life, party, workspace, economy; (i) roles; (j) core and SSE (the `/api/events` event schema waits for K11) | the group's API file, its domain types (to inferred), panel types barrel, endpoints | S–M each, L total | Schema writing mech.; reconciling each type's two or three copies is care | Response stripping on public and member groups removes a field that a page used but the schema forgot; optional-vs-required choices; private producer types | Every existing API test runs with strict response validation and passes; panel tests pass; each PR lists the drift it resolved |
| K10 | Delete `packages/api/src/types.ts`, `client.ts`, the panel's `endpoints.ts`, and the barrel (pages import contracts) | api, panel, cli | S | Mech. | — | `git grep` shows no imports; typecheck |
| K11 | Event envelope, `defineEvent`, registry in `contracts/events`, no consumers yet | `contracts/events` | S | Care (shape agreed with v5-data §2.2) | Disagreement with the data doc on `at` (§5 R3) | Unit tests; JSON Schema emitted |
| K12a | Payload schemas for the 15 variants and about 70 topics, validated only in tests (a bus test hook parses every published event) | `contracts/events/*`, `types/src/v2-topics.ts` folded | L | Mech. per topic, care for the 13 `v2Payload` consumers | Payloads built from in-process objects carry extra or non-JSON fields | Full test suite with the validating bus hook, zero failures |
| K12b | The fold, with data steps 3 and 5: one envelope on the bus, SSE, extension notification (SDK protocol 2), replay-log format, facts writer; replay fixtures rewritten by script; panel event list | kernel bus, facts, api SSE, ext-host, SDK, replay-log, `tools/replay` fixtures, panel `lib/events.ts` | L | Care | Every reader moves at once; extension permission topics (`extensions/neuro/miyoria.extension.toml:17`, `examples/hello/...:13`) if names change (C4) | Replay scenarios unchanged; panel event view; each in-repo extension receives its subscribed events |
| K12c | Delete `customEvent`, `v2Event`, `v2Payload`, `V2_TOPIC_PREFIXES`, `EVENT_TOPICS` and its panel and SDK copies | types, ext-host, panel, SDK | S | Mech. | — | `git grep` empty |

**Phase placement and order:**
- **Phase 1, before the data layer's `events` step (v5-data §8 step 3)**: K1, K2, K11. The data
  step needs the envelope and registry.
- **Phase 1, independent of the data layer** (can run in parallel, any order after K2): K3, K4,
  K5, K6 then K7, K8 then K9 then K10.
- **Phase 1, with the data layer**: K12a can start after K11. K12b lands with data step 3 (the
  `events` table and the facts writer) or step 5 (chat events), whichever moves the bus envelope.
  K12c follows.
- **Phase 2**: hostd control link, `service.toml` and `host.toml` schemas, worker token header,
  registry `requires` ranges, all in `contracts`. The lyrics service stops reading `miyoria.toml`.
- **Phase 3**: tool registry schemas, Self loop event types (v5-data §8 "wait for phase 3").
- **Phase 6**: `apps/admin` / `apps/web` split by `surface`; the second-platform contract.
- **Phase 7**: activity contract, Neuro SDK endpoint, Minecraft adapter as a remote service.
- The "one config schema" step is a neighbour, not part of this one. It uses K1's emitter and
  rules. Plugin config schemas stay in plugins.

---

## 4. Decisions for the owner

**C1. Does `contracts` replace `packages/types` or sit beside it?**
- (a) Replace: rename `types` to `contracts` and convert everything in it.
- (b) Beside: wire shapes move to `contracts` and `types` re-exports them, while service keys and
  domain logic stay in `types` and later move to their plugins.

**Recommendation: (b).** About 650 files import `types`, and most of what it holds (76 service
keys, domain functions, feature types) is not a wire contract. Converting it all would be one
large, risky change for no protocol benefit. The plan's table (v5 §12 line 536) can read as
"contracts takes over the contract part of types".

**C2. How Python models are produced**
- (a) Generated pydantic from the checked-in JSON Schema with `datamodel-code-generator`, pinned,
  checked in, and diffed in CI.
- (b) No generated models: pytest validates worker JSON against the JSON Schema files with
  `jsonschema`, and the hand pydantic models stay.
- (c) A small in-repo TS emitter that writes pydantic directly.

**Recommendation: (a).** It keeps JSON Schema as the one interchange. Only about 15 small models
are involved, and a dev-only Python tool in CI is a small cost. (b) keeps two hand copies of the
request models. (c) is a second generator to maintain.

**C3. Response validation in production**
- (a) Validate every response everywhere and fail with 500 on a mismatch.
- (b) Validate strictly in tests and dev. In production, strict (parse and strip) on public and
  member routes, and log-only for admin routes.
- (c) Tests only.

**Recommendation: (b).** On public routes, stripping enforces "words, never numbers" mechanically.
On admin routes a schema slip should not blank a panel page in the middle of a stream. The plan
says "回應也驗證" (responses are validated too), and (b) honours that where it protects people.

**C4. Event type names at the fold**
- (a) The new `type` is today's dotted topic (`platform.message.created`, `voice.playback`,
  `system.module.state`), so extension permissions, panel filters and fixtures keep their strings.
- (b) Rename to the data doc's vocabulary (`chat.message`, `turn.outcome`, `llm.call`, ...) in
  the same change.

**Recommendation: (a) for existing events; the data doc's names for types that are new in V5.**
Renaming would add a second migration to the fold and touch extension manifests. Renames can come
later, one at a time, through the registry.

**C5. How the published SDK carries contract types**
- (a) Publish `@miyoria/contracts` as a public npm package next to `@miyoria/sdk` and `miyoria`,
  and make the SDK depend on it. Extension authors then get zod transitively.
- (b) Keep the SDK at zero dependencies by bundling its declaration files, which needs a d.ts
  bundler.
- (c) Make the SDK the home of the extension protocol schemas, add zod to the SDK, and have
  `contracts/ext` re-export them.

**Recommendation: (a).** It is the plan's intent (SDK types from contracts), it adds one line to
`release:publish`, and extensions can validate what they receive. Also decide here whether the
fold (K12b) may bump the extension protocol to 2 without a v1 fallback. Recommended: yes, every
known extension is in this repo.

---

## 5. Risks and things not verified

| # | Risk or gap | Mitigation |
|---|---|---|
| R1 | The voice node and overlay have their own tsconfig and toolchain versions (voice node TS ^5.7, overlay Vite 7, panel TS ~5.8, root ~5.9) and import no workspace package today. Adding one is new for them | Path alias or `customConditions` per app; run the voice node with `--conditions=@miyoria/source`. Check `miyoria up`, which starts the voice node (`packages/cli/src/commands/up.ts:213-233`) |
| R2 | Type-check time and error readability with about 300 inferred object types in the panel | zod 4 is designed for this [I]. Measure `tsc` time before and after K9a; give hot types explicit `interface X extends z.output<...>` if needed |
| R3 | The data doc's `at` is µs since epoch (v5-data §2.2), while wire times are RFC 3339 (TS-CONVENTIONS §2). Two shapes for one field | Settle in K11 with data step 3: the wire envelope keeps RFC 3339 and the store converts. Not an owner decision |
| R4 | Strict response stripping on public and member routes can drop a field a page reads but the schema forgot | Panel tests plus a dev-mode warning; land public groups first (K9a, K9b) and open each page |
| R5 | Panel bundle grows with zod plus the schemas (not measured) | Measure in K8. If it matters, the panel imports types only (`import type`) and builds paths from a plain generated table: a second mechanism, so only if needed |
| R6 | Line numbers in `apps/panel/src/api/*` and `packages/api/src/*` are as of `1797979` and shift with later edits | Paths and symbols are named, so re-grep before starting a step |
| R7 | The SDK is published. Shape changes in K5 and K12b reach outside users | C5; semver bump; changelog line in `docs/protocols/extension-rpc.md` |
| R8 | Generated pydantic behaviour for `oneOf`, `default: null` and `extra` handling | Not verified: the generator was not run. K7 starts with a spike on the sing `JobRequest` and `OffloadRequest` and compares them with the hand models |

**Not verified:**
- No build, test or bundle was run. Sizes are line counts and greps.
- The field-name diff of panel vs server types compares names only, not field types or
  nullability. Types declared with `extends` were skipped.
- Event and topic counts are by grep (`customEvent(`, `*_TOPIC = "..."`). Topics built
  dynamically (task topics) are not counted.
- The ~166 route count is a `method: "` grep and may miss helper-built routes.
- The local Python versions of each venv were not checked. CI uses 3.12 and the README says
  3.11–3.13.
- Whether any outside party uses the published SDK today.
