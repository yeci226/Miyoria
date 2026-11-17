# Voice Link 協定(v1)

Self voice node(`apps/voice-node`,TS)和 Core 的 `voice.link` 模組之間的連線。WebSocket + JSON(音訊用二進位訊框);原本規劃的 gRPC Node Link 已經放棄(見 DECISIONS)。

- **方向**:voice node 主動連到 Core:`ws://<core>:7879/voice-link`(位址由 `[modules."voice.link"] bind` 設定)。
- **訊框**:文字訊框是 JSON(都有 `type` 欄位);二進位訊框是音訊。
- **音訊格式**:一律 **PCM s16le、單聲道**。收音固定 16 kHz;播放的取樣率由 `play_start.sample_rate` 指定,voice node 負責轉成 Discord 要的 48 kHz 立體聲。
- **Schema**:每個訊息只寫一次,是 `packages/contracts/voice-link` 的 zod schema,兩邊都用它解析;輸出成 [`packages/contracts/schema/voice-link.json`](../../packages/contracts/schema/voice-link.json)(JSON Schema,以該檔為準,下面的表格只是摘要)。Node → Core 是 `VoiceLinkNodeMessage`,Core → Node 是 `VoiceLinkCoreMessage`,每種訊息各有一個定義(`VoiceLinkHello`、`VoiceLinkJoin`…)。版本號、close code、二進位訊框的標籤和欄位上限是同一個資料夾 `protocol.ts` 裡的常數(`VOICE_LINK_VERSION`、`VOICE_LINK_CLOSE`、`VOICE_LINK_FRAME`、`VOICE_LINK_LIMITS`)。
- **相容**:v1 之內只加不改:新欄位一定是可選或有預設值。收到不認得的欄位一律忽略。收到不認得的 `type`:node 忽略(debug 日誌);Core 記一行警告後丟掉。格式不對的訊息兩邊都是記警告、丟掉,**不回任何訊息**。

## 連線與認證

1. Node 連上後 5 秒內送出:
   ```json
   {"type":"hello","version":1,"token":"<VOICE_LINK_TOKEN>","node":"voice-node",
    "self_account":{"platform":"discord","id":"<self 帳號 user id>"},
    "capabilities":["play_duck","play_pause"]}
   ```
   `capabilities`(可選,字串陣列,預設空)是這個 node 支援的**選用功能**,Core 只會對宣告過的 node 送對應的訊息,所以新的 Core 配舊的 node(或反過來)照常運作,版本號不變(仍是 1)。目前有:`play_duck`(`play_duck`)、`play_pause`(`play_pause` + `play_resume`)。不認得的名稱忽略。
   `node`(名稱,只用在日誌)和 `capabilities` 可以省略。Core 先比對 token,再檢查其他欄位;`self_account` 的 `platform`、`id` 不可以是空字串。
2. Core 回 `{"type":"welcome","session":"<ulid>"}`。token 錯誤(或不是字串)時用 close code `4401` 關閉;hello 格式不對、版本不是 1、5 秒內沒送 hello、第一個訊框不是 hello(或是二進位)都用 `4400`。Node 送出 hello 後 10 秒內沒收到 `welcome` 就斷線重連。
3. 同一個 `self_account` 只允許一條連線,新的連線會取代舊的(舊的用 `4409` 關閉)。
4. 心跳:Core 每 15 秒(`ping_interval_ms`)送 `{"type":"ping"}`,node 回 `{"type":"pong"}`。Node 的任何訊框(包括 WebSocket 的 ping / pong)都算活著;45 秒(`peer_timeout_ms`)什麼都沒收到,Core 用 `4408` 關閉。Node 那邊 60 秒沒收到 Core 的任何訊框就自己斷線重連。Node 不送 `ping`;它送的話 Core 會回 `pong`,而 node 收到 Core 的 `pong` 會當作不認得的 `type` 忽略。

**Close code**(`VOICE_LINK_CLOSE`,都是 Core 送的):

| code | 意思 | node 的反應 |
|---|---|---|
| `4400` | hello 不對(格式、版本、逾時) | 不重連,結束行程 |
| `4401` | token 錯誤 | 不重連,結束行程 |
| `4408` | 太久沒收到 node 的訊框 | 重連 |
| `4409` | 同一個 self 帳號有更新的連線 | 不重連,結束行程 |
| `1001` | Core 正在關閉 | 重連 |

其他 code(或連線直接斷掉)node 都用指數退避重連。

## Core → Node

Schema:`VoiceLinkCoreMessage`。Core 沒設定的可選欄位整個鍵不送;node 把 `null` 也當作省略。Node 檢查的範圍(schema 裡寫著):`guild`、`channel`、`user_id` 是 1~64 個字元;`play` 是 u32;`sample_rate` 是 8000~192000 的整數;`gain` 是 0~1;`fade_ms` 不是負數;`source` 不是空白、最多 2048 個字元;`width`、`height`、`fps`、`bitrate_kbps` 是正整數(u32);`encoder` 是 `auto` / `nvenc` / `software`;`audio`、`listen` 是布林值。不合的訊息整則丟掉(node 記警告,不回 `error`)。Schema 說不出、由 node 解析後處理的:`join` 至少要有 `channel` 或 `user_id`;`fade_ms` 四捨五入、超過 10 秒當 10 秒、省略當 0;`levels` 只有 `true` 算數,其他值都當省略,不會因為它拒絕訊息。

| type | 欄位 | 說明 |
|---|---|---|
| `welcome` | `session` | 回應 hello,見上面〈連線與認證〉 |
| `join` | `guild`, `channel?`, `user_id?` | 進語音。給 `channel` 就進那個頻道;只給 `user_id` 就進那個人目前所在的頻道(node 看得到 voice state) |
| `leave` | `guild` | 離開該伺服器的語音 |
| `play_start` | `play`(u32), `guild`, `sample_rate`, `levels?` | 開始一段播放;接著用二進位訊框送音訊。`levels: true`:這段播放另外帶一條**嘴型音軌**(`0x03`,例如歌曲的人聲),嘴型跟它走而不是跟播出的音訊走(舊的 node 會忽略) |
| `play_end` | `play` | 這段音訊送完了。Node 播完緩衝裡的音訊後回 `playback` `finished` |
| `play_stop` | `play`, `fade_ms` | 立刻停止(插話 / barge-in),淡出 `fade_ms` 毫秒 |
| `play_duck` | `play`, `gain`(0~1), `fade_ms` | 把這段播放的音量設成 `gain`(1 = 原音量),用 `fade_ms` 毫秒漸變;之後一直維持到再次設定。別人在講話(不是在跟她說話)時 Core 先把她降音量,不用停。需要 capability `play_duck` |
| `play_pause` | `play`, `fade_ms` | 淡出 `fade_ms` 毫秒後**暫停**:緩衝裡的音訊原封不動留著、不計入「沒收到音訊」逾時,node 持續送靜音。超過 30 秒(node 的 `maxPauseMs`)沒有 `play_resume` 就當被打斷(`playback` `interrupted`)。需要 capability `play_pause` |
| `play_resume` | `play`, `fade_ms` | 繼續暫停的播放,`fade_ms` 毫秒淡入(回到 `play_duck` 設的音量)。需要 capability `play_pause` |
| `golive_start` | `guild`, `source`, `channel?`, `width?`, `height?`, `fps?`, `bitrate_kbps?`, `encoder?`, `audio?`, `listen?` | 開始 Go Live,見下面〈Go Live〉 |
| `golive_stop` | `guild` | 停止 Go Live |
| `ping` | | 心跳,node 回 `pong` |
| `pong` | | 回應 node 的 `ping`(node 不送 `ping`,收到也忽略) |

`play_duck` / `play_pause` / `play_resume` 對已經結束或不存在的 `play` 無作用;`gain` 超出 0~1、`fade_ms` 為負數的訊息被丟掉(node 只記警告,不回 `error`)。`fade_ms` 上限 10 秒,省略視為 0。音量調整同樣套用在嘴型音量上(她小聲嘴就小動)。

**選擇性 barge-in(Core 端的規則,node 只負責執行上面的訊息)**:別人講話時 Core 先對播放送 `play_duck`;這回合要回的人講超過 `barge_in_ms` 就送 `play_pause`;語音辨識(ASR)回來後,如果是叫她名字、或要回的人說了實質內容就送 `play_stop`,否則(「嗯」、回音、跟她無關的話)送 `play_resume` 與 `play_duck` `gain: 1`,她接著講完剩下的句子。node 不宣告這兩個 capability(舊 node)時,Core 不送 duck、把「暫停」改成 `play_stop`(等於以前的行為)。這些決定都會以 `voice.barge_in` 事件(`{context, turn, account, action: duck|pause|resume|stop, reason}`)發到 Core 的事件匯流排。

二進位 `0x02`(播放音訊):`[0x02][play: u32 LE][PCM s16le 單聲道 …]`。

二進位 `0x03`(嘴型音軌,只用在 `levels: true` 的播放):`[0x03][play: u32 LE][PCM s16le 單聲道 …]`,取樣率同 `sample_rate`。Core 把每個 `0x03` 訊框送在**同長度**的 `0x02` 訊框之前,node 依序對齊;缺的部分當靜音,超過緩衝上限的丟掉。

## Node → Core

Schema:`VoiceLinkNodeMessage`。Node 可以省略有預設值的欄位,Core 會補上:可選的字串補 `null`,`display_name` 補 `""`,`is_self` / `muted` / `deafened` 補 `false`,`capabilities` 補 `[]`。Core 只檢查 `stream`、`play`、`sample_rate`、`version` 是 u32,字串不限長度。

| type | 欄位 | 說明 |
|---|---|---|
| `hello` | 見上面〈連線與認證〉 | 連線後的第一則;之後再送會被忽略 |
| `joined` | `guild`, `channel` | 已進入語音頻道 |
| `left` | `guild`, `reason?` | 已離開(被踢、頻道刪除、`leave`…) |
| `voice_state` | `guild`, `channel`, `participants[]` | 進頻道時送一次,之後成員有變動就送。`participants` 每筆:`user_id`, `display_name`, `is_self`, `muted`, `deafened` |
| `speaking` | `guild`, `user_id`, `speaking`(bool) | Discord 的說話開始 / 結束訊號 |
| `stream_open` | `stream`(u32), `guild`, `channel`, `user_id`, `display_name`, `sample_rate`(16000) | 某人開始說話,開一條音訊串流 |
| `stream_close` | `stream` | 這個人停止說話(Discord 停止送封包);可以當作斷句的提示 |
| `playback` | `play`, `state`(`started` / `finished` / `interrupted` / `failed`), `error?` | 播放狀態 |
| `golive` | `guild`, `state`(`starting` / `live` / `stopped` / `failed`), `error?`, `reason?` | Go Live 狀態,見下面〈Go Live〉 |
| `error` | `message` | 非致命錯誤(例如進頻道失敗)。Core 用它讓最早一個還在等的 `join` 失敗 |
| `ping` | | Core 回 `pong`(目前的 node 不送) |
| `pong` | | 回應 Core 的 `ping` |

二進位 `0x01`(收音):`[0x01][stream: u32 LE][PCM s16le 單聲道 16 kHz …]`,建議每 20 ms 一個訊框(640 bytes 的 PCM)。

**規則**

- Node **不送自己帳號的音訊**,也不送 bot 帳號的音訊。
- 沒同意被收音的使用者,由 Core 過濾(node 照送)。
- Node 一次只播一段;新的 `play_start` 進來時,如果前一段還沒結束,就排在它後面。

## Go Live

Core 要 self 帳號把畫面(OBS 的輸出:VTuber + 遊戲)推進語音頻道當 Go Live 直播。node 用 ffmpeg 讀 `source`(NVENC 優先,沒有就 x264),經 `@dank074/discord-video-stream` 送到 Discord。

Core 端由 `voice` 模組的 `/golive start`、`/golive stop`、`/golive status` 指令送出(來源預設是 `[modules.voice] golive_source`,即 `rtmp://127.0.0.1:1935/live/miyoria`;她還不在語音頻道時,`/golive start` 會先送 `join` 進下指令的人所在的頻道);`stage.link` 收到 `voice.golive` 事件後會跟著按 OBS 開始 / 停止直播(見 [stage-link.md](stage-link.md))。

**`golive_start`**

| 欄位 | 說明 |
|---|---|
| `guild` | 必填。 |
| `source` | 必填。`rtmp://` / `rtmps://`、`srt://`、`udp://`、`rtsp://`、`http(s)://`、`file://` 或本機檔案路徑。其他(`pipe:`、`concat:`、`-` 開頭…)一律拒絕(回 `failed`)。空白或超過 2048 個字元的 `source` 不符合 schema,整則訊息被丟掉。 |
| `channel` | 在哪個語音頻道直播。省略 = 她目前在的頻道;她不在任何頻道又沒給 `channel` 就 `failed`。給了但她不在那個頻道,node 會先進去(hybrid 模式)。 |
| `width` `height` `fps` `bitrate_kbps` | 輸出規格,省略時用 node 的設定(預設高 1080、60 fps、6000 kbps,寬度依來源比例)。超出範圍(寬/高 16~7680/4320、fps 1~120、碼率 100~100000)回 `failed`,不會默默夾住;0、負數、小數不符合 schema,整則訊息被丟掉。只給 `width` 時高度依比例。 |
| `encoder` | `auto`(預設:`h264_nvenc` 真的開得起來就用,否則 x264)/ `nvenc` / `software`。要求 `nvenc` 但開不起來時退回 x264(node 日誌會有警告)。其他值不符合 schema,整則訊息被丟掉;Core 的 `goliveStart` 在送出前就拒絕。 |
| `audio` | 是否送來源的音軌。預設 `true`。如果 OBS 的來源本來就含她的 TTS(例如 VB-Cable),設 `false` 避免觀眾聽到兩次。 |
| `listen` | 誰是伺服器。**預設讓 node 的 ffmpeg 當伺服器等 OBS 來推**:`rtmp://` 預設 `-listen 1`;`srt://` 沒寫 `mode=` 時補 `mode=listener`。來源是一台已經在跑的 RTMP/SRT 伺服器(node 去拉)時給 `listen: false`(SRT 補 `mode=caller`)。URL 裡明寫的 `mode=` 優先。 |

OBS 端:RTMP 設定→串流→自訂,伺服器 `rtmp://127.0.0.1:1935/live`、金鑰 `miyoria`;SRT 伺服器填 `srt://127.0.0.1:9999?mode=caller`。輸出請用 NVENC H.264、關鍵影格間隔 1 秒、B-frames 0、CBR(要用 node 的 `GOLIVE_NO_TRANSCODE` 直通時必須如此)。

**`golive` 狀態**

| state | 意義 |
|---|---|
| `starting` | 收到請求,在等來源 / 連 Discord。來源是 listener 時會一直停在這裡直到 OBS 開始推(超過 `GOLIVE_START_TIMEOUT_S`,預設 120 秒,變成 `failed`)。 |
| `live` | Go Live 連線已建立、畫面正在送出。 |
| `stopped` | 結束了。`reason`:`stop requested`(Core 要求)、`source ended`(OBS 停了 / 檔案播完)、`left voice` / `voice session ended (…)`(離開語音頻道,hybrid 的 Go Live 依附在語音 session 上)、`shutdown`、`not streaming`(對沒在直播的伺服器送 `golive_stop`)。 |
| `failed` | 沒起得來或中途死掉。`error` 是人看得懂的原因(來源網址不合法、ffmpeg 結束碼與最後幾行 stderr、找不到語音頻道、套件載入失敗…)。 |

規則:

- 每個 self 帳號**同一時間只有一個** Go Live(Discord 的限制)。已經在直播的伺服器再收到 `golive_start` 只會重送目前狀態;別的伺服器則回 `failed`("another Go Live is already running")。
- node 不會自動重連來源:OBS 斷線就是 `stopped`("source ended"),由 Core 決定要不要再送 `golive_start`。
- Core 的連線斷了不影響正在進行的 Go Live;重連後 node 會再報一次目前狀態。
- 離開語音(`leave`、被踢、換頻道)會先停掉 Go Live。

**和語音(收音 + TTS)同時進行**:`GOLIVE_VOICE_MODE=hybrid`(預設)時,語音連線維持不動(`selfDeaf: false`,照常收音、播放),Go Live 是 Discord 另開的第二條 WebRTC 連線(`STREAM_CREATE`),只借用語音 session id,所以兩者互不干擾。這靠的是動到 `@dank074/discord-video-stream` Streamer 的一個私有欄位(`_voiceConnection`),屬於實驗性質,還沒對真的 Discord 驗證(Phase 0 spike 的 `GOLIVE_VOICE=hybrid` 同一做法)。如果實測發現不行,改 `GOLIVE_VOICE_MODE=exclusive`:推流前 node 離開語音(送 `left`,`reason: "golive"`)、由套件自己的連線進頻道(固定自我拒聽,聽不到人、不能播 TTS);Go Live 結束後自動重新加入原頻道(送 `joined` + `voice_state`),Core 的 `leave` 會取消這個重新加入。

## 她聽起來講了多少

Core 的 `voice_playback` 事件在 `finished` / `interrupted` 時帶 `heard_ms`(node 回報 `started` 到結束的時間,扣掉 `play_pause` 暫停的部分)和 `total_ms`(這句音訊的總長;被打斷時還沒合成完就是 `null`)。她的歷史用 `heard_ms / total_ms` 算聽到了幾成,沒有 `total_ms` 才用 `ms_per_char` 估。`speak` 被 abort signal 取消(Floor 切掉這句、排程逾時、緊急停止)也一樣:送 `play_stop`、發 `interrupted`。

## 嘴型音量(不在這個協定裡)

voice node 另外把**實際送去 Discord 的 PCM**(重新取樣成 48 kHz 之後、跟播放對時;帶嘴型音軌的播放改用那條音軌,一樣套用淡出)每 10 ms 算一次 RMS,推給 Stage 的 `STAGE_LEVELS_URL`(預設不啟用,例如 `ws://127.0.0.1:7883/levels`):`{"t":<播放開始起算的 ms>,"rms":0..1}`。`t` 是該 10 ms 視窗的起點、跟音訊自己的時間軸走(補靜音時照樣前進),每段播放從 0 開始;播放結束或被打斷送一筆 `rms: 0`。`rms` 是相對滿刻度的真正 RMS(一般說話約 0.05~0.2),`STAGE_LEVELS_GAIN` 可放大。Stage 沒開時安靜地重連,不影響語音。

---

# 推論 Worker HTTP 介面(v1)

`workers/` 底下的 ASR / TTS / 判斷講完 / 歌曲 / 歌詞服務(Python),對應 `@miyoria/voice/speech` 的 `http-worker` provider、`@miyoria/voice` 的 `HttpTurnJudge`、`@miyoria/sing` 的 `HttpSingWorker`。

**JSON body 的 schema 在 `packages/contracts/workers`,輸出成 [`packages/contracts/schema/workers.json`](../../packages/contracts/schema/workers.json)**(以該檔為準,下面的範例只是舉例)。不是 JSON 的部分(multipart 欄位、PCM、標頭名稱、`/vad` 的文字訊息)是同一個資料夾 `protocol.ts` 裡的常數。錯誤一律是 4xx / 5xx 加 `{"error":"..."}`(`WorkersError`)。

## ASR:`POST /asr`

- 請求:`multipart/form-data`,欄位 `audio`(WAV,PCM s16le 單聲道,任意取樣率)、`language`(可選)、`prompt`(可選)、`priority`(可選,`ahead` 排在 `now` 後面,省略 = `now`)。
- 回應:
  ```json
  {"text":"早安","language":"zh","emotion":"happy","audio_events":["laughter"],"duration_ms":1234}
  ```
  `language`、`emotion`、`audio_events` 是可選欄位,模型不知道就整個鍵不送(SenseVoice 有,Qwen3-ASR 沒有;`WorkersAsrReply`)。`duration_ms` 是音訊長度,client 不用。標頭 `X-Inference-Ms`:模型推論的毫秒數。

## TTS:`POST /tts`

- 請求(JSON,`WorkersTtsRequest`;沒有值的欄位省略或給 `null` 都一樣):
  ```json
  {"text":"哼,才不是在等你呢。","language":"Chinese","emotion":"annoyed","instruct":"不耐煩、拖長音","voice":"deepseek-chan"}
  ```
- 回應:`200`,`Content-Type: audio/L16; rate=24000; channels=1`,body 是**串流**的原始 PCM s16le(chunked transfer)。標頭 `X-Sample-Rate` 一定要有。Worker 應該在產生第一段音訊後就開始送。
- `voice` 是 worker 端註冊好的聲音名稱(例如由參考音檔建立的 clone prompt)。
- `emotion` 是這句話要用的情緒音庫片段(`TTS_VOICE_BANK=1` 時才有作用)。台詞沒有自己的 `<emo:…>` 時用她現在表現出來的情緒;Core 依 `EMOTION_OUTPUTS` 的 `voice`(`packages/types/src/affect-outputs.ts`)和 `voice.toml` 的 `[design.bank.*]` 挑第一個有的片段。Worker 沒有那個片段時退回 `neutral`,再退回一般參考音。`instruct` 還是看原本的情緒標籤。

## TTS 的排隊

`POST /tts` 可以帶 `priority`:`now`(省略時的值,她接下來要講的)排在 `ahead`(先合成的後面幾句)前面。回應多幾個標頭:`X-Tts-Queue-Ms`(等 GPU 鎖的毫秒數,Core 算進 `tts_queue`)、`X-Tts-Reference`(用了哪個參考音,`ref`、`ref.ja`、`bank/ja/happy`)、`X-Tts-Streaming`(`chunk`:句子裡面就一塊一塊送;`sentence`:整句整句送)、`X-Tts-First-Audio-Ms`(從收到請求到第一段音訊)。`emotion` 在 `TTS_VOICE_BANK=1` 時用來選參考音,其他時候仍然只是資訊。

`GET /busy`(TTS、ASR)→ `{"busy": n}`(`WorkersBusy`):正在處理的請求數,歌曲 worker 共用顯示卡時用它讓路。

`GET /voices`(TTS,`POST /voices/reload` 一樣)→ `{"mode","default","clone_mode","voice_bank","voices":[{"name","ref_text","x_vector_only","references":[…]}]}`(`WorkersTtsVoices`)。

## 判斷講完(`workers/turn`,預設 `127.0.0.1:8006`)

- `POST /turn`:本體是 PCM s16le 單聲道 16 kHz,這個回合到現在為止的聲音(只看最後 8 秒),標頭 `X-Sample-Rate: 16000` → `{"complete": bool, "probability": 0..1, "inference_ms": …}`(`WorkersTurnReply`;client 只讀前兩個)。取樣率不是 16000 回 400,模型沒載入回 `503 {"error": …}`。
- `WS /vad`:一條連線對一條音訊串流。每則二進位訊息 512 個樣本(32 ms),每則回一個文字訊息,內容是語音機率(小數三位,`"0.923"`)。模型沒載入時關閉連線(1011),訊息大小不對關 1003。
- `GET /health` → `{"status":"ok","smart_turn":bool,"silero":bool,"threshold":…,"errors":{…}}`(`WorkersTurnHealth`)。模型缺了 worker 照常跑。

Core 的 `voice_utterance` 這時多一個 `turn: {ended_by, probability}`:`ended_by` 是 `turn`(模型判定講完)、`timeout`(等到 `turn_max_silence_ms`)或 `silence` / `length` / `close`。

## 讓出顯示卡:`POST /offload`、`POST /reload`(TTS、ASR)

歌曲 worker 轉換時要整張顯示卡(12 GB 的卡上跟 TTS / ASR 一起跑會慢 10 倍以上),所以 `tts/` 和 `asr/` worker 可以暫時放掉模型:

- `POST /offload`(JSON 可省略,`WorkersOffloadRequest` / TTS 的 `WorkersTtsOffloadRequest`):`{"reason"?: "sing", "max_s"?: 900, "drain_s"?: 15}`(`drain_s` 只有 TTS)→ `{"state":"offloaded","offload_ms":…,"drained":bool,"vram_before_mb":…,"vram_after_mb":…,"device_used_before_mb":…,"device_used_after_mb":…,"released_mb":…}`(`WorkersOffloadReply`;`drained` 只有 TTS;`vram_*` 是這個行程自己用的,`device_*` 和 `released_mb` 是在顯示卡上量到的,讀不到是 `null`;已經放掉時多 `already: true`;停掉一個進行中的 reload 時多 `cancelled_reload: true`)。新的請求馬上回 503;TTS 正在合成的整段話最多等 `drain_s`(`TTS_OFFLOAD_DRAIN_S`)做完,超過才在下一個 chunk 中斷(`drained: false`)。然後整個模型(TTS 還有 CUDA graphs 和聲音的 prompt)丟掉、`torch.cuda.empty_cache()`。CUDA graphs 綁在當初的記憶體位址上,不能搬到 CPU 再搬回來,所以是刪掉、之後重建。
- 放掉期間 `POST /tts`、`GET /voices`、`POST /asr` 都回 **`503 {"error":"offloaded"}`**(不會自動重新載入:那樣就不算讓出了);`GET /health` 仍是 `status: "ok"`,多 `offloaded: true`、`reason`、`since`、`reload_at`、`loading`、`released_mb`。
- `POST /reload` → `{"state":"ready","reload_ms":…}`(`WorkersReloadReply`):跟啟動一樣重建(TTS:權重、CUDA graphs、聲音 priming;ASR:模型 + 暖機)。重複呼叫回 `already: true`。
- 保險:放掉超過 `max_s`(`TTS_OFFLOAD_MAX_S` / `ASR_OFFLOAD_MAX_S`,預設 900 秒,0 = 不會)沒人叫 reload 就自己載回來(歌曲 worker 當掉也不會讓她永遠沒聲音)。
- Core 端:錯誤訊息有 `offloaded` 的 ASR / TTS 失敗只記 debug,不是警告。

## 歌曲 Worker(`workers/sing`,預設 `127.0.0.1:8005`)

`@miyoria/sing` 用的翻唱服務:點歌 → 下載(yt-dlp)或本機歌庫 → 人聲分離(預設 Kim 的 Mel-Band RoFormer,沒有檢查點時退回 Demucs)→ 主唱 / 和聲分離(BS-RoFormer karaoke,沒有模型檔就略過)→ 只把主唱轉換成她的聲音(`SING_VOICE`:預設她自己的 RVC 模型;也可以先過 YingMusic-SVC / Seed-VC)→ 混音,一次只做一個工作,做好的歌快取在 `data/songs/<id>/`。

- `POST /jobs`(JSON,`WorkersSingJobRequest`):`{"query"|"url"|"path": "...", "title"?, "artist"?, "pitch"?, "key"?: 0, "backing"?: "keep", "force"?: false, "exclusive_ack"?: false}`,三選一。`url` 只接受 `SING_URL_HOSTS` 的網域;`path` 是歌庫裡的相對路徑。`pitch` 是人聲移調(半音,省略 = 自動挑八度),`key` 是整首轉調(伴奏跟著移;給了 `key` 就不做自動轉調)。`backing` 是原曲的和聲怎麼處理:`keep`(預設,照原樣留在伴奏裡)、`drop`(拿掉)、`convert`(也轉成她的聲音)、`acapella`(只有人聲,沒有伴奏);每個模式在 worker 裡是各自的一首歌(歌曲 id 不同)。回 `{"job": Job}`;已經做過的歌(同一個查詢 / 連結 / 檔案與同樣的音高設定)直接回 `state: "done"`、`cached: true`。
- `GET /jobs` → `{"jobs": [Job]}`(新的在前);`GET /jobs/{id}` → `{"job": Job}`;`DELETE /jobs/{id}` 取消。`Job`(`WorkersSingJob`):`id`、`state`(`queued` / `running` / `done` / `failed` / `cancelled`)、`stage`(`resolve` / `download` / `exclusive` / `separate` / `convert` / `mix` / `lyrics` / `video`)、`progress`(0..1)、`error`、`song_id`、`source`、`position`、`song`(做好時的 meta)、`video`(`{state, progress, error}`,在抓影片時)、`exclusive`(`null` / `waiting` / `offloading` / `active` / `reloading` / `done` / `shared`;`shared`:跟 TTS / ASR 同時跑,語音照常)與 `exclusive_info`(`{state, offloaded, errors, ...}`)、`gpu`(這個工作在哪裡跑、為什麼:`{policy, stage, mode, code, reason, free_mb, total_mb, need_mb, headroom_mb, speech_loaded, people, urgent, step_s, baseline_s, spilling, spills, steps, waited_s, silenced_s, silence_est_s, silence_max_s}`,`mode` 是 `share` / `offload` / `exclusive` / `wait` / `cpu` / `give_up`)、`yielded`、`request`、`created_at` / `started_at` / `finished_at`。`WorkersSingJob` 只寫 client 讀的欄位,其餘在這裡列出、schema 沒有。
- `POST /gpu/context`(JSON,`WorkersSingGpuContext`)→ `{"ok": true}`:`{in_voice, listeners, live, urgent: [job id]}`,Core 在工作準備期間每次輪詢都送,告訴 worker 誰會注意到她安靜(要不要跟 TTS 共用卡)、哪些歌馬上要唱。久沒收到就當作有人在聽。
- **獨佔顯示卡**(`SING_OFFLOAD_URLS`,例如 `http://127.0.0.1:8002,http://127.0.0.1:8003`,預設不開):從第一個用 GPU 的階段(分離,沒有就轉換)開始,先對每個 URL `POST /offload`,轉換一結束(成功、失敗、取消都一樣)就 `POST /reload`;reload 跟混音、歌詞平行跑,工作要等它們回來才算結束(她的開場白才有聲音)。某個 worker 放不掉就跳過它(記在 `exclusive_info.errors`)。決定要不要獨佔是 `SING_GPU_POLICY`(預設 `yield`;還有 `auto` / `share` / `wait` / `offload`)和顯示卡剩多少(`gpu`);不需要就是 `shared`。`exclusive_ack: true` 的工作在 offload 前先停在 `exclusive: "waiting"`(`stage: "exclusive"`),等 Core `POST /jobs/{id}/exclusive`(她說完「我去準備一下歌喔」)或 `SING_EXCLUSIVE_WAIT_S`(30 秒)。
- `GET /songs` → `{"songs": [meta]}`(新的在前),`GET /songs/{id}` → `{"song": meta}`。meta(`WorkersSingSongMeta`):`title`、`artist`、`duration_s`、`lyrics`(`{synced, lines: [{t, text}], provider, how, confidence, checks, ...}` 或 `null`,來自 lrclib.net / 網易雲;`confidence` 與 `how` 說明來源與把握)、`backing`(請求的 `backing`;沒有主唱分離、和聲還在轉換後的人聲裡時是 `in_vocal`)、`play`(`{sample_rate: 48000, samples}`)、`pitch`(`octave_shift`、`auto_key`、`song_key`、`vocal_shift`、`source_median_hz` / `source_top_hz`、`target_note`、`ceiling_note`、`top_after_note`、`f0_clean`、`transposer`)、`timings`、`peak_vram_mb`、`has_video` / `video` / `video_error`、`beats`(`{bpm, times}`,每一拍離播放開頭幾秒;沒有穩定節拍或舊的快取是 `null` / 沒有這個鍵)。
- `POST /songs/{id}/lyrics`(`{title?, artist?, fresh?}`)重找一首歌的歌詞、不重做音訊,回 `{found, previous, lyrics, lines}`(找不到是 `{found: false, kept, lyrics}`;`WorkersSingLyricsReply`);`GET /songs/{id}/files/{name}`:`mix.wav`、`vocals.wav`、`instrumental.wav`、`lyrics.lrc`、`video.mp4`(本機歌庫可能是 `video.mkv` 等),以及 Core 串流用的 `play_mix.pcm` / `play_vocals.pcm`(PCM s16le 單聲道 48 kHz,標頭 `X-Sample-Rate`)。
- `GET /library` → `{"entries": [{path, title, artist, split}]}`(`split` = 資料夾裡已經有 `vocals.*` + `instrumental.*`)。
- 快取會自己清(`SING_CACHE_MAX_GB` / `SING_CACHE_MAX_DAYS` / `SING_CACHE_PROTECT_HOURS`,見 workers/README.md 第 9 節):最久沒用的歌先刪,所以 Core 手上「準備好了」的歌可能已經不在。`GET /songs/{id}/files/{name}` 回 404 時,Core 用同一個請求重新點(worker 重做,好了再唱)。`GET /cache` → `{bytes, gb, songs, incomplete_songs, sources, oldest_use, limits, running, last}`;`POST /cache/prune`(`{dry_run?}` 或 `?dry_run=true`)現在清一次,回 `{removed: [{kind, id, title, why, last_used, bytes}], freed_bytes, before_bytes, after_bytes, protected, over_cap, errors, ...}`。
- `GET /health` → `status`、`model`、`device`、`backend`(`seed-vc`;測試用 `mock`)、`busy`(有工作在跑)、`queued`、`vram_allocated_mb`、`gpu`(`{policy, policy_source, cuda, total_mb, free_mb, headroom_mb, audience, learned, job}`)。`WorkersSingHealth`。
- 標題、歌手、歌詞都來自 YouTube / lrclib / 點歌的人,Core 一律當不可信資料。
- `@miyoria/sing` 讀 job 和 meta 時每個欄位都有退路(舊的 worker 沒有的欄位用預設值):`WorkersSingJob` / `WorkersSingSongMeta` 的 `.catch(...)` 就是這個寫法,在 JSON Schema 裡是 `default`。

## 歌詞 Worker(`workers/lyrics`,預設 `127.0.0.1:8007`)

歌曲 worker 在另一台機器時(那台沒有 LLM 金鑰、連不到 ASR worker)用它找歌詞:查找本身還是 `workers/sing/lyrics.py`,只有 Python 端(`sing/lyrics_remote.py`)會呼叫,沒有 TypeScript client。沒有認證,只綁私有位址(Tailscale)。

- `POST /lyrics`:`multipart/form-data`,欄位 `hints`(JSON,`WorkersLyricsHints`:`key`、`raw_title`、`title`、`artist`、`uploader`、`track`、`meta_artist`、`alt_title`、`description`、`tags`、`duration`、`url`,沒有值的鍵省略)、`duration`(秒,可選)、`fresh`(`0` / `1`,可選:再問一次語言模型)、`audio`(主唱的 WAV,可選:ASR 抽查要用)。`hints` 不是 JSON 或不是物件回 400,音訊超過 64 MiB 回 413。
- 回應 `{"found": false, "result": null}` 或 `{"found": true, "result": {provider, synced, lrc, plain, track, artist, how, confidence, matched, checks, tried, llm}}`(`WorkersLyricsReply`)。
- `GET /health` → `{"ok": true}`(`WorkersLyricsHealth`)。**這個 worker 沒有 `status` 欄位**,跟下面的共通格式不同;CLI 的檢查只看 HTTP 200,所以不影響。

## 共通

- `GET /health` → `{"status":"ok", ...}`(`WorkersHealth`),`status` 在 worker 有回應時一律是 `ok`(模型放掉或沒載入也是);其餘欄位各 worker 自己加:
  - ASR(`WorkersAsrHealth`):`model`、`device`、`backend`(`sensevoice` / `qwen3`)、`offloaded`、`loading`、`released_mb`、`vram_allocated_mb`,放掉期間再加 `since`、`reason`、`reload_at`,讀得到顯示卡時加 `device_total_mb` / `device_used_mb` / `device_free_mb`。
  - TTS(`WorkersTtsHealth`):`offloaded`、`model`、`device`、`mode`、`backend`、`sample_rate`、`streaming`、`chunk_size`、`stream_probe`、`voices`、`instruct_supported`、`clone_mode`、`voice_bank`、`released_mb`、`engine_pid`、`vram_allocated_mb`;放掉期間只有 `model`、`since`、`reason`、`reload_at`、`loading`、`released_mb` 和記憶體欄位。
  - 判斷講完、歌曲:見上。歌詞 worker 例外:見上。
- 錯誤用 4xx / 5xx 加上 `{"error":"..."}`(`WorkersError`)。
