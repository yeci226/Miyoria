# 她滑 Threads 並分享到文字頻道

狀態:待擁有者審閱(2026-11-04)

## 目標

她平常閒著時自己滑 Threads,看到有想法、又對某個群體胃口的貼文,就把貼文截圖和她的評語發到 Discord 文字頻道。

成功標準:

- 不需要直播,也不需要她在語音裡;Mac 開著就能運作。
- 發文的是她本人,她記得自己發過什麼,別人回她時接得上話。
- 沒有對到該群體興趣的貼文不發,寧可少發。
- 可以關閉,也可以設定頻率和頻道;每月多花的 token 費用維持在個位數美分到幾十美分。

## 不做的事

- 不在 Threads 上按讚、留言、發文或追蹤,沿用外掛「只看不碰」的原則。
- 不自動註冊或登入帳號,也不處理帳號密碼。
- 不改主分支的直播玩法;外掛預設行為維持不變。
- 第一版不統計讚數或回覆率;興趣判斷只靠現有的記憶和對話筆記。

## 主分支現況

`extensions/threads` 已能開 Chromium、讀貼文、截圖,並可選用看圖模型描述圖片。它是一款「遊戲」:每一步都問模型一次,感想走語音,截圖只給看圖模型。

缺口:

- `OutgoingMessage` 只有文字,`PlatformSink.send` 不能附圖。
- `ThreadsBrowser` 固定開視窗(`headless: false`),預設資料夾和 OBS 流程都是給直播機用的。
- 外掛不能呼叫模型、查記憶或發訊息;這些都在 Core。

## 架構

分成三塊,外掛只負責瀏覽器,判斷和發文都在 Core:

| 單元 | 職責 | 位置 |
|---|---|---|
| `threads` 外掛 | 開關瀏覽器、讀貼文、截圖、看圖描述 | `extensions/threads`(擴充) |
| `share` 模組 | 上限檢查、挑候選、比對、寫評語、發文、失敗處理 | `packages/share`(新增) |
| 附圖發送 | 讓她的訊息可以帶圖片 | `packages/types`、`packages/discord` |

外掛不需要新的 RPC:Core 用現有的方式呼叫外掛註冊的工具,和 `@miyoria/game` 呼叫 `game_<id>_observe` 相同。名稱以 `internal.` 開頭的工具不提供給模型:`ToolRegistry.specs()` 不列出,agent 回合也不接受呼叫。

### 外掛新增

- 工具 `internal.threads.feed`:開瀏覽器(若還沒開),讀目前動態,回傳 JSON:最多 `posts` 則貼文的 `id`、作者、文字、連結、圖片數、時間,以及 `logged_in`。
- 工具 `internal.threads.capture {link}`:回傳該則貼文的 JPEG(base64)和圖片描述。沒有看圖模型或描述失敗時,`description` 為 `null`。
- 工具 `internal.threads.close`:關閉瀏覽器。
- 設定 `headless`(預設 `false`):Mac 設 `true`。
- 設定 `game`(預設 `true`):`false` 時不註冊遊戲 adapter,Mac 設 `false`,避免她改走逐則問模型的遊戲流程。
- `pnpm login`:用同一個資料夾開有視窗的瀏覽器,讓擁有者手動登入。
- 回傳前只做程式過濾:去掉已看過、廣告標記、文字太短的貼文。已看過的 `id` 存在外掛儲存區,最多保留 500 筆。

單次工具呼叫受 `call_timeout_ms`(預設 30 秒)限制,`internal.threads.feed` 要在 25 秒內結束,時間到就回傳已讀到的貼文。

### `share` 模組

提供能力 `share.browse`(`risk = "medium"`),掛在 `SOLO` 選單,說明是「去滑一下 Threads,看到想分享的就發」。她閒著時由心智迴圈決定要不要做。

新增 `Capability.available?(): boolean`(選填)。`capabilityInfo` 略過回傳 `false` 的能力,所以達到上限或在安靜時段時,心智迴圈看不到這個選項,也不會為它花 token。`game = false` 時,`SOLO` 的 `game.start` 說明也不提 Threads。

### 附圖發送

`OutgoingMessage` 新增選填欄位:

```ts
files?: { name: string; path: string; contentType: string }[];
mentions?: boolean; // false = 不解析任何提及
```

Discord sink 把第一個訊息片段連同檔案一起送出。圖片放在暫存檔,`path` 只留路徑,所以圖片內容不會進入動作紀錄。平台不支援時回報發送失敗,不會默默丟掉圖片。`share` 直接呼叫 sink 發送,才拿得到失敗結果。她的訊息會經 gateway 回到 `platform.message.created`,照常進入對話紀錄和記憶。`share` 發的訊息帶 `mentions: false`,讓 sink 用 `allowed_mentions: { parse: [] }`,因此連使用者都不會被標到。

## 流程

```text
share.browse
  1. 再檢查一次上限、安靜時段
  2. internal.threads.feed:讀貼文(不花 token)
  3. 挑候選:帶人設,一次送出整批貼文,選 0~2 則
  4. 記憶搜尋:每個可發頻道用候選文字搜尋,取前 3 個
  5. internal.threads.capture:只處理入選貼文
  6. 比對+寫評語:帶人設、頻道記憶和對話筆記,一次決定
  7. 程式再驗證後發送
  8. internal.threads.close
```

第 3 步用 `chat` 用途,第 6 步也用 `chat`。貼文、圖片描述和留言一律放在資料區塊,裡面的指令不照做。

第 6 步輸出 `{ action: "post" | "skip", post, channel, comment }`,`channel` 必須是第 4 步給的候選之一,否則當作 `skip`。

頻道範圍:

- 只考慮有文字頻道且她能發言的頻道,不含私訊和語音頻道的文字區。
- `channels` 非空時只用這份清單,否則她從最近有活動、或她有對話筆記的頻道中挑,不要求現在有人在聊。
- `exclude` 永遠排除。
- 記憶只用該頻道的 `visibleScopes`,不帶任何在場人物,所以別的伺服器或私訊的記憶不會進入判斷。
- 第 4 步沒有任何記憶或筆記對到時,直接結束,不進第 5、6 步。

`when`:

- `anytime`(預設):第 6 步選 `post` 就發。
- `active`:候選在滑的時候先截圖,留到有頻道正在聊天才進第 4、6 步,超過 `keep_hours` 就丟棄。候選和截圖存放在 `data/threads-share/`,丟棄時一併刪除。

## 設定

上限在 Core 強制,所以放在模組設定,不放在外掛設定。`[modules.share]` 預設不啟用,不影響主分支行為:

```toml
[modules.share]
enabled = false
when = "anytime"         # anytime | active
max_per_day = 3          # 一天最多發幾則
min_gap_mins = 120       # 兩則至少隔多久
browse_per_day = 6       # 一天最多滑幾輪
posts = 10               # 一輪最多看幾則
quiet_hours = "01:00-08:00"  # 這段時間不滑也不發,空字串 = 關閉
channels = []            # 空 = 她自己挑
exclude = []             # 永遠不發
keep_hours = 24          # active 模式下候選留多久
```

`[extensions."miyoria.threads"]` 新增 `headless`、`game`,其他沿用現有設定。時間一律以 Core 所在機器的本地時區計算,一天從 00:00 起算。

## 安全

判斷不確定時一律不發。

- 色情、血腥、仇恨、霸凌、個資不發,不分是否直播。第 3 步和第 6 步的指示都寫明這條。
- 貼文有圖但 `description` 為 `null`:跳過,不發沒看過的圖。
- 截圖只裁切貼文區塊,不含側欄和她的帳號畫面。
- 訊息附原文連結,用 `<網址>` 關閉預覽。
- `filterOutgoing` 照常套用,並完全不解析提及。
- 她的帳號只追蹤公開帳號,因為程式無法可靠辨識私人貼文。

每日上限、間隔、安靜時段、黑白名單和禁發私訊都在 `share` 模組的程式裡檢查,模型無法繞過。第 7 步發送前會再驗證一次頻道。

## 出錯處理

| 情況 | 處理 |
|---|---|
| `logged_in = false` 或要驗證 | `share.browse` 暫停,私訊 `owners` 一次,每 6 小時檢查一次(不花 token),登入回來就恢復 |
| 讀不到貼文 | 結束這輪,不呼叫模型,記 warning;連續 3 輪時視同暫停並通知 |
| 瀏覽器當掉或逾時 | `threads.close`,結束這輪,計入滑的次數 |
| 模型失敗或輸出不合格式 | 結束這輪,不重試 |
| 發送失敗 | 不計入發文上限,記 warning,不換頻道重試 |
| 外掛沒啟動 | `available()` 回傳 `false` |
| Core 重啟 | 當日次數、最後發文時間、暫停狀態存在 settings store;外掛存已看過的貼文 |

## 費用估算

以目前每次呼叫約 4,500 token、$0.0008 推算。假設一天滑 6 輪、比對 4 次、發 3 則,挑候選和比對每次約 5,000 token:每天約 5 萬 token,每月約 $0.3。尚未實測,也不含看圖模型。

模組用獨立的 LLM 標籤記錄,可以在用量統計裡看到實際費用。

## 測試

- `share`:上限、間隔、跨日、安靜時段、黑白名單、禁發私訊、暫停與恢復、`active` 過期;模型和外掛工具用假物件。
- 外掛:`threads.feed` 的過濾與已看過紀錄、`threads.capture` 無描述時的回傳、`game = false` 不註冊 adapter;瀏覽器用現有的假 `Browser`。
- Discord:帶檔案的訊息送出時不解析提及,分段時圖片只在第一段。
- 安全:貼文內含指令時停留在資料區塊;有圖無描述不發。
- 實機:Mac 上 headless 跑一輪真實帳號,確認截圖內容正確,訊息進入她的對話紀錄。

## 上線步驟

1. Mac:`pnpm --filter @miyoria/sdk build`,在 `extensions/threads` 執行 `pnpm browser` 和 `pnpm build`。
2. 擁有者用螢幕共用在 Mac 上執行 `pnpm login`,手動登入她的帳號。
3. `miyoria.toml`:Threads 外掛 `enabled = true`、`headless = true`、`game = false`,`[modules.share]` 先把 `channels` 設成測試頻道。
4. 確認一輪成功後,再清空 `channels` 開放她自己挑。

## 風險

- Meta 可能判定為自動化並要求驗證或限制帳號,所以用她的專屬帳號,頻率也壓低。
- Threads 改版可能讓 DOM 解析失效,此時依「讀不到貼文」處理,不會亂發。
- headless 模式和 pm2 背景工作階段下的 Chromium 行為、螢幕共用登入都還沒實測,要在實作初期先驗證。若 headless 被擋,改用有視窗模式放在 Mac 桌面。
