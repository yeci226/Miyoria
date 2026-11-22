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

[update]
allow_remote = true              # the default, also without this table; false: Core's owner may not update it (§14)

[services.asr]                   # one table per installed service
enabled = true
python = "workers/.venv-asr-qwen"     # use this existing environment; hostd will not manage it
env = { HF_HUB_CACHE = "C:/.../data/models/hf", HF_HUB_OFFLINE = "1" }

[services.sing]
enabled = true
python = "workers/.venv-sing"
# accept = false                 # it runs, but Core sends it no work (§15.6); Core cannot change it
# concurrency = 1                # at most this many units at once from Core
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
| A service on this machine | HTTP `POST /rpc` on the local API | its `MIYORIA_SERVICE_TOKEN` | the forwarded `cluster.resolve`, `cluster.llm` and `cluster.fetch` (Core then checks the `uses` table, below). `gpu.*` comes with H7; hostd does not serve it to a service yet |
| Core | the control link (hostd dialled it) | the host key, in `hello` | `host.*`, `service.*` |

Methods hostd serves:
- `host.info` → name, version, platform, GPU reading, service list.
- `service.list`, `service.start`, `service.stop`, `service.restart` (with `force`),
  `service.logs` (last N lines; with `follow`, lines arrive as `service.log` notifications until
  cancelled).
- `service.install`, `service.remove`, `host.update` (H6).
- `host.upgrade { commit, wait_s?, by? }`, `host.upgrade_cancel` (§14): Core only, to a host that
  has not opted out.
- `gpu.acquire`, `gpu.renew`, `gpu.release`, `gpu.busy`, `gpu.state` (H7).
- `cluster.resolve`, `cluster.llm`, `cluster.fetch`: forwarded to Core over the link (H5, H8). hostd adds the name of the service that asked (`service`); a service cannot set it itself.

Methods Core serves on the control link:
- `cluster.guard` → the active guarded states.
- `cluster.resolve { capability }` → endpoints with the headers to send (bearer tokens included),
  for a service the `uses` table lets resolve that capability; refused otherwise (see below).
- `cluster.llm { purpose, messages, max_tokens, temperature, json }` → text. One completion
  through Core's own model and key; counted in the daily budget and written to the call log like
  any other call. The key never leaves Core.
- `cluster.fetch { capability, method, path, headers, body }` → `{ status, headers, body }`. Core
  sends one HTTP request to the first usable endpoint of `capability` and returns the whole answer
  (body base64, each body at most `HOST_FETCH_LIMITS.MAX_BODY_BYTES`, 8 MiB; the response head must
  arrive within `HEAD_TIMEOUT_MS`, 60 s). For small calls such as the ASR spot check.

Who may use `cluster.llm`, `cluster.fetch` and `cluster.resolve`: Core decides, never the caller
(`packages/cluster/src/calls.ts`). It checks that the host is approved, that the request names
the service that asked (hostd adds it), that the host's last report lists that service, that the
service provides a capability the host is approved for, and that the `provides` → `uses` table
lets that capability use what is asked for (an LLM purpose, a capability to fetch from, a
capability to resolve; a purpose must also be on Core's list, default `fast`). The table
`DEFAULT_CLUSTER_USES` is in code and has no config key yet: `sing` and `lyrics` may use the LLM
purpose `fast` and fetch from `asr`; nothing may resolve; nothing else may use anything.
`cluster.llm` is rate limited per host (30 calls per 60 s by default).

`cluster.resolve` has its own list (`resolve`), separate from `fetch`: `fetch` sends one request
through Core and the token stays in Core, `resolve` hands the endpoint's headers to the service so
it calls the capability itself, and the token leaves Core. Before 2026-11-22 any approved host
could resolve any capability and got every endpoint's token; now a request that fails any check
is refused with `NotAllowed` before the registry is read, so no endpoint, address or token of a
capability the service was not granted is in the answer or the error. No service resolves today
(the song worker and the lyrics service go through `cluster.fetch`; `workers/hostd_client.py`
only passes the call on), so the empty default breaks nothing that runs. The operator's own call
through hostd names no service and is refused as well; to debug, it names the service it asks
for, as with `cluster.llm`. A service that needs to call a capability directly (for example a
large upload past `cluster.fetch`'s 8 MiB) gets an entry in `uses`, such as
`sing: { resolve: ["asr"] }`, in code for now.

The errors are the codes of `HOST_ERROR_CODE`
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
pick(capability: string): Endpoint | null;        // the first healthy one in order (for `job`: by score, §15.3)
candidates(capability: string): Endpoint[];       // all that take new work, in order, for callers with their own failover
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
  256 KiB read. A sender of a body also waits while the socket itself has more than 128 KiB
  queued (1 MiB until 2026-11-19), and wakes as frames are written out, not on a timer; JSON-RPC,
  credit and aborts are written at once, so at most that much body is queued in the process ahead
  of them (the kernel's send buffer and the network's queue still are). Measured on a 30 MB
  download with a slow reader: about 0.6 s, never more than 1 MiB buffered; a reader that stops
  reading stalls only its own stream. These numbers are each sender's own: nothing is negotiated.
- **Length.** A body whose head has a `content-length` must be exactly that long. The host aborts
  a response its service broke off or ended short (never ends it) and logs it; Core fails a body
  that ends at another length, whichever host sent it. The host logs every relayed response of a
  megabyte or more with its bytes, seconds and MB/s.
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

## 14. Updating a host from the panel (2026-11-21)

面板的「電腦」頁顯示每台的版本(分支、提交、和 Core 那台比是落後、相同、比較新還是分岔、有沒有沒提交的變更),擁有者勾選幾台按「更新」,那幾台自己快轉到 Core 那台的提交、裝套件、重啟有變動的服務,每一步回報到面板。The rest is the implementation.

**On by default; a host opts out** (owner, 2026-11-21). `host.toml` `[update] allow_remote` is
`true` by default, also when the table is not there, so no one writes anything to be updatable.
**Connecting a worker host to a Core lets that Core's owner update the host's checkout** to commits
of the branch the checkout tracks (fast-forward only, never with uncommitted changes, never a
download). To refuse, write `[update]` and `allow_remote = false` in `host.toml` (a new
`host.toml` from `miyoria init` ends with those two lines commented out). A host that opted out
still reports its checkout; it refuses `host.upgrade` with the reason, and the panel shows that
reason under the host. The file is read again at each `host.upgrade` and every minute for the
report, so turning it on or off needs no restart. Core's own machine (a host whose `host.toml`
enables `core`) always refuses: updating it restarts Core and rebuilds the panel under the request
that asked for it, so it stays `miyoria update` by hand on that machine.

**What Core sends.** `host.upgrade { commit, wait_s?, by? }`: a full 40-character commit, Core's own
`HEAD` (read from Core's checkout with git, never fetched; `packages/cluster/src/checkout.ts`), how
long the host may wait for her, and who asked. Never a command, a remote or a branch. Only Core may
call it (the operator on the machine has `miyoria update`). It answers at once with the job; the
job's steps travel in `host.report` (`upgrade`), so the panel watches them through the hosts list,
which polls every 2 s while a job runs.

**The host's sequence** (`packages/hostd/src/upgrade/upgrader.ts`), each step in the job:

| Step | Does | Refuses or fails with nothing changed |
|---|---|---|
| check | not opted out, a git checkout at the catalog root (a `.git` right there), on a branch with `branch.<b>.remote` and `.merge`, no change to a tracked file (untracked files do not count; git itself refuses a merge that would overwrite one) | any of these; HEAD already the commit is `done` |
| fetch | `git fetch --no-tags <that remote>` with `GIT_TERMINAL_PROMPT=0` | the commit is not there, not on the tracked upstream, older than HEAD, or HEAD has diverged |
| wait | while she is busy: a GPU lease, a guard state (`singing`, `live`) of a service that guards it, Core cannot be asked, or a running service whose `/health` says `busy: true` or `queued > 0` (the song worker's). The job is `waiting` with the reason; it can be cancelled. Core drains the host while the job runs (§15.6), so its queue empties instead of growing | still busy after `wait_s` (default 1800) |
| merge | HEAD and the tree checked again, then `git merge --ff-only --no-edit <commit>`; HEAD must be the commit | HEAD moved or the tree changed while it waited |
| install | `pnpm install --frozen-lockfile` when `pnpm-lock.yaml`, `pnpm-workspace.yaml` or a `package.json` changed; the Node services that will restart are stopped first (Windows keeps their native modules locked) | |
| sync | `uv sync` of each managed Python environment that is stale now, each stopped first when it runs (`python = ...` environments are never touched) | |
| restart | the stopped ones are started again; the running services whose code changed (their folder, a `workers/*.py`, and for Node services anything under `packages/` or `apps/`) restart one at a time once she is idle again | still busy at the deadline: they keep running the old code and are listed as not restarted |
| verify | the restarted services must come back healthy (10 minutes); what the enabled services lack that an update never fetches (`install.files`, `install.models`, `install.manual`) is listed | |

A failure in merge, install or sync goes back: `git reset --keep <from>`, only while HEAD is still
the commit this job moved to (`--keep` refuses rather than touch a changed file, and the tree was
clean), then `pnpm install` for the old lockfile, the environments synced again, the stopped
services started. A service that does not come back after the restart is reported, not rolled
back. Nothing in the sequence downloads a model, resets a tree it did not move, or discards a
change.

What a remote update does not do, and says in the job's `notes`: it does not rebuild the panel,
the overlay, the SDK or the extensions (only `miyoria update` builds); and hostd itself keeps
running the code it started with until `miyoria down` and `miyoria up` on that machine.

**Core and the panel.** `GET /api/cluster/hosts` adds each connected host's `checkout`,
`remote_update`, `upgrade` and `relation` (to Core's commit); `GET /api/cluster/checkout` is Core's
own. `POST /api/cluster/upgrade { hosts, wait_s? }` and
`POST /api/cluster/hosts/{name}/upgrade/cancel` need the node `owner.cluster.update`. It is an
`owner.*` node, like `owner.data.manage`: the `owner` role (and every account in
`[modules.commands] owners`) holds it through `*`, the `admin` role's `admin.*` does not cover it
and `moderator` has nothing of it, so with updates on by default only the owner can start one. The
owner may give it to someone by naming the node in a role of their own; the bearer token holds every
node. Each host asked is one audit entry
(`cluster.host.upgrade`, ok or not, with the reason). A finished job is logged by Core's cluster
module when the report carrying it arrives.

**Old and new.** Every new field of `host.report` and of the API's host view is optional, and the
protocol version stays 1. An old hostd reports no `checkout` and no `remote_update`: the panel
shows 「版本不明」 and offers no update, and Core never sends it `host.upgrade`. A new hostd's extra
fields are dropped by an old Core's schema. `[update]` in `host.toml` is a table an old hostd does not
know (its schema is strict), which is why the default needs no table. An old hostd takes no remote
update anyway, so there is nothing to opt out of before it is updated; write `allow_remote = false`
only on a machine whose hostd is new enough.

## 15. Routing classes and job dispatch (2026-11-21)

每個服務在描述檔宣告它能怎麼分派:`single`(整個叢集只能有一個)、`session`(一次對話或串流留在開始的那台)、`job`(一個一個獨立的工作,哪台都可以做)。`job` 的工作由 Core 算每台「這個工作做完並傳回 Core 要多久」,送到最快的那台;同時送出的兩個工作會分到兩台閒著的電腦。她的語音所在的電腦預設不接會搶顯卡的工作(翻唱),和之前的決定一樣。擁有者可以在面板釘選、排除、加權、清空一台電腦;那台電腦的主人可以在自己的 `host.toml` 限制它接什麼,Core 改不了。The rest is the implementation.

### 15.1 The `[routing]` table

```toml
# workers/sing/routing.toml: the table's contents, without the [routing] header
class = "job"                 # single | session | job (required)
latency = "batch"             # realtime | interactive | batch (default interactive)
concurrency = 1               # units one instance takes at once (default 1)
queue = true                  # its [run.health] answer reports `running` (or `busy`) and `queued`
yields_to = ["tts", "asr"]    # services of the same host its work disturbs (by name or capability)
unit_s = 300                  # a unit's usual time until Core has measured one on a host
result_mb = 90                # a unit's results, for the transfer estimate

[needs]                       # the host checks these and reports ready, or not with the reason
files = ["workers/models/seed-vc", "workers/voices/deepseek-chan/ref.wav"]
vram_gb = 7.5                 # the card's total memory at least

[variant]                     # what makes results differ between hosts: hashed, reported
files = ["workers/models/applio/logs/miyoria-deepseek-48k/miyoria-deepseek-48k_40e_11000s.pth",
         "workers/voices/deepseek-chan/ref.wav"]
env = ["SING_VOICE", "SING_RVC_MODEL", "SING_RVC_INDEX", "SING_REF"]
```

- Schema `HostRoutingSchema` (`packages/contracts/host/src/routing.ts`), strict. A descriptor may
  carry it as `[routing]` in `service.toml` (validated there by a new hostd) or as the whole of a
  `routing.toml` beside it; both at once is a catalog problem. **The repository uses
  `routing.toml`**: an older hostd's descriptor schema is strict, so a `[routing]` table in
  `service.toml` would disable the service on that host after a `git pull` or a remote update,
  while an older hostd never opens `routing.toml`. Fold it into `service.toml` once every host runs
  a hostd that knows it. The CLI package copies `routing.toml` with the descriptors.
- The catalog also refuses `class = "job"` with `latency = "realtime"` (that is a session),
  `queue = true` without `[run.health] http` or on an external service, unknown placeholders in the
  paths (allowed: `{voice}`, `{state}`, `{models}`, `{workspace}`, `{service}`, resolved as
  `install.manual` paths) and a service that yields to itself.
- Without the table nothing is reported and Core routes the service as before (§15.3).
- **Readiness** (`hostd/src/routing.ts`): every `needs.files` path exists, and the card reads at
  least `vram_gb` (a card not read yet, or one that cannot be read, does not hold the service
  back: the worker falls back as before; the first reading is a change of the report). Evaluated on
  every report and looked at again every 30 s, so a file that appears makes the service ready
  without a restart.
- **Variant**: a 16-hex hash of the listed environment values (the `host.toml` env, then the
  descriptor's, then the daemon's; placeholders are hashed unexpanded) and of each listed file:
  its relative name, size and the SHA-256 of its first and last MiB (a folder: its files, the first
  64 sampled, at most 4096 listed). Samples are cached by size and modification time, so a model of
  several GB is read once. Two hosts with the same model files and settings report the same hash; a
  model kept at another path through an environment variable counts as another variant.
- **Load**: for `queue = true` hostd reads `running` (a number), else `busy` (`true` = 1), and
  `queued` from every health probe of the running service (every `interval_s`) and reports
  `{ running, queued, age_ms, outside? }`. `age_ms` is the reading's age when the report is made,
  so Core places it on its own clock without comparing clocks. `outside` says the card is lent to
  another service of the host (an active GPU lease of another holder, `host.toml [gpu] arbiter =
  "hostd"` only). A worker whose health says neither field reports no load. **No Python worker
  changed**: the song worker's `/health` already says `busy` and `queued`.

### 15.2 Choosing a class

Ask, in order: *Can there be two of it at once in the cluster?* No: `single`. *Does a piece of
work depend on what came before on the same instance* (a stream, a call, a room whose state lives
in the worker)? Yes: `session`. Otherwise: `job`. Then the latency: `realtime` for anything a
person hears or sees as it happens, `interactive` for an answer someone is waiting on, `batch`
for work that may take minutes. `yields_to` names the services of the same host the work evicts
or starves (through the GPU lease or otherwise); `variant` lists what makes two instances'
results differ for a listener.

| Service | Class | Latency | Why | Also |
|---|---|---|---|---|
| `core` | single | (interactive) | there is one Core | |
| `voice-node` | single | realtime | it logs in as her self account; two would log it in twice | |
| `stage` | single | realtime | drives her one VTube Studio and OBS | |
| `mediamtx` | single | realtime | relays her one stream | |
| `obs`, `vtube-studio` | single | realtime | her one stream's programs; provide nothing Core calls | |
| `tts` | session | realtime | her speech is a stream of sentences on one worker | needs and variant: `workers/voices/{voice}/ref.wav`, `ref.txt`; variant env `TTS_DEFAULT_VOICE`, `TTS_MODEL`, `TTS_BACKEND`, `TTS_MODE`, `TTS_CLONE_MODE` |
| `asr` | session | realtime | a call's speech is recognised where it runs | |
| `turn` (`turn`, `vad`) | session | realtime | the VAD is a WebSocket stream per call | |
| `sing` | job | batch | each cover and karaoke song is its own unit | concurrency 1, queue, yields_to `tts`, `asr`, unit 300 s, 90 MB, needs and variant as above |
| `lyrics` | job | batch | each lookup stands alone | concurrency 2 |
| `comfyui` (`imagegen`) | job | interactive | each picture stands alone | concurrency 1, 60 s, 4 MB; no queue (external, not probed for load), no `yields_to` (it takes no lease; the imagegen module frees it while she sings, as before) |

Karaoke live scoring is a session on the `sing` capability: a room's streams start where
`openSession` places them and stay on that worker (as before); preparation is `job` work.

### 15.3 How Core routes (`packages/cluster/src/registry.ts`)

The class of a capability is what its approved hosts report for it; when they disagree the
strictest wins (single, then session, then job) and the machines page shows the disagreement.
`yields_to` is the union, `unit_s` and `result_mb` the first reported.

- **No class reported** (descriptors without the table, older hostds, static entries only): exactly
  the order of §6.3, unchanged.
- **`single`**: only the instance Core saw serving first (then `order`, then names) is returned;
  every other is a conflict, logged once per change and shown on the machines page, never used.
  When the first goes, the next is the one.
- **`session`**: `pick` and `candidates` keep the order of §6.3, so callers that resolve per
  request (speech today) behave as before. `openSession(capability, key)` chooses among the
  endpoints that take new work: healthy and not resting first, then for `realtime` the distance to
  Core (Core's own machine 0, else the last ping's round trip, unknown 1000 ms) before `order`, for
  the other latencies `order` before the distance, then names. `session(capability, key)` returns
  the endpoint while it is there; when it goes the session is over and the next one starts
  elsewhere (`closeSession` ends one; 256 are kept at most).
- **`job`**: `candidates` is in score order, healthy before unhealthy, ties to `order` then names.

The **score** of an endpoint for a new unit, in seconds, lowest first:

```
ahead    = running + queued (its last reading) + pending        (unknown load: pending + unknown_load_units)
wait     = ahead × unit / concurrency
transfer = result size ÷ transfer rate
score    = (wait + unit + transfer + penalties) ÷ weight
```

- `unit`: the decayed average measured on that host for that capability, else
  `[modules.cluster.routing.capabilities.<c>] unit_secs`, else the descriptor's `unit_s`, else
  `default_unit_secs` (120).
- `concurrency`: the host's report (the descriptor's, lowered by the host owner's `host.toml`).
- `pending`: units Core reserved on that endpoint (`reserve`) that its load reading does not show
  yet: a reservation counts while no reading taken after the unit was accepted has arrived, for at
  most `reserve_secs` (60); on a host that reports no load it counts until the unit is done, for at
  most `max_unit_secs` (3600). This is what spreads two units sent together over two idle hosts.
- result size: the capability's `result_mb` in the config, else the measured average, else the
  descriptor's `result_mb`, else 0. Transfer rate: measured for that host, else
  `transfer_mb_s` = 500 (Core's own machine), 20 (direct), 8 (through the link) MB/s.
- penalties: resting after a failure `resting_penalty_secs` (3600; not with `ignoreResting`, which
  failover callers use), a card lent to another service `outside_busy_penalty_secs` (120), her voice
  on that host while she is active with `always` `speech_penalty_secs` (900), each place further
  down `order` `order_step_secs` (30; hosts `order` does not name count as the place after the last).
  `order` is thus an explicit preference that a queue can overcome, and the tie-break.
- `weight`: the panel's, else `[modules.cluster.routing.weights]`, else 1.

An endpoint takes **no new work** (left out of `pick` and `candidates`, listed last with
`all: true` for callers that look for what an endpoint already holds) when: its host's owner set
`accept = false`; it is not ready; it reports another variant than the capability's (the config's
`variant`, else the one most of the instances report that would take work for every other reason,
a tie to `order` then names; endpoints that report none are not judged); a pin names another host; it is excluded; its host is drained (by the panel,
by `[modules.cluster.routing] drain`, or while its remote update runs, §14); or the speech-host rule
says so (§15.5). For `session` and the old order these apply too (a session capability's endpoint
that is not ready or has another variant is not used); `single` uses only its first instance.

`reserve(endpoint, { what?, sizeBytes? })` records the decision (the chosen endpoint and every
endpoint's score or why it was out; the last 10 per capability) and returns
`{ accepted(), done({ ok?, run_ms?, bytes? }) }`. `done` teaches the estimates (§15.4); `ok: false`
teaches nothing.

**Sing.** `FailoverSingWorker` keeps all its rules (a song stays with the worker that made it,
resume of a broken download, a timed-out submit is not sent twice, a job left behind is cancelled
when its worker is back, a room's streams stay on one worker) and takes its list from
`candidates("sing", { ignoreResting: true, all: true })`, marking the endpoints that take no new work
(`takesWork: false`). New songs and recordings go only to the ones that take work, in score order;
lookups of songs, jobs and karaoke files still ask every listed worker, so a song made on a host that
is now drained or excluded is still played from there. Each new song is reserved before its request
goes out, accepted when the worker answers, and done when a poll sees its job end; its run time is
from the first poll that saw it `running` (to a poll's interval). A cached song, a cancel, a lost job
and a recording's pitch teach nothing. Karaoke preparation goes through the same worker
(`KaraokeWorkerKey`), so it is spread the same way. A host that goes away mid-job hands the song to
the next choice through the failover that was there.

### 15.4 Estimates

Per host and capability: the unit time (from `done({ run_ms })`, else, when the host was known to be
idle when the unit was sent, the time from `reserve` to `done`) and the transfer rate (every answer
of 1 MiB or more read through `registry.request` for a `job` capability, direct or relayed: bytes
over the time from the response head to the body's end). Per capability (host `*`): a unit's result
bytes (`done({ bytes })`). Each is a decayed average, the newest sample weighing 0.3. Kept in
`cluster_estimates` (cluster migration 2), written on every sample and read when the module starts.

### 15.5 Core's speech host

The owner decided earlier that the song worker must not fall back to the Core machine: it would
evict her TTS and ASR while she talks. That is now a general rule. For a `job` capability whose
`yields_to` names services, a host **carries her voice** when it runs such a service (by name or
capability) whose capability's session is placed there, or, with no session, that a new request of
that capability would go to now. `[modules.cluster.routing] allow_on_speech_host` (or per
capability under `capabilities.<c>`) decides what happens to such a host:

| Mode | The speech host |
|---|---|
| `never` (default) | takes no such job |
| `when_idle` | takes them only while she is not in voice, not live and nobody spoke (people, or her) for `idle_minutes` (10) |
| `always` | takes them, with `speech_penalty_secs` while she is in voice or live |

Where her voice is comes from the bus: `voice.joined` and `voice.left` (in voice), `voice.speaking`,
`voice.utterance` and `voice.playback` (someone spoke), and the `live` guard state, read every 5 s.

### 15.6 Who controls what

**Core's owner**, in `miyoria.toml`:

```toml
[modules.cluster.routing]
allow_on_speech_host = "never"          # never | when_idle | always
idle_minutes = 10
drain = ["old-pc"]                      # finish what they have, take nothing new
[modules.cluster.routing.weights]
friend-pc = 2                           # its score is halved: about twice the work
[modules.cluster.routing.capabilities.sing]
pin = "friend-pc"                       # only this host takes new songs
exclude = ["laptop"]
variant = "0123456789abcdef"            # the variant every instance must have
allow_on_speech_host = "when_idle"
unit_secs = 240
result_mb = 120
```

and the penalties and defaults of §15.3 (`speech_penalty_secs`, `resting_penalty_secs`,
`outside_busy_penalty_secs`, `unknown_load_units`, `order_step_secs`, `reserve_secs`,
`max_unit_secs`, `default_unit_secs`, `transfer_mb_s.{local,direct,link}`). On the machines page:
pin a capability to a host, exclude a host from a capability, a host's weight, drain a host. Those
are rows of `cluster_controls` (a pin replaces the capability's other pin), applied over the
config's (a panel pin over the config's, exclusions and drains added, a panel weight over the
config's), through `POST /api/cluster/routing/controls`, which needs the node `owner.cluster.route`
(an `owner.*` node like `owner.cluster.update`: the owner role holds it, `admin` and `moderator` do
not) and writes one audit entry per call (`cluster.routing.<set|clear>.<kind>`, ok or not).

**Drain and the remote update.** While a host's update job runs (its report carries an `upgrade`
without `finished_at`), Core drains it: it gets no new job and no new session, so the update's
`wait` step, which waits while a service's health says `busy` or `queued > 0`, ends when its queue
is done instead of waiting for a queue Core keeps filling. The host's sequence itself is unchanged.

**The host's owner**, in that machine's `host.toml`, which Core cannot change:

```toml
[services.sing]
accept = false        # it runs here, but Core sends it no work (old Core: see 15.8)
concurrency = 1       # at most this many units at once, below the descriptor's
```

### 15.7 What the machines page shows

`GET /api/cluster/routing` (admin): per capability its class and latency, `yields_to`, the variant,
the speech-host mode, a `single` conflict, a class disagreement, every endpoint in order (takes new
work or why not, score and its parts, load, units sent and not reported, whether its host carries
her voice, the measured unit time and transfer rate with their sample counts, its `[routing]`), the
last decisions, the open sessions and the result size reckoned with; per host Core's own machine,
round trip, drained and why, weight; her activity; the config's controls; the panel's controls with
who set them and when. The page's services table shows per service its class, readiness and the
reason, `accept = false`, the owner's limit and running/queued (nothing for an older hostd).

### 15.8 Old and new

- Protocol version stays 1. Every new field of `host.report` (`routing`, `load` per service) is
  optional; an old Core's schema drops them. A new Core treats an old hostd's endpoint as unknown
  load (ranked after hosts known to be idle) with no readiness, variant or `yields_to` of its own (the
  capability's `yields_to` from the other hosts still applies to it).
- `host.toml`'s `accept` and `concurrency` are keys an older hostd rejects (its schema is strict):
  update a host before writing them. Nothing requires them.
- `[routing]` lives in `routing.toml` for the reason in §15.1.
- `accept = false` is honoured by a new Core. An older Core does not know it and would still send
  work; to refuse an older Core too, disable the service (`enabled = false`) or ask Core's owner to
  remove the capability from the host's approval.
- The kernel's `EndpointSource` gets optional `reserve`, `openSession`, `closeSession` and the `all`
  query; a source without them (a test's, Core's own registry when the cluster module is not
  running) still works, without dispatch accounting.

### 15.9 Not done here

- Speech (`packages/voice`) still resolves per request with `firstEndpoint`; it does not open
  sessions yet, so the realtime "nearest host" choice and session stickiness apply to TTS, ASR and
  turn only once it calls `openSession` at the start of a call. Until then the speech host is where
  a new request would go (§15.5), which is today's choice.
- Image generation keeps `pick` (scored, since `comfyui` is `job`); ComfyUI's own queue is not read.
- Nothing of this ran on real hosts: the scores, the drain during an update and the variant hashes
  were checked with fake hosts and an injected clock only.

## 16. 一台電腦的幾條連線路徑(2026-11-22)

朋友那台經 Tailscale 傳大檔案(卡拉 OK 的影片、翻唱的結果)不穩,之後還要接更多朋友的電腦。所以一台電腦可以宣告好幾條「路徑」,Core 量每一條,照工作挑最適合的,一條失敗就換下一條。owner 同意的方向(2026-11-22)。

### 16.1 四種路徑

| 種類 | 怎麼連 | 適合 | 限制 |
|---|---|---|---|
| `tailnet` | 每個服務自己的埠,在 tailnet(或區網、這台本機)的位址上 | 即時語音、WebSocket、大檔案 | Tailscale 有時自己繞中繼,變慢 |
| `direct` | hostd 的閘道,在公開的位址加轉發的埠 | 大檔案、最低延遲、即時語音 | 要有人在路由器上轉發埠(那台的主人做,不是我們);沒有 tailnet 保護,所以一定要 TLS 和 token |
| `tunnel` | hostd 的閘道,在 tunnel 的主機名稱後面(Cloudflare) | 不用轉發埠,最簡單 | 每個請求的內容有上限(當成 100 MB),大檔案分段傳;延遲較高,不給即時語音 |
| `relay` | 控制連線本身(§7.1) | 一定連得上 | 最慢;最後的退路 |

`direct` 和 `tunnel` 都經過 hostd 的**閘道**:這台一個 HTTP(S) 入口,`<路徑的網址>/svc/<服務>/<路徑>` 轉給這台的服務,`/_miyoria/probe` 回 Core 的量測。所以不管這台跑幾個服務,只要轉發一個埠、或開一個 tunnel 主機名稱。

### 16.2 怎麼宣告:`routes.toml`

那台電腦的主人才知道自己的位址,所以寫在那台的 `routes.toml`,放在 `host.toml` 旁邊。Core 改不了它。另外一個檔案而不是 `host.toml` 的一張表,理由和 §15.1 的 `routing.toml` 一樣:舊的 hostd 讀 `host.toml` 很嚴格,遠端更新之後舊的 hostd 會讀到它不認得的表;舊的 hostd 根本不會打開 `routes.toml`。hostd 啟動時讀一次,改了要 `miyoria down` 再 `up`。

```toml
# routes.toml(完整的例子在 repo 根目錄的 routes.example.toml)
[gateway]                     # 有 direct 或 tunnel 路徑時才需要
bind = "127.0.0.1"            # 預設;聽 127.0.0.1 以外的位址一定要有下面兩個
port = 7890
# tls_cert = "certs/fullchain.pem"   # 相對於 host.toml 的資料夾
# tls_key = "certs/privkey.pem"

[[route]]
kind = "tailnet"
address = "friend-pc.tail1234.ts.net"   # 沒寫就用 host.toml 的 [network] advertise

[[route]]
kind = "direct"
url = "https://friend.example.net:7890"

[[route]]
kind = "tunnel"
url = "https://miyoria-friend.example.com"
# max_body_mb = 100                     # tunnel 的預設
```

- 名字預設是種類(第二條同種類的是 `tunnel-2`),也可以自己寫 `name`。
- 沒宣告也會有的:`[network] advertise`(檔案裡沒有 `tailnet` 路徑時,叫 `advertise`)、`local`(Core 就在這台時,服務本機的位址)、`relay`。
- 檔案讀不進來(TOML 錯、不認得的鍵)是整個檔案一個問題:這台只回報沒宣告也會有的路徑,寫進 hostd 的日誌。
- 一條路徑有問題(`direct` 用 http、閘道聽不了那個埠、讀不到憑證)會帶著原因回報,Core 不會用它,面板顯示原因。

**沒有 `routes.toml` 的電腦和今天完全一樣**:回報裡沒有任何新欄位,Core 照舊用 `advertised`(沒有就經控制連線),一次、不換路徑,也不量測。

### 16.3 回報

`host.report` 多三個可省略的欄位:`routes`(每條路徑的名字、種類、網址、內容上限、為什麼不能用)、每個服務的 `reach`(路徑名字 → 這個服務在那條路徑上的網址)、`route_token`(Core 量測閘道時帶的 token,hostd 每次啟動重新產生,和服務 token 一樣只在控制連線上送)。協定版本照舊是 1;舊的 Core 會把這些欄位丟掉。

### 16.4 量測

Core 的 `RouteProber` 每 5 秒看一次哪些量測到期了,一次最多 4 個:

- **延遲和連不連得上**:每條路徑每 `probe_secs`(300 秒)一個小 `GET`。閘道路徑是 `/_miyoria/probe`(帶 `route_token`);`tailnet` 是那條路徑上一個在跑的服務的 `/health`(帶它的 token);`relay` 用控制連線本來就有的 ping。
- **流量**:閘道路徑每 `sample_secs`(1800 秒)抓一次 `sample_kib`(256 KiB)的隨機位元組。所有路徑在真的傳輸 1 MiB 以上時也會各記一筆(衰減平均,新的一筆佔 0.3)。
- **花費**:一台大約每五分鐘每條路徑一個小請求,每半小時四分之一 MB。只量有 `routes.toml` 的電腦。
- 閘道路徑的回應要有 `x-miyoria-route: gateway` 才算:Cloudflare 在 tunnel 斷掉時自己回的 502、530 算失敗。401 的原因是「閘道不認得這台的 token」,通常是網址指到別台。

### 16.5 怎麼挑

每個請求在送出時挑,照工作分三種:

| 工作 | 什麼時候 | 能用的路徑 | 先後 |
|---|---|---|---|
| 即時 | `direct: true` 查到的端點(語音辨識、語音合成、VAD) | 只有 `tailnet`、`direct` | 延遲低的先 |
| 一般 | 其他 | 全部 | 延遲低的先,`relay` 最後 |
| 大檔 | `job` 或 `batch` 的能力(翻唱、歌詞、生圖) | 全部 | 流量大的先 |

每一種裡面都是「通的」先於「還沒量過」先於「失敗過、休息完了」先於「還在休息」。還沒量過的照種類的預設值排(延遲 tailnet、direct 40 ms,tunnel 150 ms,relay 300 ms;流量 20、20、10、8 MB/s;本機的位址 1 ms、500 MB/s)。上傳的內容超過路徑上限的(或長度不知道的串流)不走那條。只有 `tunnel` 或 `relay` 的電腦,不會出現在即時的查詢裡。

### 16.6 換路徑

- 一條路徑失敗就休息 `rest_secs`(30、120、600 秒,連續失敗越多越久),排到最後;休息完先量一次。
- **什麼時候可以換下一條重送**:請求根本沒送出去(連線被拒、名字查不到、relay 還沒送就拒絕、tunnel 的邊緣替斷掉的閘道回話),或方法是 `GET`、`HEAD`、`OPTIONS`、`PUT`、`DELETE`;而且內容可以送兩次(不是串流)。其他情況照原本的錯誤丟回去,呼叫的人自己的換台規則照舊(翻唱的送出不會送兩次)。
- **下載會接續**:`GET` 的回應有 ETag(或 Last-Modified)、長度、支援 range 時,傳到一半斷了就從斷掉的那個位元組,用 `range` 和 `if-range` 從下一條路徑要剩下的,呼叫的人讀到的是一個沒斷過的內容。檔案在中間變了(if-range 對不上)就失敗,不會拼錯。最多試 5 次。
- **tunnel 分段**:有上限的路徑一開始就分段要,每段 `chunk_mb`(64 MB),最多上限減 64 KiB。這用的就是唱歌 worker 本來就支援的 range(`#save` 的續傳也是靠它),worker 不用改。

### 16.7 安全

- `direct`、`tunnel` 一定要 `https`。只有指到這台本機(`127.x`、`localhost`、`::1`)的 `http` 可以:測試,和閘道前面放 TLS 反向代理的情況。hostd 檢查一次,Core 再自己檢查一次(不管 hostd 說什麼),網址裡有帳號密碼、`?`、`#` 都不用。服務在閘道路徑上的網址一定要在那條路徑的網址底下。
- 閘道聽 `127.0.0.1` 以外的位址一定要有自己的憑證(`tls_cert`、`tls_key`)。Core 照一般方式驗證憑證,不會關掉驗證,所以 `direct` 要用 Core 信任的憑證(例如 Caddy 或 Let's Encrypt 配 DDNS 的名稱)。
- 閘道收的 token:服務自己的 token 只能進那個服務,`route_token` 只能用量測。token 錯、沒帶、服務不存在,一律同樣的 401,外面的人看不出這台跑什麼。閘道只轉 worker:Core 自己和節點(語音節點、舞台)永遠不在閘道後面,所以沒有任何路徑能碰到 Core 的 API。
- 轉給服務時拿掉 hop-by-hop 標頭,換成服務自己的 authorization;不跟隨轉址;路徑裡的 `..`、`%2e`、`%2f`、反斜線一律拒絕。
- token 不寫進日誌;面板和管理 API 只看得到路徑的名字、種類、網址和量到的數字。

### 16.8 那台電腦的主人要自己做的事

- **direct**:路由器把一個外部埠轉到這台的閘道埠;一個 Core 信任的憑證(公開的名稱,例如 DDNS 加 Let's Encrypt,或 Caddy 自動申請);憑證放在閘道自己(`bind = "0.0.0.0"` 加 `tls_cert`、`tls_key`),或閘道聽 `127.0.0.1`、前面放 Caddy 之類的 TLS 反向代理。防火牆只開那一個埠。
- **tunnel**:在那台裝 `cloudflared`,開一個 tunnel,一個主機名稱指到 `http://127.0.0.1:<閘道的埠>`。TLS 在 Cloudflare 那邊。免費方案的上傳上限是 100 MB,所以預設 `max_body_mb = 100`。
- **tailnet**:和今天一樣,`host.toml` 的 `[network] bind` 要是 tailnet 的位址(或 `0.0.0.0`)。

### 16.9 面板

「電腦」頁的「每台電腦」底下列出每條路徑:種類、通不通、現在拿來做什麼(即時、一般、大檔)、量到的延遲和流量、上限、上次量的時間、失敗或不能用的原因。`GET /api/cluster/routing` 每台多一個 `routes`。

### 16.10 Core 的設定

```toml
[modules.cluster.routes]   # 全部是預設值
probe_secs = 300
sample_secs = 1800         # 0:不主動測流量
sample_kib = 256
timeout_ms = 5000
rest_secs = [30, 120, 600]
chunk_mb = 64
```

### 16.11 程式在哪

hostd:`src/routes.ts`(讀檔和檢查)、`src/gateway.ts`(閘道)、`daemon.ts` 的 `#routesReport`、`#startGateway`。Core:`packages/cluster/src/routes.ts`(`RouteTable`:路徑、健康、挑選)、`route-probe.ts`(`RouteProber`)、`routed.ts`(換路徑、續傳、分段)、`registry.ts` 的 `request` 和 `#all`。形狀在 `packages/contracts/host/src/routes.ts`。

### 16.12 還沒做的、沒驗證的

- **語音沒有改**:即時語音照舊每個請求用 `firstEndpoint(..., { direct: true })` 找端點、經 `registry.request` 送,所以有 `routes.toml` 的電腦,語音辨識和語音合成會走路徑表(只有 `tailnet`、`direct`,失敗了換另一條)。VAD 的 WebSocket 直接用端點的 `url`(查的那一刻最好的即時路徑),連上之後不換路徑,也不會因為斷線把那條路徑標成失敗。語音沒有開工作階段(§15.9),所以也沒有「一通電話黏在同一條路徑」。
- 沒有在真的電腦上跑過:Cloudflare tunnel、轉發的埠、真的憑證、Tailscale 自己繞中繼時的量測,都只用本機的假服務和假時鐘測過。閘道自己的 HTTPS 模式沒有測試(要產生憑證)。
- 上傳不分段:worker 的協定沒有分段上傳,超過上限的上傳就不走那條路徑。現在的上傳(卡拉 OK 的錄音、ASR 抽查)都遠小於 100 MB。
- `cluster.resolve` 給 hostd 的端點是 Core 挑的那一刻的網址;服務拿去自己連時不會換路徑。
- `routes.toml` 只在 hostd 啟動時讀。
