# 部署與維運手冊

這份文件講「怎麼把 Miyoria 跑起來並維持運作」:選部署型態、第一次設定、啟動各節點、Discord 設定、升級、備份、日誌、安全與疑難排解。架構背景見 [ARCHITECTURE.md](ARCHITECTURE.md) §1、§16。

> 狀態:Phase 0–8 的程式都已實作(TypeScript,Node 24);尚未用真的 Discord、DeepSeek、語音模型、VTube Studio、OBS、Minecraft 實測。
>
> 指令寫法:下面的 `miyoria <指令>` 在不同安裝方式下是 `npx miyoria <指令>`(npm 套件)或 `pnpm dev <指令>`(從原始碼,在 repo 根目錄)。

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
| **Core** | `miyoria core`(npx、從原始碼或 Docker) | 直播機或 server | `7878` Admin API(CLI / 面板 / `/metrics`)、`7879` voice link(voice node 連進來)、`7882` stage link(Stage 連進來) |
| **資料庫** | 預設 SQLite 檔案(`data/miyoria.db`,Core 自己開,不用另外跑);選用 PostgreSQL:`deploy/docker-compose.yml` | 跟 Core 同一台 | Postgres `5432`(只綁 127.0.0.1) |
| **Self voice node** | `apps/voice-node`(Node ≥ 22.4) | 直播機(跟 ASR/TTS、OBS 同一台最好) | 不開埠,主動連 Core 的 7879 |
| **ASR / TTS worker** | `workers/`(Python,GPU) | 有 GPU 的機器 | `8001` ASR、`8002` TTS(只給 Core 用,不要對外) |
| **Stage** | `miyoria stage`(原生,不放 Docker) | 直播機 | 主動連 Core 的 7882;本機 `7883` 嘴型音量、`7884` overlay |

節點一律**主動往外連** Core,所以直播機在 NAT 後面不用做任何 port forwarding。

**所有埠預設都只綁 `127.0.0.1`。7878 / 7879 / 7882 永遠不要直接開到公網**(見 [§9](#9-安全檢查表))。

## 2. 部署型態

> 三台電腦分工(直播機、Bot 服務機、GPU 推論機)的設定、安裝和啟動指令見根目錄 README「多台電腦」和 `workers/README.md`「快速安裝」:`miyoria init` 選角色並寫好位址,`miyoria install` / `doctor` / `start` 依角色運作。`[machine]` 的 `roles` 決定這台電腦跑哪些服務,`[machine.hosts]` 是別台電腦連進來用的位址;`[stack.workers.<名稱>]` 仍可逐欄位覆蓋 worker 的 venv、埠和環境變數。

### A. All-in-one(一台機器全包)

開發或自己小規模使用。全部跑在直播機(Windows)上。

| 在直播機上 | 怎麼跑 |
|---|---|
| 資料庫 | 不用做什麼:預設 SQLite(`data/miyoria.db`)。要 Postgres 再 `docker compose -f deploy/docker-compose.yml up -d postgres` |
| Core | `npx miyoria core`(或從原始碼 `pnpm dev:core`) |
| ASR / TTS worker | 見 [workers/README.md](../workers/README.md)(沒有 GPU 先用 `workers/fake`) |
| Voice node | `cd apps/voice-node && pnpm start`(repo 根目錄先 `pnpm install`) |

所有 URL 都是預設的 `127.0.0.1`,不用改任何位址。

### B. Split:Core 在 server,語音與 Stage 在直播機(目標型態)

Core(+ 資料庫)在 server(Docker),直播機跑 worker、voice node、Stage。Discord 語音音訊在直播機上直接進 ASR、TTS 直接出,不繞 server 一圈。

```
直播機(Windows)                               Server(Linux, Docker)
┌──────────────────────────┐   voice link     ┌─────────────────────────┐
│ voice node ──────────────┼──── ws/wss ────▶ │ Core :7879              │
│ ASR :8001 / TTS :8002 ◀──┼── HTTP(經 tunnel)│  ├ Admin API :7878       │
│ Stage ───────────────────┼── ws/wss ────▶   │  └ SQLite / Postgres     │
└──────────────────────────┘                  └─────────────────────────┘
```

重點:

- Core 要呼叫直播機上的 ASR / TTS,所以 server 必須連得到那兩個埠。**不要把 8001/8002 開到公網**,走 Tailscale / WireGuard:Core 的 `ASR_URL=http://<直播機 tailnet IP>:8001`、`TTS_URL=http://<直播機 tailnet IP>:8002`,worker 啟動時用 `HOST=<tailnet IP>`(或只綁 tailnet 網卡)。
- 想少做網路設定,用 **B'**(下一節):語音推論也放 server。
- voice link 跨網路要走加密,見 [§9](#9-安全檢查表)。

Server 上:

```bash
git clone <repo> miyoria && cd miyoria
cp deploy/.env.example deploy/.env        # 改 POSTGRES_PASSWORD(只用字母數字 - _ .)
# 在專案根目錄產生 .env:可以在任何機器跑 `npx miyoria init` 再把 .env 複製過來,
# 或直接手動從 .env.example 建立,token 用 `openssl rand -hex 32` 產生
docker compose -f deploy/docker-compose.yml --profile core up -d --build
docker compose -f deploy/docker-compose.yml --profile core ps      # 等 core 變成 healthy
```

`core` 服務由 [`deploy/Dockerfile.core`](../deploy/Dockerfile.core) 建出來(Node 24,內含管理面板),使用 [`deploy/miyoria.docker.toml`](../deploy/miyoria.docker.toml) 當設定。**容器裡的 Admin API、voice link、stage link 必須綁 `0.0.0.0`**(綁 `127.0.0.1` 的話宿主機的埠映射連不進去,healthcheck 會過但外面連不到);對外與否由 compose 的 `ports:` 決定,一律只映射到宿主機的 `127.0.0.1`。容器的日誌會警告 `admin API is reachable from the network over plain HTTP`(voice / stage link 也一樣),在容器裡這是預期的。所以不要直接把給宿主機用的 `miyoria.toml` 掛進容器;要改設定就複製 `miyoria.docker.toml`,保留那三個 `bind`,在 `deploy/.env` 設 `MIYORIA_CONFIG_FILE=<路徑>`。

compose 裡的 Core 預設用同一個 compose 的 Postgres(`DATABASE_URL` 由 compose 組成)。想在容器裡用 SQLite,在 `deploy/.env` 設 `CORE_DATABASE_URL=sqlite:/data/miyoria.db`(存在 `core-data` volume)。

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

需求:Node ≥ 24;從原始碼跑還要 pnpm 9(`corepack enable` 會用 `package.json` 指定的版本);Docker 只有要 Postgres 或 Core 容器時才需要。

用 npm 套件(在一個空資料夾):

```bash
npx miyoria@latest init                # 互動式精靈
npx miyoria doctor                     # 檢查連線
npx miyoria profile validate
npx miyoria chat                       # 在終端機跟她聊天,不需要 Discord
```

想固定版本、少打 `npx`:`npm install -g miyoria`(之後直接打 `miyoria …`),或在專案裡 `npm install miyoria`。

從原始碼(repo 根目錄):

```bash
corepack enable && pnpm install
pnpm dev init                          # 跟 miyoria init 一樣;tsx 直接跑原始碼,不用 build
pnpm dev doctor
pnpm dev chat
```

`miyoria init` 會:

- 寫 `miyoria.toml`(從 `miyoria.example.toml`)和 `.env`(秘密放這裡,不進 git),並把內建角色複製到 `profiles/`;
- 詢問 LLM base URL / API key / 模型 id、Discord bot token、你的 Discord user id(擁有者);
- 自動產生 `MIYORIA_API_TOKEN`、`VOICE_LINK_TOKEN`、`STAGE_LINK_TOKEN`;
- 資料庫:預設 SQLite(`sqlite:data/miyoria.db`);也可以選 `memory://`(重啟就沒了,先試用)或 Postgres。

`miyoria doctor` 檢查設定檔、profile、LLM、Discord、資料庫連線。每次改完設定、換機器、升級後都先跑一次。

之後改設定用 `miyoria config`(互動選單)或 `miyoria config set <key> <value>`、`miyoria config set --env <NAME> <value>`。

### 資料庫

預設是 SQLite:`DATABASE_URL=sqlite:data/miyoria.db`(相對路徑以 `miyoria.toml` 所在的資料夾為準),Core 第一次啟動時建立檔案並套用 migration,不用做任何事。資料量大、要放 server 或想用 pgvector 做向量檢索時改用 PostgreSQL:

```bash
cp deploy/.env.example deploy/.env            # 改 POSTGRES_PASSWORD
docker compose -f deploy/docker-compose.yml up -d postgres
docker compose -f deploy/docker-compose.yml ps    # 等 healthy
```

根目錄 `.env` 設:

```
DATABASE_URL=postgres://miyoria:<密碼>@127.0.0.1:5432/miyoria
```

migration 在 Core 第一次連上資料庫時自動執行,`vector` 擴充也是那時建立,不需要手動處理。SQLite 換到 Postgres 時資料不會自動搬過去。

> `deploy/.env`(給 docker compose 用:資料庫密碼、埠)和根目錄 `.env`(給 Miyoria 用:LLM key、Discord token、各種 token)是兩個不同的檔案。Core 容器會自動把 `DATABASE_URL` 換成 compose 網路上的 `postgres:5432`,所以根目錄 `.env` 可以保留給宿主機用的 `127.0.0.1` 位址。

## 4. 啟動各個節點

### Core

原生:

```bash
npx miyoria core                   # 或從原始碼:pnpm dev:core
```

Core 預設在 `http://127.0.0.1:7878/` 提供管理面板(npm 套件內含;從原始碼要先 `pnpm build:web`)。

Docker:

```bash
docker compose -f deploy/docker-compose.yml --profile core up -d --build
docker compose -f deploy/docker-compose.yml --profile core logs -f core
docker compose -f deploy/docker-compose.yml --profile core down       # 停止(資料 volume 保留)
```

只想要 Postgres、Core 在宿主機跑:不加 `--profile core`,只會啟動 `postgres`。

Core 起來之後,用 CLI 操作(CLI 讀 `miyoria.toml` 的 `[modules.api]` 連 `127.0.0.1:7878`;Core 在 server 時,先 `ssh -L 7878:127.0.0.1:7878 <server>` 或走 Tailscale):

```bash
miyoria status                  # 各模組狀態、LLM 用量
miyoria module list             # enable / disable / restart <id> 可以單獨啟停子系統
miyoria decisions               # 她為什麼回話或沉默
miyoria events 'agent.*'        # 即時事件
miyoria persona show
```

### Voice node(直播機)

```bash
pnpm install                    # 在 repo 根目錄(voice node 是 workspace 的一員)
cd apps/voice-node
cp .env.example .env            # 填 SELF_TOKEN、VOICE_LINK_URL、VOICE_LINK_TOKEN
pnpm start                      # 或 pnpm build && pnpm start:dist
```

- `VOICE_LINK_TOKEN` 必須跟 Core 的 `.env` 一樣。
- `VOICE_LINK_URL`:同機 `ws://127.0.0.1:7879/voice-link`;跨機用 `ws://<tailnet-ip>:7879/voice-link` 或 `wss://voice.example.com/voice-link`。
- 啟動後在 Discord 打 `/voice join`,她就會進你所在的語音頻道。詳細設定見 [apps/voice-node/README.md](../apps/voice-node/README.md)。
- 長期運行建議用行程管理員:Windows 用工作排程器「登入時執行」或 NSSM,Linux 用 systemd / pm2。`Ctrl+C` / SIGTERM 會先離開語音頻道再結束。

### 推論 worker

見 [workers/README.md](../workers/README.md)。最短路徑:

```bash
cd workers
python -m venv .venv && .venv/Scripts/pip install -r fake/requirements.txt   # Linux: .venv/bin/pip
.venv/Scripts/python fake/fake_server.py       # 沒有 GPU 時先用這個,http://127.0.0.1:8000
```

真的 worker:SenseVoice ASR(`:8001`)、Qwen3-TTS(`:8002`),或 `workers/docker-compose.yml`(需要 NVIDIA container toolkit)。Core 端用 `ASR_URL` / `TTS_URL`(根目錄 `.env`)指到它們。檢查 worker 是否符合協定:

```bash
WORKER_ASR_URL=http://127.0.0.1:8001 WORKER_TTS_URL=http://127.0.0.1:8002 python -m pytest tests/test_contract.py
```

做歌時的 GPU 分配由 song worker 依當下狀態決定,不用設大小。`GET :8005/health` 的 `gpu` 欄位看得到決定和原因,學到的數字存在歌曲快取的 `_gpu-profile.json`,換卡會重來。要固定做法時設 `SING_GPU_POLICY`:

| 值 | 行為 |
|---|---|
| `auto`(預設) | 放得下就共用,放不下先用 CPU 和等待,語音只在必要時短暫下線 |
| `share` | 永遠不動語音 |
| `wait` | 永遠不動語音,沒空間就等 |
| `offload` | 一律讓語音下線(舊行為) |

TTS 和 ASR 的模型跑在子程序,`/offload` 結束子程序,回傳的 `released_mb` 是整張卡實際還回的量。`TTS_ENGINE_PROCESS=0` 或 `ASR_ENGINE_PROCESS=0` 可以改回同一個程序,但卸載就不一定還得回顯存。

### 從原始碼一個指令跑起來:`up`、`doctor --deep`、`update`

只用在原始碼 checkout(要有 `workers/`、`apps/`、`pnpm-workspace.yaml`);npm 安裝的版本沒有 worker,也沒有可重建的東西。

**設定(選用)。** 沒有 `[stack]` 時 `miyoria up` 只啟動 core,和 `miyoria core` 一樣。要讓它啟動 worker,在 `miyoria.toml` 寫:

```toml
[stack]
# voice_node = true             # 另外啟動 apps/voice-node(pnpm start)
# stage = true                  # 另外啟動 miyoria stage
# start_timeout_secs = 180      # 每個服務等健康檢查的秒數

[stack.workers]
asr = { venv = "workers/.venv-asr-qwen", port = 8003, env = { ASR_BACKEND = "qwen3", ASR_QWEN_SIZE = "0.6B" } }
tts = { venv = "workers/.venv-tts-faster", port = 8002 }
sing = { venv = "workers/.venv-sing", port = 8005, offload = ["tts", "asr"] }
```

每個 worker 的欄位:`venv`(預設 `workers/.venv-<名字>`)、`port`(asr、tts、sing、turn 有預設:沒有 `[machine]` 時 asr 8001、tts 8002、sing 8005、turn 8006;有 `[machine]` 時 asr 8003)、`host`、`dir`(`workers/` 底下的資料夾,預設同名)、`entry`(預設 `server.py`)、`env`、`offload`、`vram_mb`(顯存估計,預設 asr qwen3 0.6B 約 1500、tts 約 5000、sing 約 7500)、`start_timeout_secs`。`[speech.asr.*]`、`[speech.tts.*]`、`[modules.sing]` 的 `url` 要指到同一個 port,`doctor --deep` 會比對。

**`miyoria up`**

- 順序:被 `offload` 的 worker 先起,然後 sing,接著 core、voice node、stage。每一個都要通過健康檢查(worker 是 `GET /health`,core 是 `/api/health`)才起下一個。
- `offload = ["tts", "asr"]` 會替 sing 設好 `SING_OFFLOAD_URLS`(沒有它,12 GB 的卡在做歌時會溢出,轉換慢約 76 倍)。`env` 裡自己寫的值優先。
- worker 只繼承系統基本變數、CUDA 與模型快取、proxy;不繼承 shell 裡的 API key 和 token,也不會繼承舊的 `ASR_MODEL`。
- 已經在回應 `/health` 的服務直接沿用,不會重起。埠被別的程式佔用,或被 Windows 保留(EACCES)時停下來說明並附修正,**不會替你結束別人的程式**。
- 日誌在 `data/stack/logs/<服務>.log`。Ctrl+C 依相反順序停止這次啟動的服務。
- 選項:`--only asr,core`、`--skip sing`、`--timeout 300`、`--dry-run`(只列順序和指令)、`--no-check`。

**`miyoria doctor --deep`**(`--deep-only` 只跑部署檢查,不連 LLM、Discord、資料庫)。只讀:不會改 Windows、防火牆或防毒設定,每個 ✗ / ! 都附修正步驟。

| 檢查 | 抓什麼 |
|---|---|
| 埠 | 動態埠範圍從 1024 開始、設定裡的埠落在 Windows 保留範圍(綁定 EACCES 但沒人在聽)、埠被別的程式佔用 |
| 建置 | SDK、擴充 `dist`、面板、overlay 比原始碼舊或是空的 |
| Minecraft mod | jar 比原始碼舊、遊戲 `mods/` 裡的 jar 和建置出來的不同、`Protocol.java` 與 `PROTOCOL.md` 的協定版本不一致、找不到 JDK 21(PATH 上是 Java 8 也會說) |
| worker 設定 | venv 與 `server.py` 存在、埠不重複、sing 沒設 `offload`、`SING_OFFLOAD_URLS` 與 `offload` 不一致、`ASR_BACKEND=qwen3` 卻留著 `ASR_MODEL`、`speech.*.url` / `modules.sing.url` 的埠和 worker 不同 |
| 快取資料夾 | yt-dlp 快取和歌曲資料夾能不能寫入 |
| 暫存檔 | 在暫存資料夾寫、讀、刪 2 MB 檔案(防毒鎖檔的症狀)、殘留的 `esbuild-*`、偵測到 Kaspersky 等會說明 |
| 顯存 | `nvidia-smi` 的使用量,以及各 worker 估計值(含 offload)的尖峰是否超過總量 92% |
| 服務健康 | 各服務 `/health`;執行中的 core 版本和這份 CLI 不同 |
| 舊設定 | V2 留下的 `ambient_factor`、`cooldown_ms`、`min_cooldown_ms`、`interrupt_scale`,聊天等級 `ambient`(只列鍵名) |

Windows 保留埠的處理需要系統管理員,要自己做:`netsh interface ipv4 show excludedportrange protocol=tcp` 查看,`net stop winnat` 再 `net start winnat` 釋放;長期做法是 `netsh int ipv4 set dynamic tcp start=49152 num=16384`(要重開機)。

**`miyoria update`**

1. `git pull --ff-only`(工作目錄有未提交的變更就略過;`--no-pull` 不做)。
2. `pnpm install`(只在 `pnpm-lock.yaml` 比上次安裝新時)。
3. 只重建過期的:SDK、各擴充的 `dist`、面板、overlay、Minecraft mod。比的是原始碼和輸出的檔案時間;`--force` 全部重建,`--skip-mod` 跳過 mod。
4. 面板與 overlay 一律用 `vite build --minify false --target esnext`(避開防毒鎖住 esbuild 暫存檔),輸出先到 `dist.next`,成功才換掉 `dist`;失敗時舊的 `dist` 原封不動。
5. mod 用找到的 JDK 21 建置(只對這次 Gradle 設 `JAVA_HOME`,不改系統設定)。要覆蓋 `<minecraft_dir>/mods` 裡的 jar 時**先問**,舊檔備份到 `<minecraft_dir>/miyoria-backup/<時間>/`;自動化加 `--yes`,非互動又沒有 `--yes` 就不覆蓋。請先關掉遊戲。
6. 最後列出 V2 留下的舊設定值(只提示,不自動改寫)。

`--dry-run` 只列出會做的事。更新後已在執行的 core / worker 要重啟(`miyoria up`)。

### Stage 與管理面板

Stage 要直接碰 VTube Studio / OBS / 遊戲,所以原生在直播機執行,不放 Docker:`miyoria stage`,讀 `miyoria.toml` 的 `[stage]`(`core_url`、`token` = `STAGE_LINK_TOKEN`、`[stage.vts]`、`[stage.obs]`),協定見 [stage-link.md](protocols/stage-link.md);overlay 見 [apps/overlay/README.md](../apps/overlay/README.md)。

餵食禮物的那一行(「Owen 餵了她一碗白飯」,60 秒內合併、約 8 秒後淡出)在預設的 overlay 頁(`http://127.0.0.1:7884/overlay/`)裡一起顯示;只要這一行時用 `…/overlay/?show=gifts`。

管理面板是靜態檔,由 Core 提供(`[modules.api] panel_dir`,`MIYORIA_PANEL_DIR` 可覆寫):npm 套件與 Docker 映像檔都已內含;從原始碼跑時先 `pnpm --filter @miyoria/panel build`(或 `pnpm build:web`,輸出 `apps/panel/dist`,Core 預設就讀這裡)。開發時 `pnpm --filter @miyoria/panel dev`(Vite,`http://localhost:5178`,`/api` 轉給 `MIYORIA_CORE_URL`,預設 `http://127.0.0.1:7878`)。

**連結預覽**:Discord、Slack、X 這類爬蟲不跑 JavaScript,所以 Core 送出 `index.html` 時按路由改寫 `<!-- meta:start -->` 到 `<!-- meta:end -->` 之間的標籤(標題、描述、`og:*`、Twitter card,`packages/api/src/meta.ts`)。`/card/<編號>` 的標籤帶那張卡的名字、稱呼、編號和框(都是卡片頁本來就顯示的),`og:image` 指到 `/og/card/<編號>.png?v=<卡片資料的雜湊>`:只有那張卡本身,1000×1397(卡的原比例,四角透明),和面板同一份繪圖(`packages/card-face`)用 resvg 畫出來,不需要瀏覽器。站台預設圖 `/og/default.png`(1200×630)是毛玻璃:靠左貼齊邊緣一片玻璃放名字和一句話,她站在右邊、壓過玻璃的邊。玻璃後面的光是她自己的立繪放大模糊做的,不用面板的背景圖(那是遊戲美術,只放在 owner 自己的螢幕上,不放進誰都能抓的預覽圖);沒有立繪就用暮色漸層(resvg 沒有 backdrop-filter,模糊是事先用 sharp 做好的)。圖按編號加資料版本留在記憶體(最近 64 張),卡的資料變了(換框、作廢)網址的 `v` 就變,上游快取不會吃到舊圖。編號不存在、格式不對、已作廢或讀不到時給站台預設標籤和 `/og/default.png`,不含任何人的資料。網址的 origin 取 `X-Forwarded-Host` / `X-Forwarded-Proto`,沒有就用 `Host`(隧道要把原本的 Host 傳進來)。畫圖用系統字型(Windows 的微軟正黑體,Linux 要裝 Noto Sans CJK);立繪讀 `panel_dir` 裡的 `card-<pose>.local.webp`,沒有就畫不含立繪的卡。

面板有七頁(側欄可收合,`Ctrl/⌘ + B`;`Ctrl/⌘ + K` 開搜尋,可跳到頁面、人、子系統):

| 頁 | 內容 |
|---|---|
| 總覽 | 子系統、今日花費、LLM 呼叫、佇列四個數字;需要注意的項目(失敗或降級的子系統、擴充、MCP,LLM 預算);LLM 用量表 |
| 動態 | 事件 / 決策 / 轉錄三個分頁,共用同一條 `/api/events` 串流;點一列在側邊面板看細節 |
| 直播 | OBS 場景、VTS 表情(清單來自 Stage 節點回報)、OBS 推流開關、overlay 網址與預覽;「讓她說」(她不在語音頻道時停用);請求佇列;語音頻道成員與延遲 |
| 角色 | Persona(對話框編輯、儲存前看 diff、版本比較與還原)/ 記憶(搜尋、編輯、刪除、分頁載入)/ 人(關係、好感調整、稱呼、標籤、備註、封鎖) |
| 系統 | 子系統 / 擴充套件 / MCP 伺服器;MCP 只能重新連線(開關在 `miyoria.toml`) |
| 權限 | 指派(選人或輸入帳號 id)、角色的新增 / 編輯 / 刪除、Discord 身分組對應 |
| 設定 | Core 位址與 token |

側欄底部的圓點是 Core 與事件串流的狀態(滑過看版本與位址)。唯讀帳號(沒有 `admin.panel.write`)看得到所有東西,但修改類的控制項會停用。

### 上網查資料

模組 `web`(預設開著,`[modules.web]`)給她兩個工具:`web_search`(DuckDuckGo 的 HTML 搜尋,`region` 預設 `tw-tzh`)和 `web_read`(讀一個公開網頁的文字,上限 `read_chars`)。要有 `tools.web` 才能請她用,member 以上預設有,restricted 沒有。不要上網就在 `miyoria.toml` 寫 `[modules.web] enabled = false`。網頁只讀 http / https,DNS 解出來是內部、私有或 localhost 的位址一律拒絕,轉址最多 3 次且每一站重新檢查;每人 10 分鐘 6 次搜尋 / 10 次讀頁、全部人 30 / 60 次,相同搜尋 10 分鐘內用快取。查到的東西回給她時標成不可信的資料,裡面的指令她不會照做。DuckDuckGo 要求驗證或回錯誤時,她只會說現在查不到,程式不會繞過。讀一頁最多 `read_chars`(預設 12000),`result_chars`(預設 12000)是回給 agent 的上限,搜尋答案另有 `search_chars`(預設 3900);`[modules.agent] max_tool_result_chars` 要不小於 `result_chars`,否則網頁內容會在資料區塊中間被切掉。

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
- 放在 Cloudflare tunnel 後面時,請求都從本機進來,速率限制看 `CF-Connecting-IP`。Core 綁在 `127.0.0.1` 才能信這個標頭;綁到其他位址時,非本機的連線一律用連線位址。
- `identify` 不能證明對方是伺服器成員:任何 Discord 帳號都能登入成員頁,但什麼資料都沒有,而且她不認識的帳號不能點歌。
- 公開頁會把 `apps/panel/dist` 裡的預設背景圖傳給所有訪客。那張圖是遊戲 CG,對外開放前先確認授權,或把 `public/background.local.jpg` 拿掉後重新建置面板(`pnpm build:web`),面板會退回暮色漸層。

從別台機器用面板:cookie 和 token 都會走明文 HTTP,所以要嘛走 Tailscale(`redirect_uri` 用 tailnet 位址,例如 `http://100.x.y.z:7878/api/auth/oauth/callback`,並把 `[modules.api] bind` 綁到那個位址),要嘛放在 https 反向代理後面(`redirect_uri = "https://panel.example.com/api/auth/oauth/callback"`,cookie 自動加上 `Secure`)。無論哪種,Developer Portal 的 redirect、`redirect_uri` 和你在瀏覽器開的網址三者要一致。

## 6. 升級

**原則:先備份,再升級,升級後跑 `doctor`。**

```bash
scripts/backup.sh                           # Windows: scripts\backup.ps1
git pull
```

原生 Core:

```bash
npx miyoria@latest doctor        # npm 套件:@latest 會拿最新版;全域安裝的用 npm install -g miyoria@latest
# 從原始碼:git pull && pnpm install
# 重啟 core(Ctrl+C 後再 miyoria core,或你的行程管理員)
```

Docker Core:

```bash
docker compose -f deploy/docker-compose.yml --profile core up -d --build   # 重建映像檔並換掉容器
docker compose -f deploy/docker-compose.yml --profile core logs -f core
```

- 資料庫 migration 在 Core 啟動時自動往前套用。**migration 不會自動回退**,要降版就是「還原備份 + 換回舊版映像檔」。
- 想保留舊版可回退:升級前 `docker tag miyoria-core:local miyoria-core:previous`,出問題時在 `deploy/.env` 設 `MIYORIA_IMAGE=miyoria-core:previous`,`up -d` 時不加 `--build`。
- voice node:`git pull && pnpm install && pnpm --filter @miyoria/voice-node build`,再重啟。Core 與 voice node 的協定版本不符會用 close code `4400` 拒絕連線,兩邊要一起升級。
- 從原始碼升級可以用 `miyoria update`(見 §4「從原始碼一個指令跑起來」),升級後跑 `miyoria doctor --deep`。
- 設定檔有新欄位時,對照 `miyoria.example.toml` 手動合併,或重跑 `miyoria init`(可重複執行,Enter 保留現值,寫入前會問)。
- Postgres 大版本(例如 17 → 18)升級不能直接換 image tag:先備份,用新版 image 開一個新 volume,再還原。

## 7. 備份與還原

### 要備份什麼

| 項目 | 位置 | 怎麼備份 |
|---|---|---|
| 資料庫(記憶、好感、決策紀錄、persona 歷史) | SQLite:`data/miyoria.db`(Docker:`core-data` volume 的 `/data`);Postgres:compose 的 `pgdata` volume | SQLite:見下方;Postgres:`scripts/backup.sh` / `scripts\backup.ps1` |
| 設定與秘密 | 根目錄 `.env`、`miyoria.toml`、`deploy/.env` | 手動複製到安全的地方(**不要進 git、不要上傳到公開處**) |
| 角色 profile | `profiles/` | 在 git 裡;但 `profiles/*/avatar/model/` 與 `voice/*.wav` 因授權不進 git,要另外備份 |
| 聲音檔 | `workers/voices/` | 手動備份 |

### SQLite

資料就是 `data/miyoria.db` 一個檔案(WAL 模式,旁邊可能有 `miyoria.db-wal`、`miyoria.db-shm`)。最簡單:停掉 Core 再複製 `data/` 整個資料夾。不想停機就用 sqlite3 的線上備份:

```bash
sqlite3 data/miyoria.db ".backup backups/miyoria-$(date +%Y%m%d-%H%M%S).db"
```

還原:停掉 Core,把備份檔複製回 `data/miyoria.db`(刪掉舊的 `-wal` / `-shm`),再啟動。下面的腳本只處理 Postgres。

### 備份(Postgres)

```bash
scripts/backup.sh                    # -> backups/miyoria-YYYYMMDD-HHMMSS.dump
scripts/backup.sh --keep 30          # 保留最新 30 份(預設 14,0 = 全部保留)
scripts/backup.sh --dir /mnt/nas     # 寫到別處(環境變數 BACKUP_DIR / BACKUP_KEEP 也可以)
```

```powershell
scripts\backup.ps1
scripts\backup.ps1 -Keep 30 -Dir D:\nas
```

腳本用 `pg_dump -Fc`(壓縮的 custom format)從 compose 的 `postgres` 容器匯出,先寫成 `.partial` 驗證能讀才改名,所以不會留下壞檔。`backups/` 已被 `.gitignore` 排除。需要 `postgres` 服務正在執行。

定期備份:

```cron
# Linux crontab -e:每天 03:30
30 3 * * * cd /srv/miyoria && scripts/backup.sh --keep 30 >> backups/backup.log 2>&1
```

```powershell
# Windows 工作排程器(每天 03:30)
schtasks /Create /SC DAILY /ST 03:30 /TN "Miyoria Backup" /TR "pwsh -NoProfile -File C:\path\to\miyoria\scripts\backup.ps1 -Keep 30"
```

**備份要放到另一台機器或雲端**(`rsync`、`rclone`、NAS),同一顆硬碟上的備份擋不住硬碟故障。

### 還原(Postgres)

**會取代資料庫目前的內容。**

```bash
scripts/restore.sh backups/miyoria-20260101-033000.dump
scripts/restore.sh --latest          # 最新一份
scripts/restore.sh --yes <檔案>       # 不問確認(給自動化用)
```

```powershell
scripts\restore.ps1 backups\miyoria-20260101-033000.dump
scripts\restore.ps1 -Latest
```

- 如果 Core 在 Docker 裡跑,腳本會先停掉它、還原完再啟動;原生跑在宿主機的 Core 要你自己先停。
- 還原用 `--clean --if-exists --single-transaction`:失敗會整個回滾,不會留下半套資料。
- 換新機器:裝好 Docker、`up -d postgres`、複製 `deploy/.env` 與根目錄 `.env`、還原備份、再啟動 Core。
- **還原演練**:至少做過一次(例如在另一台機器或另一個 compose 專案名稱下還原),才算有備份。

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
- **從備份還原尚未支援**:面板的 JSON 備份是給人看與留存的(不含記憶的 embedding 與搜尋 token);要整個復原,請用上面的資料庫備份(SQLite 檔案或 `scripts/backup`)。重設前先做一次資料庫備份最保險。
- 這個頁面只處理目前的 profile;共用資料會影響同一個資料庫裡的其他角色(多角色的節點要注意)。

## 8. 日誌

Core 用 pino:預設每行一筆 JSON(在終端機會自動改成好讀的單行格式),層級由環境變數 `MIYORIA_LOG_LEVEL`(`fatal|error|warn|info|debug|trace|silent`)控制;沒設時用 `miyoria.toml` 的 `[core] log` 的第一個層級(預設 `info,miyoria=debug` → `info`)。`MIYORIA_LOG_FORMAT=json` / `pretty` 可以強制格式。

```bash
MIYORIA_LOG_LEVEL=warn npx miyoria core          # 安靜
MIYORIA_LOG_LEVEL=debug npx miyoria core         # 查語音管線、Discord adapter 等細節
MIYORIA_LOG_LEVEL=debug pnpm dev:core            # 從原始碼
```

模組的日誌帶 `module`(例如 `voice`、`platform.discord.bot`),函式庫的帶 `scope`(例如 `llm.router`);JSON 格式時可以用 `jq` 過濾:`MIYORIA_LOG_FORMAT=json miyoria core | jq 'select(.module == "voice")'`。

Docker:

```bash
docker compose -f deploy/docker-compose.yml --profile core logs -f core
docker compose -f deploy/docker-compose.yml --profile core logs --since 1h core
docker compose -f deploy/docker-compose.yml logs -f postgres
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

Voice node 的層級用它的 `LOG_LEVEL`(`error|warn|info|debug`);`debug` 會印出 `@discordjs/voice` 與 DAVE 的細節。Worker 的日誌在各自的終端機(或 `docker compose logs`)。

## 9. 安全檢查表

上線前逐項確認:

- [ ] **Token 都是隨機長字串**:`MIYORIA_API_TOKEN`、`VOICE_LINK_TOKEN`、`STAGE_LINK_TOKEN` 由 `miyoria init` 產生(或 `openssl rand -hex 32`);`POSTGRES_PASSWORD` 不是 `change-me`。
- [ ] **秘密不進 git**:`.env`、`deploy/.env`、`miyoria.toml` 都在 `.gitignore`;`git status` 看不到它們。Docker 映像檔不含 `.env`(根目錄的 `.dockerignore` 已排除),不要把映像檔推到公開 registry 前自行 `docker history` 檢查。
- [ ] **全部綁 127.0.0.1**:`docker compose ... ps` 的 PORTS 欄看到的是 `127.0.0.1:7878->7878/tcp`,不是 `0.0.0.0:`。原生 Core 的 `[modules.api] bind`、`[modules."voice.link"] bind`、`[modules."stage.link"] bind` 維持 `127.0.0.1:...`。`miyoria.docker.toml` 裡的 `0.0.0.0` 只是容器內部的位址,對外與否由 compose 的 `ports:` 決定,不要把 `ports:` 的 `127.0.0.1:` 前綴拿掉。
- [ ] **7878 / 7879 / 7882(以及 8001 / 8002 / 5432)沒有直接開到公網**:防火牆(`ufw`、雲端 security group)對這些埠預設全擋。Docker 發布的埠會繞過 `ufw`,所以更要靠 `127.0.0.1` 綁定而不是靠防火牆。
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

先做這三件事:`miyoria doctor`、看 log(§8)、`miyoria module list`。

| 現象 | 可能原因 / 做法 |
|---|---|
| `docker compose up` 說 `set POSTGRES_PASSWORD in deploy/.env` | 還沒建 `deploy/.env`:`cp deploy/.env.example deploy/.env`。用 `-f deploy/docker-compose.yml` 時,compose 讀的是 **deploy/** 底下的 `.env`。 |
| `--profile core` 說 `env file ...\.env not found` | 根目錄還沒有 `.env`:先跑 `miyoria init`(或手動建立)。 |
| `core` 容器一直重啟 / unhealthy | `logs core` 看原因。常見:掛進去的設定把 `bind` 改回 `127.0.0.1`(容器裡要 `0.0.0.0`,見 §2 B)、`[modules.api] token is empty`(根目錄 `.env` 沒有 `MIYORIA_API_TOKEN`)、`cannot bind`(宿主機埠被佔用,在 `deploy/.env` 改 `API_PORT` 等)、`DATABASE_URL` 密碼含特殊字元(`@ : / %` 會讓 URL 解析失敗,改用字母數字密碼)。 |
| `core` 容器讀不到 `/profiles/...`、權限錯誤 | Linux:`profiles/` 擁有者不是 uid 10001。設 `MIYORIA_UID=$(id -u)`、`MIYORIA_GID=$(id -g)`。 |
| Core 連不到宿主機上的 ASR / TTS(容器內) | worker 要綁 `0.0.0.0` 或 docker bridge 位址才連得到(只綁 `127.0.0.1` 的 worker 容器內看不到);或把 `ASR_URL` / `TTS_URL` 設成別台的位址。 |
| `miyoria status` 說沒有設定 `MIYORIA_API_TOKEN` | 根目錄 `.env` 缺這一行;CLI 和 Core 要讀到同一個 token。 |
| `miyoria status` 連不上 | Core 沒在跑;或 Core 在遠端而沒有 tunnel(`ssh -L 7878:127.0.0.1:7878`);或 `[modules.api] bind` 不是 127.0.0.1:7878。 |
| 面板按「使用 Discord 登入」後 Discord 說 `Invalid OAuth2 redirect_uri` / 回來又是登入畫面 | Developer Portal 的 Redirects 沒有登記跟 `redirect_uri` 一模一樣的網址;或瀏覽器開的面板 origin(例如 `localhost`)跟 `redirect_uri`(`127.0.0.1`)不同,cookie 落在另一個 origin。登入畫面寫「沒有管理面板權限」就是帳號缺 `admin.panel.access`(見 [§5](#管理面板的-discord-登入選用))。 |
| `platform.discord.bot` 一直 failed | 沒開 Message Content Intent;或 token 錯 / 被 reset;`miyoria doctor` 會指出。 |
| Slash command 沒出現 | 全域註冊要等最多一小時;開發時填 `command_guilds`。Bot 邀請時要有 `applications.commands` scope。 |
| Voice node 印 `bad token` 後結束(close code 4401) | `VOICE_LINK_TOKEN` 跟 Core 的不一樣(注意 Core 容器吃的是根目錄 `.env`)。 |
| Voice node 結束,close code 4400 | Core 與 voice node 版本不符,兩邊都升級到同一版。 |
| Voice node 結束,close code 4409 | 同一個 self 帳號被另一個 voice node 取代了,確認沒有重複啟動。 |
| Voice node 一直重連 | `VOICE_LINK_URL` 不對,或 Core 的 7879 沒有發布出來(`docker compose ps`);跨機器時 Tailscale 沒連上。指數退避最長 30 秒。 |
| 她進語音但沒反應 | 用 `MIYORIA_LOG_LEVEL=debug` 看 log(`module` 是 `voice`、`speech`):ASR 有沒有收到、`ASR_URL` 對不對、worker `/health` 是否回 200(`curl http://127.0.0.1:8001/health`)。 |
| 語音延遲很高 | TTS 沒用真串流(看 worker `/health` 的 `streaming`);GPU 記憶體被遊戲吃光;跨網路的 voice link 延遲過大(改用 B')。 |
| 備份腳本說 `cannot reach the Docker daemon` | Docker Desktop / dockerd 沒啟動。 |
| 備份腳本說 `postgres service is not running` | `docker compose -f deploy/docker-compose.yml up -d postgres`。 |
| 還原後 Core 報 migration 錯誤 | 備份是比較新的版本做的,Core 比較舊:用同版或更新的 Core。 |
| 想完全重來 | 原生:停掉 Core,刪掉 `data/`(SQLite)。Docker:`docker compose -f deploy/docker-compose.yml --profile core down -v` 會**刪掉資料庫與 Core 資料 volume**。先備份(§7)。 |
| 啟動時說 `No such built-in module: node:sqlite` 或 `npx miyoria` 拒絕安裝(engines) | Node 版本太舊:要 Node ≥ 24(`node -v`)。 |
| 磁碟被 Docker 吃滿 | `docker system df`;`docker image prune`、`docker builder prune`;設定日誌輪替(§8)。 |

## 切回 V2

`[core] pipeline` 決定誰能讓她開口和動手。預設 `v3`:只有主線能說話或動作,其他模組只寫事實和提案。主線出問題時,在 `miyoria.toml` 寫:

```toml
[core]
pipeline = "v2"
```

重開 core 就回到舊路徑(回話、Plan、遊戲導演各自決定)。不用改別的設定,`[modules.arbiter.floor]` 和 `[modules.agent.mainline]` 在 V2 下不會被讀。事件日誌在兩邊都會繼續寫。值打錯時 core 不會啟動,錯誤會寫 `core.pipeline`。

V3 下要查一句話的來龍去脈,看事件日誌:`decision`(來源 `mainline`,含沉默的理由)、`utterance`、`delivered`,動作是 `action` 和 `result`(來源 `mainline.hands`,`accepted` 只代表受理)。
