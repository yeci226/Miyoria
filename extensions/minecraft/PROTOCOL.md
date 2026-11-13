# miyoria-bridge 通訊協定(protocol 1,含任務 id 擴充)

`miyoria-bridge` 是裝在 Minecraft 1.21.1 客戶端裡的 Fabric 模組,在本機開一個 WebSocket 伺服器。TS adapter(`extensions/minecraft/adapter`)連上來,把它包成 `GameAdapter` 的 `describe / observe / act / events`。

- 位址:`ws://127.0.0.1:<port>`(預設 `7890`;只綁 loopback,不會對外)。
- 每則訊息是一個 **文字 frame,內容為單一 JSON 物件**(UTF-8,單則上限 1 MiB)。
- 所有遊戲存取都在 Minecraft 的 client thread 執行;回覆用 `id` 對應請求,可以亂序抵達。
- 不接受帶 `Origin` 標頭的連線(瀏覽器網頁不能連進來)。Node 的 `ws` 預設不送 `Origin`,沒問題。

## 1. 設定檔與 token

第一次啟動時模組會建立 `<遊戲目錄>/config/miyoria-bridge.json`:

```json
{
  "port": 7890,
  "token": "隨機產生的 32 字元",
  "entityRadius": 24,
  "blockScanRadius": 16,
  "maxEntities": 16,
  "maxBlockKinds": 20,
  "lowHealthThreshold": 6.0,
  "hostileRadius": 16.0,
  "autoRespawn": true,
  "autoRespawnDelayTicks": 40,
  "disablePauseOnLostFocus": true,
  "screenshotMaxWidth": 640,
  "reflexes": true,
  "reflexFight": true,
  "reflexPickup": true,
  "reflexFleeHealth": 8.0,
  "reflexEatFood": 14,
  "reflexEatFoodBusy": 6,
  "reflexStuckSecs": 20
}
```

| 欄位 | 說明 |
|---|---|
| `port` | 本機 WebSocket 埠(1024–65535) |
| `token` | 共享密鑰,連線後第一則訊息必須帶它。長度不足 16 會自動重新產生 |
| `entityRadius` | `observe` 的附近生物半徑(格),4–64 |
| `blockScanRadius` | 掃描「值得注意的方塊」的水平半徑,4–32(垂直為其與 12 取小) |
| `maxEntities` / `maxBlockKinds` | `observe` 回傳的生物數 / 方塊種類上限 |
| `lowHealthThreshold` | 血量(點數,20 = 10 顆心)小於等於此值時推送 `low_health` |
| `hostileRadius` | 敵對生物進入此距離時推送 `hostile_near` |
| `autoRespawn` | 死亡後自動按「重生」(等 `autoRespawnDelayTicks` 讓 `death` 事件先送出) |
| `disablePauseOnLostFocus` | 視窗失焦時不暫停遊戲(她在背景玩、你在別的視窗時需要) |
| `screenshotMaxWidth` | `screenshot` 預設縮圖寬度 |
| `reflexes` | 反射層(§7)總開關;舊的設定檔沒有這些欄位時用預設值 |
| `reflexFight` / `reflexPickup` | 被怪靠近時反擊(關掉就只逃)/ 工作結束後撿看得到的掉落物 |
| `reflexFleeHealth` | 血量小於等於此值時逃跑而不是反擊(0–20) |
| `reflexEatFood` / `reflexEatFoodBusy` | 閒著時飢餓 ≤ 前者就吃;≤ 後者時停下手上的事去吃 |
| `reflexStuckSecs` | Baritone 在走路卻這麼多秒沒移動(也沒在挖方塊)就算卡住(5–300) |

adapter 應該從這個檔案讀 `port` 與 `token`(同一台機器上)。

## 2. 連線流程

1. 連上 WebSocket。
2. **第一則訊息必須是 `hello`**,5 秒內沒送、送別的、token 錯誤,伺服器會回一則 `error` 然後以 close code `1008` 斷線。

```json
{"type":"hello","token":"<token>","client":"miyoria-adapter"}
```

3. 成功時回:

```json
{
  "type": "hello_ack",
  "protocol": 1,
  "mod_version": "0.1.0",
  "minecraft": "1.21.1",
  "capabilities": { "baritone": true, "altoclef": false, "screenshot": true, "tasks": true }
}
```

`capabilities.baritone` / `altoclef` 表示對應模組在執行時有沒有安裝。`capabilities.tasks: true` 表示模組支援任務 id(§6.1);舊版模組沒有這個欄位,client 要自己從事件判斷工作結束。之後可以重送 `hello`(冪等)。

4. 之後就是「請求 → 回覆」與伺服器主動推送的事件。

## 3. 訊息格式

### 3.1 請求(client → mod)

```json
{"id":"42","type":"<動作>", ...參數}
```

- `id`:字串或數字,可省略;有的話會原樣放進回覆。其他型別的 `id` 會被忽略。
- `type`:見 §5。

### 3.2 回覆(mod → client)

成功:

```json
{"type":"result","id":"42","ok":true,"data":{ ... }}
```

失敗:

```json
{"type":"result","id":"42","ok":false,"error":{"code":"invalid_args","message":"slot must be 0-8"}}
```

連線層級的錯誤(JSON 壞掉、認證失敗,無法對應到請求)用:

```json
{"type":"error","error":{"code":"bad_json","message":"not valid JSON"}}
```

### 3.3 事件(mod → client,主動推送)

```json
{"type":"event","name":"damage","time":1730000000000,"data":{ ... }}
```

`time` 是 Unix epoch 毫秒。事件只送給已通過 `hello` 的連線。

### 3.4 錯誤碼

| code | 意思 |
|---|---|
| `bad_json` | 不是合法 JSON |
| `bad_request` | 不是 JSON 物件,或缺 `type` |
| `unauthorized` | 沒先 `hello` / token 錯誤(之後會斷線) |
| `unknown_type` | 不認得的請求 `type` |
| `invalid_args` | 參數缺漏或型別 / 範圍錯誤 |
| `not_in_game` | 還在主選單或載入中,沒有玩家 / 世界 |
| `game_paused` | 單人遊戲在暫停選單中;`mine`、`craft`、`smelt` 會被拒絕(Baritone 查方塊掉落物要等內建伺服器,暫停時會讓整個遊戲卡死) |
| `not_visible` | 附近沒有她**看得到**的那種方塊(`goto {block}`、`mine`;不會透視)。訊息:`no <id>[/<id>…] in sight within <N> blocks` |
| `too_far` | 看得到,但太遠(`mine` 要 10 格內,工作台 / 熔爐要伸手搆得到)。訊息:`nearest <id> in sight is <N> blocks away at <x>,<y>,<z>` |
| `missing_items` | 背包裡的東西不夠(`craft`、`smelt`、`place`)。訊息:`missing <item> x<n>[, …]`,`<item>+` 表示「或同類」(例如任何木材),`fuel` 表示燃料;配方另外要工作台時後面接 `; also needs a crafting_table within reach` |
| `needs_station` | 要工作台(3x3 配方)或熔爐,但附近看不到。訊息:`needs a <crafting_table\|furnace> within reach; none in sight` |
| `busy` | 上一個 `craft` / `smelt` 還在做 |
| `reflex_active` | 反射(§7)正在用她的身體(逃離岩漿、反擊、吃東西…);移動身體的請求(`baritone`、`altoclef`、`look`、`use`、`attack`、`select_slot`、`place`、`craft`、`smelt`)等 `reflex_end` 再送。訊息:`busy with a reflex: <kind>` |
| `baritone_unavailable` | 沒有安裝 Baritone |
| `altoclef_unavailable` | 沒有安裝 AltoClef(或還沒初始化 / API 不符) |
| `screenshot_failed` | 擷取或編碼失敗 |
| `internal` | 模組內部例外 |

### 3.5 識別碼慣例

方塊、物品、生物、維度、生物群系的 id 一律 **省略 `minecraft:` 命名空間**(`iron_ore`、`zombie`、`the_nether`)。其他模組的 id 保留完整(`modid:thing`)。輸入也接受完整 id。

## 4. `observe` 回傳的快照

請求:`{"id":"1","type":"observe"}`。回覆的 `data` 長這樣(欄位順序不保證):

```json
{
  "health": 17.5,
  "max_health": 20.0,
  "food": 18,
  "saturation": 4.3,
  "air": 300,
  "position": { "x": 100.46, "y": 64.0, "z": -20.2 },
  "block_position": { "x": 100, "y": 64, "z": -21 },
  "yaw": 91.3,
  "pitch": -12.3,
  "dimension": "overworld",
  "biome": "plains",
  "time_of_day": 6000,
  "time_phase": "day",
  "is_night": false,
  "weather": "clear",
  "held_item": { "item": "iron_pickaxe", "count": 1, "durability_pct": 88, "slot": 0 },
  "inventory": { "apple": 3, "cobblestone": 84, "iron_pickaxe": 1 },
  "inventory_free_slots": 32,
  "hotbar": [ { "item": "iron_pickaxe", "count": 1, "durability_pct": 88 }, null, null, { "item": "cobblestone", "count": 64 }, null, null, null, null, null ],
  "armor": {
    "head": { "item": "iron_helmet", "count": 1, "durability_pct": 50 },
    "chest": null,
    "legs": null,
    "feet": null
  },
  "offhand": null,
  "looking_at": { "kind": "block", "block": "oak_log", "position": { "x": 5, "y": 64, "z": -3 }, "face": "north", "distance": 2.4 },
  "nearby_entities": [
    { "type": "zombie", "distance": 3.0, "hostile": true },
    { "type": "player", "name": "Steve", "distance": 8.0, "hostile": false },
    { "type": "cow", "distance": 12.0, "hostile": false }
  ],
  "nearby_entities_total": 3,
  "hostile_count": 1,
  "nearby_blocks": [
    { "block": "diamond_ore", "count": 2, "nearest": { "x": 30, "y": 12, "z": 30 }, "distance": 40.0 },
    { "block": "chest", "count": 1, "nearest": { "x": 1, "y": 64, "z": 1 }, "distance": 5.0 }
  ],
  "baritone": { "available": true, "busy": true, "process": "Mine", "goal": "GoalBlock{x=1,y=2,z=3}" },
  "altoclef": { "available": false, "busy": null },
  "crafting": null,
  "reflex": { "active": null }
}
```

欄位說明:

- `time_of_day`:0–23999 ticks。`time_phase`:`day`(0–11999)、`dusk`(12000–12999)、`night`(13000–22999)、`dawn`(23000–23999)。`is_night` 只在主世界(`overworld`)可能為 `true`。
- `weather`:`clear` / `rain` / `thunder`。
- `held_item` 沒拿東西時為 `null`;`durability_pct` 只有會損耗的物品才有(剩餘百分比)。
- `inventory`:物品 id → 總數(整個背包 + 快捷列加總,依 id 排序);`hotbar` 是 9 格,空格為 `null`;`armor` / `offhand` 空的為 `null`。
- `looking_at`:準心指到的東西。`kind` 為 `block` / `entity` / `none`。方塊有 `block`、`position`、`face`、`distance`;生物有 `entity`(型別)、`name`(玩家或有自訂名稱時)、`position`、`distance`。
- `nearby_entities`:只含活的生物(不含自己、盔甲架),依距離排序,最多 `maxEntities` 個;`hostile` 為 Minecraft 的 `Monster` 分類(殭屍、骷髏、苦力怕、史萊姆、幻翼……)。`nearby_entities_total` 是截斷前的總數。`name` 只在玩家或有自訂名稱時出現。
- `nearby_blocks`:`blockScanRadius` 內**她看得到的**「值得注意的方塊」(礦石、原木、石頭 / 沙子 / 礫石 / 黏土、箱子 / 桶 / 終界箱 / 界伏盒、工作台 / 熔爐 / 鐵砧等工作站、床、地獄 / 終界傳送門、刷怪磚、岩漿、可收成作物等),依方塊種類分組,每種給出數量與最近一個的座標。「看得到」= 有一面朝向她、旁邊不是不透明的完整方塊,而且從她眼睛到那一面中心的直線沒有被不透明的完整方塊擋住(樹葉、玻璃、水不擋);埋在石頭裡的礦**不會**出現(不透視)。每種只檢查最近的 24 個,所以 `count` 是「最近的那些裡看得到幾個」。排序:鑽石 / 遠古殘骸 → 其他礦石 / 原木 / 刷怪磚 → 箱子 / 岩漿 / 傳送門 → 其他;同級依距離。最多 `maxBlockKinds` 種。
- `crafting`:`craft` / `smelt` 工作進行中時是 `{"kind":"craft"|"smelt","item":<成品 / 要燒的東西,只拿東西時為 null>}`,沒有時為 `null`。
- `reflex.active`:正在跑的反射(§7:`lava`、`suffocation`、`falling_block`、`drowning`、`flee`、`fight`、`eat`、`unstuck`、`pickup`),沒有時為 `null`。
- `baritone.busy`:Baritone 目前有沒有在執行(尋路或某個流程在控制);`process` 是流程名稱(例如 `Mine`、`Follow`、`Explore`、`Farm`、`Custom Goal`),`goal` 是目前目標的字串表示。沒有安裝 Baritone 時 `available:false`。
- `altoclef.busy`:AltoClef 使用者任務是否在跑;無法判斷時為 `null`。

## 5. 動作(請求)

所有動作的回覆都是 `{"type":"result","id":..,"ok":true,"data":{..}}`;`data` 見各小節。動作只是**開始**執行,不會等到做完——完成與否看事件(§6)或再 `observe`。

**任務 id**(選填,向下相容):會開始一件「工作」的請求——`baritone`(`goto` / `mine` / `follow` / `explore` / `farm` / `build` / `raw`)、`altoclef`、`craft`、`smelt`——可以多帶 `"task": "<1–64 字元>"`。請求被接受後模組送 `task_started`,工作結束時送 `task_done` 或 `task_failed`(§6.1)。不帶 `task` 的請求行為跟以前完全一樣;舊版模組會忽略這個欄位。`task` 不是字串或長度不對回 `invalid_args`(工作不會開始)。

### 5.1 `ping`

`{"id":"1","type":"ping"}` → `data: {"time": <epoch ms>}`。不需要在遊戲世界裡也能回。

### 5.2 `baritone`

透過 Baritone 的 Java API 執行(**不是**送聊天訊息)。`command` 決定參數:

| command | 參數 | 說明 |
|---|---|---|
| `goto` | `{x,y,z}` 或 `{x,z}` 或 `{block}`;可選 `near`(搭配 xyz,走到該點 `near` 格內) | 走到座標 / 只管水平座標 / 走到 `blockScanRadius` 內最近一個**她看得到的**某種方塊旁(`GoalGetToBlock`;不是 Baritone 的 GetToBlock 流程,那個會查區塊快取 = 透視)。沒有回 `not_visible` |
| `mine` | `blocks`: 方塊 id 陣列(或單一 `block`);可選 `count`(預設 0 = 一直挖到停止) | 蒐集 / 挖掘,Baritone `legitMine` 模式:只挖看到過的方塊,挖的途中看到新的會加進來。開始前 10 格內(Baritone legit 模式看得到的範圍)要至少看得到一個,否則回 `too_far`(更遠處看得到)或 `not_visible`。看得到的都挖完時 Baritone 原本會往下挖到 `legitMineYLevel` 盲挖礦道,模組會把它停掉(`baritone_idle` 帶 `reason:"nothing_visible"`) |
| `follow` | `player`: 玩家名稱,或 `entity`: 生物型別 | 跟隨 |
| `explore` | 可選 `x`,`z`(預設目前位置) | 以該點為中心探索未探索的區域 |
| `farm` | 可選 `range`(預設 0) | 自動收割並重新種植附近作物 |
| `build` | `schematic`: `baritone/schematics` 內的檔名;可選 `x`,`y`,`z` 原點 | 蓋建築(內部用 Baritone 的 `build` 指令) |
| `stop` | 無 | 取消 Baritone 目前所有工作(也接受 `cancel`) |
| `raw` | `line`: Baritone 指令字串(不含前綴),例如 `"set allowBreak true"` | 逃生口,直接丟給 Baritone 指令管理器 |

範例:

```json
{"id":"2","type":"baritone","command":"goto","x":120,"y":64,"z":-30}
{"id":"3","type":"baritone","command":"goto","block":"crafting_table"}
{"id":"4","type":"baritone","command":"mine","blocks":["iron_ore","deepslate_iron_ore"],"count":12}
{"id":"5","type":"baritone","command":"follow","player":"Steve"}
{"id":"6","type":"baritone","command":"explore"}
{"id":"7","type":"baritone","command":"stop"}
```

回覆 `data` 會回顯 `command`,以及 `goal`(goto;`goto {block}` 另有目標方塊的 `position`)、`blocks`/`count`/`first`(mine;`first` 是看得到的最近一個)等。參數錯誤回 `invalid_args`。

### 5.3 `altoclef`

```json
{"id":"8","type":"altoclef","command":"get iron_pickaxe"}
```

等同在聊天輸入 `@get iron_pickaxe`(前綴 `@` 可寫可不寫)。模組透過 AltoClef 自己的指令執行器(以反射呼叫,**不是**編譯期依賴)執行,所以 AltoClef 的指令集完全可用(`get`、`goto`、`stop`、`gamer`、`give`……)。沒安裝回 `altoclef_unavailable`;指令解析失敗回 `invalid_args`。`data: {"command":"get iron_pickaxe","dispatched":"@get iron_pickaxe"}`。

### 5.4 `chat`

```json
{"id":"9","type":"chat","message":"大家好"}
{"id":"10","type":"chat","message":"/time set day"}
```

以 `/` 開頭視為指令。長度 1–256。若同時裝了 AltoClef,以 `@` 開頭的訊息會被 AltoClef 攔截當指令。

### 5.5 `look`

```json
{"id":"11","type":"look","yaw":90,"pitch":0}
{"id":"12","type":"look","at":{"x":10,"y":65,"z":3}}
{"id":"13","type":"look","at":{"x":10,"y":65,"z":3},"smooth":false}
```

`yaw` / `pitch` 單位為度(Minecraft 慣例:`yaw 0` 朝 +Z / 南,`90` 朝 -X / 西;`pitch` -90 朝上、+90 朝下)。只給其中一個時另一個保持不變。`at` 為看向某個世界座標。`smooth` 預設 `true`:每 tick 最多轉 24°,看起來像人在轉頭;`false` 直接瞬間轉。`data: {"yaw","pitch","smooth"}`(目標值)。

### 5.6 `use` / `attack`

```json
{"id":"14","type":"use"}
{"id":"15","type":"use","hold_ticks":32}
{"id":"16","type":"attack"}
{"id":"17","type":"attack","hold_ticks":60}
```

`use` = 右鍵(吃東西、放方塊、開門、丟雪球……),`attack` = 左鍵(攻擊、開始挖掘)。不帶 `hold_ticks` 時等同按一下;`hold_ticks`(1–1200)則按住那麼多 tick(20 tick = 1 秒),例如吃東西要按住約 32 tick、挖方塊要按住到挖斷。按住期間可用 `stop` 提早放開。這兩個動作作用在準心指到的東西上,先用 `look` 對準。`data: {"action","hold_ticks"}`。

注意:左鍵挖方塊需要遊戲視窗取得游標鎖定(畫面是第一人稱而不是開著選單)。

### 5.7 `select_slot`

```json
{"id":"18","type":"select_slot","slot":2}
{"id":"19","type":"select_slot","item":"diamond_pickaxe"}
```

選擇快捷列第 `slot`(0–8)格,或選擇快捷列裡第一個該物品。`data: {"slot","item"}`。找不到物品回 `invalid_args`。

### 5.8 `respawn`

`{"id":"20","type":"respawn"}` → 已死亡時按「重生」。`data: {"respawned": true|false}`。預設 `autoRespawn` 已經會自動做。

### 5.9 `stop`

`{"id":"21","type":"stop"}` → 取消 Baritone、停止 AltoClef 任務(`@stop`)、中止進行中的 `craft` / `smelt`(關掉畫面,送 `craft_failed` / `smelt_failed`,`cancelled:true`)、放開所有按住的按鍵、取消進行中的轉頭。`data: {"baritone": bool, "altoclef": bool}`(表示對應模組有沒有裝)。

### 5.10 `screenshot`

```json
{"id":"22","type":"screenshot","max_width":640,"format":"jpeg","quality":0.8}
```

在 render thread 從 framebuffer 讀取目前畫面(含 HUD),縮小(絕不放大)後編碼成 PNG(預設)或 JPEG,以 base64 回傳。參數:`max_width`(預設用設定檔 `screenshotMaxWidth`,64–3840)、`format`(`png` | `jpeg`)、`quality`(JPEG,0–1)。

```json
{"type":"result","id":"22","ok":true,"data":{
  "mime":"image/jpeg","width":640,"height":360,
  "source_width":1920,"source_height":1080,
  "data_base64":"/9j/4AAQ..."
}}
```

### 5.11 `craft`

```json
{"id":"23","type":"craft","item":"oak_planks","count":4}
{"id":"24","type":"craft","item":"wooden_pickaxe"}
```

像玩家一樣合成:2x2 能做的配方在背包的合成格做(會打開背包畫面,觀眾看得到),3x3 配方要她**伸手搆得到、看得到**的工作台(先轉頭看它、右鍵打開)。用格子點擊把材料一格一格放上去、shift 點成品拿走,做完關掉畫面;每一下都由伺服器檢查,不會無中生有。`count` 是想要的成品數(1–64,預設 1),會做 `ceil(count / 每次產量)` 次,材料不夠時只做得到的次數。只處理一般的有形 / 無形配方(不含煙火、地圖複製這類特殊配方)。開始前會先停下 Baritone、放開按鍵。

`data: {"item","count","crafts","table": bool}`(預計做出的數量)。工作在之後的 tick 進行,結束時送 `craft_finished` / `craft_failed`(§6)。拒絕:`invalid_args`(未知物品、沒有任何配方做得出來、已開著別的畫面)、`missing_items`、`needs_station` / `too_far`(要工作台)、`busy`、`game_paused`。

### 5.12 `smelt`

```json
{"id":"25","type":"smelt","item":"raw_iron","count":3}
{"id":"26","type":"smelt","item":"oak_log","count":4,"fuel":"oak_planks"}
{"id":"27","type":"smelt"}
```

用她搆得到、看得到的熔爐(`furnace`):打開、先把輸出格燒好的東西 shift 點出來、把 `item`(`count` 預設背包裡全部,最多 64)放進輸入格、放燃料、關掉。熔爐關著也會繼續燒(每個 10 秒),燒好要再送一次 `smelt`(不帶 `item` = 只拿東西)。燃料沒指定時依序挑:煤炭 / 木炭 → 煤炭磚 → 木材 → 原木 → 木棒(不會拿要燒的那個東西),數量剛好夠燒完。輸入格裡有別的東西還沒燒完時會失敗。

`data: {"furnace":{x,y,z},"item","count","fuel","fuel_count"}`(只拿東西時只有 `furnace`)。結束時送 `smelt_finished` / `smelt_failed`。拒絕同 `craft`(`needs_station` / `too_far` 指熔爐;沒有燃料是 `missing_items` 的 `fuel x1`)。

### 5.13 `place`

```json
{"id":"28","type":"place","item":"crafting_table"}
```

把背包裡的一個方塊放在她腳邊:先找面向的那一格,再左右、後面,然後兩格外;要是空的(或可取代,例如草)、下面是實心而且點了不會開畫面的方塊、不和她的身體重疊。物品在快捷列就直接選那一格,在背包上半部就用快捷列交換點擊換到目前選的格子。會轉頭看那裡、揮手。`data: {"item","position":{x,y,z}}`。拒絕:`invalid_args`(不是方塊、旁邊沒有空位、遊戲不讓放)、`missing_items`。

### 5.14 `quit`

```json
{"id":"29","type":"quit"}
```

關掉遊戲,跟按視窗的關閉鈕一樣(離開世界時單人世界會存檔,然後客戶端結束)。在主選單也可以。先回 `data: {"quitting": true}` 再關,之後連線會斷。adapter 只在 `quit_on_stop` 允許時才送(預設只關她自己開的遊戲)。

### 5.15 `drop`

```json
{"id":"30","type":"drop","item":"rotten_flesh","all":true}
```

把背包裡的東西丟出去(丟在她面前,也就是給面前的玩家):`item` 找第一格有這個物品的,或 `slot`(0–35,0–8 是快捷列),都沒給就丟手上那格。`all`(預設 `true`)丟一整組,`false` 只丟一個。要先關掉畫面;是會動到身體的請求,反射進行中會等它結束。`data: {"slot","item","count"}`(那格是空的時只有 `slot` 和 `count:0`)。拒絕:`missing_items`(背包裡沒有這個物品)、`invalid_args`(`slot` 超出範圍、開著畫面、已經死了)。

## 6. 事件

| name | 何時送出 | `data` |
|---|---|---|
| `death` | 玩家死亡(每次死亡一次) | `{"dimension","position":{x,y,z},"last_damage_source","last_attacker"?}` |
| `damage` | 血量下降 | `{"amount","source","attacker"?,"health"}`;`source` 是傷害類型(`mob`、`arrow`、`fall`、`lava`、`drown`、`player`、`explosion`……,取不到為 `"unknown"`),`attacker` 是攻擊者型別或玩家名 |
| `low_health` | 血量降到 `lowHealthThreshold` 以下(要先回復超過門檻 +4 才會再次觸發) | `{"health","threshold","food"}` |
| `hostile_near` | 有新種類的敵對生物進入 `hostileRadius`(同種類 5 秒冷卻) | `{"count","entities":[{type,distance}...最多8],"new_types":[..]}` |
| `item_picked` | 背包中某物品總數增加(約 0.5 秒合併一次;合成、從箱子取出也算) | `{"items":{"oak_log":3,"apple":1}}` |
| `night_started` | 主世界時間跨過 13000(上線時已是夜晚不會觸發) | `{"time_of_day"}` |
| `chat` | 收到聊天或系統訊息 | `{"sender": string\|null,"message","system": bool,"self": bool}`;`system:true` 表示伺服器 / 遊戲訊息(死亡訊息、玩家加入離開等),`self` 表示是她自己說的 |
| `advancement` | 她自己達成成就(解析聊天裡的成就公告,所以伺服器要開 `announceAdvancements`) | `{"kind":"task"\|"goal"\|"challenge","title"}` |
| `goal_reached` | Baritone 抵達路徑目標 | `{"goal"}` |
| `goal_failed` | Baritone 找不到路徑 | `{"reason":"no_path","goal"}` |
| `baritone_idle` | (額外)Baritone 從忙碌變成閒置(連續閒置 10 tick 才送,過濾路段切換的抖動)。挖礦做完、跟隨目標消失這類沒有 `goal_reached` 的流程用它判斷結束 | `{"process","goal","cancelled": bool,"reason"?}`;`cancelled` 表示是我們送了 `stop`(或 `craft` / `smelt` 開始前停下);`reason:"nothing_visible"` 表示 `mine` 看得到的都挖完了,模組停掉了 Baritone 的盲挖 |
| `craft_finished` | `craft` 做完(材料中途用完也算,做多少算多少) | `{"item","crafted","requested"}` |
| `craft_failed` | `craft` 做不下去 | `{"item","crafted","requested","error","cancelled"?}`;`error` 例如 `ran out of <item>`、`inventory full`、`could not open the crafting_table`、`the screen was closed`、`stopped` |
| `smelt_finished` | `smelt` 放好 / 拿好了(熔爐之後繼續燒) | `{"collected"?:{item:n},"item"?,"count"?,"fuel"?,"fuel_count"?,"ready_in_secs"?}` |
| `smelt_failed` | `smelt` 做不下去 | `{"error","collected"?,"cancelled"?}`;例如 `the furnace is still smelting <item>` |
| `reflex` | 一個反射開始用她的身體(§7) | `{"kind","interrupted","health","target"?,"food"?}`;`interrupted` 是被打斷的工作(Baritone 流程名例如 `Mine`、`craft`、`smelt`、按住的按鍵 `hold`),沒打斷東西為 `null`;`target` 是反擊 / 逃離的生物,`food` 是要吃的東西 |
| `reflex_end` | 反射結束 | `{"kind","ok","interrupted","secs","yielded"?}`;`ok:false` 是沒成功(逾時、被更緊急的反射接手);`yielded:true` 表示讓給了一個請求或 `stop` |

`goal_reached` 對應 `goto` 類目標;`mine` / `follow` / `explore` / `farm` 沒有「到達」的概念,結束時只會有 `baritone_idle`。注意 `goal_reached` / `goal_failed` 來自 Baritone 的 `PathEvent`(`AT_GOAL` / `CALC_FAILED`),**每一段路**都會送:挖礦時每走到一顆礦、`follow` 每次追上、AltoClef 子任務之間都會出現。用任務 id(§6.1)就不用自己解讀:模組知道自己下的是哪種工作,直接說結束了沒有。工作有任務 id 時,`goal_reached`、`goal_failed`、`baritone_idle`、`craft_*`、`smelt_*` 的 `data` 也會多一個 `task`。

### 6.1 任務生命週期(`capabilities.tasks`)

一次只有一個任務(她只有一個身體):新的工作請求會取代正在跑的任務(舊的送 `task_failed` / `superseded`)。

| name | 何時 | `data` |
|---|---|---|
| `task_started` | 帶 `task` 的工作請求被接受了(在 `result` 之後) | `{"task","kind"}`;`kind` 是 `goto`、`mine`、`follow`、`explore`、`farm`、`build`、`raw`、`altoclef`、`craft`、`smelt` |
| `task_progress` | 工作中的一步(目前:`mine` / `build` 等走到一個路徑目標) | `{"task","kind","detail"}` |
| `task_done` | 做完了 | `{"task","kind","detail", ...}`;`craft` / `smelt` 另有 `item`、`crafted`、`requested`、`ready_in_secs`(有的話) |
| `task_failed` | 做不下去 | `{"task","kind","code","message"}` |

什麼算結束(模組自己判斷,client 不用猜):

| kind | `task_done` | `task_failed` |
|---|---|---|
| `goto` | Baritone 抵達**這個**目標(`AT_GOAL`) | `unreachable`(找不到路)、`cancelled`(被停下) |
| `mine`、`build`、`follow`、`explore`、`farm`、`raw` | Baritone 從忙碌變閒置(`detail` `nothing more in sight` = 看得到的都挖完了);路徑中途的 `AT_GOAL` 只是 `task_progress` | `cancelled`、`interrupted` |
| `altoclef` | AltoClef **自己**閒置 10 tick(Baritone 在子任務之間的閒置不算);100 tick 內都沒開始忙 = 沒事可做,也算完成 | `cancelled` |
| `craft`、`smelt` | `craft_finished` / `smelt_finished` | `precondition`(材料用完、背包滿了…,`message` 是原因)、`cancelled` |

所有任務共通的失敗:`superseded`(新的工作請求取代了它)、`cancelled`(`stop`、Baritone `stop`、AltoClef `@stop`)、`interrupted`(反射 §7 打斷了它)、`died`(她死了)。client 斷線時模組不再追蹤(沒有人在等)。

```json
{"id":"30","type":"baritone","command":"mine","blocks":["iron_ore"],"count":3,"task":"01JTASK"}
{"type":"result","id":"30","ok":true,"data":{"command":"mine","blocks":["iron_ore"],"count":3,"first":{"x":1,"y":2,"z":3}}}
{"type":"event","name":"task_started","time":1730000000000,"data":{"task":"01JTASK","kind":"mine"}}
{"type":"event","name":"goal_reached","time":1730000001000,"data":{"goal":"GoalComposite","task":"01JTASK"}}
{"type":"event","name":"task_progress","time":1730000001000,"data":{"task":"01JTASK","kind":"mine","detail":"reached a path target"}}
{"type":"event","name":"baritone_idle","time":1730000009000,"data":{"process":"Mine","goal":null,"cancelled":false,"task":"01JTASK"}}
{"type":"event","name":"task_done","time":1730000009000,"data":{"task":"01JTASK","kind":"mine","detail":"finished"}}
```

TS adapter 把這些對應到核心的任務契約(`TaskFailureCode`:`interrupted` → `busy`,其餘同名;見 `README.md`)。

範例:

```json
{"type":"event","name":"damage","time":1730000000000,"data":{"amount":3.5,"source":"mob","attacker":"zombie","health":16.5}}
{"type":"event","name":"chat","time":1730000001234,"data":{"sender":"Steve","message":"你好","system":false,"self":false}}
{"type":"event","name":"goal_reached","time":1730000002345,"data":{"goal":"GoalBlock{x=120,y=64,z=-30}"}}
```

## 7. 反射層(reflex)

LLM 不碰逐幀控制。模組每個 client tick 跑一層反射(`reflex/ReflexBrain` 決定、`game/Reflexes` 執行;參考 Mindcraft 的 modes、mc_aiplayer 的 Safety Net),**只在 adapter 連著時**(有人手動玩的時候不搶控制)。一次只跑一個,依優先順序;越前面的危險可以接手後面的:

| kind | 何時開始 | 做什麼 | 何時結束 |
|---|---|---|---|
| `lava` | 在岩漿或火裡 | 朝 5 格內最近的安全落腳處跑、跳 | 離開岩漿 / 火 0.5 秒 |
| `suffocation` | 卡在方塊裡(窒息) | 像按住左鍵一樣挖開頭部那格 | 不再卡住 |
| `falling_block` | 頭上有掉落的方塊(沙、礫石) | 閃到旁邊不在那一欄的位置 | 約 0.75 秒 |
| `drowning` | 在水裡、氧氣低於 40% | 按住跳往上游 | 頭出水或氧氣回到 90% |
| `flee` | 苦力怕 6 格內,或血量 ≤ `reflexFleeHealth` 時敵對生物 10 格內 | Baritone `GoalRunAway`(16 格),沒有 Baritone 就背對牠跑 | 2 秒內沒有威脅 |
| `fight` | 看得到的敵對生物 4 格內、血量夠(不打苦力怕) | 換上最好的劍 / 斧、轉頭、靠近,攻擊冷卻好了才打(3 格內) | 1 秒內 6 格內沒有敵人 |
| `eat` | 有食物而且飢餓 ≤ `reflexEatFoodBusy`(會打斷工作),或閒著時 ≤ `reflexEatFood` | 拿出最好的食物(不吃腐肉這類,除非快餓死;從背包換到空的快捷列格,吃完換回去)、按住右鍵 | 吃完 |
| `unstuck` | Baritone 在走路但約 `reflexStuckSecs` 秒沒移動(挖方塊不算) | 停掉 Baritone,往旁邊的空位跑、跳一秒 | 一秒後 |
| `pickup` | 工作結束 0.75–30 秒內、6 格內有看得到的掉落物 | Baritone 走到那裡(走不到 5 秒就放棄那個) | 沒有可撿的 |

規則:

- 只用她看得到的目標(`canSee`):不打牆後的怪、不撿牆後的東西。中立生物(終界使者、殭屍化豬布林)只有在牠攻擊時才算威脅。攻擊距離與冷卻跟玩家一樣,Baritone 的 legit 設定(§8)與可見性檢查都不變。
- 會打斷工作的反射(除了 `pickup` 以外,以及閒著時的 `eat`)先送 `reflex`(帶 `interrupted`),再停掉 Baritone(之後的 `baritone_idle` 帶 `reason:"reflex"`)、`craft` / `smelt`(`*_failed` 帶 `cancelled:true`)、按住的按鍵。結束時送 `reflex_end`。
- 反射期間移動身體的請求回 `reflex_active`;`pickup` 和閒著時的反射會讓路給請求。`stop` 只停 `pickup` / `eat` / `unstuck`,求生的反射照跑。
- 反射自己用 Baritone 走路(`flee`、`pickup`)時,那段路的 `goal_reached` / `goal_failed` / `baritone_idle` 不送(不是她下的工作)。`pickup` 等工作的 `baritone_idle` 送出(閒置 10 tick)之後才開始。
- 死掉、在主選單、單人遊戲暫停、AltoClef 任務進行中(它有自己的反射)時不跑。
- `observe` 的 `reflex.active` 是正在跑的反射。

## 8. 不作弊:模組強制的 Baritone 設定

Baritone 只當她的腳和手,不替她「知道」看不到的東西。模組在進入世界後的第一個 tick(Baritone 已讀完自己的 `settings.txt`)設定下面這些,所以 `settings.txt` 裡相反的值會被蓋掉(`legitMine` 每次 `mine` 前還會再設一次):

| 設定 | 值 | 為什麼 |
|---|---|---|
| `legitMine` | `true` | 挖礦只挖從她眼睛射線看得到的礦(Baritone 的 `addNearby`:腳邊 10 格內、看得到),不用區塊快取的透視清單。看不到時 Baritone 會往下盲挖到 `legitMineYLevel`,模組把那一步停掉(§5.2) |
| `freeLook` | `false` | 鏡頭跟著走路方向轉;`true` 時畫面不動、身體橫著走,直播看起來像外掛 |
| `smoothLook` / `smoothLookTicks` | `true` / `10` | 鏡頭水平角度取 Baritone 最近 10 tick 目標角度的平均,轉頭是漸進的而不是瞬間甩過去 |
| `renderPath` / `renderGoal` / `renderSelectionBoxes` | `false` | 不在她(被直播)的畫面裡畫路線和目標框 |

另外 `goto {block}` 與 `observe` 的 `nearby_blocks` 都只用她看得到的方塊(§4、§5.2),不碰 Baritone 的快取搜尋。`farm`、`explore`、`follow` 沒有透視問題(作物在地表、探索看的是沒去過的區塊、跟隨的是看得到的生物),照舊。
