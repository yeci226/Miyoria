# 技術決策、風險與待確認問題

> 搭配 [ARCHITECTURE.md](ARCHITECTURE.md) 閱讀。標 **🧪** 的項目要在 Phase 0 用實測決定,目前只是預設候選。

## 1. 技術選型

| 領域 | 選擇 | 理由 / 備案 |
|---|---|---|
| 語言 / 執行環境 | **TypeScript 5.9(strict、ESM)+ Node 24**,pnpm 9 workspace(2026-11 從 Rust 原型改寫,見 ADR 13) | 原生 `fetch`、`AbortSignal`、`node:sqlite`;Core、Stage、voice node、面板、SDK 同一種語言 |
| HTTP / SSE API | Hono(`@hono/node-server`)+ zod 驗證;typed client 在 `@miyoria/api` | Panel 與 CLI 共用同一套路由;沒有另外產生 OpenAPI |
| 節點間連線 | WebSocket + JSON(音訊用二進位訊框),`ws` | 2026-11-01 改:原本規劃 gRPC,但在 Windows 要裝 protoc;WebSocket 夠用而且 TS 節點好寫 |
| DB | **SQLite(`node:sqlite`)**,只有這一種 | 2026-11 改:預設不必裝資料庫,`pnpm dlx miyoria init` 就能跑。2026-11-14 V5 拿掉 PostgreSQL(見 [design/v5-data.md](design/v5-data.md) D1):它從沒對真資料庫測過,也沒有事件紀錄的實作,Core 是一台機器上的一個行程 |
| 中文全文檢索 | `@node-rs/jieba` 斷詞,SQLite 用 FTS5 | jieba 有預編譯的原生套件,不用編譯 |
| 嵌入模型 | 可選:任何 OpenAI 相容的 `/embeddings` 端點(Ollama / LM Studio 跑 bge-m3,或雲端) | 不設也能用(全文 + 新舊 + 重要度);SQLite 在 JS 端算 cosine |
| Discord bot 帳號 | discord.js(跑在 Core) | 文字、指令 |
| Discord self 帳號 🧪 | TS voice node:`discord.js-selfbot-v13` 登入 + **`@discordjs/voice`**(透過 selfbot 的 `voiceAdapterCreator`)收發語音 + `@dank074/discord-video-stream` 負責 Go Live | 讀過套件原始碼:selfbot 內建語音沒有 DAVE;`@discordjs/voice` 有 DAVE 且每人一條串流;video-stream 有 DAVE 但不能收音。同一帳號能否同時收音 + Go Live 待 spike 驗證 |
| 指令 / 設定精靈 | 自己寫的小型指令解析器 + `@clack/prompts` | 繁中說明、`--yes` 給腳本用 |
| 設定 | TOML(`smol-toml`)+ `${VAR}` 內插 + 每個模組一份 zod schema(轉成 JSON Schema 給面板產生表單) | |
| Prompt 模板 | persona 是 Markdown 段落,情境段落是程式內建的模板字串 | 沒有模板引擎,persona 作者只要寫 Markdown |
| MCP | `@modelcontextprotocol/sdk`(官方 TS SDK) | client 與 server 都支援 |
| OBS | `obs-websocket-js`(obs-websocket v5) | |
| VTube Studio | 自己寫的薄 client(`packages/stage/src/vts.ts`,走 `ws`) | API 很小,自己控制比較好處理嘴型時序 |
| 音訊 | voice node:`@discordjs/voice`、`opusscript`(純 WASM Opus)、`prism-media`、自己寫的重取樣;Core 只處理 PCM | 直播機不用裝 ffmpeg 就能收發語音 |
| VAD | 目前每人能量 VAD;Silero VAD 待做 | |
| ASR 🧪 | 兩個主要候選對打:**SenseVoice-Small**(sherpa-onnx、CPU 就能跑、附情緒 / 笑聲等事件標記)vs **Qwen3-ASR-0.6B / 1.7B**(2026-01 開源,Apache-2.0,52 種語言與方言、單一模型支援串流與離線、準確度較高,但要 Python + vLLM、吃 GPU)。Whisper large-v3-turbo 當第三選擇;雲端備援 | 都以 Python worker(`workers/`)接入;判斷標準見下方「ASR 選型」 |
| TTS 🧪 | 首選候選 **Qwen3-TTS**(2026-01 開源,Apache-2.0,0.6B / 1.7B;中日英同一模型;串流首包宣稱 97ms;3 秒聲音複製;VoiceDesign 可以用文字描述「設計」聲音)。對照組 GPT-SoVITS(微調動漫角色聲音最成熟)、CosyVoice、IndexTTS2;雲端備援 | 以獨立 worker 服務接入 |
| 繁簡轉換 | OpenCC(`opencc-js`),ASR 輸出與 TTS 輸入都經過 | 多數中文模型偏簡體輸出;她的文字要維持 zh-TW |
| LLM 抽象 | 自己定義的薄介面(`@miyoria/llm/llm`)+ OpenAI 相容 provider(直接用 `fetch` 打 HTTP) | 能精細控制 prompt caching 與串流工具呼叫;DeepSeek 的 `reasoning_content` 另外處理 |
| 日誌 / 指標 | pino(一個 root logger,`MIYORIA_LOG_LEVEL`);Prometheus 文字格式的 `GET /metrics`(自己寫的小 registry) | OpenTelemetry 待做 |
| Panel | React + Vite + TanStack Query/Router,深色極簡(用 impeccable skill) | 生態最大 |
| 擴充執行環境 | Node(預設)/ Deno / Bun / 原生執行檔 | 跨行程 JSON-RPC |
| TS 工具 | pnpm workspace、TypeScript strict、Biome(lint + format)、Vitest、tsx(開發時直接跑原始碼)、esbuild(打包 npm 套件 `miyoria`) | |
| 型別共享 | 事件、動作、store 紀錄、API 型別定義在 `@miyoria/types` / `@miyoria/api`,Core 端套件直接 import | 面板、overlay、voice node 目前各自保留一份對應的型別 |

### ASR 選型

Phase 0 用你朋友在 Discord 的真實錄音測(台灣腔中文、夾日英、遊戲用語、多人搶話):

- **選 Qwen3-ASR**:如果 0.6B 在 4070S 上每段話的延遲 ≤ 300ms、跟遊戲 + TTS 一起跑 VRAM 夠用,而且準確度明顯比較好。這時 SenseVoice 可以留在 CPU 上專門做情緒 / 笑聲偵測(可選)。
- **留 SenseVoice**:如果 Qwen3-ASR 太吃 GPU,或準確度差距不大。

### TTS 選型(Qwen3-TTS 的注意事項)

- 有 instruction 控制(用「開心地說」這類文字控制情緒)的是 **CustomVoice / VoiceDesign**;**Base(聲音複製)沒有 instruction 控制**,情緒只能靠文字語意。要「自己的聲音 + 情緒控制」,可能要用官方的 fine-tuning 流程微調。
- **VoiceDesign → Clone** 流程:先用文字描述設計出 Miyoria 的聲音,再拿那段音當複製的參考音。沒有參考音檔的話很適合,也不會有拿真人聲優聲音的授權問題。
- 要 PyTorch + FlashAttention 2,在 Windows 原生安裝很麻煩,建議 worker 跑在 WSL2 / Docker。
- 97ms 是官方宣稱的數字,要在 4070S 上跟遊戲同時跑實測。
- **串流**:官方 `qwen-tts` Python 套件沒有串流 API。兩條真串流路線:
  - **原生 Windows(預設)**:`workers/tts` 用社群套件 [faster-qwen3-tts](https://pypi.org/project/faster-qwen3-tts/)(CUDA Graph + 串流,官方有 Windows 安裝腳本;作者在 RTX 4060 Windows 上量到 1.7B 首包約 460 ms、RTF 1.83)。
  - **WSL2 / Docker**:vLLM-Omni(`kind = "vllm-omni"`;vLLM 團隊在 H20 上量到首包約 70 ms)。
  - `qwen-tts` 的逐句合成留作最後的備案。
- 之後可以再接 vLLM-Omni 的 `/v1/audio/speech/stream` WebSocket,把 LLM 生成的文字一邊產生一邊送進去,連「等一句講完」都省掉。

## 2. 重要架構決策(ADR 摘要)

1. **Module + 事件匯流排 + service registry**,module 之間不直接依賴。理由:能啟停、能熱換、測試時可以 mock。
2. **節點主動往外連 Core**:直播機在 NAT 後面也能用,server 不需要開額外連入埠給直播機。
3. **擴充套件跨行程**,不在 Core 行程裡載入:擴充崩潰或卡住不會拖垮整個 Core,也能用任何語言寫;JSON-RPC 讓 TS 成為一等公民。
4. **遊戲用雙速控制**:LLM 只做高階決策與實況,即時操作交給 adapter。
5. **工具權限以觸發者為準**,好感 / 權限不能被對話修改:防 prompt injection 的核心。
6. **記憶有隱私範圍**:跨伺服器共享人格,但不洩漏私人內容。
7. **語音預設不存原始音訊**。
8. **單一 CLI 多子指令**(`miyoria core|stage|chat|...`,npm 套件 `miyoria`):散佈、版本對齊都簡單;Core 與 Stage 的程式用動態 `import()` 延後載入,`init` / `config` 啟動很快。
9. **Discord 雙帳號、單一大腦**(2026-11-01,擁有者決定並自負風險;2026-11-07 重申,見 ADR 14):bot 帳號負責文字與指令,self 帳號負責語音與 Go Live。兩條連線都不存狀態,資料全部在 Core;Scheduler 依 lane 路由動作。self 連線是可以拔掉的獨立節點,壞了只影響語音與 Go Live。
10. **角色 = profile,模型綁在 profile 上**:Miyoria 是框架,角色是 profile(人格 + LLM + 聲音 + 模型)。所有資料從第一天就帶 `profile_id`,之後加角色不用搬資料。
11. **Minecraft 走客戶端模組**:她開真正的 Minecraft 客戶端,Fabric 橋接模組(Java)以 Baritone(+ AltoClef)提供技能與反射,透過本機 WebSocket 給 TS adapter 用;畫面就是她的遊戲視窗。mineflayer(fork minecraft-mcp-server)當備案。LLM 只下高階目標,不直接操作底層動作。
12. **Profile = 一個完整角色**(人格 + LLM + 聲音 + Live2D);profile 內的人格段落可以在執行期修改(有版本紀錄)。LLM 的用途設定叫 `purposes`(避免跟對話 role、權限 role 混淆)。
13. **從 Rust 改寫成 TypeScript**(2026-11):Phase 0–8 的 Rust 原型(留在 git 歷史裡)改寫成 pnpm workspace 裡的 `@miyoria/*` 套件,module id、設定鍵、事件 topic、JSON 格式與預設值都照舊,舊的測試一併移植。
    - **為什麼**:voice node、面板、overlay、SDK、擴充本來就是 TS,Core 也改成 TS 之後只剩一種語言、一套工具(型別、測試、lint)與一個 lockfile;Discord(discord.js)、MCP、OBS 的官方 / 主流函式庫都在 Node 生態;散佈變成 `pnpm dlx miyoria@latest init`,不用裝 Rust 工具鏈或下載各平台執行檔。效能瓶頸在 LLM 與語音推論(遠端 / Python worker),不在 Core。
    - **Node 24 + pnpm 9**:Node 24 內建 `node:sqlite`、`fetch`、`AbortSignal.any`、`util.parseEnv`,少掉一批依賴;pnpm workspace 讓每個子系統是獨立套件(module 之間只能透過 `@miyoria/runtime/kernel` 的事件與 service registry 溝通),開發時 `tsx` 直接跑原始碼(`@miyoria/source` 匯出條件),發佈時用 esbuild 打成單一套件。
    - **SQLite 預設、Postgres 選用**:個人使用不必先架資料庫,資料是一個檔案(`data/miyoria.db`,好備份);`node:sqlite` 是內建的,不需要原生編譯。取代舊決策「只支援 Postgres」。2026-11-14 V5 再改成只留 SQLite(見 [design/v5-data.md](design/v5-data.md) D1)。
    - **WebSocket + JSON 連線**:voice link、stage link、Admin API 的 SSE 都是純文字 / JSON(音訊用二進位訊框),瀏覽器與 Node 都能直接用,不需要 protoc 或程式碼產生;協定文件在 `docs/protocols/`。
14. **語音與 Go Live 留在 self 帳號,不移到 bot**(2026-11-07,擁有者決定並自負風險):重申並確定 ADR 9 的雙帳號做法。擁有者了解 Discord 禁止 self-bot、處分可能及於 bot 和 developer 帳號,仍然選擇維持現狀。
    - **範圍**:V3 以後不做 bot 語音、不退役 self 帳號;她可以自己開 Go Live(自主開台維持現有做法)。ADR 9 與 R2 裡「bot 可用 songbird 接手只說不聽」的備案因此不是計畫,只是可能的退路。
    - **失效時**:self 帳號失效時語音與 Go Live 一起停,文字 bot 與指令不受影響(self 連線是可拔掉的獨立節點)。
    - **來源**:[design/v3-architecture.md](design/v3-architecture.md) §14.1、§19 第 1 項、§21;該版本的調查報告建議過移到 bot,這個建議被擁有者否決。

## 3. 風險

| # | 風險 | 影響 | 對策 |
|---|---|---|---|
| R1 | **Discord 語音 E2EE(DAVE 協定)**:Discord 已經推行語音端對端加密,self-bot 函式庫收語音、推 Go Live 都要支援 | 語音與 Go Live 卡住 | Phase 0 第一個 spike 就驗證候選函式庫能不能在 DAVE 下分別接收每個人的音訊、送出音訊、推流。不行就評估其他函式庫或自己補 DAVE(`@discordjs/voice` 的實作可參考) |
| R2 | **Self 帳號被封 / 函式庫失效**:self-bot 違反服務條款;Discord 改協定時函式庫常壞 | 語音與 Go Live 停擺 | 用專用小帳號、不用主帳號;self 帳號不發文字、行為保守;掉線時自動降級(文字照常,bot 可用 songbird 接手「只說不聽」);Go Live 同時可推 Twitch / YouTube 當備案。擁有者已知悉並自負風險;2026-11-07 擁有者再次決定留在 self 帳號、不移到 bot(ADR 14),所以 bot 接手只是退路,不是計畫 |
| R3 | **12GB VRAM 不夠**:遊戲 + OBS 編碼 + ASR + TTS 同時跑 | 卡頓、OOM | LLM 走雲端;ASR 選小模型(SenseVoice-Small 約 1GB 以內);TTS 實測 VRAM;OBS 用 NVENC;必要時 ASR 改在 server CPU 或雲端 |
| R4 | **語音延遲**:split 部署時音訊要在兩台機器間來回 | 對話不自然 | self voice node 跟 ASR/TTS 放同一台直播機;全程串流;第一句先出聲 |
| R9 | **Go Live 吃資源**:self voice node 用 ffmpeg 轉碼,跟遊戲、OBS 搶 GPU / CPU | 卡頓 | 盡量用 NVENC;直接吃 OBS 已編碼的串流避免重複編碼(spike 驗證) |
| R5 | **LLM 成本**:ambient 模式在熱鬧的伺服器會一直判斷 | 帳單爆炸 | 三層 attention(便宜的先篩)、prompt caching、預算硬上限、自動降級 |
| R6 | **人格漂移 / 記憶污染**:被使用者灌輸錯誤事實 | 人格崩壞 | facts 有來源與信心值;self memory 只能由系統寫入;Panel 可以審核 / 回滾 |
| R7 | **範圍太大做不完** | 專案停擺 | 每個 phase 都有可以實際用的成果;先做出「會聊天的 Discord bot」,再加語音 |
| R8 | **語音隱私與法規**:收錄他人語音 | 被檢舉、法律問題 | 公告、使用者同意、預設不存音訊、資料刪除權 |
| R10 | **Minecraft 版本綁定**:Baritone / AltoClef 各自只支援特定版本(AltoClef 目前最高 1.21.1) | 遊戲更新後模組不能用 | 直播用的客戶端固定版本,不跟著自動更新 |
| R11 | **角色名稱用到 DeepSeek 商標** | 公開營利時可能有商標疑慮 | 個人使用沒問題;要公開營利再評估是否改名 |

## 4. 已確認(2026-11-01)

- **LLM**:擁有者自己處理 API;第一個角色用 DeepSeek。預算與模型選擇由擁有者決定。
- **第一個角色**:鯨魚娘 DeepSeek-chan,有點傲嬌的少女。設定在 `profiles/deepseek-chan/`。
- **Live2D 模型**:Kamiya_Ryoko 的免費 DeepSeek-chan 模型。可用於商業內容、可修改,但不可原樣再散佈 → 模型檔只放本機。
- **聲音**:沒有參考音 → 用 Qwen3-TTS VoiceDesign 依描述生成,再固定成 clone 的參考音。
- **第一款遊戲**:Minecraft,走客戶端模組路線(見 ARCHITECTURE §12.4)。
- **直播平台**:目前只做 Discord;Twitch / YouTube 等做成可開關的 platform module,之後再加。
- **說話風格**:不刻意用台灣用語;會自然夾雜 baka、hentai 這類動漫日文。

## 5. 待你確認的問題

這些不會擋住 Phase 0 / Phase 1,但越早決定越好:

1. **Server**:後端要放哪裡(VPS / 家用 server / NAS)?有沒有 GPU?
2. **開源與授權**:只自己用就維持私有,不用選。要公開時再從 MIT / Apache-2.0(寬鬆)或 AGPL-3.0(別人改了拿去架服務也要公開)選一個。注意 Baritone 是 LGPL-3.0,Minecraft 模組散佈時要遵守。
3. **Panel 框架**:預設 React,可以接受嗎?
