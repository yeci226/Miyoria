# @miyoria/overlay

直播用的 **OBS 瀏覽器來源**:字幕(邊講邊出)、情緒指示、小型狀態 / 請求佇列面板、左下角的活動膠囊(她現在在做什麼,附進度條)。背景透明、深色極簡,每個有字的區塊都自帶半透明深色底板,所以疊在亮的遊戲畫面上也看得清楚。Vite + TypeScript,沒有框架,build 後約 32 KB(gzip 約 12 KB)。

## 它怎麼拿到資料

連到 Stage 的 overlay 推送(`packages/stage/src/overlay.ts`):

| 訊息 | 用途 |
|---|---|
| `{"type":"subtitle","turn","text","final"}` | 字幕。同一個 `turn` 的 `text` 是越來越長的完整字串(partial),`final: true` 表示這句講完。新的 `turn` 取代舊的。 |
| `{"type":"emotion","name","intensity"}` | 情緒指示(顏色依情緒名稱,`intensity` 調點的深淺)。 |
| `{"type":"speaking","state":"started"\|"stopped"}` | 她在不在說話:說話中字幕不會消失,停下來後才開始倒數。 |
| `{"type":"status","core","vts","obs","scene","streaming"}` | 狀態面板:直播中 / 場景名 / Core、VTS、OBS 連線點。 |
| `{"type":"queue","items":[…]}` | 請求佇列(「接下來」)。`items` 可以是字串,或帶 `title`(也認 `text` / `name` / `song` / `request`…)與 `by`(也認 `user` / `requester`…)的物件;最多顯示 5 筆,多的寫「還有 N 項」。 |

| `{"type":"activity","kind","label","detail","progress","elapsed_ms","duration_ms","secondary"?}` | 活動膠囊(見下面)。`kind`:`thinking`(思考中…)、`synthesizing`(產生語音…)、`tool`(查資料中 / 使用工具中…,只有類別、不帶參數)、`game`(玩遊戲中,`detail` 是遊戲名)、`song_prepare`(下載中 / 等待中 / 分離人聲 / 轉換歌聲 / 混音 / 找歌詞…,`detail` 是歌名,`progress` 是整首的進度,排隊和等待是 `null`)、`singing`(正在唱,`elapsed_ms` + `duration_ms` 由 overlay 自己的時鐘推進度);`kind: null` 隱藏。不認得的 `kind` 當成沒有進度的狀態顯示。`secondary`(可省略)`{label, detail, progress}`:她在做別的事時,背景準備中的歌,畫成膠囊旁邊一個小小的第二行(歌名 + 一條細的進度條,`progress: null` 是微光);沒有它的舊版訊息照常顯示。 |
| `{"type":"gift","text"}` | 禮物那一行(上方中間的小膠囊,例如「Owen 餵了她一碗白飯」)。Stage 把 60 秒內同一種禮物合併成一行(「Owen 和另外 3 人餵了她 5 碗白飯」),送出最新的一行,`text: ""` 表示淡出(最後一份禮物後約 8 秒)。 |
| `{"type":"touch","x","y","part"}` | 觀眾在網站上摸了直播畫面(Core 的 `live.touch`,Stage 每秒最多轉 8 個)。`x`、`y` 是 0..1(左上為原點),`part` 是 `head` / `face` / `body` / `screen`。overlay 在畫面的 (x·寬, y·高) 畫一圈小小的波紋和一顆往上飄的愛心,約 1.3 秒淡出,同時最多 12 個(超過時最舊的立刻拿掉);`prefers-reduced-motion` 時不動、只淡入淡出。範圍外或型別不對的整則略過。`?demo=1` 會隨機在她的頭、臉、身體和空白處摸。她本人的反應由 Stage 驅動(`[stage.touch]`),不在 overlay。 |
| `{"type":"danmaku","id","name","text","max_on_screen","queue_max","max_wait_ms"}` | 彈幕:觀眾付幾枚硬幣送出的一行字,從右邊進來橫越畫面(見下面「彈幕」)。`name` 是 `null` 表示名字隱藏。三個上限是實況主的設定,每一行都附上,以最新收到的為準。overlay 要回覆每一行的下場。 |
| `{"type":"danmaku_clear"}` | 彈幕一次全部拿掉:畫面上的淡出(已經算顯示過,不再回覆),還在排隊的回 `cleared`。 |
| `{"type":"notice","text"}` | 舊版 Core 的一行狀態(「準備歌曲中…」,`""` 清掉)。沒有 `activity` 時顯示在活動膠囊裡(沒有進度)。 |
| `{"type":"karaoke","room","state","round","rounds_left","song","shift","queue","join_url","qr_while_singing","members","position_ms","board","note","currency","air","settling"}` | 直播上的唱 K 房間(見下面「唱 K」)。`song` 在唱的時候是這一首,等人和結果時是下一首;`queue` 是 `song` 之後的幾首(`title`、`artist`、`by` 點的人、`state` `ready` / `preparing` / `failed`,最多 5 首);`join_url` 是加入房間的連結(畫成 QR code,沒有是 `null`);`qr_while_singing` 唱的時候也留一個小的 QR code;`settling` `{waiting: [名字]}` 是歌唱完了、在等誰的分數(結算中),其他時候 `null`。`board` 每一行多了 `pitch`(`{from, track}`:最近約 1.5 秒的音高,50 Hz、從第 `from` 格起,一格一個位元組,base64)和結果時的 `parts`(音程、安定、節奏、表現)。舊版 Core 沒有這些欄位,當成空的。Core 每次房間有變化、唱的時候每秒送一次,Stage 轉過來;`room: null` 表示結束,畫面上的唱 K 全部收掉。`position_ms` 是送出那一刻歌在直播上的位置(倒數時是負的),已經含房間固定的延遲(`air.delay_ms`);這一頁自己就是播放的地方(聲音和畫面一起在直播裡),所以不扣 lip-sync 的延遲。`air`:`backing`(播伴奏)、`relay`(播誰的歌聲,沒有是 `null`)、`delay_ms`、`backing_gain`、`voice_gain`、`duck_gain`(她說話時兩個都乘上它)。`board` 每一行的 `on_air` 是現在播出的那個人。新連上的頁面先拿到最新的一則,`position_ms` 推進到那一刻。 |
| `{"type":"karaoke_lyrics","room","round","song","lyrics","video","backing","notes"}` | 一首的歌詞(歌曲參考的第 2 版格式)、背景影片、伴奏和參考音符(`notes`:`[{start, end, midi}]`,秒、這一首的調,音高跑道用;舊版沒有),每首一次。`video` 和 `backing.path` 是 Stage 自己的網址(`karaoke/video?r=<房號>-<第幾首>`、`karaoke/backing?r=…`,相對於頁面,只在這一首還是最新的時候給 Core 指定的那一個檔案,支援 Range,不快取),沒有是 `null`。`backing.format`:`pcm`(s16le 單聲道,`rate` Hz,不用解碼)或 `m4a`(交給瀏覽器解碼)。只有 `room` 和 `round` 都對上場景的那一首才用。 |
| `{"type":"karaoke_voice","room","round","at_ms","audio"}` | 現在播出的那個人的歌聲:µ-law 16 kHz、base64,第一個樣本在歌裡的 `at_ms`。Core 已經選好是誰、換人時交叉淡化、照房間固定的延遲緩衝好,所以一段接一段沒有縫,一秒約 4 段。Stage 收到就轉,不留(新連上的頁面拿不到之前的),內容不記錄。 |
| `{"type":"levels","rms","bands"?}` | 她的聲音音量(0..1,和嘴型同一份、同樣延遲),每個 avatar frame 一次(約 60/s),停下時送一次 `rms: 0`。畫成左側邊緣從上到下一整排固定不動的橫條(貼齊畫面左緣、前端圓角、半透明):每條只改長度和透明度,中間的跟低頻、上下兩端的跟高頻,顏色跟著情緒點;她開口時淡入、停下時淡出。唱歌時跟著她的人聲。 |

不認得的訊息、壞掉的 JSON 一律略過,不會中斷。WebSocket 斷線會自動重連(0.5 s 起、最長 5 s),Stage 重開不用重新整理 OBS 的來源。

## 用法

```bash
pnpm install        # 在 repo 根目錄(pnpm workspace)
cd apps/overlay
pnpm build          # → apps/overlay/dist(Stage 預設就從這裡服務 /overlay/)
pnpm test           # vitest:訊息解析、reducer、打字機、設定
pnpm dev            # 開發:http://localhost:5173/?demo=1
```

OBS:新增「瀏覽器」來源,網址 `http://127.0.0.1:7884/overlay/`,寬 1920、高 1080。背景本來就是透明的,不需要在 OBS 裡加自訂 CSS。

### Query string

| 參數 | 預設 | 說明 |
|---|---|---|
| `ws` | 跟頁面同一個主機的 `…/overlay/ws`(file:// 開啟時 `ws://127.0.0.1:7884/overlay/ws`) | 推送位址,只接受 `ws://` / `wss://`。 |
| `show` | `subtitles,emotion,status,queue,wave,activity,gifts,screen,touches,danmaku,karaoke` | 要顯示哪些部分,逗號分隔。例如 `?show=subtitles,queue`。沒有任何有效名稱時視為預設。沒有 `danmaku` 的頁面不送 `danmaku_ready`、也不回覆任何彈幕(Stage 不等它)。沒有 `karaoke` 的頁面永遠不顯示唱 K。 |
| `karaoke_ruby` | `off` | 唱 K 歌詞上面的讀音:`off` 不顯示、`reading` 假名(日文)或拼音(中文)、`roman` 羅馬字。歌本身沒有那一種時不顯示。`demo=karaoke` 沒指定時是 `reading`。 |
| `danmaku_band` | 依版面 | 彈幕跑道的上下緣,畫面高度的比例,`上-下`,例如 `?danmaku_band=0.04-0.30`。畫面不一樣(例如她站的位置不同)時用;左右範圍照版面不變。格式不對、上緣不在下緣之上、或不到 2% 高時不採用。 |
| `cps` | `14` | 打字機基本速度(每秒字數,2~200)。字幕來得比顯示快時會自動加速追上;`200` = 不做打字效果。 |
| `scale` | `1` | 整體縮放(0.4~3)。1 是以 1080p 為準,版面隨畫面寬高等比,720p / 4K 看起來一樣。 |
| `demo` | 關 | `?demo=1` 播一段內建的假資料,不用連 Stage,設計和預覽用。`?demo=karaoke`(或 `?karaoke_demo=1`)改播一間唱 K 房間的循環(見下面)。 |
| `debug` | 關 | 推送斷線時在左下角顯示 "feed offline"(預設不顯示,避免上了直播畫面)。 |
| `layer` | `overlay` | `backdrop`:這頁變成整個場景最底下的背景層(見下面),不連推送。 |
| `layout` | `default` | `sing`:唱歌場景的版面。影片在左上(1080p 時 48,48 起、1504×846),她的模型站在右下角、蓋住影片一角;字幕移到影片下緣、活動膠囊在影片正下方、聲音條改成橫的貼在畫面底部、側邊面板對齊同樣的邊距。`karaoke`:唱 K 的場景(`docs/design/karaoke.md` §7.1):字幕、禮物、付費留言平常就放在唱 K 時的位置。`layer=backdrop&layout=karaoke` 是一般的暗色背景(沒有影片框,影片在 overlay 自己的畫面裡)。 |

### 背景層與唱歌場景

`?layer=backdrop` 畫 Stage 的 `/overlay/backdrop`(`[stage] overlay_backdrop` 指定的圖),上面一層中性的暗色;沒有圖就是近黑色。加上 `&layout=sing` 時多一塊影片的位置:沒有歌在播時是一片灰黑的半透明玻璃,影片蓋上去後只剩貼著影片外緣的 1px 半透明白邊和柔和的陰影,圓角 14px。位置在 `style.css` 的 `--pad`、`--video-*`,OBS 裡影片的位置要跟它一樣。所有底板(字幕、面板、膠囊)是同一種灰黑玻璃:`rgb(24 24 27)`、1px `rgb(255 255 255 / 0.15)` 邊、圓角 14px。

這些不用手動建:在直播機上執行

```bash
pnpm dlx miyoria stage obs-setup --dry-run   # 先看會做什麼,不改 OBS
pnpm dlx miyoria stage obs-setup             # 建好場景和來源
```

它建在 OBS 裡 Miyoria 自己的場景集合和設定檔(預設都叫 `Miyoria`,沒有就建立、有就切過去;你原本的不會被改),OBS 在推流、錄影、虛擬攝影機或重播緩衝開著時不切換。新的設定檔是空白的,從 OBS 推流的話串流金鑰和編碼器要在裡面重新設。`--here` 直接建在目前的場景集合、`--no-profile` 不換設定檔;細節見 [docs/OPERATIONS.md](../../docs/OPERATIONS.md)「Stage 與管理面板」。

它照 `[stage.obs]` 連上 OBS,依 `[modules."stage.link".scenes] roles` 的 `sing` / `chat` / `game` 場景(沒設時是「唱歌」「聊天」,沒有 `game` 就不動遊戲場景)建好下面的版面,並把圓角遮罩寫到 `[stage] data_dir`。只會新增和更新 Miyoria 自己的來源;已經有的項目不會被搬動(要重新擺回預設位置用 `--relayout`),場景裡其他擷取 VTube Studio 的來源只會被隱藏、不會刪掉。版面依 OBS 的基礎解析度等比縮放。

OBS 場景由下到上:

- **唱歌**:`…/overlay/?layer=backdrop&layout=sing` → 影片框場景(影片 1920×1080,縮成 1504/1920 放在 48,48,加「影像遮罩」濾鏡,用 1920×1080、圓角 18px 的 alpha 遮罩)→ VTube Studio(遊戲擷取、勾「允許透明」,縮 0.6 放在右下)→ `…/overlay/?layout=sing`。
- **其他場景**:`…/overlay/?layer=backdrop` → 透明的 VTube Studio → `…/overlay/`。

overlay 的兩個瀏覽器來源(`…/overlay/` 和 `…/overlay/?layout=sing`)都勾「透過 OBS 控制音訊」(`reroute_audio`):唱 K 的伴奏和歌聲是這一頁放的,要變成 OBS 混音裡的一個音訊來源,直播和 Go Live 才帶得到;沒勾的話聲音只會從這台電腦的喇叭出來,只有另外擷取桌面音訊時才會進直播。OBS 只混正在播出的場景裡的來源,所以兩個來源不會同時出聲。已經有的這兩個來源再跑一次 `obs-setup` 會被改成勾選(和網址一樣,是它一定要維持的設定);背景層沒有聲音,照舊不勾。勾了之後 OBS 預設不監聽,直播機自己的喇叭聽不到唱 K,要聽的話在 OBS 的進階音訊屬性把它設成「監聽並輸出」。

VTube Studio 要用透明背景(背景選純色、勾透明),OBS 用「遊戲擷取」並勾「允許透明」,模型周圍才會透出背景。VTube Studio 這一步沒辦法用程式設定,要自己按一次。

## 唱 K

會員頁的多人房間(`docs/design/karaoke.md`「做了什麼第四步」「做了什麼第五步」)出現在直播上。跟著房間的狀態自己變,不用切換:

| 狀態 | 畫面 |
|---|---|
| 沒有房間(`room: null`、沒收過、斷線) | 什麼都沒有,overlay 和以前一模一樣。 |
| `lobby` | 左上角一塊底板:「唱 K 房間」和還可以唱幾首、大大的房號(「在會員頁輸入房號加入」)和旁邊加入連結的 QR code(「掃描加入」)、「下一首」(`song` 在最上面,再來是 `queue`:歌名、歌手、點的人,準備中的標「準備中」、失敗的標「失敗」加刪除線;都沒有時「還沒有人點歌」)、誰在裡面(顏色點、唱 / 看、房主、準備好了沒)、在等什麼(「等大家點歌」「等歌準備好」「等大家準備好(1/2)」「都準備好了,等開房的人按開始」)。其他東西都不動。 |
| `countdown`、`singing` | 整個場景:左邊一塊畫面(1080p 時 48,40 起、1392×940,圓角玻璃),有影片時是調暗的影片(靜音、跟著歌的時鐘走),沒有就是灰黑玻璃;畫面左上是歌名那塊(第幾首、房號、歌名、歌手、升降調、「聽寫」、進度條和時間);中間是音高跑道(見下面);倒數時中間一個大數字「秒後開始」;畫面下方(820 到 980)兩行歌詞;右邊 1470 起是即時排名(名次、顏色點、名字、現在播出的人旁邊一個「播出中」、分數一位小數、「預估」、上下箭頭,換名次時滑過去、亮一下)和播出那一行(「直播播出:伴奏、Mia 的歌聲」)。右下角留給她的模型。`qr_while_singing` 時畫面右上角一個小的 QR code。 |
| `singing` 加 `settling` | 結算中:跑道和歌詞收起來,畫面中間「結算中…」,下面一行還在等誰(「還在等 Mia、Kai 的分數」,超過四個人寫「等 N 人」)或「馬上就好」,一條慢慢移動的微光;排名還在。 |
| `results` | 整個畫面的最後名次:上面是第幾首、房號、剛唱完的歌名和歌手;一個人一列(名次、顏色點、名字、「第一名」「預估」、四項分數(音程 /60、安定 /15、節奏 /15、表現 /10,數字和一條細的比例條)、總分、魚幣或「沒唱完」),第一名整列主色的底和框;四個人以下列比較高、九個人以上比較密;下面是沒發第一名的原因(`note`)、下一首、還可以唱幾首。右上角一個小的 QR code(有 `join_url` 時)。 |

- **歌詞**:和會員頁唱歌畫面同一份程式(`packages/play/karaoke/src/lyrics/`,`@miyoria/play/karaoke/lyrics`):唱的這一行在上、下一行預告在下,休息後前面四個倒數點;白字黑邊,唱到的地方一片一片換成主色(`#f29dc4`);讀音在字上面(`karaoke_ruby`);聽來的歌詞標「聽寫」,和聽到的不太一樣的那一行有點狀底線。沒有時間的那一行整行顯示,不上色。
- **時鐘**(`src/song-clock.ts`,有測試):每則 `karaoke` 說送出那一刻歌在哪裡,頁面用自己的時鐘往前推,下一則再對一次:差 0.3 秒以內的在 1.5 秒內慢慢收掉(稍微快一點或慢一點,不會倒退),差更多就直接跳過去。
- **這一頁就是播放器**(`src/karaoke-player.ts`,算術在 `src/karaoke-audio.ts`,有測試):觀眾聽到的唱 K 聲音(伴奏和現在播出的那個人的歌聲)是這一頁放出來、經 OBS(`reroute_audio`)混進直播的,**不經過她的語音頻道**。她的 TTS 不在 OBS 的混音裡,在語音頻道。每一首一個 Web Audio 的 AudioContext,歌裡的時間 `s` 在它的時鐘上是 `base + s`:`base` 從歌的時鐘來,兩個差超過 150 ms 才重新對、伴奏從正確的位置重新開始,小的差不動聲音。聲音在跑的時候,歌詞、上色、進度和影片都跟著聲音的時鐘,看到的和聽到的一致。
  - **伴奏**:`pcm` 直接把 s16le 放進 AudioBuffer(不靠 OBS 瀏覽器的 AAC 支援),`m4a` 用 `decodeAudioData`;從歌的 0 秒開始,中途接上的從那個位置開始。
  - **歌聲**:每段 µ-law 照 G.711 解開成 16 kHz 的 AudioBuffer,排在 `base + at_ms/1000`,一段接一段剛好接上;開始時間已經過了的只放剩下的,整段過了或超前 3 秒以上的丟掉。
  - **音量**:伴奏 `backing_gain`(`backing` 是 false 時 0)、歌聲 `voice_gain`;她說話時(`speaking`)兩個在 0.2 秒內降到 `duck_gain` 倍,停下後 0.4 秒回來,聽兩邊的人還聽得清楚她主持的話。
  - **自動播放**:OBS 的瀏覽器來源本來就能出聲;一般瀏覽器(示範)會先擋著,點一下或按一個鍵才開始,這時只在 `?demo` 或 `debug` 顯示「按一下開聲音」,沒開之前畫面跟著歌的時鐘走。結果、等人、房間結束、換下一首時全部停掉、關掉。
- **影片**:`<video>` 靜音、`playsinline`、沒有控制列,跟著歌的時鐘(和會員頁同一套 `video-sync`:差 0.25 秒以上跳、小差調速度、沒在唱就停);出錯或卡住就拿掉,只剩玻璃。結果時不放影片。
- **音高跑道**(`src/lanes.ts` 純函式有測試,`src/lanes-view.ts` 畫):倒數和唱的時候,一個唱的人一條(最多 8 條,照加入的順序,換名次時不跳),疊在歌名那塊和歌詞中間(1080p 時 68,240 到 1420,784;有讀音時矮一點)。一個人一條大的(240 px),二到四人一條約 150 px,更多人平分。每條左邊是顏色點、名字和即時分數,右邊是 canvas:這一首的參考音符(`karaoke_lyrics.notes`)從右往左捲,「現在」的線在 25% 寬(一條 10 秒),唱過的變暗、正在唱的最亮;唱的人的音高線用他的顏色(第 6–8 個顏色畫虛線),最新一點有一個圓點。音高是排名每秒帶來的那一段(約 1.5 秒),每個人(名字 + 顏色)接起來,新的一段從它的第一格起取代舊的,只留最後 6 秒;畫在和歌詞、伴奏同一個晚了的歌的時鐘上,只畫到「現在」,所以線剛好落在當時唱的音符上。每一點移到附近音符的那個八度(唱低八度的人也對得上),超過 5 個半音的跳或沒聲音就斷開。音高範圍是整首音符的上下多 3 個半音、至少 14 個半音,整首不變。
- **QR code**(`src/qr.ts`,有測試:和 `uqr` 做的參考碼逐格比對):`join_url` 在頁面裡產生(不連網),byte 模式、M 級、版本 1–10;深色方塊在白底上,四格的安靜區,`shape-rendering: crispEdges`,每格整數個像素。等人時在房號旁邊(1080p 時約 185–230 px,一般的連結是版本 3 或 4),結果時在畫面右上角小的(約 110–125 px),唱的時候只有 `qr_while_singing` 才有。沒有 `join_url` 就沒有 QR code,房號照樣顯示。
- **轉場**:等人 → 倒數 → 唱 → 結算中 → 結果,每一塊用 overlay 同一套進出(`motion.ts` 的 `is-out`:淡入加一點位移 260 ms、淡出 200 ms),結果的每一列依序升上來(差 60 ms);`<html data-karaoke-phase>` 是現在的階段。減少動態時都沒有動畫。
- **讓位**:唱的時候(`<html data-karaoke="stage">`、`data-karaoke-state`)側邊面板淡出(排名佔它的角落)、她的字幕不顯示(唱的時候她本來就不講話);結果時字幕移到畫面下緣;禮物和付費留言移到歌名那塊下面、畫面中間。等人時只多那一塊底板。
- **減少動態**:沒有影片,上色一片一片跳、不滑,換名次不亮;跑道不捲動,一次停一頁(10 秒),「現在」的線自己往右走;結果的列不升上來、結算中的微光不動。
- 名字、歌名都是不可信的文字,只用 `textContent` 放進去。

**示範**:`?demo=karaoke`(或 `?karaoke_demo=1`)不用 Core 和 Stage,一直循環:等人(一開始「還沒有人點歌」,房主點了一首,其他人進來時各點一首:一首好了、一首準備中(之後好了)、一首失敗;一個一個進來、選唱或看、準備好;房號旁邊是示範連結 `https://example.com/karaoke/room/<房號>` 的 QR code)→ 倒數 → 唱(編的日文 / 中文歌詞、每片的時間和讀音、每個字一個參考音符、四條跑道:一個人唱得準、一個低八度、一個偏低、一個飄來飄去還會斷,名次會換、一個人是預估、一個人的歌聲播出、唱到一半換成另一個人;每隔一首唱的時候右上角留一個小的 QR code)→ 結算中(等兩個人、一個人、馬上就好)→ 結果(四項分數、有第一名和魚幣、有人沒唱完,或沒有第一名和原因、下一首)→ 下一首的等人;唱完四首換一間房。背景影片是會員頁示範用的測試畫面,只在 `pnpm dev` 裡有,build 出來的檔案不含影片(那時是玻璃)。聽得到:頁面自己做的伴奏(幾個和弦和節拍,和 worker 一樣是 raw PCM)和播出那個人的「歌聲」(每個字一個單純的音,µ-law、四分之一秒一段、提前半秒送,和 Core 一樣),都經過同一個播放器;瀏覽器要先點一下。

## 彈幕

觀眾付幾枚硬幣送一行短字(預設最多 30 字),Core 先扣款,Stage 轉給這一頁,這一頁顯示並**回報這一行的下場**,Core 才知道要留下這筆錢(顯示了)還是退回去(沒顯示)。回覆跟推送走同一條 WebSocket(契約是 `@miyoria/contracts/overlay` 的 `OverlayReply`):

| 回覆 | 什麼時候 |
|---|---|
| `{"type":"danmaku_ready"}` | 每次連上(含重連)後送一次,而且只有彈幕層開著的頁面才送。Stage 只等送過這個的頁面回覆。 |
| `{"type":"danmaku_shown","id"}` | 這一行真的放進畫面、開始橫越的那一刻,送一次。 |
| `{"type":"danmaku_dropped","id","reason"}` | 不會顯示了:`queue_full`(來的時候已經有 `queue_max` 行在排隊;`queue_max` 是 0 時,不能馬上出發的一律丟掉)、`too_late`(排了 `max_wait_ms` 還沒有空的跑道)、`cleared`(排隊時被 `danmaku_clear` 清掉)。 |

連線還在時,收到的每一行剛好回一次(`shown` 或 `dropped`);同一個 `id` 重複收到不會再回。斷線時還在排隊的直接忘掉、不回(Stage 會把沒回的當成遺失),正在橫越的照樣跑完;重連後不補送舊的回覆。`?demo=1` 沒有人可以回,回覆只寫到 `console.debug`。

**跑道**(`src/danmaku.ts`,純函式,有測試):每一行都用同一個慢慢的速度往左走(`10rem/s`,1080p 是 160 px/s,長的不會比較快)。寬 w 的一行從跑道右緣 x = W 進來,x + w < 0 時結束、移出 DOM。同一條跑道上,前一行的尾巴離開右緣 `2.5rem` 之後才放下一行;速度一樣,所以同一條跑道的兩行永遠不會疊在一起。新的一行放在最上面那條空的跑道;畫面上最多 `max_on_screen` 行,其他的照順序排隊。每行到的時候先在畫面外量出真正的寬度,再決定跑道;移動用 rAF 時鐘算出的 `transform`,不用 CSS 動畫。

**位置**:每條跑道 `2.75rem` 高,條數 = 範圍高度 ÷ 跑道高度(至少一條)。預設版面在畫面上方三分之一(上緣往下 `1.5rem` 起,到 33.333%,1080p 是 7 條);`layout=sing` 只在歌曲影片的範圍裡、影片上方三分之一(1080p 是 6 條),在影片左右兩邊被切掉,不會經過右下角的她。`danmaku_band` 可以改上下範圍。彈幕在所有底板(側邊面板、禮物那一行、付費留言)下面,經過時從底板後面穿過去,底板上的字一直看得清楚。

**樣子**:一行不換行。送的人名字小一點、淡一點放在前面(名字隱藏時沒有);字是 `--ink`,外面一圈多層的深色陰影當描邊,底下一顆很淡的灰黑膠囊,疊在很亮的畫面上也讀得到。`danmaku_clear` 時畫面上的行原地淡出。

## 行為細節

- **打字機**:整行文字從第一個 frame 就排好版(還沒打到的字是透明的),所以字不會在打的過程中跳行。以 code point 計算,不會把 emoji 拆開。字幕修正(同 turn 的文字前綴改變)時,只重打有變的部分。
- **字幕消失**:`final` 之後,等打完、她停止說話,再停留 `2.2 秒 + 每字 55 ms`(上限 9 秒)後淡出。沒有 `final` 又 8 秒沒更新、也不在說話,視為殘留,淡出。
- **字型**:用系統字型(Segoe UI Variable / 微軟正黑體 / Noto Sans TC)。中文字型檔太大,不內嵌;OBS 所在的 Windows 都有。
- **活動膠囊**:(旁邊有時有第二行:準備中的歌,比膠囊小、安靜一點,不會取代她正在做的事。)左下角、她的聲音條右邊(`left: 10rem`,比字幕底板低,不會重疊)。一個情緒色的點、短短的狀態文字、歌名(太長會省略),底部膠囊裡面一條進度條:有進度時平順地長到新的值;唱歌時從唱到的地方線性跑到歌的結尾(CSS 動畫,不用一直收訊息);沒有進度時是一道慢慢移動的微光。換狀態時文字交叉淡化、膠囊寬度緩動到新的長度;沒事做時淡出。
- **動態**:全部用同一套:出現時淡入 + 輕微位移(或高度展開),`--t-enter` 260 ms、`--ease-out`;消失 `--t-exit` 200 ms;文字改變交叉淡化 `--t-change` 240 ms;排序、寬度 `--t-move` 280 ms;進度 `--t-progress` 700 ms(都在 `style.css` 的 `:root`)。元素要等消失的動畫跑完才移出版面(`hidden`)。側邊面板的區塊(情緒、狀態、佇列)和裡面的「直播中」、場景名稱、「還有 N 項」用 0fr → 1fr 的 grid 列展開 / 收起,面板高度跟著平順變化;佇列每一項有自己的 key,新的展開進來、移除的收起後才刪掉、換位置的滑過去(FLIP);情緒名稱、場景名稱交叉淡化;連線點換色。`prefers-reduced-motion` 時所有時間變成 1 ms,微光、呼吸都停掉(唱歌的進度條照常走,那是資訊)。

## 結構

```
src/feed.ts        訊息型別、parseMessage、reduce、shownActivity(純函式,有測試)
src/typewriter.ts  打字機步進、code point 工具、停留時間(純函式,有測試)
src/config.ts      query string(有測試)
src/emotion.ts     情緒名稱 → 顏色(同亮度同彩度,只轉色相)
src/connection.ts  WebSocket 重連、送回覆(只在連線開著時)
src/view.ts        DOM、rAF 迴圈、字幕計時、面板與佇列(FLIP)
src/danmaku.ts     彈幕跑道、上限、排隊、每行的回覆(純函式,有測試)
src/danmaku-view.ts 彈幕層的 DOM:量寬度、擺進跑道、移動、送回覆
src/activity.ts    活動膠囊(文字、寬度、進度條)
src/backdrop.ts    背景層(?layer=backdrop):背景圖、壓暗、唱歌版面的影片位置
src/motion.ts      共用動態:is-out 進出、交叉淡化、讀 CSS 的時間
src/karaoke.ts     唱 K:狀態和階段 → 畫面上有什麼、QR code 在哪、排名、結果的列、文字(純函式,有測試)
src/song-clock.ts  唱 K 歌的時鐘(純函式,有測試)
src/karaoke-audio.ts 唱 K 的聲音的算術:µ-law、raw PCM、放在聲音時鐘的哪裡、降音量(純函式,有測試)
src/karaoke-player.ts 唱 K 的播放器:伴奏和歌聲(Web Audio)
src/karaoke-view.ts 唱 K 的 DOM:等人的底板(下一首、QR code)、畫面和影片、歌詞上色、排名(FLIP)、結算中、結果
src/lanes.ts       唱 K 的音高跑道:誰有一條、每個人的音高接起來、位置(純函式,有測試)
src/lanes-view.ts  音高跑道的 canvas
src/qr.ts          QR code(byte 模式、M 級、版本 1–10,有測試)
src/karaoke-demo.ts ?demo=karaoke 的假房間
src/demo.ts        ?demo=1 的假資料(說話、思考、做歌的每個階段、唱歌、佇列變動輪流來,彈幕偶爾一行、定時一大波超過跑道和排隊上限)
src/style.css      版面與視覺
```
