# 歌詞卡 + 唱歌 worker 不佔顯示卡 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 唱歌時在語音頻道的文字聊天放一張「當下這一句」的歌詞卡;歌詞比較抓得到;唱歌 worker 閒置時不佔顯示卡。

**Architecture:** Core 端:`PlatformSink` 加選用的 `edit`,Discord sink 用 PATCH 實作;`packages/sing` 新增 `LyricsCard`(內容 + 節奏),由 `singer.ts` 接上既有的 song cue。Worker 端:`lyrics.py` 重試與補找;新增 `gpu_child.py` 讓 separate / f0 / convert 在每個工作一個的 spawn 子行程裡執行。

**Tech Stack:** TypeScript (Node 24, vitest, zod, discord.js REST)、Python 3.11 (FastAPI, multiprocessing, pytest)。

**Spec:** `docs/superpowers/specs/2026-11-03-sing-lyrics-card-gpu-child-design.md`

## Global Constraints

- 所有改動在 `yeci` 分支;上游行為不變:`[modules.sing] lyrics_card` 預設 `false`、`SING_GPU_CHILD` 預設 `0`。
- 卡片編輯最小間隔 1.5 秒(常數 `MIN_EDIT_MS = 1500`);沒換句時每 10 秒更新進度(`PROGRESS_MS = 10_000`)。
- 卡片文字:`🎵 **{歌名}** — {歌手}` / `## {句子 | 🎶 | (沒找到歌詞)}` / `` `{m:ss} / {m:ss}` ``;唱完 `✅ 唱完了:**{歌名}** — {歌手}`;其他結束 `⏹️ 沒唱完:**{歌名}** — {歌手}`。
- 不可信文字(歌名、歌手、歌詞)去換行、跳脫 markdown(`\ * _ ~` 反引號 `| > # [ ]`、行首 `-`),每項最多 200 字;訊息最多 2000 字。
- 卡片 / 編輯失敗只記 `warn` 並停用這張卡,絕不往外丟錯、不影響唱歌。
- lrclib:5xx / 429 / 連線錯誤最多 3 次(間隔 1 秒、3 秒);快取補找間隔 10 分鐘(`lyrics_checked_at`)。
- 子行程模式下主行程不 import torch;`SING_KEEP_MODELS=1` 時忽略 `SING_GPU_CHILD`;取消後 10 秒沒結束就 `terminate()`。
- TS 測試:`corepack pnpm --filter <pkg> test`;Python 測試:`workers/.venv-sing/Scripts/python.exe -m pytest`(在 `workers/` 下,先 `uv pip install --python .venv-sing/Scripts/python.exe pytest`)。

## Review Focus

- 歌詞含 `@everyone`、`<@123>`、`**`、`#` 開頭 → 不會 @ 到人、不會變粗體或標題(Task 1、Task 2 測試)。
- 歌還沒 `started` 就被跳過(只收到 `ended`)→ 不送任何訊息、不丟錯(Task 2 測試)。
- 送卡回 403(bot 沒權限在那個語音頻道發言)→ 卡停用、`onCue` 之後的呼叫都不碰 sink(Task 2 測試)。
- 結束後還有排好的計時器 → 結束後絕不再編輯(下一首歌用新卡,舊卡不會蓋到新卡)(Task 2 測試)。
- 子行程在 convert 中途死掉 → 工作失敗、`_give_gpu_back` 仍執行讓 TTS / ASR 載回(Task 5 測試)。

---

### Task 1: Discord 可以編輯訊息

**Files:**
- Modify: `packages/types/src/platform.ts`(`PlatformSink`)
- Modify: `packages/discord/src/sink.ts`(`RestLike`、`DiscordSink`)
- Test: `packages/discord/test/sink.test.ts`

**Interfaces:**
- Produces: `PlatformSink.edit?(message: MessageRef, text: string, signal?: AbortSignal): Promise<void>`;`RestLike.patch?(route, options?): Promise<unknown>`。

- [ ] **Step 1: 寫失敗的測試** `it("edits a message's text without pings")`:`FakeRest` 加 `patch` 記錄;`await sink.edit({ context: TEXT_CTX, id: "222" }, "hi @everyone <@&9>")`;斷言路由是 `Routes.channelMessage(<channel>, "222")`、body `allowed_mentions` 等於 `{ parse: [] }`、`content` 不含 `@everyone` 原樣(等於 `filterOutgoing` 的結果)、超過 2000 字時 `content.length === 2000`。另一個 `it("edit without rest.patch throws DiscordSendError")`。
- [ ] **Step 2: 跑測試確認失敗** `corepack pnpm --filter @miyoria/discord exec vitest run test/sink.test.ts` → FAIL(`sink.edit is not a function`)。
- [ ] **Step 3: 實作** `platform.ts` 加選用方法與 JSDoc;`sink.ts` 加 `patch?` 到 `RestLike`、`async edit(message, text, signal)`,用 `channelOf`、`snowflake(message.id, "message")`、`inContext("editing message …")`,截到 `MAX_MESSAGE_LEN`。
- [ ] **Step 4: 跑測試確認通過** 同上指令 → PASS;再跑 `corepack pnpm --filter @miyoria/discord test` 全過,`corepack pnpm --filter @miyoria/types exec tsc --noEmit` 無錯。
- [ ] **Step 5: Commit** `git commit -m "local(discord): PlatformSink.edit, Discord PATCH without pings"`

### Task 2: LyricsCard(內容 + 節奏)

**Files:**
- Create: `packages/sing/src/lyrics-card.ts`
- Modify: `packages/sing/src/index.ts`(export)
- Test: `packages/sing/test/lyrics-card.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `PlatformSink.send` / `edit`;`SongCue`(`@miyoria/types`);`SongMeta`(`./client.js`)。
- Produces:
  - `renderCard(view: CardView): string`,`CardView = { title: string; artist: string | null; line: string | null; lyrics: "synced" | "none"; elapsedMs: number; durationMs: number | null; ended: "finished" | "stopped" | null }`(`line === null` 且 `lyrics === "synced"` 顯示 🎶)。
  - `class LyricsCard { constructor(d: { sink: Pick<PlatformSink, "send" | "edit">; context: ContextKey; song: SongMeta; clock: Clock; log: Logger }); onCue(cue: SongCue): void; }` —— `onCue` 不 await、不丟錯;內部自己排程。
  - 常數 `MIN_EDIT_MS = 1500`、`PROGRESS_MS = 10_000`。

- [ ] **Step 1: 寫失敗的測試(內容)**:`renderCard` 的 6 個案例 —— 有歌手、沒歌手(沒有 ` — `)、`line: null` + synced → `## 🎶`、`lyrics: "none"` → `## (沒找到歌詞)`、`ended: "finished"` → 開頭 `✅ 唱完了:`、`ended: "stopped"` → `⏹️ 沒唱完:`;`line: "# **@everyone**\n- x"` → 結果裡沒有未跳脫的 `**`、沒有換行在句子裡、`#` 與 `-` 被跳脫;進度 `elapsedMs: 84_000, durationMs: 238_000` → `` `1:24 / 3:58` ``;250 字的句子被截到 200 字。
- [ ] **Step 2: 寫失敗的測試(節奏,`vi.useFakeTimers()` + `systemClock`)**:
  - `started` → `send` 1 次;0.2 秒內連送 3 個 `line`(a、b、c)→ 1.5 秒後只 `edit` 1 次,內容含 `c`、不含 `a`/`b`。
  - 兩次 `edit` 的時間差都 ≥ 1500 ms。
  - 沒有 `line` 時,`started` 後 10 秒有一次進度 `edit`。
  - `ended {outcome:"finished"}` → 最後一次 `edit` 含 `✅ 唱完了`;之後 `vi.advanceTimersByTime(60_000)` 不再有 `edit`。
  - 只收到 `ended`(沒有 `started`)→ `send`、`edit` 都 0 次。
  - `send` reject(403)→ 之後的 `line`、`ended` 都不呼叫 `edit`,`log.warn` 1 次,測試裡沒有 unhandled rejection。
  - `edit` reject → 卡停用,之後不再 `edit`。
- [ ] **Step 3: 跑測試確認失敗** `corepack pnpm --filter @miyoria/sing exec vitest run test/lyrics-card.test.ts` → FAIL(找不到模組)。
- [ ] **Step 4: 實作** `lyrics-card.ts`:`renderCard` 純函式;`LyricsCard` 存 `ref | null`、`desired: CardView`、`lastEditAt`、`timer`、`inFlight`、`dead`;`flush()` 依 `MIN_EDIT_MS` 排程、只送最新、一次一個;進度計時器每 `PROGRESS_MS`;`ended` 取消計時器、等滿間隔做最後一次後設 `dead`。`started` cue 的 `duration_ms` 優先於 `song.duration_s`。
- [ ] **Step 5: 跑測試確認通過** 同上 → PASS;`corepack pnpm --filter @miyoria/sing test` 全過。
- [ ] **Step 6: Commit** `git commit -m "local(sing): LyricsCard renders the current lyrics line and paces its edits"`

### Task 3: 接上唱歌流程 + 設定

**Files:**
- Modify: `packages/sing/src/config.ts`(加 `lyrics_card: z.boolean().default(false)`,JSDoc 一行)
- Modify: `packages/sing/src/singer.ts`(`#sing` 建卡、`cue` 同時送 `#cue` 與 `card.onCue`;`#ended` 的 `ended` cue 也交給卡)
- Modify: `miyoria.example.toml`(`[modules.sing]` 註解區加 `# lyrics_card = false   # 唱歌時在語音頻道的文字聊天放一張歌詞卡(只顯示當下這一句)`)
- Test: `packages/sing/test/module.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `LyricsCard`;`PlatformSinksKey`(`@miyoria/types`)取 `voiceContext(guild).platform` 的 sink。
- Produces: 設定鍵 `[modules.sing] lyrics_card`。

- [ ] **Step 1: 寫失敗的測試**:沿用 module.test.ts 唱一首歌的既有流程,提供一個假 `PlatformSink`(記錄 `send`/`edit`):`lyrics_card: true` 時唱完後 `send` 1 次、最後一次 `edit` 含 `✅ 唱完了`;`lyrics_card: false`(預設)時 `send`、`edit` 都 0 次;sink 沒有 `edit` 方法時也 0 次。
- [ ] **Step 2: 跑測試確認失敗** `corepack pnpm --filter @miyoria/sing exec vitest run test/module.test.ts` → FAIL。
- [ ] **Step 3: 實作** 依 Files 所列;卡只在 `lyrics_card && sink?.edit && voiceContext(guild) !== null` 時建立,存在 `#playing` 的 entry 上,`#ended` 用完即丟。
- [ ] **Step 4: 跑測試確認通過** `corepack pnpm --filter @miyoria/sing test` 全過;`corepack pnpm -r --filter @miyoria/sing --filter @miyoria/discord --filter @miyoria/types exec tsc --noEmit` 無錯。
- [ ] **Step 5: Commit** `git commit -m "local(sing): [modules.sing] lyrics_card posts the lyrics card while she sings"`

### Task 4: 歌詞比較抓得到(worker)

**Files:**
- Modify: `workers/sing/lyrics.py`(`lookup(title, artist, duration, *, query=None, attempts=3, backoff=(1.0, 3.0), sleep=time.sleep, …)`)
- Modify: `workers/sing/server.py`(`_RealAdapter.lyrics` 與 `MockBackend.lyrics` 都改成 `(src, duration, query)`;快取命中補歌詞)
- Test: `workers/tests/test_sing.py`

**Interfaces:**
- Produces: `lookup(..., query: str | None = None, attempts: int = 3, backoff: tuple[float, ...] = (1.0, 3.0), sleep: Callable[[float], None] = time.sleep)`;meta 新欄位 `lyrics_checked_at`(epoch 秒)。

- [ ] **Step 1: 寫失敗的測試**(假 httpx client,用 `httpx.MockTransport`,`sleep` 傳記錄用的 lambda):
  - `test_lyrics_retries_after_503`:第 1 次 503、第 2 次 200 有 synced → 回傳 `synced is True`,sleep 被呼叫 `[1.0]`。
  - `test_lyrics_gives_up_after_3_attempts`:一直 503 → `None`,請求數 3,sleep `[1.0, 3.0]`。
  - `test_lyrics_no_retry_on_404_or_empty`:404 或 `[]` → 請求數 1(加上原本有 artist 時的 `q=` 補查)。
  - `test_lyrics_falls_back_to_query`:標題、歌手都回 `[]`,`q=櫻之詩` 回結果 → 用到 `query`。
  - `test_cached_song_without_lyrics_gets_them_later`:mock 模式先做一首「沒歌詞」的歌(讓 mock backend 的 `lyrics` 回 `None`),再把 `lyrics_checked_at` 改成 11 分鐘前、讓 `lyrics` 回結果、再點同一首 → `meta["lyrics"]["synced"] is True`、`lyrics.lrc` 存在;10 分鐘內再點不會呼叫 `lyrics`。
- [ ] **Step 2: 跑測試確認失敗** `cd workers && .venv-sing/Scripts/python.exe -m pytest tests/test_sing.py -k lyrics -v` → FAIL。
- [ ] **Step 3: 實作** `lookup` 把每個 `c.get` 包進小的重試函式(只在 5xx、429、`httpx.TransportError` 重試);沒結果且有 `query` 時用 `q=query` 再查。`server.py` 的 `run_job` 快取命中分支:`meta.get("lyrics") is None` 且 `now - meta.get("lyrics_checked_at", 0) > 600` 時呼叫 `b.lyrics(src, duration, req.query)`,寫檔並 `store.write_meta`;新做的歌也寫 `lyrics_checked_at`。mock backend 的 `lyrics` 簽名一起改。
- [ ] **Step 4: 跑測試確認通過** `cd workers && .venv-sing/Scripts/python.exe -m pytest tests/test_sing.py -v` 全過。
- [ ] **Step 5: Commit** `git commit -m "local(sing worker): retry lrclib, search by the request, refill cached songs' lyrics"`

### Task 5: GPU 步驟在子行程裡做

**Files:**
- Create: `workers/sing/gpu_child.py`
- Modify: `workers/sing/server.py`(`run_job` 在 `SING_GPU_CHILD=1` 時用 `GpuChild` 包住 backend 的 GPU 方法,`finally` 關閉;`_peak_vram_*` 改用子行程回報值;`/health` 子行程模式不碰 torch)
- Modify: `workers/sing/engine.py`(`RealBackend.__init__` 的裝置偵測延到第一次用到時,讓主行程不 import torch)
- Modify: `workers/README.md`(環境變數表加 `SING_GPU_CHILD`)
- Test: `workers/tests/test_sing_gpu_child.py`、`workers/tests/fake_gpu.py`

**Interfaces:**
- Produces:
  - `class GpuChild: __init__(self, factory: str = "engine:make_real_backend"); separate(src, vocals_out, inst_out, progress); f0_stats(mono, sr) -> tuple[float, float] | None; ref_f0() -> float | None; convert(vocals_wav, out_wav, shift, progress, check) -> None; peak_vram_mb() -> int | None; close() -> None`。
  - `engine.make_real_backend() -> RealBackend`(頂層函式,子行程用):照 `server.py` `lifespan` 的方式用 `SING_DATA_DIR` / `SING_LIBRARY_DIR` 建 `Store(root, lib)`,再 `RealBackend(store)`。
  - 包裝點:`server.py` 的 `_RealAdapter` 持有 `self.b`(`RealBackend`);子行程模式下 `_RealAdapter` 改持有 `GpuChild`,只把 `separate` / `f0_stats` / `ref_f0` / `convert` 轉過去,其他(下載、mix、lyrics、video)仍在主行程。
  - 子行程協定(`Pipe`):主 → 子 `("call", name, args)`;子 → 主 `("progress", f)` / `("done", result)` / `("error", message)`;取消用 `multiprocessing.Event`。
- `f0_stats` 的 `mono` 是 numpy 陣列:經 Pipe pickle 傳送(數秒到數分鐘的單聲道,可接受)。

- [ ] **Step 1: 寫失敗的測試**(`fake_gpu.py` 提供 `make()` 回一個假 backend:`convert` 分 5 段呼叫 `progress`、每段檢查 `check()`,另有 `crash` 模式在第 3 段 `os._exit(1)`):
  - `test_child_runs_and_reports_progress`:`GpuChild("fake_gpu:make").convert(...)` 回傳後,progress 收到 5 個遞增值,輸出檔存在。
  - `test_child_cancel_stops_it`:`check` 在第 2 段後回 True → 丟 `Cancelled`,子行程在 10 秒內結束。
  - `test_child_crash_fails_the_job`:`crash` 模式 → 丟 `JobError`,`close()` 後子行程不在。
  - `test_job_gives_gpu_back_when_child_dies`:`SING_GPU_CHILD=1` + 假 backend crash,跑一個工作 → job `state == "failed"`,而且 `_give_gpu_back` 被呼叫(monkeypatch 記錄)。
  - `test_main_process_does_not_import_torch`:`SING_GPU_CHILD=1` 跑完一個假工作後 `"torch" not in sys.modules`(在乾淨的子直譯器裡用 `subprocess` 執行,避免測試本身已 import)。
- [ ] **Step 2: 跑測試確認失敗** `cd workers && .venv-sing/Scripts/python.exe -m pytest tests/test_sing_gpu_child.py -v` → FAIL(找不到 `gpu_child`)。
- [ ] **Step 3: 實作** `gpu_child.py`:spawn context、頂層 `_child_main(conn, cancel, factory)`;`GpuChild` 第一次呼叫才啟動;`close()` 送結束訊號、`join(10)`、逾時 `terminate()`。`server.py` 依開關選擇;`SING_KEEP_MODELS=1` 時不用子行程。
- [ ] **Step 4: 跑測試確認通過** `cd workers && .venv-sing/Scripts/python.exe -m pytest tests -v` 全過(含既有 mock 測試)。
- [ ] **Step 5: Commit** `git commit -m "local(sing worker): SING_GPU_CHILD runs the GPU stages in a child process"`

### Task 6: 部署與驗收

**Files:**
- Modify: `start-voice-stage.bat`(Sing 那行加 `set SING_GPU_CHILD=1&& `,保持 CRLF:用 Python 改)
- Mac(不進 git):`~/miyoria/miyoria.toml` 的 `[modules.sing]` 加 `lyrics_card = true`(先備份 `.bak8`)

- [ ] **Step 1: 全部測試** `corepack pnpm -r test` 與 `cd workers && .venv-sing/Scripts/python.exe -m pytest tests -v` 全過。
- [ ] **Step 2: 同步 Mac** `git push -f mac yeci:refs/heads/yeci-incoming`;Mac `git checkout -B yeci yeci-incoming && git branch -D yeci-incoming`;改 `miyoria.toml`;`pm2 restart miyoria`;log 無 level 50。
- [ ] **Step 3: 請使用者重開 Windows 的 Sing 視窗**(或整個啟動檔),確認 `/health` 正常。
- [ ] **Step 4: 驗收(使用者在語音裡點一首有同步歌詞的歌)**:卡片出現在語音頻道的文字聊天、每句更新、唱完變 `✅ 唱完了`;Mac log 沒有 Discord 429;做完歌後 Windows `\GPU Process Memory(*)\Dedicated Usage` 中 worker 主行程 ≤ 150 MB;TTS 量一次 12 秒的話 ≤ 12 秒做完。
- [ ] **Step 5: Commit** `git commit -m "local: launcher turns on SING_GPU_CHILD"`
