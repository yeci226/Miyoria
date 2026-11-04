# Threads 擴充(滑 Threads)

讓她在直播機上用瀏覽器滑**她自己的** Threads 動態:一則一則看貼文,有興趣就打開看留言,然後用語音講感想,像在實況玩遊戲一樣。

- **只看不碰**:能做的動作只有 `next`(下一則)、`open`(看留言)、`back`、`refresh`、`launch`、`quit`。沒有按讚、留言、發文、追蹤,她在 Threads 上不會留下任何東西。
- **她自己的帳號**:瀏覽器有自己的資料夾(預設 `%LOCALAPPDATA%\Miyoria\threads-browser`),擁有者在那個視窗手動登入一次,之後保持登入。程式不會碰帳號密碼。
- **是一個「遊戲」**:遊戲 id 是 `threads`,所以她會自己決定去滑(`game.start` 帶 `game = threads`),大家也可以叫她;OBS 會切到 `threads` 角色的場景(沒設就用 `game` 的)。
- **看圖**:有設定看圖模型時,有圖的貼文會截圖給它描述;沒設就只知道「附了幾張圖」。

## 安裝

```bash
pnpm install
cd extensions/threads
pnpm browser   # 下載 Playwright 的 Chromium(約 150 MB,只要一次)
pnpm build
```

`miyoria.toml`:

```toml
[modules.extensions]
dirs = ["extensions"]

[modules."stage.link".scenes]
roles = { chat = "聊天", sing = "唱歌", threads = "Threads" }   # threads 角色 = 滑 Threads 的場景

[extensions."miyoria.threads"]
# 看圖模型(任何 OpenAI 相容端點,例如 OpenCode 上的 DeepSeek V4.1 Flash 就看得懂圖);不設就只讀文字
vision_url = "https://opencode.ai/inference/go/v1"
vision_model = "deepseek-v4.1-flash"
env = { MIYORIA_THREADS_VISION_KEY = "${OPENCODE_API_KEY:-}" }   # 沿用 .env 裡已經有的 key
```

然後 `npx miyoria stage obs-setup` 會建好 Threads 場景:背景、她的瀏覽器視窗(OBS 視窗擷取「Miyoria Threads」)、站在右邊的她、overlay。

第一次:叫她去滑 Threads(或 `/game start threads`),瀏覽器視窗出現後,在視窗裡登入她的帳號。登入前她不會開始滑。

## 設定

| 設定 | 預設 | 說明 |
|---|---|---|
| `start_url` | `https://www.threads.com/` | 打開時的頁面 |
| `profile_dir` | `%LOCALAPPDATA%\Miyoria\threads-browser` | 瀏覽器資料夾(登入狀態) |
| `width` / `height` | `720` / `1000` | 視窗大小 |
| `vision_url` / `vision_model` | 無 | 看圖模型(也可以用 `MIYORIA_THREADS_VISION_URL` / `_MODEL`) |
| `vision_key_env` | `MIYORIA_THREADS_VISION_KEY` | 放 key 的環境變數 |

OpenCode 和 DeepSeek 的端點會自動加上 OpenCode 要的 `x-opencode-session`,並關掉推理(不然短短的描述會被推理吃掉)。

## 安全

貼文、留言、圖片裡的文字都是陌生人寫的,一律當成不可信的資料:導演的提示裡它們包在資料區塊中,寫了指令也不照做。直播時色情、血腥、仇恨、個資的內容她會跳過不念。瀏覽器只打開 Threads 自己的貼文連結,不會點外部連結。
