# 語音辨識 / 合成放在 Linux server

適合:server 有 NVIDIA GPU,想把直播機的 12 GB VRAM 留給遊戲和 OBS。

```
直播機(Windows)                          Linux server
┌──────────────────┐   voice link(wss)  ┌───────────────────────────────┐
│ apps/voice-node  │ ─────────────────▶ │ Core ─▶ ASR(:8001,本機)       │
│ OBS / VTS / 遊戲  │ ◀───── TTS 音訊 ── │      ─▶ TTS vLLM-Omni(:8091) │
└──────────────────┘                    │      SQLite                    │
                                        └───────────────────────────────┘
```

- Core 跟 ASR / TTS 在同一台,呼叫都走 `127.0.0.1`,worker 不用對外開。
- 只有 **voice link** 要跨機器:收音每位說話者約 256 kbps 上傳,TTS 約 384 kbps 下載;延遲多兩次網路來回(同城通常 < 50 ms),跟 TTS 本身比起來很小。

## 啟動

```bash
cd deploy/speech
docker compose up -d
docker compose logs -f tts      # 第一次會下載模型
```

GPU 記憶體:vLLM 預設會吃掉大部分 VRAM。ASR 和 TTS 放同一張卡時,依 vLLM-Omni 文件(GPU Memory Calculation and Configuration)用 `TTS_EXTRA_ARGS` 調整;卡比較小就先用 `TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-Base`。

## 上傳 DeepSeek-chan 的聲音

在任何有 Python 的機器(可以是直播機)用 `workers/tts/design_voice.py` 設計、挑好聲音後:

```bash
python workers/tts/upload_voice.py --url http://127.0.0.1:8091 --voices-dir voices --name deepseek-chan
```

(在直播機執行就先用 SSH tunnel:`ssh -L 8091:127.0.0.1:8091 <server>`。)

## Core 設定(server 上的 `miyoria.toml`)

```toml
[speech.asr.local]
kind = "http-worker"
url = "http://127.0.0.1:8001"

[speech.tts.qwen]
kind = "vllm-omni"
base_url = "http://127.0.0.1:8091/v1"
voice = "deepseek-chan"
language = "Chinese"

# 讓直播機的 voice node 連得進來;實際對外請走下面的加密方式
[modules."voice.link"]
bind = "0.0.0.0:7879"
token = "${VOICE_LINK_TOKEN}"
```

## Voice link 跨網路一定要加密

voice link 本身是明文 WebSocket(token 和語音都看得到)。跨網路時二選一:

- **私有網路(最簡單)**:Tailscale / WireGuard。`bind` 改成 server 的 tailnet IP,voice node 用 `VOICE_LINK_URL=ws://<tailnet-ip>:7879/voice-link`。
- **反向代理 + TLS**:Caddy / nginx 把 `wss://voice.example.com/voice-link` 轉到 `127.0.0.1:7879`(`bind` 維持 `127.0.0.1:7879`),voice node 用 `VOICE_LINK_URL=wss://voice.example.com/voice-link`。

不要把 7879 直接開到公網。
