# V5 管家:階段 2 的設計

> 2026-11-15。兩份唯讀盤點(CLI 和啟動邏輯、服務之間的連線)寫成的設計。**2026-11-16 實作完成並合併(PR #55),線上已經切換過去**;還沒做的收尾在 [backlog.md](backlog.md)。前半是結論、owner 的決定和工作順序;「Design detail」之後是實作用的細節(英文)。上層的規劃見 [v5-architecture.md](v5-architecture.md) 的 §4、§5、§15 和 §16 第 20 項;套件的選擇見 [v5-packages.md](v5-packages.md) §12、§13。

## 現在的樣子

- **啟動有兩套**:`up`(前景、隱藏子行程)和 `start`(Windows Terminal 分頁)共用一份計畫,但「健康」「已經在跑」「埠被占用」各寫各的,規則不同;啟動前的檢查也不同。兩者都不會重啟死掉的服務,`start` 連停止都沒有。別的指令找不到 `up` 啟動了什麼(沒有 PID 檔、沒有狀態)。
- **服務是寫死在程式裡的七個名字**(asr、tts、sing、turn、core、voice-node、stage),每個服務的差異用 `switch` 分散在安裝、檢查、VRAM 估計裡。lyrics、MediaMTX、ComfyUI 完全沒有被表示,要手動啟動。
- **埠號預設值至少在六個地方**。ASR 有 8001 和 8003 兩個預設,看你怎麼啟動。
- **位址寫在各模組的設定裡**:`speech.*.url`、`modules.voice.turn_url`、`modules.sing.url` 和 `fallback_urls`、`modules.imagegen.url`、`modules.live.video`、`stage.core_url`,加上語音節點的 `.env`。換一台電腦要改好幾處。
- **所有 Python worker 都沒有認證**,靠綁在 loopback 或 Tailscale 位址。voice link、stage link、管理 API 各有一個寫在設定檔的固定 token。
- **顯卡記憶體有兩條各自為政的路**:唱歌 worker 自己呼叫 TTS 和 ASR 的 `/offload`(位址由 CLI 用 `SING_OFFLOAD_URLS` 塞進去),Core 的生圖模組在唱歌事件時自己叫 ComfyUI 釋放。昨晚遇到的兩個 `start sing` 問題都出在第一條路的位址怎麼算。
- **Python 環境沒有 lock 檔**:`python -m venv` 加沒有釘版本的 `pip install`,`update` 不會動 Python 這邊。
- **lyrics 服務自己讀 `miyoria.toml` 和 `.env`** 來拿 LLM 的金鑰。(2026-11-16 補註:H8 已改掉。hostd 啟動的翻唱 worker 和 lyrics 服務不再讀 `miyoria.toml`:要 LLM 時經 hostd 請 Core 代跑(`cluster.llm`,用途 `fast`),ASR 抽查經 `cluster.fetch`;沒有 hostd 時只用 `SING_LYRICS_LLM_URL` / `_KEY` / `_MODEL` 三個環境變數。)
- **已經有的**:CLI 的 npm 套件會把 Core、面板和角色包打包進去,CI 會把打包好的檔案裝起來跑 `init`;kernel 的 Supervisor 有退避和放棄的算法;擴充協定有一份對稱的 JSON-RPC 實作。

## 設計的結論

- **每個服務一份 `service.toml`**,放在服務自己的資料夾。名字、提供什麼能力、怎麼裝、怎麼跑、健康怎麼看、怎麼重啟、要多少顯卡記憶體,全部在這一份。埠號預設值只在這裡。程式裡不再有服務名稱的 `switch`。
- **每台電腦一個 hostd**(新套件 `packages/hostd`,用 `miyoria hostd` 執行)。它照 `host.toml` 和描述檔啟動服務、探測健康、退避重啟、寫輪替的日誌、分配埠、發 token、仲裁顯卡記憶體。CLI 的 `up`、`down`、`restart`、`status`、`logs` 都只是對 hostd 說話。`up --foreground` 保留:不經常駐程式,直接在終端機跑同一套監管。
- **Core 多一個 `cluster` 模組**:hostd 對它撥一條有認證的 WebSocket(控制連線),回報這台有哪些服務、位址、健康、顯卡。它維護登記處。其他模組改成問登記處要「asr」,設定裡不再有位址。沒有 hostd 管的服務(例如朋友那台還沒升級前的翻唱服務)只在一個地方寫成靜態登記。
- **一份協定**:JSON-RPC 2.0,和擴充協定用同一份實作,多一個 WebSocket 傳輸。本機的 CLI、這台的服務、Core 都用同一張方法表對 hostd 說話。
- **加入**:`host invite` 產生十分鐘有效的一次性代碼,`host join` 換成這台專屬的金鑰;這台宣告的能力要再核可一次才會被使用。
- **token**:hostd 每次啟動服務都發一個新的 token 給它,並經控制連線告訴 Core;Core 呼叫 worker 時帶上。worker 之間不再互相呼叫,要顯卡、要別的服務的位址、要用 LLM 都問本機的 hostd。
- **LLM 金鑰不離開 Core**:lyrics 要模型時經 hostd 請 Core 代跑,花費照樣記在每天的預算和呼叫紀錄裡。
- **顯卡記憶體**:hostd 持有租約表。唱歌和生圖向它要,它決定共用、請語音讓出、還是排隊,並在用完或持有者死掉時把語音載回來。Core 把「有沒有人在語音、有沒有在直播」送給 hostd,不再送給唱歌 worker。
- **別人從零架一套**:`npm i -g miyoria`、`miyoria init`、`miyoria up`。沒有顯卡時是只有文字的模式(只跑 Core)。worker 的原始碼跟著 npm 套件走,所以不用 clone repo。
- **階段結束時刪掉**:`start`、`up` 自己的啟動器、`install` 的 pip 步驟、`[stack]` 和 `[machine]`、各模組設定裡的位址、`SING_OFFLOAD_URLS`、Core 對唱歌 worker 的 `/gpu/context` 推送、生圖模組自己叫 ComfyUI 釋放的接線、lyrics 讀設定檔的程式。

## owner 的決定(2026-11-15)

| # | 事 | 決定 | 影響 |
|---|---|---|---|
| P1 | 不在 tailnet 裡的電腦,工作要不要經控制連線中繼 | **做**(「聽起來會比較 clean」) | 加入的電腦預設就是走中繼,不用設任何網路;要即時語音的服務才另外設直接連的位址。多一步 H5b |
| P2 | Python 環境改用 uv 和 lock 檔 | **改用 uv,這台之後也換** | 新的方式先在乾淨的資料夾裝起來驗證;這台在切換那一步換過去,換之前舊環境留著當退路 |
| P3 | 給別人用的版本要不要有語音 | **要有**。提醒風險,建議用小號 | 安裝文件的語音章節寫明它用的是 self 帳號、可能被停權,建議另外開一個帳號 |
| P4 | 給別人用的版本附哪個角色 | **照舊附 deepseek-chan** | npm 套件不用改。聲音模型和 Live2D 現在本來就不在套件裡,要不要另外提供沒有決定 |
| P5 | Cluster 設定搬進資料庫(§5.6 第 1 點) | **之後的階段做** | 階段 2 只拆出 `host.toml` 並把位址從模組設定拿掉。搬進資料庫排在階段 6,和每個 Space 的設定一起 |
| P6 | 發佈到 npm | **晚點** | 這個階段做到「打包檔裝得起來、CI 會測」為止 |
| P7 | 顯卡仲裁搬多少進 hostd | **全搬**,照建議的做法 | 先把唱歌 worker 現有的判斷錄成對照表,hostd 要逐格相同;舊的路等實際聽過一次語音中點歌才刪 |

## 工作順序

每一步結束時都能跑,並刪掉它取代的東西。H2 和 H3 在 H1 之後同時做,資料夾不重疊。

| 步 | 內容 | 主要資料夾 | 大小 |
|---|---|---|---|
| H1 | `contracts/host`:`service.toml`、`host.toml` 的 schema,協定的方法表,登記處的型別。替現有的每個服務寫描述檔;一個測試確認描述檔和今天 `buildPlan` 算出來的值相同 | `packages/contracts/host`、各服務資料夾 | 中 |
| H2 | `packages/hostd`:描述檔目錄、監管(啟動、停止、退避重啟、健康探測)、輪替日誌、埠分配、狀態資料夾、本機 API、前景模式。CLI 的 `up`、`down`、`restart`、`status`、`logs`。從 `[stack]` 和 `[machine]` 轉出 `host.toml`。刪 `start` 和舊的啟動器 | `packages/hostd`、`packages/cli` | 大 |
| H3 | Core 的 `cluster` 模組:控制連線的伺服端、host 資料表、登記處、靜態登記、事件。JSON-RPC 加 WebSocket 傳輸和共用的連線輔助;hostd 這邊的連線 | `packages/cluster`、`packages/sdk`、`packages/core` | 大 |
| H4 | 各模組改問登記處:語音辨識和合成、斷句和 VAD、唱歌(保留歌跟著 worker 的邏輯)、生圖、直播影像;語音節點和舞台的連線資訊由 hostd 給。刪設定裡的位址 | `packages/voice`、`packages/sing`、`packages/workspace`、`packages/live`、`packages/stage`、`apps/voice-node` | 中 |
| H5 | `host invite / join / ls / approve / remove`;host 金鑰;服務 token(Python 這邊一個共用的檢查,Core 的每個 client 帶上) | `packages/cluster`、`packages/api`、`packages/cli`、`workers` | 中 |
| H5b | 中繼:Core 對某台服務的 HTTP 請求可以改走那台的控制連線(包含大檔案的串流)。加入的電腦沒設對外位址時自動用這條路;唱歌、生圖、歌詞適用,即時語音不適用 | `packages/cluster`、`packages/hostd` | 中 |
| H6 | 安裝:每個 worker 一個 uv 專案和 lock、`add / remove`、`models pull / ls / gc`、`update`(只重裝變了的,一次重啟一個)、`doctor` 的新檢查 | `packages/hostd`、`packages/cli`、`workers/*` | 大 |
| H7 | 顯卡仲裁:(a)對照表;(b)hostd 的租約和 Core 的情境推送,唱歌和生圖改成向 hostd 要;(c)刪 worker 那邊的判斷和 Core 的接線 | `packages/hostd`、`workers/sing`、`packages/workspace/imagegen`、`packages/sing` | 大 |
| H8 | lyrics 變成被管理的服務,LLM 經 Core 代跑;刪讀設定檔的程式 | `workers/lyrics`、`workers/sing`、`packages/cluster` | 小 |
| H9 | 面板的「電腦」頁;`status --all`、`logs --host` | `apps/panel`、`packages/api`、`packages/contracts/api` | 中 |
| H10 | 登入時自動啟動(明確的指令才會設定);`update` 和手動重啟會先問 Core 現在能不能打斷 | `packages/hostd`、`packages/cli` | 小 |
| H11 | 從零架一套:npm 套件帶 worker 原始碼、`init` 改寫(寫 `host.toml`、只有文字的模式)、給外人看的安裝文件、CI 裝起來跑一次 | `packages/cli`、`docs` | 中 |
| H12 | 收尾:刪除清單、`OPERATIONS.md`、`workers/README.md`、朋友那台的升級教學改成 `host join`、backlog | 全部 | 小 |
| 切換 | 這台線上的服務改由 hostd 管,Python 環境換成 uv 管的(舊環境先留著);朋友那台加入。和階段 1 一樣要你在場,動手前給清單 | | |

## 切換那天要注意的事(邊做邊累積)

- **先停掉舊的全部服務**,尤其是語音節點:它沒有埠,hostd 看不到手動啟動的那一個,兩個同時在會讓 self 帳號登入兩次。
- **三個位址不再有預設值**:`[modules.voice] turn_url`、`[modules.sing] url`、`[modules.imagegen] url` 沒寫就是沒有。hostd 回報之後登記處會有它們;在那之前(或 hostd 沒連上時)要靠設定檔明寫。切換前檢查線上設定有沒有靠預設值的。
- **設定檔的位址和 hostd 回報的位址要寫法一致**才會被當成同一個:`localhost` 和 `127.0.0.1` 不算同一個。對不上時會用到沒有 token 的那一筆,worker 開了 token 檢查之後就是 401。
- **Windows 上停服務是直接結束整棵行程樹**,沒有溫和停止,和現在一樣。
- **guard 的預設來源**是 Core 的 `/api/public/status`,要 `[modules.api.public]` 開著才有;控制連線接上之後改由 Core 直接回答。
- **Python 環境**:五個 worker 的 uv 專案已經在暫存資料夾照 lock 裝起來驗證過(torch 2.11.0+cu128,CUDA 可用)。這台換過去時 `host.toml` 先指向舊環境起一次,確認沒問題再一個一個換成 uv 管的。
- **朋友那台**:升級前是靜態登記(沒有 token);升級並加入之後走控制連線。歌詞服務要等 H8 做完才能跨機器帶對 token。
- **7880 埠**:Core 的 `cluster` 模組要用。切換前確認這台沒有別的東西占著。

## 切換清單(2026-11-16)

> 結果:第一段在 2026-11-16 06:34 到 06:40 做完,第 14 步(換成 uv)同一天做了斷句、語音辨識、語音合成三個。owner 測過之後在同一天說階段 2 完成並合併。第 11、12 步(直播時重啟被擋、平時重啟)沒有另外記錄結果;第 13、15、16 步和第 17 步的刪除 PR 還沒做,列在 [backlog.md](backlog.md)。下面是當時的清單,留著當紀錄。

做法和階段 1 一樣:線上的 checkout 先切到這個分支實測,沒問題再合併。每一步做完我會回報,有任何一步不對就照最後的「退回」走。

**開始前(我先確認,不動任何東西)**

- PR #55 的 CI 全綠。
- 她是閒置狀態,沒有在唱歌或直播。
- 你在電腦前,並且可以進語音頻道測試。

**第一段:換過去(她會離線幾分鐘)**

1. 備份:`miyoria.toml`、`.env`、`data/core.db`(三個檔)各複製一份到 `data/backups/`。
2. 停掉舊的全部服務:Core、斷句、語音辨識、語音合成、語音節點、舞台、MediaMTX。語音節點一定要先停,不然 self 帳號會登入兩次。
3. 線上的 checkout 切到這個分支,`pnpm install`,重新建置面板和擴充。
4. `miyoria host migrate --dry-run`,把它印的內容給你看;沒問題再實際執行,產生 `host.toml`。現有的 Python 環境、埠、環境變數都會原樣帶過去,不重裝任何東西。
5. `miyoria add mediamtx --no-install`(舊設定裡沒有它,因為以前是手動啟動)。
6. `miyoria doctor`,有紅字先處理。
7. `miyoria up`。hostd 會依序帶起所有服務,這台會自動登記到自己的 Core。
8. 檢查:`miyoria status` 每個服務都是 running 而且健康;`miyoria host ls` 這台是已核可、已連線;面板的「電腦」頁看得到這台和它的服務。

**第二段:實測(要你在語音裡)**

9. 文字:在 Discord 跟她說話,確認會回。
10. 語音:進語音頻道、她加入、你說話她回應、打斷她、開 Go Live、離開。
11. 守門:她在直播時執行 `miyoria restart core`,應該被擋下並說明原因。
12. 重啟:`miyoria restart core`(不在直播時),確認她回來、語音和直播還在。

**第三段:可以另外挑時間做的**

13. 登入時自動啟動:`miyoria host autostart on`,照清單檢查四點(工作是用你的帳號、沒有視窗、手動觸發能帶起服務、登出再登入後會回來)。
14. Python 環境換成 uv:一次換一個服務。把 `host.toml` 裡那個服務的 `python = ...` 拿掉,`miyoria add <服務>`,重啟它,確認正常再換下一個。舊環境先不刪。
15. 朋友那台升級:照 `docs/sing-remote-host.md`。升級前他那台照舊能用(靜態登記、沒有 token),但歌詞的語音辨識抽查會被擋,因為這台的語音辨識現在要 token。
16. hostd 的顯卡仲裁:需要在這台唱一次歌才能測。要你明確同意暫時讓翻唱回到本機,做法是 `host.toml` 設 `[gpu] arbiter = "hostd"`、在語音裡點一首歌、確認語音有讓出又載回來;退回是改回 `"worker"` 再重啟 hostd。
17. 以上都穩定之後:合併 PR #55,再另開一個 PR 刪掉只為了搬遷留著的東西(`[stack]`、`[machine]`、`host migrate`、設定裡的位址鍵、唱歌 worker 自己的顯卡判斷)。

**退回(任何時候)**

- `miyoria down`。
- 線上的 checkout 切回 `main`,`pnpm install`。
- 把第 1 步備份的 `data/core.db` 三個檔放回去(這個分支會在資料庫加兩張表,舊版程式沒見過)。測試期間的對話紀錄會跟著不見。
- 照舊的方式啟動(`miyoria start`)。`host.toml` 和 `data/host/` 留著不影響舊版。

**還沒被實際驗證過、切換時第一次會遇到的事**

- 真的語音辨識和語音合成經登記處、帶 token 被呼叫(只在暫存資料夾用斷句 worker 實跑過一次)。
- 語音節點和舞台由 hostd 啟動,並從 hostd 拿連線資訊。
- hostd 在 Windows 上停止有子行程的服務(語音節點是經 `pnpm start` 起來的)。
- 這台的 7880 埠有沒有被占用。

## 風險

- **hostd 壞了整台都受影響**。它要小;`up --foreground` 是不經它的退路;切換前線上那套照舊能用 `start` 啟動(H2 刪 `start` 是在分支上,線上換過去是切換那一步)。
- **重裝 Python 環境**可能讓現在能跑的顯卡環境壞掉。見 P2:先在別的資料夾驗證;這台換過去時舊環境不刪,`host.toml` 一行就能指回去。
- **顯卡仲裁重寫**可能讓語音中點歌時卡住或爆記憶體。見 P7:對照表加一次實際測試。
- **token 上線的順序**:Core 和 worker 要同時認得 token。worker 這邊是「有設環境變數才檢查」,所以可以先上 worker、再上 Core,不會有一段時間互相連不上。朋友那台在升級前是靜態登記,沒有 token,和今天一樣只靠 Tailscale。
- **Windows 以外的路沒人跑過**。描述檔和 hostd 不寫死 Windows 的東西(`taskkill`、`wt`、PowerShell 只在平台分支裡),CI 在 Linux 上跑 hostd 的測試;但真的在 Linux 上裝 worker 這個階段不會驗證。

---

## Design detail

The rest is for implementation. Section numbers are referred to from the work briefs.

## 1. Names

| Thing | Name | Where |
|---|---|---|
| Descriptor of one service | `service.toml` | in the service's own folder |
| Per-machine file | `host.toml` | the workspace folder (next to `miyoria.toml` when Core runs here) |
| Daemon | hostd | `packages/hostd`, run as `miyoria hostd` |
| Schemas and method table | `@miyoria/contracts/host` | `packages/contracts/host`, id prefix `Host` |
| Core module | `cluster` | `packages/cluster` |
| Registry class | `EndpointRegistry` | `packages/cluster` (the kernel already has `ServiceRegistry` for in-process handles) |
| Control link | `cluster.link` | Core serves `ws://<bind>/cluster-link`, default bind `127.0.0.1:7880` |

The plan (v5-architecture §12) lists hostd under apps. It is a package here because the published
`miyoria` CLI must contain it, the same way it contains Core.

## 2. `service.toml`

One file per service. Everything a host needs to install, run, probe and stop it. No per-service
branch remains in TypeScript: `importsFor`, `pipSteps`, `estimateVram`, `manualItems`, the `kind`
branches of `buildPlan` and the port tables all become fields.

```toml
name = "asr"
kind = "worker"                  # worker | node | external
provides = ["asr"]               # capability names, v5-architecture §4
platforms = ["win32", "linux"]
summary = "語音辨識(Qwen3-ASR)"

[install]
runtime = "python"               # python | node | binary | none
python = ">=3.11,<3.14"
project = "."                    # folder holding pyproject.toml and uv.lock
extras = ["qwen3"]               # optional-dependency groups to sync
system = ["ffmpeg"]              # programs that must be on PATH: checked, installed only when asked
[[install.models]]               # fetched by `models pull`, into the host's model folder
repo = "Qwen/Qwen3-ASR-0.6B"
revision = "<commit>"
[[install.files]]                # a public model file, downloaded after one question (§9.1)
path = "smart-turn/smart-turn-v3.2-cpu.onnx"   # relative to <state>/models
hf = "pipecat-ai/smart-turn-v3"  # or url = "https://..." on the host allowlist
file = "smart-turn-v3.2-cpu.onnx"
revision = "<40-character commit>"
sha256 = "<hex>"
size = 8_900_000                 # bytes
what = "Smart Turn v3.2(判斷講完)"
licence = "BSD-2-Clause"
optional = true                  # the service runs without it; default false
[[install.manual]]               # placed by a person: checked, never fetched
path = "voices/{voice}"
what = "參考聲音的資料夾"

[run]
command = ["{python}", "server.py"]   # an argument list, never a shell string
cwd = "."
port = 8003                      # preferred port; "auto" takes any free one. hostd reports the real one.
host_env = "HOST"
port_env = "PORT"
env = { ASR_BACKEND = "qwen3", ASR_QWEN_SIZE = "0.6B" }
pass_env = ["HF_*", "CUDA_*"]    # added to the base allowlist; nothing else of the daemon's environment is passed
after = []                       # start after these when they are installed on the same host
guard = []                       # cluster states in which a voluntary restart waits: "singing", "live"

[run.health]
http = "/health"                 # 200 with {"status": "ok"}; `tcp = true` or `process = true` for services without HTTP
startup_s = 180
interval_s = 10
timeout_s = 3

[run.restart]
policy = "on-failure"            # always | on-failure | never
backoff_s = [1, 5, 30]           # the last value repeats
give_up = { failures = 5, window_s = 600 }

[run.stop]
grace_s = 10                     # then the whole process tree is killed

[gpu]
policy = "evictable"             # pinned | evictable | on_demand
vram_mb = { resident = 1500, peak = 2000 }
offload = "/offload"             # POST; evictable and on_demand services only
reload = "/reload"
busy = "/busy"
```

Rules:
- Placeholders in `command`, `env` and paths: `{python}` (the service's environment), `{node}`,
  `{miyoria}` (this CLI's own entry), `{config}` (the Core config path), `{state}`, `{models}`,
  `{service}` (the descriptor's folder), `{port}`, `{host}`. Unknown placeholders are an error at
  load time.
- `kind = "external"` is a program hostd does not own: OBS, VTube Studio, ComfyUI. It has
  `[probe]` instead of `[run.health]`, and an optional `[launch]` that is used only on request.
  It is never restarted automatically and never stopped by `down`.
- `kind = "node"` is a TypeScript service that dials Core itself: `voice-node`, `stage`. hostd
  gives it the link address and token as environment (§6.4).
- A service whose backend has variants (ASR: qwen3 or sensevoice; TTS: faster or qwen-tts) has one
  descriptor for the default. A host that wants the other one overrides `install.extras` and
  `run.env` in `host.toml`.
- One default per value, here and nowhere else. `WORKER_DEFAULT_PORT`, `LEGACY_PORT`,
  `WORKER_DEFAULTS`, the worker's own Python default, `settings.ts` and the example config stop
  carrying ports. The Python default stays as the value used when a worker is run by hand.

Descriptors to write in H1, with today's values:

| name | kind | provides | port | gpu | folder |
|---|---|---|---|---|---|
| `core` | worker | `core` | 7878 (from `[modules.api] bind`) | none | `packages/core` |
| `asr` | worker | `asr` | 8003 | evictable | `workers/asr` |
| `tts` | worker | `tts` | 8002 | evictable | `workers/tts` |
| `turn` | worker | `turn`, `vad` | 8006 | none | `workers/turn` |
| `sing` | worker | `sing` | 8005 | on_demand | `workers/sing` |
| `lyrics` | worker | `lyrics` | 8007 | none | `workers/lyrics` |
| `mediamtx` | worker (binary) | `media` | 9997 (API) | none | `workers/mediamtx` |
| `voice-node` | node | `voice-room` | none | none | `apps/voice-node` |
| `stage` | node | `renderer` | 7884 (overlay) | none | `packages/stage` |
| `comfyui` | external | `imagegen` | 8188 | on_demand | `services/comfyui` |
| `obs` | external | none | 4455 | reserve | `services/obs` |
| `vtube-studio` | external | none | 8001 | reserve | `services/vtube-studio` |

Catalog roots, in source mode: `workers/*/`, `apps/*/`, `packages/core/`, `packages/stage/`,
`services/*/`, later `extensions/*/`. In a packaged install the same relative folders exist inside
the installed `miyoria` package (§11).

## 3. `host.toml`

Written by `init`, `host join`, `add` and `remove`. It holds nothing about other machines except
the cluster address.

```toml
name = "main-pc"

[cluster]
url = "ws://127.0.0.1:7880/cluster-link"
# the host key is in <state>/host.key, readable by this user only

[paths]
state = "data/host"              # envs/, models/, logs/, run/

[network]
bind = "127.0.0.1"               # the address services listen on
# advertise = "main-pc.tailnet"  # set only when other machines should call this one directly

[gpu]
reserve_mb = 2500                # left for OBS, VTube Studio and the desktop

[services.asr]                   # one table per installed service
enabled = true
python = "workers/.venv-asr-qwen"     # use this existing environment; hostd will not manage it
env = { HF_HUB_CACHE = "C:/.../data/models/hf", HF_HUB_OFFLINE = "1" }

[services.sing]
enabled = true
python = "workers/.venv-sing"
```

Without `advertise`, no service of this machine is called directly from outside: Core reaches
them through the control link (§7.1). That is the default for a machine that joins, so joining
needs no network setup. A machine that serves real-time speech to a Core on another machine sets
`bind` and `advertise` to its tailnet address.

State folder layout: `envs/<service>/` (uv-managed), `models/` (with `hf/` as the Hugging Face
cache), `logs/<service>.log` (rotated by size, a fixed number kept), `run/hostd.json`
(`pid`, `port`, `token`, `started_at`; user-only permissions), `host.key`.

`miyoria host migrate` writes a `host.toml` from an existing `[machine]` and `[stack]` so the live
machine keeps its environments, ports and worker environment variables. It is deleted in H12 with
the two sections.

## 4. hostd

One process per workspace folder. Started by `miyoria up` when it is not running (detached, no
window), by the logon task (H10), or in the foreground by `miyoria up --foreground` or
`miyoria hostd`.

Parts:
- **Catalog**: loads and validates descriptors, applies `host.toml` overrides, resolves
  placeholders. An invalid descriptor disables that service and is reported; it does not stop the
  daemon.
- **Supervisor**: per service a small state machine: `stopped → starting → running → stopping`,
  plus `backoff`, `failed` (gave up) and `external`. Spawning and tree-kill through `execa`
  (v5-packages §12). The backoff and give-up arithmetic follows the kernel `Supervisor`
  (`packages/runtime/kernel/src/supervisor.ts`); it is not shared code, the kernel one supervises
  in-process modules.
- **Probes**: HTTP, TCP or process-alive, per descriptor. `starting` becomes `running` on the
  first good probe; a running service that fails three probes in a row is restarted by policy.
- **Ports**: the preferred port when it is free, else a free one for `"auto"`, else the service
  fails with the reason (`in-use`, `denied`, with the WinNAT hint that `checks.ts` has today). One
  implementation; the copies in `up.ts`, `start.ts` and `checks.ts` go.
- **Already running**: decided by hostd's own state first. A service that answers on its port but
  was not started by this hostd is reported as `foreign` and left alone; `up` says so. This
  replaces the command-line scans of `launch.ts`, including the voice node's.
- **Logs**: stdout and stderr of every service to `logs/<service>.log` through
  `rotating-file-stream`; hostd's own log beside them.
- **Environment**: the base allowlist (`workerBaseEnv`) plus `pass_env`, then descriptor `env`,
  then `host.toml` `env`, then what hostd adds: host, port, `MIYORIA_SERVICE_TOKEN`,
  `MIYORIA_HOSTD_URL`, and link values for nodes. Core gets the full environment, as today.
- **Local API**: `127.0.0.1` on a random port. Callers send the token from `run/hostd.json`
  (the CLI) or their own service token (a service).
- **Core link**: §6.
- **GPU**: §8.

Foreground mode runs the same supervisor inside the calling terminal, prints service state
changes, and stops everything on Ctrl+C. It still connects to Core when a cluster is configured.

What a crash does: a service that exits is restarted by its policy without asking anyone.
`guard` applies only to restarts somebody chose: `restart`, `update`, a descriptor or
environment change. Then hostd asks Core (`cluster.guard`); when a guarded state is active the
command reports it and waits, or goes ahead with `--force`.

## 5. Host protocol

JSON-RPC 2.0. On the control link it is the same `Peer` as the extension protocol
(`packages/sdk/src/rpc.ts`); local callers send one request per HTTP call. H3 gives
`Peer` a message transport interface with two implementations: the existing `Content-Length`
framing over streams, and one JSON text frame per message over a WebSocket. Requests in both
directions, `$/cancelRequest`, per-request timeouts stay as they are.

Three kinds of caller reach hostd, all with the same method table (the daemon implements it once,
`HostApi` in `packages/hostd/src/api.ts`):

| Caller | Transport | Authenticated by | May call |
|---|---|---|---|
| CLI on this machine | HTTP `POST /rpc` on the local API; `GET /logs/<service>` streams log lines | the token in `run/hostd.json` | everything |
| A service on this machine | HTTP `POST /rpc` on the local API | its `MIYORIA_SERVICE_TOKEN` | the forwarded `cluster.resolve`, `cluster.llm` and `cluster.fetch`. `gpu.*` comes with H7; hostd does not serve it to a service yet |
| Core | the control link (hostd dialled it) | the host key, in `hello` | `host.*`, `service.*` |

Methods hostd serves:
- `host.info` → name, version, platform, GPU reading, service list.
- `service.list`, `service.start`, `service.stop`, `service.restart` (with `force`),
  `service.logs` (last N lines; with `follow`, lines arrive as `service.log` notifications until
  cancelled).
- `service.install`, `service.remove`, `host.update` (H6).
- `gpu.acquire`, `gpu.renew`, `gpu.release`, `gpu.busy`, `gpu.state` (H7).
- `cluster.resolve`, `cluster.llm`, `cluster.fetch`: forwarded to Core over the link (H5, H8). hostd adds the name of the service that asked (`service`); a service cannot set it itself.

Methods Core serves on the control link:
- `cluster.guard` → the active guarded states.
- `cluster.resolve { capability }` → endpoints with the headers to send.
- `cluster.llm { purpose, messages, max_tokens, temperature, json }` → text. One completion
  through Core's own model and key; counted in the daily budget and written to the call log like
  any other call. The key never leaves Core.
- `cluster.fetch { capability, method, path, headers, body }` → `{ status, headers, body }`. Core
  sends one HTTP request to the first usable endpoint of `capability` and returns the whole answer
  (body base64, each body at most `HOST_FETCH_LIMITS.MAX_BODY_BYTES`, 8 MiB; the response head must
  arrive within `HEAD_TIMEOUT_MS`, 60 s). For small calls such as the ASR spot check.

Who may use `cluster.llm` and `cluster.fetch`: Core decides, never the caller
(`packages/cluster/src/calls.ts`). It checks that the host is approved, that the host's last
report lists the service that asked, that the service provides a capability the host is approved
for, and that the `provides` → `uses` table lets that capability use what is asked for (an LLM
purpose, a capability to fetch from; a purpose must also be on Core's list, default `fast`). The
table `DEFAULT_CLUSTER_USES` is in code and has no config key yet: `sing` and `lyrics` may use the
LLM purpose `fast` and fetch from `asr`; nothing else may use anything. `cluster.llm` is rate
limited per host (30 calls per 60 s by default). The errors are the codes of `HOST_ERROR_CODE`
(`packages/contracts/host/src/protocol.ts`): `NotAllowed` (-32014) for any failed check,
`NotLinked` (-32015) when hostd has no link to Core, `Unavailable` (-32016) when there is no usable
endpoint or no LLM or the call failed, `TooLarge` (-32017) for a body over the limit,
`RateLimited` (-32018) over the `cluster.llm` rate.

Notifications:
- hostd → Core: `host.report` (the full snapshot: on connect, then on every change),
  `service.event` (one state change with its reason and the log tail on failure).
- Core → hostd: `cluster.context { in_voice, listeners, live, urgent }` (H7),
  `cluster.links` (§6.4).

Every params and result shape is a zod schema in `contracts/host`, emitted to
`schema/host.json` under the existing rules (v5-contracts: `.meta({ id })`, no transforms, new
fields optional or defaulted). Method names and error codes are TypeScript constants in
`protocol.ts`.

## 6. The `cluster` module and the registry

### 6.1 Control link

Core serves `/cluster-link` on its own bind (`[modules.cluster] bind`, default
`127.0.0.1:7880`), like the voice and stage links. The first message is
`hello { protocol, host, key, name, platform, version }`; Core answers `welcome` or closes with
the codes the other links use (4400 bad hello, 4401 unauthorized, 4408 timeout, 4409 replaced).
H3 writes the link helper (backoff 1 s to 30 s, heartbeat, close-code policy) for hostd in a form
the voice node and the stage node can adopt (v5-packages §6). Moving those two working clients
onto it is not part of H3; it is listed for H12.

### 6.2 Data

Plugin-owned tables (Drizzle, `StorePlugin`):
- `cluster_hosts`: `id`, `name` (unique), `key_hash` (SHA-256 of a 32-byte random key),
  `status` (`pending`, `approved`, `revoked`), `capabilities` (the approved list, JSON),
  `platform`, `version`, `created_at`, `last_seen_at`.
- `cluster_invites`: `code_hash`, `expires_at`, `used_at`, `created_by`.

Events (through `contracts/events`): `cluster.host.joined`, `.approved`, `.removed`,
`.connected`, `.disconnected`, `cluster.service.state`. Live endpoints are memory only; they are
rebuilt from the next `host.report` after a Core restart.

### 6.3 Registry

`EndpointRegistry`, offered to modules as a kernel service handle:

```ts
interface Endpoint {
  capability: string;
  host: string;                  // host name, or the static entry's name
  service: string;
  url: string;
  headers: Record<string, string>;   // the bearer token, when the endpoint has one
  via: "direct" | "link";            // link: requests travel over the host's control link (§7.1)
  healthy: boolean;
  version: string | null;
}
pick(capability: string): Endpoint | null;        // the first healthy one in order
candidates(capability: string): Endpoint[];       // all, in order, for callers with their own failover
request(endpoint: Endpoint, path: string, init?: RequestInit): Promise<Response>;  // direct fetch, or through the link
failed(endpoint: Endpoint, error: unknown): void; // rests it for a retry period
watch(capability: string, onChange: () => void): Disposable;
```

Module clients call `request` and never build a URL themselves, so the relay of §7.1 needs no
change in them. A WebSocket service (VAD) is direct only: `pick` can be asked for direct
endpoints only.

Order: `[modules.cluster.order] <capability> = ["host-a", "host-b"]`; hosts not listed come after,
healthy before unhealthy. An endpoint from a host that is not `approved` for that capability is
never returned.

Static entries, for services no hostd manages:

```toml
[modules.cluster.static.friend-sing]
provides = ["sing"]
url = "http://100.83.26.41:8005"
# token = "${FRIEND_SING_TOKEN}"   # when that worker checks one
```

This is the only place a service address may appear in the cluster config.

### 6.4 What modules change (H4)

During the move the address keys stay in the config and Core's wiring registers them in the
registry as static entries (v5-architecture §4: the TOML addresses are the static fallback), so
the live config keeps working on the day of the cut-over. Modules never read an address
themselves. A reported endpoint and a static one with the same URL count as one, the reported
one. A default address that the config does not state is not registered: no phantom local
endpoints. The keys and the seeding are deleted in H12, when hostd reports every managed service
and the rest is written under `[modules.cluster.static]`.

MediaMTX is the exception in this phase: it has three ports (API, HLS, RTMP) and the voice
node's encoder uses one of them, so `[modules.live.video]` keeps its addresses. hostd still runs
and probes the process.

| Module | Today | After |
|---|---|---|
| speech (`http-worker` providers) | `speech.asr.<name>.url`, `speech.tts.<name>.url` | the provider names a capability; `url` is removed. The chain order and the "failed provider goes last" rule stay in `SpeechService`; a provider with no endpoint counts as failed |
| voice (turn, VAD) | `modules.voice.turn_url` | `turn` and `vad` from the registry; the silence and energy fallbacks stay |
| sing | `modules.sing.url`, `fallback_urls` | `candidates("sing")`. `FailoverSingWorker` keeps the song-stays-with-its-worker rules and takes its endpoint list from the registry instead of config |
| imagegen | `modules.imagegen.url`, `headers` | `imagegen` from the registry; a proxy token becomes a static entry's token |
| voice node | `VOICE_LINK_URL`, `VOICE_LINK_TOKEN` in its `.env` | hostd passes them; Core sends `cluster.links` to hosts approved for `voice-room` |
| stage node | `[stage] core_url`, `token` | the same, for `renderer` |

`SELF_TOKEN` stays in the voice node's own `.env`: it is that machine's secret.
Speech providers of kind `openai` and `vllm-omni` keep their `url`: they are outside services with
their own keys, not cluster services.

## 7. Joining and tokens (H5)

```
miyoria host invite [--name NAME]      # on the Core machine: prints a code, valid 10 minutes, one use
miyoria host join <core-url> --code ABCD-1234
miyoria host ls | approve <name> [capability...] | remove <name>
```

- `invite` calls the admin API; the code is stored hashed.
- `join` calls `POST /api/cluster/join` (no session; the code is the credential; attempts are
  rate limited per address and per code). The answer is the host id, a new host key and the link
  URL. The key is written to `<state>/host.key`.
- The first `host.report` lists what the host provides. Nothing is used until `approve`.
- The hostd on Core's own machine joins without a code: `init` and `host migrate` create its row
  through the admin API with the admin token, already approved.
- Service tokens: hostd makes a random token for every service start and sends it in
  `host.report`. The registry returns it as an `authorization` header. Python side: one helper,
  `workers/service_auth.py`, a FastAPI dependency that requires the bearer token on every route
  when `MIYORIA_SERVICE_TOKEN` is set, and does nothing when it is not (a worker run by hand).
  hostd's own probes send the token.
- Workers still call their neighbours on the same machine in one place: the sing worker's offload
  calls to TTS and ASR, until H7 lands (the hostd arbiter is written but off; `SING_GPU_ARBITER`
  defaults to `self`). The lyrics code's ASR check no longer is one: under hostd it goes through
  Core (`cluster.fetch` to `asr`, H8). For the offload calls hostd also gives every service of the
  machine one shared `MIYORIA_HOST_TOKEN`, new at each daemon start; a worker accepts its own token
  or the host token, and sends the host token to a neighbour.
- The host id and key live together in `<state>/host.key` as JSON `{ "id", "key" }`.
- `remove` revokes the key, closes the link, drops the host's endpoints.

### 7.1 Relay over the control link (H5b)

Owner decision P1. An endpoint with `via: "link"` is one Core cannot call directly: the host has
no `advertise` address. `registry.request` then sends the HTTP request through that host's
control link and returns a standard `Response` whose body is a stream, so a caller cannot tell it
from `fetch`. Implemented in `packages/cluster/src/relay.ts` (Core), `packages/hostd/src/link/`
(host) and `packages/contracts/host/src/relay.ts` (shapes, frame codec, credit windows).

- **Open.** Core sends the JSON-RPC request
  `relay.request { stream, service, method, path, headers, body, length? }`. `stream` is a number
  unique per connection. `path` starts with `/` and is appended to the address
  `HostApi.target(service)` gives, so the host can only ever call its own services; redirects are
  passed back, never followed. Hop-by-hop headers, `host`, `content-length` and
  `authorization` are not sent: the host adds the service's own token, which never leaves it.
- **Head.** hostd answers `{ status, headers }` as soon as the service's response headers arrive.
  A 404 or a 503 is a response, not an error.
- **Bodies** are binary WebSocket frames on the same socket: `[kind u8][stream u32 LE][payload]`.

  | Kind | Name | Direction | Payload |
  |---|---|---|---|
  | 0x01 | request chunk | Core → host | at most 64 KiB |
  | 0x02 | request end | Core → host | none |
  | 0x03 | response chunk | host → Core | at most 64 KiB |
  | 0x04 | response end | host → Core | none |
  | 0x05 | abort | either | a short reason |
  | 0x06 | credit | either | a byte count |

- **Flow control.** A window of 1 MiB per stream and direction: the sender is never more than the
  window ahead of what the receiver's consumer has read. The receiver sends credit after every
  256 KiB read. A sender also waits while the socket itself has more than 1 MiB queued. Measured
  on a 30 MB download with a slow reader: about 0.6 s, never more than 1 MiB buffered; a reader
  that stops reading stalls only its own stream.
- **Ending.** Before the head, cancelling is `$/cancelRequest`; after it, an abort frame in either
  direction. A dropped link fails every open stream on Core's side and aborts every running
  `fetch` on the host's side, and the caller's own failover applies.
- **Limits.** 16 open streams per host on Core's side (the next call fails at once), 64 as a
  backstop on the host. The head times out after 120 s by default; a body has no timeout beyond
  the link's own liveness. A malformed frame closes the link.
- **Not relayed.** WebSocket upgrades and trailers. Real-time speech (ASR, TTS, the VAD socket)
  asks for direct endpoints only.
- A caller that neither reads nor cancels a large response body keeps a stream slot until the
  link drops, as an unread `fetch` body keeps a connection.

## 8. GPU arbitration (H7)

The current behaviour is specified in [v5-gpu.md](v5-gpu.md) and recorded in
`workers/sing/gpu_decisions.json` (3,172 cases) and `workers/sing/gpu_scenarios.json`
(26 scripted runs of the real job loop on a simulated clock); `workers/tests/test_gpu_table.py`
keeps both in step with the Python. Decisions taken on the open points of that specification
(2026-11-16):

- `gpu.acquire` carries what only the worker knows (stage, whether it can pause, the learned
  need, whether it can run on the CPU, the silence estimate, spill history, job id). hostd keeps
  each job's waits. `mode` is a cap: `share` never evicts speech.
- Before taking her voice hostd answers `wait { code: "announce" }`; the worker waits for Core's
  go (or 30 s) and asks again with `announced: true`. Core's speech pause keeps reading the job's
  `exclusive` field.
- A fourth answer, `refused`, replaces the worker's give-up.
- hostd runs the window's silence clock and ends a window through the answer to `gpu.renew`; the
  worker renews at least every second while a window is open, and reports spills there.
- `gpu.busy` answers `{ busy, allowance_s }` from a 100 ms cache; the pause loop stays in the
  worker.
- hostd holds the speech workers' lease (`max_s` 60, renewed every 20 s); their own reload after
  `max_s` stays as the safety net.
- Decisions use the measured free memory, as today. `[gpu] reserve_mb` is for static checks and
  for a card that cannot be read.
- The worker keeps learning each stage's need and sends it. The sing descriptor's `vram_mb.peak`
  is 4096 to match.
- The oddities the specification lists are reproduced as recorded. Each fix is its own later
  change to the table and the arbiter together. Fixed so far (2026-11-16, v5-gpu §10 items 3, 4
  and 7): the endless wait under `yield`, the backing voices' pass running on the card while
  speech reloads, and the last window closing only at the job's end. Each window's real silence
  is recorded (item 6; the limit itself is unchanged).
- Image generation is not moved in this phase: the module is closed until a model is chosen, and
  moving it changes when ComfyUI unloads. Core's existing wiring stays; the lease API leaves room
  for a `share`-only tenant.
- The worker keeps its own arbitration behind a switch until a song request in a live voice call
  has been heard on the new path.

Today's logic lives in `workers/sing/gpu.py` (policies `yield`, `auto`, `share`, `offload`,
`wait`; limits from about twenty `SING_*` variables), `exclusive.py` (the offload lease against
TTS and ASR) and `yielding.py` (pausing while speech is busy), fed by Core's `/gpu/context` push;
and separately in Core's `ImageGenService`, which frees ComfyUI on sing events.

After H7 hostd is the only arbiter on a machine:
- **Reading**: used and total memory of the device. `nvidia-smi` per read or NVML through `koffi`;
  H7 measures both before choosing (v5-packages §13).
- **Budget**: total minus `[gpu] reserve_mb`.
- **Tenants**: services with `[gpu]`. `pinned` is never asked to leave. `evictable` is resident
  and can be offloaded for a lease (TTS, ASR). `on_demand` holds memory only while it has a lease
  (sing, ComfyUI) and is told to free it after the lease.
- **Lease**: `gpu.acquire { mb, mode: "share" | "exclusive", max_s, reason }` answers `granted`
  (with what was evicted), `wait` (with the reason, so she can say it) or `cpu`. The holder renews;
  a lease ends on `gpu.release`, on expiry, or when hostd sees the holder's process exit. hostd
  then reloads what it evicted. This replaces `_recover_speech`.
- **Context**: Core sends `cluster.context` to the hosts that hold `tts` or `asr`; the decision
  "may speech be evicted now" uses it. Core stops pushing `/gpu/context` to the sing worker.
- **Yielding**: `gpu.busy` answers from a short-lived cache of the evictable tenants' `/busy`,
  polled only while a lease with `yield` is active.

Method of work: (a) a Python test drives `gpu.py` over a matrix of inputs and writes the decisions
to a checked-in table; (b) the TypeScript arbiter must produce the same table; (c) the sing worker
becomes a lease client, `ImageGenService` asks through the registry's host, and the old code and
`SING_OFFLOAD_URLS`, `SING_YIELD_URLS` are deleted. Step (c) waits for a live song request during
a voice call with the owner listening.

## 9. Installing (H6)

- Each Python service gets a `pyproject.toml` and a `uv.lock` in its folder. Variants are extras,
  declared as conflicting where they cannot share an environment. The CUDA build of torch is set
  through an index in the project file with platform markers (v5-research §6).
- `miyoria add <service>...`: `uv sync --frozen` into `<state>/envs/<service>`, fetch
  `install.files` after asking (§9.1), check `install.system` and `install.manual`, write the
  `[services.<name>]` table. `install.models` are fetched by `models pull` or by the service. `remove` deletes the environment and the table, never models.
- `miyoria models pull | ls | gc`: models are shared by revision in `<state>/models`; `gc` lists
  what no installed service names and deletes only after a confirmation.
- `miyoria update`: pull or upgrade the package, then for each installed service whose lock,
  descriptor or sources changed: reinstall, and restart one at a time through the guard.
- A `[services.<name>] python = "<path>"` environment is never touched by `add`, `update` or
  `remove`.
- A machine whose antivirus inspects TLS sets its certificate bundle in `host.toml`
  (`[paths] ca_bundle`), which hostd passes as `SSL_CERT_FILE` and `REQUESTS_CA_BUNDLE`.

### 9.1 Model files (`[[install.files]]`, owner 2026-11-17)

Only public, freely downloadable weights are fetched automatically. A private asset (her RVC
model, the reference audio), an executable (MediaMTX) and source code that runs (Seed-VC) stay
`[[install.manual]]`.

- **Schema** (hostd's own, `packages/hostd/src/descriptor.ts`, on top of the contract's
  `HostServiceSchema`; unknown keys are rejected): `path` (relative to `<state>/models`; no `..`,
  no absolute or drive path, no `\`, not under `hf/`, not `.part`), exactly one source: `url`
  (https, no credentials, a host on the allowlist; a github.com URL must be a release asset) or
  `hf` + `file` + `revision` (a 40-character commit; a branch or tag is refused), `sha256`
  (required), `size` (bytes, required), `what` (zh-TW, shown), `licence` (SPDX id or a short note,
  shown), `optional` (default `false`). No `when` and no `extract`: no existing item needed them.
  A broken entry is a catalog problem for that service, with the field and the reason.
- **Where**: `<state>/models/<path>`, the state folder of `host.toml` (`[paths] state`, relative
  to the workspace). A packaged install keeps them in the user's folder, not the package's, which
  is what `install.manual` paths still get wrong (backlog).
- **Downloader** (`install/download.ts`, Node's fetch and streams, no new dependency): https only;
  allowlist `huggingface.co`, `*.huggingface.co`, `*.hf.co`, `github.com` (release assets),
  `objects.githubusercontent.com`, `release-assets.githubusercontent.com`,
  `raw.githubusercontent.com`. Redirects are followed by hand, at most 5, each hop checked like
  the first URL. Into `<file>.part` with `Range` to continue; 60 s without data aborts the attempt;
  a dropped connection, a timeout, 408/425/429 and 5xx are retried after 2, 8 and 30 s. A
  transfer that outgrows `size` is stopped. The `.part` is hashed and renamed into place only when
  the SHA-256 matches; otherwise it is deleted. One file at a time. Before the first byte the
  drive must have the remaining bytes plus 512 MB, or nothing starts and the message gives the
  numbers. Nothing downloaded is run.
- **Asking**: `add`, `update` and `doctor --fix` list each missing or wrong file with its size,
  licence and source, then ask once; `--yes` agrees; without a terminal and without `--yes` they
  print the list and the command and exit non-zero. `host.update` (the daemon's re-sync) never
  downloads; `update` asks and then calls `service.install` for the services that need files.
- **Checking**: `doctor` reports each file as verified, missing (a failure unless `optional`) or
  wrong (size or checksum). Hashes are remembered in `<state>/models.verified.json` with the size
  and modification time, so only a new or changed file is hashed again; `doctor --deep` hashes
  every file. `doctor --print-hashes <service>` prints the SHA-256 and size of the service's files
  on this machine (its `install.files` and what its `install.manual` items hold) in `service.toml`
  syntax.
- **Starting**: hostd does not start a service whose non-optional file is missing or the wrong
  size (no hashing at start); its status is `disabled` and the reason names the files. A start
  after the file appeared re-checks.
- `install.files` is left out of the install-record hash: adding or pinning a file does not make
  the environment stale.

## 10. CLI

| Command | Does | Replaces |
|---|---|---|
| `init` | asks what this machine is for; writes `host.toml`, and `miyoria.toml` plus `.env` when Core runs here | today's `init` and `machine-step.ts` |
| `host invite / join / ls / approve / remove / migrate / autostart` | §7, §3, H10 | none |
| `add / remove <service>` | §9 | `install` |
| `up [service...]`, `down [service...]`, `restart <service>` | start hostd if needed, then ask it | `up`, `start` |
| `up --foreground` | the supervisor in this terminal, no daemon | `up` |
| `status [--all]` | this host's services, or every host's through Core | `status` (Core only) |
| `logs <service> [-f] [--host NAME]` | tail the rotated log | none |
| `doctor [--fix] [--print-hashes <service>]` | today's checks, driven by descriptors, plus hostd, link, token and the model files (§9.1) | `doctor`, `role-checks.ts` |
| `update` | §9 | `update` |
| `models pull / ls / gc` | §9 | `downloads.ts` use in `install` |

The parser stays hand-written (v5-packages §12). `core`, `stage`, `chat`, `config`, `db`,
`module`, `persona`, `ext` and the rest are unchanged.

## 11. Someone else's own copy (H11)

- **Install**: `npm i -g miyoria` (or pnpm). The package already carries Core, the panel, the
  overlay and a profile. H11 adds the service catalog: `workers/` without models, voices and
  environments, and `services/`. hostd reads descriptors from the package when there is no repo.
- **Text only**: a machine with no GPU runs one service, `core`. `init` offers this first:
  Discord bot token, LLM provider and key, profile. Nothing about workers is asked.
- **Adding voice later**: `miyoria add asr tts turn voice-node`. The setup page says plainly that
  the voice node logs in as a user account, that Discord may suspend such an account, and that a
  separate account made for this is the sensible choice (P3).
- **Character**: the package keeps shipping the deepseek-chan profile (P4).
- **Docs**: one public page, `docs/SETUP.md`: text only in five steps, then optional chapters
  (voice, singing, a second machine).
- **Check**: the CI job that installs the packed tarball also runs `miyoria up --foreground` with
  a fake LLM and no Discord token, and waits for Core's health.

## 12. Deleted at the end of the phase

What the phase deletes. Status checked against the tree on 2026-11-16 (the branch is not at the end
of the phase yet).

Already gone: `commands/start.ts`; `commands/up.ts` (`up` now lives with the hostd commands in
`commands/host.ts`); `commands/install.ts`; `stack/launch.ts`; `role-checks.ts`; `machine-step.ts`;
the port and VRAM tables of `stack/checks.ts` (the file stays, for the Windows port and antivirus
checks). `lyricsllm.load_config` is not deleted: it was rewritten (H8) and no longer reads
`miyoria.toml`.

Still there, to delete at the end:
- `stack/roles.ts` and `stack/config.ts`, with the `[stack]` and `[machine]` sections of the
  config schema; `host migrate` reads them, so it goes with them.
- The URL keys listed in §6.4 (`speech.*.url`, `modules.voice.turn_url`, `modules.sing.url` and
  `fallback_urls`, `modules.imagegen.url`, `[stage] core_url`). They stay as optional static
  registry entries and have no default address.
- `SING_OFFLOAD_URLS` (still set by the `sing` descriptor) and `SING_YIELD_URLS`, until H7 is on.
- Core's `/gpu/context` push (`packages/sing/src/client.ts`) and `ImageGenService`'s sing wiring
  (`packages/workspace/imagegen`), until the GPU step and the imagegen move.
- `workers/mediamtx/start.ps1`.

`workers/docker-compose.yml` and `deploy/` are not part of this phase and stay as they are (noted
in the backlog as untested).

## 13. Tests

- H1: descriptor schema tests; every descriptor in the repo parses; a pin test that the plan
  built from descriptors equals `buildPlan` for the same machine config (deleted with `buildPlan`).
- H2: the supervisor against small fake services (a Node script that serves `/health`, one that
  exits, one that never becomes healthy): start order, backoff, give-up, stop with tree kill,
  port in use, foreign service, log rotation. Runs on Linux in CI and on Windows locally.
- H3: link hello and close codes; `host.report` to registry; order, static entries, unapproved
  hosts; the `Peer` conformance test still passes on the stream transport.
- H4: each module's existing tests, with the registry supplying what config supplied.
- H5: join with a used, expired or wrong code; revoked key; a worker with and without a token
  (`workers/tests`).
- H7: the decision table.
