# @miyoria/voice-node

Miyoria 的 **self 帳號語音節點**:用一個 Discord 使用者帳號(專用小帳號)進語音頻道,把每個人的聲音即時送給 Core,再把 Core 產生的 TTS 音訊播進頻道。

> ⚠️ **Self-bot 違反 Discord 服務條款,帳號可能被封**,而且 Discord 改協定時 self-bot 函式庫常常會壞。這是擁有者明確選擇承擔的風險(ARCHITECTURE §11.2)。**只用專用的小帳號,不要用主帳號。**這個節點是可以隨時拔掉的獨立程式,壞掉時 Core 的其他功能(官方 bot 的文字、指令)照常運作。

## 它在整個系統裡的位置

```
Discord 語音 ⇄ (self 帳號) ⇄ voice-node ⇄ Voice Link(WebSocket) ⇄ Core(voice.link 模組)
                                                                        └─ ASR → agent → TTS
官方 bot 帳號 ⇄ Core(文字、slash commands)      ← 這個節點完全不碰
```

- **官方 bot 帳號**負責文字與指令;**這個 self 帳號只做語音**:進出頻道、每人分開收音、播放 TTS。它**不發任何文字訊息、不回指令**。
- 節點**主動連到 Core**(`ws://<core>:7879/voice-link`),所以直播機在 NAT 後面也沒問題。協定細節見 [`docs/protocols/voice-link.md`](../../docs/protocols/voice-link.md)(本節點實作 node 端)。
- 節點本身**不存任何狀態**:要進哪個頻道、要不要錄、誰同意被收音,全部由 Core 決定。節點會把「聽到的所有人」都送出去(只跳過自己和 bot),**同意過濾在 Core 做**。
- 音訊格式:收音是 **16 kHz 單聲道 s16le**(每 20 ms 一個 640 bytes 的訊框);播放時 Core 給任意取樣率的單聲道 PCM,節點負責轉成 Discord 要的 48 kHz 立體聲。

## 需求

- Node ≥ 22.4(開發用 24)、pnpm 9
- 語音(Opus 編解碼)不需要 ffmpeg:用純 WASM 的 `opusscript`,之後要省 CPU 可換 `@discordjs/opus`。**Go Live 要 ffmpeg 在 PATH 上**(`golive/encoder.ts` 用 `ffmpeg` 探測編碼器、做編碼和轉送)
- Discord 語音會走 DAVE(端對端加密),由 `@discordjs/voice` + `@snazzah/davey` 處理;`pnpm report` 可以看依賴是否齊全

## 安裝與執行

```bash
pnpm install                      # 在 repo 根目錄:voice node 是 pnpm workspace 的一員
cd apps/voice-node
cp .env.example .env              # 然後填 SELF_TOKEN 等
pnpm typecheck
pnpm test
pnpm start                        # tsx 直接跑 src/main.ts(--conditions=@miyoria/source:workspace 套件用原始碼)
```

協定的訊息定義在 workspace 套件 `@miyoria/contracts/voice-link`。`pnpm start`、`pnpm dev`、`pnpm test`、`pnpm typecheck` 直接讀它的原始碼,不用先編譯。

也可以編譯後執行(`dist/` 用的是 `@miyoria/contracts` 編譯好的 `dist/`,所以要連它一起編):

```bash
pnpm --filter "@miyoria/voice-node..." build   # 先編 @miyoria/contracts,再 tsc → dist/
pnpm start:dist                   # node dist/main.js
```

### 用 hostd 跑(平常的做法)

```bash
miyoria add voice-node                  # 在 repository 裡;列出還要自己處理的事
miyoria up voice-node                   # hostd 用 `pnpm start` 在這個資料夾跑它,在 Core 之後啟動
```

- `SELF_TOKEN` 永遠寫在 `apps/voice-node/.env`,hostd 不給。
- **已經加入 Core 的電腦**(包括 `miyoria up` 自動連上本機 Core 的那台):`VOICE_LINK_URL` 和 `VOICE_LINK_TOKEN` 由 hostd 給(Core 把 voice link 的位址和 token 交給它),`.env` 裡不用填。hostd 給了值,`.env` 裡的同名變數不再用;Core 還沒送來、或這台沒有加入時,這兩個變數不會設,node 照舊讀自己的 `.env`。
- 她在唱歌或直播時,`miyoria restart voice-node`、`down`、`update` 會拒絕重啟它(`--force` 才行)。

`Ctrl+C`(SIGINT / SIGTERM)會:離開所有語音頻道 → 告訴 Core(`left`)→ 關掉 WebSocket → 登出 Discord。再按一次 `Ctrl+C` 直接強制結束。

## 設定(環境變數或 `.env`)

| 變數 | 預設 | 說明 |
|---|---|---|
| `SELF_TOKEN` | (必填) | self 帳號(專用小帳號)的 user token。**只放在本機 `.env`,不要 commit、不要貼到任何地方**。`.env` 已被 `.gitignore` 排除。 |
| `VOICE_LINK_URL` | `ws://127.0.0.1:7879/voice-link` | Core 的 voice.link 位址(對應 Core 設定的 `[modules."voice.link"] bind`)。已加入 Core 的電腦由 hostd 給,不用填;手動跑或沒加入時才寫。 |
| `VOICE_LINK_TOKEN` | (空) | 跟 Core 約好的共用 token,hello 時送出。已加入 Core 的電腦由 hostd 給,不用填;手動跑或沒加入時要跟 Core 的 `.env` 一樣。 |
| `LOG_LEVEL` | `info` | `error` / `warn` / `info` / `debug`。`debug` 會印出 `@discordjs/voice` 的連線與 DAVE 細節。 |
| `SILENCE_MS` | `400` | 某人停止說話多久算一段串流結束(`stream_close`)。建議 300~500。 |
| `PLAYBACK_MAX_BUFFER_S` | `60` | 單一播放最多緩衝幾秒音訊,超過回報 `failed`(避免 Core 一次灌太多吃光記憶體)。 |
| `PLAYBACK_PREBUFFER_MS` | `60` | 開始播放前先累積多少 ms,避免一開始就斷斷續續。 |
| `PLAYBACK_MAX_STARVE_MS` | `10000` | Core 太久沒送下一段音訊時,最多補多久靜音,超過回報 `failed`。 |
| `STAGE_LEVELS_URL` | (空 = 不送) | Stage 的嘴型端點,例如 `ws://127.0.0.1:7883/levels`。見下面〈嘴型音量〉。 |
| `STAGE_LEVELS_GAIN` | `1` | 送出的 RMS 乘上這個倍數(上限 1)。 |
| `GOLIVE_*` | 見 `.env.example` | Go Live 預設值:`GOLIVE_VOICE_MODE`(`hybrid` / `exclusive`)、`GOLIVE_ENCODER`(`auto` / `nvenc` / `software`)、`GOLIVE_NVENC_PRESET`、`GOLIVE_CODEC`、`GOLIVE_HEIGHT`、`GOLIVE_FPS`、`GOLIVE_BITRATE_KBPS`、`GOLIVE_HWACCEL_DECODE`、`GOLIVE_NO_TRANSCODE`、`GOLIVE_START_TIMEOUT_S`。`golive_start` 內的欄位優先。 |

## 行為說明

**連線 Core**
- 先登入 Discord(拿到自己的 user id),再連 Core,5 秒內送 `hello`(含 `self_account`);收到 `welcome` 才算就緒。
- 斷線自動重連,指數退避 1 s → 30 s(加抖動);連線穩定 30 秒以上才把退避歸零。重連成功後會重新回報目前所在的頻道(`joined` + `voice_state`),因為 Core 的狀態是空的。
- 連線斷掉時,正在播的東西會立刻停掉(沒人在驅動了)。
- 這些 close code 不會重試,直接結束程式(exit 1):**4401**(token 錯誤,會印 `bad token`)、**4400**(協定版本不符)、**4409**(同一個 self 帳號被另一個節點取代)。
- 超過 60 秒沒收到 Core 的任何訊框(Core 每 15 秒會 ping)就判定死線並重連。

**進出語音**
- `join` 給 `channel` 就進該頻道;只給 `user_id` 就進那個人**目前**所在的頻道(從 voice state 查,查不到就回 `error`)。已在同一頻道時只會重新回報狀態;在同伺服器的另一個頻道時會先離開(`left`,reason `moved`)再進新的。
- 進頻道後回 `joined`,並送一次 `voice_state`;之後該頻道有人進出、靜音 / 拒聽變化,就再送 `voice_state`。`display_name` = 伺服器暱稱 > 全域顯示名稱 > 使用者名稱。`participants` 包含 self 帳號自己(`is_self: true`)。
- 被踢、被移走、頻道被刪、語音連線失敗(重連 5 次仍失敗)會回 `left`。被管理員移到別的頻道則回新的 `joined`。
- 失敗(找不到伺服器 / 頻道、沒權限、頻道已滿、連線逾時 30 秒)回 `error`。

**收音**
- 每個說話中的人(排除 self 帳號自己和 bot)各一條 Opus 串流 → 解碼 48 kHz → 下混單聲道 → 重新取樣 16 kHz → 切成 20 ms 訊框送出。第一個完整訊框送出前先送 `stream_open`;停止說話(`SILENCE_MS` 靜音後)送 `stream_close`。stream id 是遞增的 u32。
- 另外會送 `speaking`(Discord 的說話開始 / 結束訊號)。
- 如果跟 Core 的連線慢到 WebSocket 送出緩衝超過 512 KB,**會丟掉收音訊框**而不是越積越多(日誌會有警告),不會卡住事件迴圈。

**播放**
- `play_start` 建立一個排隊的播放;之後的 `0x02` 二進位訊框附加音訊;`play_end` 表示沒有更多資料(緩衝播完才回 `finished`);`play_stop` 在 `fade_ms` 內淡出後停止並回 `interrupted`(`fade_ms: 0` 立刻停)。
- 回報的 `playback` 狀態:`started`(真的開始出聲)/ `finished` / `interrupted` / `failed`(附 `error`)。
- **同一個伺服器一次只播一段**,其他的排隊(最多 16 段)。排隊中的播放被 `play_stop` 會直接移除並回 `interrupted`。
- Core 送音訊比即時慢時,節點會補靜音等資料(不會斷掉);等太久(`PLAYBACK_MAX_STARVE_MS`)才判定 `failed`。Core 送得比即時快沒問題,會緩衝(上限 `PLAYBACK_MAX_BUFFER_S`)。
- 離開頻道、語音連線中斷時,所有進行中與排隊中的播放都回報 `interrupted`。

**嘴型音量(給 Stage)**
- 設了 `STAGE_LEVELS_URL` 就會連過去(WebSocket 客戶端,Stage 沒開時安靜地重連,只警告一次)。播放時,**Discord 播放器實際拉走的 PCM**(已重新取樣成 48 kHz 立體聲、補靜音也算)每 10 ms 算一次 RMS,送 `{"t":<自這段播放開始的 ms>,"rms":0..1}`。`t` 是視窗起點,跟音訊自己的時間軸走;每筆依牆上時鐘在 `起點 + t` 送出(播放器剛開始會一口氣多讀幾個 frame,所以不是看拉取當下),播放器停頓後會重新對時而不是一口氣補送。
- 播放結束(播完、被打斷、連線中斷)送最後一筆 `rms: 0`。同時只有一段播放在驅動嘴型,後開始的取代先開始的。
- 每筆也帶 `bands`:pre-emphasis 後 6 個帶通頻帶(300 / 550 / 850 / 1300 / 2000 / 3000 Hz)在最近 20 ms 的 RMS,Stage 用它的形狀估計母音(A/I/U/E/O)。舊版 Stage 會忽略它。
- RMS 是真正的相對滿刻度值(一般說話約 0.05~0.2);Stage 那邊會自己做 dB 曲線和自動增益,`STAGE_LEVELS_GAIN` 通常不用調。

**Go Live(推流)**
- Core 送 `golive_start { guild, source, channel?, width?, height?, fps?, bitrate_kbps?, encoder?, audio?, listen? }`,node 回報 `golive { guild, state: starting | live | stopped | failed, error?, reason? }`(完整欄位說明見 [`docs/protocols/voice-link.md`](../../docs/protocols/voice-link.md))。`source` 通常是 OBS 的輸出:`srt://127.0.0.1:9999`(node 的 ffmpeg 自動當 `mode=listener`,OBS 填 `?mode=caller`)或 `rtmp://127.0.0.1:1935/live/miyoria`(ffmpeg 當 RTMP 伺服器,`-listen 1`);也可以是已經在跑的本機伺服器(`listen: false`)、`udp://`、`http(s)://`、本機檔案。
- 流程:ffmpeg 讀來源 → 轉碼(`auto`:先實際開一次 `h264_nvenc` 測試,能用就 NVENC、否則 x264;結果快取)→ NUT → `@dank074/discord-video-stream` 切 H.264/H.265 封包送 Go Live。NVENC 是獨立的硬體區塊,不太吃遊戲的 3D 效能;`GOLIVE_NO_TRANSCODE=true` 可以直接轉送 OBS 已編好的 H.264(OBS 要設 1 秒關鍵影格、0 B-frame)。
- **跟語音同時進行**(`GOLIVE_VOICE_MODE=hybrid`,預設):語音連線(`@discordjs/voice`,不拒聽)維持不動、照常收音和播 TTS;Go Live 是 Discord 另開的 WebRTC 連線(`STREAM_CREATE`),只借用語音 session id。實驗性質:要動 discord-video-stream 的私有欄位 `_voiceConnection`,**還沒對真的 Discord 驗證**。我們已經在本機驗證到 Discord 之前的每一段:函式庫載得起來、NVENC 命令列、SRT listener 接 ffmpeg 推流、demux、送出 `STREAM_CREATE` / `STREAM_SET_PAUSED`、中止時送 `STREAM_DELETE`,而且 hybrid 全程**沒有**送 `VOICE_STATE_UPDATE`(不會動到語音連線)。
- 備案 `GOLIVE_VOICE_MODE=exclusive`:推流期間 node 離開語音(送 `left`,reason `golive`),由套件自己的連線佔著頻道(固定自我拒聽 = 聽不到人、不能播 TTS);推流結束自動重新加入原頻道。如果實測發現 hybrid 不行就用這個。
- 同一個帳號同時只有一個 Go Live。離開語音頻道(`leave`、被踢、換頻道)會先停掉 Go Live。來源斷線(OBS 停了)= `stopped` / `source ended`,不會自動重連。
- 需要 `ffmpeg` 在 PATH(要有 `libopus`、`libzmq`;你現在的 gyan.dev build 兩個都有,也有 `h264_nvenc`)。`@dank074/discord-video-stream` 的原生依賴(node-av、zeromq、sharp、node-datachannel)是第一次 Go Live 才載入的,載入失敗只會變成一則 `failed`,不會影響語音。
- 已知:該函式庫的 `minimizeLatency` 會傳 `-flags lowdelay`,新版 ffmpeg 會拒絕(`Error setting option flags to value lowdelay`),所以我們自己傳 `-fflags nobuffer -flags low_delay …`。

## Discord 端注意事項

- **用專用小帳號**:建議開一個沒有重要資料的帳號,只加進她要待的伺服器。不要用你的主帳號,被封的話損失最小。
- **不要讓它發文字**:這個帳號只做語音(文字 / 指令由官方 bot 帳號負責),可以降低被偵測的機會,也讓她對外只有一個「說話的帳號」。
- **收音前要取得同意**(ARCHITECTURE §10.1):進頻道的人要知道她在聽、會被轉成文字。節點會把所有人的音訊送給 Core,是否處理由 Core 的同意名單決定;建議在頻道說明或進場時公告。節點不會把音訊寫到磁碟。
- **身分共用**:Discord user id 是全域唯一的,官方 bot 在文字頻道看到的人與 self 帳號在語音聽到的人會對應到同一個 `Person`,記憶與好感共用。Core 要把 bot 和 self 兩個帳號 id 都登記為自己的帳號(避免自己回自己)。
- **權限**:self 帳號要有該頻道的「檢視頻道」與「連線」權限,頻道不能是滿的;要被聽到還需要「說話」權限。
- **DAVE**:Discord 語音已採端對端加密。收音、送音都靠 `@discordjs/voice` 內建的 DAVE(`@snazzah/davey`);**這個專案沒有實際連過 Discord 驗證**,Phase 0 的 spike(已移除,留在 git 歷史)就是要驗證這件事,結果以 spike 為準。
- 一個 self 帳號同一時間在同一個伺服器只能待在一個語音頻道(Discord 的限制)。

## 疑難排解

| 現象 | 可能原因 / 做法 |
|---|---|
| 啟動就印 `[config] SELF_TOKEN is missing` | 還沒建 `.env`,或沒填 `SELF_TOKEN`。 |
| `Discord login failed` | token 錯誤 / 已失效(換密碼、被登出會讓 token 失效),或帳號被要求驗證。到瀏覽器登入看看有沒有驗證提示。 |
| 日誌印 `bad token` 後程式結束 | Core 回 close 4401:`VOICE_LINK_TOKEN` 跟 Core 設定不一致。 |
| 一直 `connecting ... reconnecting in N ms` | Core 沒啟動,或 `VOICE_LINK_URL` / port 不對、防火牆擋住。確認 Core 的 `voice.link` 模組已啟用。 |
| 日誌印 `replaced by a newer voice-node connection` | 同一個 self 帳號有另一個節點連到同一個 Core(4409),關掉多餘的那個。 |
| `join` 後回 `error`:`could not establish the voice connection within 30 s` | 語音握手卡住:DAVE / UDP 被擋(防火牆要允許對外 UDP)、地區 / 帳號被 Discord 限制,或函式庫跟 Discord 最新協定不相容。設 `LOG_LEVEL=debug` 看 `voice:` 開頭的日誌;`pnpm report` 檢查依賴;升級 selfbot 函式庫 / `@discordjs/voice` 後再試。 |
| `join` 回 `cannot join channel ... (missing permission, or the channel is full)` | 權限不足或頻道已滿。 |
| 進得去,但 Core 收不到任何人的聲音 | 確認 self 帳號沒有被伺服器「拒聽」;`LOG_LEVEL=debug` 看有沒有 `speaking` / 解碼錯誤;DAVE 解密失敗時收到的是亂碼,Opus 解碼會一直失敗。 |
| 別人聽不到她說話 | 沒有「說話」權限、self 帳號被伺服器靜音、或 DAVE 沒協商成功(送出的音訊必須加密)。看 `playback` 有沒有 `started`。 |
| 播放斷斷續續 | Core 的 TTS 比即時慢(日誌看不到錯誤,但會補靜音)。調大 `PLAYBACK_PREBUFFER_MS`,或讓 Core 多緩衝一點再送。 |
| 日誌警告 `dropping capture audio` | Core 端收不及(或網路慢),WebSocket 送出緩衝滿了,節點選擇丟掉音訊而不是卡住。檢查 Core 的負載。 |
| 說話的人開頭被吃掉一點 | 目前要等 Discord 的 speaking 訊號出現後才訂閱該使用者的串流,第一個封包(約 20 ms)會被漏掉,對 ASR 影響很小。 |

## 專案結構

```
src/
  main.ts             進入點:載入設定、登入 Discord、連 Core、處理 SIGINT
  config.ts           環境變數 / .env
  log.ts              分級日誌(不記 token)
  protocol.ts         Voice Link v1:用 @miyoria/contracts/voice-link 的 schema 解析 Core 的訊息,加上 schema 說不出的部分(join 要有 channel 或 user_id、fade_ms 四捨五入並夾到 10 秒、null 當省略);二進位訊框編解碼
  link.ts             Core 的 WebSocket 用戶端:hello/welcome、ping/pong、重連退避、close code
  node.ts             協調者:Core 指令 ⇄ 各伺服器的語音 session
  guild-voice.ts      單一語音 session:@discordjs/voice 連線、AudioPlayer、收音
  capture.ts          收音管線:Opus → 16 kHz 單聲道 20 ms 訊框、stream_open/close
  discord.ts          selfbot 登入、顯示名稱、voice state / 成員查詢
  golive/plan.ts      golive_start → 驗證過的計畫(來源網址白名單與 ffmpeg 輸入選項、規格範圍)
  golive/encoder.ts   NVENC 實測探針與 auto / nvenc / software 選擇
  golive/manager.ts   Go Live 狀態機(starting → live → stopped | failed),引擎與語音端都是注入的
  golive/dvs-engine.ts  discord-video-stream 引擎:ffmpeg 轉碼 → Go Live;hybrid / exclusive 兩種語音共存方式
  levels/rms.ts       10 ms 視窗 RMS + 母音頻帶(交錯立體聲 → 單聲道)
  levels/publisher.ts 依牆上時鐘排程送出每個視窗,播放時間軸 t,多段播放交接
  levels/client.ts    Stage levels 的 WebSocket 客戶端(安靜重連)
  audio/resampler.ts  串流式 windowed-sinc 重新取樣、單聲道 ⇄ 立體聲
  audio/fifo.ts       Int16 取樣 FIFO
  playback/source.ts  單一播放的緩衝來源:延遲重新取樣、淡出、補靜音、上限
  playback/queue.ts   每個伺服器的播放佇列狀態機(只依賴 PlayerPort 介面)
  playback/discord-port.ts  PlayerPort 的 @discordjs/voice 實作(自己編 Opus,低延遲)
test/                 vitest:協定、重新取樣、播放佇列(含假 player)、收音、Core 連線、真 AudioPlayer 冒煙測試、嘴型 RMS 與排程、Go Live(計畫、狀態機、引擎載入錯誤)
```

## 已知限制 / 尚未實測

- 沒有對真的 Discord 連線測過(測試環境無法):所有 Discord 相關程式是依 `node_modules` 裡 `@discordjs/voice` 0.19.2 與 `@lng2004/discord.js-selfbot-v13` 3.7.2 的型別與原始碼寫的,版本與 Phase 0 的 spike 相同(spike 已移除,留在 git 歷史)。
- 播放是節點自己把 PCM 編成 Opus(`StreamType.Opus`),不經過 prism-media 的編碼器;`prism-media` 的 peer 依賴會警告 `opusscript` 版本(`^0.0.8` vs `0.1.1`),與 spike 相同,不影響這條路徑。
- Go Live 與語音同時進行(hybrid)尚未對真的 Discord 驗證(見上);Go Live 的 DAVE 加密由 discord-video-stream 處理(`@snazzah/davey`),同樣沒有實測。
