# Voice Link 協定(v1)

Self voice node(`apps/voice-node`,TS)和 Core 的 `voice.link` 模組之間的連線。WebSocket + JSON(音訊用二進位訊框);原本規劃的 gRPC Node Link 已經放棄(見 DECISIONS)。

- **方向**:voice node 主動連到 Core:`ws://<core>:7879/voice-link`(位址由 `[modules."voice.link"] bind` 設定)。
- **訊框**:文字訊框是 JSON(都有 `type` 欄位);二進位訊框是音訊。
- **音訊格式**:一律 **PCM s16le、單聲道**。收音固定 16 kHz;播放的取樣率由 `play_start.sample_rate` 指定,voice node 負責轉成 Discord 要的 48 kHz 立體聲。

## 連線與認證

1. Node 連上後 5 秒內送出:
   ```json
   {"type":"hello","version":1,"token":"<VOICE_LINK_TOKEN>","node":"voice-node",
    "self_account":{"platform":"discord","id":"<self 帳號 user id>"}}
   ```
2. Core 回 `{"type":"welcome","session":"<ulid>"}`。token 錯誤時用 close code `4401` 關閉;版本不符用 `4400`。
3. 同一個 `self_account` 只允許一條連線,新的連線會取代舊的(舊的用 `4409` 關閉)。
4. 心跳:Core 每 15 秒送 `{"type":"ping"}`,node 回 `{"type":"pong"}`;45 秒沒回應就斷線。

## Core → Node

| type | 欄位 | 說明 |
|---|---|---|
| `join` | `guild`, `channel?`, `user_id?` | 進語音。給 `channel` 就進那個頻道;只給 `user_id` 就進那個人目前所在的頻道(node 看得到 voice state) |
| `leave` | `guild` | 離開該伺服器的語音 |
| `play_start` | `play`(u32), `guild`, `sample_rate`, `levels?` | 開始一段播放;接著用二進位訊框送音訊。`levels: true`:這段播放另外帶一條**嘴型音軌**(`0x03`,例如歌曲的人聲),嘴型跟它走而不是跟播出的音訊走(舊的 node 會忽略) |
| `play_end` | `play` | 這段音訊送完了。Node 播完緩衝裡的音訊後回 `playback` `finished` |
| `play_stop` | `play`, `fade_ms` | 立刻停止(插話 / barge-in),淡出 `fade_ms` 毫秒 |
| `golive_start` | `guild`, `source`, `channel?`, `width?`, `height?`, `fps?`, `bitrate_kbps?`, `encoder?`, `audio?`, `listen?` | 開始 Go Live,見下面〈Go Live〉 |
| `golive_stop` | `guild` | 停止 Go Live |
| `watch_start` | `guild`, `user_id` | 開始看某人的 Go Live,見下面〈看直播〉 |
| `watch_stop` | `guild` | 結束觀看 |
| `watch_snapshot` | `id`(u32) | 要一張目前畫面 |
| `ping` | | |

二進位 `0x02`(播放音訊):`[0x02][play: u32 LE][PCM s16le 單聲道 …]`。

二進位 `0x03`(嘴型音軌,只用在 `levels: true` 的播放):`[0x03][play: u32 LE][PCM s16le 單聲道 …]`,取樣率同 `sample_rate`。Core 把每個 `0x03` 訊框送在**同長度**的 `0x02` 訊框之前,node 依序對齊;缺的部分當靜音,超過緩衝上限的丟掉。

## Node → Core

| type | 欄位 | 說明 |
|---|---|---|
| `joined` | `guild`, `channel` | 已進入語音頻道 |
| `left` | `guild`, `reason?` | 已離開(被踢、頻道刪除、`leave`…) |
| `voice_state` | `guild`, `channel`, `participants[]` | 進頻道時送一次,之後成員有變動就送。`participants` 每筆:`user_id`, `display_name`, `is_self`, `muted`, `deafened` |
| `speaking` | `guild`, `user_id`, `speaking`(bool) | Discord 的說話開始 / 結束訊號 |
| `stream_open` | `stream`(u32), `guild`, `channel`, `user_id`, `display_name`, `sample_rate`(16000) | 某人開始說話,開一條音訊串流 |
| `stream_close` | `stream` | 這個人停止說話(Discord 停止送封包);可以當作斷句的提示 |
| `playback` | `play`, `state`(`started` / `finished` / `interrupted` / `failed`), `error?` | 播放狀態 |
| `golive` | `guild`, `state`(`starting` / `live` / `stopped` / `failed`), `error?`, `reason?` | Go Live 狀態,見下面〈Go Live〉 |
| `watch` | `guild`, `user_id`, `state`(`starting` / `live` / `stopped` / `failed`), `reason?`, `error?` | 觀看狀態,見〈看直播〉 |
| `watch_snapshot_failed` | `id`, `error` | 這張截圖沒拿到 |
| `error` | `message` | 非致命錯誤(例如進頻道失敗) |
| `pong` | | |

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
| `source` | 必填。`rtmp://` / `rtmps://`、`srt://`、`udp://`、`rtsp://`、`http(s)://`、`file://` 或本機檔案路徑。其他(`pipe:`、`concat:`、`-` 開頭…)一律拒絕。 |
| `channel` | 在哪個語音頻道直播。省略 = 她目前在的頻道;她不在任何頻道又沒給 `channel` 就 `failed`。給了但她不在那個頻道,node 會先進去(hybrid 模式)。 |
| `width` `height` `fps` `bitrate_kbps` | 輸出規格,省略時用 node 的設定(預設高 1080、60 fps、6000 kbps,寬度依來源比例)。超出範圍(寬/高 16~7680/4320、fps 1~120、碼率 100~100000)回 `failed`,不會默默夾住。只給 `width` 時高度依比例。 |
| `encoder` | `auto`(預設:`h264_nvenc` 真的開得起來就用,否則 x264)/ `nvenc` / `software`。要求 `nvenc` 但開不起來時退回 x264(node 日誌會有警告)。 |
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

## 看直播

她看朋友的 Go Live:Core 送 `watch_start`,node 接收該直播的影像與聲音,Core 定期要截圖,串流聲音另外送回。

二進位(node → Core):

| 訊框 | 格式 | 說明 |
|---|---|---|
| `0x04` | `[0x04][id: u32 LE][JPEG]` | 回應 `watch_snapshot` 的截圖,`id` 同請求 |
| `0x05` | `[0x05][PCM s16le 單聲道 16 kHz]` | 串流聲音,每框 20 ms。**沒有 id**,因為同時只看一場 |

規則:

- `0x05` 和人聲的 `0x01` 完全分開,不進 `Listener`,不觸發插話。
- JPEG 長邊最多 1280,上限 900 KB(Core 的單則上限是 1 MiB):超過就降品質重編一次,還是超過就回 `watch_snapshot_failed`。
- 同一個 self 帳號同時只看一場;已在看別人時 `watch_start` 會先停舊的再接新的。
- 她在 Go Live 時,`watch_start` 回 `failed`;看直播時開始 Go Live 會先停止觀看。
- 開播者關播、她離開語音、被踢時,node 送 `stopped`。
- Core 連線斷掉時,node 立刻停止觀看(和 Go Live 不同,Go Live 會繼續推流)。
- 舊版 node 會忽略這些訊息;Core 等 `live` 超過 15 秒就視為失敗。

## 嘴型音量(不在這個協定裡)

voice node 另外把**實際送去 Discord 的 PCM**(重新取樣成 48 kHz 之後、跟播放對時;帶嘴型音軌的播放改用那條音軌,一樣套用淡出)每 10 ms 算一次 RMS,推給 Stage 的 `STAGE_LEVELS_URL`(預設不啟用,例如 `ws://127.0.0.1:7883/levels`):`{"t":<播放開始起算的 ms>,"rms":0..1}`。`t` 是該 10 ms 視窗的起點、跟音訊自己的時間軸走(補靜音時照樣前進),每段播放從 0 開始;播放結束或被打斷送一筆 `rms: 0`。`rms` 是相對滿刻度的真正 RMS(一般說話約 0.05~0.2),`STAGE_LEVELS_GAIN` 可放大。Stage 沒開時安靜地重連,不影響語音。

---

# 推論 Worker HTTP 介面(v1)

`workers/` 底下的 ASR / TTS 服務(Python),對應 `@miyoria/speech` 的 `http-worker` provider。

## ASR:`POST /asr`

- 請求:`multipart/form-data`,欄位 `audio`(WAV,PCM s16le 單聲道,任意取樣率)、`language`(可選)、`prompt`(可選)。
- 回應:
  ```json
  {"text":"早安","language":"zh","emotion":"happy","audio_events":["laughter"],"duration_ms":1234}
  ```
  `emotion` 和 `audio_events` 是可選欄位(SenseVoice 有,Qwen3-ASR 沒有)。

## TTS:`POST /tts`

- 請求(JSON):
  ```json
  {"text":"哼,才不是在等你呢。","language":"Chinese","emotion":"annoyed","instruct":"不耐煩、拖長音","voice":"deepseek-chan"}
  ```
- 回應:`200`,`Content-Type: audio/L16; rate=24000; channels=1`,body 是**串流**的原始 PCM s16le(chunked transfer)。標頭 `X-Sample-Rate` 一定要有。Worker 應該在產生第一段音訊後就開始送。
- `voice` 是 worker 端註冊好的聲音名稱(例如由參考音檔建立的 clone prompt)。

## 讓出顯示卡:`POST /offload`、`POST /reload`(TTS、ASR)

歌曲 worker 轉換時要整張顯示卡(12 GB 的卡上跟 TTS / ASR 一起跑會慢 10 倍以上),所以 `tts/` 和 `asr/` worker 可以暫時放掉模型:

- `POST /offload`(JSON 可省略):`{"reason"?: "sing", "max_s"?: 900}` → `{"state":"offloaded","offload_ms":…,"vram_before_mb":…,"vram_after_mb":…}`。整個模型(TTS 還有 CUDA graphs 和聲音的 prompt)丟掉、`torch.cuda.empty_cache()`。正在合成的那一句會先做完。CUDA graphs 綁在當初的記憶體位址上,不能搬到 CPU 再搬回來,所以是刪掉、之後重建。
- 放掉期間 `POST /tts`、`GET /voices`、`POST /asr` 都回 **`503 {"error":"offloaded"}`**(不會自動重新載入:那樣就不算讓出了);`GET /health` 仍是 `status: "ok"`,多 `offloaded: true`、`reason`、`since`、`reload_at`。
- `POST /reload` → `{"state":"ready","reload_ms":…}`:跟啟動一樣重建(TTS:權重、CUDA graphs、聲音 priming;ASR:模型 + 暖機)。重複呼叫回 `already: true`。
- 保險:放掉超過 `max_s`(`TTS_OFFLOAD_MAX_S` / `ASR_OFFLOAD_MAX_S`,預設 900 秒,0 = 不會)沒人叫 reload 就自己載回來(歌曲 worker 當掉也不會讓她永遠沒聲音)。
- Core 端:錯誤訊息有 `offloaded` 的 ASR / TTS 失敗只記 debug,不是警告。

## 歌曲 Worker(`workers/sing`,預設 `127.0.0.1:8005`)

`@miyoria/sing` 用的翻唱服務:點歌 → 下載(yt-dlp)或本機歌庫 → 人聲分離(Demucs)→ Seed-VC 歌聲轉換成她的聲音 → 混音,一次只做一個工作,做好的歌快取在 `data/songs/<id>/`。

- `POST /jobs`(JSON):`{"query"|"url"|"path": "...", "title"?, "artist"?, "pitch"?, "key"?: 0, "force"?: false, "exclusive_ack"?: false}`,三選一。`url` 只接受 `SING_URL_HOSTS` 的網域;`path` 是歌庫裡的相對路徑。`pitch` 是人聲移調(半音,省略 = 自動挑八度),`key` 是整首轉調(伴奏跟著移;給了 `key` 就不做自動轉調)。回 `{"job": Job}`;已經做過的歌(同一個查詢 / 連結 / 檔案與同樣的音高設定)直接回 `state: "done"`、`cached: true`。
- `GET /jobs/{id}` → `{"job": Job}`;`DELETE /jobs/{id}` 取消。`Job`:`id`、`state`(`queued` / `running` / `done` / `failed` / `cancelled`)、`stage`(`resolve` / `download` / `exclusive` / `separate` / `convert` / `mix` / `lyrics` / `video`)、`progress`(0..1)、`error`、`song_id`、`source`、`position`、`song`(做好時的 meta)、`video`(`{state, progress, error}`,在抓影片時)、`exclusive`(`null` / `waiting` / `offloading` / `active` / `reloading` / `done`)與 `exclusive_info`(`{offloaded, errors, exclusive_wait_s?, offload_s, reload_s?}`)。
- **獨佔顯示卡**(`SING_OFFLOAD_URLS`,例如 `http://127.0.0.1:8002,http://127.0.0.1:8003`,預設不開):從第一個用 GPU 的階段(分離,沒有就轉換)開始,先對每個 URL `POST /offload`,轉換一結束(成功、失敗、取消都一樣)就 `POST /reload`;reload 跟混音、歌詞平行跑,工作要等它們回來才算結束(她的開場白才有聲音)。某個 worker 放不掉就跳過它(記在 `exclusive_info.errors`)。`exclusive_ack: true` 的工作在 offload 前先停在 `exclusive: "waiting"`(`stage: "exclusive"`),等 Core `POST /jobs/{id}/exclusive`(她說完「我去準備一下歌喔」)或 `SING_EXCLUSIVE_WAIT_S`(30 秒)。
- `GET /songs`、`GET /songs/{id}` → meta:`title`、`artist`、`duration_s`、`lyrics`(`{synced, lines: [{t, text}]}` 或 `null`,來自 lrclib.net)、`play`(`{sample_rate: 48000, samples}`)、`pitch`(`octave_shift`、`auto_key`、`song_key`、`vocal_shift`、`source_median_hz` / `source_top_hz`、`target_note`、`ceiling_note`、`top_after_note`、`f0_clean`、`transposer`)、`timings`、`peak_vram_mb`、`has_video` / `video` / `video_error`。
- `GET /songs/{id}/files/{name}`:`mix.wav`、`vocals.wav`、`instrumental.wav`、`lyrics.lrc`、`video.mp4`(本機歌庫可能是 `video.mkv` 等),以及 Core 串流用的 `play_mix.pcm` / `play_vocals.pcm`(PCM s16le 單聲道 48 kHz,標頭 `X-Sample-Rate`)。
- `GET /library` → `{"entries": [{path, title, artist, split}]}`(`split` = 資料夾裡已經有 `vocals.*` + `instrumental.*`)。
- 標題、歌手、歌詞都來自 YouTube / lrclib / 點歌的人,Core 一律當不可信資料。

## 共通

- `GET /health` → `{"status":"ok","model":"...","device":"cuda:0"}`
- 錯誤用 4xx / 5xx 加上 `{"error":"..."}`。
