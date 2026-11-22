# Profile:一個獨立的角色

> 2026-11-22。owner 的決定:一個 profile 是一個獨立的角色,一次只跑一個,角色之間什麼都不共用(成員、錢包、記憶都不共用);沒有面板上的切換鈕,也不同時跑兩個,換角色就是停掉、用另一個 profile 啟動。世界觀的詞(魚幣、深海交易所、五檔獨家股票)是 profile 的一部分,預設值是今天的,Miyoria 的行為和用字一個字都不變。電腦(hostd、配對過的電腦、`host.toml`)是共用的,不屬於任何 profile,換角色不用重新配對。現有的資料原地變成 Miyoria 的 profile,不搬、不改名、不刪。這是階段 6 的第一步。

## 1. 一個 profile 是什麼、在哪

profile 就是 `profiles/<id>/` 這個資料夾。它本來就放人格(`profile.toml`、`persona/`、`voice.toml`、`avatar.toml`、`lorebook.toml`);現在它也可以有自己的設定和資料:

```
profiles/<id>/
  profile.toml  persona/  voice.toml  avatar.toml  lorebook.toml   # 人格、聲音、模型(本來就有)
  miyoria.toml   # 她自己的設定:Discord 帳號和伺服器、[character]、世界觀的詞、各模組
  .env           # 她自己的祕密:LLM 金鑰、Discord token
  data/          # 她自己的資料庫和檔案
```

- **有自己的 `miyoria.toml`**:這個角色完全用它。設定檔裡的相對路徑(資料庫、`data/...`)從這個資料夾算,所以資料就在 `profiles/<id>/data/`。
- **沒有自己的 `miyoria.toml`**:用安裝資料夾的 `miyoria.toml` 和 `data/`,和有 profile 之前一樣。今天的安裝就是這樣:`core.profile = "deepseek-chan"`,`profiles/deepseek-chan/` 沒有自己的設定,所以 Miyoria 照舊跑在原本的設定和資料上,什麼都沒動。

資料庫裡的 profile id 本來就是資料夾名稱(`deepseek-chan`),不用改。

## 2. 怎麼選

依序:

1. 環境變數 `MIYORIA_PROFILE=<id>`(只看真的環境變數,不讀 `.env`)。只能選有自己 `miyoria.toml` 的 profile,或安裝設定本來就跑的那個。
2. 安裝資料夾 `miyoria.toml` 的 `[core] profile`(本來就有的鍵)。
3. 都沒有:`deepseek-chan`(本來的預設)。

`miyoria profile use <id>` 改的就是第 2 項(保留註解),下次啟動 core 生效;hostd 每次啟動 core 都重新讀這個檔,所以換角色是 `profile use` 再 `miyoria restart core`,hostd 不用重開。不另加命令列旗標:`--profile` 已經是 `stage obs-setup` 的選項(OBS 的設定檔),共用會混淆。

選好之後,有自己設定的 profile 的 `miyoria.toml` 要寫 `core.profile = "<id>"`、`core.profiles_dir = ".."`(`profile new` 會寫好);寫成別的就拒絕啟動,免得人格和資料對不起來。

## 3. 哪些指令跟著 profile

- **跟著**(她的設定、`.env`、資料):`core`、`chat`、`stage`、`config`、`doctor`、`db`、`memory`、`module`、`decisions`、`events`、`persona`、`discord`、`ext`、`profile validate`。有自己設定的 profile,`--config` 換成它的 `miyoria.toml`。
- **不跟**(這台電腦):`init`、`update`、`hostd`、`up`、`down`、`restart`、`status`、`logs`、`add`、`remove`、`models`、`host ...`、`profile list/show/use/new`。永遠用安裝資料夾的 `miyoria.toml`、`.env` 和旁邊的 `host.toml`。`doctor` 的電腦部分也用安裝資料夾的 `host.toml`。配對過的電腦也是安裝資料夾的(§7)。

**`.env`**:跟著 profile 的指令,在有自己設定的 profile 只載入它自己的 `.env`,不載入安裝資料夾的(別的角色的 Discord token 不能漏過來)。hostd 是用安裝資料夾的 `.env` 啟動的,它把整個環境傳給 core;所以環境裡和安裝資料夾 `.env` 一樣的值當成是從那裡繼承來的:profile 自己有就換成自己的,沒有就拿掉。其他真的設在環境裡的值照舊優先。

## 4. `[character]`:她是誰

在 profile 的 `miyoria.toml`(沒有自己設定的就是安裝資料夾那份):

```toml
[character]
name = "Miyoria"               # 她的本名
short_name = "Miyo"            # 大部分人怎麼叫她;"" = 沒有
other_names = ["米優", "みよ"]  # 簡稱的其他寫法
pronoun = "她"
exchange_name = "深海交易所"
creature = "鯨魚"              # 她是什麼,一個詞(卡片文字的「…的小毛病」);"" = 不特別寫
```

每個欄位的預設值就是今天寫死的字,所以不寫這段的安裝一個字都不變(有測試逐字比對)。寫錯(例如 `name = ""`)Core 不啟動:不然她會用別人的名字起來。

- Core 開機時讀它,放進 `Profile.character`,並提供 `CharacterKey` 服務;模組從服務拿,沒有服務(單元測試)就用 `DEFAULT_CHARACTER`。
- **幣名**本來就是 `[modules.economy] currency`,在 profile 自己的設定裡,不再重複一份;Core 開機時把它讀成 `CurrencyKey` 服務(§8)。
- 角色名字和人格的名字不同:`[character] name` 是她的本名,`profile.toml` 的 `display_name` 是人格的名字(Miyoria 演 DeepSeek-chan)。新角色兩個通常一樣。

## 5. 顯示

- CLI:`miyoria profile show`(名字、選擇的來源、設定檔、資料夾、人格)、`miyoria profile list`(● 是會跑的那個);`miyoria core` 啟動時記一行跑的是哪個。
- 面板:側欄的「她」那一塊顯示 Core 回報的名字;一行小字 `profile <id> · 自己的資料` 或 `安裝資料夾的資料`(`GET /api/profile`)。沒有切換鈕。

## 6. 開一個新角色

`miyoria profile new <id> --name <名字>`:建立 `profiles/<id>/`,從範本放人格(`profile.toml`、`persona/identity.md`、`style.md`)、從範例設定放 `miyoria.toml`(寫好 `[core]`、`[character] name`、`database_url = "sqlite:data/miyoria.db"`,不引用 `${DATABASE_URL}`,免得繼承來的變數指到別人的資料;擴充資料夾指回安裝資料夾的 `extensions/`)、`.env` 範本和空的 `data/`。資料夾已經存在就拒絕,不會寫進任何現有的 profile。寫好人格和 token 之後 `profile use <id>`。

`profiles/*/miyoria.toml` 和 `profiles/*/data/` 加進 `.gitignore`。

## 7. 電腦是共用的

> 2026-11-22 owner 的決定:hostd 和配對過的朋友電腦是所有角色共用的,換角色不用重新配對。

**電腦資料庫 = 安裝資料夾的資料庫。** 配對和電腦的狀態本來就在 `cluster_*` 表,這些表留在原地:安裝資料夾 `miyoria.toml` 的 `core.database_url` 指的那個檔案(預設 `data/miyoria.db`,相對路徑從安裝資料夾算)。不另開 `data/machines.db`,也從不複製:配對只有一份,不會有兩份各自改下去。

- **沒有自己設定的 profile(今天的安裝)**:它的資料庫就是安裝資料夾的資料庫,`cluster` 模組照舊用 store 裡的表(`store.plugin(clusterTables)`),不多開任何連線、不建任何檔案。升級之後磁碟上什麼都沒變(有測試逐位元組比對 `data/`)。
- **有自己設定的 profile**:Core 開它自己的資料庫當 store,另外用同一個 SQLite 驅動和同一套 migration 開安裝資料夾的資料庫,**只給 `cluster` 用**(`openMachineDatabase`,`packages/cluster/src/tables.ts`;底下是 store 的 `openPluginDatabase`)。這條連線只跑 `cluster` 的 migration,其他表(Miyoria 的成員、記憶、錢包、事件)一張都不碰,也不讀。
- **第一次跑、安裝資料夾的資料庫還不存在**(新安裝只跑自己有設定的角色):在那個路徑建一個新檔,裡面只有 `_migrations`(core 的記帳表,只有第一個 migration)和 `cluster_*`,沒有任何角色的表。之後安裝資料夾的角色真的在這個檔上跑時,store 照常補上其他 migration。
- 安裝資料夾的資料庫是 `memory://`(測試用):沒有檔案可以共用,這個角色的電腦就留在它自己的 store(記一行警告)。
- 角色自己的資料庫裡也會有空的 `cluster_*` 表(store 開機時照樣 migrate 所有表),但不用、一直是空的。這一步之前用新角色配對過的電腦(如果有)留在它自己的資料庫裡,不搬、不刪、不用;重新配對一次就好。
- 一次只跑一個角色,所以同一個檔案同時只有一個 Core 寫;CLI 的離線指令(`db`、`memory`)同時開也沒關係,WAL 和 busy timeout 本來就處理。

安裝資料夾的資料庫怎麼找:讀安裝資料夾的 `miyoria.toml`,`${...}` 的展開和安裝資料夾自己的 Core 一樣:先看真的環境變數,再看安裝資料夾的 `.env`;**角色自己 `.env` 裡的值不算**(例如它自己的 `DATABASE_URL`),不然電腦會跟著跑到她的資料庫。這在 `machineSource`(`packages/core/src/profiles.ts`),`miyoria core`/`chat` 啟動時算好交給 Core。

**搬的和不搬的:**

| 在電腦資料庫(共用) | 留在角色自己的資料庫 |
|---|---|
| `cluster_hosts`:電腦的 id、名字、金鑰的 SHA-256、核准狀態、核准的能力 | 她的一切:成員、身分、羈絆、記憶、錢包和經濟、卡片、交易所、事件、設定 |
| `cluster_invites`:加入碼(雜湊) | 面板的模組開關和設定修訂(`config_*`) |
| `cluster_estimates`:每台電腦量到的速度 | |
| `cluster_controls`:面板上的釘選、排除、權重、暫停接新工作 | |

服務的用途表(`cluster.llm`/`fetch`/`resolve` 能用什麼)在程式裡,不在資料庫,兩邊一樣。

**`[modules.cluster]` 跟著安裝資料夾。** 這一段的每個鍵都在描述電腦,不是她:`bind`、`public_url`(電腦連進來的位址,hostd 的 `host.toml` 指的就是它)、`static`(不歸 hostd 管的服務和它們的 token)、`order`、`retry_secs`、`hello_timeout_ms`、`ping_secs`、`peer_timeout_secs`、`routes`(各電腦的連線路徑和探測),和整個 `[modules.cluster.routing]`(權重、暫停、各能力的釘選和排除、傳輸速度、單位時間,以及 `allow_on_speech_host`/`idle_minutes`/`speech_penalty_secs`:它們決定的是「講話那台電腦能不能接唱歌的工作」,還是電腦的事)。所以有自己設定的角色,`cluster` 模組用**安裝資料夾** `miyoria.toml` 的 `[modules.cluster]`(含 `enabled`)跑,角色自己 `miyoria.toml` 裡的這一段不用(它還是得通過設定檢查)。不然換個角色,`bind` 就可能從 `0.0.0.0` 變回預設的 `127.0.0.1`,朋友的電腦就連不進來。這一段沒有面板可改的欄位,所以不會有角色資料庫裡的修訂蓋在上面。`[modules.cluster.static]` 的 token 用安裝資料夾 `.env` 的值,那是電腦的祕密,不是哪個角色的。

## 8. 世界觀的詞:現在可以設定的

> 2026-11-22 第二步。預設值都是今天的字,沒有 profile 設定的安裝輸出逐字不變(prompt、Discord 文字、圖的資料、面板、首頁都有測試比對)。

| 詞 | 鍵 | 預設 | 用在哪 |
|---|---|---|---|
| 幣名 | `[modules.economy] currency`(只有這一份) | `魚幣` | Core 開機讀成 `CurrencyKey` 服務(和 `CharacterKey` 一樣);錢包、簽到、轉帳、禮物、拍賣、卡片、預測、房間、派對獎勵、點歌券、交易所的每一句、圖、面板頁、LLM 工具說明和 prompt 裡的那一句。純函式拿 `currency` 參數,預設 `DEFAULT_CURRENCY` |
| 免責小字 | 跟著幣名 | `魚幣是遊戲點數,沒有現金價值,…不是投資建議。` | `exchangeDisclaimer(currency)`、`transferSmallPrint(currency)`:只換幣名,其他字一個不動;每個原本有小字的地方照樣有(walker 測試用預設和 `貝殼` 各跑一次) |
| 交易所名 | `[character] exchange_name` | `深海交易所` | Discord 卡片標題、面板交易所頁 |
| 代名詞 | `[character] pronoun` | `她` | 這次改過的句子(交易所、錢包指令、轉帳、面板交易所和狀態字);其他還直接寫「她」 |
| 她是什麼 | `[character] creature`(新) | `鯨魚` | 卡片文字的 prompt:「有你的尾音、吐槽和鯨魚的小毛病」;`""` = 「有你的尾音和吐槽」 |
| 五檔獨家股票 | `[modules.exchange.local_companies.<角色>]`:`code`、`name`、`anchor`、`what_moves`、`blurb` | feeding `RICE` 白飯食品 100、songs `WHLE` 鯨落唱片 108、silence `NAPS` 打盹床業 88、game `CUBE` 方塊礦業 116、model `DPSK` DipSick AI 94 | 見下 |
| 首頁 | `profiles/<id>/landing/landing.json` | 第一個角色:今天那一頁 | 見 §9 |

**獨家股票。** 訊號的邏輯跟著「角色」走,寫在程式裡:`feeding`(餵食)、`songs`(唱完的歌)、`silence`(沒說話的小時)、`game`(遊戲目標和死掉)、`model`(模型出錯和太慢,只會跌)。每個角色的代號、名字、起始價、「什麼讓它動」那一句和舊市場的簡介是 profile 的;`what_moves`/`blurb` 不寫就照名字和代名詞自動寫,用預設名字時就是今天那一句。代號要四個大寫字母、彼此不同。舊寫法 `local_anchors.RICE` 和 `local_signals.RICE` 照樣能讀(用第一個角色的代號當鍵,等於那個角色),`local_signals.<角色>` 是新寫法。

**改代號是什麼意思。** 持股、委託、成交、價格紀錄、走勢都用代號當鍵存在資料庫裡,價格的隨機走勢也用代號當種子。新 profile 的資料庫是空的,代號隨便取都安全。在已經有資料的資料庫上改代號:舊代號底下還有紀錄時,交易所模組拒絕啟動(Core 照常跑,模組頁寫原因),訊息寫明哪個角色、舊代號、新代號、怎麼辦(改回去,或用新的 profile);舊代號底下什麼都沒有時,它只是從清單下架。設定的代號已經是有人查過的真實股票代號,也拒絕。

**面板怎麼拿到這些詞。** Core 回傳面板的 HTML 時,和她的名字(`og:site_name`)一樣,在 meta 區塊多放一個 `<meta name="miyoria:world" content="{…}">`(JSON:`currency`、`exchange_name`、`pronoun`、`persona`、`landing`);只有在任何一個和第一個角色不同時才放,所以今天的安裝 HTML 一個位元組都不變。面板開頁時同步讀一次(`apps/panel/src/lib/world.ts`),沒有這個 tag(今天的安裝、dev server、測試)就是今天的字。API 回應本來就帶 `currency` 的地方照樣優先用回應的。選同步的 meta 而不是另一個 API 欄位,是因為格式化函式要同步拿到幣名,也不能讓今天的首頁先閃一下別的頁。

**預覽圖。** `/og/default.png` 的名字太長時縮小(最小 56),還放不下就截斷加「…」;Miyoria 照舊是 128。

## 9. 首頁是 profile 的

`profiles/<id>/landing/landing.json`:

- `{"builtin": "miyoria"}`:第一個角色手做的那一頁(面板的 `Landing.tsx` 和 `her/` 的動圖,原地不動)。`profiles/deepseek-chan/landing/landing.json` 就是這一行,所以今天的安裝看到的首頁一模一樣,也不用多等任何請求。
- 她自己的首頁:
  ```json
  {
    "line": "一句介紹(不寫 = 下面那一句)",
    "cover": "cover.webp",
    "sections": [{ "title": "聊天", "text": "標她就好", "image": "chat.webp" }]
  }
  ```
  只有純文字(面板當文字畫,不當 HTML);圖放在同一個資料夾。最多 12 段,標題 60 字、內文 2000 字、介紹 200 字。
- 沒有這個檔:用 `[character]` 做的簡單首頁(名字、「<名字> 是住在 Discord 和直播裡的 AI VTuber。」、直播間、Discord 登入、管理面板)。`miyoria profile new` 建的新角色就是這樣。
- 檔案讀不懂(不是 JSON、欄位不對、圖名不合規):開機記一行警告、用簡單首頁,不會擋 Core 啟動;只是某張圖不見或不合規:那張拿掉、記一行。

API(公開面開著時才有):`GET /api/public/landing` 回 `{"kind":"builtin"}`、`{"kind":"plain",name,line}` 或 `{"kind":"own",name,line,cover,sections}`;`GET /api/public/landing/files/<名字>` 只給這一頁用到的圖,規則和面板的靜態檔一樣是允許清單:名字只能是英數、`-`、`_` 加圖片副檔名(webp、png、jpg、avif、gif),直接在資料夾裡、是一般檔案(不跟符號連結)、最多 8 MB,每次請求重新檢查,`nosniff`,型別照副檔名。

## 10. 還寫死的,和為什麼

| 項目 | 為什麼留著 |
|---|---|
| Discord 指令名(`/miyo`、`/me`、`/exchange`…) | 改名是成員看得到的變更,owner 沒有要;也不是一個設定鍵就能乾淨換掉(指令樹、權限節點、說明、面板都用這些名字)。之後要再設計 |
| `packages/stage` 的 OBS 場景名、VTS 外掛名 | 是電腦和直播軟體上的名字,不是她的世界;改了要重設 OBS/VTS |
| extensions 的預設值、`tools/replay`、套件名、環境變數前綴(`MIYORIA_*`) | 程式和安裝的名字,不是角色的 |
| 首頁 `Landing.tsx` 的內容(名字、文案、立繪) | 它就是第一個角色自己的首頁(§9),不是共用的範本 |
| 設定說明的幾句管理文字(交易所手續費的說明、彈幕開關的說明、派對「玩完發魚幣」) | 寫在模組設定 schema 的靜態 meta 裡,建 schema 時拿不到 profile;只有管理員看得到 |
| 範例和假資料:`card-face` 的 `samples.ts`、面板交易所的 `demo.tsx`、overlay 的 `karaoke-demo.ts` | 是第一個角色的示範資料,不是真的輸出 |
| 卡拉 OK(`play/karaoke`、面板 karaoke 頁) | 文字的幣名本來就從資料來;這一步另一個工作在改,沒碰 |
| `llm/tools` 搜尋工具的關鍵字(`魚幣`) | 只是加權;工具說明本身已經帶設定的幣名,搜得到 |
| 大部分「她」 | 只在這次改過的句子換成 `pronoun`;要第二個代名詞的角色出現時再全面換 |
| 程式註解、型別說明裡的「魚幣」「深海交易所」 | 不是輸出 |
| 價格走勢的種子 | 用代號:同一個代號同一條走勢,換代號就是另一檔(所以有紀錄時不准換) |
| 面板上建角色 | 不做(owner 決定沒有切換鈕) |
