# 讓她第一次玩 Minecraft:逐步設定

照順序做一次就好。背景說明在 [README.md](README.md),協定在 [PROTOCOL.md](PROTOCOL.md)。

**前提**:Minecraft 和 Miyoria Core 跑在**同一台 Windows 電腦**(模組只聽 `127.0.0.1`)。Node ≥ 24、pnpm 已可用(`corepack enable`)。

## 1. 建置(在 repo 根目錄,一次)

模組(需要 JDK 21;這台電腦已有 Temurin 21):

```powershell
cd extensions\minecraft\mod
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-21.0.3.9-hotspot"
.\gradlew.bat downloadBaritone     # 抓 baritone-api-fabric-1.11.3.jar 到 mod\libs\
.\gradlew.bat build                # 測試 + 產出模組 jar
cd ..\..\..
```

產出兩個等一下要用的檔案:

- `extensions\minecraft\mod\build\libs\miyoria-bridge-0.1.0.jar`
- `extensions\minecraft\mod\libs\baritone-api-fabric-1.11.3.jar`

adapter(Core 用 `node dist\index.js` 啟動它,所以要先 build):

```powershell
pnpm install
pnpm --filter "@miyoria/ext-minecraft..." build
```

## 2. 建一個她專用的遊戲實例

不要跟你自己玩的實例混用。二選一:

**A. Prism Launcher(推薦)**

1. 「新增實例」→ 名稱 `Miyoria-1.21.1` → 版本 **1.21.1** → 模組載入器選 **Fabric**(0.16.x 或更新)→ 確定。
2. 實例上按右鍵 →「資料夾」。打開的是 `%APPDATA%\PrismLauncher\instances\Miyoria-1.21.1\`,**遊戲目錄是裡面的 `minecraft\`**(舊版 Prism 叫 `.minecraft\`)。下面說的「遊戲目錄」都是指這層。
3. Java:Prism 的「設定 → Java」開自動下載,或指到 `C:\Program Files\Eclipse Adoptium\jdk-21.0.3.9-hotspot\bin\javaw.exe`(1.21.1 需要 Java 21)。

**B. 官方啟動器**

1. 執行 Fabric 安裝程式(https://fabricmc.net/use/installer/ )→ Client → Minecraft **1.21.1** → Loader 選最新 → 勾「建立設定檔」→ Install。
2. 啟動器 →「安裝檔」→ `fabric-loader-1.21.1` →「編輯」→ **遊戲目錄**改成專用資料夾,例如 `C:\Games\Miyoria-1.21.1`。這個資料夾就是「遊戲目錄」。

帳號:在這個實例登入**她自己的** Microsoft 帳號(不要用你的;帳號資訊只存在啟動器,不要放進 repo 或設定檔)。只想先試單人世界,可以用離線帳號。

## 3. 放模組:`<遊戲目錄>\mods\`

**只用 Baritone(建議第一次這樣)**,`mods\` 裡剛好三個檔:

| 檔案 | 從哪來 |
|---|---|
| `fabric-api-0.116.17+1.21.1.jar`(或更新的 1.21.1 版) | https://modrinth.com/mod/fabric-api (篩 1.21.1 / Fabric) |
| `baritone-api-fabric-1.11.3.jar` | 複製 `extensions\minecraft\mod\libs\` 裡那個(= GitHub `cabaletta/baritone` v1.11.3 的同名檔) |
| `miyoria-bridge-0.1.0.jar` | 複製 `extensions\minecraft\mod\build\libs\` 裡那個 |

- **不要用 `baritone-standalone-fabric-1.11.3.jar`**:standalone 版把 API 也混淆了,模組呼叫不到,她會不能走路挖礦。
- **改用 AltoClef 時**:把 Baritone 那個 jar **拿掉**,換成 `altoclef-1.21.1-0.19.jar`(https://github.com/MiranCZ/altoclef/releases/tag/0.19 ,內建自己的 Baritone)。**Baritone jar 和 AltoClef 絕對不要同時放**(兩個 id 都是 `baritone`,會衝突)。
- 不要放 `-sources.jar`。

## 4. 第一次啟動遊戲

1. 啟動實例,停在主選單也可以。打開 `<遊戲目錄>\logs\latest.log`(Prism:實例的「Minecraft 記錄」視窗),要看到這一行:

   ```
   Miyoria bridge listening on ws://127.0.0.1:7890 (token in C:\...\config\miyoria-bridge.json)
   ```

   同時**不能**有 `Baritone is not installed` 或 `baritone.api is missing`(有的話回去看第 3 步)。看到 `could not bind 127.0.0.1:7890` 是埠被占用,改 token 檔裡的 `port` 後重開遊戲。
2. Token 檔就是那行 log 裡的路徑:`<遊戲目錄>\config\miyoria-bridge.json`(第一次啟動自動產生,含隨機 `token`)。不用手動複製 token,adapter 會自己讀;不要外流或提交。刪掉會重新產生新 token。
3. 建一個單人世界(第一次建議:生存、和平或簡單難度、不開作弊)進去。
4. 影像:按 `F11` 切回**視窗化**(全螢幕獨占 OBS 抓不到),1920×1080 或 1280×720。失焦不暫停已由模組自動處理;但挖方塊 / 攻擊需要遊戲視窗在前景、不要開著選單。
5. (可選)Baritone 建議設定寫進 `<遊戲目錄>\baritone\settings.txt`,內容見 [README.md](README.md) §5。

## 5. Miyoria 設定(你的 `miyoria.toml`,在 repo 根目錄)

加上(或併入已有的同名表格;TOML 不能出現兩個 `[modules.extensions]`):

```toml
[modules.extensions]
dirs = ["extensions"]   # 預設值;Miyoria 要在 repo 根目錄啟動,才找得到 extensions\minecraft\adapter

[extensions."miyoria.minecraft"]
# 遊戲目錄(含 config\ 的那層)。用單引號,Windows 的反斜線才不用跳脫。
minecraft_dir = 'C:\Users\<你>\AppData\Roaming\PrismLauncher\instances\Miyoria-1.21.1\.minecraft'
# minecraft_dir = 'C:\Games\Miyoria-1.21.1'   # 官方啟動器的例子
# allow_commands = false   # true 才讓她送 / 開頭的遊戲指令
# damage_important = 4     # 一次受傷幾點以上算大事(會馬上實況)
# 她要玩的時候自己用 Prism Launcher 開遊戲(預設開著;實例 id 從 minecraft_dir 推)
# prism_path = 'C:\Users\<你>\AppData\Local\Programs\PrismLauncher\prismlauncher.exe'   # 預設自動找
# prism_instance = "Miyoria-1.21.1"
# launch_world = "latest"      # 直接進入最近玩的存檔;"" = 停在主選單;或存檔資料夾名
# launch_timeout_secs = 180
# quit_on_stop = "launched"    # 停止玩時關遊戲:launched(只關她開的)| always | never
# auto_launch = true

[modules.game]
default_game = "minecraft"
decide_secs = 20           # 多久想一次下一步(有事件時會提早,最快每 4 秒)
# 她不在語音頻道時,實況送到哪(可省略;省略就送到下 /game start 的頻道)
# stream_context = { platform = "discord", scope = "<伺服器 id>", channel = "<頻道 id>", kind = "voice" }
# require_connected = true   # 開始前先確認遊戲開著、模組連上;沒開就自己開(auto_launch),開不起來就拒絕並說原因
# launch_wait_secs = 240     # 自己開遊戲時最多等幾秒
# close_on_stop = true       # 停止玩時也請 adapter 關遊戲(它照自己的 quit_on_stop 決定要不要真的關)
# failure_guard_secs = 45    # 動作失敗後這段時間不給 goto / mine / look / attack,逼她換方法或目標(0 = 關)

# 遊戲內聊天變成她的一段對話(預設就開著,這段可省略)
[modules."game.chat"]
world = "local"            # 這個世界 / 伺服器的名字;換世界或伺服器時改它,歷史就分開
username = "<她的 Minecraft 名字>"   # 別人在遊戲裡提到這個名字 = 在叫她
# max_chars = 120          # 她在遊戲聊天室一句最多幾個字
# reply = "auto"           # auto(打字,直播中又在語音時也講出來)| chat | voice | both

# 遊戲聊天室要不要主動插話,跟一般頻道一樣用頻道模式(預設跟 profile:ambient)
# [modules.agent]
# channels = { "minecraft:local" = "mention-only" }
```

確認找得到擴充:

```powershell
pnpm dev ext list          # 要列出 miyoria.minecraft 0.1.0  ...\extensions\minecraft\adapter
```

## 6. 開玩

1. 遊戲開著、在世界裡(順序其實無所謂,adapter 每幾秒會自動重連,最多等 15 秒)。
2. 啟動 Core:`pnpm dev:core`。Core 的 log 會出現 adapter 的 `connected to the mod`(帶 `capabilities`,`baritone` 要是 `true`)。如果是 `no miyoria-bridge token` 或 `the mod refused the connection`,就是 `minecraft_dir` 指錯了。
3. Discord(owner 有全部權限,moderator 有 `game.*`):

   | 指令 | 作用 |
   |---|---|
   | `/game status` | 看她在不在玩、目前目標、bot 忙不忙(先打這個確認) |
   | `/game start` | 開始玩。可選參數 `game`(預設 `minecraft`)、`where`:`auto`(預設:她所在的語音頻道 > `stream_context` > 這裡)/ `voice` / `here` / `stream` |
   | `/game goal 去砍十個橡木原木` | 指定她接下來要做的事 |
   | `/game stop` | 停止(也會叫 Baritone / AltoClef 停下來) |

4. 第一次建議先 `/game goal 走到最近的樹旁邊`,確認她會走;再試 `/game goal 挖一些石頭`。

### 直接跟她說「去玩 Minecraft」

不用指令也可以:在 Discord 跟她說「去玩 Minecraft 吧」「開台玩 Minecraft」。她自己決定要不要(好感、心情),要的話會用 `game_start` 工具:

1. 先確認遊戲開著、模組連上。**沒開的話她會自己用 Prism Launcher 開**(`prismlauncher --launch Miyoria-1.21.1 --world <最近玩的存檔>`,等模組連上、進入世界,最多約 4 分鐘);Prism 找不到、啟動器出錯或逾時,`game_start` 會失敗並說原因,她就會跟大家說。還在主選單也可以開始,進入世界後她就會動。停止玩的時候,她自己開的遊戲會再關掉(你開的不會)。
2. 開始一個 session(她在語音頻道就在語音裡實況),直播畫面自動切到遊戲場景(見第 7 步)。
3. 你說了要做什麼(「去挖鐵礦」)她會把它當第一個目標;說了要開台、她也願意的話會順便 Go Live(OBS 跟著開播,也要過閘門,太頻繁或你禁止 `stream.*` 時會被擋)。從遊戲聊天室裡要求開台不行(跨伺服器禁令),要在 Discord 講。
4. 之後導演迴路自己決定目標和動作,邊玩邊實況;「別玩了」或 `/game stop` 停止,畫面切回聊天場景。

### 遊戲內聊天

- 遊戲裡其他玩家說的話是她的一段獨立對話(不會跟 Discord 頻道混在一起)。她在遊戲裡回話很短,而且一定不是指令(開頭的 `/`、`!`、`#`、`.` 會被拿掉)。
- 直播中又在語音頻道時,她的回話也會用語音講出來(有字幕);她可以自己改成只打字、只講或都要。
- **把你的 Minecraft 帳號連到 Discord**:在 Discord 打 `/me link`(不帶代碼)拿一組代碼,10 分鐘內在遊戲聊天室輸入 `!link <代碼>`。連好之後遊戲裡的你就是 Discord 的你(同一份好感和記憶);沒連的玩家對她來說是陌生人。
- 她的遊戲名字要寫在 `[modules."game.chat"] username`,別人在遊戲裡叫她時她才知道。
- 自主暫停(`/admin autonomy pause`)時,她不會在遊戲裡打字,導演也停下來。

## 7. OBS

1. 建一個場景,例如 `Game`(遊戲場景)。
2. 來源 →「視窗擷取」→ 視窗選 `[javaw.exe]: Minecraft* 1.21.1 - ...`;擷取方式 **Windows 10 (1903 and up)**;取消「擷取游標」;勾「Client Area」。黑畫面就改用「遊戲擷取」→ 擷取特定視窗。
3. 疊上 VTube Studio 的她(角落)和 overlay 瀏覽器來源 `http://127.0.0.1:7884/overlay/`(1920×1080,字幕與狀態)。
4. 音訊:「應用程式音訊擷取」選 `javaw.exe` 只收遊戲聲音;她的語音走 TTS 那條。
5. 其他場景(建議都建,名稱看得出用途就好,例如):`Talk` / `雜談`(平常聊天)、`BRB` / `暫離`、`Starting Soon` / `開場`、`Ending` / `結尾`。
6. **場景用途**:Stage 節點連上後,Core 會用 AI 從名稱判斷每個場景的用途(聊天、遊戲、暫離、開場、結尾)。到面板「直播」頁的「場景用途」確認,不對就改;或寫死在設定檔:

   ```toml
   [modules."stage.link".scenes]
   roles = { chat = "Talk", game = "Game", brb = "BRB", starting = "Starting Soon", ending = "Ending" }
   transition = { name = "Fade", duration_ms = 300 }   # OBS「場景轉換」裡的名稱
   transitions = { game = { name = "Stinger" } }       # 進遊戲用 stinger(要先在 OBS 建好)
   ```

7. **自動切換**:開台 → 開場畫面(30 秒)→ 聊天;開始玩 → 遊戲;停止 → 聊天;直播中 5 分鐘沒人講話或她離開語音 → 暫離;下播 → 結尾畫面停 6 秒才真的停播。你在 OBS 手動切了之後,2 分鐘內不會被切回來。手動切換仍可以 `/stream scene <場景或用途>`(例如 `/stream scene game`)。
8. 轉場會變成 OBS 目前的轉場(之後手動切換也用它)。轉場名稱打錯時只會記警告,照樣切換。

## 出問題時

先看 [README.md](README.md) §8 疑難排解。最常見:

- 她站著不動、`/game status` 說 bot 閒置:看遊戲 log 有沒有 Baritone 相關錯誤;`baritone.api is missing` = 裝成 standalone 了。
- `/game start` 回「找不到 minecraft 的遊戲 adapter」:adapter 沒 build(第 1 步)、不是在 repo 根目錄啟動 Core,或 `pnpm dev ext list` 沒列出它。
- `/game status` 的狀況寫「還在主選單或載入中」:導演在等,進入世界就好,下一次決策(≤ 20 秒)會自己接上。
- `/game start`(或她)說「Minecraft 還沒開,或遊戲裡的模組沒有連上」:遊戲沒開、`minecraft_dir` 指錯,或 adapter 還沒連上(Core log 要有 `connected to the mod`)。
- 場景沒有自動切:看面板「場景用途」有沒有對到場景;自主暫停中導演也會停;剛手動切過的話要等 `manual_hold_ms`(預設 2 分鐘)。
- 遊戲聊天她不回:頻道模式是不是 `off` / `mention-only`(`[modules.agent] channels` 的 `minecraft:<world>`);暫停中她不打字。
