# 幫 Miyoria 架翻唱(sing)worker:給主機提供者的說明

你要做的是把你的顯示卡借給 Owen 的 Core,在你的電腦上跑 **sing worker**(點歌翻唱的 GPU 服務)。你**不需要**跑 Core、Discord bot、ASR、TTS 或任何其他服務,也不需要 Discord token 或 LLM 的金鑰。

```
你的電腦(hostd + sing)  ──主動撥出一條連線──▶  Owen 的 Core
                          ◀── Core 的請求走這條線回來
                          ──▶ 做好的歌(音訊、影片、歌詞資訊)也走這條線
```

**你的電腦不用開任何埠、不用設防火牆、不用告訴 Owen 你的 IP。** 你電腦上的管家(hostd)主動連到 Owen 的 Core;Core 要請 sing 做歌時,請求就走這條已經連好的線回來,做好的歌也從同一條線傳回去。你的電腦只需要連得到 Owen 給你的 Core 位址(兩個:管理 API 和控制連線,見第 3 步)。

worker 做的事:Core 送一個工作,worker 做完(yt-dlp 下載 → 人聲分離 → 切主唱 → RVC 轉成她的聲音 → 混音 → 找歌詞),Core 再把音訊抓回去播。

**還在用舊版(手動跑、固定位址的 worker)?** 看最後一節「還在用舊版的話」。

## 0. 需求

| 項目 | 需求 |
|---|---|
| 系統 | Windows 10/11(專案是照 Windows 做的) |
| 顯示卡 | NVIDIA,建議 8 GB 以上 VRAM(`service.toml` 的估計是約 7.5 GB);轉換階段 PyTorch 峰值約 3.2 GB,分離更高(不夠會自動退到 CPU,但很慢)。要先裝好支援 CUDA 12.8 的 NVIDIA 驅動 |
| 軟體 | Git、Node.js 24 以上、[uv](https://docs.astral.sh/uv/)(`winget install --id=astral-sh.uv -e`)、ffmpeg(要在 PATH,`winget install --id=Gyan.FFmpeg -e`)。Python 不用自己裝:uv 會依 `pyproject.toml` 找或下載 3.11–3.13 |
| 硬碟 | 模型約數 GB,歌曲快取預設最多 6 GB(`SING_CACHE_MAX_GB`) |
| 網路 | 連得到 Owen 的 Core(位址由他給),能連 YouTube(下載用)和 `lrclib.net`(歌詞) |

`miyoria` 套件還沒有發佈到 npm,所以要從 repository 跑:下面的 `miyoria <指令>` 在 repository 裡都寫成 `pnpm dev <指令>`。

## 1. 取得程式碼

```powershell
git clone https://github.com/owenliu0924/Miyoria.git
```

```powershell
cd Miyoria
```

```powershell
node scripts/setup.mjs
```

`setup.mjs` 啟用 pnpm、安裝相依套件,然後接著跑設定精靈(下一步)。整個 `workers/` 資料夾都要用,不能只拿 `workers/sing`。

## 2. 設定這台電腦並安裝 sing

設定精靈(`pnpm dev init`)第一題選第三項:**這台只提供服務給別台的 Core**。它問你要提供哪些服務時,勾 `sing`。這一步只寫 `host.toml`(這台電腦跑什麼),不會建環境。已經跑過 `init` 的話,直接做下一個指令也可以。

```powershell
pnpm dev add sing
```

它做這些事:

- 用 uv 把 `workers/sing/pyproject.toml` 和 `uv.lock` 裝成一個環境(放在 `data/host/envs/sing`),包括 CUDA 12.8 版的 torch。第一次要下載很多東西,要等一陣子;失敗了重新執行同一個指令,做完的會跳過;
- 檢查 ffmpeg 在不在 PATH;
- 下載 `workers/sing/service.toml` 的 `[[install.files]]` 列的公開模型檔:先列出每個檔案的大小、授權和來源,問你一次(`-y` 不問),同意後下載到 `data/host/models/`,SHA-256 對了才留下;
- 列出**要你自己放的東西**。

### 自動下載的和要自己放的

**自動下載的**:只有公開、可以自由下載、`service.toml` 寫了 SHA-256 和固定版本的模型檔。目前是兩個分離模型(下表第 3、4 列的模型檔):`vocal-split/MelBandRoformer.ckpt`(約 913 MB,MIT)、`lead-split/becruily-bs/bs_roformer_karaoke_frazer_becruily.ckpt`(約 204 MB,來源沒有標授權,Owen 決定自動下載)和它的設定檔(1.9 KB)。它們放在 `data/host/models/`,不是 `workers/models/`。

**舊的手動位置繼續有效,不會下載兩次。**worker 先找 `data/host/models/`,沒有就退回 `workers/models/`;所以在 `update` 抓檔案之前,你原本放的檔案照常使用。`update` 看到 `workers/models/` 裡有檔案、大小和 SHA-256 都對,就用**硬連結**把它接到 `data/host/models/`(不下載、不多佔硬碟空間,原本的檔案不動;兩個資料夾在不同磁碟時才會改成複製)。你**不用**刪掉或搬動舊檔案。

**一直要自己放的**:Owen 的聲音資產(下表前兩列,私人的,不會自動下載),和 Seed-VC 原始碼(是程式碼,自動下載只抓模型權重,從不抓會被執行的東西)。

路徑從 repository 根目錄算起。前兩項是 Owen 的聲音資產,**請 Owen 提供**,只放在你的本機,不要上傳或再分享。

| 路徑 | 內容 | 來源 |
|---|---|---|
| `workers/models/applio/` | Applio 原始碼 + 它自己的 `venv/`(RVC 在子程序裡跑)+ 她的 RVC 模型 `logs/miyoria-deepseek-48k/miyoria-deepseek-48k_40e_11000s.pth` | Owen 提供(用別的路徑就設 `SING_APPLIO_DIR` / `SING_RVC_MODEL`) |
| `workers/voices/deepseek-chan/ref.wav`(和 `ref.txt`) | 她的參考音;worker 啟動時會檢查這個檔在不在 | Owen 提供(或設 `SING_REF`) |
| `data/host/models/lead-split/becruily-bs/`(舊位置 `workers/models/lead-split/becruily-bs/`) | 主唱 / 伴唱分離模型 | **自動下載**(Hugging Face `becruily/bs-roformer-karaoke`);沒有就不切主唱 |
| `data/host/models/vocal-split/MelBandRoformer.ckpt`(舊位置 `workers/models/vocal-split/`) | 人聲分離模型 | **自動下載**(Hugging Face `KimberleyJSN/melbandroformer`);沒有就退回 Demucs |
| `workers/models/vocal-split/MelBandRoformer.yaml`(或放在 `data/host/models/vocal-split/`) | 人聲分離模型的設定檔 | **仍然手動**(沒有固定來源):沒有它就退回 Demucs。已經有的話不用動 |
| `workers/models/seed-vc/` | Seed-VC 原始碼(要有 `modules/` 這個資料夾) | github.com/Plachtaa/seed-vc。**不能略過**:worker 啟動時就檢查它在不在,沒有就啟動失敗(`Seed-VC not found at ...`),即使預設轉換鏈 `rvc` 用不到它 |

第一首歌還會自動下載約 2 GB 的其他模型(worker 自己從 Hugging Face 抓的,不經過上面的清單)。檢查還缺什麼(`doctor` 也會驗證已經下載的模型檔的 SHA-256):

```powershell
pnpm dev doctor
```

## 3. 向 Owen 要邀請碼,加入他的 Core

Owen 在他的 Core 那台執行 `miyoria host invite --name <你的名字>`。它印出一組**只能用一次、10 分鐘內有效**的邀請碼,和一整行要你執行的指令。Owen 要先把 Core 的管理 API(`7878`)和控制連線(`7880`)改成你連得到的位址(區網或 Tailscale),做法在 [OPERATIONS.md](OPERATIONS.md) 的「多台電腦」。如果他的 Core 只在 Tailscale 上,他會請你裝 Tailscale 並加入他的 tailnet:這只是讓你的電腦連得到 Core,不是讓 Core 連進你的電腦。

在你的電腦上執行那一行,長得像:

```powershell
pnpm dev host join http://100.64.0.5:7878 --code <邀請碼> --name <你的名字>
```

它把這台電腦的金鑰存在 `data/host/host.key`(**不要傳給別人**;Owen 用 `host remove` 就能讓它失效),並在 `host.toml` 寫下 `[cluster] url`。名字沒給時,依序用 `host.toml` 的 `name`、再用電腦的名字。

然後請 Owen 在他那台核准你:

```powershell
miyoria host approve <你的名字>
```

**核准之前,你的服務不會被使用。**

## 4. 啟動

```powershell
pnpm dev up
```

它在背景啟動你這台的 hostd,再由 hostd 啟動 `sing`,等健康檢查通過才印出結果。hostd 會在 sing 當掉時自己重啟,log 寫在 `data/host/logs/sing.log`。

確認有起來:

```powershell
pnpm dev status          # sing 要是執行中、健康
pnpm dev logs sing -f    # 看 log,Ctrl+C 離開
```

請 Owen 在他那台看 `miyoria host ls`:你的電腦要是「已連線」,核准的能力要有 `sing`。第一首歌要多等一下,因為模型第一次才下載。

**不用再設 `HOST`、`PORT`、`SING_LYRICS_URL` 這些環境變數。**hostd 啟動 worker 時自己給(位址只綁你這台的 `127.0.0.1`,埠 `8005`)。沒有任何東西對外聽。

## 5. 日常

| 要做的事 | 指令 |
|---|---|
| 更新程式 | `pnpm dev update`(拉最新程式、需要時重建環境,一次一個重啟正在跑的服務) |
| 停掉 | `pnpm dev down` |
| 再啟動 | `pnpm dev up` |
| 登入 Windows 時自動啟動 | `pnpm dev host autostart on`(`off` 關掉,`status` 看目前) |
| 看狀態 / log | `pnpm dev status`、`pnpm dev logs sing -f` |
| Owen 從面板幫你更新 | **預設就會**:你的電腦加入 Owen 的 Core 之後,他可以從面板把你這份 checkout 更新到 `origin/main` 上的提交(只快轉;你有沒提交的變更就不動;她在唱歌時會等;不下載模型)。不想讓他更新:在 `host.toml` 加 `[update]` 和 `allow_remote = false`,一分鐘內生效。細節見 [OPERATIONS.md](OPERATIONS.md) 的「從面板更新別台電腦」 |

`update` 不會動到 `workers/models/`、`workers/voices/` 和歌曲快取(`data/songs`):這些不在 git 裡。

### `git pull` 之後(分離模型改成自動下載)

在 repository 根目錄執行:

```powershell
git pull
```

```powershell
pnpm dev update
```

它會依序做這些事,你只要看提示:

1. 同步環境(`uv.lock` 沒變就跳過),需要時重啟正在跑的 sing(忙的話會說「還在忙所以沒有重啟」,等她不忙再執行它列的 `miyoria restart sing`);
2. 列出「要下載的模型檔」。你原本放在 `workers/models/` 的兩個模型檔會寫成「沿用 …(檢查碼相同,硬連結,不用下載)」,**不問、不下載**(讀一次檢查碼,約 1.1 GB,幾秒到十幾秒);
3. 唯一會問你的是 `lead-split/becruily-bs/config_karaoke_frazer_becruily.yaml`(1.9 KB,新檔名,舊的設定檔不是這個名字):「下載這 1 個檔案(共 1.9 KB)?」回答 `y`。授權欄會寫「未標示」,這是 Owen 決定可以自動下載的。要不問就 `pnpm dev update --yes`;
4. 如果你**沒有**舊位置的模型檔,同一個提問會列出三個檔案:約 913 MB + 204 MB + 1.9 KB,共約 1.1 GB,下載後驗證 SHA-256,才放進 `data/host/models/`;磁碟要留約 0.5 GB 的餘裕。

之後不必再做什麼:不用移動檔案、不用改設定,`pnpm dev up` / 既有的 sing 會自己找到新位置或舊位置的檔案。**仍然要自己放的**只有:Applio、`ref.wav`、Seed-VC 原始碼,和人聲分離的設定檔 `MelBandRoformer.yaml`(沒有固定來源;你已經有就不用動)。要看狀況:`pnpm dev doctor`(會驗證 SHA-256),`pnpm dev doctor --fix` 補缺的。

## 6. Owen 這邊怎麼用

你被核准、服務連線之後,Core 自己找得到你的 sing:Owen 不用寫你的位址。

**好幾台都有 sing 時,每首歌送到哪台。**翻唱是「一個一個獨立的工作」(`workers/sing/routing.toml` 的 `class = "job"`)。每點一首歌,Core 替每台算「這首做完並傳回 Core 要多久」:前面還有幾首(你的 sing 的 `/health` 會說正在做和排隊的數量,加上 Core 剛送出、你那台還沒回報的)乘上一首在那台平常要多久,加上這首本身,加上把做好的檔案傳回來的時間(Core 量過你那台的傳輸速度)。最快的那台拿到這首。兩首同時點,會分到兩台閒著的電腦。一首在你那台平常要多久、傳得多快,Core 會記住(重啟也不會忘),在面板「電腦」頁看得到,每首歌為什麼送到哪台也看得到。

`[modules.cluster.order]` 還是有用,但只是「偏好」:排後面一位,分數就多 30 秒(`order_step_secs`),所以前面那台排了好幾首時,歌還是會送到後面那台。

```toml
[modules.cluster.order]
sing = ["你的名字", "他自己那台的名字"]
```

**她的語音所在的電腦不接翻唱。**做歌會把 TTS 和 ASR 擠出顯卡(`yields_to = ["tts", "asr"]`),所以 Core 預設不把歌送到正在跑她語音的那台(通常是 Owen 自己那台)。Owen 可以在 `[modules.cluster.routing]` 改 `allow_on_speech_host`:`"never"`(預設)、`"when_idle"`(她不在語音、沒在直播、而且 10 分鐘沒人說話才可以)、`"always"`(可以,但她在語音或直播時排很後面)。

**連不上時換下一台**:新點的歌先送到分數最好的,連不上(你的電腦關了、斷線)就送下一個。點歌的請求如果已經連上、只是回應逾時,就不換台(那台可能已經收下,換台會兩張顯卡各做一次),照單一 worker 的方式回報錯誤。一首歌在哪台做,之後查進度、抓音軌和影片都找同一台(檔案在那台);那台連不上超過 `[modules.sing] fallback_retry_secs`(預設 30 秒)還是不回,這首歌就在下一台重做,原本那台回來時會取消留在它那邊的工作。連不上的那台這段時間內不再問,之後會再試。只有「連不上」才換台,worker 有回應的錯誤(例如連結的網域不允許)照常回報。

**歌詞。**你的 sing worker 自己找歌詞(lrclib、網易雲)。需要問 LLM(猜這是哪首歌)和 ASR 抽查歌詞時,你的 hostd 請 Owen 的 Core 代跑:用的是 Owen 的模型和金鑰,金鑰不會到你的電腦,每次呼叫記在 Owen 的每日預算和呼叫紀錄裡。所以你**不需要**金鑰,也不用另外跑歌詞服務。

## 你的電腦要符合什麼,Core 能對你的電腦做什麼

**要接翻唱工作,你的電腦要「準備好」。**你的 hostd 自己檢查 `workers/sing/routing.toml` 的 `[needs]`:Seed-VC 原始碼和參考聲音要在、顯卡至少 7.5 GB。缺什麼,hostd 回報「沒準備好」和缺的東西,Core 就不送歌來;補上之後下一次回報就好了,不用重啟。

**你的聲音模型要和別台一樣。**hostd 把她的 RVC 模型檔(`workers/models/applio/logs/miyoria-deepseek-48k/` 裡的 `.pth`)、參考聲音和 `SING_VOICE` 這幾個設定算成一個短的雜湊值(檔案大小加上頭尾各 1 MB 的內容,不會整個讀)回報給 Core。和大多數電腦不同的那台不接歌(唱出來聲音會不一樣),面板會寫出來。你把模型放在別的路徑(`SING_RVC_MODEL`)也會算成不同。

**Core 的主人能做的:**送翻唱工作給你的 sing、查進度、抓做好的檔案(全部走你撥出去的那條連線);在面板把你的電腦釘選、排除、加權或「清空」(做完手上的,不接新的);從面板把你的 checkout 更新到他追蹤的提交(見第 5 節,可以關掉)。

**Core 的主人不能做的:**在你的電腦上執行任何指令、讀你的檔案、下載模型、改你的 `host.toml`、拿到你的金鑰以外的東西。你的服務只聽你電腦本機(除非你自己設 `[network] advertise`,或在 `routes.toml` 開了閘道)。

**讓 Core 有更快的路連到你(選用)。**預設所有東西都走你撥出去的那條連線,最慢但一定通。傳大檔案(影片、做好的歌)想快一點,可以在 `host.toml` 旁邊放一個 `routes.toml`,宣告 Core 還能怎麼連到你:`tunnel`(Cloudflare tunnel 的主機名稱,不用轉發埠,最簡單)、`direct`(公開的位址加轉發的埠,要 https 和一張 Core 信任的憑證)、`tailnet`(你在 Owen 的 tailnet 裡時)。Core 會量每一條,挑快的,一條失敗就換下一條,最後還是那條連線。轉發埠、憑證、`cloudflared` 這些要你自己設;例子和每一種要做什麼寫在 repo 根目錄的 [routes.example.toml](../routes.example.toml),細節在 [v5-hostd.md](design/v5-hostd.md) §16。不管哪一條,Core 都要帶你那個服務的 token 才進得去,而且只進得去你的 worker。改了 `routes.toml` 要 `pnpm dev down` 再 `pnpm dev up`;沒有這個檔案就和現在一樣。

**你自己限制你的電腦接什麼**(寫在你的 `host.toml`,Core 改不了):

```toml
[services.sing]
accept = false        # sing 照樣在跑,但 Core 不送新工作過來
concurrency = 1       # 同時最多幾首(不能比描述檔的多)
```

**先更新,再加這兩行**:比較舊的 hostd 看不懂這兩個設定,會拒絕整個 `host.toml`。舊版的 Core 也看不懂 `accept = false`;要連舊 Core 都不送,改成 `enabled = false`(sing 就不跑),或請 Owen 把 `sing` 從你的核准能力拿掉。完全不想讓他用你的電腦:`pnpm dev down`,或請他 `host remove` 你。

## 7. 已知限制

1. **歌曲影片**:Core 播歌前會從 worker 的 `/songs/{id}/files/video.mp4` 把影片下載到自己的 `data/songs/<id>/`(也走同一條連線),所以 worker 在別台也能放影片。前提是 Core 和 Stage 在同一台(Stage 讀的是 Core 這台的本機路徑)。連線慢時(例如只有不到 1 Mbit/s 的上傳,幾十 MB 的影片唱完都還沒到),在 `[modules.sing]` 設 `video_source = "local"`:Core 自己用 yt-dlp(`ytdlp_path`,轉 mp4 要有 ffmpeg)從歌的連結下載影片,失敗才跟 worker 拿;只有 worker 說有影片的歌才放。
2. **做歌時不會讓 TTS / ASR 讓出顯卡**:你的電腦上沒有它們,所以她說話和做歌不會互相搶 VRAM(反而更好),但也沒有「她先說一句我去準備歌」的流程;若 Core 端還是有這句提示,Owen 可以把 `[modules.sing] prepare_notice = false`。
3. 這個 worker 一次只做一首歌(佇列),你那邊 GPU 被別的程式(遊戲)占住時會變慢。
4. 做歌的細節(GPU 怎麼和別的程式分)見 [workers/README.md](../workers/README.md) 第 9 節。

## 8. 疑難排解

先看 `pnpm dev status` 和 `pnpm dev logs sing -f`。

| 症狀 | 原因 / 處理 |
|---|---|
| `host join` 說代碼無效或過期 | 代碼只能用一次、10 分鐘有效。請 Owen 再 `host invite` 一組 |
| `host join` 連不上 Core | Core 預設只聽本機。請 Owen 把 `[modules.api] bind` 和 `[modules.cluster] bind` 改成你連得到的位址,並確認你的電腦連得到(Tailscale 要在線)。Owen 的 `invite` 發現只聽本機時會提醒 |
| `host join` 說這台已經加入過別的 Core | 先請原來的 Core 的主人 `host remove <名字>`,再加 `--force` |
| `up` 之後 Owen 的 `host ls` 看不到你,或沒有 `sing` | 他還沒 `host approve`;或你的 `up` 沒成功(看 `status`);或這台的 `host.toml` 沒有 `[cluster] url`(重新 `host join`) |
| 啟動時說 reference voice not found | 缺 `workers/voices/deepseek-chan/ref.wav` 或 `SING_REF` |
| 啟動時說 Seed-VC not found | 缺 `workers/models/seed-vc/modules/`(或 `SING_SEEDVC_DIR` 指錯),見第 2 步 |
| 「RVC model or Applio not found」警告 | `workers/models/applio/`(`core.py`、`venv/`、`.pth`)不完整,會退成別的轉換鏈 |
| 找歌卡住 | ffmpeg 不在 PATH、Node 沒裝、`SING_YTDLP_CACHE` 寫不進去 |
| 轉換很慢 | VRAM 不夠退到 CPU,或 GPU 被別的程式占住 |
| 想改 worker 的設定值(快取大小等) | 在 `host.toml` 加 `[services.sing]` 的 `env = { SING_CACHE_MAX_GB = "10" }`,再 `pnpm dev restart sing`。完整清單見 `workers/README.md` 第 9 節 |

## 還在用舊版的話

這是 hostd 之前的做法:手動跑 worker,用固定位址(通常是 Tailscale 位址),Owen 在設定檔寫你的位址。新的做法(上面)不需要這些;能換就換。這一節留給還沒換的人。

**怎麼運作。**你在 PowerShell 手動啟動 worker,綁在你的 Tailscale 位址(`tailscale ip -4`,例如 `100.x.y.z`),Owen 的 Core 從他那邊連到 `http://100.x.y.z:8005`。這種 worker **沒有任何認證**(沒有 hostd 給 token,不檢查),所以:

- 一定要綁在 Tailscale 位址,不要綁 `0.0.0.0`;
- 在 Tailscale ACL 只允許 Owen 的機器連你的 `:8005`;
- Windows 防火牆只放行 Tailscale 網卡(系統管理員 PowerShell):

  ```powershell
  New-NetFirewallRule -DisplayName "miyoria-sing" -Direction Inbound -LocalPort 8005 -Protocol TCP -InterfaceAlias "Tailscale" -Action Allow
  ```

**啟動。**在 `workers\sing`,用 uv 建環境、設環境變數、啟動(環境變數只在這個視窗有效):

```powershell
cd workers\sing
uv sync --frozen
$env:HOST = "100.x.y.z"          # 你的 Tailscale 位址
$env:PORT = "8005"
$env:SING_LYRICS_URL = "http://<Owen 的 Tailscale IP>:8007"   # 歌詞交給 Owen 那邊的歌詞服務(見下)
uv run --frozen python server.py
```

(舊的 `workers\.venv-sing` 虛擬環境還能用:`.\.venv-sing\Scripts\python.exe server.py`。要換成新做法又不想重新下載,在 `host.toml` 寫 `[services.sing]` 的 `python = "<repository>\workers\.venv-sing"`(環境資料夾),hostd 就用那個環境,不會動它;`pnpm dev host migrate` 會從舊的 `[machine]` 設定替你寫。)

`SING_OFFLOAD_URLS` 留空(預設):你的電腦上沒有 TTS / ASR。`SING_LYRICS_ASR=0` = 不做 ASR 抽查,也不會把主唱音軌傳給歌詞服務。啟動後在你的電腦測(輸出有 `"status":"ok"`):

```powershell
curl.exe http://100.x.y.z:8005/health
```

**Owen 那邊。**編輯 `miyoria.toml`:

```toml
[modules.sing]
url = "http://100.x.y.z:8005"               # 你的 Tailscale 位址
fallback_urls = ["http://127.0.0.1:8005"]   # 連不上你的時候,改用 Owen 自己電腦上的 worker
timeout_secs = 20                           # 跨網路建議放寬(拿檔案不看總時間,看 fetch_stall_secs)
```

這兩個位址進入登記處成為「靜態」項目,連不上時換台的規則和第 6 節一樣。也可以用 `[modules.cluster.static.<名字>]` 寫 `provides = ["sing"]` 和 `url`。位址寫法要一致(`localhost` 和 `127.0.0.1` 不算同一個)。然後重啟 Core,在 Owen 的電腦測 `curl.exe http://100.x.y.z:8005/health`。

**歌詞服務(Owen 這邊,舊版才需要)。**你的 worker 不在 hostd 之下、沒有加入 Core 時,不能請 Core 代跑 LLM 和 ASR。所以 Owen 在他的電腦上另外跑歌詞服務,你的 worker 用 `SING_LYRICS_URL` 呼叫它。因為歌詞服務也沒有 hostd,Owen 要手動啟動(在 `workers\lyrics`):

```powershell
cd workers\lyrics
uv sync --frozen
$env:HOST = "100.a.b.c"     # Owen 自己的 Tailscale 位址
$env:PORT = "8007"
$env:SING_LYRICS_LLM_URL = "https://.../v1"   # 歌詞專用的 LLM(OpenAI 相容)
$env:SING_LYRICS_LLM_KEY = "..."
$env:SING_LYRICS_LLM_MODEL = "..."
uv run --frozen python server.py
```

它也沒有認證,一樣只綁 Tailscale 位址並用 ACL 只放行對方的機器。沒設 `SING_LYRICS_LLM_URL` 和 `_MODEL` 就不問 LLM,只用規則找。ASR 抽查預設連 `127.0.0.1:8003`;hostd 啟動的 ASR 會檢查 token,手動跑的歌詞服務沒有 token,會得到 401,所以要抽查就要有手動跑的 ASR(用 `SING_LYRICS_ASR_URL` 指過去),不然設 `SING_LYRICS_ASR=0`。對方傳過來的只有 16 kHz 單聲道的主唱音軌(每分鐘約 2 MB)。歌詞的時間對齊仍在你的 worker(它要讀音訊);歌詞服務沒開時,這首歌沒有字幕,不會放錯的詞。

**舊版的疑難排解**(Tailscale 能 ping 通,但 8005 連不上):在你的電腦依序檢查。

1. worker 有沒有在聽 8005:

   ```powershell
   Get-NetTCPConnection -LocalPort 8005 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, OwningProcess
   ```

   沒有輸出:worker 沒啟動,看視窗裡的錯誤。`LocalAddress` 是 `127.0.0.1`:忘了設 `$env:HOST`。是你的 Tailscale 位址:綁定正確,看下一步(`0.0.0.0` 連得到但違反上面的規則,請改掉)。
2. 用 Tailscale 位址連自己:`Test-NetConnection 100.x.y.z -Port 8005`,`TcpTestSucceeded` 要是 `True`。
3. 防火牆規則:`Get-NetFirewallRule -DisplayName "miyoria-sing"`;沒有就用上面的 `New-NetFirewallRule` 加上,規則裡的 `-InterfaceAlias "Tailscale"` 要和 `Get-NetAdapter` 看到的網卡名稱一樣。
4. Tailscale ACL 有沒有放行 Owen 的機器到你的 `:8005`(管理頁的 Access controls)。從 Owen 的電腦測 `Test-NetConnection 100.x.y.z -Port 8005`。

要停掉舊的 worker:在跑它的視窗按 Ctrl+C;找不到視窗時,用上面第 1 項的指令看是誰在聽 8005,再 `Stop-Process -Id <OwningProcess>`。
