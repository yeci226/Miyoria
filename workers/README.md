# Miyoria 推論 Worker(ASR / TTS / 唱歌)

`@miyoria/speech` 的 `http-worker` provider 對應的 GPU 推論服務。協定在 [`docs/protocols/voice-link.md`](../docs/protocols/voice-link.md)「推論 Worker HTTP 介面」,這裡的三個服務都照那份契約實作。

| 目錄 | 服務 | 預設埠 | 說明 |
|---|---|---|---|
| `asr/` | `POST /asr`、`GET /health` | 8001 | `ASR_BACKEND=sensevoice`(sherpa-onnx,CPU,附情緒 / 事件標記)或 `qwen3`(Qwen3-ASR,GPU) |
| `tts/` | `POST /tts`、`GET /health`、`GET /voices`、`POST /voices/reload` | 8002 | Qwen3-TTS,聲音由 `VOICES_DIR` 註冊;後端 `faster-qwen3-tts`(真串流,推薦)或官方 `qwen-tts`(句子級,備案) |
| `sing/` | `POST /jobs`、`GET /jobs/{id}`、`GET /songs`、`GET /songs/{id}/files/{name}`、`GET /library`、`GET /health` | 8005 | 點歌翻唱:yt-dlp / 本機歌庫 → Demucs 人聲分離 → Seed-VC 歌聲轉換(她的聲音)→ 混音 + lrclib 歌詞;見第 9 節 |
| `fake/` | 兩個端點都有 | 8000 | 不需要 GPU 的假 worker(固定文字 / 正弦波「聲音」),用來做端對端測試 |
| `tests/` | pytest | | 契約測試(預設打 fake,也可以打真的 worker) |

```
workers/
├── asr/   server.py  tags.py  requirements*.txt  Dockerfile
├── tts/   server.py  text_split.py  design_voice.py  requirements.txt  requirements-faster.txt  Dockerfile
├── sing/  server.py  engine.py  seedvc_runtime.py  songs.py  lyrics.py  requirements.txt
├── fake/  fake_server.py  requirements.txt
├── tests/ conftest.py  test_contract.py  test_text_split.py  test_asr_tags.py  test_tts_backends.py  test_sing.py
├── voices/   # 你的聲音:<name>/ref.wav + ref.txt(不進 git)
├── models/   # SenseVoice 模型目錄、seed-vc/ 原始碼與權重(不進 git)
└── docker-compose.yml
```

ASR / TTS 的輸出入都是「原始模型文字」:繁簡轉換(OpenCC `s2tw`)由 Core 端(`opencc-js`)負責,worker 不做。

---

## 0. 先用 fake worker 跑通整條線(不需要 GPU)

```bash
cd workers
python -m venv .venv
.venv/Scripts/pip install -r fake/requirements.txt      # Windows;WSL / Linux 用 .venv/bin/pip
.venv/Scripts/python fake/fake_server.py                 # http://127.0.0.1:8000(PORT=9000 可改埠)
```

把 ASR 和 TTS 的 `url` 都指到 `http://127.0.0.1:8000` 就能測 Miyoria 的語音管線。fake 的行為:

- `/asr`:回固定文字(環境變數 `FAKE_ASR_TEXT` 可改),`duration_ms` 是上傳音檔的真實長度。
- `/tts`:每個非空白字元 60 ms 的正弦波(音高由字決定、`emotion` 會改變音高),24 kHz,每句串流一次。可用聲音 `deepseek-chan`、`default`(`FAKE_VOICES` 可改);`FAKE_TTS_DELAY_MS=300` 模擬合成延遲。

跑測試(只需 fastapi / httpx / pytest):

```bash
cd workers
.venv/Scripts/python -m pytest                     # 37 個測試,打 in-process 的 fake

# 用同一份契約測試檢查「真的」worker:
WORKER_ASR_URL=http://127.0.0.1:8001 WORKER_TTS_URL=http://127.0.0.1:8002 \
  .venv/Scripts/python -m pytest tests/test_contract.py
```

---

## 1. 環境:原生 Windows vs WSL2 / Docker

| | 原生 Windows | WSL2 / Docker(建議) |
|---|---|---|
| SenseVoice(sherpa-onnx,CPU) | 沒問題 | 沒問題 |
| Qwen3-ASR(transformers) | 可以跑,用 SDPA | 可用 FlashAttention 2 |
| Qwen3-ASR(vLLM 後端,唯一支援串流 ASR) | 不能 | 可以 |
| Qwen3-TTS(faster-qwen3-tts,真串流) | **推薦**,用 SDPA | 可以 |
| Qwen3-TTS(官方 `qwen-tts`,句子級) | 可以跑,用 SDPA(VRAM 多一些、可能慢一些) | 可用 FlashAttention 2 |
| Qwen3-TTS(vLLM-Omni,真串流) | 不能 | 可以 |
| FlashAttention 2 | 幾乎裝不起來 | 可以(要編譯,見下) |

WSL2 的 CUDA 用 Windows 的 NVIDIA 驅動,**WSL 裡不要另外裝顯卡驅動**。模型和聲音檔請放在 WSL 的 Linux 檔案系統(`~/miyoria/...`),不要從 `/mnt/c/...` 讀(I/O 很慢)。

### 1a. 原生(Windows 或 WSL2 都適用)

Python 3.11+(`tts/design_voice.py` 用到 `tomllib`)。Windows 把 `bin` 換成 `Scripts`。

**ASR — SenseVoice(CPU)**

```bash
cd workers
python -m venv .venv-asr && .venv-asr/bin/pip install -r asr/requirements-sensevoice.txt

# 下載模型(約 1 GB 壓縮檔,內含 fp32 + int8;int8 約 230 MB)
mkdir -p models && cd models
curl -LO https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2
tar xf sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17.tar.bz2 && cd ..

cd asr
ASR_BACKEND=sensevoice \
ASR_MODEL=../models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17 \
  ../.venv-asr/bin/python server.py                     # http://127.0.0.1:8001
```

**ASR — Qwen3-ASR(GPU)**

```bash
python -m venv .venv-asr-qwen
.venv-asr-qwen/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128   # 一定要先裝 CUDA 版
.venv-asr-qwen/bin/pip install -r asr/requirements-qwen3.txt
# WSL2 可選:  pip install -U flash-attn --no-build-isolation   /   pip install -U "qwen-asr[vllm]"

cd asr
ASR_BACKEND=qwen3 ASR_QWEN_SIZE=0.6B ../.venv-asr-qwen/bin/python server.py   # 第一次會自動下載約 2 GB
# 本機模型:ASR_MODEL=/path/to/Qwen3-ASR-0.6B ;vLLM:ASR_QWEN_BACKEND=vllm ASR_VLLM_GPU_MEM=0.25
```

**TTS — Qwen3-TTS(faster-qwen3-tts,推薦,真串流)**

原生 Windows 的完整步驟(PowerShell)見第 3 節;Linux / WSL2 / Git Bash 版:

```bash
python -m venv .venv-tts-faster          # 獨立 venv:faster-qwen3-tts 的 qwen-tts-hf 會和官方 qwen-tts 衝突
.venv-tts-faster/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128   # 先裝 CUDA 版(Windows 用 Scripts)
.venv-tts-faster/bin/pip install -r tts/requirements-faster.txt

cd tts
VOICES_DIR=../voices TTS_DEFAULT_VOICE=deepseek-chan ../.venv-tts-faster/bin/python server.py   # http://127.0.0.1:8002
# 第一次會自動下載 Qwen/Qwen3-TTS-12Hz-1.7B-Base(約 4–5 GB);小一點:TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-Base
# 首包延遲 / 斷音的取捨:TTS_CHUNK_SIZE(預設 4 ≈ 333 ms,8 ≈ 667 ms),見第 3 節
```

**TTS — Qwen3-TTS(官方 `qwen-tts`,句子級串流,最後備案)**

```bash
python -m venv .venv-tts                 # 不要和 .venv-tts-faster 共用
.venv-tts/bin/pip install torch --index-url https://download.pytorch.org/whl/cu128
.venv-tts/bin/pip install -r tts/requirements.txt
# WSL2 可選:  MAX_JOBS=4 pip install -U flash-attn --no-build-isolation

cd tts
TTS_BACKEND=qwen-tts VOICES_DIR=../voices TTS_DEFAULT_VOICE=deepseek-chan ../.venv-tts/bin/python server.py   # http://127.0.0.1:8002
```

啟動時會一次載入模型(faster:另外捕捉 CUDA graph)、把 `VOICES_DIR` 底下每個聲音建好 clone prompt、再暖機合成一句(同時確定輸出取樣率)。Log 看到 `TTS backend: …` 和 `voices: deepseek-chan` 才算就緒;`/health` 的 `backend` / `streaming` 也會告訴你實際用的是哪個後端。

### 1b. Docker Compose

需要 Docker Desktop(WSL2 backend)+ NVIDIA 驅動。

```bash
cd workers
# SenseVoice 的模型照 1a 下載到 ./models/ ,然後:
docker compose up --build                              # asr(sensevoice) + tts
ASR_BACKEND=qwen3 docker compose up --build            # 換成 Qwen3-ASR(也可寫進 workers/.env)
```

- `asr` → `127.0.0.1:8001`,`tts` → `127.0.0.1:8002`,**只綁 loopback**(worker 沒有認證,不要對外開)。
- 兩個服務都保留 GPU 0;映像用 CUDA 12.8 runtime 基底、非 root 使用者(uid 10001)。
- Volume:`./models`(唯讀)→ `/models`、`./voices` → `/voices`、`../profiles`(唯讀)→ `/profiles`、`hf-cache` 存 Hugging Face 下載(重建映像不用重抓)。
- 每個後端要各自 build(`ASR_BACKEND` 是 build arg;映像 tag 是 `miyoria-asr:<backend>`)。
- TTS 後端:預設 build 官方 `qwen-tts`(句子級)。要 faster-qwen3-tts(真串流):`TTS_REQUIREMENTS=requirements-faster.txt docker compose build tts`(兩個套件互相衝突,一個映像只裝一個;worker 依裝了誰自動選,`TTS_BACKEND`、`TTS_CHUNK_SIZE` 也會傳進容器)。
- FlashAttention 2:`TTS_BASE_IMAGE=nvidia/cuda:12.8.1-cudnn-devel-ubuntu24.04 TTS_FLASH_ATTN=1 docker compose build tts`(要 nvcc,編譯很久;不開就自動用 SDPA)。ASR 同理 `ASR_FLASH_ATTN=1`(Dockerfile 的 `BASE` 要換成 devel)。
- 映像尚未在這台機器上實際 build 過(沒有下載任何依賴);第一次 build 如果 pip 版本衝突,以 `qwen-asr` / `qwen-tts` 上游說明為準調整 `requirements*.txt`。

---

## 2. VRAM 預期(4070 SUPER 12 GB)

> **這些是依模型大小估的數字,還沒實測。**實測請用 `spikes/speech-bench`(在開著遊戲 + OBS 的狀態下量),worker 的 `/health` 也會回報 `vram_allocated_mb`(僅 PyTorch 配置的部分)。

| 元件 | 權重 | 實際約佔 | 備註 |
|---|---|---|---|
| ASR SenseVoice-Small int8 | 約 230 MB | **GPU 0**,RAM 約 0.5–1 GB | CPU 跑;延遲看 `ASR_THREADS` |
| ASR Qwen3-ASR-0.6B(transformers, bf16) | 約 1.2–2 GB | 約 2–3 GB | |
| ASR Qwen3-ASR-1.7B | 約 3.5–4.5 GB | 約 5–6 GB | 0.6B 不夠準才考慮 |
| ASR Qwen3-ASR(vLLM) | | 預先配置 `ASR_VLLM_GPU_MEM` × 全卡(預設 0.25 ≈ 3 GB) | 不吃遊戲的餘裕,先算好比例 |
| TTS Qwen3-TTS-1.7B-Base(bf16) | 約 4–5 GB | 約 5–7 GB | 長句 / 同時多個請求會再多 |
| TTS Qwen3-TTS-0.6B-Base | 約 2 GB | 約 3–4 GB | 品質要實測 |
| `design_voice.py`(1.7B VoiceDesign) | 約 4–5 GB | 約 5–7 GB | **只在挑聲音時跑**;跑之前先停 TTS worker |
| 唱歌 `sing/`(Demucs htdemucs + Seed-VC 44 kHz 歌聲模型) | 約 1 GB | **實測峰值約 3.2 GB**,只在做歌時 | 一次一首、每階段用完就釋放,閒置時 0;分離 OOM 時自動改用 CPU |

DECISIONS 的預算:遊戲 + OBS baseline + ASR + TTS ≤ 約 11 GB。1.7B TTS + Qwen3-ASR-0.6B 大約 8–10 GB,遊戲很吃 VRAM 時改用 SenseVoice(CPU)或 TTS 0.6B。

---

## 3. TTS 的串流模式與 `instruct`(務必看)

### 推薦(原生 Windows):faster-qwen3-tts —— 真串流,`tts/` worker 的預設後端

官方 `qwen-tts` 套件沒有串流 API,所以另一個社群套件 **[faster-qwen3-tts](https://pypi.org/project/faster-qwen3-tts/)**(CUDA graph 加速,`generate_voice_clone_streaming()` 每產生 `chunk_size` 個 codec step 就吐一段音訊)是目前**原生 Windows 上最簡單的真串流路線**:不需要 WSL2 / Docker / vLLM。`tts/server.py` 在偵測到它可以 import 時就自動用它(`TTS_BACKEND=auto`,預設);HTTP 介面(`POST /tts` 串流 PCM)完全不變,Miyoria 端照第 5 節設定 `kind = "http-worker"` 即可。

**安裝(原生 Windows,獨立 venv)**

> faster-qwen3-tts 依賴 `qwen-tts-hf`,它和官方 `qwen-tts` 提供**同名的 `qwen_tts` 模組**,兩個裝在一起會互相覆蓋。所以一定要用**自己的 venv**、**不要**裝 `tts/requirements.txt`。

```powershell
cd workers
python -m venv .venv-tts-faster
# 先裝 CUDA 版 PyTorch(版本對照你的驅動,cu124 / cu126 / cu128 …;不先裝的話 pip 會抓到 CPU 版)
.venv-tts-faster\Scripts\pip install torch --index-url https://download.pytorch.org/whl/cu124
.venv-tts-faster\Scripts\pip install -r tts\requirements-faster.txt

cd tts
$env:VOICES_DIR = "..\voices"; $env:TTS_DEFAULT_VOICE = "deepseek-chan"
..\.venv-tts-faster\Scripts\python server.py          # http://127.0.0.1:8002
```

(Git Bash:`.venv-tts-faster/Scripts/pip …`,環境變數用 `VOICES_DIR=../voices … python server.py`。)第一次啟動會下載 `Qwen/Qwen3-TTS-12Hz-1.7B-Base`(約 4–5 GB)、捕捉 CUDA graph、替每個聲音各跑一次短合成(建立 clone prompt 快取並確定取樣率),所以啟動比較久;log 出現 `TTS backend: faster`、`voices: deepseek-chan` 才算就緒。`/health` 會回 `"backend":"faster","streaming":true,"chunk_size":4`。

**環境變數**(其餘共通的見 `tts/server.py` 開頭)

| 變數 | 預設 | 說明 |
|---|---|---|
| `TTS_BACKEND` | `auto` | `auto` = `faster_qwen3_tts` 可 import 就用 faster,否則退回 `qwen-tts`;也可強制 `faster` / `qwen-tts`(選擇結果會寫進 log 和 `/health`) |
| `TTS_CHUNK_SIZE` | `4` | 每個串流 chunk 的 codec step 數。**12 step = 1 秒音訊**,所以 4 ≈ 333 ms、8 ≈ 667 ms(套件文件的例子)、12 = 1 s。越小,第一個 chunk 越早出來,但每秒音訊要做更多次 codec 解碼、對 GPU 被遊戲搶佔的容忍度也較低(來不及就會斷音);越大越穩、單次 chunk 較長。**預設 4 是為了壓低首包延遲,尚未在這台機器上實測**,聽到斷音就調大到 8 |
| `TTS_WARMUP_PREFILL` | `100` | 捕捉 CUDA graph 時假設的 prompt 長度(套件 README 的範例值) |
| `TTS_MODEL` | `Qwen/Qwen3-TTS-12Hz-1.7B-Base` | 想省 VRAM 用 `…-0.6B-Base` |
| `TTS_ATTN` | `auto` | 有 `flash_attn` 就用,否則 `sdpa`(Windows 上就是 SDPA,不用裝 flash-attn) |

**運作方式**

1. 長文字仍用 `text_split.py` 切句(`TTS_MIN_SENTENCE_CHARS` / `TTS_MAX_SENTENCE_CHARS`),**一句接一句串流,每一句再一個 chunk 一個 chunk 地送**;每個 chunk 一出來就轉成 s16le PCM(float / ndarray / tensor → clip → int16)寫到 socket。
2. 取樣率(`X-Sample-Rate`)取自**第一個 chunk 的 `sr`**:worker 先開始生成、等到第一個 chunk 才建立回應,所以第一個 chunk 之前的失敗會回正常的 4xx/5xx JSON。`X-Tts-First-Audio-Ms` 是「收到請求 → 第一個 chunk 可送」的實測毫秒數,`X-Tts-Streaming: chunk`。
3. 生成在 worker 執行緒裡跑,透過 `asyncio.Queue` 交給回應串流;**client 斷線就停止生成**(在 chunk 之間檢查,正在 GPU 上的那一個 chunk 會跑完再丟棄)。同一把 GPU 鎖以「句」為單位持有,同時兩個請求會在句子邊界交錯。
4. 串流中途失敗會中斷 chunked 連線(client 看到錯誤,而不是把截斷的音訊當完整)。
5. 聲音:Base 模型每次呼叫都傳 `ref.wav` 路徑 + `ref.txt` 內容,套件會依 (路徑, 文字) 快取 clone prompt;worker 啟動 / `POST /voices/reload` 時各跑一次短合成把快取暖好。沒有 `ref.txt` 的聲音走 `xvec_only`(只用 speaker embedding,品質較差)。
6. CustomVoice / VoiceDesign 模型:套件原始碼(0.5.4)有 `generate_custom_voice_streaming` / `generate_voice_design_streaming`,worker 也用它們串流(語意見下面 `instruct` 一節);如果安裝的版本沒有對應的串流方法,該模式自動退回整句 `generate_*`(`/health` 的 `streaming` 會變 `false`)。這兩個模式**還沒用真的模型跑過**。

**預期延遲(必須自己量)**:faster-qwen3-tts 的 README 在 **RTX 4060(Windows)** 上量到 1.7B 模型 **首包(TTFA)約 460 ms、RTF 1.83**(RTF > 1 = 比即時快)。4070 SUPER 規格較高,**預期會好一點**,但這只是參考、不是這台機器的量測值:實際請看回應標頭 `X-Tts-First-Audio-Ms`(見第 6 節 curl),並在開著遊戲 + OBS 的狀態下量。另外 worker 本身會多一點執行緒 / 佇列的開銷,而且我們預設的 `chunk_size=4` 比該 benchmark 小(benchmark 用的 chunk 大小請以套件 README 為準),所以數字不能直接套用。

**另一種接法:faster-qwen3-tts 自帶的 OpenAI 相容伺服器**。該專案 repo 裡有 `examples/openai_server.py`(不在 PyPI 套件內,要 clone repo 取得;用法以它自己的 README 為準),提供 OpenAI 風格的 `/v1/audio/speech`。這樣就**不需要這個資料夾的 tts worker**,Miyoria 用 `kind = "openai"` 直接接(`OpenAiTts` 會要 `pcm` 並串流讀取):

```toml
[speech.tts.fq]
kind = "openai"
base_url = "http://127.0.0.1:8000/v1"   # 以該伺服器實際埠為準
model = "qwen3-tts"                      # 照該伺服器接受的名稱
voice = "deepseek-chan"                  # 該伺服器怎麼註冊聲音,以它的文件為準
```

(這條接法我們這邊沒有測過。代價:沒有這個 worker 的切句、`/voices/reload`、`X-Tts-First-Audio-Ms`、`instruct` 轉送等行為,聲音註冊也要照它自己的方式。)

### 備案 A:用 vLLM-Omni 跑 Qwen3-TTS(WSL2 / Docker)

[vLLM-Omni](https://docs.vllm.ai/projects/vllm-omni/en/latest/serving/speech_api/) 把 Qwen3-TTS 拆成 Talker → Code2Wav 兩段,每解出一小段 codec 就送出音訊,不必等整句。vLLM 團隊在 H20 上量到單一請求首包約 70 ms(4070 SUPER 會慢一些,要自己量)。Miyoria 用 `kind = "vllm-omni"` 直接接它的 OpenAI 相容 `/v1/audio/speech`(`stream_format = "audio"`),**不需要這個資料夾的 tts worker**。vLLM **不支援原生 Windows**,所以只在你已經有 WSL2 / Docker 環境、或想要 vLLM 的並行批次能力時才選這條。

1. 在 **WSL2 或 Docker** 依 vLLM-Omni 官方文件安裝。
2. 啟動 Base 模型(聲音複製):
   ```bash
   vllm serve Qwen/Qwen3-TTS-12Hz-1.7B-Base        --deploy-config vllm_omni/deploy/qwen3_tts.yaml        --omni --port 8091 --trust-remote-code
   ```
   12 GB 要和遊戲、ASR 共用,記得照 vLLM-Omni 的「GPU Memory Calculation and Configuration」文件調低記憶體用量;放不下就先試 0.6B。
3. 用下面第 4 節的 `design_voice.py` 設計並挑好聲音後,上傳成具名聲音:
   ```bash
   python tts/upload_voice.py --url http://127.0.0.1:8091 --voices-dir voices --name deepseek-chan
   ```
4. `miyoria.toml`:
   ```toml
   [speech.tts.qwen]
   kind = "vllm-omni"
   base_url = "http://127.0.0.1:8091/v1"
   voice = "deepseek-chan"
   language = "Chinese"
   ```
   想用文字指令控制情緒(`[emotion.instruct]`)要改用 CustomVoice / VoiceDesign 模型並加 `instructions = true`;Base 複製出來的聲音會忽略指令。

### 最後備案:官方 `qwen-tts` 後端的串流是**句子級**(不是真串流)

faster-qwen3-tts 裝不起來、或不想用社群套件時,`tts/requirements.txt`(官方 `qwen-tts`;**另開 venv,別和 faster 混裝**)會讓 worker 自動退回這個後端(也可以 `TTS_BACKEND=qwen-tts` 強制)。`qwen-tts` 套件(2026-11-01 查)**沒有文件化的串流 API**,只有整段的 `generate_*`。所以 worker 這樣做:

1. 用 `。！？!?…` 和換行把文字切句(`tts/text_split.py`;太短的合併、超過 80 字的在逗號處切;`TTS_MIN_SENTENCE_CHARS` / `TTS_MAX_SENTENCE_CHARS` 可調)。
2. 第一句合成完就開始回傳 PCM;回傳的同時已經在合成下一句,所以只要 RTF < 1,後面的句子不會斷。
3. **首包延遲 = 第一句的整句合成時間**,不是官方宣稱的 97 ms。`X-Tts-First-Audio-Ms` 會告訴你實測值;Core 端「第一句先出聲」(R4)就靠這個。想壓低首包就讓 LLM 的第一句短一點。回應標頭 `X-Tts-Streaming: sentence`,`/health` 的 `"streaming": false`。
4. 啟動時會掃描安裝的 `qwen-tts` 有沒有 `stream` 相關方法,記錄在 log 和 `/health` 的 `stream_probe`,**但不會自動使用**(沒驗證過就不敢用)。
5. 第一句失敗會回正常的 4xx/5xx JSON;串流中途失敗會中斷 chunked 連線。
6. 所有 GPU 呼叫用同一把鎖序列化(以句為單位);client 斷線後最多浪費一句已經在跑的合成。

### `instruct` / `emotion`

只有支援指令控制的模型才吃 `instruct`(DECISIONS「TTS 選型」):

| `TTS_MODEL` | mode | `voice` | `instruct` / `emotion` |
|---|---|---|---|
| `…-Base`(預設) | `clone` | `VOICES_DIR` 裡的聲音名稱 | **忽略**(情緒只能靠文字語意) |
| `…-CustomVoice` | `custom_voice` | 內建 speaker 名稱 | 套用 `instruct` |
| `…-VoiceDesign` | `voice_design` | 選填;聲音目錄裡的 `instruct.txt` 當基底描述 | `instruct` 接在基底描述後面 |

`emotion` 欄位只是資訊;Miyoria 送來的 `instruct` 已經是 `voice.toml` `[emotion.instruct]` 對應好的指令,worker 不再自己查表。`/health` 的 `instruct_supported` 會告訴 Core 目前的模型吃不吃。`custom_voice` 和 `voice_design` 兩個模式**還沒用真的模型跑過**(只有 clone 路徑有照 spike 寫法)。

---

## 4. 設計 / 挑選 DeepSeek-chan 的聲音

流程:VoiceDesign 依文字描述生出幾個候選 → 你聽、挑一個 → 固定成 clone 的參考音(`VOICES_DIR/deepseek-chan/ref.wav` + `ref.txt`)→ TTS worker 用 Base 模型複製它。描述寫在 `profiles/deepseek-chan/voice.toml` 的 `[design]`(`instruct`、`sample_text`、`language`),想調音色就改那裡。

```bash
cd workers/tts          # 用 .venv-tts 或 .venv-tts-faster(後者的 qwen_tts 來自 qwen-tts-hf,未實測);跑之前先停 TTS worker(VRAM)
../.venv-tts/bin/python design_voice.py generate deepseek-chan --n 8
#   → workers/voices/deepseek-chan-candidates/cand_00_seed1000.wav … + 同名 .txt(= sample_text)+ manifest.json
#   8 個聽起來一樣?加  --gen-kwargs '{"do_sample": true, "temperature": 0.9, "top_p": 0.95}'
#   想換 seed 範圍:--seed 2000;臨時改描述:--instruct "..." --text "..."

# 聽完挑第 3 個(複製成 voices/deepseek-chan/ref.wav + ref.txt)
../.venv-tts/bin/python design_voice.py pick deepseek-chan 3
# 也可以自己複製兩個檔案(ref.txt 必須是 ref.wav 實際說的內容,pick 會用候選的 .txt)

curl -X POST http://127.0.0.1:8002/voices/reload        # 已在跑的 worker 不用重啟
```

- 預設路徑:`--profiles-dir` = repo 的 `profiles/`(環境變數 `PROFILES_DIR`),`--voices-dir` = `workers/voices`(`VOICES_DIR`)。Docker 內:`docker compose run --rm tts python design_voice.py generate deepseek-chan`(compose 已掛 `/profiles` 和 `/voices`)。
- 評分建議:中日混說(「baka!」「うるさい」)自不自然、音色是否清亮偏高又帶點傲氣、clone 之後跟候選聽起來是否一致。
- 挑好之後 `voices/deepseek-chan/ref.wav` 約 3–10 秒、乾淨無背景音就夠。**`voices/` 在 git 之外**(`workers/.gitignore`);repo 根目錄 `.gitignore` 目前忽略的是 `profiles/*/voice/*.wav`,之後若要把參考音放進 profile,記得確認它不會被誤提交。
- 沒有 `ref.txt` 的聲音會退回只用 speaker embedding(`x_vector_only_mode`),品質較差,啟動 log 會警告。

---

## 5. 接上 Miyoria

在 Miyoria 設定檔的 `[speech]` 區段:

```toml
[speech.asr.local]
kind = "http-worker"
url = "http://127.0.0.1:8001"
# timeout_secs = 20            # 選填

[speech.tts.local]
kind = "http-worker"
url = "http://127.0.0.1:8002"
voice = "deepseek-chan"        # 預設聲音;請求沒指定 voice 時用
# timeout_secs = 30            # 串流的閒置逾時;冷啟動的第一句可能要幾秒,別設太小

[speech]
asr_chain = ["local"]
tts_chain = ["local"]
```

沒有 GPU 時,把兩個 `url` 都改成 `http://127.0.0.1:8000` 指向 fake worker。

---

## 6. curl 冒煙測試

> Windows 的 Git Bash / PowerShell 用 `curl` 直接塞中文 JSON 可能因為編碼出錯(`There was an error parsing the body`)。**在 Windows 上請把 JSON 寫進 UTF-8 檔案,用 `--data-binary @req.json`**;WSL / Linux 可以直接內嵌。

**健康檢查**

```bash
curl -s http://127.0.0.1:8001/health      # {"status":"ok","model":"...","device":"cpu","backend":"sensevoice"}
curl -s http://127.0.0.1:8002/health      # {"status":"ok","model":"Qwen/Qwen3-TTS-...","backend":"faster","mode":"clone","sample_rate":24000,"streaming":true,"chunk_size":4,...}
curl -s http://127.0.0.1:8002/voices
```

**TTS**(先做,產生音檔再給 ASR 用)

```bash
cat > req.json <<'EOF'
{"text":"哼,你終於來了喔?我才、才沒有在等你呢。好啦,今天要做什麼?",
 "language":"Chinese","emotion":"embarrassed","voice":"deepseek-chan"}
EOF
curl -sS -D - -X POST http://127.0.0.1:8002/tts -H 'Content-Type: application/json' \
     --data-binary @req.json -o out.pcm
# 預期標頭:HTTP 200、content-type: audio/L16; rate=24000; channels=1、x-sample-rate: 24000、
#          transfer-encoding: chunked、x-tts-streaming: chunk(faster)或 sentence(qwen-tts)、
#          x-tts-first-audio-ms: <首包延遲:faster = 第一個 chunk,qwen-tts = 第一句整句>

# PCM 轉 WAV 來聽(任選一個)
ffmpeg -f s16le -ar 24000 -ac 1 -i out.pcm out.wav
python -c "import wave;w=wave.open('out.wav','wb');w.setnchannels(1);w.setsampwidth(2);w.setframerate(24000);w.writeframes(open('out.pcm','rb').read())"
```

**ASR**

```bash
curl -sS -X POST http://127.0.0.1:8001/asr -F "audio=@out.wav" -F "language=zh"
# {"text":"…","language":"zh","emotion":"neutral","audio_events":[],"duration_ms":4120}   (SenseVoice)
# {"text":"…","language":"zh","duration_ms":4120}                                          (Qwen3-ASR)
```

任何取樣率 / 聲道數的 WAV 都可以(worker 自己轉 16 kHz 單聲道)。錯誤一律是 4xx / 5xx 加 `{"error":"..."}`。

---

## 7. ASR 細節

- **SenseVoice**:語言在啟動時固定(`ASR_LANGUAGE`,預設 `auto`,對中日英夾雜最安全),所以請求的 `language`、`prompt` 會被忽略。`emotion` 取 `neutral|happy|sad|angry|fearful|disgusted|surprised`(模型說不出來就省略),`audio_events` 取 `bgm|applause|laughter|cry|sneeze|breath|cough|sing`(一般語音的 `Speech` 標記會濾掉)。標記從 sherpa-onnx 結果的 `lang/emotion/event` 欄位解析,也容錯處理仍留在文字裡的 `<|...|>`。
- **Qwen3-ASR**:`language` 轉成模型的語言名稱(`zh`→`Chinese`,`auto`/未知→自動偵測),回應的 `language` 轉回短碼。`prompt` 只有在安裝的 `qwen-asr` 的 `transcribe()` 有 `context` 參數時才會傳入,否則忽略。沒有 `emotion` / `audio_events`。
- 並行:解碼 / 重取樣在執行緒池裡平行跑,模型呼叫用鎖序列化;事件迴圈不會被推論卡住。預設最長 60 秒音檔(`ASR_MAX_AUDIO_SECONDS`)、32 MB 上傳(`ASR_MAX_UPLOAD_MB`),超過回 413。
- 這裡的 ASR 是「整段辨識」。Qwen3-ASR 的串流模式(vLLM)這一版沒有接,HTTP 契約本身也是整段上傳。

---

## 8. 疑難排解

| 症狀 | 原因 / 處理 |
|---|---|
| 啟動就 `missing .../model.int8.onnx` | `ASR_MODEL` 要指到解壓後的 SenseVoice 資料夾(內含 `model.int8.onnx` + `tokens.txt`) |
| Windows 裝到 CPU 版 torch | 先 `pip install torch --index-url https://download.pytorch.org/whl/cu128`(或 cu124 / cu126,對照驅動)再裝 `qwen-asr` / `qwen-tts` / `faster-qwen3-tts` |
| TTS 啟動說 `CUDA graphs require CUDA device` | torch 是 CPU 版或 `TTS_DEVICE` 不是 `cuda…`;faster 後端一定要 CUDA |
| log 警告 `both qwen-tts and … qwen-tts-hf are installed` | 同一個 venv 混裝了兩個套件(同名 `qwen_tts` 模組);faster 請用獨立 venv 只裝 `requirements-faster.txt` |
| `/health` 的 `backend` 不是你想要的 | `TTS_BACKEND=faster` / `qwen-tts` 強制;`auto` 看 `faster_qwen3_tts` 能不能 import |
| faster 後端聽到斷音 / 每個 chunk 之間有空檔 | 把 `TTS_CHUNK_SIZE` 從 4 調到 8;GPU 被遊戲吃滿也會這樣(RTF 掉到 1 以下) |
| `flash_attn` 裝不起來 | 不用裝;`*_ATTN=auto` 找不到就用 SDPA。要強制:`TTS_ATTN=sdpa` / `ASR_ATTN=sdpa` |
| TTS 回 503 `no voices registered` | `VOICES_DIR/<name>/ref.wav` 不存在或目錄名稱錯;改完用 `POST /voices/reload` |
| TTS 回 404 `unknown voice` | `voice` 要等於 `VOICES_DIR` 底下的資料夾名稱(`*-candidates` 資料夾不會被註冊) |
| OOM | 換 `TTS_MODEL=…-0.6B-Base`、ASR 換 SenseVoice;或先關掉遊戲量 baseline;不要同時跑 `design_voice.py` |
| 聲音在句子之間有小爆音或停頓 | 兩個後端都是逐句生成,句子之間各自有開頭 / 結尾;qwen-tts 後端尤其明顯,這是它句子級串流的已知限制:模型每次輸出各自帶開頭 / 結尾;停頓太明顯就調大 `TTS_MIN_SENTENCE_CHARS` 讓句子長一點 |

---

## 9. 唱歌:歌曲 worker(`sing/`)

點歌 → 她用自己的聲音翻唱(像 Neuro-sama)。Core 的 `sing` 模組送工作過來,做好的歌由 Core 串流到語音頻道(見 [design/autonomy.md](../docs/design/autonomy.md) §22)。

**流程**(一次一首;模型每個階段載入、用完就釋放 VRAM,所以平常不佔 GPU):

1. **找歌**:`query` 先比對本機歌庫(`data/songs/library/`,檔名 `歌手 - 歌名.mp3`;或一個資料夾放 `vocals.*` + `instrumental.*`,已經分好就不用再分離),沒有就用 yt-dlp `ytsearch1:` 搜 YouTube;`url` 只接受 `SING_URL_HOSTS` 的網域。最長 `SING_MAX_SECONDS`(480 秒)。
2. **分離**:Demucs `htdemucs`(`SING_SEPARATOR_MODEL=htdemucs_ft` 比較乾淨、慢 4 倍)→ 人聲 + 伴奏;同一個來源只分一次(`data/songs/_sources/`)。
3. **轉換**:Seed-VC 的歌聲模型(F0 條件、44.1 kHz、Whisper-small 內容編碼、BigVGAN v2 44 kHz、RMVPE 音高),參考音是 `voices/deepseek-chan/ref.wav`(`SING_REF` 也可以用 `;` 列多個檔案或給資料夾,串成最多 25 秒)。轉換前先清 F0(`pitch.py`:補 ≤ 40 ms 的掉格、折回短暫的八度跳動、濾掉尖刺;`SING_F0_CLEAN=0` 關掉)。自動挑音高:看歌的人聲中位數**和最高音**(第 95 百分位),對她的中位數(說話 + `SING_TARGET_OFFSET`)和上限(`SING_MAX_NOTE`,或說話 + `SING_CEILING_OFFSET`),選八度(-12 / 0 / +12);最高音還是超過上限就整首往下轉(最多 `SING_KEY_MIN` −5,伴奏用 ffmpeg Rubber Band 一起移),低太多就往上一點(最多 `SING_KEY_MAX` +3);`pitch` 可以直接指定人聲移調,`key` 是整首轉調(伴奏一起移,這時只自動挑八度)。原人聲靜音的地方,轉換後的人聲會被閘掉(去掉轉換的雜音)。
4. **混音**:轉換後的人聲恢復成原人聲的響度,加上伴奏,整體正規化到 `SING_TARGET_LUFS`(-16),峰值 ≤ -1 dBFS。輸出 `mix.wav`、`vocals.wav`、`instrumental.wav`,以及 Core 串流用的 48 kHz 單聲道 `play_mix.pcm` / `play_vocals.pcm`(人聲那條給嘴型用)。
5. **歌詞**:lrclib.net 依歌名 / 歌手 / 長度找同步 LRC(找不到就沒有字幕)。
6. **影片**(跟 2–5 平行,從下載那一步開始):影片網站的來源另外抓**只有畫面**的影片(H.264 ≤ `SING_VIDEO_MAX_HEIGHT` 優先,其次其他編碼轉封裝成 mp4,不超過 `SING_VIDEO_MAX_MB`),存成 `video.mp4`,唱歌時直播畫面放它(靜音)。本機歌庫:資料夾裡的 `video.*`,或跟音檔同名的影片檔(`歌手 - 歌名.mp4`)。歌要等影片好才算做好;影片失敗或音訊好了之後 `SING_VIDEO_WAIT_S` 秒還沒好就不等(`meta.json` `has_video: false` + `video_error`)。SoundCloud 這種沒有影片的連結會直接略過。這功能之前做好的歌,再點一次會只補抓影片。

做好的歌快取在 `data/songs/<id>/`(`meta.json` 有來源、音高、歌詞、各階段耗時與 VRAM 峰值);同一個查詢 / 連結 / 檔案 + 同樣的音高設定再點一次是馬上好。`data/` 是本機資料:下載的歌、模型權重、參考音都不要提交。

**安裝(原生 Windows,Git Bash)**

```bash
cd workers
python -m venv .venv-sing
.venv-sing/Scripts/pip install torch==2.11.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128   # 先裝 CUDA 版
.venv-sing/Scripts/pip install -r sing/requirements.txt

# Seed-VC 不是 pip 套件:把原始碼放到 models/seed-vc(GPL-3.0,只放本機)
mkdir -p models/seed-vc
curl -L https://codeload.github.com/Plachtaa/seed-vc/tar.gz/refs/heads/main | tar -xz -C models/seed-vc --strip-components=1

cd sing
../.venv-sing/Scripts/python server.py      # http://127.0.0.1:8005;第一首歌會先下載約 2 GB 的模型
```

YouTube 需要 JavaScript runtime 解 player challenge:yt-dlp 會用 Node(Miyoria 本來就要裝)或 deno(`SING_JS_RUNTIMES`);requirements 已經帶 `yt-dlp[default]`(含 `yt-dlp-ejs`)。ffmpeg 要在 PATH 上。

**接上 Miyoria**

```toml
[modules.sing]
url = "http://127.0.0.1:8005"
# start = "decide"         # 她決定什麼時候唱;"auto" = 好了就唱
```

**冒煙測試**

```bash
curl -s -X POST http://127.0.0.1:8005/jobs -H 'content-type: application/json' -d '{"query":"Cartoon On & On NCS"}'
curl -s http://127.0.0.1:8005/jobs/<id>          # state / stage / progress;done 時 song.timings、peak_vram_mb
.venv/Scripts/python -m pytest tests/test_sing.py  # mock 模式(SING_BACKEND=mock),不需要 GPU / 網路
```

**實測**(2026-11-02,4070 SUPER,TTS / ASR / OBS 同時開著、GPU 已用約 10 GB):NCS 的〈On & On〉(3 分 28 秒)從 YouTube 搜尋到做好 **61.9 秒**:找歌 3.3 秒、下載 8.1 秒、分離 4.6 秒、轉換 42.3 秒(30 steps)、混音 1.6 秒、歌詞 2.0 秒;本行程 PyTorch VRAM 峰值 **3.2 GB**。同一首再點是快取。同一首的影片(只抓影片,沒有重做轉換):720p60 H.264(這首 YouTube 最高 720p)、78.4 MB,找 + 下載 16.9 秒(下載本身約 8 秒、8.8 MB/s),跟分離 + 轉換平行跑,不會拖慢。

| 環境變數 | 預設 | 說明 |
|---|---|---|
| `SING_BACKEND` | `seed-vc` | `mock` = 正弦波假歌(測試用) |
| `SING_DATA_DIR` / `SING_LIBRARY_DIR` | `<repo>/data/songs` / `<data>/library` | 快取與本機歌庫 |
| `SING_REF` / `SING_SEEDVC_DIR` | `../voices/deepseek-chan/ref.wav` / `../models/seed-vc` | 參考音、Seed-VC 原始碼 |
| `SING_DEVICE` / `SING_SEPARATE_DEVICE` | `cuda` | 分離 OOM 時自動退到 CPU |
| `SING_DIFFUSION_STEPS` / `SING_CFG_RATE` | 30 / 0.7 | 步數越多越穩、越慢 |
| `SING_TARGET_OFFSET` | 2 | 她唱歌的音高比說話高幾個半音(自動挑八度用) |
| `SING_MAX_NOTE` / `SING_CEILING_OFFSET` | — / 16 | 她的最高音(`A5` 或 Hz);沒設就是說話中位數 + 16 半音 |
| `SING_KEY_MIN` / `SING_KEY_MAX` | -5 / 3 | 自動整首轉調的範圍(都設 0 = 只挑八度) |
| `SING_F0_CLEAN` | 1 | 轉換前清理 F0 |
| `SING_OFFLOAD_URLS` | (空) | 做歌時請它們放掉 GPU 的 worker,例如 `http://127.0.0.1:8002,http://127.0.0.1:8003` |
| `SING_EXCLUSIVE_WAIT_S` / `SING_RELOAD_TIMEOUT_S` | 30 / 300 | 等 Core 說可以開始(她先說一句)/ 等 worker 載回來 |
| `SING_TARGET_LUFS` | -16 | 混音響度 |
| `SING_MAX_SECONDS` | 480 | 最長的歌 |
| `SING_URL_HOSTS` | YouTube、SoundCloud、Bilibili、Niconico | 連結允許的網域(逗號分隔,子網域也算) |
| `SING_LIBRARY_FIRST` / `SING_LYRICS` / `SING_KEEP_MODELS` | 1 / 1 / 0 | 先比對本機歌庫 / 抓歌詞 / 模型留在 VRAM |
| `SING_GPU_CHILD` | 0 | 1 = 分離、音高分析、轉換在子行程裡做,工作結束就關掉,閒置的 worker 不佔 VRAM(`SING_KEEP_MODELS=1` 時不用) |
| `SING_VIDEO` / `SING_VIDEO_MAX_HEIGHT` / `SING_VIDEO_MAX_MB` / `SING_VIDEO_WAIT_S` | 1 / 1080 / 300 / 120 | 抓原曲影片 / 最高解析度 / 最大檔案 / 音訊好了之後最多再等幾秒 |
| `HOST` / `PORT` | `127.0.0.1` / `8005` | 只聽本機 |

Go Live 直播要讓觀眾聽到歌,voice node 的 `GOLIVE_AUDIO` 要開(`true`);語音頻道裡的人不受影響。

**做歌時獨佔顯示卡**:12 GB 的卡上 TTS + ASR 開著時轉換會慢 10 倍以上。TTS / ASR worker 有 `POST /offload`(丟掉模型、清 CUDA cache,之後 `/tts`、`/asr` 回 `503 {"error":"offloaded"}`)和 `POST /reload`(跟啟動一樣重建;放掉超過 `TTS_OFFLOAD_MAX_S` / `ASR_OFFLOAD_MAX_S` 900 秒會自己載回來),見 [voice-link.md](../docs/protocols/voice-link.md)「讓出顯示卡」。歌曲 worker 設 `SING_OFFLOAD_URLS=http://127.0.0.1:8002,http://127.0.0.1:8003` 後,分離 / 轉換前叫它們放掉、轉換完叫它們載回來(失敗、取消也會);Core 會讓她先說一句「我去準備一下歌喔」。重建成本約等於啟動時間(這台:TTS 引擎 12.9 秒、ASR 14.9 秒)。
