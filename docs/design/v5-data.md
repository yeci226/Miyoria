# V5 資料層:階段 1 的設計

> 狀態(2026-11-21):**已實作**,在階段 1 合併(PR #53,2026-11-15),線上已經跑在新的資料庫上。§8 第 14 步只做了前半(見「第 14 步做完之後」):舊的 store 介面和只剩搬移在讀的舊表(`relationships`、`relationship_deltas`、`self:feeling:*`)還沒拿掉,列在 [backlog.md](backlog.md)。下面是 2026-11-14 寫的設計,實作時的出入以程式為準。
>
> 2026-11-14。唯讀調查寫成的設計,當時還沒有實作。數字來自 2026-11-13 對 `data/miyoria.db` 的唯讀查詢。前半是結論和要 owner 決定的事;「Design detail」之後是實作用的細節(英文,含資料表草稿)。上層的規劃見 [v5-architecture.md](v5-architecture.md) §13。

## 現在的資料庫長什麼樣

- 同一件事記了五份:`log_events` 七天就有 182,313 列(一天 1.2 萬到 4.2 萬列、5 到 16 MB),另外 `message_log` 43,728、`decision_log` 28,294、`turn_outcomes` 21,734、`audit_log` 4,615。清理從來沒有刪掉過任何東西。
- `profile_settings`(1,414 列)裡藏了很多結構:她的想法、文件、目標、教訓(約 1.4 MB),她怎麼叫每個人(152 列)、隱私和語音同意、面板的登入 session、模型花費的統計。
- 84 個人、84 個帳號,全部是 Discord,沒有人連結了第二個帳號。
- 一天約 2,400 次模型呼叫。
- 檔案 345 MB,另外有 4 MB 還在 WAL 裡沒有寫回去。

## 設計的結論

- **只留 SQLite。** 刪掉 `postgres.ts`(2,685 行)、18 個 Postgres 遷移、`pg` 相依和 compose 裡的 postgres 服務。
- **一張 `events` 表是唯一的原始紀錄。** 每筆事件帶可見範圍(公開 / 這個 Space / 這個 Room / 私訊 / 她自己 / owner)和保留等級。衍生的事件(想法、決定)取它用到的事件裡最窄的範圍,所以關於私訊的想法進不了群組的提示詞。
- **「不要記得這個」變成遮蔽**:事件的內容換成一個「已遮蔽」的標記,並留下一筆遮蔽紀錄。「忘了我」遮蔽那個人所有的聊天事件,並呼叫每個外掛的遺忘掛鉤。
- **保留多久看等級**:旁聽到的觀察 14 天後合成每日統計;回合內部和模型呼叫的紀錄 90 天;原始聊天 365 天;稽核、身分、錢永久。
- **模型呼叫**:完整的提示詞和回應留在每天的 JSONL 檔;每次呼叫另外有一筆只含中繼資料和花費的事件,每日預算從事件算。
- **現在的五份紀錄變成檢視**(`v_messages`、`v_decisions`、`v_turns`、`v_audit`),`core/src/recorder.ts` 刪掉。
- **外掛自己帶資料表**:外掛宣告資料表前綴、只會往前的遷移(寫成 TS 字串,跟著外掛走)、相依、種子資料、匯出和清除的類別、遺忘和合併一個人的掛鉤。Core 在遷移對不上時拒絕啟動。`store` 套件只剩連線、遷移執行、事件紀錄、產物庫。
- **身分和場所**由一個永遠開著的 `identity` 外掛擁有:`persons`、`accounts`、`link_codes`、`spaces`、`rooms`、`sessions`、`space_members`。
- **錢的帳本是例外**:魚幣帳本和交易所金庫保持是外掛自己的表,有自己的約束,每筆入帳另外發一筆事件。

## 要 owner 決定的事

**2026-11-14:owner 全部照建議決定。** 之後又加了一項:新的外掛資料表先用 Drizzle(`drizzle-orm` 的 `node:sqlite` 驅動)試寫第 4 步的 identity,比過再決定是否全面採用;`events` 表、全文搜尋和 trigger 維持手寫 SQL。

| # | 事 | 建議 |
|---|---|---|
| D1 | 資料庫 | 只留 SQLite。失去的是沒在本機測過的 Docker 加 Postgres 部署,以及多個行程同時寫入 |
| D2 | 原始聊天留多久 | 365 天。它是最底層的紀錄,階段 3 可以從它重建記憶 |
| D3 | 隱私和語音同意的選擇 | 跟著帳號連結一起帶過去。重設的話,可能會去私訊或聽一個已經說過不要的人 |
| D4 | 紀念卡要用的資料 | 匯入時存下「第一次見到的時間、舊的羈絆分級名稱、舊卡的張數」,階段 5 就不需要再開舊檔。羈絆本身仍然重來 |
| D5 | 什麼時候切換到新資料庫 | 階段 1 結束時就切,階段 3 再從留下的聊天重建記憶;不等階段 3 |
| D6 | 一個資料庫一個角色 | 拿掉每張表的 `profile_id` 欄。現在每一列都是 `deepseek-chan` 或 `_global` |
| D7 | 模型的提示詞和回應 | 留在 JSONL。保留天數從 14 天提高到 30 天是可選的 |
| D8 | 錢的帳本 | 保持是外掛自己的表,是「只有一份原始紀錄」的刻意例外 |

## Drizzle 試用的結果(2026-11-14)

第 4 步的 identity 外掛是用 Drizzle(`drizzle-orm` 1.0.0-rc.5,`drizzle-orm/node-sqlite` 驅動,不需要原生編譯的套件)寫的,同時回答「要不要全面用它」。結論是**一般的外掛資料表都用 Drizzle,有幾樣維持手寫 SQL**。**2026-11-15:owner 決定全面採用。**

- **用 Drizzle 的**:各外掛的一般資料表(設定、auth、directive、economy、交易所、卡片、產物庫的中繼資料等)。資料表定義就是型別的來源,不再手寫資料列的轉換。
- **維持手寫 SQL 的**:`events` 表和它的 trigger、JSON 檢視;全文搜尋;遷移執行器本身;`legacy` schema;會重建整張表的遷移。
- **遷移怎麼接**:SQL 由 drizzle-kit 從資料表定義產生,commit 進 repo,交給 `migrate.ts` 的執行器套用;有一個測試比對「定義」和「遷移後的資料庫」,兩邊對不上就失敗。不用 Drizzle 自己的 migrator:它不會拒絕被改過或缺少的遷移,順序錯了也照跑。
- **速度**(10 萬次查詢):預先 prepare 的 Drizzle 查詢和手寫的 prepared statement 一樣快(約 2 到 3 微秒);每次現組的查詢要 11 到 19 微秒,所以常跑的查詢要先 prepare。
- **交易**:Drizzle 和手寫 SQL 共用同一條連線,一起 commit、一起 rollback;一律用 `Db.tx`(巢狀時是 savepoint),不用 Drizzle 自己的 `transaction()`。
- **Drizzle 做不到、要自己補的**:`STRICT`(產生 SQL 時補上);欄位的 `COLLATE NOCASE`(改用不分大小寫的 unique index);drizzle-kit 看不到 partial index 的條件和 expression index(由比對測試檢查)。
- **代價**:它是 rc 版,試用時踩到十個小問題,都有繞法;程式碼行數沒有變少(同樣的操作從約 285 行變成約 394 行),換到的是型別檢查和不會對不上的 schema;CLI 多一個相依,安裝後約 28 MB。
- **之後幾步要照做的**:常跑的查詢 prepare 一次;JSON 欄位讀出來時用 zod 解析(`$type` 只是編譯期的標註);第 11 步加一個涵蓋所有 Drizzle 外掛的比對測試。

和原設計不同的地方:identity 放在 `packages/store/src/identity/`,還不是獨立的套件;一個人一個 handle(不是一個帳號一個);`persons.name` 保留第一次見到時的名字;為了讓 identity 擁有 `accounts` 和 `link_codes`,`legacy` 的第 1 和第 3 個遷移拿掉了這幾張表。

## 做到第 5 步時和原設計不同的地方(2026-11-15)

- **事件的名字**:現有的事件沿用現在的 topic 名稱。別人說的話是 `platform.message.created`,她自己送出的訊息是同一個型別加上 `self: true`(她的文字只會以平台回傳的那一則出現在匯流排上);聽到的語音是 `voice.utterance`;她說出口的是 `voice.playback`(只記 `started`)。facts 模組自己的紀錄(觀察、想法、決定、動作)叫 `facts.*`,因為它存的是 facts 的內容而不是 topic 的 payload;原本的 topic 留在 `data.origin.topic`。
- **一句話只存一次**:聊天事件用 `msg:<平台>:<id>` 當 key,兩條連線都送來的同一則訊息只存一筆。她對那句話的觀察(`facts.observation.said`)用同一個 key,是衍生的,另外存。
- **「不要記得這個」**:把那則訊息 key 底下的事件全部遮蔽(聊天那一筆和她對它的觀察),內容換成遮蔽標記,信封留著;設定裡那份 500 筆的排除清單拿掉了。之後有人把同樣的話再貼一次,會當成新的訊息。
- **「忘了我」**(不帶關鍵字):除了刪記憶,也遮蔽這個人所有的聊天事件和她對那些話的觀察;帶關鍵字的不動聊天紀錄。指令的說明文字跟著改了。
- **保留多久**:沒有對她說的閒聊現在也留 365 天(以前 14 天就合成統計);值得記的遊戲事件留 90 天。
- **`seq` 不會被重用**(AUTOINCREMENT),壓縮刪掉舊列之後也一樣。
- **還沒做的**:「忘了我」不會去改 LLM 呼叫的 JSONL 檔(風險 R4);她在一個還沒有人說過話的私訊裡的第一句話,存的時候沒有場所。

## 第 11 步做完之後(2026-11-15)

- **類別放在哪**:類別的清單(id、順序、相依、要不要確認)還是只有一份,在 store 裡;每個外掛只宣告「我的哪些表屬於哪個類別」。面板、API、指令都用類別 id,所以外掛只能加內容,不能加類別。沒裝某個外掛時,類別還在,只是少了那個外掛的部分。
- **「忘了我」和合併**:store 有一個協調者(`store.personData`),在一個交易裡依序呼叫每個外掛的掛鉤,有相依的先跑,identity 和事件紀錄最後;任何一個掛鉤丟錯就整個復原。每個掛鉤回報做了什麼,或是說明為什麼不動(錢、角色和登入、規則、人的那一列、羈絆都留著)。
- **記在哪**:每次請求記成一筆稽核事件(`audit.person.forget`、`audit.person.merge`),只有 id、原因和各掛鉤的筆數,沒有任何對話內容。原設計寫的是 `identity.merged` 事件,但一般事件會被清除資料刪掉,稽核不會,所以改用稽核。
- **「忘了我」現在多涵蓋的**:私訊裡的記憶、從這個人其他已連結帳號說的記憶、合併之前記在舊 id 底下的聊天紀錄。以前只處理發出指令的那個帳號。
- **沒有放進掛鉤的**:會員卡和籤(會員頁自己刪,而且不能忘記時也會刪)、筆記頁(是設定,不是外掛的表)、為這個人做的產物(有自己的到期和下架)。
- **清除事件紀錄**:永久保留的事件只有在它記錄的那個類別也被清除時才刪。清聊天紀錄不會再刪掉金幣的過帳;全部重設還是全部刪。
- **遮蔽的通知**:記憶體裡的快取在交易真的寫入之後才收到通知(`Db.afterCommit`),交易復原就不通知。

## 第 14 步做完之後(2026-11-16)

趁還沒有任何新資料庫,把能整理的先整理掉;切換之後每次改結構都要寫遷移。

- **`legacy` 壓成一個遷移**:V4 的 18 個遷移走到最後只剩三張表還有人用,`relationships`、`relationship_deltas`(社交)和 `member_cards`(會員卡)。現在一個遷移直接建這三張,測試留著舊遷移建出來的結構當對照。它們的 `profile_id` 欄位留著:這三張表在階段 4(心)和階段 5(玩)會重新設計,現在拿掉要改每一句查詢。
- **記憶的遷移也併成一個**(含 embedding 是哪個模型算的那一欄)。全新的資料庫每個外掛都只記一筆遷移。
- **全新資料庫有的表**:事件紀錄(`events`、`event_rollups`)、身分和場所(`persons`、`accounts`、`link_codes`、`spaces`、`rooms`、`sessions`、`space_members`)、設定(4 張)、產物庫(3 張)、權限(5 張)、規則(1 張)、經濟(8 張)、記憶(`memory_records`、全文索引、向量版本)、上面三張舊表,加五個讀事件紀錄的 view。
- **刪掉的**:沒人讀的模組狀態介面;啟動時修 V4 資料的程式(紀錄裡的臨時代號、把舊關係搬進人物卡);修 V4 筆記範圍的腳本;社交連結帳號時多做一次的記憶合併。
- **留著的轉接層**:大部分舊的 store 介面還有很多呼叫的地方(設定 24 個檔、人物 12 個、稽核 11 個、聊天紀錄 7 個……),跟著各套件在後面的階段重寫時再換,不做全 repo 的介面大改。
- **一個行為差別**:以前每次啟動都會替「有關係但人物卡還沒搬過」的人補卡,羈絆超過 25 的會種一筆依附。這段是 V4 的搬移程式,現在沒有了;名字和羈絆快照本來就由情感服務維持,「種依附」沒有別的來源,階段 4 做人物模型時一起處理。

## 切換的步驟

1. 先拿現行檔案的複本演練一次匯入。
2. 停掉 Core。
3. 把 `miyoria.db`、`-wal`、`-shm` **三個檔一起**改名搬進 `data/archive/`。只搬 `.db` 會丟掉還在 WAL 裡的 4 MB 最近寫入。
4. 用 `VACUUM INTO` 做一份單一檔案的複本,寫下雜湊。
   - `data/replay/` 如果有檔案(重播紀錄預設是關的),一起搬進封存:新版一行是一個新格式的事件,讀到舊格式的行會報錯並指出是舊格式,不會轉換。
5. V5 指向新的 `data/core.db`。
6. 第一次啟動時跑遷移和種子、建立 `home` session、把 `miyoria.toml` 匯入成第 1 版設定。
7. 跑 `miyoria db import-links`,然後做基本檢查。

新舊兩個 Core 不能同時連 Discord(同一個帳號會回兩次)。要退回去:停掉 V5、切回打了標籤的舊版、把封存的檔案改名回來;V5 試跑期間得到的東西舊版看不到。

## 工作順序

每一步都留著舊的 store 介面當轉接層,所以測試一直是綠的。大小:小 = 不到一天,中 = 一到三天,大 = 三天以上(一個代理含測試)。

| # | 步驟 | 大小 |
|---|---|---|
| 1 | 新的遷移執行器(已完成) | 小 |
| 2 | 刪掉 Postgres(已完成) | 小 |
| 3 | `events` 表、遮蔽、保留等級(已完成) | 中 |
| 4 | `identity` 外掛(已完成,用 Drizzle 寫) | 中 |
| 5 | 聊天事件取代 `message_log`(已完成) | 中 |
| 6 | 回合和稽核事件;刪掉 recorder(已完成) | 小到中 |
| 7 | `llm.call` 事件(已完成) | 小 |
| 8 | 設定外掛(有版本的設定、每個 Space / Room 的覆寫)(已完成) | 中 |
| 9 | 把 auth、directive、persona、economy 的表搬進各自的外掛,memory 先原樣搬(已完成) | 大 |
| 10 | 產物庫(已完成) | 中 |
| 11 | 每個外掛自己的資料類別(匯出、清除)、「忘了我」和合併的掛鉤(已完成) | 中 |
| 12 | 匯入和封存的工具(已完成,拿現行資料庫的複本演練過) | 小 |
| 13 | 切換 | 小 |
| 14 | 刪掉轉接層和舊的遷移程式(能做的已完成,其餘跟著各套件重寫) | 中 |

以上都可以在重建大腦(階段 3)之前做。要等階段 3 的:session 的逐字稿和壓縮、新的記憶結構和 embedding、她的 JSON 狀態變成真的表、Self loop 的事件型別、`share()`。

## 風險

- `node:sqlite` 的寫入是同步的,可能卡到語音。保留現在的緩衝寫入,並監看每次寫入花多久。
- 128 個原始檔和 97 個測試檔 import 了 store;靠轉接層才能讓每一步都小。
- 遮蔽碰不到 JSONL 的提示詞檔。「忘了我」會依回合代號改寫那些檔;單次的「不要記得這個」只能等 14 天後檔案過期。
- 切換之後到階段 3 之間產生的記憶,到時是從留下的聊天重建,不是搬過去。

---

## Design detail

**Marks.**
- **[read: path]**: read in source at that path (paths are relative to `packages/` unless they start with `docs/`).
- **[db]**: a read-only query on the live database. Counts are from 2026-11-13; the last write is 07:11 UTC.
- **[inferred]**: inferred, not checked.

Size marks: **S** is under a day, **M** is one to three days, **L** is more than three days, for one agent including tests.

---

## 0. Summary

| Topic | Recommendation |
|---|---|
| Dialect | **SQLite only** (`node:sqlite`, WAL, STRICT tables). Delete `postgres.ts` (2,685 lines), the 18 PG migrations, the `pg` dependency and the compose `postgres` service. |
| Raw record | One table, `events`. Its envelope follows v5 §4: `id, seq, at, type, source, parent, turn, session, place ids, person, scope, tier, key, data, v, redacted_at`. `message_log`, `decision_log`, `turn_outcomes`, `audit_log` and the `llm_usage:*` rows become views or queries over it. |
| Store package | Keeps four things: the connection, the migration runner (`_migrations`), the event log and the artifact store. Everything else moves to a plugin. |
| Plugin tables | A plugin's manifest declares a `schema`: a table prefix, migrations embedded as TS strings (so the CLI bundle carries them), `requires`, a seed and data categories. Core runs core migrations first, then plugins in dependency order, each migration in its own transaction. Tests call `openTestDb({ plugins })` on `:memory:`. |
| Identity and places | Owned by an always-on `identity` core plugin: `persons`, `accounts`, `link_codes`, `spaces`, `rooms`, `sessions`, `space_members`. `AccountRef` and `ContextKey` stay as the code types, and a resolver maps them to rows and to session keys. |
| Settings | `config_revisions` holds the versioned cluster config; `place_settings` holds per-Space and per-Room overrides, resolved room → space → cluster; `plugin_state` holds singleton JSON. Collections get real tables. |
| Cut-over | Stop Core. Rename the old `.db`, `-wal` and `-shm` files together into `data/archive/`. V5 opens a new `data/core.db`. `miyoria db import-links` copies people, accounts, handles and (pending decision D3) privacy and voice-consent choices, plus a legacy snapshot for the keepsake card. Roll back by renaming the files back. |
| Before phase 3 | Runner, Postgres removal, `events`, identity and places, the five logs as projections, LLM call events, moving stable plugins' tables out, artifact tables, import tooling, cut-over. |
| Wait for phase 3 | L1 transcripts, the new memory schema, turning the brain's JSON blobs (`mind:*`, `knowledge:*`, `reflect:*`, `self:*`) into tables, and the final event types of the Self loop. |

---

## 1. What exists today

### 1.1 Tables

Sources: the migrations in `store/migrations/sqlite/0001`–`0018` [read], row counts [db], and writers [read: the files named]. "Written" means a row is dated 2026-11-12 or later [db].

| Table | Owner feature (writer) | Rows | Still written | Notes |
|---|---|---:|---|---|
| `log_events` | facts EventLog (`memory/facts/src/log.ts`, `bus.ts`) | 182,313 | yes | `person` holds a **handle string, not a person id**: 40,028 rows set, 0 look like ULIDs [db]. `log_event_rollups` has 0 rows, so compaction has never deleted anything [db]. |
| `message_log` | `core/src/recorder.ts:132` | 43,728 | yes | Duplicates the chat that `log_events` already holds [read: phase1-removals §8] |
| `decision_log` | `core/src/recorder.ts:97` | 28,294 | yes | JSON `trace`, 9.9 MB [db] |
| `turn_outcomes` | `core/src/recorder.ts:106-108` | 21,734 | yes | JSON `record`, 9.1 MB. The same data is in `log_events` kind `result` [db] |
| `audit_log` | api, auth, directive, commands, economy, gate/actions, memory (`AuditLogKey` users) | 4,615 | yes | Top action: `gate.game.act` 1,138 [db] |
| `memory_records` + `memory_fts` (5 shadow tables) + `memory_vector_version` | memory (`memory/memory`) | 14,728 | yes | `embedding` is NULL everywhere, because embedding is off [db] |
| `relationships` | social / self | 69 | yes | Affinity reaches 105 [db] |
| `relationship_deltas` | social | 7,462 | yes | |
| `people` | recorder via `PeopleStore.upsertAccount` | 84 | yes | |
| `accounts` | same | 84 | yes | All are `discord`. No person has two accounts [db] |
| `link_codes` | identity (`IdentityStore`) | 2 | no (11-08) | Stores the code in plain text [read: 0003] |
| `roles` | auth (built-ins) | 7 | seeded | All 7 are built-in [db] |
| `role_assignments`, `role_mappings`, `node_overrides` | auth | 0 | no | |
| `directives` | brain/directive | 0 | no | |
| `persona_overrides` | profile | 0 | no | |
| `module_state` | kernel/core | 45 | yes | Only `ext.miyoria.osu` and `ext.miyoria.threads` are off [db] |
| `profile_settings` | about 20 packages through `SettingsStore` | 1,414 | yes | JSON key-value table; see §1.2 |
| `coin_ledger` | economy | 1,285 | yes | Keyed by `(author_platform, author_id)`. The purse is the synthetic account `{platform:"self"}` [read: `economy/src/purse.ts:2`] |
| `coin_wallets` | economy | 6 | no (11-09) | Frame and board flags |
| `member_cards` | api `member.ts` | 126 | yes | |
| `fortunes` | economy / api | 11 | yes | |
| `deals` | economy | 3 | no (11-10) | v5-play §4.2 deletes it |
| `goals`, `goal_pledges` | economy | 0 | no | Deleted (v5-play §4.2) |
| `bounties` | economy | 8 | yes | |
| `economy_docs` | economy v2 | 27 (`item` 22, `room` 5) | no (11-11) | Generic document table; `data` is JSON |
| `schema_version` | store runner | 17 | — | The live DB is at version 17; the repo has 0018 [db, read] |

Volume [db]:
- `log_events` covers 7 days (2026-11-07 to 11-13) at 12k–42k rows a day and about 5–16 MB of `body` a day.
- `message_log` adds 2.3k–7.6k rows a day.
- The file is 345 MB (84,378 pages of 4 KB) with a 4 MB WAL.
- About 2,400 LLM calls a day (`llm_usage:2026-11-12`: 2,403 calls, 25.5M prompt tokens, $5.00).

### 1.2 JSON that hides structure (`profile_settings`)

Per-family counts and sizes [db]. The "should be" column is a recommendation.

| Key family | Profile | Rows | Bytes | Really is | Should be |
|---|---|---:|---:|---|---|
| `mind:thought:*` | deepseek-chan | 220 | 630k | A collection of thoughts | Phase 3 brain table (or the event log) |
| `knowledge:doc:*` | deepseek-chan | 400 | 576k | L3 documents | Phase 3 `memory_notes` |
| `mind:goal:*`, `mind:digest:*`, `mind:life:*`, `mind:plan`, `mind:reminder` | deepseek-chan | 218 | 138k | Agenda, digests, plans | Phase 3 tables |
| `reflect:run:*`, `reflect:lesson:*`, `reflect:state` | deepseek-chan | 86 | 50k | Reflection runs and lessons (L5) | Phase 3 tables |
| `self:feeling:<person>` | deepseek-chan | 69 | 37k | Per-person feeling | Phase 4 `heart_person` |
| `self:state` | deepseek-chan | 1 | 29k | Drives, policy, agenda in one blob | Phase 4 split; until then `plugin_state` |
| `feedback:day:*` | deepseek-chan | 10 | 84k | Daily feedback | Phase 3 eval |
| `conversation:state:<ctx>` | deepseek-chan | 25 | 29k | Per-place summaries keyed by a context string | Phase 3 `sessions` / L1 |
| `memory_watermark:discord:*` | deepseek-chan | 31 | 5k | Consolidation cursor per place | Column on the projection cursor (phase 3) |
| `handle:<platform>:<id>` | `_global` | 152 | 26k | **Identity**: account → stable name → person [read: `store/src/handles.ts:1-9`] | `persons.handle` (phase 1) |
| `privacy:<platform>:<id>` | `_global` | 3 | <1k | A person's choices [read: `types/src/privacy.ts:1-9`] | `persons.prefs` (phase 1) |
| `voice_consent:<platform>:<id>` | `_global` | 5 | <1k | A person's choice [read: `voice/voice/src/consent.ts:19`] | `persons.prefs` (phase 1) |
| `panel_session:<hash>` | `_global` | 45 | 13k | Login sessions [read: `api/src/session.ts`] | `auth_sessions` table |
| `llm_usage:<day/month>` | `_global` | 12 | 2k | Running cost totals [read: `llm/llm/src/cost.ts`] | Query over `llm.call` events |
| `discord.emoji.desc.<id>` | deepseek-chan | ≈120 | ≈2.5k | Per-emoji descriptions | `discord_emoji` table |
| `arbiter:state`, `queue:state`, `sing:setlist`, `initiative:state`, `stage:scene_roles`, `public:today`, `mood:last`, `agent:work:day`, `activeness:*`, `notebook:page:*`, `memory.dates` | mixed | 15 | 64k | Module singletons | `plugin_state`. The song queue becomes a per-Space table when phase 6 touches it |
| `memory_excluded` | deepseek-chan | 0 now | | "Don't remember this" list [read: `memory/memory/src/exclusion.ts:13-16`] | Redaction in `events` (§2.4) |

Other JSON columns with structure [read: migrations]:
- `economy_docs.data`: items, predictions, bets, commissions and rooms all in one table.
- `decision_log.trace` and `turn_outcomes.record`.
- `memory_records.scope` / `scope_key`: canonical JSON used as an equality key.
- The canonical-JSON `context_key` columns, which repeat a Discord-shaped `ContextKey` in every log.

---

## 2. The event log

### 2.1 What to keep from facts

[read: `memory/facts/src/log.ts:1-6`, `config.ts`, `module.ts:187-215`, `store/src/sqlite.ts:2689-2880`]

**Keep:**
- **Non-blocking `append`.** It writes into a hot window and a bounded buffer, flushed in one transaction every 500 ms. The store failing never reaches a turn or the voice path.
- Idempotent ids: `ON CONFLICT (id) DO NOTHING`.
- The `cause` chain.
- **Leaf-first compaction** that preserves chains, with per-day rollups.
- The `BEFORE UPDATE` append-only trigger.
- The ambient-fold and `retain_days` policy.
- The flush-time metric.

**Change:**
- `person` is a handle. It becomes `person_id`.
- `context` / `context_key` (Discord-shaped canonical JSON) become `session` plus place ids.
- The turn lookup uses `json_extract(body,'$.turn')` [read: `sqlite.ts:2756-2761`]. It becomes a `turn` column.
- `kind` is a closed list of 10 values [read: `types/src/log-event.ts:22-43`]. It becomes a registered `type`.
- There is no privacy scope and no redaction. "Do not remember this" leaves the text in `log_events` and keeps a side list in settings [read: `exclusion.ts:1-8`]. Both are added.
- PostgreSQL never implemented the log [read: `stores.ts:572`, `migrations/postgres/0006`].

### 2.2 Envelope and table

The envelope is v5 §4's `{ type, data, id, parent, at, turn, source }` plus place, privacy and retention fields. Core stamps `source`, `seq` and `tier`. Writers supply the rest, and the type registry supplies defaults.

```sql
-- core 0002_events.sql  (core 0001 is the bookkeeping, §3.1)
CREATE TABLE events (
    seq          INTEGER PRIMARY KEY,          -- commit order; the paging cursor
    id           TEXT    NOT NULL UNIQUE,      -- ULID; the bus envelope id; idempotent append
    at           INTEGER NOT NULL,             -- µs since epoch, when it happened
    type         TEXT    NOT NULL,             -- registered: 'chat.message', 'turn.outcome', ...
    v            INTEGER NOT NULL DEFAULT 1,   -- schema version of `data` for this type
    source       TEXT    NOT NULL,             -- stamped by Core: plugin / provider / host id
    parent       TEXT,                         -- id of the causing event
    turn         TEXT,                         -- turn id
    session      TEXT,                         -- session key ('discord:<g>:<c>', 'discord:dm:<person>', 'home')
    space_id     TEXT,                         -- denormalised from the session for scope checks
    room_id      TEXT,
    person_id    TEXT,                         -- acting person (never a handle)
    account_id   TEXT,                         -- acting account
    scope        TEXT    NOT NULL CHECK (scope IN ('public','space','room','dm','self','owner')),
    tier         TEXT    NOT NULL CHECK (tier IN ('keep','long','short','ambient')),
    key          TEXT,                         -- attention / dedupe key, e.g. 'msg:discord:<id>'
    data         TEXT    NOT NULL,             -- JSON
    redacted_at  INTEGER                       -- set once by redact(); data becomes '{"redacted":true}'
) STRICT;

CREATE INDEX events_type_idx    ON events (type, seq);
CREATE INDEX events_session_idx ON events (session, seq) WHERE session IS NOT NULL;
CREATE INDEX events_person_idx  ON events (person_id, type, at) WHERE person_id IS NOT NULL;
CREATE INDEX events_turn_idx    ON events (turn) WHERE turn IS NOT NULL;
CREATE INDEX events_parent_idx  ON events (parent) WHERE parent IS NOT NULL;
CREATE INDEX events_key_idx     ON events (key) WHERE key IS NOT NULL;
CREATE INDEX events_tier_idx    ON events (tier, at);        -- compaction
CREATE INDEX events_at_idx      ON events (at);              -- time windows, metrics

-- Rows never change, with one exception: redact() may replace `data` and set `redacted_at`, once.
CREATE TRIGGER events_append_only BEFORE UPDATE ON events
WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL
          AND NEW.data = '{"redacted":true}'
          AND NEW.seq = OLD.seq AND NEW.id = OLD.id AND NEW.at = OLD.at AND NEW.type = OLD.type
          AND NEW.source = OLD.source AND NEW.parent IS OLD.parent AND NEW.turn IS OLD.turn
          AND NEW.session IS OLD.session AND NEW.person_id IS OLD.person_id
          AND NEW.scope = OLD.scope AND NEW.tier = OLD.tier)
BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE event_rollups (           -- what compaction removed, per UTC day (kept from 0006)
    day      INTEGER NOT NULL,
    type     TEXT    NOT NULL,
    source   TEXT    NOT NULL,
    count    INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    last_at  INTEGER NOT NULL,
    PRIMARY KEY (day, type, source)
) STRICT;
```

- `data` stays JSON text rather than SQLite's binary `jsonb`, so `sqlite3` stays readable. At about 15 MB a day this costs little [inferred from §1.1 volume].
- **Do not create any FK from `events` to identity tables.** The log must accept rows for accounts or places that are not resolved yet, and a FK check on every insert costs time.
- `profile_id` is gone: one database belongs to one character (decision D6).

### 2.3 Order and ids

- **`seq` is the total order**. One process writes the file, so `seq` is the commit order. Paging and "what happened after X" use `seq`.
- `id` is a ULID made by a monotonic factory at creation. Events buffered by the facts writer are created before they commit, so `id` order and `seq` order can differ by up to one flush.
- `at` is when the event happened. Remote producers (hostd nodes, voice-node) stamp it themselves, so `at` can be skewed. Time windows use `at`; causality uses `parent`, then `seq`.
- **Two write paths, one table:**
  1. **Buffered** (`events.append`, never throws): chat, observations, turn internals. This is the facts writer as it is today.
  2. **Transactional** (`db.tx(() => { ...; events.appendNow(e) })`): when a plugin's own row and its event must commit together, such as a ledger posting and its `economy.posted` event, or an artifact row and `artifact.created`.

### 2.4 Privacy scope and "do not remember this"

**Scope** says where the content may be loaded into a prompt or shown. The writer sets it, defaulting from the session. Derived events (decisions, thoughts, summaries) **inherit the narrowest scope among their inputs**. Without this rule, a thought about a DM could reach a group prompt.

| `scope` | Default for | Can be loaded in |
|---|---|---|
| `public` | Public posts, public stage and live events | Anywhere |
| `space` | Space-wide events (member joined, server goal) | Sessions of the same `space_id` |
| `room` | Messages in a guild channel, thread or voice room | Sessions of the same `room_id` (threads: the parent room too) |
| `dm` | DMs | The DM session of `person_id`, and her inner tools with an owner check |
| `self` | Her own state with no source (mood tick, cluster start) | Her own prompts anywhere |
| `owner` | Audit, admin, identity, LLM call metadata | Panel and owner only |

- Memory (phase 3) uses the same vocabulary plus `person` ("anywhere this person is"). Today's memory scopes map one to one: `global`→`public`/`self`, `guild`→`space`, `channel`→`room`, `dm`→`dm`, `person`→`person` [read: `store/src/records.ts:380-390`].
- **"Do not remember this"** (today: `agent.message.excluded` plus a 500-entry list in settings [read: `exclusion.ts`]) becomes `events.redact(id, reason)`:
  - It sets `data = '{"redacted":true}'` and `redacted_at` on the target, allowed only by the trigger above.
  - In the same transaction it appends `privacy.redacted` with `{target, reason}`. The text is not kept.
  - Message and turn readers are views (§2.7), so the line disappears from every projection at once.
  - Memory records point at events (`source_events`, already in 0007 [read]). The memory plugin listens for `privacy.redacted` and deletes or rewrites records whose only evidence is the redacted event.
- **"Forget me"** (`/me memory forget`, `POST /api/member/forget` [read: `api/src/member.ts:393-416`]) also redacts every `chat.*` and `voice.*` event with `person_id = X`, after each plugin's `forgetPerson(X)` hook (§3.4). The envelopes stay for counts. The person and account rows stay unless the person also asks to unlink.
- **The JSONL limit.** LLM call files hold prompt text, and redaction cannot reach every line by event id. Lines carry `turn` [read: `llm/llm/src/calls.ts:117`]. So `forget me` also rewrites the affected day files and drops the bodies of calls whose `turn` touched the person's events. A single "do not remember this" relies on the 14-day file retention and says so (risk R4).

### 2.5 Retention and size

Each registered type has a `tier`. Compaction keeps today's leaf-first rule (a row goes only when no row names it as `parent`), works per tier and keeps writing `event_rollups`.

| Tier | Types (examples) | Kept | Why |
|---|---|---|---|
| `ambient` | `world.observed` with ambient salience (presence, game hazards, stage ticks) | Folded after 14 days | 33,673 of today's rows are ambient [db] |
| `short` | `turn.decision`, `turn.thought`, `action.*`, `llm.call` | 90 days | Debugging and metrics windows |
| `long` | `chat.message`, `chat.said`, `voice.heard`, `voice.said`, `share.*` | 365 days (decision D2) | L0 for re-deriving L1–L3 in phase 3 and for evals |
| `keep` | `audit.*`, `identity.*`, `settings.changed`, `privacy.redacted`, `economy.posted`, `artifact.*`, `heart.changed` (phase 4) | Forever | Small and needed for "why" |

- **Size.** Today it is about 30k events and 15 MB a day [db]. With the V2, Floor and Arbiter sources gone (in the top sources: `mainline` 35,636, `floor` 7,510, `arbiter` 5,868 rows) [db], 15k a day is plausible [inferred].
  - Chat alone: about 7k lines a day at about 0.5 KB each, roughly 1.3 GB a year.
  - Everything else: bounded by its tier.
- **Disk.** The first core migration sets `PRAGMA auto_vacuum = INCREMENTAL`; this works only before any table exists. Compaction then runs `PRAGMA incremental_vacuum(N)`. The nightly backup uses `VACUUM INTO 'data/backups/core-<day>.db'`.

### 2.6 LLM calls

[read: `llm/llm/src/call-writer.ts:1-50`, `calls.ts:81-127`]

**Keep the JSONL files for bodies** (`data/llm-calls/<day>.jsonl`, `keep_days` 14, 512 MB a day cap), and **add one `llm.call` event per call**:
- `tier=short`, `scope=owner`, `turn` set.
- `data` holds the `LlmCallRecord` without bodies: purpose, model, status, usage, cost, ms, finish_reason, tools, plus `file: "2026-11-14.jsonl"`.

Why bodies stay out of SQLite: about 2,400 calls a day at about 10k prompt tokens each [db: `llm_usage`] is roughly 100 MB a day of mostly repeated prefixes. That would triple the DB growth for data that is read rarely.

This meets v5 §7.5 ("rebuild what the model saw") within `keep_days`. To keep more, there are two options:
- Raise `keep_days` to 30 (decision D7).
- Later (phase 3, optional): store prompts as content-addressed blocks in the artifact store, because prefixes repeat. Not in phase 1.

The `llm_usage:*` settings rows go away. The panel's daily cost and the $10 budget become `SELECT sum(json_extract(data,'$.cost_usd')) FROM events WHERE type='llm.call' AND at >= ?`; the indexes are fine at that volume. A cached day total in memory covers the per-request budget check.

### 2.7 The five logs as projections

| Old log | Rows [db] | Written by [read] | New event types | Projection |
|---|---:|---|---|---|
| `log_events` | 182,313 | facts bus | All (renamed table, new envelope) | The table itself |
| `message_log` | 43,728 | `core/src/recorder.ts:132` | `chat.message`, `chat.said`, `voice.heard`, `voice.said` | `VIEW v_messages` over `events_session_idx`: `json_extract` author name, text, `is_self` |
| `decision_log` | 28,294 | `recorder.ts:97` | `turn.decision` | `VIEW v_decisions` |
| `turn_outcomes` | 21,734 | `recorder.ts:106-108` | `turn.outcome` (one per turn; a re-send is a new event and readers take the latest) | `VIEW v_turns` (latest per `turn`) |
| `audit_log` | 4,615 | `AuditLogKey` writers | `audit.<area>.<action>`, `scope=owner`, `tier=keep`, `data={actor,target,detail,ok}` | `VIEW v_audit WHERE type GLOB 'audit.*'` |
| `llm_usage:*` (settings) | 12 | `llm/llm/src/cost.ts` | `llm.call` | Query (§2.6) |

`core/src/recorder.ts` disappears: the platform plugin and delivery write the chat events, and the brain writes the turn events.

`relationship_deltas` is not one of the five. Phase 4 replaces it with `heart.changed` events, one per change as the brief requires, and a `heart_person` table of current values. No separate delta table.

**Readers that must change** [read, call sites from `git grep` of the service keys, tests excluded]:

| Old log | Readers | What they do |
|---|---|---|
| `message_log` | `brain/agent/src/history.ts:77`; `memory/memory/src/module.ts:141`; `memory/learning/src/modules.ts:146` and `conversation.ts:357`; `heart/mind/src/mind.ts:2025`; `api/src/member.ts:290` (`authoredSince`, member chart) | Recent lines of a context, lines since a watermark, counts per author |
| `decision_log` / `turn_outcomes` | `api/src/core.ts`; `api/src/metrics-turns.ts` (`decisionsSince`, `outcomesSince`); `api/src/prompts.ts`; `plugin-host/mcp/src/server.ts` | Panel "why did she (not) reply", turn metrics, the MCP read tool |
| `audit_log` | `api/src/state.ts` (panel audit page) | Read newest first; filter by actor |
| `log_events` via `EventLogKey` | `api/src/facts.ts`; `brain/activity/src/steer.ts`; `brain/agent/src/mainline/main.ts`; `brain/arbiter/src/module.ts`; `brain/directive/src/{module,service}.ts`; `economy/src/{economy,purse}.ts`; `heart/mind/src/module.ts`; `live/src/module.ts`; `memory/memory/src/engine.ts`; `play/party/src/module.ts` | Through the facts `EventLog` interface. Only the filter fields change: `person` becomes a person id, `context` becomes `session` |
| `AuditLogKey` writers | `auth`, `brain/directive/src/service.ts`, `commands/src/registry.ts`, `economy/src/{economy,purse}.ts`, `gate/actions/src/registry.ts`, `memory/memory/src/{commands,module}.ts`, `api` | Change to `events.append({type:'audit.…'})` |
| Wire formats with the event shape | Panel SSE parser `apps/panel/src/api/types.ts:123-155`, SDK `sdk/src/types.ts:142`, replay fixtures [read: phase1-removals §5] | Not the DB, but they move with the contracts step |

**Migration tactic.** In step 5–6 of §8, `MessageLog`, `DecisionLog` and `AuditLog` keep their interfaces but are reimplemented over the views. The callers above do not change in that step. Each one moves to the event API later, when its own package is rewritten. The V2-era ones (mainline, arbiter) are deleted rather than ported.

---

## 3. Plugin-owned tables

### 3.1 Mechanism

```ts
// @miyoria/store (store keeps only this, the connection, events and artifacts)
export interface PluginSchema {
  plugin: string;                       // 'economy'; also the table prefix 'economy_'
  requires?: readonly string[];         // schemas that must migrate first ('identity' is implied)
  migrations: readonly Migration[];     // ordered, forward-only
  seed?(db: Db): void;                  // idempotent, runs every start (built-in roles, ...)
  data?: readonly DataCategory[];       // inventory / export / wipe (§3.4)
  forgetPerson?(db: Db, person: PersonId): number;   // "forget me"
}
export interface Migration { version: number; name: string; sql: string }  // sql is a TS string
// ModuleManifest gains: schema?: PluginSchema
```

- **Migrations are TS string constants, not `.sql` files.** Today the store reads `../migrations/sqlite/` from disk [read: `store/src/sqlite.ts:157,326`], so the CLI build has to copy that folder next to the bundle [read: `cli/scripts/build.mjs:114-116`]. Strings go through esbuild with the plugin, so a plugin installed on any host carries its own schema. Each string can still be authored as a `.sql` file and imported with an esbuild text loader. Recommendation: plain `.ts` files.
- **Bookkeeping:**

```sql
-- core 0001_bookkeeping.sql (runs first; PRAGMA auto_vacuum=INCREMENTAL is issued before it)
CREATE TABLE _migrations (
    plugin     TEXT    NOT NULL,           -- 'core', 'identity', 'economy', ...
    version    INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,           -- sha256 of the sql text
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (plugin, version)
) STRICT;
```

- **Order.**
  1. `core` (events, artifacts).
  2. `identity`, then `config`: core plugins that always run.
  3. Feature plugins in topological order of `requires`, ties broken by plugin id.
  4. Within a plugin, by `version`. Each migration runs in its own `BEGIN IMMEDIATE` transaction together with its `_migrations` row, as today [read: `sqlite.ts:338-356`].
- **Refusals** (Core will not start):
  - A recorded version is missing from the code. This is kept from today [read: `sqlite.ts:333-337`].
  - A **checksum differs**, meaning someone edited a migration that already ran. This is new.
  - The file has `schema_version` but no `_migrations`, meaning it is the old database. Message: "archive it first" (§7).
- **Naming lint** in the runner: every `CREATE TABLE|INDEX|TRIGGER|VIEW` name in a plugin's SQL must start with `<plugin>_`. Core tables have no prefix. A plugin may declare foreign keys only to core and identity tables, never to another feature plugin. Cross-plugin reads go through the service registry, not SQL.
- **Installed versus enabled.** Migrations run for every plugin that is *installed* (registered in the build), enabled or not. Turning a plugin on at runtime then never runs DDL. A removed plugin's tables stay; `miyoria db doctor` lists orphans and `miyoria db drop-plugin <id>` drops them on request.
- **Handle.** `ctx.db` is a thin wrapper (`all / get / run / tx`, plus `events.appendNow` inside `tx`) on the single shared `DatabaseSync`. `tx` stays synchronous ("fn must not await") as today [read: `sqlite.ts:300-311`].
- **Tests.** `import { openTestDb } from "@miyoria/store/testing"` gives `openTestDb({ plugins: [economySchema], clock })`. It opens `:memory:`, applies core, identity and the listed schemas, runs seeds, and returns `{ db, events, identity }`. Today 27 test files open in-memory stores [read: `git grep`]. A shared contract test checks every registered schema:
  - It applies to an empty DB.
  - It re-runs as a no-op.
  - Its names pass the lint.
  - Its `forgetPerson` and wipe leave no row with that person.

### 3.2 Plugins and their tables in V5

Phase 1 moves existing tables (renamed, with `profile_id` dropped and keys changed from `(author_platform, author_id)` to `person_id`). Later phases add the rest.

| Plugin (package) | Phase 1 tables | Added later |
|---|---|---|
| **core** (`store`) | `_migrations`, `events`, `event_rollups`, `artifacts`, `artifact_blobs`, `artifact_shares` | Phase 3: optional `llm_prompt_blocks` (§2.6) |
| **identity** (new part, `access/identity` or `runtime/identity`) | `persons`, `accounts`, `link_codes`, `spaces`, `rooms`, `sessions`, `space_members` | Phase 6: second-platform fields if needed |
| **config** (`runtime/profile`) | `config_revisions`, `place_settings`, `plugin_state`, `config_persona_overrides` (from `persona_overrides`, 0 rows) | — |
| **auth** (`auth` → `access`) | `auth_roles`, `auth_assignments` (by `account_id`), `auth_role_mappings` (by `space_id`), `auth_overrides`, `auth_sessions` (from `panel_session:*`) | — |
| **directive** (`brain/directive`) | `directive_rules` | — |
| **memory** (`memory/memory`) | `memory_records`, `memory_fts`, `memory_vector_version` (moved as is) | Phase 3: `memory_notes` (L3 documents, replacing `knowledge:doc:*`), `memory_episodes` (L2), `memory_transcripts` (L1 per session, with compaction cursor), embeddings with model id and dimension. The schema is redesigned, so moving it in phase 1 is temporary |
| **heart** (`heart/*`) | none (`relationships` and deltas restart empty; until phase 4 the old modules write `heart_relationships` as a renamed copy) | Phase 4: `heart_person` (bond −100..1000, trust, familiarity, warmth, respect, ease, grudge, longing, rapport, text fields, `tier_floor`), `heart_self` (mood, drives) and **one `heart.changed` event per change** with `{field, delta, reason_quote, cause}` |
| **economy** (`economy`) | `economy_ledger` (from `coin_ledger`; the purse is a reserved `person_id` such as `self`), `economy_wallets`, `economy_fortunes`, `economy_bounties`, `economy_docs` (temporary) | Phase 5: drop deals, goals, pledges, commissions and the room docs (v5-play §4.2); add `economy_auction(_bids)`, `economy_lottery(_tickets)`, `economy_aquarium_fish`, per-person feed caps. **Exchange** (its own sub-schema `exchange`): `exchange_companies`, `exchange_ticks`, `exchange_orders`, `exchange_fills`, `exchange_positions` (with T+1 lots), `exchange_corp_actions`, and **`exchange_vault`**: a double-entry, append-only ledger. Buy settles into the vault; sell, dividends and delisting settle out of it; weekly burns. A CHECK-backed balance query makes "vault ≥ 0" a test. Fees and tax are separate burn rows in `economy_ledger` |
| **cards** (new, phase 5; absorbs `card-face`, member cards, collection) | none in phase 1 (`member_cards` restarts) | `cards_card` (serial, `person_id`, kind daily, image or keepsake, rarity, face text, `artifact_id`, cover and awakened flags), `cards_parts`, `cards_themes`, `cards_negatives` (底片 stock, `artifact_id`, status), `cards_pity`, `cards_dex`, `cards_reports`, `cards_gifts` |
| **queue** (`play/queue`) | `plugin_state` `queue:state` | Phase 6: `queue_items(space_id, …)` |
| **sing** | `plugin_state` setlist | `sing_jobs` if the job queue persists |
| **imagegen** (`workspace/imagegen`) | none (jobs are JSON sidecar files [read: `imagegen/src/service.ts:986`]) | Phase 5: `imagegen_jobs` |
| **platform-discord** (`discord`) | `discord_emoji(space_id, emoji_id, description)` | — |
| **mind, self, learning, arbiter, initiative, stage, live, party** | `plugin_state` only (blobs moved verbatim by key prefix) | Phase 3/4 rebuild them. Arbiter and initiative are deleted |

### 3.3 Why the ledger stays a table

Money needs a unique idempotency key per wallet, a balance check inside the posting transaction, and is never compacted; the vault needs double entry. These are integrity constraints on state, not an activity log. The ledger stays the economy plugin's table. Each posting also commits one `economy.posted` event (`tier=keep`) in the same transaction, carrying the ledger row id, amount and reason, so her inbox and the audit view see it. This is a deliberate exception to "one raw record" (decision D8).

### 3.4 Data categories

`store/src/data.ts` (1,022 lines) knows every package's tables and settings keys as strings [read: `data.ts:1-14`]. In V5 each schema declares its own `data` categories (inventory, export, wipe) and `forgetPerson`. The panel's data page and the factory reset iterate over registered schemas. `data.ts` shrinks to the registry plus the event-log category.

---

## 4. Identity and places

### 4.1 Tables

```sql
-- identity 0001
CREATE TABLE persons (
    id          TEXT    PRIMARY KEY,                 -- ULID; imported people keep their old id
    name        TEXT    NOT NULL,                    -- latest display name
    handle      TEXT    NOT NULL UNIQUE COLLATE NOCASE, -- stable name in prompts ('Owen', 'Owen#2')
    prefs       TEXT    NOT NULL DEFAULT '{}',       -- JSON: presence, dm, approach, voice_consent
    created_at  INTEGER NOT NULL,
    merged_into TEXT    REFERENCES persons (id),     -- set when absorbed; the row stays so ids resolve
    legacy      TEXT                                 -- JSON snapshot from the V4 import (keepsake), or NULL
) STRICT;

CREATE TABLE accounts (
    id           TEXT    PRIMARY KEY,                -- ULID
    platform     TEXT    NOT NULL,                   -- 'discord'
    external_id  TEXT    NOT NULL,                   -- snowflake
    person_id    TEXT    REFERENCES persons (id),    -- NULL: seen, not a person yet (future live-chat viewers)
    display_name TEXT    NOT NULL,
    is_self      INTEGER NOT NULL DEFAULT 0,         -- her own accounts
    first_seen   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL,
    linked_at    INTEGER,
    linked_by    TEXT CHECK (linked_by IN ('first_sight','code','owner','import')),
    UNIQUE (platform, external_id)
) STRICT;
CREATE INDEX accounts_person_idx ON accounts (person_id) WHERE person_id IS NOT NULL;

CREATE TABLE link_codes (                            -- one-time codes, stored hashed
    code_hash  TEXT    PRIMARY KEY,
    account_id TEXT    NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
) STRICT;

CREATE TABLE spaces (                                -- a guild or group
    id          TEXT    PRIMARY KEY,                 -- ULID
    platform    TEXT    NOT NULL,
    external_id TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    joined_at   INTEGER NOT NULL,
    left_at     INTEGER,
    UNIQUE (platform, external_id)
) STRICT;

CREATE TABLE rooms (                                 -- a channel, thread, voice room or DM
    id          TEXT    PRIMARY KEY,
    platform    TEXT    NOT NULL,
    external_id TEXT    NOT NULL,
    space_id    TEXT    REFERENCES spaces (id),      -- NULL for DMs
    parent_id   TEXT    REFERENCES rooms (id),       -- thread → its channel
    kind        TEXT    NOT NULL CHECK (kind IN ('text','voice','thread','forum','stage','dm')),
    name        TEXT,
    caps        TEXT    NOT NULL DEFAULT '{}',       -- JSON flags: text, voice, buttons, stickers, threads, attach_max_bytes
    dm_person   TEXT    REFERENCES persons (id),     -- the other side of a DM
    created_at  INTEGER NOT NULL,
    archived_at INTEGER,
    UNIQUE (platform, external_id)
) STRICT;
CREATE INDEX rooms_space_idx ON rooms (space_id);

CREATE TABLE sessions (                              -- her conversation context in one place
    key        TEXT    PRIMARY KEY,                  -- see below
    space_id   TEXT    REFERENCES spaces (id),
    room_id    TEXT    REFERENCES rooms (id),
    person_id  TEXT    REFERENCES persons (id),      -- DMs
    lane       TEXT    NOT NULL DEFAULT 'text' CHECK (lane IN ('text','voice','home')),
    created_at INTEGER NOT NULL,
    last_at    INTEGER NOT NULL
) STRICT;

CREATE TABLE space_members (                         -- needed for "Space members" artifact visibility (§5)
    space_id   TEXT    NOT NULL REFERENCES spaces (id),
    account_id TEXT    NOT NULL REFERENCES accounts (id),
    nick       TEXT,
    roles      TEXT    NOT NULL DEFAULT '[]',        -- platform role ids (auth maps them)
    joined_at  INTEGER,
    left_at    INTEGER,
    last_seen  INTEGER NOT NULL,
    PRIMARY KEY (space_id, account_id)
) STRICT;
```

**Session keys** (v5 §6):

| Place | Key |
|---|---|
| Room | `<platform>:<space ext>:<room ext>` |
| Thread | `<platform>:<space ext>:<parent ext>:<thread ext>` |
| Voice lane of a voice channel | `<platform>:<space ext>:voice:<room ext>`. This keeps today's `contextKeyString` voice infix [read: `types/src/platform.ts:37-48`]: on Discord a voice channel's text chat has the same id |
| DM | `<platform>:dm:<person ULID>`, not the DM channel id. A person with two accounts on one platform has one DM session; the session remembers the last account used, to reply through |
| Home | `home` |

Account links (v5 §6) need no separate history table. The current link is `accounts.person_id`. Every change is an `identity.linked` or `identity.merged` event (`tier=keep`, `scope=owner`).

### 4.2 Mapping from today

| Today [read] | V5 |
|---|---|
| `AccountRef {platform, id}` (`types/src/platform.ts:9-12`) | Stays as the code type. `identity.account(ref)` returns the row and `ref` = `(platform, external_id)`. Plugin tables store `person_id` (wallets, cards, heart) or `account_id` (auth assignments, membership) |
| `ContextKey {platform, scope, channel, kind}` (`platform.ts:29-35`) | Stays as a code type during migration. `identity.resolve(ctx, author?)` upserts the space and room and returns `{space_id, room_id, session}`. `kind: dm` → session by the author's person; `voice` → lane `voice`; `thread` → `parent_id` from the platform's thread event. Phase 6 replaces `ContextKey` in domain code with `SessionKey` |
| `people` (84) / `accounts` (84) | `persons` / `accounts` |
| `PeopleStore.upsertAccount` (creates a person on first sight) | Same rule, `linked_by='first_sight'`. A person is made for any account that speaks |
| `IdentityStore.linkAccount / mergePeople / createLinkCode / consumeLinkCode` | Same operations. Merge sets `merged_into` and calls each plugin's `mergePerson(keep, absorb)` hook (today only memory has one [read: `stores.ts:415`]). Codes are stored as sha256 |
| `handle:<platform>:<id>` in `_global` settings (152) | `persons.handle`, made from the first account's display name with a suffix on collision, as today [read: `handles.ts:1-9`] |
| `privacy:*`, `voice_consent:*` (8) | `persons.prefs` JSON. They are a person's own choices; defaults allow everything [read: `types/src/privacy.ts`] |
| `role_mappings(platform, guild, …)` | `auth_role_mappings(space_id, …)` |
| Memory `MemoryScope` with `guild`, `channel`, `dm(account)` | Phase 3: `space_id`, `room_id`, `dm(person)` |
| Event `person: Handle` | `events.person_id`; readers resolve the handle through identity |

### 4.3 What the import reads and writes

`miyoria db import-links --from data/archive/miyoria-v4-<date>.db [--dry-run]` opens the old file read-only. It is idempotent: it skips persons whose id already exists.

| Reads (old) | Rows [db] | Writes (new) |
|---|---:|---|
| `people (id, display_name, created_at)` | 84 | `persons` with **the same id**, `name`, `created_at` |
| `accounts (platform, account_id, person_id, display_name, first_seen, last_seen)` | 84 | `accounts` (new ULID, `linked_by='import'`) |
| `profile_settings` `_global` `handle:*` where `person` is set | 84 of 152 (67 have no person) [db] | `persons.handle`. The 67 person-less handles are skipped; they get handles when they speak |
| `profile_settings` `_global` `privacy:*`, `voice_consent:*` | 3 + 5 | `persons.prefs` (if D3 = yes) |
| For the keepsake: `min(accounts.first_seen)`, the `relationships` tier name at archive time, `count(member_cards)` | — | `persons.legacy` JSON `{first_seen, old_tier, cards}` (if D4 = yes). The phase-5 cards plugin issues the keepsake once per person with `legacy IS NOT NULL` and records `cards.keepsake_issued` |
| — | — | One `identity.imported` event per person (`tier=keep`, `scope=owner`) |

Not imported (owner decision §16 #3): bond, memories, coins, cards, events, decisions, settings blobs. Channel modes and module on/off flags are configuration: they come from `miyoria.toml` in the config import, not from the old DB.

---

## 5. Artifact store

Per v5 §11.2: one immutable piece of content plus a record. Content is stored by hash on Core's disk; shares are explicit, tokens are hashed, and visibility can never be wider than the place the artifact came from.

```sql
-- core 0003_artifacts.sql
CREATE TABLE artifact_blobs (
    sha256     TEXT    PRIMARY KEY,
    size       INTEGER NOT NULL,
    location   TEXT    NOT NULL DEFAULT 'local',     -- later 's3:<bucket>'
    stored_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE artifacts (
    id            TEXT    PRIMARY KEY,               -- ULID
    sha256        TEXT    NOT NULL REFERENCES artifact_blobs (sha256),
    mime          TEXT    NOT NULL,                  -- sniffed from content, never from the name
    filename      TEXT    NOT NULL,                  -- sanitised by code
    source        TEXT    NOT NULL CHECK (source IN ('imagegen','sandbox','cards','sing','clip','doc','render')),
    plugin        TEXT    NOT NULL,
    derived_from  TEXT    REFERENCES artifacts (id), -- the re-encoded / cleaned copy points at its original
    turn          TEXT,
    event_id      TEXT,                              -- the 'artifact.created' event
    made_for      TEXT    REFERENCES persons (id),
    origin_session TEXT,                             -- caps visibility (a DM-made artifact never becomes space-wide)
    origin_scope  TEXT    NOT NULL CHECK (origin_scope IN ('public','space','room','dm','self','owner')),
    space_id      TEXT    REFERENCES spaces (id),
    review        TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (review IN ('pending','passed','blocked','taken_down')),
    created_at    INTEGER NOT NULL,
    expires_at    INTEGER,                           -- default +7 days; NULL once kept (album / keep)
    kept_by       TEXT,                              -- 'album', 'person', 'owner', 'cards'
    deleted_at    INTEGER
) STRICT;
CREATE INDEX artifacts_person_idx  ON artifacts (made_for, created_at);
CREATE INDEX artifacts_space_idx   ON artifacts (space_id, created_at);
CREATE INDEX artifacts_expiry_idx  ON artifacts (expires_at) WHERE expires_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE artifact_shares (
    id          TEXT    PRIMARY KEY,
    artifact_id TEXT    NOT NULL REFERENCES artifacts (id),
    token_hash  TEXT    NOT NULL UNIQUE,             -- sha256 of a ≥128-bit token; the token is never stored
    audience    TEXT    NOT NULL CHECK (audience IN ('person','space','link')),
    person_id   TEXT    REFERENCES persons (id),
    space_id    TEXT    REFERENCES spaces (id),
    event_id    TEXT    NOT NULL,                    -- the 'share.created' event (who asked, which turn)
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER,
    revoked_at  INTEGER,
    downloads   INTEGER NOT NULL DEFAULT 0,
    last_download_at INTEGER
) STRICT;
```

Updating `downloads` is the one mutable counter. A per-download event would flood `events`, so only the first download per share is logged as `share.opened`.

**On disk.**
- Path: `data/artifacts/blobs/<aa>/<bb>/<sha256>` (two-level fan-out).
- Ingest: stream to `data/artifacts/tmp/<ulid>`, hash while writing, fsync, rename. If the blob exists, delete the temp file (deduplication).
- Remote hosts (sing, imagegen): Core pulls the file through hostd into `tmp/`, verifies the announced sha256, then commits. This replaces the shared-disk assumption.
- **The original is never served.** At the first share, the plugin makes a cleaned derivative (images re-encoded without EXIF and NSFW-checked; text secret-masked), and that derivative is what the share points at (`derived_from`).
- **GC** (daily):
  - Artifacts past `expires_at` get `deleted_at`, and their shares are revoked.
  - A blob with no live artifact for 24 hours is unlinked.
  - Quotas per person, Space and day are a `SUM(size)` query; no table.
- Lifecycle events: `artifact.created`, `share.created`, `share.revoked`, `artifact.taken_down`, all `tier=keep`.

---

## 6. Settings

| What | Where | Format | Why |
|---|---|---|---|
| **Cluster config** (one schema built from plugin schemas, v5 §5.6) | `config_revisions(version INTEGER PK, doc TEXT JSON, created_at, created_by, note)`; the current one is `max(version)` | JSON, validated by the combined zod schema | Versioned and diffable. Live reload is the next revision. `miyoria.toml` is imported once as revision 1 |
| **Host config** | `host.toml` on each host | File | Not Core's data (v5 §5.6) |
| **Secrets** | Files and environment on each host | — | Never in the DB |
| **Per-Space and per-Room overrides** | `place_settings` (below) | One JSON value per `(plugin, key)` | Resolved room → space → cluster → schema default. Covers talk level, enabled features and language per Room, and timezone, daily post (channel and on/off), shop, server goal, drop toggle and queue options per Space (v5 §6) |
| **Her own state** (mood, drives, current agenda) | Until phase 4: `plugin_state`. Phase 4: `heart_self` | JSON per plugin | One writer, read whole, shape changing quickly. Nothing filters on its fields |
| **Collections** (thoughts, docs, lessons, goals, digests, emoji descriptions, sessions) | Plugin tables | Rows | Grow without bound and are listed, filtered and deleted one by one. Today they are hundreds of keys under one prefix |
| **Person choices** (privacy, voice consent) | `persons.prefs` | JSON | Small, read whole, belong to the person |
| **Module on/off** (`module_state`, 45 rows) | The `enabled` flag in cluster config | — | One place for "is it on" |

```sql
-- config 0001
CREATE TABLE config_revisions (
    version    INTEGER PRIMARY KEY,
    doc        TEXT    NOT NULL,          -- whole cluster config, JSON
    created_at INTEGER NOT NULL,
    created_by TEXT    NOT NULL,          -- 'import', 'panel:<person>', 'cli'
    note       TEXT
) STRICT;

CREATE TABLE place_settings (
    scope      TEXT    NOT NULL CHECK (scope IN ('space','room')),
    scope_id   TEXT    NOT NULL,          -- spaces.id / rooms.id
    plugin     TEXT    NOT NULL,
    key        TEXT    NOT NULL,
    value      TEXT    NOT NULL,          -- JSON, validated by the plugin's zod on write
    updated_at INTEGER NOT NULL,
    updated_by TEXT    NOT NULL,
    PRIMARY KEY (scope, scope_id, plugin, key)
) STRICT;

CREATE TABLE plugin_state (               -- small singleton blobs only; collections need a table
    plugin     TEXT    NOT NULL,
    key        TEXT    NOT NULL,
    value      TEXT    NOT NULL,          -- JSON
    v          INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (plugin, key)
) STRICT;
```

**Rules for `plugin_state`:**
- Size: about 64 KB per value at most, enforced.
- No prefix scans for listing things: a key family that needs `list(prefix)` is a table.
- Each value is parsed with the owner's zod and `v`.

`SettingsStore` stays as an adapter over `plugin_state` during migration. Today about 62 source files use it [read: `git grep -c SettingsStore`]. Every `settings.changed` and `config.revised` change appends an event (`tier=keep`), so the panel's "who changed what" comes from the log.

---

## 7. The cut-over

1. **Ready.**
   - The V5 build passes typecheck and tests.
   - `miyoria db import-links --dry-run --from data/miyoria.db` against a **copy** of the live file prints the expected counts: 84 persons, 84 accounts, 84 handles, 8 prefs [db].
2. **Stop** Core (`miyoria down`, or stop the foreground process). Check that nothing holds the file.
3. **Archive.** Rename `data/miyoria.db`, `data/miyoria.db-wal` and `data/miyoria.db-shm` **together** to `data/archive/miyoria-v4-<date>.db{,-wal,-shm}`.
   - SQLite finds the WAL by name, so renaming all three keeps the un-checkpointed 4 MB intact. Renaming only `.db` would lose it.
   - Then make a single-file copy with `sqlite3 'file:...?mode=ro' "VACUUM INTO 'data/archive/miyoria-v4-<date>.single.db'"`.
   - Write `sha256sum` of both files to `data/archive/MANIFEST.txt`.
   - Delete nothing. `data/miyoria.db.before-song-perms` and `data/backups/` stay.
4. **Configure.** `store.url = "sqlite:data/core.db"`. A new filename means stale old code can never open the V5 file, and V5 refuses any file with `schema_version` (§3.1).
5. **First start** on the empty file:
   - Set the pragmas: `auto_vacuum=INCREMENTAL`, `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout`.
   - Run core migrations, then identity and config, then plugins.
   - Run seeds (built-in roles, owners from config).
   - Write `system.cluster_created` with versions and the plugin list.
   - Create the `home` session.
   - Import `miyoria.toml` as config revision 1. Channel modes go to `place_settings`, and the osu and threads disables become `enabled=false`.
6. **Import links:** `miyoria db import-links --from data/archive/miyoria-v4-<date>.single.db`.
7. **Smoke:**
   - Discord connects. The first message creates a space, a room and a session, and resolves to an imported person by `(discord, snowflake)`.
   - The panel shows the person list, the empty economy and the event stream.
8. **Side by side.** Do not run old and new against Discord at the same time: one self account would answer twice. The useful form is a **museum**: the `main` branch build pointed at a copy of the archived file with the Discord and voice modules off, so the owner can look at old data in the old panel. Optional; no new code.
9. **Rollback** (within the trial window, for example 3 days):
   1. Stop V5.
   2. Check out the last pre-V5 tag (tag it at step 2).
   3. Rename the three archived files back to `data/miyoria.db*`.
   4. Start.

   Anything V5 recorded stays in `data/core.db` (not merged back). Coins and cards earned in V5 during the trial are lost to V4. Say so when announcing the trial.
10. **After the window:** delete the V4-only code (B16: `core/src/modules.ts:203-215` `migrateStoredData` / `repairEphemeralHandles`, `heart/self/src/migrate.ts`, `memory/memory/scripts/rescope-self-notes.ts`, `adoptSqlxMigrations` [read: phase1-removals §6, §10]) together with the old migration files.

---

## 8. Order of work

The store keeps its current `Store` aggregate interface as an adapter until the last step, so callers move one package at a time and every step ends green. The new schema starts from version 1 for everything: V5 never migrates an old file (it starts empty), so no `ALTER` chain is needed.

| # | Step | Size | Leaves green because | Before phase 3? |
|---|---|---|---|---|
| 1 | Migration runner v2: `_migrations` with checksums, embedded TS migrations, `PluginSchema`, ordering, naming lint, `openTestDb`. Old migrations wrapped as one temporary schema `legacy` | S | Same tables, new bookkeeping | yes |
| 2 | Delete PostgreSQL: `postgres.ts`, `migrations/postgres`, `pg`, `deploy/docker-compose.yml` `postgres` service, the PG section of `behaviour.test.ts:2336`, CLI build copy, docs | S | PG tests were skipped without `pgUrl` [read] | yes |
| 3 | `events` table plus facts writing the new envelope (`type`, `session`, `person_id`, `scope`, `tier`, `turn`); `EventLogStore` over it; type registry with defaults; redaction trigger and `redact()`; tiered compaction | M | `EventLogKey` consumers use the facts interface; only filter field names change | yes |
| 4 | `identity` plugin: persons, accounts, link codes, spaces, rooms, sessions, members; resolver from `ContextKey`; `PeopleStore`, `IdentityStore` and `HandleDirectory` reimplemented over it; handles and prefs off settings | M | Adapters keep the old interfaces | yes |
| 5 | Chat events replace `message_log`: the platform plugin and delivery write `chat.*` and `voice.*`; `MessageLog` becomes a view adapter; "do not remember this" becomes `redact()` (exclusion list removed) | M | Six readers unchanged through the adapter | yes |
| 6 | `turn.decision` and `turn.outcome` replace `decision_log` and `turn_outcomes`; `audit.*` replaces `audit_log`; `recorder.ts` deleted | S–M | `DecisionLog` and `AuditLog` adapters over views | yes |
| 7 | `llm.call` events; cost and budget from events; `llm_usage:*` removed; JSONL unchanged | S | — | yes |
| 8 | `config` plugin: `config_revisions`, `place_settings`, `plugin_state`; `SettingsStore` adapter over `plugin_state`; `module_state` into config; one-off TOML import | M | Adapter | yes |
| 9a | Move stable plugin tables out of `store`: auth (+ `auth_sessions`), directive, persona overrides, economy (`person_id` wallets) | L (four sub-PRs, S–M each) | Each plugin owns its schema and implementation; `Store` loses those members | yes |
| 9b | Move memory (`memory_records`, FTS, vector) as is | M | — | yes (temporary; phase 3 redesigns it) |
| 10 | Artifact store: tables, blob layout, ingest, GC, share tokens (no public route yet) | M | New code, own tests | yes (needed in phase 3) |
| 11 | Data categories per schema; `data.ts` reduced to a registry; `forgetPerson` and `mergePerson` hooks | M | Panel data page and reset tests | yes |
| 12 | `miyoria db import-links`, `db archive`, `db doctor`, and the guard that refuses an old file; rehearsal on a copy | S | — | yes |
| 13 | **Cut-over** (§7) | S | — | yes, end of phase 1 |
| 14 | Delete adapters and `legacy`: the `Store` aggregate, `SettingsStore` key families, `profile_id`, B16 code | M | Last callers moved | Tail of phase 1, or as each package is rewritten |

**Wait for phase 3 (the brain):**
- L1 `memory_transcripts` and session compaction.
- The L2 and L3 schema and embeddings (with model and dimension per row).
- `mind:*`, `knowledge:*`, `reflect:*` and `conversation:state:*` as real tables. Moving them earlier would be thrown away.
- The Self loop's event types (tool call and result in the transcript, inbox items, `schedule`).
- `share()` on top of step 10.
- Phase 3 can **backfill** L2 and L3 from L0 `chat.*` events written since the cut-over. This is why chat is `tier=long`.

**Later phases:**
- Phase 4: `heart_person`, `heart_self`, `heart.changed` events.
- Phase 5: `cards_*`, the economy deletions and additions, `exchange_*` with the vault, `imagegen_jobs`.
- Phase 6: moving the singletons to `place_settings` or Space-keyed tables (song queue, daily post, timezone, shop, server goal), the second-platform contract, and `ContextKey` → `SessionKey` in domain code.

---

## 9. Risks

| # | Risk | Mitigation |
|---|---|---|
| R1 | `node:sqlite` is synchronous: a flush blocks the event loop, the voice path included [read: `facts/src/log.ts:38-43`] | Keep the 500 ms buffered writer and the flush histogram; transactional appends are small. Move the DB to a worker thread only if flush p99 exceeds about 20 ms |
| R2 | JSON-extracting views are slow for the panel's longer windows | Partial indexes on `(session, seq)`, `(person_id, type, at)`, `(type, seq)`. If a view is still hot, add a projection table maintained in the flush transaction. Do not denormalise speculatively |
| R3 | Churn: 128 source files and 97 test files import `@miyoria/store` [read: `git grep`] | Adapters (steps 3–9) and one package per PR |
| R4 | Redaction cannot reach every JSONL body | `forget me` rewrites files by turn id; single exclusions expire with `keep_days` (14). Documented in the privacy text |
| R5 | Cutting over before phase 3 resets memory again when phase 3 changes its schema | Phase 3 re-derives from L0 rather than migrating the phase-1 memory tables. Cost: a few weeks of extracted memories are rebuilt, not lost |
| R6 | A migration gets edited after it ran | Checksum refusal at start |
| R7 | Losing the WAL during the archive | Rename all three files, then `VACUUM INTO` a single-file copy; MANIFEST with hashes |

---

## 10. Decisions for the owner

| # | Decision | Recommendation |
|---|---|---|
| D1 | **One dialect** | **SQLite.** It is live, has the only event-log implementation, and Core is one process on one machine (v5 §5). What you lose: the compose `postgres` service and Docker-with-Postgres deployment (untested locally), pgvector search in the database (SQLite keeps vectors cached in memory, fine for tens of thousands; `sqlite-vec` can load later), several concurrent writer processes, `pg_dump`-style tooling (replaced by `VACUUM INTO` backups) |
| D2 | How long raw chat (L0) is kept | **365 days** (about 1.3 GB a year at today's rate). Ambient observations fold after 14 days; turn internals and LLM call metadata go after 90 days; audit, identity and money stay forever |
| D3 | Carry over people's privacy and voice-consent choices, besides account links | **Yes** (8 rows). Resetting them could DM or listen to someone who opted out |
| D4 | What the keepsake card shows | Store `{first_seen, old tier name, number of member cards}` at import, so phase 5 can print "since 2026-11-0x" without reopening the old file. Bond itself still restarts |
| D5 | When to cut over | **End of phase 1**, with phase 3 rebuilding memory from L0, rather than waiting for phase 3 |
| D6 | Drop `profile_id` (one database per character) | **Yes.** Every live row is `deepseek-chan` or `_global` [db] |
| D7 | LLM call bodies | **Stay in JSONL**; only metadata goes to `events`. Raise `keep_days` from 14 to 30 if replaying older incidents matters |
| D8 | Money ledgers (coins, the exchange vault) | **Plugin tables with their own constraints**, plus one `economy.posted` event per posting. A deliberate exception to "one raw record" |
