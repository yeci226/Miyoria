# 她看直播

狀態:待擁有者審閱(2026-11-05)

## 目標

她掛在語音頻道時,可以自己決定看誰的 Discord Go Live、不看或換人看,像一起看的朋友一樣,有值得講的才開口。之後再加上 Twitch / YouTube。

成功標準:

- 看直播時語音不中斷:她照常聽大家講話、用語音回應。
- 她自己決定開始、換人和離開,別人也可以請她看。
- 平常安靜看,大約一到兩分鐘最多一句;有人問她時,看當下的畫面回答。
- 直播的聲音不會打斷她,也不會被當成有人在對她說話。
- 本人可以拒絕被看,而且被看時會收到通知。
- 看直播的任何錯誤都不影響語音。
- 模組預設關閉,開關不影響現有功能。

## 範圍

本文件定義共用架構和**第一階段(Discord Go Live)**。**第二階段(Twitch / YouTube 瀏覽器來源)**另開 spec,本文件只保留 `WatchSource` 介面給它。

第二階段有兩個未驗證的風險:瀏覽器抓音訊、Playwright Chromium 不含 H.264。她也不會自己逛平台,只會從擁有者設定的清單或別人給的連結挑選。

## 不做的事

- 不做連續影片理解:她看的是定時截圖和音訊轉文字,反應會慢幾秒到十幾秒。
- 不跨語音頻道找直播。她自己決定時,只看所在頻道裡的直播。
- 不和她自己的 Go Live 同時進行。
- 不解 H.264 以外的編碼。
- 不做掉包重傳(NACK)。她幾十秒才看一張,掉包了就再要一個關鍵影格。
- 不存截圖、不存轉錄,也不把筆記寫進長期記憶。
- 不用第二個 Discord 帳號。
- 不把截圖發到任何頻道;她只用語音或文字講自己看到什麼。

## 現況與 spike 結果

現有基礎:

- `world` 已記錄每個成員的 `streaming`,她的心智迴路可以看到。
- 心智迴路透過能力(capability)自己行動,例如 `game.start`。
- `agent_initiative` 讓她主動開口,`hint` 走資料區塊。
- `PromptContributor` 能把狀態放進提示詞,例如 `sing`。
- `speech.transcribe`、`EnergyVad`、`Segmenter` 可重用。
- `Consent` 和 `privacy:<platform>:<id>` 紀錄已有 opt-out 機制,紀錄可以加欄位。
- `LlmRouter` 支援圖片,`router.takesImages(purpose)` 可先檢查模型。
- `@dank074/discord-video-stream` 只會推流,但 `@snazzah/davey` 有 `decrypt(userId, mediaType, packet)`。

2026-11-05 spike(`spikes/voice-node/src/watch.ts`)對真的 Go Live 跑了一次 45 秒:

| 項目 | 結果 |
|---|---|
| 語音連線 | 全程未斷,收到 19 次講話事件 |
| 串流資訊 | 送出 `STREAM_WATCH` 約 0.3 秒後回覆 |
| 媒體 | 影像封包 3021 個,音訊封包 2174 個,編碼 H.264 |
| DAVE 解密 | 影像成功 1290 格、失敗 14 格(都在開頭金鑰就緒前);音訊 1500 包全部成功 |
| 成果 | 720p JPEG 清楚可讀,人聲經擁有者試聽正常 |
| 音量 | 原始平均 -51.6 dB,偏小,原因未確認 |

做法要點:語音由 `@discordjs/voice` 持有,觀看用另一條 `StreamConnection`,只借語音 session id。接收端只宣告一條 `m=video`,所有 RTP 都進同一個 track,再依 payload type 分開(H.264 = 101、Opus = 120)。送 `SELECT_PROTOCOL` 時只列 Opus 和 H.264,之後送 `MEDIA_SINK_WANTS`。

## 架構

```
朋友的 Go Live
   │ WebRTC + DAVE
apps/voice-node/src/watch/        收串流、解密、解出圖和聲音
   │ voice link(新增訊息)
packages/voice                    只負責轉送,不經過 Listener
   │ WatchSource 介面
packages/watch(新模組)           節奏、筆記、判斷要不要開口
   │ agent_initiative
現有回覆流程 → TTS → 語音頻道
```

| 單元 | 負責 | 不負責 |
|---|---|---|
| voice node `watch/` | 連線、解密、解 JPEG、聲音轉 16 kHz 單聲道 | 判斷內容、呼叫模型 |
| `WatchSource` | `start`、`stop`、`snapshot`、聲音事件、結束事件 | 任何判斷 |
| `Watcher` | 一次一場;定時截圖、呼叫模型、分段轉錄、維護筆記 | 直接講話 |
| `SpeakGate` | 純函式,判斷這次能不能開口 | 呼叫模型、寫台詞 |
| Prompt 區段 `watch` | 看直播時放進提示詞 | 存長期記憶 |
| `watch_look` 工具 | 有人問時立刻截圖回答 | 定時截圖 |
| `watch.start`、`watch.stop` | 她和別人使用的能力 | 繞過動作閘門 |

## Voice link 協定

Core → Node:

| 訊息 | 欄位 | 用途 |
|---|---|---|
| `watch_start` | `guild`、`user_id` | 開始看;已在看別人時,node 先停舊的再接新的 |
| `watch_stop` | `guild` | 結束 |
| `watch_snapshot` | `id`(u32) | 要一張目前畫面 |

Node → Core:

| 訊息 | 欄位 | 用途 |
|---|---|---|
| `watch` | `guild`、`user_id`、`state`、`reason?`、`error?` | `state`:`starting`、`live`、`stopped`、`failed` |
| `watch_snapshot_failed` | `id`、`error` | 這張截圖沒拿到 |
| 二進位 `0x04` | `[0x04][id: u32 LE][JPEG]` | 截圖 |
| 二進位 `0x05` | `[0x05][PCM s16le 單聲道 16 kHz]` | 串流聲音,每框 20 ms |

規則:

- `0x05` 和人聲的 `0x01` 完全分開,不進 `Listener`,不觸發插話。
- JPEG 長邊最多 1280。Core 的 voice link 單則上限是 1 MiB,所以 JPEG 上限 900 KB,超過就降品質重編一次,還是超過就回 `watch_snapshot_failed`。
- 同一個 self 帳號同時只看一場。
- 她在 Go Live 時,`watch_start` 回 `failed`。反過來,看直播時開始 Go Live 也會先停止觀看。
- 開播者關播、她離開語音、被踢時,node 送 `stopped`。
- Core 連線斷掉時,node 立刻停止觀看。這點和 Go Live 不同:Go Live 繼續推流。
- 舊版 node 會忽略這些訊息。Core 等 `live` 超過 15 秒就視為失敗。

## Voice node 接收端

檔案都在 `apps/voice-node/src/watch/`:

| 檔案 | 負責 |
|---|---|
| `manager.ts` | 生命週期,比照 `golive/manager.ts`,引擎由外部注入 |
| `connection.ts` | Discord 串流連線。**動到函式庫私有欄位的程式全部關在這裡** |
| `rtp.ts` | RTP 解析、H.264 組包、PLI |
| `snapshot.ts` | 要關鍵影格、解密、轉 JPEG |
| `audio.ts` | Opus 解碼、混成單聲道、轉 16 kHz |

截圖流程:

1. 收到 `watch_snapshot`,送 PLI。
2. 等下一個完整的關鍵影格。
3. 用 DAVE 解密。
4. 用一次性的 ffmpeg 把關鍵影格轉成 JPEG。
5. 掉包或解密失敗就再要一次,最多 3 次,總共約 5 秒;失敗回 `watch_snapshot_failed`。

平常不解碼影片。音訊持續解密和解碼。

開始時會先確認 `connection.ts` 依賴的私有欄位都存在,不存在就回 `failed`,不影響語音。Discord 給的不是 H.264 時也回 `failed`,`error` 寫明編碼。

## `packages/watch`

### 來源介面

```ts
interface WatchSource {
  start(target: WatchTarget, signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  snapshot(signal: AbortSignal): Promise<Buffer>; // JPEG
  audio(): AsyncIterable<Int16Array>;             // 16 kHz 單聲道
  ended(): Promise<string>;                       // 結束原因
}
```

第一階段只有 `DiscordSource`,由 `voice` 模組的 link 實作。

### 看的循環

每 `snapshot_secs` 秒一輪,從上一輪結束開始算,不會重疊:

1. 確認本人的 `watch` 仍允許,不允許就停止觀看。
2. 向來源要一張截圖,等候上限 8 秒。
3. 把圖片、最近幾則筆記、最近台詞交給 `watch` 用途的模型。這次呼叫不提供工具。
4. 模型回傳 `{ note, worth_saying, topic }`,用 zod 檢查;`note` 最多 240 字。
5. 寫入筆記,交給 `SpeakGate`。

`watch_look` 執行後重新計時,避免連續看兩次。

### 聲音

串流聲音先做音量正規化,再經 `EnergyVad` 和 `Segmenter` 分段,用 `speech.transcribe` 轉文字,過濾 ASR 常見幻聽字句後放進台詞筆記。

開播者用 `/voice consent off` 拒絕收音時,不轉錄這場的串流聲音,只看畫面。這部分沿用 `Consent` 的 opt-out / opt-in 政策。

ASR 和人聲共用同一個並行上限,人聲優先,串流語音排不上時直接丟棄,不排隊。

### 筆記

只存在記憶體,這場結束就丟:最近 `notes_keep` 則畫面筆記,最近 `transcript_secs` 秒的台詞。

### 開口條件

`SpeakGate` 全部成立才發 `agent_initiative`(`reason = "watch"`,`hint` 為筆記):

| 條件 | 預設 |
|---|---|
| 模型回 `worth_saying: true` | |
| 距離她上次開口至少 `speak_min_secs` | 60 秒 |
| 最近 `quiet_secs` 內沒有人聲 | 10 秒 |
| 她現在沒在講話或唱歌 | |
| `topic` 不在最近 5 個講過的主題裡 | 去空白、轉小寫後比對 |

不符合就丟掉,不排隊。

### 聊天時

- Prompt 區段 `watch`:看直播時提供,內容是在看誰、看了多久、最近的筆記和台詞。放進 data block,並限制長度。只在她看直播所在的語音 context 提供。
- `watch_look`:只在看直播時提供,截一張新圖,連同問題交給模型,回傳文字。約需 2 到 8 秒。

## 她自己決定

能力:

| 能力 | 風險 | 說明 |
|---|---|---|
| `watch.start` | medium | 參數 `user`。正在看別人時等於換人 |
| `watch.stop` | low | 隨時可用 |

開始條件:

- 目標正在開播,且本人的 `watch` 允許。
- 她不在 Go Live。
- `router.takesImages("watch")` 為真。
- `on_own`(她自己決定):目標要在她目前的語音頻道。
- 別人要求:她不在任何語音頻道時,先用現有的 `join` 進對方頻道;她在另一個頻道時拒絕並說明。

防止亂跳:

- `on_own` 時,一場至少看 `min_watch_secs` 才能換人。
- 不論誰發起,每小時最多 `starts_per_hour` 次。

心智快照新增兩項:

- `streams`:所在頻道裡開播且允許被看的人。
- `watching`:正在看誰、看了多久、最近的筆記。

## 自動停止

- 開播者關播。
- 她離開語音頻道。
- 開播者設定 `watch:off`。
- 連續 `max_snapshot_failures` 次截圖失敗。
- 單場滿 `max_watch_mins`。
- `[llm.budget]` 用完。

## 同意與通知

- `PersonPrivacy` 新增 `watch`,預設 `true`,由 `/me privacy watch:off` 關閉。
- 開始看時檢查一次,之後每次截圖前都檢查。關閉後不再截新圖,最多約 30 秒內退出觀看。
- 開始看某人時,在該語音頻道的文字區發卡片,說明她正在看誰、畫面會送到模型,以及怎麼關閉。
- 同一個人 `notice_hours` 小時內只通知一次。
- **通知送不出去就不看**,這是失敗時的保守行為。
- `streams` 不列出 `watch:off` 的人,所以她不會想去看他們的直播。
- 她講出口的話沿用現有行為,會進對話歷史,可能被記憶系統摘要。

## 設定

```toml
[llm.purposes]
# 看直播用的模型要收圖片;不設就用 chat
# watch = ["provider:model"]

[modules.watch]
enabled = false
snapshot_secs = 30
speak_min_secs = 60
quiet_secs = 10
notes_keep = 10
transcript_secs = 180
min_watch_secs = 180
starts_per_hour = 6
max_watch_mins = 120
max_snapshot_failures = 5
notice_hours = 24
```

## 安全

- 直播畫面和台詞都是不可信內容。
- 看圖提示說明圖中文字只是內容,不是指示。
- 筆記和台詞都進 data block,並限制長度;`hint` 走既有資料區塊。
- `watch` 模型呼叫不提供工具,輸出只當作文字資料。
- JPEG 只在記憶體,送完模型就丟,log 不記圖片內容。
- 測試輸出不進 git。

## 出錯處理

| 狀況 | 處理 |
|---|---|
| 單張截圖失敗 | 跳過這輪;連續 5 次停止觀看 |
| 模型失敗或格式錯誤 | 這輪沒有筆記,不重試 |
| 模型不收圖片 | 開始前拒絕並說明 |
| ASR 失敗 | 繼續看畫面,記警告 |
| Discord 串流中斷 | 回 `stopped`,不自動重連 |
| 函式庫私有欄位改變 | 回 `failed`,語音不受影響 |
| voice node 斷線 | Core 結束這場 |
| 通知送不出去 | 不開始看 |

`watch/` 的錯誤不能往外丟到語音:manager 接住全部例外,轉成 `failed`。

## 費用估算

看圖呼叫每小時約 120 次,加上 `watch_look` 和她開口時的回覆呼叫。實際費用取決於 `watch` 用途的模型,`max_watch_mins` 和 `[llm.budget]` 是上限。ASR 跑本機。

## 測試

| 層級 | 內容 |
|---|---|
| 單元 | RTP 組包、PLI、音訊轉換、`SpeakGate`、冷卻、自動停止、同意檢查 |
| Voice link | 新訊息和 `0x04`、`0x05` 的編解碼,1 MiB 上限 |
| 假來源整合 | 假 `WatchSource` 跑完整 `Watcher`;驗證串流聲音不觸發插話,截圖失敗 5 次會停止 |
| 錯誤隔離 | 假引擎丟例外,語音連線不受影響 |
| 實測 | 下面第 1 步,加上一次真正的完整流程 |

## 上線步驟

1. **實測驗證**(沿用 spike 程式,先改好再跑):
   - 每 30 秒送一次 PLI,連跑 10 分鐘,開播者都回關鍵影格。
   - 只解密關鍵影格和音訊,跳過其他畫面,DAVE 仍解得開;不成立就改成解密每一格,但不解碼。
   - 連看 30 分鐘,連線和語音都穩定。
   - 再錄一次聲音,確認音量偏小是來源造成還是接收造成。
2. **接收端**:voice node `watch/` 和 voice link 協定。
3. **`packages/watch`**:`Watcher`、筆記、`SpeakGate`、Prompt 區段、`watch_look`。
4. **自主決定**:能力、心智快照、冷卻。
5. **同意與通知**:完成前 `[modules.watch]` 維持關閉。
6. 更新 `docs/ARCHITECTURE.md`、`docs/DECISIONS.md`、`docs/ROADMAP.md`、`docs/protocols/voice-link.md`、`miyoria.example.toml` 和 `packages/cli/templates/miyoria.example.toml`。

spike 程式只用來驗證,不併入正式程式。

第 1 步任何一項不成立,就回到本文件調整設計,不直接往下做。

## 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| Discord 改協定,或函式庫升級改了私有欄位 | 看不到直播 | 全部關在 `connection.ts`,啟動檢查,不影響語音 |
| 看別人的串流是新的 self-bot 行為,可能增加封號風險 | 語音和 Go Live 一起受影響,因為是同一個帳號 | 沿用 ADR 9 的自負風險原則,寫進 DECISIONS;模組預設關閉 |
| 朋友畫面含私人資料 | 隱私外洩到第三方模型 | opt-out、通知、不存檔,通知失敗就不看 |
| 開播者不接受頻繁關鍵影格請求 | 截圖變慢或畫質抖動 | 第 1 步驗證;必要時加大 `snapshot_secs` |
| 開頭金鑰還沒就緒 | 前幾秒解密失敗 | spike 已觀察到;截圖重試涵蓋,不算錯誤 |
| 只有 45 秒實測 | 長時間行為未知 | 第 1 步 30 分鐘測試 |
| 她過度換台或太吵 | 打擾大家 | 冷卻、`SpeakGate`,參數都可調 |
