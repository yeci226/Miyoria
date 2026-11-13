# 幫 Miyoria 架翻唱(sing)worker:給主機提供者的說明

你要做的是在你的電腦上跑 **sing worker**(點歌翻唱的 GPU 服務),Owen 的 Core 透過 **Tailscale** 連到你。你**不需要**跑 Core、Discord bot、ASR、TTS 或任何其他服務。

```
Owen 的電腦:Core ──HTTP──▶ Tailscale ──▶ 你的電腦:sing worker(:8005)
                  ◀── 做好的歌(音訊 + 歌詞資訊)
```

Core 送一個工作(`POST /jobs`),worker 做完(yt-dlp 下載 → 人聲分離 → 切主唱 → RVC 轉成她的聲音 → 混音 → 找歌詞),Core 再用 HTTP 把音訊抓回去播。

## 0. 需求

| 項目 | 需求 |
|---|---|
| 系統 | Windows 10/11(專案是照 Windows 做的;Linux 也能跑 worker 本身,但 `miyoria start` 的分頁啟動只支援 Windows Terminal) |
| 顯示卡 | NVIDIA,建議 8 GB 以上 VRAM;轉換階段 PyTorch 峰值約 3.2 GB,分離更高(不夠會自動退到 CPU,但很慢)。要先裝好 NVIDIA 驅動 |
| 軟體 | Git、Python 3.11–3.13、Node.js(yt-dlp 解 YouTube 要用)、ffmpeg(要在 PATH)、Tailscale |
| 硬碟 | 模型約數 GB,歌曲快取預設最多 6 GB(`SING_CACHE_MAX_GB`) |
| 網路 | 能連 YouTube(下載用)、`lrclib.net`(歌詞) |

## 1. 加入 Tailscale

1. 兩台電腦都裝 Tailscale。Owen 邀請你進他的 tailnet,或是你把你的機器分享給他(Tailscale 管理頁 → 機器 → Share)。
2. 在你的電腦查 Tailscale 位址:
   ```bash
   tailscale ip -4        # 100.x.y.z
   ```
3. worker **沒有任何認證**,所以:
   - 把 worker 綁在這個 Tailscale 位址(不要綁 `0.0.0.0`),只有 tailnet 裡的裝置連得到;
   - 在 Tailscale ACL 只允許 Owen 的機器連你的 `:8005`;
   - 不要對外開 Windows 防火牆的 8005,只放行 Tailscale 網卡(如果要加規則:`New-NetFirewallRule -DisplayName "miyoria-sing" -Direction Inbound -LocalPort 8005 -Protocol TCP -InterfaceAlias "Tailscale" -Action Allow`)。

## 2. 取得程式碼

```bash
git clone https://github.com/owenliu0924/miyoria.git
cd miyoria
pnpm install        # 只有要用 miyoria 指令才需要;手動裝 worker 可以略過
```

## 3. 安裝 sing worker(手動,最不容易出錯)

在 `workers/` 底下:

```bash
cd workers
python -m venv .venv-sing
# 先裝 CUDA 版 torch,不然 pip 會抓到 CPU 版
.venv-sing/Scripts/pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128
.venv-sing/Scripts/pip install -r sing/requirements.txt
```

(也可以用 `miyoria init` 選「自訂」只勾 `sing`,再 `miyoria install` / `miyoria doctor` / `miyoria start`,效果相同;細節見 `workers/README.md` 的「快速安裝」。)

## 4. 模型與資料(需要 Owen 提供的部分)

預設轉換鏈是 `SING_VOICE=rvc`,需要下列檔案(放在 `workers/` 底下):

| 路徑 | 內容 | 來源 |
|---|---|---|
| `models/applio/` | Applio 原始碼 + 它自己的 `venv/`(RVC 在子程序裡跑) + 她的 RVC 模型 `logs/miyoria-deepseek-48k/miyoria-deepseek-48k_40e_11000s.pth` | **Owen 提供**(她的聲音模型,不進 git;用別的路徑就設 `SING_APPLIO_DIR` / `SING_RVC_MODEL`) |
| `voices/deepseek-chan/ref.wav`(+ `ref.txt`) | 她的參考音;worker 啟動時會檢查這個檔在不在 | **Owen 提供**(不進 git;或設 `SING_REF`) |
| `models/lead-split/becruily-bs/` | 主唱 / 伴唱分離模型 | Hugging Face `becruily/bs-roformer-karaoke` |
| `models/vocal-split/MelBandRoformer.ckpt` + `.yaml` | 人聲分離 | Hugging Face `KimberleyJSN/melbandroformer`;缺的話退回 Demucs(第一次自動下載) |
| `models/seed-vc/` | Seed-VC 原始碼 | 只有 `seedvc` 轉換鏈用得到,預設可略過 |

第一首歌會自動下載約 2 GB 的模型。她的 RVC 模型和參考音是 Owen 的聲音資產,請只放在你的本機,不要上傳或再分享。

## 5. 設定與啟動

建議在 `workers/sing/` 底下啟動,用環境變數設定(PowerShell):

```powershell
cd workers/sing
$env:HOST = "100.x.y.z"          # 你的 Tailscale 位址(只聽 tailnet)
$env:PORT = "8005"
$env:SING_LYRICS_URL = "http://<Owen 的 Tailscale IP>:8007"   # 歌詞交給 Owen 那邊的歌詞服務(見第 6 節)
../.venv-sing/Scripts/python server.py
```

重點環境變數(完整清單在 `workers/README.md` 第 9 節):

| 變數 | 說明 |
|---|---|
| `HOST` / `PORT` | 綁定位址 / 埠,預設 `127.0.0.1` / `8005`。**一定要改成 Tailscale 位址**,否則 Owen 連不到 |
| `SING_OFFLOAD_URLS` | **留空**。這是做歌時叫 TTS / ASR 讓出顯卡用的,你的電腦上沒有它們 |
| `SING_LYRICS_URL` | Owen 那邊的歌詞服務網址。找歌詞(含問 LLM、ASR 抽查)都在 Owen 那邊做,你不需要金鑰,也不用連 ASR。沒設的話你的 worker 會自己找,但找不到時沒有 LLM 可問 |
| `SING_LYRICS_ASR` | 設 `0` = 不做 ASR 抽查,也不會把主唱音軌傳給歌詞服務 |
| `SING_CACHE_MAX_GB` / `SING_CACHE_MAX_DAYS` | 歌曲快取上限,預設 6 GB / 14 天 |
| `SING_DATA_DIR` | 快取位置,預設 `<repo>/data/songs` |

啟動成功後,**在你的電腦上**先測:

```bash
curl http://100.x.y.z:8005/health
```

## 6. Owen 這邊怎麼接上 Core

Owen 編輯 `miyoria.toml`:

```toml
[modules.sing]
url = "http://100.x.y.z:8005"     # 你的 Tailscale 位址
fallback_urls = ["http://127.0.0.1:8005"]   # 連不上你的時候,改用 Owen 自己電腦上的 worker
timeout_secs = 20                  # 跨網路建議放寬(抓歌的音訊自動乘 10 倍)
```

**連不上時退回 Owen 自己的 worker**(`fallback_urls`,可省略):新點的歌先送到 `url`,連不上(你的電腦關了、不在 tailnet 上)就依序送 `fallback_urls`。點歌的請求如果已經連上、只是回應逾時,就不換台(那台可能已經收下,換台會兩張顯卡各做一次),照單一 worker 的方式回報錯誤。一首歌在哪台做,之後查進度、抓音軌和影片都找同一台(檔案在那台);那台連不上超過 `fallback_retry_secs`(預設 30 秒)還是不回,這首歌就在下一台重做,原本那台回來時會取消留在它那邊的工作。連不上的那台這段時間內不再問,之後會再試,回來了新點的歌就又送回去。只有「連不上」才換台,worker 有回應的錯誤(例如連結的網域不允許)照常回報。同一個位址在 `url` 和 `fallback_urls` 重複寫只算一次。Owen 的電腦上要有在跑的 sing worker(`miyoria up` / `start` 的 inference 角色會啟動它;平常不佔顯卡)。

然後重啟 Core。在 Owen 的電腦測:

```bash
curl http://100.x.y.z:8005/health
curl -X POST http://100.x.y.z:8005/jobs -H "content-type: application/json" -d '{"query":"Cartoon On & On NCS"}'
curl http://100.x.y.z:8005/jobs/<id>     # state / stage / progress
```

**歌詞服務(Owen 這邊也要啟動)**:找歌詞要用 Owen 的 LLM 設定和 ASR,所以跑在 Owen 的電腦上,對方的 worker 透過 `SING_LYRICS_URL` 呼叫它。啟動(Owen 的電腦,在 `workers/` 底下):

```powershell
python -m venv .venv-lyrics
.venv-lyrics/Scripts/pip install -r lyrics/requirements.txt
$env:HOST = "100.a.b.c"     # Owen 自己的 Tailscale 位址
$env:PORT = "8007"
cd lyrics; ../.venv-lyrics/Scripts/python server.py
```

它沒有認證,一樣只綁 Tailscale 位址並用 ACL 只放行對方的機器。ASR 抽查預設連 `127.0.0.1:8003`(Owen 本機的 ASR),不用另外設定。對方傳過來的只有 16 kHz 單聲道的主唱音軌(每分鐘約 2 MB)。

注意:**不要**用 `miyoria init` 的 `[machine.hosts] inference` 去指到你的機器。那個欄位是「asr / tts / sing 同一台」的單一位址,會連 `ASR_URL` / `TTS_URL` 也一起改過去,但你這台沒有 ASR / TTS。直接手動改 `[modules.sing] url` 就好。

## 7. 已知限制(程式目前沒處理)

1. **歌曲影片**:Core 播歌前會從 worker 的 `/songs/{id}/files/video.mp4` 把影片下載到自己的 `data/songs/<id>/`,所以 worker 在別台也能放影片。前提是 Core 和 Stage 在同一台(Stage 讀的是 Core 這台的本機路徑)。
2. **歌詞對齊仍在對方的 worker**:歌詞服務只負責找歌詞和驗證,拿到歌詞後的時間對齊要讀音訊,在 worker 做。歌詞服務沒開時,這首歌沒有字幕,不會放錯的詞。
3. **做歌時不會再讓 TTS / ASR 讓出顯卡**:因為 worker 不在同一台,她說話和做歌不會互相搶 VRAM(反而更好),但也沒有「她先說一句我去準備歌」的流程;若 Core 端還是有這句提示,可以把 `[modules.sing] prepare_notice = false`。
4. **沒有認證**:全靠 Tailscale 隔離,請照第 1 節設 ACL / 綁定位址。
5. 這個 worker 一次只做一首歌(佇列),你那邊 GPU 被別的程式(遊戲)占住時會變慢。

## 8. 疑難排解

| 症狀 | 檢查 |
|---|---|
| Owen 連不到 | `tailscale ping`、`HOST` 是否設成 Tailscale 位址、防火牆 / ACL |
| 啟動時說 reference voice not found | 缺 `voices/deepseek-chan/ref.wav` 或 `SING_REF` |
| 「RVC model or Applio not found」警告 | `models/applio/`(`core.py`、`venv/`、`.pth`)不完整,會退成別的轉換鏈 |
| 找歌卡住 | ffmpeg 不在 PATH、Node 沒裝、`SING_YTDLP_CACHE` 寫不進去 |
| 轉換很慢 | VRAM 不夠退到 CPU,或 GPU 被別的程式占住 |
