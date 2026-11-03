@echo off
rem Miyoria on this PC: speech workers + song worker + voice node. Core runs on the Mac.
rem Close the windows to stop everything.
set ROOT=C:\Users\shawn\miyoria
set TAILNET_IP=100.107.179.72
set PYTHONUTF8=1

rem ASR: SenseVoice on CPU (no VRAM; Qwen3-ASR on the GPU made TTS choppy next to the song worker, 2026-11-03)
rem More accurate but needs ~1.9 GB VRAM: Qwen3-ASR (use instead of the SenseVoice line)
rem start "Miyoria ASR :8001" /D "%ROOT%\workers\asr" cmd /k "set HOST=%TAILNET_IP%&& set ASR_BACKEND=qwen3&& set ASR_QWEN_SIZE=0.6B&& set HF_HUB_OFFLINE=1&& set HF_HUB_DISABLE_SYMLINKS_WARNING=1&& ..\.venv-asr-qwen3\Scripts\python.exe server.py"
start "Miyoria ASR :8001" /D "%ROOT%\workers\asr" cmd /k "set HOST=%TAILNET_IP%&& set ASR_BACKEND=sensevoice&& set ASR_MODEL=..\models\sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17&& ..\.venv-asr\Scripts\python.exe server.py"

rem TTS: Qwen3-TTS 0.6B (about 3-4 GB VRAM; 1.7B does not fit next to OBS and games on 8 GB)
rem TTS_SENTENCE_PAUSE_MS = silence between sentences; name readings in workers\voices\readings.json
start "Miyoria TTS :8002" /D "%ROOT%\workers\tts" cmd /k "set HOST=%TAILNET_IP%&& set TTS_MODEL=Qwen/Qwen3-TTS-12Hz-0.6B-Base&& set VOICES_DIR=..\voices&& set TTS_DEFAULT_VOICE=deepseek-chan&& set TTS_SENTENCE_PAUSE_MS=350&& set HF_HUB_DISABLE_SYMLINKS_WARNING=1&& ..\.venv-tts-faster\Scripts\python.exe server.py"

rem Songs: yt-dlp -> Demucs -> Seed-VC in her voice. While converting it asks TTS and ASR to free the GPU
rem (she is silent for a few minutes) and reloads them after. Songs are cached in data\songs.
start "Miyoria Sing :8005" /D "%ROOT%\workers\sing" cmd /k "set HOST=%TAILNET_IP%&& set SING_VIDEO=0&& set SING_OFFLOAD_URLS=http://%TAILNET_IP%:8002,http://%TAILNET_IP%:8001&& set HF_HUB_DISABLE_SYMLINKS_WARNING=1&& ..\.venv-sing\Scripts\python.exe server.py"

rem Voice node: the self account in Discord voice (needs SELF_TOKEN in apps\voice-node\.env)
start "Miyoria voice node" /D "%ROOT%\apps\voice-node" cmd /k "corepack pnpm start"

rem Stage (VTube Studio / OBS / overlay) is not started: not used for now.
rem To bring it back: start "Miyoria Stage" /D "%ROOT%" cmd /k "corepack pnpm dev stage"
