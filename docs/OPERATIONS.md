# 部署與維運手冊

這份文件講「怎麼把 Miyoria 跑起來並維持運作」:選部署型態、第一次設定、服務的安裝與啟動(hostd)、多台電腦、Discord 設定、升級、備份、日誌、安全與疑難排解。第一次從零架一套,先看 [SETUP.md](SETUP.md)。架構背景見 [ARCHITECTURE.md](ARCHITECTURE.md) §1、§16。

> 狀態:V5 階段 0 到 5 已合併,線上在跑(Discord 文字、語音、Go Live、唱歌、VTube Studio、OBS、DeepSeek 經 OpenCode),各階段和還沒做的事見 [design/v5-architecture.md](design/v5-architecture.md) §15 與 [design/backlog.md](design/backlog.md);Minecraft 暫停,見 [design/minecraft-findings.md](design/minecraft-findings.md)。[ROADMAP.md](ROADMAP.md) 的舊 phase 清單是歷史。
>
> 指令寫法:下面的 `miyoria <指令>` 在 repository 裡是 `pnpm dev <指令>`(在 repo 根目錄)。`miyoria` 套件還沒有發佈到 npm(見 [SETUP.md](SETUP.md)),發佈之後才能用 `pnpm dlx miyoria <指令>`(npm 是 `npx miyoria <指令>`)。
>
> 這份文件寫的是 hostd 之後的做法:每台電腦一個管家 hostd,服務由 `miyoria add`、`up` 安裝和啟動。舊的 `miyoria start`、`miyoria install`、`[machine]` 和 `[stack]` 設定都已經沒有了;舊設定用 `miyoria host migrate` 轉一次(見 [§4](#搬舊的設定))。

## 目錄

1. [節點與埠](#1-節點與埠)
2. [部署型態](#2-部署型態)
3. [第一次設定](#3-第一次設定)
4. [啟動各個節點](#4-啟動各個節點)
5. [Discord 設定](#5-discord-設定)
6. [升級](#6-升級)
7. [備份與還原](#7-備份與還原)
8. [日誌](#8-日誌)
9. [安全檢查表](#9-安全檢查表)
10. [疑難排解](#10-疑難排解)

---

## 1. 節點與埠

| 節點 | 怎麼跑 | 在哪 | 對外埠(預設) |
|---|---|---|---|
| **Core** | `miyoria up`(hostd 啟動,見 [§4](#4-啟動各個節點));`miyoria core` 是前景跑一個;Docker | 直播機或 server | `7878` Admin API(CLI / 面板 / `/metrics`)、`7879` voice link(voice node 連進來)、`7882` stage link(Stage 連進來)、`7880` cluster link(別台電腦的 hostd 連進來,模組 `cluster`);選用:`7881` MCP server(`[mcp.server]`,預設關) |
| **資料庫** | SQLite 檔案(`data/miyoria.db`,Core 自己開,不用另外跑) | 跟 Core 同一台 | 無 |
| **Self voice node** | `apps/voice-node`(Node ≥ 22.4),hostd 啟動(`miyoria add voice-node`,要有 repository) | 直播機(跟 ASR/TTS、OBS 同一台最好) | 不開埠,主動連 Core 的 7879 |
| **ASR worker** | `workers/asr`(Python,GPU 或 CPU),hostd 啟動 | 有 GPU 的機器 | `8003` |
| **TTS worker** | `workers/tts`(Python,GPU),hostd 啟動 | 有 GPU 的機器 | `8002` |
| **Sing worker** | `workers/sing`(Python,GPU),hostd 啟動 | 有 GPU 的機器(要和 ASR / TTS 同一台,見 [§4](#推論-worker)) | `8005` |
| **Turn worker** | `workers/turn`(Python,CPU),hostd 啟動 | 跟 Core 同一台 | `8006`(判斷講完,選用) |
| **Lyrics worker** | `workers/lyrics`(Python),hostd 啟動 | 跟 Core 同一台 | `8007`(只有翻唱 worker 在**沒有加入**的電腦時才用,見 [§4](#推論-worker)) |
| **MediaMTX** | `workers/mediamtx`,hostd 啟動(只有 Windows);`mediamtx.exe` 要自己放,見 [§4](#mediamtx) | 直播機 | `1935` RTMP、`8888` LL-HLS、`9997` API(選用:`[modules.live.video]`) |
| **ComfyUI** | 自己跑,給 `packages/workspace/imagegen` 用;hostd 不啟動它 | 有 GPU 的機器 | `8188`(`[modules.imagegen]` 的 `url`,沒有預設值,要寫才會用) |
| **Neuro 擴充** | `extensions/neuro`(Core 的擴充行程) | 跟 Core 同一台 | `8000`(`serve = true` 才開,讓遊戲連進來) |
| **fake worker** | `workers/fake`(沒有 GPU 測試用,手動跑) | 任何機器 | `8000`(`PORT` 可改) |
| **Stage** | `miyoria up`(hostd 啟動)或 `miyoria stage`(前景);原生,不放 Docker | 直播機 | 主動連 Core 的 7882;本機 `7883` 嘴型音量(`/levels`)、`7884` overlay;另外連 VTube Studio 的 API(預設 `8001`,不是 Stage 開的埠) |

節點一律**主動往外連** Core,所以直播機在 NAT 後面不用做任何 port forwarding。別台電腦的 hostd 也是主動連 Core 的 `7880`:那台電腦的服務不用開埠(見 [§4](#多台電腦))。

**所有埠預設都只綁 `127.0.0.1`。7878 / 7879 / 7880 / 7882 永遠不要直接開到公網**(見 [§9](#9-安全檢查表))。

每個服務的預設埠、健康檢查路徑、顯示卡記憶體估計,只寫在它資料夾的 `service.toml`(上表的埠就是從那裡來的),一個服務只有一個預設值。要換埠:在 `host.toml` 的 `[services.<名稱>]` 寫 `port = ...`。Core 的 `7878` 是 `[modules.api] bind` 的埠:換的時候兩邊要一致(`miyoria config set modules.api.bind ...` 加 `[services.core] port = ...`)。

自己手動跑 `server.py`(沒有 hostd)時,用的是 Python 檔案裡的預設:ASR 是 `8001`,其他和上表相同。所以「hostd 啟動的 ASR」是 `8003`,「手動跑的 ASR」是 `8001`;VTube Studio 的 API 也預設 `8001`,手動跑 ASR 又跟它同機時要把其中一個改掉。`packages/voice/speech` 原始碼註解裡的 `8101` / `8102` 只是範例,沒有任何程式用它當預設。

## 2. 部署型態

> 多台電腦分工(直播機、Bot 服務機、GPU 推論機)不再用「角色」設定:每台電腦的 `host.toml` 列出它跑哪些服務,`miyoria host invite` / `host join` / `host approve` 把它們接到同一個 Core。步驟見 [§4 多台電腦](#多台電腦)和 [SETUP.md](SETUP.md)。

### A. All-in-one(一台機器全包)

開發或自己小規模使用。全部跑在直播機(Windows)上。

| 在直播機上 | 怎麼跑 |
|---|---|
| 資料庫 | 不用做什麼:SQLite(`data/miyoria.db`) |
| Core | `miyoria up core`(或前景跑一個:`miyoria core`) |
| ASR / TTS worker | `miyoria add asr tts`,`miyoria up`,見 [workers/README.md](../workers/README.md)(沒有 GPU 先用 `workers/fake`) |
| Voice node | `miyoria add voice-node`,`miyoria up voice-node`(要在 repository 裡,見 [§4](#voice-node)) |

這台電腦的 `host.toml` 列出以上服務,`miyoria up` 一次啟動;Core 起來後這台會自動連到自己的 Core,不用改任何位址。

### B. Split:Core 在 server,語音與 Stage 在直播機(目標型態)

Core(+ 資料庫)在 server(Docker),直播機跑 worker、voice node、Stage。Discord 語音音訊在直播機上直接進 ASR、TTS 直接出,不繞 server 一圈。

```
直播機(Windows)                               Server(Linux, Docker)
┌──────────────────────────┐   voice link     ┌─────────────────────────┐
│ voice node ──────────────┼──── ws/wss ────▶ │ Core :7879              │
│ ASR :8003 / TTS :8002 ◀──┼── HTTP(經 tunnel)│  ├ Admin API :7878       │
│ Stage ───────────────────┼── ws/wss ────▶   │  └ SQLite                │
└──────────────────────────┘                  └─────────────────────────┘
```

重點:

- Core 要呼叫直播機上的 ASR / TTS,所以 server 必須連得到那兩個埠。**不要把 8003 / 8002 開到公網**,走 Tailscale / WireGuard。
- **Core 不在 Docker 時**(原生 Core 在 server),用 [§4 多台電腦](#多台電腦):直播機 `host join`,Core 那台核准;即時語音(ASR、TTS)要直連,所以直播機的 `host.toml` 要寫 `[network] bind` 和 `advertise` 成 tailnet 位址。不用在 Core 的設定檔寫任何 worker 位址。
- **Core 在 Docker 時**,目前只能用舊的接法:`deploy/` 的 compose 沒有發布 cluster link 的 `7880`,直播機的 hostd 連不進去;而 hostd 啟動的 worker 會檢查 token(每次啟動都換,靜態登記寫不出來),所以 Docker 的 Core 只能配**手動跑**的 worker(沒有檢查 token):`ASR_URL=http://<直播機 tailnet IP>:8001`(手動跑的 ASR 預設埠是 `8001`)、`TTS_URL=http://<直播機 tailnet IP>:8002`,worker 啟動時用 `HOST=<tailnet IP>`(或只綁 tailnet 網卡)。`deploy/` 這一輪沒有跟著改,見 [backlog](design/backlog.md)。
- 想少做網路設定,用 **B'**(下一節):語音推論也放 server。
- voice link 跨網路要走加密,見 [§9](#9-安全檢查表)。

Server 上:

```bash
git clone <repo> miyoria && cd miyoria
cp deploy/.env.example deploy/.env        # 可選:改埠、映像檔、設定檔
# 在專案根目錄產生 .env:可以在任何機器跑 `miyoria init` 再把 .env 複製過來,
# 或直接手動從 .env.example 建立,token 用 `openssl rand -hex 32` 產生
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps      # 等 core 變成 healthy
```

`core` 服務由 [`deploy/Dockerfile.core`](../deploy/Dockerfile.core) 建出來(Node 24,內含管理面板),使用 [`deploy/miyoria.docker.toml`](../deploy/miyoria.docker.toml) 當設定。**容器裡的 Admin API、voice link、stage link 必須綁 `0.0.0.0`**(綁 `127.0.0.1` 的話宿主機的埠映射連不進去,healthcheck 會過但外面連不到);對外與否由 compose 的 `ports:` 決定,一律只映射到宿主機的 `127.0.0.1`。容器的日誌會警告 `admin API is reachable from the network over plain HTTP`(voice / stage link 也一樣),在容器裡這是預期的。所以不要直接把給宿主機用的 `miyoria.toml` 掛進容器;要改設定就複製 `miyoria.docker.toml`,保留那三個 `bind`,在 `deploy/.env` 設 `MIYORIA_CONFIG_FILE=<路徑>`。

compose 裡的 Core 用 `core-data` volume 裡的 SQLite(`DATABASE_URL=sqlite:/data/miyoria.db`,由 compose 設定;要換路徑就在 `deploy/.env` 設 `CORE_DATABASE_URL`)。

### B'. Split + 語音在 server

server 有 NVIDIA GPU 時,ASR / TTS(Linux 可用 vLLM-Omni)跟 Core 放同一台,直播機只跑 Stage 和 voice node,12 GB VRAM 留給遊戲和 OBS。步驟見 [deploy/speech/README.md](../deploy/speech/README.md)。Core 容器連同機器上的 worker 用 `host.docker.internal`(compose 已加 `extra_hosts`),或在根目錄 `.env` 設 `ASR_URL` / `TTS_URL`。

只有 voice link 要跨機器:收音每位說話者約 256 kbps 上傳、TTS 約 384 kbps 下載。

### C. Cloud-voice

Core 在 server,ASR / TTS 用雲端供應者(`miyoria.toml` 的 `[speech.*]` 改 `kind = "openai"` 等),直播機只跑 Stage(和 voice node)。不需要 GPU,延遲與費用取決於供應者。

### 選哪個?

| 情況 | 建議 |
|---|---|
| 先試試看、開發 | A |
| 想讓她 24 小時待在 Discord 文字頻道,但直播機不是常開 | B(Core 在 server,語音只在直播時才開) |
| server 有好 GPU | B' |
| 沒有 GPU | C(或 A 搭配 SenseVoice CPU ASR + 雲端 TTS) |

## 3. 第一次設定

第一次從零架一套(只有文字、不需要顯卡),照 [SETUP.md](SETUP.md) 走五個步驟。這一節補充它沒有細講的部分。

需求:Node ≥ 24;從原始碼跑還要 pnpm 9(`corepack enable` 會用 `package.json` 指定的版本);Docker 只有要 Core 容器時才需要;要裝 Python 服務(ASR、TTS、翻唱 ...)還要 [uv](https://docs.astral.sh/uv/)(CLI 不會替你裝它)。

`miyoria` 套件還沒有發佈到 npm,今天能用的是從 repository 跑:

```bash
git clone <repository 網址> && cd Miyoria
node scripts/setup.mjs                 # 啟用 pnpm、安裝相依套件,然後接著跑 miyoria init
pnpm build:web                         # 管理面板(只有從 repository 跑才需要這一步)
pnpm dev doctor                        # 檢查連線
pnpm dev chat                          # 在終端機跟她聊天,不需要 Discord
```

本文件的 `miyoria <指令>` 在 repository 裡寫成 `pnpm dev <指令>`(tsx 直接跑原始碼,不用 build)。

`miyoria init` 第一題問這台電腦要做什麼:**文字聊天**(只跑 Core)、**文字加語音**(再加 `asr`、`tts`、`turn`)、或**只提供服務給別台的 Core**(不跑 Core,見 [§4 多台電腦](#多台電腦))。前兩項會:

- 寫 `miyoria.toml`(從 `miyoria.example.toml`)和 `.env`(秘密放這裡,不進 git),並把內建角色複製到 `profiles/`;
- 詢問 LLM base URL / API key / 模型 id、Discord bot token、你的 Discord user id(擁有者);
- 自動產生 `MIYORIA_API_TOKEN`、`VOICE_LINK_TOKEN`、`STAGE_LINK_TOKEN`;
- 資料庫:預設 SQLite(`sqlite:data/miyoria.db`);也可以選 `memory://`(重啟就沒了,先試用);
- 寫 `host.toml`:這台電腦跑哪些服務。選「文字加語音」只是把三個服務名字先寫進去,環境還沒建,要接著 `miyoria add asr tts turn`(見 [§4](#一台電腦的設定))。

非互動(腳本)用 `miyoria init --yes`(全部採用預設值),或 `--mode text|voice|service`,`service` 還可以加 `--services asr,tts` 指定服務。

`miyoria doctor` 檢查設定檔、角色、LLM、Discord、資料庫連線,和 `host.toml` 啟用的每個服務缺什麼(見 [§4](#用-doctor-檢查))。每次改完設定、換機器、升級後都先跑一次。

之後改設定用 `miyoria config`(互動選單)或 `miyoria config set <key> <value>`、`miyoria config set --env <NAME> <value>`。

### 資料庫

預設是 SQLite:`DATABASE_URL=sqlite:data/miyoria.db`(相對路徑以 `miyoria.toml` 所在的資料夾為準),Core 第一次啟動時建立檔案並套用 migration,不用做任何事。只支援 SQLite:`postgres://` 之類的網址會讓 Core 啟動失敗。

## 4. 啟動各個節點

每台電腦跑一個 **hostd**(管家):常駐的小程式,照這台的 `host.toml` 和每個服務的 `service.toml` 啟動服務、看它們健不健康、死了就退避重啟、把日誌寫成檔案。`miyoria up`、`down`、`restart`、`status`、`logs` 都只是對它說話。設計見 [design/v5-hostd.md](design/v5-hostd.md)。

兩份描述檔各管一件事:

- **`service.toml`**(在服務自己的資料夾:`workers/*/`、`apps/voice-node/`、`packages/core/`、`packages/stage/`、`services/*/`)是這個服務的事實:預設埠、健康檢查路徑、怎麼啟動、顯示卡記憶體、`miyoria add` 要裝什麼、哪些東西要人自己放。CLI 裡沒有服務名稱的表。
- **`host.toml`**(在工作資料夾,跟 `miyoria.toml` 同一個資料夾,不進 git)是這台電腦的事:名字、跑哪些服務、要不要換埠或環境變數、要不要加入某個 Core。`miyoria init`、`add`、`remove`、`host join` 會寫它。

### 一台電腦的設定

```bash
miyoria init                    # 第一題:這台電腦要做什麼;寫 host.toml(要跑 Core 的也寫 miyoria.toml 和 .env)
miyoria add asr tts turn        # 加服務:uv 建環境、下載缺的模型檔(先問),最後列出還要你自己處理的事
miyoria up                      # 在背景啟動 hostd,再由它依序啟動 host.toml 啟用的服務
miyoria status                  # 看每個服務的狀態、健康、埠
```

`miyoria add` 不給名字會列出目錄。給名字時它:

1. 在 `host.toml` 加 `[services.<名稱>]`(沒有 `host.toml` 就建一份);
2. 用 uv 把服務資料夾的 `pyproject.toml` 和 `uv.lock` 裝成 `<狀態資料夾>/envs/<名稱>`(`uv sync --frozen`,版本全部照 lock 檔,包括 CUDA 版的 torch);沒有 uv 會停下來告訴你怎麼裝,裝好後重新執行同一個指令,做完的會跳過;
3. 下載服務 `[[install.files]]` 列的模型檔(見下面 [自動下載的模型檔](#自動下載的模型檔));
4. 檢查 `[install] system` 的程式有沒有在 PATH 上(例如 ffmpeg;不會替你裝),列出 `[install.manual]` 要你自己放的東西。

#### 自動下載的模型檔

`service.toml` 的 `[[install.files]]` 每一個檔案都寫明:放在哪裡(`<狀態資料夾>/models/` 底下的相對路徑)、從哪裡來(https 網址,或 Hugging Face 的 repository、檔名和**固定的 commit**)、SHA-256、大小、是什麼、授權。只放公開、可以自由下載的權重;她的聲音模型、參考音這類私人的東西一律是 `[install.manual]`,不會自動下載。

- `add`、`update`、`doctor --fix` 下載之前先列出每個檔案的大小、授權和來源,加總後**問一次**;`-y` / `--yes` 不問。沒有終端機又沒有 `--yes` 時,印出清單和要執行的指令後以失敗結束,什麼都不下載。回答「不要」時其他步驟照做,缺的檔案留著,之後 `miyoria doctor --fix` 可以補。
- 只從 https、只從允許的主機下載:huggingface.co(和它的 CDN)、github.com 的 release 檔案、raw.githubusercontent.com;每一次轉址都重新檢查,最多 5 次。擴充的 `service.toml` 不能自己加主機,寫了清單外的主機那個服務會被標成有問題。
- 先寫到 `<檔名>.part`,中斷了重跑會用 Range 續傳;一段時間收不到資料或伺服器暫時出錯會等一下再重試。SHA-256 對了才改名成正式的檔名,不對就刪掉並報錯。磁碟剩的空間不夠「要下載的大小 + 512 MB」時不開始,訊息會寫出數字。下載的檔案只會放在模型資料夾裡,也從來不會被執行。
- 缺少必要的檔案(沒標 `optional = true` 的)時 hostd 不會啟動那個服務,`miyoria status` 的原因會寫是哪個檔案;標了 `optional` 的(服務沒有它也能跑,只是退回比較陽春的做法)不擋啟動。
- 算過的 SHA-256 記在 `<狀態資料夾>/models.verified.json`(連同檔案的大小和修改時間),之後 `doctor` 只重算有變的檔案;`doctor --deep` 每個都重算。
- `miyoria doctor --print-hashes <服務>` 印出這台電腦上那個服務的檔案(`[[install.files]]` 的,和 `[install.manual]` 資料夾裡的)的 SHA-256 和大小,照 `service.toml` 的寫法,方便把手動放的檔案改成自動下載。

**現在自動下載的**:sing 的兩個分離模型(`vocal-split/MelBandRoformer.ckpt`、`lead-split/becruily-bs/bs_roformer_karaoke_frazer_becruily.ckpt` 和它的設定檔,2026-11-18 對過實際檔案和 repository 公布的 SHA-256 後填入 `workers/sing/service.toml`)。turn 的兩個小模型還沒有:repository 裡沒有它們的 SHA-256 和 commit,所以先註解掉、照舊列成手動項目;在有這些檔案的電腦上執行 `miyoria doctor --print-hashes turn` 填進去、取消註解後就會自動下載(見 `workers/turn/service.toml` 的 `TODO(owner machine)`)。

**沿用舊位置的檔案(`adopt_from`)**:`[[install.files]]` 可以寫 `adopt_from`,值是工作區(`host.toml` 所在資料夾)底下的相對路徑,指這個檔案手動放的舊位置(例如 sing 的 `workers/models/vocal-split/MelBandRoformer.ckpt`)。`add` / `update` / `doctor --fix` 發現檔案在 `<狀態資料夾>/models/` 還沒有(或不對),而舊位置的檔案大小和 SHA-256 都符合,就改用**硬連結**把它接過來(同一個磁碟上不多佔空間;跨磁碟時才複製),不下載、不問(清單上寫「沿用 …」,不算進要下載的大小),舊檔案原封不動。大小或檢查碼不符的舊檔案會被忽略,照一般方式下載。sing 的 worker 自己也先找 `SING_MODELS_DIR`(hostd 給的 `<狀態資料夾>/models`),找不到就退回舊位置(`workers/sing/modelpaths.py`),所以 `update` 抓檔案之前什麼都不會壞;`SING_VOCAL_MODEL`、`SING_LEAD_MODEL` 指定的完整路徑永遠優先。人聲分離的 `MelBandRoformer.yaml` 沒有固定來源,仍然是手動的(放在 `workers/models/vocal-split/` 或 `<狀態資料夾>/models/vocal-split/` 都找得到)。

Hugging Face 上的大模型(ASR、TTS)`add` 不下載:第一次啟動時服務自己下載,或先 `miyoria models pull <服務>`(下載到 `<狀態資料夾>/models`)。要同步別的 extras(例如 ASR 的 `sensevoice`):`miyoria add asr --extra sensevoice`(只能用在一個服務,另外要在 `[services.asr]` 用 `env` 設 `ASR_BACKEND`,見 [workers/README.md](../workers/README.md))。`--no-install` 只寫 `host.toml`,不建環境。

`miyoria remove <服務>` 停止它、刪掉它的環境(下載的模型留著)、從 `host.toml` 拿掉;`--keep-env` 保留環境。`miyoria models gc` 列出沒有任何服務用到的模型,確認後才刪。

**要人自己放的東西**(`add` 的輸出、`doctor` 都會列;路徑是從 repository 根目錄算起,`<模型資料夾>` 是 `<狀態資料夾>/models`):

| 服務 | 要自己放的 | 說明 |
|---|---|---|
| `tts` | `workers/voices/<聲音>/ref.wav` 和 `ref.txt` | 她的聲音參考音,不進 git;`<聲音>` 預設 `deepseek-chan`([workers/README.md](../workers/README.md) 第 4 節) |
| `turn` | `<模型資料夾>/smart-turn/smart-turn-v3.2-cpu.onnx`、`<模型資料夾>/silero-vad/silero_vad.onnx` | 兩個公開的小模型,填好檢查碼後改成自動下載(見上面);沒有也能跑,Core 退回舊的判斷 |
| `sing` | `workers/models/applio`、`workers/models/vocal-split/MelBandRoformer.yaml`、`workers/models/seed-vc` | 她的 RVC 歌聲模型(私人)、人聲分離模型的設定檔(沒有固定來源)和 Seed-VC 原始碼(是程式碼,不自動下載)。兩個分離模型本身(`vocal-split`、`lead-split`)由 `update` 自動下載,舊位置 `workers/models/` 裡的沿用;沒有的部分會退回或略過,見 [workers/README.md](../workers/README.md) 第 9 節 |
| `mediamtx` | `workers/mediamtx/mediamtx.exe` | 見下面 [MediaMTX](#mediamtx) |
| `voice-node` | `apps/voice-node/.env` | `SELF_TOKEN`,見下面 [Voice node](#voice-node) |

`miyoria add voice-node` 目前只能在有 repository 的資料夾裡做(語音節點還沒有跟著套件發行,見 [backlog](design/backlog.md))。

### 每天的指令

| 指令 | 做什麼 |
|---|---|
| `miyoria status [--all]` | 這台電腦的服務(狀態、健康、埠),和執行中 Core 的模組與 LLM 用量。`--all` 另列 Core 知道的每一台電腦和已連線那些的服務 |
| `miyoria logs <服務> [-f] [-n 100]` | 看一個服務的日誌最後 100 行(`-n` 改行數,最多 2000);`-f` 持續追蹤,Ctrl+C 結束 |
| `miyoria up [服務...]` | 沒給名字就啟動 `host.toml` 啟用的全部。hostd 沒在跑時先在背景啟動它。`--timeout 秒` 最多等多久、`--no-wait` 交給 hostd 就結束 |
| `miyoria up --foreground` | 不經背景的 hostd,在這個終端機監管並顯示狀態;Ctrl+C 依相反順序停止全部 |
| `miyoria down [服務...]` | 停止指定的服務;沒給名字就停止全部並結束 hostd |
| `miyoria restart <服務>` | 重新啟動一個服務(重啟前會重新讀 `host.toml` 和 `service.toml`) |
| `miyoria doctor [--deep] [--fix]` | 檢查這台缺什麼,見下面 [用 doctor 檢查](#用-doctor-檢查);`--print-hashes <服務>` 印出現有檔案的 SHA-256 和大小 |
| `miyoria update` | 更新程式碼和環境,見 [§6](#6-升級) |
| `miyoria add` / `remove` / `models pull` `ls` `gc` | 見上面 |
| `miyoria hostd` | 在這個終端機執行 hostd 本身(`up` 平常會替你在背景啟動它) |

`status`、`logs`、`down`、`restart` 都只在 hostd 有在跑時才有東西可問;`up` 啟動它。`miyoria logs` 在 hostd 沒在跑時仍然讀得到檔案。

**hostd 的行為**:

- 服務死掉(行程結束或連續健康檢查失敗)就自動重啟,間隔 1、5、30 秒(之後都是 30 秒);10 分鐘內失敗 5 次就放棄,狀態是 `failed`,日誌的最後幾行會印出來。這些數字是每個服務 `service.toml` 的預設,可以改。重啟死掉的服務不會問任何人。
- `up` 看到埠上已經有東西在回應、但不是這個 hostd 啟動的,標成 `foreign`,**不會動它,也不會結束它**。埠被別的程式佔用、或被 Windows 保留(EACCES)時,服務不起來並說明原因。
- Windows 上停服務是直接結束整棵行程樹(`service.toml` 的 `grace_s` 之後),沒有溫和停止。
- 服務只繼承系統基本變數、CUDA 與模型快取、proxy,不繼承 shell 裡的 API key 和 token;Core、Voice node 和 Stage 例外,拿到完整的環境(金鑰和 token 來自 `.env`)。
- `up` 在跑 Core 的那台電腦上,Core 起來後會自動把這台連到自己的 Core(印一行「這台電腦已連上本機的 Core」,等於 `miyoria host join --local`);不想要就 `--no-link`。
- 登入時自動啟動:`miyoria host autostart on|off|status`(`on` 會先印出要執行的指令並確認)。

**這台電腦上的檔案**(狀態資料夾預設是 `data/host`,在 `host.toml` 的 `[paths] state` 改):

| 路徑 | 內容 |
|---|---|
| `host.toml` | 這台電腦的設定(工作資料夾,不進 git) |
| `<狀態資料夾>/envs/<服務>/` | uv 建的 Python 環境。`host.toml` 的 `[services.<名稱>] python = "<路徑>"` 指定的環境不在這裡,`add`、`update`、`remove` 都不會動它 |
| `<狀態資料夾>/models/` | 下載的模型;`hf/` 是 Hugging Face 的快取(hostd 啟動的 Python 服務用它當 `HF_HUB_CACHE`),其他是 `[[install.files]]` 的檔案(和沒下載完的 `.part`) |
| `<狀態資料夾>/models.verified.json` | 已經驗證過的模型檔 SHA-256,連同大小和修改時間;刪掉只會讓下次 `doctor` 重算 |
| `<狀態資料夾>/logs/<服務>.log` | 服務的 stdout 和 stderr;每 10 MB 輪替一次,留舊的 5 份(`<服務>.log.1` 到 `.5`)。hostd 自己的日誌是 `hostd.log` |
| `<狀態資料夾>/run/hostd.json` | 正在跑的 hostd 的 pid、本機 API 埠和 CLI 用的 token(只有你的使用者讀得到) |
| `<狀態資料夾>/host.key` | 這台加入 Core 之後的金鑰(`{ "id", "key" }`,不要給別人) |

`data/` 在 `.gitignore` 裡,所以狀態資料夾不會進 git。

### 受保護的服務

她在唱歌或直播時,**Core、Voice node 和 Stage 不會被重啟或停止**(它們的 `service.toml` 有 `guard`:Core 和 Voice node 是唱歌和直播,Stage 是直播)。`miyoria restart`、`miyoria down`(停這些服務,或整台全停)、`miyoria remove` 和 `miyoria update` 會先問 Core 她現在的狀態:

- 在唱歌或直播時,指令停下來說明原因,什麼都不動;等她不忙再執行,或加 `--force` 照做。`update` 沒有 `--force` 這個意思(它的 `--force` 是全部重建):忙的服務會被留著不動,它印出之後要執行的 `miyoria restart <服務>`。
- 問不到 Core 的狀態(Core 沒起來、不是這台的服務、控制連線斷了)時,一樣拒絕,要確定要做請加 `--force`。
- 平常的狀態來源是 Core 的 `/api/public/status`(要 `[modules.api.public]` 開著才有);控制連線接上之後,改由 Core 直接回答。
- 其他服務(ASR、TTS、sing、turn、lyrics、MediaMTX)沒有保護,隨時可以重啟。要注意:重啟 `tts` 或 `asr` 會讓她那幾秒說不出話或聽不見;`sing` 做歌到一半被重啟,那首歌就失敗了。
- 第一次加入 Core 之後,已經在跑的 Voice node 和 Stage 會自動重啟一次,拿到 Core 給的連線位址和 token;如果她正好在唱歌或直播,它們繼續跑,狀態會寫著需要重啟,等她不忙再 `miyoria restart`。

### 用 doctor 檢查

`miyoria doctor` 先做設定檔、角色、LLM、Discord、資料庫(只有跑 Core 的電腦),再對 `host.toml` 啟用的每個服務檢查它的 `service.toml` 說需要什麼:

| 檢查 | 抓什麼 |
|---|---|
| hostd | 有沒有在跑,幾個服務在跑 |
| 平台 | 服務只支援別的作業系統(例如 MediaMTX 只有 Windows) |
| 環境 | uv 環境沒建、或和 `uv.lock`、extras、`service.toml` 不一致;`host.toml` 的 `python` 指到不存在的環境 |
| 系統程式 | `[install] system` 的程式(例如 ffmpeg)不在 PATH 上 |
| 手動項目 | `[install.manual]` 要你自己放的東西缺了(警告) |
| 檔案 | `[[install.files]]` 每個檔案:在而且 SHA-256 對(✓)、缺(必要的 ✗,hostd 不會啟動服務;`optional` 的 !)、大小或 SHA-256 不對(✗)。SHA-256 只在檔案新出現或改過時重算,`--deep` 全部重算 |
| 模型 | Hugging Face 模型還不在快取裡(警告,第一次啟動會自己下載) |
| host.key、Core 連線 | 只在 `host.toml` 有 `[cluster]` 時:這台有沒有加入、Core 有沒有接受、連線通不通 |

`--deep`(`--deep-only` 只跑部署檢查,不連 LLM、Discord、資料庫)另外加。只讀:不會改 Windows、防火牆或防毒設定,每個 ✗ / ! 都附修正步驟:

| 檢查 | 抓什麼 |
|---|---|
| 匯入檢查 | 用服務自己環境的 Python `import` 它 `service.toml` 的 `check_imports` 列的套件(例如 sing:`torch`、`demucs`、`librosa`)。換了非預設的後端(例如 ASR 的 `sensevoice`)時,那份清單是預設後端的,可能誤報失敗 |
| 埠 | 動態埠範圍從 1024 開始、設定裡的埠落在 Windows 保留範圍(綁定 EACCES 但沒人在聽)、埠被別的程式佔用 |
| 服務健康 | 各服務的健康檢查路徑(`/health`);執行中的 Core 版本和這份 CLI 不同;turn 的模型沒載入 |
| 顯存 | `nvidia-smi` 的使用量,以及各服務估計值(常駐的加上做歌這類工作時的尖峰)是否超過「總量減 `[gpu] reserve_mb`」的 92% |
| 狀態資料夾 | 能不能寫入 |
| 建置 | SDK、擴充 `dist`、面板、overlay 比原始碼舊或是空的 |
| Minecraft mod | jar 比原始碼舊、遊戲 `mods/` 裡的 jar 和建置出來的不同、`Protocol.java` 與 `PROTOCOL.md` 的協定版本不一致、找不到 JDK 21(PATH 上是 Java 8 也會說) |
| 暫存檔 | 在暫存資料夾寫、讀、刪 2 MB 檔案(防毒鎖檔的症狀)、殘留的 `esbuild-*`、偵測到 Kaspersky 等會說明 |

`--fix` 只做安全的修復:把缺的或過期的環境同步一次、下載缺的或不對的模型檔(先列出來問一次,`-y` 不問)。不裝系統程式、不改任何系統設定、不重啟服務。

Windows 保留埠的處理需要系統管理員,要自己做:`netsh interface ipv4 show excludedportrange protocol=tcp` 查看,`net stop winnat` 再 `net start winnat` 釋放;長期做法是 `netsh int ipv4 set dynamic tcp start=49152 num=16384`(要重開機)。

### 多台電腦

另一台電腦(例如有顯卡的那台)可以替 Core 跑服務,它不需要自己的 Discord token、LLM key 或資料庫。步驟也在 [SETUP.md](SETUP.md) 的「第二台電腦」。

1. **Core 那台**:`miyoria host invite [--name <名字>] [--ttl <分鐘>]`。印出一組只能用一次的邀請碼(預設 10 分鐘有效),和另一台要執行的整行指令。
2. **另一台**:`miyoria init`,第一題選「只提供服務給別台的 Core」(或直接 `miyoria add <服務>`);裝好要提供的服務;再執行 `invite` 印出的那行:
   ```bash
   miyoria host join <Core 的位址> --code <邀請碼> [--name <名字>]
   ```
   `<Core 的位址>` 是 Core 管理 API 的位址,例如 `http://100.64.0.5:7878`。它把 `host.key` 存進狀態資料夾、在 `host.toml` 寫 `[cluster] url`。這台已經加入過別的 Core 時,要先在原來的 Core 上 `miyoria host remove`,再加 `--force`。
3. **Core 那台**:`miyoria host approve <名字> [能力...]`。核准之前,那台的服務不會被使用;不列能力就核准它目前回報的全部(`asr`、`tts`、`sing` ...)。`miyoria host ls` 看每一台的狀態、是否已連線、核准了哪些能力、版本和最後上線;`miyoria host remove <名字>` 讓金鑰失效、斷線、它的服務不再被使用。
4. **另一台**:`miyoria up`。

Core 預設只聽本機。要讓別台連進來,把 `[modules.api] bind`(管理 API,`7878`,`join` 用它)和 `[modules.cluster] bind`(控制連線,`7880`)改成這台的區網或 Tailscale 位址,再重啟 Core:

```bash
miyoria config set modules.api.bind 100.64.0.5:7878
miyoria config set modules.cluster.bind 100.64.0.5:7880
miyoria restart core
```

`invite` 發現管理 API 只聽本機時會提醒你。Core 在反向代理後面時,在 `[modules.cluster]` 設 `public_url = "wss://core.example/cluster-link"`,`join` 才會給新電腦正確的連線位址。`miyoria status --all` 和面板的「電腦」頁(`/machines`)列出每一台電腦和它的服務、「誰負責什麼」,也能在那裡產生邀請碼。

**「經連線」是什麼意思。**加入的電腦是**它主動撥一條連線到 Core**(控制連線,Core 的 `7880`);Core 要呼叫它的服務時,請求就走這條線回去,大的檔案(做好的歌)也一樣。所以**那台電腦不用開埠、不用設防火牆、也不用把它的位址告訴 Core**;唯一要它連得到的是 Core 的兩個位址。面板把這種服務標成「經連線」,Core 直接連的標成「直連」。

**什麼時候才要設 `[network]`。**只有**即時語音**要直連:Core 呼叫 ASR、TTS、turn、VAD 時只用「直連」的位址,不走中繼。所以如果有 ASR、TTS 或 turn 跑在**另一台**電腦,那台的 `host.toml` 要寫:

```toml
[network]
bind = "100.64.0.7"            # 服務聽的位址(預設 127.0.0.1)
advertise = "100.64.0.7"       # Core 怎麼連到這台;沒寫就沒有人能直接呼叫這台的服務
```

並且只對 Core 那台放行(Tailscale ACL 或防火牆);hostd 啟動的 worker 會檢查 token(見下面),但 token 不是加密。翻唱、生圖、歌詞不需要這個設定。

**Core 怎麼挑服務。**每個服務在 `routing.toml`(放在 `service.toml` 旁邊)宣告它怎麼分派,詳細見 [v5-hostd.md](design/v5-hostd.md) §15:

| 類別 | 服務 | Core 怎麼挑 |
|---|---|---|
| `single`(唯一) | core、voice-node、stage、mediamtx、OBS、VTube Studio | 整個叢集只用第一個出現的那個;第二個是衝突,面板和日誌會寫出來,不會被用 |
| `session`(工作階段) | tts、asr、turn | 和以前一樣:依 `[modules.cluster.order]`(例如 `tts = ["main-pc"]`),沒列到的排後面,健康的排前面 |
| `job`(工作) | sing、lyrics、ComfyUI | 每個工作送到「做完並傳回 Core 最快」的那台:排隊、那台的速度、傳回的時間,加上懲罰(剛失敗、顯卡被別的服務借走、不知道它忙不忙、她的語音在那台、`order` 排後面一位 +30 秒),除以權重 |

沒有 `routing.toml` 的服務(和比較舊的 hostd 回報的)照舊:依 `order` 的第一個健康的。失敗的服務先被跳過 `retry_secs`(預設 30 秒)。不接新工作的(沒準備好、聲音模型和別台不同、被排除、被清空、那台的主人設 `accept = false`)不會被挑,但已經在那台做好的歌照樣從那台拿。**沒有 hostd 管的服務**(例如還沒升級的朋友那台翻唱 worker)才在 `miyoria.toml` 寫位址:`[modules.cluster.static.<名字>]` 的 `provides` 和 `url`(有 token 時加 `token = "${FRIEND_SING_TOKEN}"`);`speech.*.url`、`[modules.voice] turn_url`、`[modules.sing] url` 與 `fallback_urls`、`[modules.imagegen] url` 也是同樣的用途。其中 `turn_url`、`sing.url`、`imagegen.url` **沒有預設值**:沒寫就是沒有,由 hostd 回報的服務補上。設定檔寫的位址和 hostd 回報的位址要**寫法一致**(`localhost` 和 `127.0.0.1` 不算同一個)才會被當成同一個。

**token。**hostd 每次啟動 Python 服務都給它一個新的 token,Core 呼叫時帶上;worker 對每個路徑(包括 `/health`)檢查 `Authorization: Bearer`。**自己手動跑的 worker 沒有檢查**,和以前一樣。同一台電腦的服務之間(翻唱 worker 叫 TTS 和 ASR 讓出顯卡)用另一個每次啟動 hostd 才換的共用 token。

### 工作分到多台電腦

同一個 `job` 服務(例如 sing)可以裝在好幾台電腦上,Core 會自己分。面板「電腦」頁的「誰負責什麼」列出每個能力的類別、每台的分數(和怎麼算出來的)、正在做和排隊的數量、Core 量到的「一個工作要多久」和「傳回多快」,以及最近幾個工作為什麼送到哪台。

**她的語音所在的電腦。**翻唱會把 TTS 和 ASR 擠出顯卡,所以預設不送到正在跑她語音的那台(`allow_on_speech_host = "never"`)。要讓這台在她閒著時也做歌:

```toml
[modules.cluster.routing]
allow_on_speech_host = "when_idle"   # never(預設)| when_idle | always
idle_minutes = 10                    # when_idle:多久沒人說話才算閒著
```

**擁有者的控制**(面板「電腦」頁,需要 `owner.cluster.route`,只有擁有者角色有;每次都記進稽核紀錄),也可以寫在設定檔(面板上會標「設定檔」,不能在面板改):

| 控制 | 面板 | 設定檔 |
|---|---|---|
| 釘選:這個能力只送這台 | 只用這台 | `[modules.cluster.routing.capabilities.sing] pin = "friend-pc"` |
| 排除:這台不接這個能力 | 排除 | `... exclude = ["laptop"]` |
| 權重:分數除以它(2 = 大約兩倍的工作) | 權重 | `[modules.cluster.routing.weights] friend-pc = 2` |
| 清空:做完手上的,不接新的 | 清空 | `[modules.cluster.routing] drain = ["old-pc"]` |

從面板更新一台電腦時,Core 會在更新期間自動清空它,所以它的排隊會做完,更新的「等她忙完」才等得到。

**別台電腦的主人自己限制**(他的 `host.toml`,Core 改不了):`[services.sing]` 的 `accept = false`(服務照跑,不接 Core 的新工作)和 `concurrency = 1`(同時最多幾個)。這兩個鍵比較舊的 hostd 看不懂,會拒絕整個 `host.toml`:**先更新那台,再寫**。

### 搬舊的設定

以前用 `miyoria.toml` 的 `[machine]` 和 `[stack]` 設定、`miyoria start` 或舊的 `miyoria up` 啟動的電腦,轉一次:

```bash
miyoria host migrate --dry-run     # 先看會寫什麼
miyoria host migrate               # 寫 host.toml(已經有的要加 --force 覆寫)
```

它從 `[machine]` 和 `[stack]` 寫出 `host.toml`:每個 worker 的 `python = "<舊的 venv>"`、`port` 和 `env`,Core、voice node、stage 是否啟用。**舊的虛擬環境照樣能用**:`[services.<名稱>] python` 指著它們,hostd 不會動它,`add`、`update`、`remove` 也不會。`host.toml` 說不出來的(例如 `offload` 清單、`vram_mb`、`start_timeout_secs`)會列成「沒有帶過來」。轉完之後 `[stack]` 和 `[machine]` 不再有作用,`miyoria start`、`miyoria install` 和舊的 `miyoria up` 選項(`--only`、`--skip`、`--dry-run`、`--no-check`)都已經沒有了。

之後要把某個服務換成 uv 管理的環境:在 `host.toml` 拿掉那個服務的 `python =` 那一行,執行 `miyoria add <服務>`(或 `miyoria doctor --fix`)建新環境,再 `miyoria restart <服務>`。換之前舊環境留著,一個服務一個服務換。

**切換那天要注意的事**(第一次把一台已經在用的電腦交給 hostd):

- **先停掉舊的全部服務**,尤其是 Voice node:它沒有埠,hostd 看不到手動啟動的那一個,兩個同時在會讓 self 帳號登入兩次。
- **三個位址不再有預設值**:`[modules.voice] turn_url`、`[modules.sing] url`、`[modules.imagegen] url` 沒寫就是沒有。切換前檢查線上設定有沒有靠預設值;hostd 沒連上時,要靠設定檔明寫。
- **位址要寫法一致**:設定檔的位址和 hostd 回報的位址,`localhost` 和 `127.0.0.1` 不算同一個。對不上時會用到沒有 token 的那一筆,worker 有檢查 token 之後就是 401。
- **7880 埠**要沒有別的東西占著(Core 的 `cluster` 模組用);被占用時這個模組會失敗,Core 照常執行,但別台電腦連不進來。
- 朋友那台升級前是靜態登記(沒有 token);升級並加入之後走控制連線,見 [sing-remote-host.md](sing-remote-host.md)。

### Voice node

```bash
miyoria add voice-node                # 要在 repository 裡;列出還要你處理的事
cp apps/voice-node/.env.example apps/voice-node/.env     # 填 SELF_TOKEN
miyoria up voice-node
```

hostd 用 `pnpm start` 在 `apps/voice-node` 跑它(從原始碼,tsx),所以 repository 根目錄要先 `pnpm install`。它在 Core 之後才啟動(`service.toml` 的 `after`)。

- `SELF_TOKEN`(self 帳號的 token)永遠寫在 `apps/voice-node/.env`,不會由 hostd 給。
- **已經加入 Core 的電腦**:Core 的 voice link 位址和 token 由 hostd 給(`VOICE_LINK_URL`、`VOICE_LINK_TOKEN`),`.env` 裡不用填這兩項;hostd 給的值優先於 `.env`。
- **沒有加入的電腦**:照舊在 `.env` 填 `VOICE_LINK_URL`(同機 `ws://127.0.0.1:7879/voice-link`;跨機用 `ws://<tailnet-ip>:7879/voice-link` 或 `wss://voice.example.com/voice-link`)和 `VOICE_LINK_TOKEN`(必須跟 Core 的 `.env` 一樣)。
- 啟動後在 Discord 打 `/voice join`,她就會進你所在的語音頻道。詳細設定見 [apps/voice-node/README.md](../apps/voice-node/README.md)。
- 重啟它要看她有沒有在直播(受保護,見上面);`Ctrl+C` / SIGTERM(`miyoria down voice-node`)會先離開語音頻道再結束,但 Windows 上 hostd 停服務是直接結束行程樹。
- 登入時自動啟動:`miyoria host autostart on`(見上面)。

### Core

hostd 啟動(平常的做法,見上面):`miyoria up core`。前景直接跑一個:

```bash
miyoria core                            # 或從原始碼:pnpm dev:core
```

Core 預設在 `http://127.0.0.1:7878/` 提供管理面板(從原始碼要先 `pnpm build:web`)。

Docker:

```bash
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml logs -f core
docker compose -f deploy/docker-compose.yml down       # 停止(資料 volume 保留)
```

(Docker 的 Core 由 compose 管,不是 hostd 的服務;`deploy/` 的檔案這一輪沒有跟著改,見 [backlog](design/backlog.md)。)

Core 起來之後,用 CLI 操作(CLI 讀 `miyoria.toml` 的 `[modules.api]` 連 `127.0.0.1:7878`;Core 在 server 時,先 `ssh -L 7878:127.0.0.1:7878 <server>` 或走 Tailscale):

```bash
miyoria status                  # 這台的服務,和 Core 的各模組狀態、LLM 用量
miyoria module list             # enable / disable / restart <id> 可以單獨啟停子系統
miyoria decisions               # 她為什麼回話或沉默
miyoria events 'agent.*'        # 即時事件
miyoria persona show
```

### 推論 worker

見 [workers/README.md](../workers/README.md)。從零裝起:

```bash
miyoria add asr tts turn          # 要裝的 worker;ASR 和 TTS 要 NVIDIA 顯卡和 uv
miyoria up
```

沒有 GPU 時先用 `workers/fake`(不經 hostd,手動跑,`http://127.0.0.1:8000`,見 workers/README.md 第 0 節),並在 `miyoria.toml` 把 `[speech.asr.local]`、`[speech.tts.local]` 的 `url` 指過去。

檢查 worker 是否符合協定(對 hostd 啟動、有 token 檢查的 worker,要帶 token,所以這個測試用在手動跑的 worker 或 fake):

```bash
WORKER_ASR_URL=http://127.0.0.1:8001 WORKER_TTS_URL=http://127.0.0.1:8002 python -m pytest tests/test_contract.py
```

**翻唱要和 ASR、TTS 在同一台**:`sing` 做歌時要請 TTS 和 ASR 讓出顯卡。hostd 啟動 `sing` 時會把這台電腦上 TTS 和 ASR 的位址放進 `SING_OFFLOAD_URLS`(`sing` 在它們之後啟動)。**顯卡的仲裁目前還是翻唱 worker 自己做**:hostd 那一份已經寫在這個分支上,但預設關著、還沒做完,不要用,進度見 [design/v5-gpu.md](design/v5-gpu.md)。

做歌時的 GPU 分配由 song worker 依當下狀態決定,不用設大小。`GET :8005/health` 的 `gpu` 欄位看得到決定和原因,學到的數字存在歌曲快取的 `_gpu-profile.json`,換卡會重來。要固定做法時在 `host.toml` 的 `[services.sing] env` 設 `SING_GPU_POLICY`:

| 值 | 行為 |
|---|---|
| `auto`(預設) | 放得下就共用,放不下先用 CPU 和等待,語音只在必要時短暫下線 |
| `share` | 永遠不動語音 |
| `wait` | 永遠不動語音,沒空間就等 |
| `offload` | 一律讓語音下線(舊行為) |

TTS 和 ASR 的模型跑在子程序,`/offload` 結束子程序,回傳的 `released_mb` 是整張卡實際還回的量。`TTS_ENGINE_PROCESS=0` 或 `ASR_ENGINE_PROCESS=0` 可以改回同一個程序,但卸載就不一定還得回顯存。

**歌詞。**加入 Core 的電腦上由 hostd 啟動的翻唱 worker **自己找歌詞**,需要 LLM(猜原曲)和 ASR(抽查歌詞)時經它的 hostd 請 Core 代跑:LLM 的金鑰不離開 Core,每次呼叫照樣記進每天的預算和呼叫紀錄;ASR 抽查由 Core 轉給它的 ASR。**歌詞服務**(`lyrics`,`8007`)只給**沒有加入**的電腦上的翻唱 worker 用(它的 `SING_LYRICS_URL` 指到這個服務):歌詞服務自己不再讀 `miyoria.toml`,要嘛由 hostd 啟動並已加入 Core,要嘛設 `SING_LYRICS_LLM_URL`、`SING_LYRICS_LLM_KEY`、`SING_LYRICS_LLM_MODEL`(三項,URL 和 MODEL 都有才用)。細節見 [sing-remote-host.md](sing-remote-host.md) 和 workers/README.md 第 9 節。

### MediaMTX

OBS 推的 RTMP 由 MediaMTX 中轉給 voice node 和 Core 的 LL-HLS(只有 Windows;選用,`[modules.live.video]`)。hostd 依 `workers/mediamtx/service.toml` 啟動它:`miyoria add mediamtx`、`miyoria up mediamtx`。要自己放的只有一樣:

- `workers/mediamtx/mediamtx.exe`(不進 git;從 <https://github.com/bluenviron/mediamtx/releases> 下載 `mediamtx_v1.21.3_windows_amd64.zip`,用同一頁的 `checksums.sha256` 核對)。

它還需要環境變數 `MIYORIA_HLS_SECRET`(寫在 `.env`,和 Core 的 `[modules.live.video] secret` 是同一個值):hostd 把它當成 `MTX_HLSCDNSECRET` 交給 MediaMTX。hostd 是從執行 `miyoria up` 的環境拿到它的(`miyoria` 會讀 `.env`),所以改了 `.env` 之後要 `miyoria down` 再 `miyoria up`。沒有這個變數,服務會被停用並說明原因。健康檢查目前只看埠(`9997`)有沒有開。MediaMTX 有三個埠(API、RTMP、LL-HLS),voice node 的編碼器用其中一個,所以 `[modules.live.video]` 仍然自己寫位址,MediaMTX 不進登記處。更多見 [workers/mediamtx/README.md](../workers/mediamtx/README.md)(裡面講 `start.ps1` 的部分是舊的)。

### Stage 與管理面板

Stage 要直接碰 VTube Studio / OBS / 遊戲,所以原生在直播機執行,不放 Docker:由 hostd 啟動(`miyoria add stage`、`miyoria up stage`,她直播時不會被重啟,見 [§4](#受保護的服務)),或前景跑一個 `miyoria stage`。它讀 `miyoria.toml` 的 `[stage]`(`core_url`、`token` = `STAGE_LINK_TOKEN`、`[stage.vts]`、`[stage.obs]`)。**已經加入 Core 的電腦**上,Core 的 stage link 位址和 token 由 hostd 給(環境變數 `STAGE_LINK_URL`、`STAGE_LINK_TOKEN`,優先於 `[stage]` 的 `core_url` 和 `token`);沒有加入的電腦照舊用 `[stage]`,也可以自己設這兩個環境變數。協定見 [stage-link.md](protocols/stage-link.md);overlay 見 [apps/overlay/README.md](../apps/overlay/README.md)。

**OBS 的場景和來源**由 `miyoria stage obs-setup` 建(在直播機上跑,先 `--dry-run` 看會做什麼),而且建在 Miyoria 自己的**場景集合**和**設定檔**裡(預設都叫 `Miyoria`),你原本的場景集合和設定檔不會被改、也不會被刪:

- **第一次**:建立設定檔 `Miyoria` 並切過去,只設兩件事:畫布和輸出 1920x1080(FPS 沿用切換前 OBS 的),打開重播緩衝(`basic.ini` 的 `SimpleOutput` / `AdvOut` 的 `RecRB`,簡易和進階輸出模式都開;OBS 只在載入設定檔時建立重播緩衝,所以會先切回你原本的設定檔再切回來一次)。再建立場景集合 `Miyoria`、在裡面建好所有場景和來源,最後把聊天場景設成目前的場景。結束時印出要貼進 `[stage.obs]` 的 `collection = "Miyoria"`、`profile = "Miyoria"`(設定檔不會被自動改)。
- **新的設定檔是空白的**:要從 OBS 推流的話,串流金鑰(設定 → 直播)和編碼器(設定 → 輸出)要在 `Miyoria` 設定檔裡重新設一次;它不會複製也不會碰你原本設定檔的串流金鑰、編碼器、錄影路徑。VTube Studio 的透明背景也還是要自己打開一次。
- **之後再跑**:切到已經有的 `Miyoria` 設定檔和場景集合,只補上缺的東西;已經有的設定檔不會再被改(你在裡面調的 FPS、編碼器都留著)。要它重新設 1920x1080 和重播緩衝:`--profile-settings`。
- **OBS 在推流、錄影、虛擬攝影機或重播緩衝開著時**,要切換場景集合或設定檔(或改設定檔)就拒絕並說要先停哪幾個:切換會打斷輸出。已經在 `Miyoria` 上、不用切換時照常補齊。
- 選項:`--collection <名稱>` / `--profile <名稱>` 換名稱(預設取 `[stage.obs] collection` / `profile`,沒設是 `Miyoria`);`--here` 直接建在 OBS 目前的場景集合裡(以前的做法);`--no-profile` 不換設定檔;`--relayout` 把已經有的項目擺回預設位置。
- **overlay 的聲音**:overlay 的兩個瀏覽器來源(`…/overlay/`、`…/overlay/?layout=sing`)勾「透過 OBS 控制音訊」(`reroute_audio`),已經有的再跑一次也會改成勾選:唱 K 房間的伴奏和播出的歌聲是 overlay 這一頁放的,要進 OBS 的混音,Go Live(`GOLIVE_AUDIO=true`)才帶得到。OBS 預設不監聽這個來源,直播機的喇叭聽不到;她的 TTS 不在 OBS 的混音裡,在語音頻道。見 [design/karaoke.md](design/karaoke.md)「做了什麼第五步」。
- OBS 換場景集合時會先送 `CurrentSceneCollectionChanging`,這段時間送別的請求會失敗,所以它等 `CurrentSceneCollectionChanged`(設定檔是 `CurrentProfileChanged`)才繼續,30 秒沒等到就停下來、不再送任何東西;等 OBS 換好(有對話框先關掉)再跑一次就好。

**執行時**:`[stage.obs] collection` 有設、OBS 卻在別的場景集合上時(Stage 連上 OBS 時和開始直播時檢查),Stage 不在 OBS 建任何東西(包括自動建的字幕文字來源),也不幫你切換;log 記一次警告,狀態裡的 `obs_warning` 寫「OBS 不在「Miyoria」這份場景集合上(現在是「…」)」,面板「直播」和 `/stream status` 會顯示。`profile` 不一樣時只記一行 info(精華要的重播緩衝在設定檔裡)。

餵食禮物的那一行(「Owen 餵了她一碗白飯」,60 秒內合併、約 8 秒後淡出)在預設的 overlay 頁(`http://127.0.0.1:7884/overlay/`)裡一起顯示;只要這一行時用 `…/overlay/?show=gifts`。

管理面板是靜態檔,由 Core 提供(`[modules.api] panel_dir`,`MIYORIA_PANEL_DIR` 可覆寫):npm 套件與 Docker 映像檔都已內含;從原始碼跑時先 `pnpm --filter @miyoria/panel build`(或 `pnpm build:web`,輸出 `apps/panel/dist`,Core 預設就讀這裡)。開發時 `pnpm --filter @miyoria/panel dev`(Vite,`http://localhost:5178`,`/api` 轉給 `MIYORIA_CORE_URL`,預設 `http://127.0.0.1:7878`)。

**連結預覽**:Discord、Slack、X 這類爬蟲不跑 JavaScript,所以 Core 送出 `index.html` 時按路由改寫 `<!-- meta:start -->` 到 `<!-- meta:end -->` 之間的標籤(標題、描述、`og:*`、Twitter card,`packages/api/src/meta.ts`)。`/card/<編號>` 的標籤帶那張卡的名字、稱呼、編號和框(都是卡片頁本來就顯示的),`og:image` 指到 `/og/card/<編號>.png?v=<卡片資料的雜湊>`:只有那張卡本身,1000×1397(卡的原比例,四角透明),和面板同一份繪圖(`packages/card-face`)用 resvg 畫出來,不需要瀏覽器。站台預設圖 `/og/default.png`(1200×630)是毛玻璃:靠左貼齊邊緣一片玻璃放名字和一句話,她站在右邊、壓過玻璃的邊。玻璃後面的光是她自己的立繪放大模糊做的,不用面板的背景圖(那是遊戲美術,只放在 owner 自己的螢幕上,不放進誰都能抓的預覽圖);沒有立繪就用暮色漸層(resvg 沒有 backdrop-filter,模糊是事先用 sharp 做好的)。圖按編號加資料版本留在記憶體(最近 64 張),卡的資料變了(換框、作廢)網址的 `v` 就變,上游快取不會吃到舊圖。編號不存在、格式不對、已作廢或讀不到時給站台預設標籤和 `/og/default.png`,不含任何人的資料。網址的 origin 取 `X-Forwarded-Host` / `X-Forwarded-Proto`,沒有就用 `Host`(隧道要把原本的 Host 傳進來)。畫圖只用專案帶的字型(`packages/card-face/fonts` 的 Noto Sans TC,SIL OFL 1.1),不用系統字型,哪台電腦畫出來都一樣;羈絆環的圖也是。每日卡的立繪是現場算的那張(見下面的「每日卡」),算不出來或是舊卡時讀 `panel_dir` 裡的 `card-<pose>.local.webp`,都沒有就畫不含立繪的卡。

**每日卡**(`[modules.cards]`,`packages/play/cards`,設計見 [design/v5-play.md](design/v5-play.md) §2、§10.2.3):會員頁的「抽一張新卡」和 `/me card` 發的是每日卡,一張 `price`(預設 30)魚幣,第一張也要錢,一天最多 `daily_cap`(5)張,部件照公開機率抽(`GET /api/public/cards/odds`,`/me card action:機率`),表情跟著關係。卡上的立繪用她的 Live2D 模型照抽到的部件、表情和種子現場算(設計見 [design/cards.md](design/cards.md) §6),算不出來就用 10 張固定圖裡最接近表情的那張;目前只有連結預覽的圖用到現場算的立繪,會員頁和 `/me card` 還是固定圖。舊的會員卡原樣留著;舊的抽收藏已經拿掉,大家已經有的收藏在模組啟動時複製到 `cards_legacy`,圖鑑裡是「舊收藏」。帳本的新原因是 `card_daily` 和 `card_refund`。改機率就是改 `rarity_weights`,設定的修訂紀錄就是改機率的紀錄。`POST /api/member/card` 的 `Idempotency-Key` 存在卡上(`cards_card.issue_key`),扣款用的卡號在扣款前先記下(`cards_pending`):同一個 key 重送,中間重啟過也一樣,回的是第一次那張卡、不會再扣錢;Core 剛好停在扣款和寫卡之間時,用同一個 key 重送會拿到那張卡(沒有重送的話,那筆錢目前不會自己退)。

**不用錢的卡**(不必設定):羈絆第一次升到某個分級(朋友、好朋友 …… 永恆羈絆,共 15 級;小階 I/II/III 不算)時,`cards` 模組給一張里程碑卡,一級一張、掉下去再升回來不會再給;字是 api 模組照每日卡的寫法請她寫的(知心以上會用那一級錨點的共同記憶),api 沒開時卡上只有名字。從舊紀錄搬過來的人(heart 的搬移留下 `legacy.migrated_at`,或 `miyoria db import-links` 帶過來的 `persons.legacy`)第一次打開自己的卡(會員頁的卡片、卡片列表、圖鑑,或 `/me card`)時拿到一張紀念卡,印著第一次見面的日子、以前的分級和舊卡張數(知道的話),不私訊、她也不會被通知。兩種都不算進每天的張數、不動保底;`cards` 模組沒在跑的時候升的級不會補發。

**頻道裡的掉落**(`[modules.cards] drops`,預設關,v5-play §6.2):打開後只在 `drop_channels` 列的頻道(頻道 id)。十分鐘內三個人以上共二十句以上(她自己和機器人的不算)就算熱鬧,一段時間擲一次 `drop_chance`(0.25);一個頻道一天最多 `drops_per_channel_day`(2)次、兩次至少隔 `drop_gap_mins`(120)分鐘;決定要掉後隨機等 30 到 180 秒才出現,十分鐘沒人撿就飄走。卡是一則中性的通知加一個「撿起來」按鈕(`/me card` 的路由,沒有新指令)。第一個按的人拿到一張免費的卡,帶一個只有掉落才有的部件,只有他看得到卡、通知改成「誰撿走了」;一人一天一張,同一個頻道上一張是你撿的就撿不到下一張;她不認識或不說的人撿不了。次數和時間記在 `cards_drop`,重啟不會重算;日誌有 `cards: dropped a card`。資料庫 migration 2 到 4(`issue_key`、`cards_drop`、`cards_pending`)啟動時自己跑,不用做什麼。

**卡的立繪(Live2D 算圖)**:在跑 Core 的那台電腦上算,模型不出機器。要準備的:

1. **Live2D 的檔案**:照 `tools/card-studio/vendor.md` 把 Cubism Core(`live2dcubismcore.min.js`,Core 5.1)和 Cubism Web Framework(`5-r.4`)放進 `tools/card-studio/vendor/`。這個資料夾在 `.gitignore` 裡,是 Live2D 的授權檔案,不要提交。
2. **建置**:`pnpm --filter @miyoria/card-studio build`(做出 `dist/` 的頁面和 Core 載入的 `dist/node/render.js`;沒有 `vendor/` 時它說明原因後什麼都不做)。`pnpm install` 已經裝好 playwright-core,不用另外下載瀏覽器:用這台電腦的 Edge(Windows 都有)或 Chrome。
3. **設定**:`[modules.cards] portrait_model` 指到模型的 `.model3.json`(例如 VTube Studio 的 `StreamingAssets/Live2DModels/DeepSeek-chan/大肥鱼.model3.json`)。`portrait` 預設 `"live2d"`,改成 `"fixed"` 就一律用固定立繪;`portrait_browser`(`msedge` / `chrome`)、`portrait_studio`(預設 `tools/card-studio`)、`portrait_cache`(預設 `data/cards/portraits`)、`portrait_cache_max_mb`(2048:`portrait_cache` 裡的圖最多佔多少 MB,超過就從最久沒用的刪起)、`portrait_timeout_secs`(30)。改完 `miyoria restart core`。

缺任何一樣(沒設模型、沒建置、少了 `vendor/`、開不了瀏覽器),Core 照常啟動,日誌寫一行 `card portraits: Live2D rendering unavailable` 說原因,卡用固定立繪。連續失敗三次會暫停十分鐘(一行 `paused`)。第一張約 3 秒(開瀏覽器、載入模型),之後一張約 0.5 秒;同一張卡只算一次,圖依「抽到什麼」的雜湊存在 `portrait_cache`(一張約 1 MB;啟動時和每算好一張後,總量超過 `portrait_cache_max_mb` 就刪最久沒用的,讀一次算用一次;刪掉的圖下次要用時照卡的快照重算出一樣的)。要看全部部件和表情長怎樣:`pnpm --filter @miyoria/card-studio sheet`,圖在 `.tmp-test/cards-sheet/`。

**每週的市集**(`[modules.market]`,`packages/play/market`,設計見 [design/v5-play.md](design/v5-play.md) §4.5、§11.4):點歌優先券、每週拍賣、每週樂透,做完就開,數字都是設定。魚幣都走經濟的帳本(要 `economy` 模組在跑),帳本的新原因是 `song_priority` / `song_priority_refund`、`lottery_ticket` / `lottery_refund` / `lottery_prize`、`auction_hold` / `auction_release` / `auction_won`;經濟健康表把優先券、彩券和得標算成回收,減掉退回和樂透獎金,押著的出價不算。她自己的帳號不能出價、買券或中獎。

- **點歌優先券**:`/queue song request priority:true`,或會員頁點歌時帶 `priority`(`POST /api/member/songs`)。一張 `song_priority`(40),一個人一天 `song_priority_per_day`(2,0 = 不賣)。這首排到沒用券的歌前面,用券的照先後;歌單卡片標「優先券」。歌沒排進去、沒做成、失敗或在唱之前被取消,券退回;唱了(或唱到一半被跳過)不退。她的提示詞不提券。
- **每週拍賣**:要設 `auction_channel`(頻道 id),沒設就不辦。每週六 20:00 在那個頻道貼一則拍品,開 24 小時,起標 50、每次至少加 5,最後 5 分鐘有人出價就延長 5 分鐘,最多延到原本結束後 30 分鐘(`auction_extend_mins`、`auction_extend_max_mins`)。大家按「出價」填金額(或 `/me auction bid:`),出價會押住錢,被超過馬上退回;結束時得標的錢燒掉、押著的還回去,沒人出價就什麼都不發生。拍什麼:`auction_lots` 裡的種類,預設只有 `["frame"]`(只此一件的卡框);owner 指定的(不在 `auction_lots` 裡的會被拒),否則她挑(一次小的模型呼叫,`auction_purpose`;只有一種就不呼叫),沒有模型就輪流。「只此一件的卡框」得標就是他的(卡框 `one-<拍品 id>`,只有他能選);「這一週她怎麼叫你」預設不拍(誰都能用 `/me call` 免費改稱呼),要拍就把 `"call_name"` 加進 `auction_lots`:等得標的人按「取名」給一個稱呼(或 `/me auction name:`),過稱呼的形狀檢查和審查、她不是很討厭他,就是她這 7 天對他的稱呼,之後換回原本的(他自己中途改過就不動);72 小時內沒給或按「不要了」就全額退回、不燒。拍賣中改 `auction = false` 或拿掉頻道:正在拍的取消、押著的全退。
- **每週樂透**:一張 10,一個人一週最多 20 張,週日 20:00 開獎。少於 3 個不同的人買就不開、全額退回;否則用系統的 CSPRNG 依張數抽一張,中的人拿賣出的七成,其餘燒掉。公告(有「買 1 張」「買 5 張」按鈕)和開獎發在 `lottery_channel`,沒設就用拍賣的頻道,兩個都空就不公告(照樣能用 `/me lottery count:` 和會員頁買)。改 `lottery = false`:不賣,這週已經賣的全額退回。 `/game lottery` 把這一週的獎池和開獎時間貼在當下的頻道,大家都看得到(不顯示誰買了幾張);`/me lottery` 只有本人看得到。
- **API**:會員 `GET /api/member/market/auction|bids|lottery|tickets`、`POST /api/member/market/bid {amount}`、`POST /api/member/market/name {name}`(或 `{give_up: true}`)、`POST /api/member/market/lottery {count}`(帶 `Idempotency-Key`);owner `GET /api/market/history`(含 `offered`、`next`)、`POST /api/market/plan {lot: "call_name" | "frame" | "skip", note?}`(下一場:這週的還沒開就是這週的)、`POST /api/market/settle {what: "auction" | "lottery"}`(立刻結束拍賣 / 立刻開獎),後兩個要 `admin.economy.adjust`。
- **面板**:會員頁有「市集」區塊(出價、買彩券、我的出價和彩券,點歌時可以勾優先券);管理端在「經濟 / 市集」看紀錄、安排下一場、現在結算(要 `admin.economy.adjust`)。
- **圖**:拍賣和樂透的通知(開始、結束、每週公告、開獎)和 `/me auction`、`/me lottery` 的回覆上面有一張圖(api 模組的 `PicturesKey`,替代文字是一行摘要);api 沒開、畫不出來或太慢就只有原本的文字卡,頻道不給上傳檔案時也一樣。要讓圖發得出去,她在頻道裡要有「附加檔案」的權限。
- **重啟**:所有狀態在資料庫(`market_lots`、`market_bids`、`market_lottery_weeks`、`market_lottery_tickets`),時間從存的時間算;每 30 秒看一次該開的、該結束的、該開獎的,停在一半的(押了錢沒記下的出價、扣了錢沒記下的彩券、還沒燒或還沒付的、她收下了但還沒套上的稱呼)下一輪補完;那一週已經開過才找到的彩券直接退回。點歌優先券的退款沒成功(經濟沒在跑)時,唱歌模組每 30 秒再試一次,日誌 `cannot refund a song priority ticket`。日誌:`market: a lot opened`、`market: a pass failed; the next one tries again`、`market: no Discord to post in`。
- **拿掉功能**:先把 `auction`、`lottery` 設成 `false` 讓它退完;整個外掛要刪的時候,`packages/play/market/src/migrations.ts` 的 `retireMarketSql` 就是要加的那個 migration(押著的出價和還沒開獎那週的彩券退回,再刪表)。

**直播彈幕**(`[modules.economy] danmaku_*`,設計見 [design/v5-play.md](design/v5-play.md) §11.6):她開台時,會員花魚幣發一則短句,從直播畫面右邊飄到左邊。預設開著,一則 5 魚幣、最多 30 字、每個人每 20 秒一則、一天最多 50 則,畫面上最多 12 則,其他的在 overlay 上排隊(最多 20 則、最多等 30 秒)。

- **要什麼**:`economy` 和 `stage.link` 在跑、她在直播(ActivityManager 的 broadcast 是 `live`;沒有 ActivityManager 時看 OBS 有沒有在推流),直播機的 Stage 是這個版本(hello 帶 `danmaku`),OBS 裡的 overlay 頁開著而且沒有用 `?show=` 拿掉 `danmaku`。只要彈幕一層的頁:`…/overlay/?show=danmaku`。直播機舊、沒有 overlay 頁、或 Stage 沒連上時,送出的彈幕會馬上退回。
- **在哪發**:`/me danmaku text:`、`/me i` 錢包頁的「發彈幕」(表單),會員頁「現場」的小表單(`GET`/`POST /api/member/danmaku`,帶 `Idempotency-Key`)。沒開台、在冷卻、到上限、魚幣不夠、有連結或提及、被審查擋下,一律不扣錢,原因寫在回覆或表單下面。
- **錢怎麼走**:送出時扣(帳本原因 `danmaku`),overlay 回報「顯示了」就留著,其他(沒有 overlay 頁、排隊滿了、等太久、被清空、overlay 斷線或沒回)就退回一列 `danmaku_refund`。直播機在 Core 不在時把回報留著,連回來再送。Core 重啟時:扣了錢還沒送出的 1 分鐘後退回,送出了卻一直沒有回報的在等待時間加 90 秒後退回;同一則不會再送一次。健康表把彈幕算成回收、退回的減掉;錢包明細寫「直播彈幕」「彈幕沒顯示,退回」。不分給她的錢包,不上贊助榜,不碰羈絆。
- **她那邊**:每一則都不會問她。每 `danmaku_note_s`(60)秒最多一則摘要(「直播畫面上這段時間飄過 7 則觀眾的彈幕,其中幾則:…」),隨機挑最多 3 則顯示過的,跟聊天室一樣是背景知道的事,她想回再回;不念出來。
- **管理**:面板 `/system/economy` 的「直播彈幕」一組能改開關、價格、字數、冷卻、每天幾則、畫面上幾則、顯示名字、多久告訴她一次;經濟的卡片有「今天彈幕」(顯示過的則數和收的魚幣)和「清空彈幕」(畫面上的拿掉,排隊中的退回)。不讓某個人發:`/admin person tag user:<他> tag:no_danmaku`(拿掉標籤就恢復),他會看到「你現在不能發彈幕」。她關台時排隊中的會自動清掉並退回。
- **日誌**:`danmaku: cannot settle a line`、`danmaku: a refund was not posted`(下一輪再試)、`danmaku: sweep failed`、`danmaku: cannot write her note`。

**唱 K(第一步,一個人)**(`[modules.karaoke]`,`packages/play/karaoke`,設計見 [design/karaoke.md](design/karaoke.md) 的「做了什麼(第一步)」):會員在 `/karaoke` 貼連結或打歌名,唱歌 worker 做伴唱軌和參考旋律,會員在自己的瀏覽器唱,唱完 Core 重算分數,她在講評頻道講一句。沒有房間、沒有直播畫面、沒有魚幣。

- **要什麼**:`sing` 模組在跑、至少一台唱歌 worker(和翻唱同一批,同一套 failover;worker 要是這個分支的,看得懂 `purpose: "karaoke"`);會員頁要開(`[modules.api.public] enabled`)。沒有 worker 時只能唱已經準備好的歌,會員頁會說。worker 不用新的模型,只用翻唱已經有的分離、主唱、RMVPE 和歌詞查詢。
- **設定**:`open`(會員能不能點歌和唱)、`max_song_secs`(480)、`daily_songs`(每人每天準備幾首新歌,10;已經準備好的不算)、`tolerance_cents`(50)、`comment`(她講評)、`comment_channel`(`"discord:<伺服器 id>:<頻道 id>"`,沒設就只讓她知道、不開口)、`cache_dir`(`data/karaoke`)。面板的 `/system/karaoke` 能改前六個。
- **worker 那邊**:做出來的放在 worker 歌曲快取的 `_karaoke/k-<來源>/`(`karaoke.m4a`:伴奏加和聲,AAC 128 kbps 48 kHz 立體聲;`reference.json`;`meta.json`),不在 `GET /songs`(她翻唱過的歌)裡,跟著歌曲快取一起清。唱 K 的工作不會叫語音讓出顯卡:放不下就等,等太久就失敗。檔案從 `GET /karaoke/<id>/files/<名字>` 拿。
- **Core 這邊**:準備好時把兩個檔案抓到 `cache_dir/<歌的 id>/`,一天沒人唱就刪,再唱時再從 worker 抓。瀏覽器拿檔案只能用 10 分鐘的簽名網址(綁這一次、這個檔、這個帳號,還要登入的 cookie),不能公開分享、沒有下載鍵;Core 重啟後舊的網址失效。音高軌(每秒 50 格、一格一個位元組)留 7 天;結果留著(「忘記我」一起刪)。
- **API**:會員 `GET /api/member/karaoke`、`POST /api/member/karaoke/songs {text}`、`GET /api/member/karaoke/songs/{id}`、`POST /api/member/karaoke/songs/{id}/sessions`、`POST /api/member/karaoke/sessions/{id}/result`、`GET /api/member/karaoke/sessions/{id}`,檔案 `GET /api/member/karaoke/files/{session}/{name}?exp=&sig=`;owner `GET /api/karaoke/results`(最近的結果和「沒有驗證」的原因)。
- **她講評**:唱完 Core 送她一則通知(來源 `game.karaoke`),裡面是系統的數字;設了 `comment_channel` 時她在那個頻道照平常的方式回一句(她平常的一個回合,沒有另外的模型呼叫),之後 3 分鐘內她在那個頻道的第一句當成講評顯示在會員的結果頁。一起唱過記成 `played_together`。
- **作弊標記**:音高軌九成以上的格離原唱不到 15 cents(就是拿參考旋律做的軌)會被標成「沒有驗證」:分數照樣顯示,不算最好成績;她不會知道。原因在 `GET /api/karaoke/results`。
- **試一下**:開發時 `pnpm --filter @miyoria/panel dev`,開 `http://localhost:5178/karaoke?karaoke-demo`:不用 Core、不用麥克風的示範(假的 API 和假的唱歌的人,只在開發伺服器)。
- **日誌**:`karaoke: the worker did not take the song`、`karaoke: a song could not be prepared`(`detail` 是 worker 的原話)、`karaoke: the files are gone`、`karaoke: the pass failed`。

面板的頁(側欄可收合,`Ctrl/⌘ + B`;`Ctrl/⌘ + K` 開搜尋,可跳到頁面、人、子系統):

| 頁 | 內容 |
|---|---|
| 總覽 | 子系統、今日花費、LLM 呼叫、佇列四個數字;需要注意的項目(失敗或降級的子系統、擴充、MCP,LLM 預算);LLM 用量表 |
| 動態 | 事件 / 決策 / 轉錄三個分頁,共用同一條 `/api/events` 串流;點一列在側邊面板看細節 |
| 直播 | OBS 場景、VTS 表情(清單來自 Stage 節點回報)、OBS 推流開關、overlay 網址與預覽;「讓她說」(她不在語音頻道時停用);請求佇列;語音頻道成員與延遲 |
| 角色 | Persona(對話框編輯、儲存前看 diff、版本比較與還原)/ 記憶(搜尋、編輯、刪除、分頁載入)/ 人(關係、好感調整、稱呼、標籤、備註、封鎖) |
| 系統 | 子系統 / 擴充套件 / MCP 伺服器。子系統預設是卡片格子(她、玩、平台、系統四段;每張卡有圖示、狀態、最多四個數字、下一件事或最後的錯誤、快速動作),右上角可以切回表格,瀏覽器會記住;點一張卡或一列進到 `/system/<id>`:狀態、能在面板上改的設定和變更紀錄(見下面「模組設定」)。MCP 只能重新連線(開關在 `miyoria.toml`) |
| 權限 | 指派(選人或輸入帳號 id)、角色的新增 / 編輯 / 刪除、Discord 身分組對應 |
| 設定 | Core 位址與 token |
| 電腦(`/machines`) | Core 知道的每一台電腦:狀態、是否已連線、核准的能力、它的服務(停止 / 重啟,她忙時會再問一次是否強制),移除電腦;「邀請電腦」產生邀請碼;「誰負責什麼」列出每種能力的候選服務,標「直連」或「經連線」和正在使用的那個。叢集模組沒啟動時只顯示說明 |

側欄底部的圓點是 Core 與事件串流的狀態(滑過看版本與位址)。唯讀帳號(沒有 `admin.panel.write`)看得到所有東西,但修改類的控制項會停用。

**模組設定**(設計見 [design/v5-settings.md](design/v5-settings.md)):面板的 `/system/<id>` 能改一部分模組設定(目前是市集、卡片、經濟的三個價格和直播彈幕、派對遊戲、唱歌、直播頁,見設計的「做了什麼」)。

- **存在哪**:面板改的值存在資料庫的設定修訂(`config_revisions`,和模組開關同一份),**蓋在 `miyoria.toml` 上**,一個鍵一個鍵;檔案不會被改。每次儲存是新的一版,記誰(`panel:discord:<id>`、`panel:token`、`cli`)和何時,事件紀錄有 `config.revised`;頁面下方的變更紀錄能把某一次的變更復原。
- **儲存就套用**:一個按鈕「儲存並重新啟動 X」:Core 檢查值(錯的值在欄位下面用中文說哪裡錯)、寫一版,再只重新啟動 X 和依賴它的模組,幾秒鐘。她在唱歌或直播時,重啟會打斷她的模組(sing、voice、voice.link、stage.link 和會連帶重啟它們的)先存起來,唱完 / 直播結束才重啟,卡片上寫「已存,她唱完後重新啟動套用」;按鈕會先問。
- **檔案和面板不一樣時**:面板的值贏。Core 啟動時每個「面板蓋掉、而且和檔案不同」的鍵寫一行 log(`the panel's value overrides miyoria.toml for this key`);面板的欄位旁寫「面板改過 · 檔案:X」,可以「還原成檔案的值」。面板存的值後來不合 schema(升級後)會被略過並警告,用檔案或預設值。
- **CLI**:`miyoria config get <鍵>` 會說這個鍵被面板改過(值、第幾版、誰、何時、檔案寫什麼);`config set` 改到被蓋住的鍵時警告檔案的值不會生效;`miyoria config overrides` 列出面板改過的全部;`miyoria config bake` 把它們寫進 `miyoria.toml`(保留註解)再從資料庫清掉,之後檔案是唯一的來源(模組開關不動)。資料庫檔案不存在時這些指令什麼都不建立。
- **誰能改**:看設定要能進面板;改要 `admin.panel.write` 加 `admin.settings.<模組 id>`。owner(`*`)和 admin(`admin.*`)本來就有;moderator 沒有,要給就在權限頁的角色加例如 `admin.settings.party`。管理 token 什麼都能改。
- **頻道選擇器**:列出她在的伺服器的文字頻道(依伺服器和分類),她看不到或不能發言的顯示但不能選;資料來自 Discord bot 連線時的快取,沒連上時清單是空的(已存的頻道仍顯示 id)。

**權限改了就重新登入**:一個人的角色改了以後,他已登入的面板會在下一個請求時重新判斷:原本是會員、現在能進管理面板,或原本是管理、現在不能了,那個登入就失效,要重新登入拿到對的身分(經面板改的立刻生效;在 Discord 用指令改的,最晚 `[modules.api.discord_oauth] recheck_secs` 秒後)。

### 上網查資料

模組 `web`(預設開著,`[modules.web]`)給她三個工具:`web_search`(DuckDuckGo 的 HTML 搜尋,`region` 預設 `tw-tzh`)和 `web_read`(讀一個公開網頁的文字,上限 `read_chars`;最後列出網頁的主圖和內文的 `read_pictures` 張圖片網址)和 `web_image`(給圖片網址,她自己看那張圖;只看 png / jpeg / webp / gif,不縮圖,超過 `image_max_bytes`(預設 5000000)就看不了,經同一個受保護的下載和各自的次數限制 `image_per_person` / `image_global`;聊天模型不收圖片時直接說看不了、不下載;圖片只在下一步以 user 圖片給模型,不寫進紀錄)。要有 `tools.web` 才能請她用,member 以上預設有,restricted 沒有。不要上網就在 `miyoria.toml` 寫 `[modules.web] enabled = false`。網頁只讀 http / https,DNS 解出來是內部、私有或 localhost 的位址一律拒絕,轉址最多 3 次且每一站重新檢查;每人 10 分鐘 6 次搜尋 / 10 次讀頁、全部人 30 / 60 次,相同搜尋 10 分鐘內用快取。查到的東西回給她時標成不可信的資料,裡面的指令她不會照做。DuckDuckGo 要求驗證或回錯誤時,她只會說現在查不到,程式不會繞過。讀一頁最多 `read_chars`(預設 12000),`result_chars`(預設 12000)是回給 agent 的上限,搜尋答案另有 `search_chars`(預設 3900);`[modules.agent] max_tool_result_chars` 要不小於 `result_chars`,否則網頁內容會在資料區塊中間被切掉。

## 5. Discord 設定

她用**兩個帳號**:官方 bot 帳號負責文字與指令;self 帳號只負責語音。

### 官方 bot 帳號(文字 + 指令)

1. 到 <https://discord.com/developers/applications> 建立 Application,在 **Bot** 頁籤新增 bot,複製 token 放進 `.env` 的 `DISCORD_BOT_TOKEN`。
2. **Bot → Privileged Gateway Intents** 打開 **Message Content Intent**、**Presence Intent** 與 **Server Members Intent**(後兩個讓她知道誰在線、在玩什麼、誰在哪個語音頻道,見 `world` 模組)。沒開的話 gateway 會拒絕連線(close code 4014),模組會一直失敗,日誌會寫哪裡要開;不想開 Presence / Server Members 就在 `[modules."platform.discord.bot"]` 設 `presence_intents = false`(她仍看得到語音狀態,但不知道誰在線、在做什麼)。Bot 在 100 個伺服器以上時這兩個 intent 要經過 Discord 審核。
   - presence 只在各自的伺服器裡用(`[modules.world] guilds` 可以限定只看哪些伺服器),不會出現在私訊或其他伺服器的對話;每個人都能用 `/me privacy presence:off` 讓她完全不讀自己的狀態(紀錄存在 `privacy:<platform>:<id>`)。
3. **OAuth2 → URL Generator** 勾 scope `bot` 與 `applications.commands`,權限:View Channels、Send Messages、Send Messages in Threads、Read Message History、Add Reactions。用產生的網址邀請進伺服器。
4. 在 Discord 打開開發者模式(設定 → 進階),對自己按右鍵「複製使用者 ID」,填到 `MIYORIA_OWNER_ID`(擁有者權限)。
5. 想讓 slash command 立刻生效,把伺服器 id 填進 `miyoria.toml` 的 `[modules."platform.discord.bot"] command_guilds`;留空是全域註冊,最多要等一小時。
6. 用 `miyoria doctor` 確認 token 有效,`miyoria module list` 看 `platform.discord.bot` 是 running。

### Self 帳號(語音)

- **用專用小帳號,不要用主帳號。** Self-bot 違反 Discord 服務條款,帳號可能被封,風險由擁有者自行承擔(ARCHITECTURE §11.2)。
- 把 self 帳號加進她要待的伺服器,並給語音頻道的「檢視頻道」「連線」「說話」權限。
- user token 只放在 voice node 所在機器的 `apps/voice-node/.env`(`SELF_TOKEN`),**不要**放進 Core 的設定,也不要貼到任何地方。
- 收音前要讓頻道裡的人知道她在聽(`[modules.voice] consent`:`opt-out` 預設收音、可退出;`opt-in` 同意後才收)。

### 管理面板的 Discord 登入(選用)

面板預設用 admin token 登入;開了這個之後,也可以按「使用 Discord 登入」(token 照樣能用,CLI 一直用 token)。

1. 在同一個 Application 的 **OAuth2** 頁籤:**Client ID** 就是 Application ID,填 `.env` 的 `DISCORD_CLIENT_ID`;按 **Reset Secret** 取得 **Client Secret**,填 `DISCORD_CLIENT_SECRET`。
2. **OAuth2 → Redirects** 新增 redirect URL,例如 `http://127.0.0.1:7878/api/auth/oauth/callback`。
3. 在 `miyoria.toml` 打開 `[modules.api.discord_oauth]`(見 `miyoria.example.toml`),`redirect_uri` 填**一模一樣**的網址,重啟 Core。`miyoria` 日誌會出現 `Discord login for the panel is on`。
4. 用瀏覽器開**跟 redirect_uri 同一個 origin** 的面板網址(上例就是 `http://127.0.0.1:7878/`,不是 `localhost:7878`):登入用的 cookie 只屬於那個 origin。開發時用 Vite(`pnpm dev`)就另外登記 `http://localhost:5178/api/auth/oauth/callback`、把 `redirect_uri` 改成它,並用 `http://localhost:5178` 開面板;Vite 的 proxy 會轉給 Core。

誰能登入:

- `[modules.auth] owners` 裡的擁有者,以及**全域**指派了 `admin` 角色的人(`*` / `admin.*` 已包含 `admin.panel.access` 與 `admin.panel.write`)。其他人登入後是「成員」:只看得到公開頁和她眼中的自己,所有管理 API 都拒絕(`[modules.api.public] enabled = false` 時才是直接拒絕登入)。之後才拿到權限的人要重新登入一次。
- 開放給其他角色:`/admin perm allow role:moderator node:admin.panel.access scope:global`(唯讀,修改類按鈕會停用),要能修改再加 `node:admin.panel.write`。面板檢查時沒有伺服器 / 頻道,所以只算 `scope:global` 的指派與覆寫。
- 拿掉角色或權限後幾秒內生效,已登入的人會被送回登入畫面。登入 session 預設 7 天(`session_days`),存在資料庫(只存 token 的雜湊),Core 重啟不會掉;登出會立刻刪掉。

公開頁(`[modules.api.public]`,預設開):

- 根網址對沒登入的人顯示她現在在做什麼、歌單和今天的統計,API 在 `/api/public/*`;登入的成員多看到她眼中的自己、下載資料、請她忘記、點歌,API 在 `/api/member/*`。管理用的 token 表單在 `#/login`,頁面上沒有連結。
- 放在 Cloudflare tunnel 後面時,請求都從本機進來,速率限制看 `CF-Connecting-IP`。Core 綁在 `127.0.0.1` 才能信這個標頭;綁到其他位址時,非本機的連線一律用連線位址,不管設定的是哪個標頭。
- 前面換成這台電腦上別的反向代理(nginx、Caddy)時,用 `[modules.api.public] client_ip_header` 指定它帶訪客位址的標頭:`x-real-ip`,或 `x-forwarded-for`(取最後一個,也就是代理自己加上的那個)。代理要自己設這個標頭,不能照轉訪客送來的,否則訪客可以自己挑速率限制看的位址。沒設定時照預設讀 `CF-Connecting-IP`,而 nginx 預設會把訪客送的這個標頭原樣轉進來:用 nginx 或 Caddy 一定要設 `client_ip_header`,或在代理把 `CF-Connecting-IP` 清掉(nginx:`proxy_set_header CF-Connecting-IP "";`)。設成空字串就不讀任何標頭,所有從本機來的請求算同一個人。
- `identify` 不能證明對方是伺服器成員:任何 Discord 帳號都能登入成員頁,但什麼資料都沒有,而且她不認識的帳號不能點歌。
- 公開頁會把 `apps/panel/dist` 裡的預設背景圖傳給所有訪客。那張圖是遊戲 CG,對外開放前先確認授權,或把 `public/background.local.jpg` 拿掉後重新建置面板(`pnpm build:web`),面板會退回暮色漸層。

從別台機器用面板:cookie 和 token 都會走明文 HTTP,所以要嘛走 Tailscale(`redirect_uri` 用 tailnet 位址,例如 `http://100.x.y.z:7878/api/auth/oauth/callback`,並把 `[modules.api] bind` 綁到那個位址),要嘛放在 https 反向代理後面(`redirect_uri = "https://panel.example.com/api/auth/oauth/callback"`,cookie 自動加上 `Secure`)。無論哪種,Developer Portal 的 redirect、`redirect_uri` 和你在瀏覽器開的網址三者要一致。

## 6. 升級

**原則:先備份,再升級,升級後跑 `doctor`。**

```bash
# 先備份 data/(見 §7)
miyoria update
miyoria doctor --deep
```

### `miyoria update`(從原始碼,和 hostd 管的服務)

1. `git pull --ff-only`(工作目錄有未提交的變更就略過;`--no-pull` 不做;不是 git 資料夾就略過)。
2. `pnpm install`(只在 `pnpm-lock.yaml` 比上次安裝新時)。
3. 只重建過期的:SDK、各擴充的 `dist`、面板、overlay、Minecraft mod。比的是原始碼和輸出的檔案時間;`--force` 全部重建,`--skip-mod` 跳過 mod。
4. 面板與 overlay 一律用 `vite build --minify false --target esnext`(避開防毒鎖住 esbuild 暫存檔),輸出先到 `dist.next`,成功才換掉 `dist`;失敗時舊的 `dist` 原封不動。
5. mod 用找到的 JDK 21 建置(只對這次 Gradle 設 `JAVA_HOME`,不改系統設定)。要覆蓋 `<minecraft_dir>/mods` 裡的 jar 時**先問**,舊檔備份到 `<minecraft_dir>/miyoria-backup/<時間>/`;自動化加 `--yes`,非互動又沒有 `--yes` 就不覆蓋。請先關掉遊戲。
6. **Python 環境**:`host.toml` 啟用的每個 Python 服務,如果它的環境和現在的 `uv.lock`、extras、`service.toml` 不一致,就重新 `uv sync --frozen`(`host.toml` 用 `python = ...` 指定的環境不動)。
7. **重啟**:跑著、而且環境剛同步過或自己的資料夾在這次 pull 有變的服務,**一次一個**重啟,每個都經過[保護](#受保護的服務):她在唱歌或直播時,Core、Voice node 和 Stage **不會被動**,`update` 印出「還在忙所以沒有重啟」和之後要執行的 `miyoria restart <服務>`(要先同步環境的,重新執行 `miyoria update`)。`--no-restart` 同步環境但不重啟任何服務。
8. **模型檔**:`[[install.files]]` 缺的或不對的(例如 pull 進來的 `service.toml` 加了新檔案、換了版本),列出大小、授權和來源後問一次再下載(`--yes` 不問;沒有終端機又沒有 `--yes` 就印出清單、這一項算失敗)。還在忙沒有重啟的服務這次不下載。見 [自動下載的模型檔](#自動下載的模型檔)。

`--dry-run` 只列出會做的事。`doctor --deep` 會比對執行中的 Core 版本和這份 CLI,不同時提醒重啟。

npm 安裝的版本沒有 git 資料夾可以 pull:`update` 會告訴你先用套件管理員升級(`npm update -g miyoria`,pnpm 是 `pnpm update -g miyoria`),再重新執行 `miyoria update` 同步環境和重啟服務。

### 從面板更新別台電腦

面板「電腦」頁的每台電腦都會顯示版本(分支 · 提交)、和 Core 那台比是落後幾個提交、相同、比較新還是分岔。勾選幾台按「更新」,那幾台會自己快轉到 **Core 那台現在的提交**、需要時 `pnpm install`、同步變了的 Python 環境、重啟有變動的服務,每一步都顯示在那台底下。只有擁有者能按(權限節點 `owner.cluster.update`,admin 和 moderator 角色沒有;擁有者可以在自訂角色裡把這個節點給別人),每台都會記進稽核紀錄。

- **預設是開的**:跑 worker 的電腦一旦加入某個 Core,那個 Core 的擁有者就能把這台的 checkout 更新到它追蹤的分支上的提交。不用寫任何設定。
- **要關掉**:在那台的 `host.toml` 加

  ```toml
  [update]
  allow_remote = false
  ```

  一分鐘內生效,不用重啟(`miyoria init` 新寫的 `host.toml` 最後有這兩行,註解掉的)。關掉的電腦一樣會回報版本,但不接受更新,面板會寫出原因。
- **跑 Core 的那台不能從面板更新**(會重啟 Core 自己),照舊在那台 `miyoria update`。
- 那台只會在它**自己追蹤的分支**(通常是 `origin/main`)上**快轉**:有未提交的變更、分岔、比 Core 新、或 Core 的提交還沒推上去,都會拒絕,什麼都不動。
- 她在做歌、唱歌或直播時,那台會先**等**(面板顯示「等她忙完」和在等什麼,最多 30 分鐘,可以取消)。更新期間 Core 不送新工作給那台(自動清空),所以它的排隊做完就會往下走。
- 中途裝套件或同步環境失敗,會退回原本的提交、把停掉的服務帶回來。更新後沒起來的服務會列出來,不會自動退回。
- **不會下載模型**:新版需要的模型檔缺了會列在結果裡,請那台的主人在那台執行 `miyoria doctor --fix` 或 `miyoria models pull`。
- 遠端更新**不建置**面板、overlay、SDK 和擴充,hostd 自己也還是舊的程式,直到那台 `miyoria down` 再 `miyoria up`;要這些的話在那台 `miyoria update`。結果裡會提醒。
- 那台的 hostd 太舊時面板寫「版本不明」,不能從這裡更新:先在那台手動更新一次。

### 其他方式

Docker Core:

```bash
docker compose -f deploy/docker-compose.yml up -d --build   # 重建映像檔並換掉容器
docker compose -f deploy/docker-compose.yml logs -f core
```

- 資料庫 migration 在 Core 啟動時自動往前套用。**migration 不會自動回退**,要降版就是「還原備份 + 換回舊版映像檔」。
- 想保留舊版可回退:升級前 `docker tag miyoria-core:local miyoria-core:previous`,出問題時在 `deploy/.env` 設 `MIYORIA_IMAGE=miyoria-core:previous`,`up -d` 時不加 `--build`。
- voice node:`miyoria update` 之後 `miyoria restart voice-node`(她在直播時會被擋)。Core 與 voice node 的協定版本不符會用 close code `4400` 拒絕連線,兩邊要一起升級。
- 設定檔有新欄位時,對照 `miyoria.example.toml` 手動合併,或重跑 `miyoria init`(可重複執行,Enter 保留現值,寫入前會問)。

## 7. 備份與還原

### 要備份什麼

| 項目 | 位置 | 怎麼備份 |
|---|---|---|
| 資料庫(記憶、好感、決策紀錄、persona 歷史) | `data/miyoria.db`(Docker:`core-data` volume 的 `/data`) | 見下方 |
| 設定與秘密 | 根目錄 `.env`、`miyoria.toml`、`deploy/.env` | 手動複製到安全的地方(**不要進 git、不要上傳到公開處**) |
| 角色 profile | `profiles/` | 在 git 裡;但 `profiles/*/avatar/model/` 與 `voice/*.wav` 因授權不進 git,要另外備份 |
| 聲音檔 | `workers/voices/` | 手動備份 |

### SQLite

資料就是 `data/miyoria.db` 一個檔案(WAL 模式,旁邊可能有 `miyoria.db-wal`、`miyoria.db-shm`)。最簡單:停掉 Core 再複製 `data/` 整個資料夾。不想停機就用 sqlite3 的線上備份:

```bash
sqlite3 data/miyoria.db ".backup backups/miyoria-$(date +%Y%m%d-%H%M%S).db"
```

還原:停掉 Core,把備份檔複製回 `data/miyoria.db`(刪掉舊的 `-wal` / `-shm`),再啟動。

Docker:資料在 `core-data` volume 的 `/data/miyoria.db`。停掉 core 再把 volume 裡的檔案複製出來,例如 `docker run --rm -v miyoria_core-data:/data -v "$PWD/backups:/backups" alpine cp /data/miyoria.db /backups/`。

**備份要放到另一台機器或雲端**(`rsync`、`rclone`、NAS),同一顆硬碟上的備份擋不住硬碟故障。**還原演練**:至少做過一次,才算有備份。

### 從 V4 切換到新的資料庫(`miyoria db`)

V5 從一個新的資料庫檔開始,從不打開也不改 V4 的檔案(Core 遇到 V4 的檔案會拒絕啟動,訊息裡會列出下面的指令)。只帶過去「誰是誰」:人和他們的 id、帳號、她對每個人的稱呼(handle)、隱私和語音同意的選擇、紀念卡要用的資料(第一次見到的時間、舊的羈絆分級名稱、舊卡張數)。羈絆、記憶、魚幣、卡片、聊天紀錄都不帶。設計見 [design/v5-data.md](design/v5-data.md) §4.3、§7。

| 指令 | 做什麼 |
|---|---|
| `miyoria db doctor [檔案]` | 只讀檢查一個檔案:V4 / V5 / 空的 / 不是資料庫、Core 會不會拒絕、遷移、`integrity_check` 和 `foreign_key_check`、人數 / 帳號數 / 事件數和最新事件的時間;V4 的檔案另列 `import-links` 會帶過來的數量。省略檔案 = `core.database_url` |
| `miyoria db archive [檔案] [--dry-run]` | Core 停掉之後:檔案還被開著就拒絕(Windows 用「把檔案改名成自己」測試,SQLite 開著的檔案改不了名;Linux 看 `/proc`;其他系統用 `lsof`),把 `.db`、`-wal`、`-shm` **三個一起**改名搬進 `data/archive/miyoria-v4-<日期>.db*`,用 `VACUUM INTO` 做一份單一檔案的 `.single.db`,把雜湊寫進 `data/archive/MANIFEST.txt`,最後印出接下來要打的指令。不刪任何檔案;要輸入 `archive` 確認(或加 `--yes`)。中途失敗(或被中斷)可以直接重跑:它會照 `.plan.json` 接著做,資料夾和計畫對不上就拒絕 |
| `miyoria db import-links --from <檔案> [--dry-run]` | 從 V4 的檔案(只讀)匯入 `core.database_url` 的資料庫,新檔不存在就建立。一個交易;重跑不會重複(已經有的人會略過並計數)。新資料庫裡已經有人用了某個帳號就整個拒絕,所以要在 V5 跟任何人說話之前匯入。`--dry-run` 只列出數量和前幾筆 |

切換的順序(先拿現行檔案的**複本**演練一次第 1 步):

```bash
miyoria db doctor <複本>                         # 1. 演練:V4、integrity ok
miyoria db import-links --from <複本> --dry-run  #    數量對嗎(人、帳號、handle、選擇)
# 2. 停掉 Core(miyoria down,或關掉前景的 miyoria core)
miyoria db doctor data/miyoria.db                # 3. 停機後再看一次
miyoria db archive                               # 4. 封存(輸入 archive 確認)
miyoria config set core.database_url sqlite:data/core.db   # 5. 指向新檔
miyoria db import-links --from data/archive/miyoria-v4-<日期>.single.db --dry-run
miyoria db import-links --from data/archive/miyoria-v4-<日期>.single.db   # 6. 匯入
miyoria db doctor data/core.db                   # 7. V5、人數對
miyoria core                                     # 8. 第一次啟動:其餘的遷移
```

匯入放在第一次啟動之前,這樣沒有人能先跟 V5 說話。新舊兩個 Core 不能同時連 Discord(同一個帳號會回兩次)。要退回 V4:停掉 V5,把 `data/archive/` 裡的三個 `miyoria-v4-<日期>.db*` 改名回 `data/miyoria.db*`,再啟動舊版;V5 試跑期間的東西舊版看不到。

### 資料管理(面板「資料」頁)

管理面板的「資料」頁列出她的每一類資料(資料表與設定 key 的對應見 [ARCHITECTURE.md](ARCHITECTURE.md) §16「資料類別」),分成三張表:

| 表 | 類別 |
|---|---|
| 她的資料(只屬於目前的 profile) | 記憶(含整理時間)、關係(含變化紀錄)、稱呼、內在狀態與感情、心情、聊天紀錄(含記憶整理進度 watermark)、決策紀錄、頻道設定(模式 / 活躍度)、Persona 修改、她提議的工具、擴充套件資料、其他設定、工具工作區(有 sandbox 模組時) |
| 共用資料(同一個節點的所有角色共用) | 主動發話狀態、人物與帳號連結(含連結代碼)、語音同意、隱私設定、點播佇列、角色與權限(角色、指派、Discord 角色對應、節點覆寫)、模組開關 |
| 保留的資料(只能看與匯出) | 稽核紀錄、LLM 用量、面板登入(不匯出) |

每一列可以「檢視」(跳到對應頁面)、「匯出 JSON」與「刪除」。匯出與刪除需要 `owner.data.manage`(只有擁有者與 admin token 有);唯讀帳號(沒有 `admin.panel.write`)看不到刪除與危險區。

- **刪除**:對話框會列出連帶刪除的類別(例如刪人物會一起刪關係、稱呼與感情)。記憶、聊天紀錄、人物、權限、隱私、語音同意等重要類別要輸入 profile id 才能刪;心情、決策紀錄、頻道設定、佇列、模組開關按一次確認即可。聊天紀錄一定連同記憶整理進度一起刪(只刪進度會讓舊聊天被重新萃取成記憶,所以不能單獨刪)。
- **刪除時會發生什麼**:快取這份資料的模組(memory、social、mood、self、agent、initiative、world、queue、sandbox 中相關的)先停下來,同一個交易裡刪除,再把模組啟動;頻道設定同時從 agent 的記憶體裡清掉,權限刪除後 auth 會重新載入。少數東西要重新啟動 Core 才完全生效:Persona 修改刪除後,執行中的人格要等 Core 重啟才回到 profile 檔案的內容;模組開關刪除後,下次啟動才回到設定檔的預設。語音同意有最多一分鐘的快取。
- **回到初始狀態**(危險區):刪除上表「她的資料」與「共用資料」的所有內容,回到剛安裝的狀態。流程:按「下載備份」→ Core 產生完整備份(含稽核紀錄)並下載到瀏覽器,同時發一個 15 分鐘內有效、只能用一次的憑證 → 輸入 profile id → 確認。沒有這個憑證 Core 會拒絕重設,所以不可能跳過備份。重設會保留稽核紀錄(並新增 `data.backup`、`data.reset` 兩筆)、LLM 用量與面板登入;角色與權限回到內建角色,設定檔 `[modules.commands] owners` 的擁有者仍是擁有者。
- **API**:`GET /api/data`、`GET /api/data/export?categories=a,b`、`POST /api/data/wipe`(`{ categories, confirm }`)、`POST /api/data/backup`(回應標頭 `x-miyoria-backup-token`)、`POST /api/data/reset`(`{ confirm, backup_token }`)。每次匯出、刪除與重設都寫進稽核紀錄。
- **從備份還原尚未支援**:面板的 JSON 備份是給人看與留存的(不含記憶的 embedding 與搜尋 token);要整個復原,請用上面的資料庫備份(SQLite 檔案)。重設前先做一次資料庫備份最保險。
- 這個頁面只處理目前的 profile;共用資料會影響同一個資料庫裡的其他角色(多角色的節點要注意)。

## 8. 日誌

Core 用 pino:預設每行一筆 JSON(在終端機會自動改成好讀的單行格式),層級由環境變數 `MIYORIA_LOG_LEVEL`(`fatal|error|warn|info|debug|trace|silent`)控制;沒設時用 `miyoria.toml` 的 `[core] log` 的第一個層級(預設 `info,miyoria=debug` → `info`)。`MIYORIA_LOG_FORMAT=json` / `pretty` 可以強制格式。

```bash
MIYORIA_LOG_LEVEL=warn miyoria core          # 安靜
MIYORIA_LOG_LEVEL=debug miyoria core         # 查語音管線、Discord adapter 等細節
MIYORIA_LOG_LEVEL=debug pnpm dev:core            # 從原始碼
```

由 hostd 啟動的 Core(`miyoria up`)日誌寫在 `<狀態資料夾>/logs/core.log`,用 `miyoria logs core` 看。它繼承執行 `miyoria up` 時的環境,所以要改層級,在 `.env` 寫 `MIYORIA_LOG_LEVEL=debug`,再 `miyoria down` 和 `miyoria up`(hostd 的環境是它啟動時定下來的,只 `restart core` 讀不到新的 `.env`)。

模組的日誌帶 `module`(例如 `voice`、`platform.discord.bot`),函式庫的帶 `scope`(例如 `llm.router`);JSON 格式時可以用 `jq` 過濾:`MIYORIA_LOG_FORMAT=json miyoria core | jq 'select(.module == "voice")'`。

Docker:

```bash
docker compose -f deploy/docker-compose.yml logs -f core
docker compose -f deploy/docker-compose.yml logs --since 1h core
```

在 `deploy/.env` 設 `MIYORIA_LOG_LEVEL=...` 再 `up -d` 就能改容器內的層級。Docker 預設的 json-file 日誌沒有大小上限,長期運行建議在 `/etc/docker/daemon.json` 設 `"log-driver": "local"` 或 `"log-opts": {"max-size": "20m", "max-file": "5"}`。

不用看 log 也能知道她在想什麼:

```bash
miyoria decisions -l 50      # 最近的 attention 決策:回話或沉默,以及原因
miyoria events 'agent.*'     # 即時事件串流(依 topic 過濾)
miyoria status               # LLM 用量(token、費用)
curl -s -H "Authorization: Bearer $MIYORIA_API_TOKEN" http://127.0.0.1:7878/metrics   # Prometheus 指標
```

`GET /metrics` 是 Prometheus 文字格式(事件數、LLM 首 token 延遲、用量等),跟其他 API 一樣要 token;給沒有憑證的 Prometheus 抓,可以設 `[modules.api] metrics_public = true`(只在 API 沒有對外時這樣做)。OpenTelemetry 還沒有。

**LLM 呼叫紀錄**:每次呼叫 LLM(成功或失敗)都寫一行 JSON 到 `data/llm-calls/<UTC 日期>.jsonl`(相對於 `miyoria.toml` 所在的資料夾,`[llm.call_log] dir` 可以改):用途、模型、送出的訊息與工具、推理與取樣設定、回覆(含推理文字)、用量、耗時、錯誤和回合 id。Core 重啟後面板的呼叫檢視器會先載入當天的紀錄(只有摘要,沒有內容),事後查事故或拿來重播評估都靠這些檔案。檔案裡有大家說的話和她的回覆,只存在這台電腦上,不會上傳;API key、Authorization 標頭和 provider 設定不會寫進去,訊息裡看起來像金鑰的字串和內嵌圖片也會先遮掉。預設保留最近 14 天(`keep_days`,含今天),更舊的檔案在啟動時和之後每天自動刪掉;當天的檔案超過 512 MB(`max_mb_per_day`)後,當天其餘的呼叫只記用途、模型、用量這些,不記內容(那幾行帶 `"metadata_only": "size_cap"`)。不要內容就設 `bodies = false`,完全不寫就在 `miyoria.toml` 寫 `[llm.call_log] enabled = false`。寫不進去(磁碟滿、資料夾沒有權限)時只丟掉那幾行,每分鐘最多記一次警告,不會拖慢或擋住她說話。用 `jq` 找失敗的呼叫:`jq -c 'select(.call.status == "error") | .call' data/llm-calls/2026-11-14.jsonl`。

Voice node 的層級用它的 `LOG_LEVEL`(`error|warn|info|debug`);`debug` 會印出 `@discordjs/voice` 與 DAVE 的細節。Worker、voice node、stage 這些 hostd 啟動的服務,日誌在 `<狀態資料夾>/logs/<服務>.log`(預設 `data/host/logs/`,每 10 MB 輪替,留舊的 5 份):`miyoria logs <服務>` 看最後 100 行,`miyoria logs <服務> -f` 持續追蹤;hostd 自己的日誌是同一個資料夾的 `hostd.log`。前景跑的(`miyoria up --foreground`、`miyoria core`)印在終端機,Docker 的 Core 用 `docker compose logs`。

## 9. 安全檢查表

上線前逐項確認:

- [ ] **Token 都是隨機長字串**:`MIYORIA_API_TOKEN`、`VOICE_LINK_TOKEN`、`STAGE_LINK_TOKEN` 由 `miyoria init` 產生(或 `openssl rand -hex 32`)。
- [ ] **秘密不進 git**:`.env`、`deploy/.env`、`miyoria.toml` 都在 `.gitignore`;`git status` 看不到它們。Docker 映像檔不含 `.env`(根目錄的 `.dockerignore` 已排除),不要把映像檔推到公開 registry 前自行 `docker history` 檢查。
- [ ] **全部綁 127.0.0.1**:`docker compose ... ps` 的 PORTS 欄看到的是 `127.0.0.1:7878->7878/tcp`,不是 `0.0.0.0:`。原生 Core 的 `[modules.api] bind`、`[modules."voice.link"] bind`、`[modules."stage.link"] bind` 維持 `127.0.0.1:...`。`miyoria.docker.toml` 裡的 `0.0.0.0` 只是容器內部的位址,對外與否由 compose 的 `ports:` 決定,不要把 `ports:` 的 `127.0.0.1:` 前綴拿掉。
- [ ] **7878 / 7879 / 7880 / 7882(以及 8001 / 8003 / 8002 / 8005 / 8006 / 8007 / 5432)沒有直接開到公網**:防火牆(`ufw`、雲端 security group)對這些埠預設全擋。Docker 發布的埠會繞過 `ufw`,所以更要靠 `127.0.0.1` 綁定而不是靠防火牆。
- [ ] **跨機器連線有加密**:
  - **Tailscale / WireGuard(最簡單)**:`bind` 改成 server 的 tailnet IP(compose 的 `ports:` 也改成 `<tailnet-ip>:7879:7879`),voice node 用 `VOICE_LINK_URL=ws://<tailnet-ip>:7879/voice-link`。tailnet 內部流量本身已加密。
  - **wss 反向代理**:Caddy / nginx 把 `wss://voice.example.com/voice-link` 轉到 `127.0.0.1:7879`,voice node 用 `wss://...`。Admin API 同理(要從遠端用面板時),且不要在代理上放寬 `Authorization` 檢查。
  - SSH tunnel 也行:`ssh -L 7878:127.0.0.1:7878 <server>`。
  - 面板開了 Discord 登入時,遠端只用 https 或 tailnet 位址,且 `redirect_uri` 跟瀏覽器網址一致(見 [§5](#管理面板的-discord-登入選用))。
  - voice link 與 Admin API 本身是**明文** HTTP/WebSocket,token 和語音都看得到;不加密就不能跨網路。
- [ ] **Self 帳號 token**(`SELF_TOKEN`)只存在 voice node 那台機器的 `.env`,權限只有你自己的使用者可讀(Linux:`chmod 600 .env`)。
- [ ] **Discord bot 權限最小化**:邀請連結只勾上面列的權限,不要給 Administrator。
- [ ] **容器已降權**:Core 容器以非 root(uid 10001)執行、唯讀根檔案系統、`cap_drop: ALL`、`no-new-privileges`。Linux 上若 `profiles/` 不是這個 uid 擁有,用 `deploy/.env` 的 `MIYORIA_UID` / `MIYORIA_GID` 換成自己的,不要 `chmod 777`。
- [ ] **備份有加密或放在受信任處**:dump 內含所有人的對話記憶。
- [ ] **收音同意**:語音頻道有公告她在聽;`[modules.voice] consent` 設定符合你的社群規則;預設不存音訊。
- [ ] **成本煞車**:LLM 供應者後台設用量上限;用 `miyoria status` 定期看用量。
- [ ] **公開頁**:對外的 tunnel 只應指到 Core;`metrics_public` 維持 false(tunnel 會把 `/metrics` 一起開出去)。
- [ ] **面板權限**:只有需要的角色有 `admin.panel.access` / `admin.panel.write`;`DISCORD_CLIENT_SECRET` 跟其他秘密一樣只放 `.env`。
- [ ] Token 外洩時:立刻到 Discord Developer Portal Reset Token / 換 self 帳號密碼,重新產生 `MIYORIA_API_TOKEN` / `VOICE_LINK_TOKEN`(刪掉 `.env` 裡那行再跑 `miyoria init`,或手動改),重啟所有節點。

## 10. 疑難排解

### 她什麼動作都不做,日誌寫 `cannot read the rules`

規則(docs/design/v3-architecture.md §9)讀不到時,除了停止類動作,她的動作全部擋下,面板 `GET /api/directives` 的 `healthy` 會是 `false`。這是刻意的:規則讀不到,就當作規則擋住了。資料庫恢復後,下一次讀取(最多 `[modules.directive] refresh_secs` 秒)就會自己恢復。關掉 `directive` 模組沒有用,它只管工具和指令,規則本身一直生效。

### 她完全不回話,面板寫「已緊急停止」

緊急停止開著(面板的按鈕、`/admin autonomy pause`、`/miyo` 的「緊急停止」、`POST /api/mind/pause` 都是同一件事,重啟後仍然有效)。按下去依序做:設定暫停、結束進行中的回合並丟掉排隊的話、打斷正在播的語音,再以 `panel` 身分停唱歌、關台、離開語音、停遊戲。每一步的結果都會回報,其中一步失敗不影響後面的步驟,再按一次會全部重做。

停止期間聽到的話會留在她的歷史裡,但不會回。解除(`/admin autonomy resume`、面板「解除停止」)後她會再開口,語音、直播和遊戲不會自動回來。每一步最多等 `[modules.actions] emergency_step_ms`。

### 她說「Filtered.」

那句話被內容安全擋下來了(`[modules.moderation]`,§16)。`moderation.block` 事件和日誌的 `output blocked` 有規則 id,不會有內容;誤擋時用 `allow` 或 `disabled_rules`。被擋的句子在 DeliveryLedger 記成 `blocked`:不算講過,同一個版本也不會再講一次。

### 她拒絕做某件事,說有規則

看 `/miyo` 或 `/admin` 的「規則」頁、或 `GET /api/directives`。`deny` 對所有人有效,主人自己的指令也一樣,要解除才會恢復。

先做這幾件事:`miyoria doctor`、`miyoria status`(服務有沒有在跑)、看 log(§8,服務用 `miyoria logs <服務>`)、`miyoria module list`。

| 現象 | 可能原因 / 做法 |
|---|---|
| `docker compose up` 說 `env file ...\.env not found` | 根目錄還沒有 `.env`:先跑 `miyoria init`(或手動建立)。 |
| `core` 容器一直重啟 / unhealthy | `logs core` 看原因。常見:掛進去的設定把 `bind` 改回 `127.0.0.1`(容器裡要 `0.0.0.0`,見 §2 B)、`[modules.api] token is empty`(根目錄 `.env` 沒有 `MIYORIA_API_TOKEN`)、`cannot bind`(宿主機埠被佔用,在 `deploy/.env` 改 `API_PORT` 等)、`DATABASE_URL` 不是 `sqlite:` 或 `memory://`(只支援 SQLite)。 |
| `core` 容器讀不到 `/profiles/...`、權限錯誤 | Linux:`profiles/` 擁有者不是 uid 10001。設 `MIYORIA_UID=$(id -u)`、`MIYORIA_GID=$(id -g)`。 |
| Core 連不到宿主機上的 ASR / TTS(容器內) | worker 要綁 `0.0.0.0` 或 docker bridge 位址才連得到(只綁 `127.0.0.1` 的 worker 容器內看不到);或把 `ASR_URL` / `TTS_URL` 設成別台的位址。 |
| `miyoria status` 說沒有設定 `MIYORIA_API_TOKEN` | 根目錄 `.env` 缺這一行;CLI 和 Core 要讀到同一個 token。 |
| `miyoria status` 連不上 | Core 沒在跑;或 Core 在遠端而沒有 tunnel(`ssh -L 7878:127.0.0.1:7878`);或 `[modules.api] bind` 不是 127.0.0.1:7878。 |
| `miyoria up` 說找不到 `host.toml` | 這台還沒有 `host.toml`:新安裝 `miyoria init`;從舊設定來的 `miyoria host migrate`(見 [§4](#搬舊的設定))。 |
| 服務印 `✗`、狀態是 `backoff` 或 `failed` | 服務起不來或一直死掉(10 分鐘內 5 次就放棄)。`miyoria logs <服務> -n 200` 看原因:缺環境(`miyoria doctor --fix`)、缺模型或手動項目(`miyoria doctor`)、埠被佔(下一行)。修好後 `miyoria restart <服務>`。 |
| `up` 說埠上已經有在回應的服務,不是這個 hostd 啟動的 | 狀態 `foreign`:有別的程式(例如舊的手動啟動的服務)佔著那個埠,hostd 不會動它。把它關掉再 `miyoria up <服務>`,或在 `host.toml` 的 `[services.<名稱>]` 寫別的 `port`。 |
| `restart`、`down`、`update` 說「受保護」 | 她正在唱歌或直播,Core、Voice node、Stage 不會被動;等一下再試,確定要做就加 `--force`(`update` 會留著它們,之後 `miyoria restart <服務>`)。問不到 Core 的狀態時也這樣說。 |
| Core 呼叫 worker 得到 401 | hostd 啟動的 worker 要 token:Core 要從登記處拿(`miyoria status --all` 看這台有沒有連上、有沒有核准)。設定檔寫的位址和 hostd 回報的不一致(`localhost` 對 `127.0.0.1`)會用到沒有 token 的那一筆。hostd 啟動的 worker 連 `/health` 也要 token,所以手動 `curl` 會得到 401,看健康用 `miyoria status`。 |
| `miyoria host join` 連不上 Core | Core 的 `[modules.api] bind` 還是 `127.0.0.1`(要改成區網或 Tailscale 位址),或邀請碼過期、用過了(重新 `miyoria host invite`)。 |
| 加入了,但那台的服務沒有被用 | 還沒 `miyoria host approve <名字>`;`miyoria host ls` 看狀態和連線。連線一直是「未連線」:那台的 `miyoria doctor` 會說 `host.key`、Core 連線哪裡不對,Core 的 `[modules.cluster] bind`(`7880`)要連得到。 |
| 面板按「使用 Discord 登入」後 Discord 說 `Invalid OAuth2 redirect_uri` / 回來又是登入畫面 | Developer Portal 的 Redirects 沒有登記跟 `redirect_uri` 一模一樣的網址;或瀏覽器開的面板 origin(例如 `localhost`)跟 `redirect_uri`(`127.0.0.1`)不同,cookie 落在另一個 origin。登入畫面寫「沒有管理面板權限」就是帳號缺 `admin.panel.access`(見 [§5](#管理面板的-discord-登入選用))。 |
| `platform.discord.bot` 一直 failed | 沒開 Message Content Intent;或 token 錯 / 被 reset;`miyoria doctor` 會指出。 |
| Slash command 沒出現 | 全域註冊要等最多一小時;開發時填 `command_guilds`。Bot 邀請時要有 `applications.commands` scope。 |
| Voice node 印 `bad token` 後結束(close code 4401) | `VOICE_LINK_TOKEN` 跟 Core 的不一樣(注意 Core 容器吃的是根目錄 `.env`)。 |
| Voice node 結束,close code 4400 | Core 與 voice node 版本不符,兩邊都升級到同一版。 |
| Voice node 結束,close code 4409 | 同一個 self 帳號被另一個 voice node 取代了,確認沒有重複啟動。 |
| Voice node 一直重連 | `VOICE_LINK_URL` 不對,或 Core 的 7879 沒有發布出來(`docker compose ps`);跨機器時 Tailscale 沒連上。指數退避最長 30 秒。 |
| 她進語音但沒反應 | 用 `MIYORIA_LOG_LEVEL=debug` 看 log(`module` 是 `voice`、`speech`):ASR 有沒有收到、`ASR_URL` 對不對、worker `/health` 是否回 200(hostd 啟動的 ASR 在 `8003`,要帶 token,所以先看 `miyoria status` 的健康欄和 `miyoria logs asr`;手動跑的 ASR 是 `8001`,`curl http://127.0.0.1:8001/health`)。 |
| 語音延遲很高 | TTS 沒用真串流(看 worker `/health` 的 `streaming`);GPU 記憶體被遊戲吃光;跨網路的 voice link 延遲過大(改用 B')。 |
| 還原後 Core 報 migration 錯誤 | 備份是比較新的版本做的,Core 比較舊:用同版或更新的 Core。 |
| 想完全重來 | 原生:停掉 Core,刪掉 `data/`(SQLite)。Docker:`docker compose -f deploy/docker-compose.yml down -v` 會**刪掉 Core 資料 volume(資料庫在裡面)**。先備份(§7)。 |
| 啟動時說 `No such built-in module: node:sqlite` 或 `pnpm dlx miyoria`(或 `npx miyoria`)拒絕安裝(engines) | Node 版本太舊:要 Node ≥ 24(`node -v`)。 |
| 磁碟被 Docker 吃滿 | `docker system df`;`docker image prune`、`docker builder prune`;設定日誌輪替(§8)。 |

## 一句話的來龍去脈

只有主線能讓她說話或動作,其他模組只寫事實和提案。舊設定檔裡的 `[core] pipeline` 不再有作用,core 啟動時會警告一次。

要查一句話的來龍去脈,看事件日誌:`decision`(來源 `mainline`,含沉默的理由)、`utterance`、`delivered`,動作是 `action` 和 `result`(來源 `mainline.hands`,`accepted` 只代表受理)。
