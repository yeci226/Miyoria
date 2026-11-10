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

| `{"type":"activity","kind","label","detail","progress","elapsed_ms","duration_ms"}` | 活動膠囊(見下面)。`kind`:`thinking`(思考中…)、`synthesizing`(產生語音…)、`song_prepare`(下載中 / 讓出顯示卡中 / 分離人聲 / 轉換歌聲 / 混音 / 找歌詞,`detail` 是歌名,`progress` 是 worker 的進度)、`singing`(正在唱,`elapsed_ms` + `duration_ms` 由 overlay 自己的時鐘推進度);`kind: null` 隱藏。不認得的 `kind` 當成沒有進度的狀態顯示。 |
| `{"type":"gift","text"}` | 禮物那一行(上方中間的小膠囊,例如「Owen 餵了她一碗白飯」)。Stage 把 60 秒內同一種禮物合併成一行(「Owen 和另外 3 人餵了她 5 碗白飯」),送出最新的一行,`text: ""` 表示淡出(最後一份禮物後約 8 秒)。 |
| `{"type":"notice","text"}` | 舊版 Core 的一行狀態(「準備歌曲中…」,`""` 清掉)。沒有 `activity` 時顯示在活動膠囊裡(沒有進度)。 |
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
| `show` | `subtitles,emotion,status,queue,wave,activity,gifts,screen` | 要顯示哪些部分,逗號分隔。例如 `?show=subtitles,queue`。沒有任何有效名稱時視為預設。 |
| `cps` | `14` | 打字機基本速度(每秒字數,2~200)。字幕來得比顯示快時會自動加速追上;`200` = 不做打字效果。 |
| `scale` | `1` | 整體縮放(0.4~3)。1 是以 1080p 為準,版面隨畫面寬高等比,720p / 4K 看起來一樣。 |
| `demo` | 關 | `?demo=1` 播一段內建的假資料,不用連 Stage,設計和預覽用。 |
| `debug` | 關 | 推送斷線時在左下角顯示 "feed offline"(預設不顯示,避免上了直播畫面)。 |
| `layer` | `overlay` | `backdrop`:這頁變成整個場景最底下的背景層(見下面),不連推送。 |
| `layout` | `default` | `sing`:唱歌場景的版面。影片在左上(1080p 時 48,48 起、1504×846),她的模型站在右下角、蓋住影片一角;字幕移到影片下緣、活動膠囊在影片正下方、聲音條改成橫的貼在畫面底部、側邊面板對齊同樣的邊距。 |

### 背景層與唱歌場景

`?layer=backdrop` 畫 Stage 的 `/overlay/backdrop`(`[stage] overlay_backdrop` 指定的圖),上面一層中性的暗色;沒有圖就是近黑色。加上 `&layout=sing` 時多一塊影片的位置:沒有歌在播時是一片灰黑的半透明玻璃,影片蓋上去後只剩貼著影片外緣的 1px 半透明白邊和柔和的陰影,圓角 14px。位置在 `style.css` 的 `--pad`、`--video-*`,OBS 裡影片的位置要跟它一樣。所有底板(字幕、面板、膠囊)是同一種灰黑玻璃:`rgb(24 24 27)`、1px `rgb(255 255 255 / 0.15)` 邊、圓角 14px。

這些不用手動建:在直播機上執行

```bash
npx miyoria stage obs-setup --dry-run   # 先看會做什麼,不改 OBS
npx miyoria stage obs-setup             # 建好場景和來源
```

它照 `[stage.obs]` 連上 OBS,依 `[modules."stage.link".scenes] roles` 的 `sing` / `chat` / `game` 場景(沒設時是「唱歌」「聊天」,沒有 `game` 就不動遊戲場景)建好下面的版面,並把圓角遮罩寫到 `[stage] data_dir`。只會新增和更新 Miyoria 自己的來源;已經有的項目不會被搬動(要重新擺回預設位置用 `--relayout`),場景裡其他擷取 VTube Studio 的來源只會被隱藏、不會刪掉。版面依 OBS 的基礎解析度等比縮放。

OBS 場景由下到上:

- **唱歌**:`…/overlay/?layer=backdrop&layout=sing` → 影片框場景(影片 1920×1080,縮成 1504/1920 放在 48,48,加「影像遮罩」濾鏡,用 1920×1080、圓角 18px 的 alpha 遮罩)→ VTube Studio(遊戲擷取、勾「允許透明」,縮 0.6 放在右下)→ `…/overlay/?layout=sing`。
- **其他場景**:`…/overlay/?layer=backdrop` → 透明的 VTube Studio → `…/overlay/`。

VTube Studio 要用透明背景(背景選純色、勾透明),OBS 用「遊戲擷取」並勾「允許透明」,模型周圍才會透出背景。VTube Studio 這一步沒辦法用程式設定,要自己按一次。

## 行為細節

- **打字機**:整行文字從第一個 frame 就排好版(還沒打到的字是透明的),所以字不會在打的過程中跳行。以 code point 計算,不會把 emoji 拆開。字幕修正(同 turn 的文字前綴改變)時,只重打有變的部分。
- **字幕消失**:`final` 之後,等打完、她停止說話,再停留 `2.2 秒 + 每字 55 ms`(上限 9 秒)後淡出。沒有 `final` 又 8 秒沒更新、也不在說話,視為殘留,淡出。
- **字型**:用系統字型(Segoe UI Variable / 微軟正黑體 / Noto Sans TC)。中文字型檔太大,不內嵌;OBS 所在的 Windows 都有。
- **活動膠囊**:左下角、她的聲音條右邊(`left: 10rem`,比字幕底板低,不會重疊)。一個情緒色的點、短短的狀態文字、歌名(太長會省略),底部膠囊裡面一條進度條:有進度時平順地長到新的值;唱歌時從唱到的地方線性跑到歌的結尾(CSS 動畫,不用一直收訊息);沒有進度時是一道慢慢移動的微光。換狀態時文字交叉淡化、膠囊寬度緩動到新的長度;沒事做時淡出。
- **動態**:全部用同一套:出現時淡入 + 輕微位移(或高度展開),`--t-enter` 260 ms、`--ease-out`;消失 `--t-exit` 200 ms;文字改變交叉淡化 `--t-change` 240 ms;排序、寬度 `--t-move` 280 ms;進度 `--t-progress` 700 ms(都在 `style.css` 的 `:root`)。元素要等消失的動畫跑完才移出版面(`hidden`)。側邊面板的區塊(情緒、狀態、佇列)和裡面的「直播中」、場景名稱、「還有 N 項」用 0fr → 1fr 的 grid 列展開 / 收起,面板高度跟著平順變化;佇列每一項有自己的 key,新的展開進來、移除的收起後才刪掉、換位置的滑過去(FLIP);情緒名稱、場景名稱交叉淡化;連線點換色。`prefers-reduced-motion` 時所有時間變成 1 ms,微光、呼吸都停掉(唱歌的進度條照常走,那是資訊)。

## 結構

```
src/feed.ts        訊息型別、parseMessage、reduce、shownActivity(純函式,有測試)
src/typewriter.ts  打字機步進、code point 工具、停留時間(純函式,有測試)
src/config.ts      query string(有測試)
src/emotion.ts     情緒名稱 → 顏色(同亮度同彩度,只轉色相)
src/connection.ts  WebSocket 重連
src/view.ts        DOM、rAF 迴圈、字幕計時、面板與佇列(FLIP)
src/activity.ts    活動膠囊(文字、寬度、進度條)
src/backdrop.ts    背景層(?layer=backdrop):背景圖、壓暗、唱歌版面的影片位置
src/motion.ts      共用動態:is-out 進出、交叉淡化、讀 CSS 的時間
src/demo.ts        ?demo=1 的假資料(說話、思考、做歌的每個階段、唱歌、佇列變動輪流來)
src/style.css      版面與視覺
```
