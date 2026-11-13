# Minecraft 擴充(客戶端模組路線)

讓她**真的開一個 Minecraft 視窗在玩**:Fabric 客戶端模組 `miyoria-bridge` 在本機開 WebSocket,對外提供狀態快照、事件推送與動作;能力來源是 **Baritone**(尋路、挖礦、跟隨、探索、蓋建築)與可選的 **AltoClef**(高階任務、自動吃東西、躲怪)。直播畫面直接擷取她的遊戲視窗,也就是她的第一人稱視角。架構背景見 `docs/ARCHITECTURE.md` §12.3–§12.4。

```
extensions/minecraft/
  mod/        # Fabric 客戶端模組 miyoria-bridge(Java 21,Gradle + Fabric Loom)
  adapter/    # TS game adapter 擴充(miyoria.minecraft):連到 mod 的 WebSocket,實作 GameAdapter
  PROTOCOL.md # 通訊協定(精確的 JSON)
  SETUP.md    # 第一次實玩的逐步設定(玩家端 + Miyoria 端)
```

**第一次要讓她玩,照 [SETUP.md](SETUP.md) 一步一步做。** 這份 README 是背景說明與參考。

| | 版本 |
|---|---|
| Minecraft | **1.21.1**(Java 版) |
| Fabric Loader | ≥ 0.16(建置使用 0.16.14) |
| Fabric API | 0.116.17+1.21.1(或更新的 1.21.1 版) |
| Baritone | **1.11.3**(對應 Minecraft 1.21 / 1.21.1,Fabric 版) |
| AltoClef(可選) | MiranCZ 分支 0.19,`altoclef-1.21.1-0.19.jar` |
| Java | 21 |

## 1. 玩家端安裝

用一個專屬的 Minecraft 實例(例如 Prism Launcher / 官方啟動器建一個 `Miyoria-1.21.1` profile),不要跟你自己玩的混在一起。

1. 安裝 **Fabric Loader** for 1.21.1(官方安裝程式 https://fabricmc.net/use/installer/ )。
2. 把這些放進該實例的 `mods/`:
   - **Fabric API**(`fabric-api-0.116.17+1.21.1.jar` 或更新的 1.21.1 版)。
   - **Baritone**:`baritone-api-fabric-1.11.3.jar`(https://github.com/cabaletta/baritone/releases/tag/v1.11.3 ;也就是建置時 `./gradlew downloadBaritone` 抓到 `mod/libs/` 的同一個檔案)。**不要用 `baritone-standalone-fabric`**:standalone 版連 API 都混淆了,別的模組呼叫不到,miyoria-bridge 會當作沒有 Baritone(log 會出現 `baritone.api is missing`)。`api` 版是完整的 Baritone 模組,只是保留 API 不混淆。
   - **miyoria-bridge**:`mod/build/libs/miyoria-bridge-0.1.0.jar`(建置方式見 §2)。
   - 可選 **AltoClef**:`altoclef-1.21.1-0.19.jar`(https://github.com/MiranCZ/altoclef/releases/tag/0.19 )。
3. **重要:AltoClef 內建了自己的 Baritone**。只用 AltoClef 時,**不要**再放獨立的 Baritone jar(會有兩個 id 為 `baritone` 的模組而衝突);只想用 Baritone 時就不要放 AltoClef。
4. 啟動一次遊戲,進單人世界,看 `logs/latest.log` 有沒有:

```
Miyoria bridge listening on ws://127.0.0.1:7890 (token in .../config/miyoria-bridge.json)
```

沒有 Baritone 時模組仍會啟動(可以 `observe`),但 `baritone` 動作會回 `baritone_unavailable`,啟動時 log 會有警告。

## 2. 建置模組

需要 JDK 21(`JAVA_HOME` 若指向 Java 8,先改成 JDK 21;Gradle wrapper 已附上,不需要另外安裝 Gradle)。

```bash
cd extensions/minecraft/mod
export JAVA_HOME="C:/Program Files/Eclipse Adoptium/jdk-21.0.3.9-hotspot"   # Windows / Git Bash 範例
./gradlew downloadBaritone      # 第一次:抓 Baritone API jar 到 mod/libs/
./gradlew build                 # 單元測試 + 產出 build/libs/miyoria-bridge-0.1.0.jar
```

### Baritone 怎麼被解析

Baritone **沒有**發佈到公開 Maven 倉庫,官方產物是 GitHub Releases 的 jar。所以建置時編譯對象是 `mod/libs/baritone-api-fabric-<版本>.jar`(`compileOnly`,不會打包進模組,執行時由玩家安裝的 Baritone / AltoClef 提供;玩家要裝的也是這個 jar):

- `./gradlew downloadBaritone` 會從 `https://github.com/cabaletta/baritone/releases/download/v1.11.3/baritone-api-fabric-1.11.3.jar` 下載;也可以手動下載放到同一路徑。版本由 `mod/gradle.properties` 的 `baritone_version` 決定。
- jar 缺少時:`./gradlew test` **仍可執行**(改用 `src/baritoneStub/java` 裡標明「COMPILE-ONLY STUB」的最小介面,只含用到的少數型別,**不會**被打包),但 `jar` / `build` / `runClient` 會失敗並印出上述修復指示。
- 該 jar 為 LGPL-3.0,已被 `.gitignore` 排除,不進版控。

### 開發時直接跑遊戲

```bash
./gradlew runClient    # 啟動帶有 miyoria-bridge + Fabric API + Baritone(mod/libs 的 api jar)的開發客戶端
```

### 目錄

```
mod/
  build.gradle  gradle.properties  settings.gradle  gradlew(.bat)
  libs/                       # Baritone API jar(git 忽略)+ README
  src/main/java/dev/miyoria/bridge/
    protocol/   Request / Messages / Protocol         # JSON 編解碼(純 Java)
    snapshot/   SnapshotSummarizer                    # 原始狀態 → 快照 JSON(純 Java)
    events/     EventDetector                         # 每 tick 狀態 → 事件(純 Java)
    server/     BridgeServer                          # Java-WebSocket(以 jar-in-jar 內嵌),token 驗證
    config/     BridgeConfig                          # config/miyoria-bridge.json
    game/       Minecraft / Baritone / AltoClef 相關(client thread)
  src/baritoneStub/java/      # 僅在缺 Baritone jar 時使用的編譯期 stub
  src/test/java/              # JUnit:協定、快照、事件、設定、伺服器(真的 WebSocket round trip)
```

## 3. 她自己的 Minecraft 帳號

- 需要一個**擁有 Java 版**的 Microsoft 帳號,專門給她用(不要用你自己的;帳號被 ban 或被伺服器管理員盯上時才不會牽連)。
- 在該實例的啟動器登入那個帳號。**不要把帳號、密碼或 token 放進這個 repo 或 adapter 設定**;登入狀態只存在啟動器裡。
- 單人世界(最簡單)或任何允許 Baritone 的伺服器都可以。多人伺服器請先確認規則:Baritone / AltoClef 在很多伺服器上算作弊。要上伺服器時,把 Baritone 設定 `antiCheatCompatibility true`(見 §5)。
- 純測試可以用離線(offline)啟動器帳號跑單人世界,不需要正版帳號。

## 4. 設定檔

`config/miyoria-bridge.json` 第一次啟動自動建立,欄位與預設值見 `PROTOCOL.md` §1。重點:

- `port`(預設 7890)與 `token`(隨機產生)。adapter 從同一份檔案讀取。
- 只綁 `127.0.0.1`;帶 `Origin` 標頭的連線(瀏覽器)會被拒絕。
- 改完設定要重啟遊戲。

## 5. 建議的 Baritone 設定

求生反射(岩漿、溺水、窒息、落沙、反擊 / 逃跑、進食、卡住、撿東西)在模組自己的反射層(`PROTOCOL.md` §7,`miyoria-bridge.json` 的 `reflex*` 欄位);走路、挖礦的行為偏好放在 Baritone 設定裡。Baritone 讀 `<遊戲目錄>/baritone/settings.txt`(一行一個:`名稱 值`),建議:

```
allowBreak true
allowPlace true
allowSprint true
allowParkour false
allowParkourPlace false
allowInventory false
allowWaterBucketFall true
maxFallHeightNoWater 3
autoTool true
replantCrops true
avoidance true
mobAvoidanceRadius 8
smoothLook true
smoothLookTicks 10
chatControl false
prefixControl false
antiCheatCompatibility true
logAsToast false
desktopNotifications false
notificationOnPathComplete false
echoCommands false
```

- `smoothLook` 讓視角轉動像人在轉頭,直播畫面比較自然。**模組進入世界時會強制設定** `legitMine true`、`freeLook false`、`smoothLook true`、`smoothLookTicks 10`、`renderPath` / `renderGoal` / `renderSelectionBoxes false`(不作弊、看起來像人在玩;理由見 `PROTOCOL.md` §8),這裡寫相反的值會被蓋掉。
- `chatControl false` / `prefixControl false`:不讓 Baritone 攔截聊天輸入裡的 `#` 指令(我們走 API,不需要)。
- `allowParkour false`:直播時別讓她太冒險;想要更像玩家再開。
- `allowInventory false`:避免 Baritone 自己開背包整理物品。
- 設定也能在執行中用 `{"type":"baritone","command":"raw","line":"set allowBreak false"}` 調整。

AltoClef(`<遊戲目錄>/altoclef/altoclef_settings.json`)內建這些生存反射,預設即開啟,可依需要調整:`autoEat`、`mobDefense`、`dodgeProjectiles`、`avoidDrowning`、`autoMLGBucket`、`autoRespawn`、`autoReconnect`、`minimumFoodAllowed`。AltoClef 的指令前綴預設 `@`(`commandPrefix`)。若使用 AltoClef,可把 `miyoria-bridge.json` 的 `autoRespawn` 關掉,讓它自己處理(兩邊同時開也不會出事)。

## 6. 直播用的影像設定

她的視窗就是畫面來源,所以:

- **視窗化 / 無邊框視窗**(`F11` 切換全螢幕,直播時用視窗化),解析度 1920×1080 或 1280×720,固定不要縮放。全螢幕獨占會讓視窗擷取抓不到。
- **垂直同步開**、最大幀率 60;渲染距離 10–12、模擬距離 8(Baritone 尋路和 AltoClef 掃描要有足夠已載入區塊,太小會常常找不到路)。
- **FOV 80**,**視角晃動(View Bobbing)關**、「失真效果」與「FOV 效果」調到 50% 以下,觀眾比較不會暈。
- **HUD 保留**(血量、飢餓、快捷列、經驗),觀眾要看得到;`GUI 縮放` 2 或 3。聊天視窗建議開著,Baritone / AltoClef 的狀態會顯示在那裡。
- 失焦不暫停:模組預設會把「失去焦點時暫停(pauseOnLostFocus)」關掉(`disablePauseOnLostFocus`)。但**挖方塊、攻擊需要游標鎖定在遊戲視窗**,所以直播機上讓遊戲視窗保持前景、不要開選單。
- 光影 / 材質包可用(Iris + Sodium 等),畫面最後是由 OBS 擷取;這些與模組的相容性尚未實測,遇到 `screenshot` 全黑時先關光影試試。

### OBS 視窗擷取

1. 來源 → **視窗擷取(Window Capture)**,視窗選 `[javaw.exe]: Minecraft* 1.21.1 ...`。
2. 擷取方式選 **Windows 10 (1903 and up)**;關閉「擷取游標」;勾選「Client Area」(只抓遊戲畫面,不含標題列與邊框)。
3. 視窗不能最小化;被其他視窗擋住在新版擷取方式下仍能擷取。若黑畫面,改用 **Game Capture**(模式:擷取特定視窗)。
4. 音訊:Windows 11 可用「應用程式音訊擷取」只收 Minecraft 的聲音;她的語音(TTS)走另一條(見 `docs/ARCHITECTURE.md` §12.2 的 VB-Cable)。
5. 協定有 `screenshot`(縮圖給支援圖片的模型),和 OBS 擷取互不干擾;adapter 目前還沒用它(工具結果只傳文字)。

## 7. TS adapter(`adapter/`,擴充 `miyoria.minecraft`)

Core 的擴充套件主機從 `[modules.extensions] dirs`(預設 `["extensions"]`,相對於啟動 Miyoria 的資料夾)找到 `adapter/miyoria.extension.toml`(`kind = ["game-adapter","tools"]`、`game = "minecraft"`),用 `node dist/index.js` 啟動它。所以 adapter 要先建置:`pnpm --filter "@miyoria/ext-minecraft..." build`(連同 `@miyoria/sdk`)。設定放在 `miyoria.toml` 的 `[extensions."miyoria.minecraft"]`,欄位見 `adapter/config.schema.json`;最重要的是 `minecraft_dir`(遊戲實例目錄,adapter 從 `<目錄>/config/miyoria-bridge.json` 讀 port 和 token,每次重連都重讀)。沒設定時會找官方啟動器預設的 `%APPDATA%\.minecraft`,找不到 token 時 log 會警告一次並列出找過的路徑。

**任務契約**(`docs/design/v2-architecture.md` §3.8):adapter 是 `game.minecraft` 的任務執行器(`adapter.tasks`,SDK 的 `TaskRunner`;`docs/protocols/extension-rpc.md`〈任務執行器〉)。核心(遊戲導演)只選目標:每個目標是一個任務 `{id, goal, args, budget_s}`,結束時一定有一個 `game.minecraft.task.done` 或 `task.failed{code, detail}`。沒有原始的 `observe` / `act` 工具了。

| | miyoria-bridge |
|---|---|
| 目標(`describe().actions`) | 21 個:`goto`、`mine`、`follow`、`explore`、`farm`、`build`、`obtain`、`hunt`、`shelter`、`recover`、`place`、`chat`、`stop`、`look`、`attack`、`use`、`select`、`respawn`、`drop`、`launch`、`quit`,各有參數 schema 和建議的 `budget_s`;加上生存進度指南 `guide`(`adapter/src/guide.ts`,跟著執行器註冊,所以導演的 prompt 看得到)。`get`、`craft`、`smelt` 還認得(`HIDDEN_ACTIONS`),但不再給模型選 |
| `observe` | `observe` → 繁中摘要 + 精簡狀態(`busy`、`capabilities`、背包、最好的鎬能挖什麼(`pickaxe_tier`)、食物、離天黑 / 天亮幾分鐘、附近生物、看得到的方塊、合成中、正在跑的反射(`reflex`)、`obtain` 計畫的進度(`plan`)、上次死在哪裡和掉了什麼(`last_death`,6 分鐘內)…;背包是完整的,目標的成功條件從這裡讀),外加正在跑的任務 id;沒連上或在主選單時回 `connected:false` / `in_game:false`,導演就不會叫 LLM。沒連上時另有 `launch`:`{available, problem?, state: idle\|starting\|failed, error?}` |
| 任務的開頭(`act`) | 對應到 `baritone` / `altoclef` / `craft` / `smelt` / `place` / `chat` / `look` / `use` / `attack` / `select_slot` / `respawn` / `stop`;工作請求帶 `task`(任務 id)。`hello_ack.capabilities` 說沒有的模組直接失敗(`precondition`)。`mine` 先 `observe` 看背包,鎬不夠挖不到東西的方塊直接拒絕並說要先做什麼(`adapter/src/harvest.ts`)。模組的拒絕轉成告訴她下一步的繁中句子,也轉成失敗碼(`not_visible` → `not_found`、`too_far` → `unreachable`、`missing_items` / `needs_station` → `precondition`、`busy` / `reflex_active` → `busy`…,`failureCode()`) |
| `events()` | 推送事件 → `game.minecraft.<事件>`,`data.text` 是給實況用的一句話,`important` 標出值得馬上反應的(死亡、低血量、危險生物、稀有物品、別人講話、成就);另外有 `connected` / `disconnected`。工作本身的事件(`goal_reached`、`baritone_idle`、`craft_*`、`smelt_*`、`task_*`)不轉送:那是任務的事 |

**任務什麼時候結束**:模組回報任務 id 時(`capabilities.tasks`,`PROTOCOL.md` §6.1)就照模組說的:`task_done` / `task_failed{code}`(`interrupted` → `busy`,其餘同名),不再從 Baritone 的路徑事件猜。舊版模組才由 adapter 讀那件工作自己的事件:`goto` 以 `goal_reached`(`goal_failed` → `unreachable`)結束,`mine` / `build` 以 `baritone_idle` 結束(中途每一段路的 `goal_reached` 不算),`craft` / `smelt` 以 `*_finished` / `*_failed` 結束,AltoClef 的 `get` 要 AltoClef 自己也閒下來;反射打斷 → `busy`,死掉 → `died`。`follow` / `explore` / `farm` 不會自己結束:預算用完前 0.5 秒停下並算完成(`explore` 給 `find` 時看到那個方塊或生物就提早結束)。指令型的目標(`chat`、`look`、`select`、`stop`…)模組接受就完成。用身體的任務互相取代(舊的 `superseded`);`chat` 可以同時跑。被取消或逾時的任務會送 `stop` 停下模組的工作(被取代的不送,新的工作會接手)。

**`obtain {item, count, strategy?}`:取得物品只有這一個入口**。原本三條重疊的路(AltoClef 的 `get`、自寫規劃器的 `obtain`、手動 `craft` / `mine` / `smelt`)變成它的內部策略,實作都沒改:`plan`(規劃器認得這個物品時,預設)、`altoclef`(規劃器不認得、有裝 AltoClef 時)、`craft`(兩者都不行時,直接做一次這個物品)。`strategy` 可以強制指定(給之後討論「換方法」時試用)。

`plan` 策略(`adapter/src/planner.ts` + `obtain.ts`,參考 mc_aiplayer 的 GoalPlanner):程式依配方、熔爐、方塊掉落物與工具等級(`harvest.ts`)往回推,例如鐵鎬從空手:砍原木 ×4 → 做木材 ×16 → 工作台 → 放下 → 木棒 ×8 → 木鎬 → 挖鵝卵石 ×11 → 熔爐 → 放下 → 石鎬 → 挖粗鐵 ×3 → 燒鐵錠 ×3 → 鐵鎬。同一種材料一次做齊;燃料先用煤炭,不夠就把原木做成木材再燒。每一步都用一般的請求,等那一步的結束事件,再從實際背包重新規劃;看不到方塊就 `explore` 到看得到為止(最多 90 秒),太遠就先 `goto`,工作台 / 熔爐不在旁邊就走過去或放下背包裡的。同一步失敗兩次就結束並說卡在哪一步、為什麼(帶失敗碼);反射打斷的那一步會等反射結束再重做,不算失敗。每一步是任務的 `progress`,結束就是任務的 `done` / `failed`(不再有 `plan_finished` / `plan_failed` 事件)。

**做完不等於有進展**(`docs/design/v4-plan.md` §11.2,`adapter/src/progress.ts`):用身體的任務前後各看一次背包(加上這段時間的 `item_picked`),`done` 的 `data.outcome` 是 `{progressed, gained, lost, inventory, note}`(核心的 `GameTaskOutcome`)。拿東西的目標(`mine`、`farm`、`obtain`、`hunt`、`recover`…)背包有多東西才算進展;`goto` / `follow` / `build` 做完就算;`explore` 看到開始時沒看到的方塊、生物或生態域才算(在同一片海上跑滿時間不算);`obtain` 已經有的東西、空的 `mine` 都是「做完但沒有進展」。導演把沒有進展的 `done` 當成一次失敗。

**食物**(`planner.ts`、`obtain.ts`):`obtain` 認得食物:生肉靠打獵(`hunt` 步驟:跟著動物、準心對到就打、夠了就停,附近沒有先探索)、熟食用熔爐烤、`bread` 收成小麥(Baritone `farm`)再做、`melon_slice` 挖西瓜;`{item:"food"}` 依附近有的動物、作物和熔爐挑最容易的。`hunt {entity, count}` 是單獨打獵(多拿 count 個肉)。打獵靠準心:模組的 `nearby_entities` 沒有座標,動物不在準心上時只會往下看一點;模組之後給座標就會直接瞄準牠。

**天黑和死掉**(`survival.ts`):adapter 從快照看出天快黑了(黃昏或晚上,每晚一次)就送 `night_started`,不只靠模組在 13000 tick 的事件(在晚上進世界時那個不會來)。`shelter`:有床就放下來睡;沒有就往下挖三格、從裡面把方塊放在頭頂上封起來,等到天亮(預算 540 秒)。`recover`:記住死掉的位置、維度和身上的東西(死前最後一次快照的背包),走回去等撿東西,撿到了就清掉;超過 6 分鐘或不在同一個維度就不去。這兩個由導演在天黑和死後自己開始(`[modules.game] night_action` / `death_action`)。

**自己開遊戲(`launch` / `quit`)**:`game start` 時遊戲沒開,導演透過閘門開始 `launch` 任務(principal `director`,預算 `[modules.game] launch_wait_secs`,預設 240 秒;由 ActivityManager 開的就用它的 task id)。adapter 用 Prism Launcher 的 CLI 開實例:`prismlauncher --launch <實例> [--world <存檔>]`(背景、detached,Core 重開不會關掉遊戲),等模組連上;要進世界的話再等世界載入,任務才 `done`。找不到 Prism(`precondition`)、啟動器結束時回錯誤碼(`crashed`)、預算用完(`timeout`),都變成 `game start` 的失敗並說原因。Prism 執行檔:`prism_path`(或 `MIYORIA_MC_PRISM`),沒設就依序找實例資料夾旁(可攜版)、`%LOCALAPPDATA%\Programs\PrismLauncher\prismlauncher.exe`、`%PROGRAMFILES%`、`%PROGRAMFILES(X86)%`、scoop;實例 id 從 `minecraft_dir`(`…\instances\<實例>\.minecraft`)推,也可以用 `prism_instance` 指定;`launch_world` 預設 `latest`,空字串 = 停在主選單。`game stop` 取消目前目標的任務,再跑 `stop` 和 `quit`(`[modules.game] close_on_stop`);adapter 的 `quit_on_stop` 預設 `launched`:只關她自己開的遊戲。決策迴路不會自己選 `launch` / `quit`(`[modules.game] session_actions`)。

**反射**(模組,見 `PROTOCOL.md` §7):`reflex`(緊急的標成 important)和打斷了東西或沒成功的 `reflex_end` 會轉送;撿東西、沒打斷工作的進食結束不轉送。請求被 `reflex_active` 擋下時 adapter 等 `reflex_end` 再送一次:在任務裡最多等到任務的預算用完,單獨的 `act` 最多 10 秒。

**逾時**(由內而外,每一層都比它包住的那層晚放棄,見 `packages/game/src/timeouts.ts`):一個模組請求 10 秒(`request_timeout_ms`)< 導演的一次控制呼叫(observe / start / cancel)20 秒(`[modules.game] tool_timeout_secs`)< 主機的 RPC 30 秒(`[modules.extensions] call_timeout_ms`)< 任務預算 `budget_s`(目標建議的,否則 `task_budget_secs` 240 秒,不超過 `max_goal_secs`)< 主機替沒回報的任務判 `timeout`(預算 + `task_grace_ms` 5 秒)< 目標上限 `max_goal_secs` 600 秒。開遊戲另一條:`launch` 預算 240 秒 < ActivityManager `game_timeout_ms` 300 秒。

雙速控制的分工:快迴路(逐幀)在模組的反射層和 Baritone / AltoClef;慢迴路(導演 + LLM)每 `decide_secs`(預設 20 秒)、目標的任務結束時,或遇到事件(`death`、`low_health`、`advancement`、`chat`、`connected`)時才 `observe` 一次,選下一個目標並產生實況評論(敵人靠近和反射結束交給反射,不再叫醒她)。目標有成功條件(`want`:背包裡要有什麼)、失敗一次不會結束(`max_attempts` 3 次、`max_goal_steps` 8 步);導演記得這場每一步的結果和失敗碼(和事件分開一欄)。同一個做法(動作加物品,例如 `obtain:bread`)同一個失敗碼兩次就暫停 10 分鐘(`method_hold_secs`),`invalid` 的物品做法整場不再用,用完次數的目標也暫停,別的做法成功不會解除;`stop` 是即時動作,不是目標也不算成功。舊的低階防呆照舊:任務失敗後 `failure_guard_secs`(預設 45 秒)內不送 `guarded_actions`(預設 `goto`、`mine`、`look`、`attack`),只有真的有進展才提早解除。每個結束的目標都發 `game.director.goal`,帶結束碼(`done` / `reported` / `gave_up` / `no_progress` 或任務的失敗碼);達成的目標把有進展的步驟記成技能(`game.director.skill`),下次同樣的東西會放進 prompt。

## 8. 疑難排解

| 現象 | 處理 |
|---|---|
| log 顯示 `could not bind 127.0.0.1:7890` | 埠被占用,改 `config/miyoria-bridge.json` 的 `port` |
| 連上後立刻被關(close 1008) | 第一則不是 `hello`、5 秒內沒送、token 錯誤 |
| `not_in_game` | 還在主選單或載入畫面,等進入世界後再下動作 |
| `baritone_unavailable` | `mods/` 沒有 Baritone(或用了 AltoClef 又另外放了獨立 Baritone 造成衝突) |
| log 有 `baritone.api is missing` | 裝成了 `baritone-standalone-fabric`,換成 `baritone-api-fabric-1.11.3.jar` |
| adapter log `no miyoria-bridge token` / `the mod refused the connection` | `[extensions."miyoria.minecraft"] minecraft_dir` 沒設或指錯資料夾(要指到含 `config/` 的那層) |
| `altoclef_unavailable` | 沒裝 AltoClef,或剛進世界還沒初始化,或版本 API 不同 |
| `goto` 一直 `goal_failed` | 目標區塊沒載入或不可達;調高渲染距離、確認 `allowBreak` / `allowPlace` 設定 |
| `screenshot` 全黑 | 關掉光影再試;確認視窗未最小化 |
| 建置時 `Baritone API jar not found` | 執行 `./gradlew downloadBaritone` |

## 9. 驗證狀態

已驗證:Gradle 建置(Windows、Temurin JDK 21)、JUnit 62 項(協定、快照、事件偵測、反射決策、設定、WebSocket 驗證與請求回覆 round trip)、對真實 Baritone 1.11.3 API jar 的編譯、缺 jar 時的失敗訊息與 stub 測試路徑;adapter 的 Vitest(對假 mod 的連線、重連、token、動作對應、事件與目標完成判斷,以及透過 SDK runtime 的整個擴充)與擴充探索(`miyoria ext list` 找得到 `miyoria.minecraft`)。

**尚未在真實遊戲裡驗證**(需要 Minecraft 帳號與圖形環境):所有與遊戲互動的行為,包含 `observe` 的實際內容、Baritone / AltoClef 動作、`use` / `attack` 按鍵模擬、`screenshot` 擷取、`advancement` / `chat` 事件解析,以及 AltoClef 的反射呼叫(已對照 `altoclef-1.21.1-0.19.jar` 的方法簽名撰寫,未實跑)。第一次實機測試請從 `observe` 與 `baritone goto` 開始。

**自主能力(自己開遊戲、反射層、`obtain` 規劃器、失敗防呆,2026-11-03)**:只在測試裡驗證過,遊戲裡還沒實跑。已驗證:反射的決策邏輯(JUnit:觸發條件、優先順序與接手、結束的遲滯、冷卻、卡住偵測、撿東西的時間窗、`yieldNonUrgent`)、模組對真實 Baritone 1.11.3 與 Minecraft 1.21.1 的編譯和缺 jar 的 stub 路徑;adapter 的 Vitest:啟動器(假的 process:參數、`--world latest`、錯誤碼、逾時、`quit_on_stop`、找 Prism 的路徑)、`launch` / `quit` 對假 mod、規劃器(鐵鎬的完整步驟、已有的東西、燃料、工具等級、tag 材料)、計畫執行器對假世界(從空手做木鎬、看不到就探索、太遠就走過去、反射打斷後重做、取消)、`reflex_active` 重試與反射事件文字;導演的 Vitest:自己開遊戲(連上並等世界載入、啟動器失敗、逾時、拒絕)、停止時送 `quit`、失敗防呆。**沒驗證**:真的開 Prism(這台的 `prismlauncher.exe` 沒有實際執行過)、`--world` 是否直接進入世界、`quit` 是否正常存檔關閉;所有反射在遊戲裡的實際動作(逃離岩漿的路線、挖開窒息方塊、按鍵移動、攻擊、進食的快捷列交換、Baritone `GoalRunAway`、撿東西);`obtain` 在真的世界裡跑完整條鐵鎬路線。

**不作弊與生存進度(`craft` / `smelt` / `place`、可見性、Baritone legit 設定)**:可見性判斷(JUnit)、快照欄位、adapter 的對應 / 鎬等級拒絕 / 錯誤與事件文字(Vitest)、對真實 Baritone 1.11.3 API jar 與 Minecraft 1.21.1 的編譯與建置已驗證;遊戲裡的實際行為還沒實跑。實機要看:新世界 `observe` 不再列出埋在地下的礦、`mine diamond_ore` 沒鐵鎬被拒、`mine oak_log` 只砍看得到的樹且砍完會停(`reason:"nothing_visible"`)而不是往下挖、`craft oak_planks` / `crafting_table` 打開背包合成、`place crafting_table` 後 `craft wooden_pickaxe` 會轉頭打開工作台、`smelt raw_iron` 放進熔爐再 `smelt` 拿出鐵錠、Baritone 走路時鏡頭跟著轉而且轉得平順、畫面上沒有路線線條。
