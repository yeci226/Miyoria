# Stage Link 協定(v1)

Stage 節點(`miyoria stage`,跑在直播機)和 Core 的 `stage.link` 模組之間的連線。跟 [Voice Link](voice-link.md) 一樣用 WebSocket + JSON(不用 gRPC,Windows 上不必裝 protoc)。實作在 `packages/stage`(`@miyoria/stage`)。

- **方向**:Stage 主動連到 Core:`ws://<core>:7882/stage-link`(位址由 `[modules."stage.link"] bind` 設定,預設 `127.0.0.1:7882`)。
- **訊框**:只有文字訊框,都是 JSON,都有 `type` 欄位。
- **一次只接一個 Stage**:新的連線會取代舊的。

## 連線與認證

1. Stage 連上後 5 秒內送出:
   ```json
   {"type":"hello","version":1,"token":"<STAGE_LINK_TOKEN>","node":"stage",
    "capabilities":["overlay","vts","lipsync","obs"]}
   ```
   `capabilities` 只是告知用(Core 會記下來,`StageLink.node()` 查得到)。
2. Core 回 `{"type":"welcome","session":"<ulid>"}`。token 錯誤用 close code `4401` 關閉;版本不符、格式錯誤或 5 秒內沒送 hello 用 `4400`。Stage 收到 `4401` / `4400` 會直接結束(重試也沒用),其他情況會以 1 秒起跳、最多 30 秒的退避重連。
3. 新的 Stage 連線取代舊的,舊的用 `4409` 關閉。被取代的 Stage 等 30 秒再試。
4. 心跳:Core 每 15 秒送 `{"type":"ping"}`,Stage 回 `{"type":"pong"}`;任一方 45 秒沒收到任何東西就斷線(Core 用 `4408` 關閉)。
5. 連上之後 Stage 馬上送一次 `status`,之後只要 VTS / OBS 狀態有變就再送。

## Core → Stage

| type | 欄位 | 說明 |
|---|---|---|
| `emotion` | `name`, `intensity`(0..1), `resting?` | 情緒標記(來自 `agent.emotion`)。`name` 是小寫,`intensity` 沒給時是 `1.0`。`resting: true` 不是某句話的標記,而是她現在表現出來的情緒(`affect.changed`):沒有標記時臉就停在這裡,直到下一個 `resting`(`neutral` 是沒有特別的情緒) |
| `subtitle` | `turn`, `text`, `final`(bool) | 字幕。同一個 `turn` 的新字幕取代舊的(`text` 是到目前為止的全文)。沒有 turn 的語音用 `""` |
| `speaking` | `state`(`started` / `stopped`) | 她開始 / 停止說話(來自 `voice.playback`) |
| `scene` | `name`, `transition?`, `transition_ms?`, `id?` | 切 OBS 場景。有 `transition` 時只用在這一次切換:設成**目標場景**的轉場覆寫(`SetSceneSceneTransitionOverride`,`transition_ms` 是長度,50..20000),不改 OBS 全域的「目前的轉場」;切換一次一個,兩次切換的轉場不會互相套用。OBS 沒有這個轉場時記警告、照樣用目前的轉場切換 |
| `stream` | `action`(`start` / `stop`), `id?` | 開始 / 停止直播 |
| `avatar_hotkey` | `name`, `id?` | 觸發 VTS hotkey(名稱或 hotkey ID) |
| `gaze` | `target`(`chat` / `game` / `camera`) | 她看哪裡 |
| `song_video` | `action`(`play` / `stop`), `song`, `path?`, `offset_ms?`, `scene?` | 她唱的歌的原曲影片(見下面「唱歌時放影片」)。`play`:`path` 是直播機上歌曲快取裡的影片(絕對路徑),`offset_ms` 是送出時歌已經唱了多久,`scene` 是導演會切去的 `sing` 場景(沒有就是目前場景);`stop`:停掉並清空。沒有 `id`、不回覆 |
| `notice` | `text` | overlay 的一行狀態(`""` 清掉)。她的語音因為要做歌暫停時是「準備歌曲中…」(來自 `speech.pause`)。新的 overlay 改用 `activity` 顯示這段時間,`notice` 留給舊版 Stage / overlay;新 overlay 只在沒有 `activity` 時才把它顯示在活動膠囊裡 |
| `activity` | `kind`, `label`, `detail`, `progress`, `elapsed_ms`, `duration_ms` | 她現在在做什麼(overlay 左下的活動膠囊,見下面「活動」)。`kind`:`thinking` / `synthesizing` / `song_prepare` / `singing`,`null` = 隱藏(其他欄位為空);`label` 是短的中文狀態(≤ 40);`detail` 是歌名(已跳脫、≤ 49 字)或 `null`;`progress` 0..1 或 `null`(不確定);唱歌時 `elapsed_ms`(送出時唱到哪)與 `duration_ms`(歌多長),進度由收到的一方自己的時鐘推進 |
| `status_request` | `id?` | 要一份最新的 `status` |
| `ping` / `pong` | | |

範例:

```json
{"type":"emotion","name":"annoyed","intensity":1.0}
{"type":"subtitle","turn":"01JD3W6Q8X0Z5K2M9C4B7N1R3T","text":"哼,才不是在等你呢。","final":false}
{"type":"speaking","state":"started"}
{"type":"scene","name":"Game","id":12}
{"type":"scene","name":"Game","transition":"Fade","transition_ms":300,"id":15}
{"type":"stream","action":"start","id":13}
{"type":"avatar_hotkey","name":"Wave","id":14}
{"type":"gaze","target":"chat"}
{"type":"song_video","action":"play","song":"yt-K4DyBUG242c","path":"C:\\Miyoria\\data\\songs\\yt-K4DyBUG242c\\video.mp4","offset_ms":0,"scene":"唱歌"}
{"type":"song_video","action":"stop","song":"yt-K4DyBUG242c"}
{"type":"activity","kind":"song_prepare","label":"轉換歌聲","detail":"夜に駆ける","progress":0.62,"elapsed_ms":null,"duration_ms":null}
{"type":"activity","kind":"singing","label":"正在唱","detail":"夜に駆ける","progress":null,"elapsed_ms":0,"duration_ms":261000}
{"type":"activity","kind":null,"label":"","detail":null,"progress":null,"elapsed_ms":null,"duration_ms":null}
```

`song_video`、`activity` 是 v1 之後加的:舊版 Stage 不認得它們(記 debug log、略過),協定版本仍是 1。

**活動(`activity`,Core 端)**:由 `stage.link` 從匯流排事件算出來,優先順序由高到低:

| `kind` | `label` | 什麼時候 | 進度 |
|---|---|---|---|
| `singing` | 正在唱 | `sing.cue` `started` 到 `ended` | `elapsed_ms` / `duration_ms`(`sing.cue` `started` 的 `duration_ms`;沒有就是不確定) |
| `song_prepare` | 下載中 / 讓出顯示卡中 / 分離人聲 / 轉換歌聲 / 混音 / 找歌詞(也有 排隊中、找歌中、下載影片、準備歌曲) | `sing.prepare` 有歌在準備(`exclusive` 是 `waiting` / `offloading` 時是「讓出顯示卡中」,其他依 worker 的 `stage`) | worker 的整體進度 |
| `synthesizing` | 產生語音… | 她的一句話送去 TTS(`voice.synthesis`)、還沒開始播(`voice.playback` `started` / `failed`) | 不確定 |
| `thinking` | 思考中… | 回合在跑(`agent.turn.started` 到 `completed`),還沒說出任何一句 | 不確定 |

- 一個回合的第一句開始播之後就交給字幕:句子之間(下一句在 TTS)不再顯示「思考中」或「產生語音」。文字頻道的回合只有 `subtitle_text_turns = true` 時才算。
- `thinking` / `synthesizing` 要持續 250 ms 才顯示(很快結束的回合不會閃一下);回合 2 分鐘、TTS 30 秒沒有結束就不再算。
- 種類、文字或歌改變時立刻送;同一個活動的進度最多每 250 ms 送一次(而且要變超過 0.5%);唱歌時只在開始送一次。Stage 重新連上(送 `status`)時會先收到目前的活動。
- 歌名是不可信的文字:經過 `safeName`(去掉控制字元、換行,最多 48 字)。

**字幕的規則**(Core 端):

- 語音播放開始(`voice.playback` `started`)時,把這段文字接到該 turn 的字幕後面,送 `final: false`。
- 該 turn 已完成(`agent.turn.completed`)而且沒有正在播的語音時,送一次 `final: true`。之後如果同一個 turn 又有排隊的語音開始播,會再送 `final: false` 的更新,最後再 `final: true`。
- 文字頻道(非語音)的回合預設不出字幕;`[modules."stage.link"] subtitle_text_turns = true` 時,回合完成就直接送 `final: true` 的全文。

## Stage → Core

| type | 欄位 | 說明 |
|---|---|---|
| `status` | `vts`(bool), `obs`(bool), `scene`(string / null), `streaming`(bool), `scenes`(string[]), `hotkeys`(string[]), `overlay_url`(string / null), `id?` | 目前狀態。`vts`:已連上並通過 VTS 認證;`obs`:已連上 obs-websocket;`scene`:OBS 目前的 program 場景;`scenes`:OBS 所有場景名稱(`GetSceneList`,順序跟 OBS 場景清單由上到下一樣,OBS 沒連上時是 `[]`);`hotkeys`:VTS 目前模型的 hotkey 名稱(VTS 連上 / 換連線、以及收到 `status_request` 時重新讀取,VTS 沒連上時是 `[]`);`overlay_url`:Stage 的 overlay 網頁(給 OBS browser source 用,綁 `0.0.0.0` / `::` 時寫成 `127.0.0.1`) |
| `error` | `message`, `id?` | 錯誤 |
| `ping` / `pong` | | |

```json
{"type":"status","vts":true,"obs":true,"scene":"Game","streaming":false,"scenes":["Talk","Game"],"hotkeys":["Wave","臉紅"],"overlay_url":"http://127.0.0.1:7884/overlay/"}
{"type":"status","vts":true,"obs":true,"scene":"Game","streaming":true,"scenes":["Talk","Game"],"hotkeys":["Wave","臉紅"],"overlay_url":"http://127.0.0.1:7884/overlay/","id":13}
{"type":"error","message":"OBS is not connected","id":13}
```

`scenes`、`hotkeys`、`overlay_url` 是 v1 之後加的欄位:舊版 Stage 不送也沒關係,Core 會當成 `[]`、`[]`、`null`(協定版本仍是 1)。`scene` 的 `transition` / `transition_ms` 也是之後加的:舊版 Stage 會忽略它們(用 OBS 目前的轉場),協定版本不變。管理面板的 `GET /api/stage` 直接用它們:`scenes` → 場景選單,`hotkeys` → `expressions`(表情 / hotkey 選單),`overlay_url` → overlay 預覽。

**請求與回覆**:`scene`、`stream`、`avatar_hotkey`、`status_request` 帶 `id` 時,Stage 一定要回一個帶同樣 `id` 的訊息:成功回 `status`(動作完成後的狀態),失敗回 `error`。`stream` 會等 OBS 真的進入(或離開)直播狀態才回,最多 `[stage.obs] stream_wait_ms`(預設 15 秒)。Core 端等 `request_timeout_ms`(預設 10 秒)沒回覆就當作失敗。沒有 `id` 的 `error` 只是通知(Core 會發佈成 `stage.error` 事件)。

## Core 端

```toml
[modules."stage.link"]
bind = "127.0.0.1:7882"
token = "${STAGE_LINK_TOKEN}"
# ping_interval_ms = 15000
# peer_timeout_ms = 45000
# hello_timeout_ms = 5000
# request_timeout_ms = 10000
# subtitle_text_turns = false
golive_obs = true          # 跟在 voice node 的 Go Live 後面按 OBS 開始 / 停止直播
golive_start_delay_ms = 3000   # 等 voice node 的 ffmpeg 綁好 RTMP listener 再按
```

- 訂閱 `agent.emotion`、`agent.turn.completed`、`voice.playback`,依上面的規則轉送;另外用 `agent.turn.started`、`voice.synthesis`、`sing.prepare`、`sing.cue` 算出 `activity`。
- 另外訂閱 `voice.golive`(`{guild, state, error?, reason?}`):`starting` 時在 `golive_start_delay_ms` 後叫 OBS 開始直播(最多重試 3 次),`stopped` / `failed` 時叫 OBS 停止。所以 Discord 的 `/golive start` 一個指令就能從推流到 OBS 全包;`golive_obs = false` 可以關掉,讓 OBS 自己控制。
- 有 ActivityManager(module `activity`)時上面這段不跑:OBS 是開台(`ensure_live`)的第二個子步驟,`stage.stream` 過閘門、Go Live 真的 `live` 之後才按(`[modules.activity] obs`、`obs_start_delay_ms`、`obs_attempts`);直播機連著但 OBS 沒開就是「開台失敗:OBS 沒開」並把 Go Live 收回。Go Live 從別處開或自己斷掉時,它也會讓 OBS 跟著開 / 停。
- 提供 `StageLink` 服務(`StageLinkKey`):`setScene`、`stream`、`hotkey`、`refreshStatus`、`gaze`、`status`、`subscribeStatus`。
- 狀態變化發佈成 `custom` 事件(topic `stage.status`),payload `{connected, vts, obs, scene, streaming, scenes, hotkeys, overlay_url}`(斷線時只有 `{"connected": false}`)。
- 有 `CommandRegistry` 時註冊指令:`stream start`、`stream stop`、`stream scene <name>`、`stream status`(權限節點 `stream.start` / `stream.stop` / `stream.scene` / `stream.status`)。

### 場景用途與場景導演(`[modules."stage.link".scenes]`)

```toml
[modules."stage.link".scenes]
director = true                 # 狀態一變就自動切場景
classify = true                 # 第一次看到場景清單時用 LLM(classify_purpose,預設 fast)從名稱判斷用途
roles = { chat = "聊天", game = "遊戲" }          # 擁有者指定,最優先(面板不能改)
transition = { name = "Fade", duration_ms = 300 } # 每次切換的轉場(none = OBS 目前的)
transitions = { game = { name = "Stinger" } }     # 個別用途的轉場
debounce_ms = 1500              # 這麼近的狀態變化算一次
min_switch_ms = 8000            # 兩次自動切換的最小間隔(開場、結尾除外)
manual_hold_ms = 120000         # 別人手動切了之後,導演這麼久不插手
starting_ms = 30000             # 開台後開場畫面停多久
ending_ms = 6000                # 停播前結尾畫面停多久
brb_after_ms = 300000           # 直播中、沒在玩遊戲時多久沒人講話 → 暫離(0 = 不切)
brb_on_voice_leave = true       # 直播中她離開語音 → 暫離
only_while_live = false         # true:只在直播中切
```

- **用途(role)**:內建 `chat`(聊天)、`game`(遊戲)、`brb`(暫離)、`starting`(開場)、`ending`(結尾)、`sing`(唱歌);`roles` 裡可以加自己的(小寫英數與 `_`)。每個用途的場景依序取自:設定檔 `roles` → 面板(`PUT /api/stage/scenes`,存在 settings `_global` / `stage:scene_roles`)→ 自動分類。自動分類在節點第一次回報 `scenes`、以及場景清單改變時跑一次:`fast` 用途、JSON 模式,場景名稱放在不可信的資料區塊裡,答案只認清單裡一字不差(不分大小寫)的名稱;沒有 LLM、呼叫失敗或答案不是 JSON 時改用關鍵字(`chat` / `talk` / `雜談`、`game` / `遊戲`、`brb` / `afk` / `暫離`、`start` / `soon` / `開場`、`end` / `outro` / `下播`、`sing` / `song` / `karaoke` / `MV` / `唱歌` / `歌回`…)。服務 `SceneRolesKey`。
- **能力 `stage.scene`** 收 `{role}` 或 `{name}`(場景名稱;不是場景名稱但是用途名稱時當用途):用途會帶上它的轉場送 `scene`。她的工具 `stage_scene` 一樣可以給 `role`。
- **導演**(principal `director`,每次切換都是 `stage.scene {role}` 過閘門,所以自主暫停時導演也停):
  - 開台(Go Live `starting` / `live`,或 OBS 開始直播)→ `starting`,`starting_ms` 後 → `chat`(在玩遊戲就 `game`)。沒有場景的用途會跳過、換下一個符合的(沒有開場場景就直接聊天;正在玩遊戲就維持遊戲場景);
  - `game.director.session` `started` → `game`,`stopped` → `chat`;
  - 她開始唱歌(`sing.cue` `started`)→ `sing`(立刻,不等 debounce、`min_switch_ms`、`manual_hold_ms`),唱的時候不會切去暫離或遊戲;唱完(`ended`)→ 回到唱之前的場景(用 `stage.scene {name}`),唱的期間狀況變了(遊戲開始 / 結束、開台 / 下播)就改去現在該在的場景,有人手動切走了就不動。沒有 `sing` 場景時唱歌不切場景;
  - 直播中、沒在玩遊戲:`brb_after_ms` 沒有任何人講話(她的語音、別人的語音、回合完成)或她離開了語音頻道 → `brb`,有人講話 / 回到語音 → 回來;
  - 停播:Go Live `stopped` / `failed`,或 OBS 停止直播 → `ending`,並停在結尾畫面直到有新的變化(開台、開始 / 停止遊戲)。
  - 只對**變化**反應(開機時不會去「修正」目前的場景);`debounce_ms` 內的變化合併;兩次自動切換至少隔 `min_switch_ms`;別人(OBS 裡手動、指令、面板、她自己的 `stage_scene`)切了之後 `manual_hold_ms` 內不插手,期間有變化就等時間到再切。開場與結尾不受這些等待限制。
- **結尾幕(`StreamCurtainKey`)**:`stream.stop`(Go Live)與 `stage.stream stop`(`/stream stop`、面板)在真的停播前先呼叫它:切到 `ending`、停留 `ending_ms` 再停;沒有結尾場景、沒在直播或切換被閘門擋下時馬上繼續。
- 轉場只用在那一次切換(目標場景的轉場覆寫),OBS「目前的轉場」不會被改掉。
- **場景是她狀態的函式**:有 ActivityManager 時,導演從它的 snapshot(`activity.changed`)讀她在不在語音、直播、玩遊戲、唱歌,`scene = f(presence, broadcast, activity, 她的覆寫)`(`stage.link` 也把這個規則提供成 `SceneRuleKey`,所以 `ActivitySnapshot.scene` 是同一個答案)。她(或指令、面板)用 `stage.scene` 切的場景是**有時間的覆寫**(`manual_hold_ms` 長),導演照著它、時間到再回到規則的場景,不會跟她搶;只有在 OBS 裡直接切的才算手動切換。導演和結尾幕的切換共用一把鎖,所以它自己的切換不會被當成手動切換。

### 唱歌時放影片(`song_video`,Stage 端)

```toml
[stage.obs]
# song_video_source = "Miyoria 歌曲影片"   # 媒體來源名稱(不要這功能:Core 的 [modules.sing] video = false)
# song_video_dir = "data/songs"            # worker 的 SING_DATA_DIR;不在裡面的路徑一律不放
# song_video_lead_ms = 0                   # 提早多久 restart(補 OBS 開檔到出第一格的時間)
# song_video_resync_ms = 300               # 跟歌差超過這麼多就 seek(0 = 不檢查)
```

- 收到 `play`:先確認 `path` 是 `song_video_dir` 裡存在的 `video.<mp4|mkv|webm|mov|m4v>`;要播的場景是 `scene`(沒給就是 OBS 目前的場景)。**媒體來源要是那個場景裡的項目**,或是放在場景裡的巢狀場景(最多兩層)裡,例如給影片加圓角框用的 `唱歌 · 影片`(群組不算);都找不到就什麼都不做(每個場景只警告一次)。顯示 / 隱藏的是找到的那一層裡的項目。
- 設定媒體來源(`SetInputSettings`,overlay):`is_local_file: true`、`local_file`、`looping: false`、`restart_on_activate: false`、`close_when_inactive: false`、`clear_on_media_end: true`,再 `SetInputMute` 靜音。`restart_on_activate` 刻意關掉:切場景的轉場晚於開始時,OBS 會把影片從頭重播、跟歌錯開;開始的時間由 Stage 自己控制。項目是隱藏的就先顯示,歌結束後再藏回去。
- 時間:收到後 `[stage.lipsync] latency_ms` − `offset_ms` − `song_video_lead_ms` 時 `TriggerMediaInputAction` restart;1.5 秒後、之後每 20 秒用 `GetMediaInputStatus` 比對位置,差超過 `song_video_resync_ms` 就 `SetMediaInputCursor`。晚到的 `play`(`offset_ms` 大)立刻 restart、0.3 秒後 seek 到歌的位置。
- 收到 `stop`(或下一首的 `play`):晚 `latency_ms` 後 stop、把 `local_file` 清空。
- OBS 沒連上、拒絕任何一個呼叫:記 log,歌照唱,不會讓 Stage 出錯。

**OBS 要自己建的東西**(Miyoria 不會改你的 OBS 場景):

1. 新增場景,名稱例如 `唱歌`(或在 `[modules."stage.link".scenes] roles` 寫 `sing = "你的場景名稱"`;名稱裡有 sing / song / karaoke / MV / 唱歌 / 歌回 的會被自動分類成 `sing`)。
2. 場景裡由下到上:
   1. **媒體來源**,名稱 `Miyoria 歌曲影片`(跟 `song_video_source` 一樣):「本機檔案」打勾、檔案先空著、「循環」不勾、「來源變成作用中時重新開始播放」不勾(Stage 也會設)。按右鍵 → 變形 → 「符合畫面大小」(全畫面在最底層)。音訊混音器裡它會被設成靜音,不用管。
   2. 她的 **VTube Studio 視窗擷取**(或遊戲擷取 / Spout2,跟聊天場景一樣的來源可以直接「加入現有的」),放在影片上面,背景透明。
   3. 最上面 **`Miyoria Overlay` 瀏覽器來源**(`http://127.0.0.1:7884/overlay/`,一樣「加入現有的」),歌詞字幕會在這裡。
3. 沒有 `唱歌` 場景也可以:把同一個媒體來源加進聊天場景(可以先隱藏),唱歌時 Stage 會在目前場景裡顯示它、唱完藏回去。

---

# 嘴型音量串流(Lip-sync levels,v1)

Voice node(跟 Stage 在同一台直播機)播放她的聲音時,把播放中的音量與音色送給 Stage,Stage 算出嘴型注入 VTube Studio。

- **位址**:`ws://127.0.0.1:7883/levels`(`[stage.lipsync] bind`)。只綁本機,不需要 token。
- **方向**:voice node → Stage,單向;Stage 不回任何東西。連線斷了 voice node 自己重連即可。
- **訊框**:文字 JSON,每 10 ms 一個,**只在她說話時送**:
  ```json
  {"t": 1234, "rms": 0.21, "bands": [0.0123, 0.0310, 0.0402, 0.0281, 0.0094, 0.0031]}
  ```
  - `t`:這個 10 ms 視窗在本次播放中的起點(毫秒,每段播放從 0 開始)。**Stage 用它排時間**:每段播放的第一筆把 `t = 0` 對到 Stage 的時鐘(anchor),之後每筆在 `anchor + t + latency_ms` 生效,所以網路抖動、一次到好幾筆都不會讓嘴型忽快忽慢;比預期早到的訊框把 anchor 往前修(延遲最少的那筆最準),連續晚到超過 `resync_ms`(預設 60 ms,播放器停頓、voice node 重新對時)就開新的時間軸。`t` 回到 0 = 新的一段播放。沒有 `t` 的訊框(舊版)依到達時間排。
  - `rms`:這 10 ms 音訊的 RMS,範圍 0..1(PCM s16 除以 32768 後計算)。超出範圍會被截斷。
  - `bands`(可省略,v1 的相容擴充):單聲道先做 pre-emphasis(+6 dB/oct),再經過 6 個帶通濾波器(中心 300 / 550 / 850 / 1300 / 2000 / 3000 Hz,Q 1.5,兩級串接),每個頻帶在最近 20 ms 的 RMS。只有「形狀」有意義(Stage 取 dB 後減掉平均),絕對大小不重要。舊的 Stage 會忽略這個欄位;舊的 voice node 不送它時,Stage 就不驅動母音參數。
- 播完或被打斷時可以送一個 `{"t": <ms>, "rms": 0}`;就算沒送,Stage 在 150 ms(`stale_ms`)沒收到新值後也會把嘴巴闔上。`speaking` `stopped` 不會清掉已排隊的訊框(那些音觀眾還沒聽到)。
- RMS 應該在**實際出聲的那一刻**送出(voice node 把該段送進播放器的時候)。觀眾比這晚約 150–250 ms 聽到(Discord / 推流緩衝),所以 Stage 預設延後 `latency_ms = 180`;嘴型明顯比聲音早就加大,晚就調小。

**Stage 端的處理**(`[stage.lipsync]`,以 `[stage.vts] inject_hz` 預設 60 Hz 注入;每格的 dt 取自時鐘,所以 30 Hz 也可以):

1. 每格把這段時間內到期的**所有**訊框合起來(`aggregate = "rms"` 能量平均,或 `"max"`),不會丟樣本。
2. 音量 → 張嘴(`Envelope`):換成 dBFS,低於 `gate_db`(-50)算安靜;自動增益參考值(AGC)跟著她的音量走,往上快(`agc_attack_ms` 150)、往下慢(`agc_ms` 2000),只在說話時移動,限制在 `agc_min_db`..`agc_max_db`(-38..-4,起始 `agc_init_db` -16);參考值以下 `range_db`(26 dB)對到張嘴 0..1,再套 `curve`(0.85)、乘 `max_open`。最後 attack / release 平滑(`attack_ms` 22 / `release_ms` 80)。所以小聲的句子嘴巴也會張開,一般說話不會只開到兩成。
3. 母音(`VowelClassifier`):`bands` 的形狀跟五個母音樣板(`vowel_templates`,預設是日語女聲的共振峰合成量出來的)比距離,softmax(`vowel_sharpness`)成 A/I/U/E/O 權重,`vowel_smooth_ms`(45)平滑;只在嘴巴有張開時更新。
4. 注入:`MouthOpen` = 張嘴;`JawOpen`(自訂參數)= 張嘴 × `jaw_gain`(0.8);`VoiceA..VoiceO` = 權重 × 張嘴 × `vowel_gain`,`VoiceSilence` = 1 − 1.5 × 張嘴(模型把它們對到 `ParamA..ParamO` / `ParamSilence`);`MouthSmile`(嘴型)= 情緒姿勢的值 + `avatar.toml` `[lipsync.shape.<母音>]` 的偏移 × 權重 × 張嘴(例如 i/e 嘴角往兩邊、u/o 嘟嘴)。不再用正弦波假裝嘴型變化。

參數名稱來自 profile 的 `avatar.toml` `[lipsync]`(`mouth_open`、`mouth_form`、`jaw`、`vowels = true/false`);`mode = "mic"` 時不注入嘴型,也不開這個端點。

---

# Overlay WebSocket(v1)

Stage 的 HTTP 伺服器(`[stage] overlay_bind`,預設 `127.0.0.1:7884`):

- `GET /overlay/`:靜態檔案,來自 `[stage] overlay_dir`(預設 `apps/overlay/dist`)。OBS browser source 指向 `http://127.0.0.1:7884/overlay/`。
- `GET /overlay/backdrop`:直播背景圖,`[stage] overlay_backdrop` 指定的檔案(任何路徑);沒設定時 404,背景層就只畫深色漸層。
- `GET /overlay/ws`:WebSocket,Stage → overlay 單向推送 JSON。連上時先收到最新的 `status`、`emotion`、`subtitle`(有的話),之後即時推送:

```json
{"type":"status","core":true,"vts":true,"obs":true,"scene":"Game","streaming":true}
{"type":"emotion","name":"happy","intensity":1.0}
{"type":"subtitle","turn":"01JD3W6Q8X0Z5K2M9C4B7N1R3T","text":"早安。","final":false}
{"type":"speaking","state":"started"}
{"type":"notice","text":"準備歌曲中…"}
{"type":"activity","kind":"thinking","label":"思考中…","detail":null,"progress":null,"elapsed_ms":null,"duration_ms":null}
```

`activity` 原樣轉送 Core 的 `activity`;新的連線也會先收到目前的活動(唱歌時 `elapsed_ms` 會加上經過的時間),Stage 和 Core 斷線時送一次 `kind: null` 把它藏起來。`notice`(`""` 清掉)也一樣會先送給新的連線;overlay 在沒有活動時把它顯示在活動膠囊裡。`core` 表示 Stage 目前有沒有連上 Core。`subtitle` 的規則同上(同一個 `turn` 的新字幕取代舊的)。

---

# VTube Studio(參考)

Stage 以外掛身分連 VTS Public API(`ws://127.0.0.1:8001`,`[stage.vts] url`),自己實作 JSON API:

- 認證:`AuthenticationTokenRequest`(使用者要在 VTS 按「允許」)→ token 存在 `<data_dir>/vts-token.txt`(預設 `data/stage/vts-token.txt`)→ `AuthenticationRequest`。token 失效時自動重新申請。
- 連上後用 `CurrentModelRequest`、`ExpressionStateRequest`、`HotkeysInCurrentModelRequest` 檢查 `avatar.toml` 的設定(找不到的只會警告),再用 `ParameterCreationRequest` 建立 `[stage.vts] custom_params` 裡 VTS 沒有的自訂參數(預設 `JawOpen`、`BrowInnerUp`、`MouthFunnel`、`MouthPucker`、`REyeSquint`、`LEyeSquint`、`mouthSmileL`、`mouthSmileR`、`MiyoriaEyeSmile`、`MiyoriaBodyX/Y/Z`;很多模型的對應寫的是 ARKit 名稱,參數存在之後那些對應就會動),最後 `InputParameterListRequest`:VTS 沒有的參數不注入。
- 注入:每格一個 `InjectParameterDataRequest`,`mode: "set"`,只送 Miyoria 自己驅動的參數;`faceFound` 預設 `true`(`[stage.vts] face_found`),VTS 就不會播模型的「追蹤遺失」待機動畫(大肥鱼的 `脱捕.motion3.json` 會接管眼睛、下巴、頭和道具,每 13 秒重複同一套動作)。
- **情緒**(`avatar.toml` `[emotion.<名稱>]`):
  - `expression`:重點貼圖。`.exp3.json` → `ExpressionActivationRequest`;其他 → hotkey 名稱(`HotkeyTriggerRequest`,名稱會先對照成 hotkey ID)。強度低於 `accent_min` 時不開。同一時間只維持一個主情緒;維持 `emotion_hold_ms`(預設 4 秒),她說話時不會結束,說完至少再留 `after_speech_ms`(預設 1.5 秒),然後回到 `neutral`。`neutral` 是表情檔時沒有重點貼圖時就開著它;是 hotkey 時(例如 VTS 的「Remove all expressions」)回到休息狀態時觸發它。沒有貼圖也沒有姿勢的情緒視為 `neutral`。舊寫法 `[emotion] happy = "x.exp3.json"` 仍然可以用。
  - `params`:VTS 輸入參數的姿勢(眉毛、眼睛開合、`MiyoriaEyeSmile`、瞇眼、嘴角、鼓臉…)。`neutral` 的 params 是休息值;情緒在 `[stage.emotion] ease_in_ms`(250)內漸入,維持期間往 `sustain`(0.65)衰減(`decay_ms` 3000),結束後 `ease_out_ms`(700)漸出;換情緒時交叉淡入淡出。整個姿勢乘上 `intensity`。`FaceAngle*`、`EyeLeft*`、`EyeRight*`、`MiyoriaBody*` 是加在程序動作上的偏移(歪頭、低頭、看旁邊)。
  - `blink`:眨眼頻率倍數。`gesture` / `gesture_chance`:見下面手勢。
  - 休息時的臉(`resting`):只有 `params` 的姿勢,強度是感受強度 × `[stage.emotion] resting_strength`(0.6),不開重點貼圖、不觸發手勢。Core 在情緒換了或強度變動 0.1 以上時才送,Stage 重新連上時會補送一次。
  - Core 端:語音回合的情緒在**用那個情緒說的那句話開始播放時**才送(`voice.playback` `started` 帶 `emotion`;LLM 的標記通常比聲音早一句以上),`intensity` 來自 `<emo:happy 0.5>` 這種標記(沒寫就是 1)。文字回合照舊立刻送。Stage 端再把情緒和 `speaking` 延後 `latency_ms`,跟嘴型一起對上觀眾聽到的時間。
- **手勢**(`[gesture.<名稱>]`):`open` / `close` 是 hotkey 名稱或 `.exp3.json`(表情檔:開了之後關掉,不用寫 `close`),`group` 同一組同時只有一個(例如兩隻手),`hold_ms` 停留時間範圍,`cooldown_ms` 同一個手勢再觸發的最短間隔。情緒依 `gesture_chance ×(0.4 + 0.6 × 強度)× [stage.gesture] chance_scale` 從自己的 `gesture` 清單隨機挑一個(優先挑上次沒用過的);任兩個手勢開始至少隔 `[stage.gesture] min_gap_ms`(8 秒)。`[idle] gesture` 在她安靜 `after_ms` 之後每 `every_ms` 偶爾來一次;情緒手勢可以接手同一組的待機手勢(先關,`switch_ms` 後再開)。VTS 重新連上時會先把進行中的手勢關掉。
- **眨眼**(`[stage.blink]`):`EyeOpenLeft/Right` = 姿勢的值 × 眨眼曲線。間隔是 `min_ms`(2 s)+ 指數分布(平均 `mean_ms` 3.8 s),超過 `max_ms`(6 s)重抽;閉眼 `close_ms` 120 ms、全閉 `closed_ms` 30 ms、睜開 `open_ms` 180 ms;`double_chance` 15% 接第二下(最多兩下);每句話開始有 `speech_chance` 35% 會眨一下;頻率乘上情緒的 `blink`。
- **動作**(`[stage.gaze]` 姿勢與 `idle_amount`、`[stage.motion]` 其他):`FaceAngleX/Y/Z`、`EyeLeftX/Y`、`EyeRightX/Y` 在 `gaze` 目標的姿勢附近。頭部是種子雜訊(兩個八度、每次啟動不同,`seed` 可固定),說話時 ×`speech_motion`(1.5);嘴巴從閉到開(`nod_threshold`)時小點頭(`nod_deg`,間隔至少 `nod_gap_ms`),每句開頭隨機歪頭或點頭(`sentence_deg`)。眼睛做 saccade:平均每 `saccade_mean_ms`(1.4 s)跳一次 `saccade_amount`,`glance_chance` 的機率是比較大的一瞥(`glance_amount`),頭會跟一點(`head_follow_deg`)。身體 `MiyoriaBodyX/Y/Z` = 頭的 `body_follow`(0.35)倍、延遲 `body_lag_ms`(450),再加自己的飄動(`body_drift`)。

**VTS 端要手動設定的對應**(大肥鱼;API 不能改模型的參數對應,要在 VTS 的模型設定 → 參數裡改,存檔):

1. **「微笑」**(輸出 `EyeSmile`):輸入從 `MouthSmile` 改成 `MiyoriaEyeSmile`,輸入範圍 0..1。不改的話,嘴型的 `MouthSmile`(休息值 0.58)會讓眼睛一直瞇著、說話時亂瞇。
2. **「身体X / 身体Y / 身体Z」**(輸出 `PositionX/Y/Z`,模型的物理再推到 `ParamBodyAngle*`、骨盆、手臂、裙子):輸入從 `FaceAngleX/Y/Z` 改成 `MiyoriaBodyX/Y/Z`,範圍 -30..30 → -30..30。不改的話身體照舊跟頭完全同步(也能用,只是比較僵)。
3. 其他(`JawOpen`、`BrowInnerUp`、`MouthFunnel`、`MouthPucker`、`REyeSquint`、`LEyeSquint`、`mouthSmileL/R`)模型原本就對應到這些名字,Stage 建立參數後自動生效,不用改。
4. `TimeUntilTrackingLostIdleAnimation` 不用動:`faceFound = true` 時那段動畫不會播。如果你自己開了臉部追蹤,把 `[stage.vts] face_found = false` 或關掉 Miyoria 的注入,兩邊會搶參數。
