# 每個子系統自己的設定和狀態卡

> 2026-11-17 規劃;2026-11-18 做了第一步和第二步(卡片格子),見文末「做了什麼」。owner 的要求在 [v5-play.md](v5-play.md) §11.2:每個子系統要能有自己的設定,系統頁把每個子系統畫成一張有更多資訊的卡,要有一個介面讓子系統自己定義設定項(開關、輸入框這類)。第一個用到的是每週拍賣的頻道。文中的現況是讀程式得來的,沒有執行;§12 是要 owner 回答的事。

## 0. 結論

1. **設定項寫在模組自己的 zod schema 上**:欄位用 zod 4 的 `.meta()` 帶一個 `x-miyoria` 說明(種類、中文標籤、說明、分組、怎麼套用)。zod 會把它原樣放進 JSON Schema,所以面板、CLI、外部擴充讀的是同一份東西。只有帶了說明的欄位會出現在面板上,其餘照舊只在設定檔裡。
2. **面板改的值存進資料庫,疊在 `miyoria.toml` 上**:用已經存在、已經在記模組開關的 `config_revisions`。每次儲存是新的一版,帶誰改的;改錯可以回到上一版。不寫回設定檔。階段 6 把整份設定搬進資料庫時,這一層就是那一份的開頭,不用做兩次。
3. **存了就重啟那一個模組**:supervisor 加一個 `reconfigure`,換掉模組的設定再重啟它(和依賴它的)。今天任何模組設定都要重啟整個 Core 才生效。
4. **狀態卡是模組回報的一小份資料**:狀態、最多四個數字、下一件排定的事、最後的錯誤、一兩個快速動作。面板不認識任何模組,照資料畫。
5. **第一步只做拍賣需要的那一點**:一個模組的設定頁、頻道選擇器、`reconfigure`、疊加層和稽核,再開放十個左右已經有的設定。系統頁的卡片格子是第二步。

## 1. 現況

### 1.1 設定怎麼讀

| 東西 | 在哪 | 做什麼 |
|---|---|---|
| 一份 schema | `packages/core/src/config-schema.ts` 用 kernel 的 `composeConfigSchema` 組:每個頂層段落的 schema 加上每個模組的 `configSchema`(放在 `modules.<id>` 底下,另加 `enabled`) | 啟動前檢查整份檔案;`startPolicy` 決定哪些問題擋下啟動、哪些只警告 |
| 模組的 schema | 各套件的 `config.ts`,約一百個 `z.object`,每個欄位都有預設值 | `ctx.config(Schema)` 在 `start` 裡解析 `[modules.<id>]`;manifest 的 `configSchema` 經 `manifestJson` 變成 JSON Schema |
| 欄位的說明 | 只在 `miyoria.example.toml`(1,391 行)的註解裡 | schema 上沒有任何 `.describe()` 或 `.meta()` |
| 範例檔同步 | `cli/test/templates.test.ts`(兩份範例是同一個檔)、`core/test/config-schema.test.ts`(範例檔沒有任何問題、每個模組都有 schema),economy、sing、agent、imagegen 各有一個「範例的值等於預設值」的測試 | 改預設值要一起改範例檔 |
| 拿掉的鍵 | `core/src/removed-config.ts` | 還寫著的舊鍵在啟動時警告一次 |
| CLI | `miyoria config`(`cli/src/commands/config.ts`)、`settings.ts`(欄位種類 text、url、port、bool、id、ids、secret、choice,給 `init` 和選單用)、`toml-patch.ts`(保留註解和排版的 TOML 編輯) | `config set` 用整份 schema 檢查值再寫檔 |
| 祕密 | `.env`,檔案裡寫 `${NAME}` | `config_revisions` 不收字面上的祕密(`import.ts` 會拒絕) |
| 擴充 | `[extensions."<id>"]`,說明在擴充自己的 `config.schema.json`(JSON Schema),host 用 `z.fromJSONSchema` 轉成 zod | 經 `initialize` 的 `config` 交給擴充 |

### 1.2 改了什麼時候生效(查過)

- Core 啟動時讀一次檔案,`boot.ts` 把每個模組的 `[modules.<id>]` 交給 `supervisor.register`,存在 slot 裡。`Supervisor.restart` 重用同一份,**沒有任何路會換掉它**。所以今天任何模組設定都要重啟整個 Core。
- CLI 寫完設定會照實說:「模組設定在 core 啟動時讀取,這些變更要重啟 core 才會生效」(`afterWrite`)。只有模組開關會經 API 立刻套用。
- [v5-heart.md](v5-heart.md) 寫的「設定改了是 supervisor 重啟這個模組」和程式不符,這份設計把它補成真的。
- 模組開關的記憶已經在資料庫:`ConfigModuleState` 把面板或指令的開關寫成 `config_revisions` 的下一版(作者 `runtime`),開機時和檔案的 `enabled` 取 AND。

### 1.3 資料庫裡已經有的(階段 1 做的)

`packages/store/src/config/`:

- `config_revisions(version, doc, created_at, created_by, note)`:整份文件一版一版存;`write` 有 `expected` 版本(別人先寫了就 `ConfigConflictError`)、`validate` 掛鉤(Core 給 `validateRevision`,Core 起不來的文件寫不進去)、`revert`;每次寫都記一筆 `config.revised` 事件(`keep`,帶作者和改了哪些路徑)。
- `place_settings`:每個 Space、Room 的覆寫,`room → space → cluster → 預設` 解析,寫入記 `settings.changed`。**還沒有人讀它**。
- `importConfigToml`:把整份檔案匯入成第 1 版。寫好、有測試,**沒有人呼叫**;v5-data §7 的「第一次啟動匯入」沒有發生,owner 決定(v5-architecture §16 第 24 項)把它排在階段 6。

### 1.4 面板

- 系統頁(`pages/system/SystemPage.tsx`)三個分頁:子系統(一張 `DataTable`:名稱和 id、狀態、訊息、自動重啟次數、⋯ 裡的啟用 / 停用 / 重新啟動)、擴充套件、MCP。資料是 `GET /api/modules`(`ModuleInfo`:id、name、description、enabled、state、reason、recent_restarts)和 `POST /api/modules/{id}/{action}`。
- 設定頁(`pages/settings/SettingsPage.tsx`)只有這個瀏覽器的連線和登出,跟 Core 的設定無關。電腦頁(`pages/machines/`)是 hostd 的電腦和服務,一台一個區塊,有 `GpuBar`、服務表和啟停。
- 沒有任何列出 Discord 頻道或身分組的路由;權限頁的身分組對應要手打 id。頻道等級頁(`/api/channels/levels`)只列她最近看過的頻道。
- 面板刻意不把 zod 打包進去(`api/orpc.ts`:只載入沒有 schema 的路由表),也不驗證回應。
- DESIGN.md 的規則和這件事有關的:不要有框的軟陰影圓角卡、不要大數字方塊、區塊之間靠間距和細線;每個控制項都要是 Core 真的能做的事;即時控制經 actuator gate(principal `panel`);破壞性的要確認;錯誤用 primary 色和文字。

### 1.5 模組和擴充怎麼宣告

- `ModuleManifest`:`id`、`name`、`description`、`requires`、`optional`、`configSchema`。`Module` 有 `start`、`stop?`、`health?`(`healthy` / `degraded` / `unhealthy` 加原因)。
- Core 認得 42 個模組(`module-ids.ts`),三個不能停(agent、arbiter、heart)。
- 擴充:`miyoria.extension.toml` 的 `[config] schema = "config.schema.json"`,每個擴充是一個 `ext.<id>` 模組,跑在子行程,協定在 `packages/contracts/ext`。
- 路由全部在 `packages/api`;v5-architecture §11.1 的「外掛自己貢獻路由」還沒做。

## 2. 設定項的宣告

### 2.1 原則

- **一個來源**:型別、預設值、範圍、選項從 zod 來;面板要的只多標籤、說明、種類和套用方式,寫在同一個欄位的 `.meta()` 上。不另開一份會和 schema 對不上的描述檔。
- **要開放才出現**:沒有 `x-miyoria` 的欄位不出現在面板。經濟有六十幾個數字,大部分不該被隨手調;v5-architecture §5.6 說的「收成具名的預設組」也是在這一層做(一個 `select` 欄位,選了寫一組值)。
- **祕密永遠不出現**:token、金鑰、密碼不能在面板上改,也不回傳值,只回「有沒有設、從哪個環境變數來」。

### 2.2 欄位種類

| `kind` | zod | 畫成 | 存的值 |
|---|---|---|---|
| `switch` | `boolean` | Switch | `true` / `false` |
| `number` | `number`,`min` / `max` / `int` 從 schema 來,`step` 寫在 meta | Input(數字)或 Slider(`slider: true`) | 數字 |
| `text` | `string`(`maxLength`、`pattern` 從 schema 來) | Input,`long: true` 是 Textarea | 字串 |
| `select` | `enum` | 兩到四個用 `Segmented`,多的用 Select;選項的中文在 meta `labels` | 字串 |
| `multi` | `array(enum)` | 一排 Checkbox 或 chips | 字串陣列 |
| `channel` | `string` 或 `array(string)` | Popover + Command 的頻道選擇器,`multiple: true` 可多選,`room: "text" \| "voice" \| "thread"` 篩種類 | 見 §2.5 |
| `role` | 同上 | 身分組選擇器 | 同上 |
| `person` | `string` | 現有的人物選擇器 | person id |
| `time` | `string`,`/^\d{2}:\d{2}$/` | 時間輸入,照模組的 `utc_offset_minutes` 顯示 | `"20:00"` |
| `weekday` | `int` 0 到 6 | `Segmented`(日 一 二 三 四 五 六) | 數字,0 是週日 |
| `duration` | `number`,單位寫在 meta `unit: "s" \| "min" \| "h" \| "day"` | 數字加單位 | 照鍵名的單位,不換算 |
| `coins` | `int`,`min(0)` | 數字加經濟模組送來的幣名 | 整數 |
| `ratio` | `number` 0 到 1 | 百分比輸入 | 0..1 的小數 |
| `rows` | `array(object)`,物件裡只有上面幾種簡單欄位 | 小表格,加一列、刪一列、上下移 | 陣列 |

其他欄位共有的 meta:`label`、`help`(一句,會顯示在欄位下)、`group`、`order`、`apply`(§5.1)、`danger`(一句為什麼危險,有它就要確認)、`secret`、`scope`(`cluster`,之後可以是 `space`,§4.4)。分組的名字寫在模組根物件的 meta:`groups: [{ id: "where", label: "地點" }, …]`。

### 2.3 寫起來的樣子

拍賣模組還沒寫(下文暫稱 `auction`)。它的設定:

```ts
export const AuctionConfigSchema = z
  .object({
    channel: z.string().default("")
      .meta(setting({ kind: "channel", room: "text", label: "拍賣頻道", help: "每週在這個頻道開一個討論串", group: "where" })),
    weekday: z.number().int().min(0).max(6).default(6)
      .meta(setting({ kind: "weekday", label: "星期幾開", group: "when" })),
    start_at: z.string().regex(/^\d{2}:\d{2}$/).default("20:00")
      .meta(setting({ kind: "time", label: "幾點開", group: "when" })),
    hours: z.number().int().min(1).max(72).default(24)
      .meta(setting({ kind: "duration", unit: "h", label: "拍多久", group: "when" })),
    extend_mins: z.number().int().min(0).max(30).default(5)
      .meta(setting({ kind: "duration", unit: "min", label: "延長", help: "最後這段時間有人出價就延長這麼久", group: "when" })),
    start_price: z.number().int().min(1).default(50)
      .meta(setting({ kind: "coins", label: "起標", group: "price" })),
    utc_offset_minutes: z.number().int().default(480),   // 不開放:沒有 meta
  })
  .meta(settingGroups([{ id: "where", label: "地點" }, { id: "when", label: "時間" }, { id: "price", label: "價格" }]));
```

`setting()` 和 `settingGroups()` 在 kernel 的 `config-schema.ts`,只是把參數包成 `{ "x-miyoria": {...} }` 並檢查型別。`configJsonSchema` 已經是唯一的 JSON Schema 產生器,zod 會把 meta 的自訂鍵原樣放進輸出,所以 `manifestJson` 的 `config_schema` 自動帶著這些說明。kernel 另加 `settingFields(jsonSchema)`:走一遍 JSON Schema,收出 `SettingField[]`(路徑、種類、標籤、限制、預設值),API 和 CLI 都用它。

範例檔的同步測試加一條:有 `x-miyoria` 的欄位,範例檔裡要有同一個鍵(註解也算)。標籤寫在 schema 上之後,範例檔的註解可以慢慢改成從標籤產生,這不在第一步。

### 2.4 外部擴充

擴充的 `config.schema.json` 本來就是 JSON Schema,直接在屬性上寫同樣的 `"x-miyoria": { "kind": "switch", "label": "…" }`。host 已經用 `z.fromJSONSchema` 讀它;只要 kernel 的 `settingFields` 讀的是 JSON Schema 而不是 zod,擴充和內建模組走同一條路。契約(`contracts/ext`)加一個 `SettingMetaSchema` 讓擴充作者有型別,host 在探索時檢查,不合的欄位略過並警告。擴充的設定路徑是 `extensions."<id>".<key>`,改了是重啟那個擴充的行程(新的 `initialize.config`)。

### 2.5 選擇器的選項從哪來

- Core 加一個 `PlaceDirectoryKey` 服務:`spaces()`、`rooms(space, kind)`、`roles(space)`。Discord 模組提供它(從連線的 guild cache;沒連上時退回 identity 的 `spaces`、`rooms` 表,那裡有她看過的地方和名字)。之後的平台各自提供。
- 路由:`GET /api/places/rooms?kind=text`、`GET /api/places/roles?space=`。答案帶名字、所屬伺服器、種類,以及「她看不到這個頻道」這類旗標,面板把不能用的選項顯示成停用並說原因。
- **存什麼**:新的欄位存 context key(`discord:<guild>:<channel>`),這是 `place_settings` 和頻道等級已經在用的格式,階段 6 不用換算。已經存在的頻道欄位(`cards.drop_channels`、`live.channels`)存的是裸的頻道 id,欄位用 `ref: "id"` 照舊存 id。
- 選過的頻道後來被刪了:值留著,面板顯示「找不到這個頻道」和原本的 id,模組照它自己的方式處理(拍賣就是不開,卡片上寫原因)。

### 2.6 驗證和錯誤

- **Core 是唯一的裁判**。面板不帶 zod(§1.4),欄位元件只用 HTML 的 `min`、`max`、`step`、`maxLength` 擋明顯的錯;儲存時 API 用模組的 schema 檢查合併後的整段,錯了回 400,每一筆是 `{ path, message }`,面板放在那個欄位底下(primary 色,`role="alert"`)。
- 訊息用 zod 自帶的 zh-TW 語系(`z.locales.zhTW`,只在這條路由的解析時用,不改全域),前面接欄位標籤:「起標:數字太小,至少要 1」。跨欄位的規則照 TS-CONVENTIONS 不寫 `.refine`,由模組自己檢查;`check_only: true` 的乾跑讓那些錯也回到表單(第一步不需要)。

## 3. 狀態卡

### 3.1 介面

```ts
interface ModuleCard {
  facts: { label: string; value: string | number; unit?: string }[];   // 最多四個
  next?: { label: string; at: Timestamp };                             // 下一件排定的事
  last_error?: { at: Timestamp; message: string };
  actions?: { id: string; label: string; confirm?: string }[];          // 一到兩個
}
interface Module {
  card?(): Promise<ModuleCard>;
  act?(action: string, by: Principal): Promise<void>;
}
```

- 狀態、原因、自動重啟次數照舊從 supervisor 來,不是模組自己說的;`last_error` 沒給時用 supervisor 的 `reason`。
- API 對每個模組的 `card()` 等最多 500 ms,逾時或丟錯就只畫狀態,並在 log 記一次。結果快取 10 秒;卡片的數字不需要更即時。
- 快速動作經 `POST /api/modules/{id}/actions/{action}`,經 actuator gate 以 principal `panel` 執行,和其他即時控制一樣。有 `confirm` 的先開 `ConfirmDialog`。
- 擴充:協定加一個可選的 `status` 請求(host 問、擴充答同樣的形狀),協定版本加一;不回答的擴充只畫狀態。

### 3.2 各模組的卡

| 模組 | 數字 | 下一件事 | 動作 |
|---|---|---|---|
| cards | 今天發出幾張、今天收了多少魚幣、今天掉落幾次、保底觸發幾次 | 每日重置 | — |
| economy | 七天回收率、今天發出、今天收回、流通總量 | 懸賞結算 | — |
| sing | 歌單幾首、正在唱什麼、worker 連不連得上 | — | 暫停歌單 / 繼續 |
| party | 進行中幾場、今天幾場 | — | 結束進行中的遊戲(確認) |
| auction | 這週的拍品、目前最高價、出價人數 | 開拍或結標的時間 | 跳過這週(確認)、換拍品 |
| lottery | 這週賣出幾張、獎池、買的人數 | 開獎時間 | — |
| heart | 認識的人、今天有變動的人、最近一次反思處理了幾個人 | 下一次每晚反思 | —(不能停) |
| llm | 今天花費 / 每天上限、今天呼叫數、失敗率 | — | — |

拍賣的「她自己挑、owner 能指定或跳過」(v5-play §11.1)是動作,不是設定。

## 4. 存在哪、誰贏

### 4.1 兩種做法

| | 寫回 `miyoria.toml` | 資料庫的疊加層 |
|---|---|---|
| 怎麼做 | Core 用 `toml-patch.ts` 改檔案,保留註解 | 面板改的鍵寫成 `config_revisions` 的下一版,開機和套用時疊在檔案上 |
| 誰改的、何時 | 沒有;要另記 | 每一版有作者和時間,`config.revised` 事件已經在記 |
| 改錯了 | 自己記得原本的值 | 回到任何一版(`revert` 已經有) |
| 同時改 | Core 寫檔時你也在編輯器裡改:誰後存誰贏 | `expected` 版本,衝突回 409 |
| 檔案在哪 | 只在 Core 那台;Core 要能寫自己的設定檔 | 資料庫本來就在 Core |
| 和階段 6 | 階段 6 還是要搬進資料庫,做兩次 | 階段 6 把整份匯入同一張表,同一套合併 |
| 壞處 | 寫檔出錯 Core 就起不來;祕密和註解混在一起 | 檔案和面板可能不一致:檔案改了被面板蓋掉的鍵不會生效 |

**選資料庫的疊加層**。壞處用三件事補:開機時 log 列出「面板蓋掉、而且和檔案不同」的鍵;面板每個被蓋的欄位顯示「面板改過 · 檔案是 X」和還原;CLI 的 `config get` / `config set` 碰到被蓋的鍵會說(§5.3)。

### 4.2 合併的規則

- 有效的值 = 檔案(`${NAME}` 展開後)疊上目前這一版的文件。物件逐鍵合併,陣列和純值整個取代。疊加層沒有的鍵照檔案,檔案也沒有就是 schema 的預設值。
- 「還原」是從疊加層刪掉那個鍵(寫一版),不是寫入檔案的值。
- 模組開關已經是這樣:疊加層的 `enabled` 和檔案取 AND。這個規則不變。
- 疊加層不收祕密:`secret` 欄位不能寫;面板送來的值含 `${NAME}` 的也拒絕(環境變數的參照是檔案的事,階段 6 的整份匯入例外)。
- 檔案壞掉時 Core 照舊起不來;疊加層有不合的值(例如升級後 schema 變了)時,那個鍵被略過並警告,模組用檔案或預設值啟動,面板在欄位上顯示「這個值不再有效」。

### 4.3 稽核、匯出和匯入

- 誰:作者寫 `panel:<person id>`(Discord 登入)、`panel:token`(管理 token)、`cli`、`runtime`(開關)。改了什麼:版本是整份文件,前後兩版一比就有每個鍵的舊值和新值,事件不用多帶值。模組頁的「變更紀錄」列出改到這個模組的版本:時間、誰、欄位標籤、舊值 → 新值、備註。
- `miyoria config overrides` 列出疊加層的每個鍵、值、誰改的;`miyoria config bake` 把疊加層寫進 `miyoria.toml`(`toml-patch.ts`,保留註解),再寫一版清空這些鍵,給想讓檔案當唯一來源的人和搬家前用。
- `GET /api/config/overrides` 給 JSON,`PUT` 帶 `expected` 整份換掉,給備份用;都不含祕密。

### 4.4 和階段 6 對齊

- 階段 6 的「Cluster 設定搬進資料庫」就是把 `importConfigToml` 接上:整份檔案寫成一版,之後疊加層就是完整的設定,檔案只剩開機需要的 `[core]`。合併的程式碼不用改。
- 「每個 Space 的設定」:欄位 meta 的 `scope: "space"` 表示它可以每個 Space 不同,寫到 `place_settings`(`plugin` = 模組 id,`key` = 欄位路徑),照 `room → space → cluster` 解析。API 從第一天就收一個可選的 `space` 參數;第一步只有 cluster 這一層,面板不畫選 Space 的控制項。
- 拍賣頻道在多伺服器時天生是每個 Space 一個,所以 `auction.channel` 一開始就標 `scope: "space"`,現在只有一個伺服器時寫在 cluster 層。

## 5. 套用、權限、CLI

### 5.1 套用

| `apply` | 意思 | 例子 |
|---|---|---|
| `module`(預設) | 存了就 `reconfigure` 那個模組:換掉 slot 的設定,停掉它和依賴它的,再啟動。幾秒鐘 | 拍賣、卡片、經濟、派對的數字 |
| `core` | 要重啟 Core 才生效;面板存了之後在頁首顯示「重啟 Core 後生效」 | 頂層段落、綁定位址、資料庫;第一步不開放 |

- `Supervisor.reconfigure(id, section)` 在 supervisor 的佇列裡跑,和 `pause` 一樣「先停、換、再啟動」,所以停的時候模組寫回去的是舊狀態,啟動讀到的是新設定。起不來就照舊是 `failed` 加原因,面板在卡上顯示,疊加層不會自動退版(owner 可以按「回到上一版」)。
- 停模組會打斷進行中的事的那幾個(sing、voice、stage.link)用 hostd 已經有的守衛(`cluster-guards.ts` 的 `singing`、`live`):守衛擋著時照樣存,但重啟等到守衛放開才做,卡片顯示「唱完後套用」。第一步的模組沒有守衛。
- 模組自己熱套用(不重啟,收到新設定就用)以後有需要再加 `ctx.onConfig`;重啟幾秒鐘,現在不值得。

### 5.2 權限

- 看設定要 `admin.panel.access`(管理路由本來的規則)。改設定要新的節點 `admin.settings.<模組 id>`,另外照舊要 `admin.panel.write` 和 CSRF 標頭。owner(`*`)和 admin(`admin.*`)本來就有;moderator 預設沒有,owner 想給可以在權限頁加 `admin.settings.party` 這種。管理 token 什麼都能改。
- `danger` 的欄位打開確認框,說明為什麼危險;第一步不開放任何 `danger` 欄位。

### 5.3 CLI

- `miyoria config get <鍵>`:除了檔案的值,也說「面板改過:X(第 14 版,誰,何時)」。CLI 直接讀資料庫(唯讀)或經 API,哪個可用用哪個。
- `miyoria config set <鍵>`:照舊寫檔。鍵被疊加層蓋著時警告「檔案的值不會生效」,`--clear-override` 同時把疊加層的那個鍵刪掉(Core 在跑經 API,沒在跑直接寫一版,作者 `cli`)。
- 寫完的提示照實說:`apply: module` 的欄位問「要現在重啟 X 嗎」,經 API 的 `reconfigure`;其他照舊說要重啟 Core。檢查值仍是同一份 schema(`validate.ts`),CLI 和面板接受的值一樣。

## 6. API(在 `contracts/api`)

| 路由 | 做什麼 |
|---|---|
| `GET /api/modules` | 照舊,多 `category`(她 / 平台 / 玩 / 系統)、`settings`(有沒有可改的欄位)、`card`(`ModuleCard \| null`) |
| `GET /api/modules/{id}` | 一個模組:上面的全部,加 `requires`、`optional`、依賴它的模組 |
| `GET /api/modules/{id}/settings?space=` | `{ revision, groups, fields: SettingField[], values: { [path]: { value, source: "default" \| "file" \| "panel", file?, set? } } }`;祕密只有 `set` 和環境變數名 |
| `PUT /api/modules/{id}/settings` | `{ expected, set: { [path]: value }, reset: path[], note?, check_only? }` → `{ revision, applied: "restarted" \| "deferred" \| "needs_core_restart", state }`;400 帶 `problems`,409 是版本衝突或守衛擋下 |
| `GET /api/modules/{id}/settings/history?limit=` | 改到這個模組的版本,每一筆的作者、時間、備註、`{ path, label, before, after }` |
| `POST /api/modules/{id}/actions/{action}` | 卡片上的快速動作 |
| `GET /api/places/rooms?kind=&space=`、`GET /api/places/roles?space=` | 選擇器的選項 |
| `GET` / `PUT /api/config/overrides` | 整個疊加層的匯出和匯入 |

`SettingField` 是 JSON 可以表示的:`{ path, kind, label, help, group, order, apply, danger, scope, unit, labels, room, multiple, ref, min, max, step, int, max_length, options, default, columns }`。全部在 `contracts` 裡用 zod 定義,面板 import 型別。Core 提供一個 `ModuleSettingsKey` 服務(手上有檔案的 `Config`、store 的版本和 supervisor),API 模組只呼叫它,不自己合併。

## 7. 面板

### 7.1 系統頁:子系統的格子

- 「子系統」分頁預設是格子,工具列多一個 `Segmented`(格子 / 清單),記在瀏覽器;清單就是今天的表,給要一次看 42 個的時候用。篩選多一項「有設定」。
- 依 `category` 分段,段落標題 15。每個子系統是一個區塊,**不是有框的卡**:上緣一條細線,名字 15 semibold、旁邊狀態點和文字,下面最多四個事實(標籤在上、數值在下,14,不是大數字),再一行下一件事或最後的錯誤(錯誤用 primary 色),最底是「設定 ›」和最多兩個動作(neutral 按鈕)。`xl` 三欄、`md` 兩欄、手機一欄。
- 停用的區塊文字變暗,只剩「啟用」。不能停的(agent、arbiter、heart)沒有停用。

```
系統
子系統  擴充套件  MCP
[搜尋名稱或 id        ]  [全部 · 需要注意 · 已停用 · 有設定]           [格子 | 清單]

玩
─────────────────────────  ─────────────────────────  ─────────────────────────
拍賣           ● 執行中    卡片           ● 執行中    派對遊戲       ○ 已停用
這週      最高     出價    今天   收入     掉落       已停用
她怎麼叫你 180 魚幣 6 人   37 張  1,110    2 次
結標 11/23 20:00          每日重置 00:00
設定 ›   [跳過這週]        設定 ›                     [啟用]
```

### 7.2 一個模組的頁面

- 路由 `/system/$id`(可以分享、從格子、清單、指令面板都能到),頁首 `運作 / 系統 / 拍賣`,頁首的動作是重新啟動和停用。
- 由上而下:**狀態**(一行事實:狀態、id、依賴;卡片的數字和下一件事,快速動作)→ **設定**(依分組,每組一個 13 的小標,欄位一列一個:標籤在左、控制項、說明在下;被面板蓋掉的欄位旁邊是「面板改過 · 檔案:X」和還原)→ **變更紀錄**(最近十筆,載入更多)。
- 有改動時底部出現一條 `.glass-well` 的帶子:「有 2 項沒存」、取消、主要按鈕「儲存並重新啟動拍賣」。儲存的結果走 Sonner;400 的錯放回欄位;409 衝突說「別人剛改過」並重新載入。
- 表單的狀態用 TanStack Form(§10),欄位元件用現有的 `Field`、`Switch`、`Select`、`Segmented`、`Input`、`Popover + Command`。

```
運作 / 系統 / 拍賣                                         [重新啟動]  [停用]

● 執行中   auction   依賴 economy、platform.discord.bot
這週拍品      最高價     出價     結標
她怎麼叫你    180 魚幣   6 人     11/23 20:00(週日)
[跳過這週]  [換拍品]

設定                                         第 14 版 · Owen · 11/17 23:10
地點
  拍賣頻道      [# 活動公告          ▾]   面板改過 · 檔案:沒設   還原
                每週在這個頻道開一個討論串
時間
  星期幾開      [日 一 二 三 四 五 (六)]
  幾點開        [20:00]
  拍多久        [24] 小時
  延長          [ 5] 分鐘
                最後這段時間有人出價就延長這麼久
價格
  起標          [50] 魚幣
                起標:數字太小,至少要 1

變更紀錄
  11/17 23:10   Owen(面板)   拍賣頻道   沒設 → #活動公告
  11/17 22:58   cli           起標       40 → 50

┌ 有 2 項沒存                                 [取消]  [儲存並重新啟動拍賣] ┐
```

## 8. 步驟

每一步都能單獨上線。

| # | 做什麼 | 大小 |
|---|---|---|
| 1 | **拍賣用得到的最小一份**:kernel 的 `setting()`、`settingGroups()`、`settingFields()`;`Supervisor.reconfigure`;Core 的疊加合併(開機和 `reconfigure` 都走它)和 `ModuleSettingsKey`;`PlaceDirectoryKey`(Discord 的文字頻道);路由 `GET/PUT settings`、`history`、`places/rooms`;權限節點;面板 `/system/$id` 的狀態一行加設定表單和變更紀錄(現在的表格每列可點進去);§9 的設定加上 meta;CLI 的 `config get` 顯示來源、`config set` 警告 | 中 |
| 2 | 狀態卡:`card()`、`act()`、`GET /api/modules` 帶卡、系統頁的格子;§3.2 的模組先做 cards、economy、llm、party,拍賣和樂透寫的時候一起做 | 中 |
| 3 | 其餘種類:`role`、`person`、`rows`、`multi`、`ratio`;`check_only`;`config overrides`、`config bake`、匯出匯入路由 | 小 |
| 4 | 擴充:`contracts/ext` 的 `SettingMetaSchema`、協定的 `status`、hello 範例擴充寫一個開關當示範 | 小 |
| 5 | 守衛延後套用(sing、voice、stage.link);開放這些模組的設定 | 小 |
| 6 | 和階段 6 一起:整份匯入、`scope: "space"` 寫 `place_settings`、面板選 Space | 跟著階段 6 |

拍賣模組本身(拍品、出價、延長、討論串)是 v5-play §11 的工作,不在這份設計裡;它寫的時候就照 §2.3 宣告設定。

## 9. 第一批開放的設定

都是 `apply: module`、沒有 `danger`、改錯了不會壞資料的:

| 模組 | 欄位 | 種類 |
|---|---|---|
| auction(還沒寫) | `channel`、`weekday`、`start_at`、`hours`、`extend_mins`、`start_price` | §2.3 |
| lottery(還沒寫,鍵名是草案) | `channel`、`price`、`max_tickets`、`draw_weekday`、`draw_at`、`min_buyers` | 同上的種類 |
| cards | `price`、`daily_cap`、`pity` | coins、number |
| cards | `drops`、`drop_channels` | switch、channel(多選,`ref: "id"`) |
| economy | `card_foil`、`screen_message`、`fortune` | coins |
| party | `song_rounds`、`soup_mins`;`rewards.enabled`、`rewards.coins_per_point`、`rewards.max_coins` | number、duration、switch、coins |
| sing | `start`(`decide` / `auto`)、`max_pending_per_user`、`video` | select、number、switch |
| live | `pats`、`channels` | switch、channel(多選,`ref: "id"`) |

先不開放:卡片的機率(`rarity_weights`,公開的機率表照它算,改了要公告)、經濟的發放數字(要看兩週的數字,v5-play §4.7)、`heart` 的上限和衰減、任何位址、token、模型和 `[llm]`。這些標 `danger` 或留在檔案,等 owner 說要再開。

## 10. 考慮過的套件

| 套件 | 是什麼 | 結論 |
|---|---|---|
| zod 4 的 `.meta()` 和 `z.toJSONSchema` | 自訂的 meta 鍵原樣放進 JSON Schema([zod.dev/json-schema](https://zod.dev/json-schema)) | **用**。說明和 schema 在同一個地方,擴充寫同樣的 JSON。已經在用 zod 4.6 |
| zod 的 zh-TW 語系 | `z.locales.zhTW`,repo 裡的 zod 4.6.7 有 | **用**,只在設定的解析上 |
| TanStack Form 1.x | 無頭的表單狀態:改了哪些、還原、陣列欄位;支援 Standard Schema | **用**它管狀態,不在瀏覽器驗證。面板已經用 TanStack 的 Query、Router、Table。v2 還在 alpha,鎖 1.x |
| react-hook-form 7 | 同樣的角色 | 也可以;選 TanStack Form 只因為同一家、和 Query 的寫法一致 |
| RJSF 6(`@rjsf/core` + `@rjsf/shadcn`) | JSON Schema 直接長出整張表單,另寫 uiSchema | 不用。它要 ajv 在瀏覽器驗證;它會畫整份 schema,我們只要開放的欄位;uiSchema 是第二份描述;頻道、身分組選擇器還是要自己寫成 widget;主題要和玻璃的設計規則對抗 |
| JSON Forms | JSON Schema 加 UI schema | 同上,而且 UI schema 是另一份檔案 |
| AutoForm(`@autoform/zod`)、zod-to-form | zod 直接長出 shadcn 表單 | 不用。要把 zod 打包進面板(面板刻意不帶);擴充給的是 JSON Schema;zod-to-form 還很新 |
| `toml-patch.ts`(自己的) | 保留註解的 TOML 編輯 | 只給 `config bake` 用 |

自己寫的部分只有欄位元件(十來個,大多是現有元件的組合)和 `settingFields`(走一遍 JSON Schema,約一百行)。

## 11. 風險

- **檔案和面板不一致**:有人改了檔案、忘了面板蓋過那個鍵。§4.1 的三個提示是對策;如果還是常發生,就早一點做階段 6 的整份匯入,讓資料庫成為唯一來源。
- **重啟模組的副作用**:模組停了再起,記憶體裡的東西(派對遊戲的「最近的結果」)會清掉,進行中的派對遊戲會結束。表單的按鈕寫明「重新啟動 X」,有進行中的事時確認框說會打斷什麼。
- **meta 太多變雜**:schema 檔變長。只開放要開放的欄位;標籤短。
- **42 個區塊太長**:分段加篩選;清單模式留著。
- **TanStack Form 的 v2**:改寫的大版本在 alpha;鎖 1.x,表單包在一個元件裡,換的時候只改一處。

## 12. 要 owner 回答的

| # | 問題 | 建議 |
|---|---|---|
| S1 | 系統頁的「卡」照 DESIGN.md 畫成沒有框的區塊(上緣細線、間距分開),還是這頁破例用有框的卡? | 照 DESIGN.md,不破例 |
| S2 | 面板改的值存在資料庫、疊在設定檔上(檔案改了被蓋掉的鍵會警告但不生效),還是寫回 `miyoria.toml`? | 存資料庫 |
| S3 | 儲存就重啟那個模組(一個按鈕),還是存和套用分開? | 一個按鈕「儲存並重新啟動 X」 |
| S4 | 誰能改設定? | owner 和 admin;moderator 預設不能,要給再在權限頁加 |
| S5 | §9 的第一批可以嗎?卡片的機率、經濟的發放數字要不要也放上去? | 照 §9;機率和發放數字先不放 |
| S6 | 拍賣和樂透現在就做成每個伺服器一份,還是等階段 6? | 現在只有一份,欄位先標 `scope: "space"`,階段 6 才分 |
| S7 | 子系統分頁預設是格子還是清單? | 格子,清單可以切換並記住 |

## owner 的決定(2026-11-17)

| 題 | 決定 |
|---|---|
| S1 系統卡片的樣子 | 破例做成卡片,但每張卡片背後仍是面板的那一層毛玻璃 |
| S2 面板改的設定存哪裡 | 資料庫,疊在 `miyoria.toml` 上 |
| S3 儲存和套用 | 一個按鈕:儲存並重新啟動那個模組 |
| S4 誰能改 | owner 交給我判斷:owner 和 admin 能改;moderator 預設不能,要的話在權限頁個別給 `admin.settings.<id>` |
| S5 第一批開放哪些設定 | 待回答(owner 問這題的意思) |
| S6 拍賣和樂透要不要每個伺服器一套 | 先一套,階段 6 再分 |
| S7 系統頁預設 | 卡片牆 |
| 卡片上的圖示(owner 2026-11-17 追加) | 每張系統卡片有一個小圖示代表那個系統。模組在自己的宣告裡給圖示的名稱(用面板已經在用的那一套圖示,不放圖檔),沒給的用預設的;外部擴充也能給 |

## 做了什麼(2026-11-18,第一步和第二步)

| 部分 | 在哪 | 做了什麼 |
|---|---|---|
| 設定項的宣告 | `runtime/kernel/src/settings.ts` | `setting()`、`settingGroups()`、`settingFields()`(讀 JSON Schema,所以內建模組和擴充同一條路)、§2.2 的全部種類(型別都有;面板畫 switch、number、text、select、channel、time、weekday、duration、coins、ratio,其餘顯示值並說要改檔案)、`sectionIssues()`(zod 的 zh-TW 語系,只在這次解析用) |
| 疊加層 | `core/src/module-settings.ts` | `ModuleSettings`(`ModuleSettingsKey`):開機時把 `config_revisions` 的 `modules.<id>` 疊在檔案上(`enabled` 照舊另外 AND),不合 schema 的鍵略過並警告,面板蓋掉且和檔案不同的鍵 log 一次;`describe`(欄位、值、來源)、`save`(檢查、寫一版、套用)、`history`、`revert`、`overrides` |
| 重新啟動 | `Supervisor.reconfigure` | 換掉 slot 的設定,在佇列裡停掉它和依賴它的再啟動;停用的模組只存設定。會停到 sing、voice、voice.link、stage.link 的重啟在她唱歌或直播時(`cluster-guards.ts` 的兩個守衛)先存,守衛放開(每 5 秒看一次)才重啟 |
| 地點 | `types/src/places.ts`、`discord/src/places.ts` | `PlaceDirectoryKey`,Discord 從連線的 guild cache 提供(她能不能看、能不能發言 / 加入,不能時的原因);沒連上就是空的、`ready: false`。沒有退回 identity 的表 |
| API | `contracts/api/src/settings.ts`、`api/src/settings.ts` | §6 的路由,除了 `places/roles` 和 `config/overrides`;`GET /api/modules` 多 `icon`、`category`、`settings`、`card`、`pending`;另加 `POST .../settings/revert`;400 帶 `problems`,409 是版本衝突 |
| 權限 | 同上 | 改要 `admin.settings.<id>`(加上 `admin.panel.write`),讀照舊;稽核 `settings.save`、`settings.revert`、`module.card_action` |
| 狀態卡 | `Module.card()` / `act()`、各模組 | cards、economy、market(拍賣和樂透是同一個模組,一張卡)、sing、party、heart、llm;每個模組的 manifest 有 `icon` 和 `category`。快速動作只有唱歌的「停下這首」(經 actuator gate 跑 `sing.stop`) |
| 擴充 | `contracts/ext`、`ext-host` | manifest 的 `icon`;`initialize` 的 contributions 可以說 `status: true`,host 就用 `status` 請求拿卡(`ExtStatusResult`) |
| CLI | `cli/src/commands/config.ts` | `config get` 說被面板蓋掉(第幾版、誰、何時、檔案寫什麼),`config set` 警告,`config overrides`、`config bake` |
| 面板 | `pages/system/` | 卡片格子(預設)和清單的切換、「有設定」篩選、`/system/$id`(狀態、設定表單、變更紀錄),見 `apps/panel/DESIGN.md`「Subsystems and their settings」 |
| 登入 | `api/src/session.ts` | 角色改了,已登入的面板在下一個請求重新判斷;會員 ↔ 管理對不上就失效、要重新登入(經 API 改的立刻,Discord 指令改的最晚 `recheck_secs`)。權限頁的指派對話框說一行 |

第一批開放的欄位(§9,不含卡片的機率和經濟的發放數字):

- market:拍賣開關、拍賣頻道、星期幾開拍、幾點開拍、拍多久、起標、每次至少加、延長、最多延長;樂透開關、樂透頻道、一張的價格、每人每週幾張、星期幾開獎、幾點開獎、最少幾人;點歌優先券的價格、每人每天幾張
- cards:`price`、`daily_cap`、`pity`、`drops`、`drop_channels`、`drop_window_mins`、`drop_min_people`、`drop_min_lines`、`drop_chance`、`drops_per_channel_day`、`drop_gap_mins`、`drop_delay_min_secs`、`drop_delay_max_secs`、`drop_expire_mins`、`drops_per_person_day`
- economy:`card_foil`、`screen_message`、`fortune`
- party:`song_rounds`、`soup_mins`、`rewards.enabled`、`rewards.coins_per_point`、`rewards.max_coins`
- sing:`start`、`max_pending_per_user`、`video`
- live:`pats`、`channels`

和上面設計不一樣的地方:

- **擴充的 `status` 沒有把協定版本加一**:改成 contributions 的一個選用旗標,預設關。版本加一會讓每個沒更新的擴充連不上,旗標不會;SDK 還沒有包裝它,擴充自己回 `status` 請求即可。
- **還原是一個模組的**:「回到第 N 版」只把這個模組在面板上的設定換成那一版的,不是整份文件 `revert`,不然會一起退掉別的模組和開關的變更。變更紀錄的按鈕是「復原這次」(回到這次之前那一版)。
- **作者**寫 `panel:<平台>:<帳號 id>` 和 `panel:token`(不是 person id:API 手上只有帳號);變更紀錄的名字從目前登入的 session 找,找不到就寫 id。
- **TanStack Form 沒有用**:面板沒有這個套件(規定不能 `pnpm install`),表單狀態是頁面自己的 draft(改了哪些、還原哪些),一樣只在 Core 檢查值。
- **分類**寫在 manifest(`category`),不是 API 另外配。`duration` 多了 `ms` 這個單位。面板認得的圖示是 `lib/module-icons.ts` 裡的一組 lucide 名字,不是整套(整套會打包上千個檔);其他名字畫預設的 `Box`。
- **`SettingField` 有兩份型別**:kernel 的 TypeScript 介面(產生它)和 contracts 的 zod schema(API 回應用);contracts 不能依賴 kernel,API 的型別檢查讓兩邊對得上。
- **守衛**不分哪一個:被保護的模組在唱歌或直播任一個守衛擋著時都等。
- 範例檔的同步測試做了(`core/test/module-settings.test.ts`:每個面板欄位在範例檔的那個表格裡都有)。

還沒做:`check_only`、`GET /api/places/roles`(身分組、人物選擇器)、`GET|PUT /api/config/overrides`、`config set --clear-override`、`scope: "space"` 寫 `place_settings`(欄位已經標了)、模組熱套用(`ctx.onConfig`)、派對和拍賣的快速動作(沒有經 gate 的 capability 可以用)。

## 13. 每個地方的設定和整份設定進資料庫(2026-11-22,階段 6 P2)

v5-places.md 是 Space、Room 和 `PlaceConfig` 怎麼解析;這一節是面板、API、CLI 怎麼讀寫每個地方的值,以及 `miyoria.toml` 怎麼匯入資料庫。單一伺服器的安裝升級後什麼都不用做,行為照舊:匯入是 owner 自己下的指令,Core 開機不會做。

### 13.1 每個地方的值

| 部分 | 在哪 | 做什麼 |
|---|---|---|
| Core | `core/src/module-settings.ts` | `describe(id, { space, room })` 給每個 `scope: "space" \| "room"` 欄位多一份 `place`:這個地方自己的值、拿掉它之後的值(`inherited`)、那個值從哪來;`value` 是這個地方實際用的(照 v5-places §3 解析,頻道不在這個伺服器的就不算)。`save` 帶 `place` 時寫 `place_settings`(作者照舊是 `panel:<平台>:<帳號>`),不寫設定版本、不重啟模組,結果是 `applied: "immediate"`;`reset` 是拿掉這個地方自己的值。`placeHistory` 從 `settings.changed` 事件列出這個伺服器(和它的頻道)或一個頻道的變更 |
| 規則 | 同上 | `space` 欄位只能設在伺服器;`room` 欄位可以設在伺服器(那個伺服器沒自己設的頻道跟它)或頻道。`union` 的欄位要是清單。頻道欄位設了別的伺服器的頻道就拒絕(「這個頻道不在 X」)。值照模組的 schema 檢查,錯了一樣回到欄位底下。她還沒看過的頻道,設值時在 identity 建那個 room |
| API | `api/src/settings.ts`、`contracts/api/src/settings.ts` | `GET/PUT /api/modules/{id}/settings` 和 `.../history` 收 `?space=<identity 的 id>&room=<頻道 id>`;沒有 `space` 就是整個安裝,和以前一樣。不認得的伺服器 404,只給 `room` 是 400 |
| 權限 | 同上 | 改整個安裝要 `admin.settings.<id>`(owner、admin 本來就有);改一個伺服器的值,這個節點也可以來自**指派在那個伺服器**的角色(權限頁的指派,範圍選那個伺服器)。進面板本身照舊要全域的 `admin.panel.access`。Discord 身分組對應到的角色在面板上還不算:面板不知道登入的人在那個伺服器有哪些 Discord 身分組(要平台把成員的身分組交給 API,之後再接) |
| 面板 | `app/Shell.tsx`、`pages/system/ModulePage.tsx` | 頁首的伺服器切換(`?space=`,只有一個伺服器時不畫)。模組頁在有欄位可以每個伺服器不同、而且不只一個伺服器時(或有欄位可以每個頻道不同時)多一個「範圍」:全部伺服器、這個伺服器、一個頻道(選頻道)。選了伺服器或頻道,表單只列能在那裡不同的欄位,每個欄位底下說「這個伺服器設的 · 拿掉後是 X」或「沿用全部的值」,按鈕是「儲存到 X」,存了立刻生效。變更紀錄跟著範圍,伺服器的紀錄沒有「復原這次」 |
| 權限頁 | `pages/access/*` | 平台和伺服器從 `GET /api/places/spaces` 來(她在的伺服器,用名字選);一個伺服器都還沒有的安裝照舊是 discord 和手打 id |

### 13.2 疊加層的 `${NAME}` 和「從哪來」

- 疊加層(`config_revisions` 的 `modules.<id>`)裡的字串也可以有 `${NAME}`:開機、面板和重啟模組時都像檔案一樣從環境變數展開,模組永遠拿不到字面上的 `${...}`。環境變數沒設(也沒有 `:-` 預設值)的那個鍵略過並警告,和不合 schema 的值一樣,用檔案或預設值。面板存的值照舊不能含 `${`。
- 疊加層的值和檔案一樣時,來源算「檔案」:匯入之後疊加層就是整份檔案,不會每個欄位都顯示「面板改過」。不一樣才是「面板改過 · 檔案:X」。
- `miyoria config get <鍵>` 說值從哪來:檔案、資料庫第幾版(誰、何時;和檔案一樣時說一樣),再列出每個伺服器、每個頻道自己的值。

### 13.3 `miyoria config import`

把 `miyoria.toml` 寫成資料庫裡的下一版設定(作者 `import`):

- **和目前那一版合併**:面板改過的鍵(`modules.<id>.*`,`enabled` 以外)蓋在檔案的值上,所以模組用的值不變。之前在面板或指令關掉的模組照舊是關的;檔案的 `enabled = false` 也一起進去。
- `${NAME}` 照原樣存(§13.2 會展開);檔案裡有字面上的密碼(`token`、`api_key`、`password` 這類鍵)就整個拒絕、什麼都不寫,並說是哪幾個鍵:先用 `miyoria config set <鍵> <值>` 把它搬到 `.env`(它會自動改成 `${NAME}`),再匯入。
- `[modules.agent]` 的 `channels`、`activeness` 裡寫著伺服器或頻道的項目搬到那個地方的設定;裸的頻道 id 和私訊的留在原處。
- `scope: "space"` 的頻道欄位(拍賣、樂透頻道、卡拉 OK 的留言頻道這類)把全部伺服器那一層的值**複製**到擁有那個頻道的伺服器:context key 自己寫著伺服器,裸的 id 查 identity 看過的頻道;沒人知道的頻道只留在全部那一層。全部那一層的值不刪(頻道規則本來就不讓它跑到別的伺服器)。
- 一個地方已經有自己的值,保留,不蓋掉。
- 只做一次:已經匯入過,再跑就什麼都不寫並說已經匯入過。`--replace` 用檔案原樣蓋掉資料庫的設定(面板之後改的值拿掉,版本紀錄裡還在;每個地方的值也照檔案蓋),已經匯入過也照做。
- `--dry-run` 只印會怎樣:第幾版、和目前不同的路徑、保留的面板值、會寫進哪個伺服器或頻道(新建的標出來)、保留的地方值、留在全部那一層的。沒有 `--yes` 時會問;不在終端機裡又沒有 `--yes` 就不寫。
- 匯入之後:`[modules.*]` 以資料庫為準,檔案再改的鍵會被資料庫的蓋過(開機 log、`config get`、`config set` 會說);`[core]`、`[llm]` 這些頂層段落照舊只讀檔案。要讓檔案再成為唯一的來源:`miyoria config bake`。檔案的 `enabled = false` 進了資料庫,之後在檔案拿掉它不會把模組打開,要用面板或 `miyoria module enable <id>`。

**升級步驟(owner 自己做)**:

1. `miyoria db doctor`:看資料庫在哪、遷移都套用了、「伺服器」那一段的主要伺服器是原本那個。
2. 停掉 Core。
3. 備份:把 `db doctor` 印的資料庫檔,連同旁邊的 `-wal`、`-shm`(有的話)一起複製到別的資料夾。
4. `miyoria config import --dry-run`:讀一遍。被拒絕(檔案裡有密碼)就照訊息把它們搬到 `.env` 再試。
5. `miyoria config import`:確認後寫入(腳本裡用 `--yes`)。
6. 抽查:`miyoria config get modules.market.auction_channel` 這類,看來源和每個伺服器的值。
7. 啟動 Core。log 裡不應該有「the panel's value overrides miyoria.toml」是你沒改過的鍵。

退回:停掉 Core,把第 3 步的檔案放回去。

### 13.4 和計畫不一樣的地方

- 計畫寫「首次開機匯入一次」;owner 2026-11-15 改成手動指令,開機不呼叫(`core/src/boot.ts` 只把 Places 交給設定層)。
- 計畫的「一個伺服器裡對應到 `admin.settings.<id>` 的身分組」:面板上只認指派在那個伺服器的角色,見 §13.1。
- 檔案的 `enabled` 也進了匯入的那一版(原本的測試就是這樣),所以匯入後在檔案打開模組要多一步,見 §13.3。

還沒做:Discord 身分組對應的權限(§13.1)、伺服器值的「復原這次」、一次存多個伺服器、把 `[core]` 以外的頂層段落也從資料庫讀。
