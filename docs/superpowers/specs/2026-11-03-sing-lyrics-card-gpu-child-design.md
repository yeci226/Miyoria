# 唱歌打磨:歌詞卡 + 唱歌 worker 不佔顯示卡

日期:2026-11-03 · 分支:`yeci`(本機,不送回上游) · 狀態:設計,待審

## 目標

1. **歌詞卡**:她在語音裡唱歌時,語音頻道內建的文字聊天有一張卡,只顯示當下這一句(加歌名、進度),
   換句就編輯同一則訊息;唱完改成「唱完了」留著。
2. **抓得到歌詞**:lrclib 偶爾回 503 時重試,也用點歌時打的名字找;已做好但沒歌詞的歌,下次點時再找一次。
3. **唱歌 worker 平常不佔顯示卡**:現在做完一首歌後,worker 行程還留著約 2.1 GB 的 CUDA 環境,
   和 TTS(2.5 GB)、ASR 一起把 8 GB 顯示卡擠爆,TTS 掉到比即時慢一倍,她說話一卡一卡。
   改成用 GPU 的步驟在子行程裡做,做完子行程結束,記憶體跟著還回去。

成功標準:

- 唱一首有同步歌詞的歌,卡片每句更新、不觸發 Discord 429、唱完變成「✅ 唱完了」。
- 唱歌時卡片出錯不影響唱歌本身。
- worker 閒置(做完歌之後)時,Windows「GPU 專用記憶體」計數器顯示 worker 行程 ≤ 150 MB。
- 現有測試全過;新功能有測試。

不做:翻譯歌詞、整首歌詞、Stage overlay 的改動、Mac 端任何新行程。

## 1. 歌詞卡(Core,TypeScript)

### 1.1 送出與編輯訊息

- `packages/types/src/platform.ts`:`PlatformSink` 加選用方法
  `edit?(message: MessageRef, text: string, signal?: AbortSignal): Promise<void>`。
  選用,其他平台不用實作;沒有 `edit` 的平台就不出卡。
- `packages/discord/src/sink.ts`:`RestLike` 加選用的 `patch`;`DiscordSink.edit` 用
  `PATCH Routes.channelMessage(channel, id)`,body `{ content, allowed_mentions: { parse: [] } }`,
  內容先過 `filterOutgoing`,超過 2000 字截斷。不 @ 任何人(跟送訊息一樣的最後防線)。
- 出卡用既有的 `send`(`reply_to: null`),拿回 `MessageRef` 之後只用 `edit`。

### 1.2 卡片內容(`packages/sing/src/lyrics-card.ts`,新檔,純函式 + 小狀態機)

```
🎵 **{歌名}** — {歌手}
## {當下這一句 | 🎶(間奏、前奏) | (沒找到歌詞)}
`{已唱 m:ss} / {總長 m:ss}`
```

- 唱完(`outcome = finished`):`✅ 唱完了:**{歌名}** — {歌手}`
- 跳過 / 中斷 / 出錯:`⏹️ 沒唱完:**{歌名}** — {歌手}`
- 歌名、歌手、歌詞都來自 YouTube / lrclib,是不可信的資料:去掉換行、在 Discord markdown 字元前加反斜線
  (反斜線、星號、底線、波浪號、反引號、直線、大於、井號、方括號,以及行首的減號),每項最多 200 字。
  沒有歌手(`SongMeta.artist` 是 null)就省略「— 歌手」。

### 1.3 更新節奏

- `started` cue → 送出卡片(大字位置:有同步歌詞時先放 🎶,沒有就是「(沒找到歌詞)」)。
- `line` cue → 記下「想顯示的內容」,排程更新:距上次編輯 ≥ 1.5 秒就馬上編,否則在滿 1.5 秒時編;
  期間又換句只留最新的(不排隊)。同時最多一個編輯在進行。
- 沒換句時,每 10 秒更新一次進度。
- `ended` cue → 取消排程,等滿最小間隔後做最後一次編輯,之後不再動。
- 任何送出 / 編輯失敗:記一筆 `warn`,這首歌的卡片就停用;唱歌照常。
- 時間一律用注入的 `Clock`(`ctx.clock`),方便用假時鐘測試。

同一頻道 Discord 大約每 5 秒能改 5 次;這裡最多每 1.5 秒一次,加上她自己的 `text_echo` 訊息仍在限制內。

### 1.4 接線(`packages/sing/src/singer.ts`、`config.ts`)

- 設定:`[modules.sing] lyrics_card`(boolean,預設 `false`,行為跟上游一樣);Mac 的 `miyoria.toml` 設 `true`。
- `#sing()` 開始前:`lyrics_card` 為真、`voiceContext(guild)` 有值、平台 sink 有 `edit` 時,建立
  `LyricsCard`(帶 `SongMeta` 的歌名、歌手、歌詞是否同步)。
- 傳給 `singSong` 的 `cue` 改成同時交給 `#cue`(原本的 bus 事件,不變)和 `card.onCue`。
- `#ended()` 發出的 `ended` cue 一樣經過 `card.onCue`,卡片在那裡收尾。

### 1.5 測試(vitest)

- `lyrics-card.test.ts`:內容格式(有 / 沒有歌手、沒歌詞、間奏、markdown 跳脫、截斷);
  假時鐘下的節奏(連續快速換句只編最新一句、最小間隔 1.5 秒、10 秒進度、結束後不再編輯);
  `send` 或 `edit` 丟錯時卡片停用、不往外丟錯。
- `discord` 的 sink 測試:`edit` 打對路由、body 不含 mention 權限、內容有過濾。
- `sing` 的 singer 測試:`lyrics_card = false` 時完全不呼叫 sink。

## 2. 抓得到歌詞(song worker,Python)

- `workers/sing/lyrics.py` `lookup()`:HTTP 5xx / 429 / 連線錯誤最多試 3 次(間隔 1 秒、3 秒);
  4xx 和「沒結果」不重試。新增參數 `query: str | None`:標題 / 歌手都找不到時,再用 `q=<query>` 找一次。
- `server.py`:`b.lyrics(src, duration)` 帶入 `req.query`。
- 快取命中(`cached is not None`)而 `meta["lyrics"]` 是空的、距上次找(`meta["lyrics_checked_at"]`)
  超過 10 分鐘:再找一次,找到就寫 `lyrics.lrc` 並更新 `meta.json`;不管有沒有找到都更新 `lyrics_checked_at`。
- 測試(pytest,mock lrclib client):503 後成功、一直 503 回 None 且只試 3 次、用 query 補找、
  快取命中補歌詞。

## 3. 唱歌 worker 不佔顯示卡(song worker,Python)

### 3.1 做法:GPU 步驟在子行程裡做

會用到 GPU 的步驟只有三個,都在同一個工作裡:`separate`(Demucs)、`_auto_shift` 用的
`f0_stats` / `ref_f0`(RMVPE)、`convert`(Seed-VC)。

- 新檔 `workers/sing/gpu_child.py`:`GpuChild` 代理物件,方法跟 `RealBackend` 這三個一樣。
  第一次被呼叫時用 `multiprocessing` 的 spawn 開一個子行程,子行程裡建一個 `RealBackend` 執行;
  工作結束(`run_job` 的 `finally`)時關掉子行程。一個工作一個子行程。
- 參數與結果:檔案路徑、數字、dict(都可 pickle),音檔照舊寫在磁碟上。
- 進度:子行程把 `progress(f)` 經 `Pipe` 傳回,主行程照舊呼叫 `_set(job, …)`。
- 取消:主行程的 `check()` 發現取消時設 `multiprocessing.Event`,子行程在每段轉換之間檢查;
  10 秒內沒結束就 `terminate()`。
- 子行程掛掉(例外、OOM、被殺):主行程收到錯誤字串,當成這個工作失敗(跟現在一樣的錯誤路徑),
  並確保 `_give_gpu_back` 照常把 TTS / ASR 載回來。
- `peak_vram_mb`:由子行程量好回報,寫進 `meta.json`(取代主行程的 `_peak_vram_*`)。
- 主行程完全不 import torch:`RealBackend.__init__` 的裝置偵測搬進子行程;`/health` 的
  `vram_allocated_mb` 在子行程模式下回報 0(主行程本來就沒有)。
- 開關:環境變數 `SING_GPU_CHILD`(預設 `0`,行為跟上游一樣);`start-voice-stage.bat` 設 `1`。
  `SING_KEEP_MODELS=1` 時忽略 `SING_GPU_CHILD`(兩者互斥:要留模型就得留在同一個行程)。

代價:每首歌多一次子行程啟動與 import torch,約 5–10 秒;模型本來就是每階段載入,所以沒有額外損失。

### 3.2 測試

- pytest:用假的 GPU backend(不需要 GPU)跑子行程模式:結果正確、進度有傳回、取消會停、
  子行程丟錯時工作失敗且 `_give_gpu_back` 有被呼叫;mock 模式的既有測試照過。
- 手動驗收(Windows):做一首歌後,`\GPU Process Memory(*)\Dedicated Usage` 裡 worker 主行程 ≤ 150 MB;
  做歌期間 TTS / ASR 照舊被借走再載回。

## 4. 部署

- 全部 commit 在 `yeci` 分支;Windows 改完、測完,`git push mac yeci`,Mac `git checkout` 後重開 Core。
- Mac `miyoria.toml`:`[modules.sing] lyrics_card = true`。
- Windows `start-voice-stage.bat`:Sing 那行加 `SING_GPU_CHILD=1`。
- 上游有更新時:`git fetch origin && git rebase origin/main`(在 `yeci` 上)。

## 5. 風險

- Discord 的實際限制以回應標頭為準;若仍遇到 429,discord.js REST 會排隊重試,卡片只是慢一點,
  最小間隔可以調大(先寫成常數,有需要再做成設定)。
- Windows 的 spawn 會重新 import 主模組:子行程入口要放在 `gpu_child.py` 的頂層函式,不能依賴 `server.py` 的全域狀態。
- lrclib 本身不穩:重試只能改善,不保證每首都有歌詞;沒歌詞時卡片照樣顯示歌名與進度。
