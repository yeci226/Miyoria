# 自己架一套 Miyoria

這一頁帶你從零開始,架出一個會在 Discord 回你話的 Miyoria。先只做文字聊天,不需要顯卡;語音、翻唱和第二台電腦是後面的選用章節。

> Miyoria 還在早期階段:設定、資料庫和指令都可能不預告地改變。下面寫的是現在做得到的事;還做不到的地方會直接寫「還不行」。

## 需要什麼

- **Node.js 24**。從 <https://nodejs.org> 安裝,`node --version` 要是 v24 以上。
- **一個 Discord 機器人**。到 <https://discord.com/developers/applications> 建一個 Application,在 **Bot** 頁籤新增 bot 並複製 token。同一頁的 **Privileged Gateway Intents** 要打開:
  - **Message Content Intent**(一定要)。
  - **Presence Intent** 和 **Server Members Intent**(預設要;她用它們知道誰在線、誰在哪個語音頻道)。不想開就之後執行 `miyoria config set modules."platform.discord.bot".presence_intents false`。沒開卻又要求的話,Discord 會拒絕連線,`miyoria doctor` 會告訴你哪一項沒開。

  然後到 **OAuth2 → URL Generator**,勾 scope `bot` 和 `applications.commands`,權限勾 View Channels、Send Messages、Send Messages in Threads、Read Message History、Add Reactions,用產生的網址把 bot 邀請進你的伺服器。
- **一組 LLM 的 API key**。`miyoria init` 支援 DeepSeek(預設)、OpenAI、任何 OpenAI 相容的服務(要填它的網址),和 opencode。
- **不需要顯卡。** 只有加上語音或翻唱才要(見下面)。

## 五個步驟

**1. 安裝。** 套件還沒有發佈到 npm,今天能用的是從 repository 安裝:

```bash
git clone <repository 網址>
cd Miyoria
node scripts/setup.mjs     # 啟用 pnpm、安裝相依套件,然後接著跑 miyoria init(下一步)
pnpm build:web             # 建出管理面板;只有從 repository 跑才需要這一步
```

在 repository 裡,本頁的 `miyoria <指令>` 都寫成 `pnpm dev <指令>`。

之後(發佈到 npm 以後)會是:`npm i -g miyoria`,或不安裝直接 `pnpm dlx miyoria@latest init`。現在還不行。

**2. 設定。** `miyoria init`(上一步的 `setup.mjs` 已經替你開了)第一題問這台電腦要做什麼,選第一項「文字聊天」。接著依序問角色(預設 deepseek-chan)、LLM 的 key 和模型、Discord bot token 和你的 Discord user id、資料庫(預設 SQLite,不用安裝)、管理面板的登入。不確定的題目按 Enter 用預設值。確認後它寫出:

- `miyoria.toml`:設定。
- `.env`:密碼和 token(不要放進 git)。
- `host.toml`:這台電腦跑哪些服務,文字聊天只有 `core`。
- `profiles/`、`data/`:角色和資料庫。

**3. 啟動。**

```bash
miyoria up
```

它會在背景啟動這台電腦的管家(hostd),再由管家啟動 Core,等 Core 回應健康檢查後印出 `✓ core  http://127.0.0.1:7878`。第一次啟動時,這台電腦也會自動連到自己的 Core(印一行「這台電腦已連上本機的 Core」),不用多做什麼。

**4. 打開管理面板。** 瀏覽器開 <http://127.0.0.1:7878/>,用 `.env` 裡的 `MIYORIA_API_TOKEN` 登入。想先確認她活著,不經 Discord 也可以在終端機聊:`miyoria chat`。

**5. 在 Discord 跟她說話。** 把 bot 邀請進伺服器後,在頻道裡 @ 她。bot 在線上、有回話,就完成了。

## 常用指令

| 指令 | 做什麼 |
|---|---|
| `miyoria status` | 這台電腦的服務(狀態、健康、埠),和 Core 的模組與 LLM 用量 |
| `miyoria logs core -n 100` | 看一個服務最後 100 行日誌;加 `-f` 持續追蹤 |
| `miyoria doctor` | 檢查設定、LLM、Discord、資料庫,和每個服務缺什麼 |
| `miyoria update` | 更新:`git pull`、裝相依套件、只重建有變的,再一個一個重啟有變的服務 |
| `miyoria down` | 停止全部服務並結束管家 |

`miyoria config` 可以一次改一項設定,`miyoria --help` 列出全部指令。

## 加上語音

語音是兩件事:**辨識和合成**(在你的顯卡上跑)和**語音節點**(進 Discord 語音頻道的那個程式)。

**需要什麼。** 一張 NVIDIA 顯卡和驅動。語音辨識約佔 1.5 GB 顯示記憶體,語音合成約 5 GB(各服務 `service.toml` 的 `vram_mb`),加起來約 6.5 GB,桌面和別的程式還要再留一些。另外要裝 [uv](https://docs.astral.sh/uv/)(Python 環境用它建;CLI 不會替你裝):Windows 用 `winget install --id=astral-sh.uv -e`,Linux 和 macOS 用 `curl -LsSf https://astral.sh/uv/install.sh | sh`。

**辨識和合成。**

```bash
miyoria add asr tts turn   # 建環境、下載缺的檔案,最後列出還要你自己處理的事
miyoria up
```

模型第一次要下載幾個 GB(辨識約 2 GB、合成 4 到 5 GB)。聲音的參考音(`ref.wav` 和它說的內容 `ref.txt`)不在套件裡,要自己準備;`miyoria add tts` 的輸出會寫出放在哪個路徑。`miyoria doctor` 會檢查還缺什麼。(`miyoria init` 的第二個選項「文字加語音」做的只是把 `asr`、`tts`、`turn` 先寫進 `host.toml`,上面兩行還是要自己執行。)

**語音節點。** 她進語音頻道、聽和說,要靠語音節點。

> **請先讀這一段。** 語音節點是用一個 **Discord 使用者帳號**(self 帳號)登入的,不是 bot。Discord 的服務條款不允許用程式自動操作使用者帳號,這個帳號可能被停權。請**另外申請一個專門給她用的小帳號**,絕對不要用你在意的帳號。要不要用、風險有多大,是你自己的決定。文字聊天和上面的辨識、合成都不需要這個帳號;只有進語音頻道才需要。

節點目前**還沒有跟著 `miyoria` 套件發行**,需要 repository:在 clone 下來的資料夾裡執行 `pnpm dev add voice-node`,再照 [`apps/voice-node/README.md`](../apps/voice-node/README.md) 填 `apps/voice-node/.env`(self 帳號的 `SELF_TOKEN`,和 Core 相同的 `VOICE_LINK_TOKEN`),以及 [OPERATIONS.md](OPERATIONS.md) 第 5 節「Self 帳號(語音)」的權限設定。在套件裡執行 `miyoria add voice-node` 會告訴你同一件事。

## 加上翻唱

翻唱(`sing` 服務)要更多顯示記憶體(約 7.5 GB,和辨識、合成輪流使用),要 ffmpeg 在 PATH 上,而且**模型要自己放**:她的 RVC 歌聲模型、人聲分離模型等,`miyoria add sing` 會列出每一項和該放的位置。這一塊目前還沒有為「從套件安裝」準備好,請用 repository 跑。借朋友的顯卡來唱歌的做法見 [sing-remote-host.md](sing-remote-host.md)(那份是 hostd 之前寫的,指令以本頁和 `miyoria add sing` 的輸出為準)。

## 第二台電腦

另一台電腦(例如有顯卡的那台)可以替 Core 跑服務。它不需要自己的 Discord token、LLM key 或資料庫。

1. **Core 那台**:`miyoria host invite`。它印出一組只能用一次、10 分鐘有效的邀請碼,和另一台要執行的整行指令。
   - Core 預設只聽本機。要讓別台連進來,要把 Core 的兩個位址改成這台的區網或 Tailscale 位址,例如 `miyoria config set modules.api.bind 100.64.0.5:7878` 和 `miyoria config set modules.cluster.bind 100.64.0.5:7880`,然後重啟 Core(`miyoria down` 再 `miyoria up`)。`invite` 發現管理 API 只聽本機時會提醒你。
2. **另一台**:`miyoria init`,第一題選第三項「只提供服務給別台的 Core」,勾要提供的服務(要顯卡的會標出來);再 `miyoria add <服務>`;然後執行 `invite` 印出的那行:
   ```bash
   miyoria host join <Core 的位址> --code <邀請碼>
   ```
   最後 `miyoria up`。
3. **Core 那台**:`miyoria host approve <那台的名字>`。核准之前,它的服務不會被使用。`miyoria host ls` 看每一台是不是已連線。

面板的「電腦」頁會把每個服務標成「直連」或「經連線」。**經連線**的意思是:那台電腦主動撥了一條連線到 Core,Core 呼叫它時就走這條線回去,所以那台不用開埠,也不用設定防火牆。即時語音這類要直接連的服務才需要另外設位址,翻唱不用。

## 出問題時

- **`找不到 …host.toml`**(後面接著提到 `host migrate`,那是給舊設定轉檔用的):`miyoria up` 要 `host.toml`。新安裝重新執行 `miyoria init`(選第一項)就會建出來。
- **`✗ core  …` 之後貼出幾行日誌**:Core 沒起來,日誌的最後幾行通常就是原因(設定寫錯、資料庫打不開)。完整的用 `miyoria logs core -n 200` 看。
- **埠被占用**:`埠 7878 上已經有在回應的服務,不是這個 hostd 啟動的;不會動它`。有別的程式佔了 Core 的埠(或你已經有一個 Core 在跑)。關掉它,或 `miyoria config set modules.api.bind 127.0.0.1:7890`,並在 `host.toml` 的 `[services.core]` 加 `port = 7890`。
- **bot 一直離線**:日誌有 `token is empty; module disabled`,代表 `.env` 的 `DISCORD_BOT_TOKEN` 是空的;填上之後 `miyoria down` 再 `miyoria up`。Discord 連不上或拒絕,先 `miyoria doctor`:它會寫出 `沒有開啟 Message Content Intent` 或 `Presence Intent` 這類訊息,照它說的到 Developer Portal 打開。
- **她不回話,`doctor` 的 LLM 一項失敗**:API key、網址或模型名稱不對。`miyoria init` 重新輸入,或 `miyoria config set --env LLM_API_KEY <key>`。
- **`找不到 uv`**(`miyoria add` 時):照訊息裡的指令裝好 uv,重新執行同一個 `miyoria add`,做完的部分會跳過。
- **`Core 的管理 API 不接受這個 token`**:`.env` 的 `MIYORIA_API_TOKEN` 和執行中 Core 讀到的不同。重啟 Core(`miyoria down` 再 `miyoria up`)。
- **`up` 印出 `這台沒有自動連上本機的 Core:…`**:只是自動連線這一步沒做成(原因寫在同一行),Core 照常在跑。修好原因後再 `miyoria up`,或手動 `miyoria host join --local`;不想自動連就 `miyoria up --no-link`。

## 不能做的事(現在)

- 從 npm 安裝:還沒有發佈。
- 語音節點和翻唱從套件安裝:還沒有;兩者都要 repository。
- 第二台電腦:Core 那邊要自己把兩個位址改成區網或 Tailscale 位址,還沒有一個指令幫你做。
