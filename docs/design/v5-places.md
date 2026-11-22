# 很多地方:Space、Room 和每個地方的設定

> 2026-11-22。階段 6「很多地方」的第一步(P1 基礎):她在幾個伺服器裡、哪個是原本的那個、誰是哪裡的成員,以及一個模組的設定怎麼在每個伺服器、每個頻道不同。這一步只做介面、資料和兩條路由;模組、設定頁和 Discord 的多伺服器是後面的步驟(§8)。單一伺服器的安裝升級後行為不變。v5-architecture §6 是為什麼,這份是做成什麼樣。

## 1. 模型

| 東西 | 在哪 | 說明 |
|---|---|---|
| **Space** | identity 的 `spaces` | 一個 Discord 伺服器。`id` 是 ULID,表和路由都存它;`external_id` 是 guild id。`left_at` 有值表示她已經離開(列都留著) |
| **主要的 Space** | `spaces.is_primary` | 安裝原本的那個伺服器:沒指定伺服器時的預設(管理頁、階段 6 之前的資料)。最多一個;不會自己移動,她離開了也一樣 |
| **原有的 Space** | `spaces.established` | 升級時她已經在的伺服器(identity v4 那時候有列的每一個,主要的和其他的都算;以前離開、之後回來的也算,列本來就在),還有新安裝看到的第一個(主要的)。照 cluster 的設定,跟以前一模一樣。之後才第一次看到的伺服器不是原有的,就是「新的伺服器」(§9),先安靜。標了就不會取消;要讓新的伺服器像原有的一樣,替它設就好 |
| **Room** | `rooms` | 頻道、討論串(`parent_id` 是它的頻道)、語音房、私訊(沒有 Space) |
| **成員** | `space_members` | 在那裡有動作的帳號:說過話、用過指令、按過按鈕或選單、送過表單,或在它的語音頻道裡被看到。`platform.member` 的離開把 `left_at` 寫上,再有動作就清掉 |
| **地方的設定** | `place_settings(scope, scope_id, plugin, key)` | `scope` 是 `space` 或 `room`,`plugin` 是模組 id,`key` 是欄位路徑。沒有另外一張每個 Space 的設定表 |

兩個服務,Core 提供,介面在 `packages/types/src/places.ts`:

- **`Places`(`PlacesKey`)**:`primary()`、`spaces()`(她還在的,主要的排第一)、`space(id)`、`room(id)`、`at(ctx)`(一個 `ContextKey` 在哪個 Space、Room、session,只讀不寫)、`ofGuild(platform, guild)`、`channelSpace(platform, channel)`、`members(space)`、`spacesOf(person)`、`isMember(person, space)`、`seen` / `left`(她加入、離開一個伺服器)、`memberSeen` / `memberLeft`、`onChange`。實作是 `store/src/identity/places.ts` 的 `SpacePlaces`。
- **`PlaceConfig<T>`(`PlaceConfigKey`,模組用 kernel 的 `placeConfig(ctx, Schema)` 拿)**:`base()`(cluster 的值)、`for(where)`(某個地方的值)、`onChange`。實作是 `core/src/place-config.ts`。

`ContextKey` 這一階段還是線上和程式裡的型別,`Places.at` 是它到 Space / Room 的橋。分享的「這個 Space 的成員」(`artifacts/membership.ts`)就是 `Places.isMember`,規則沒變。

**怎麼變成成員**:在一個伺服器裡有動作的人就是那裡的成員。

- 說話:事件記錄寫一則有作者的訊息時,`Identity.resolve` 順手寫 `space_members`(本來就這樣)。
- 不說話的動作:Discord 模組(`discord/src/handler.ts`)在伺服器裡的每個互動派送之前呼叫 `Places.memberSeen(space, account, name)`:斜線指令、右鍵選單、按鈕、選單、表單送出;自動完成不算。語音:連線時已經在語音頻道裡的人、加入或換到一個語音頻道的人也算;同一個頻道裡靜音、拒聽、開直播不寫。機器人和她自己的帳號(機器人帳號、`self_account_ids`)不會這樣變成成員;語音狀態沒有成員資料、分不出是不是機器人的,也不算。
- `memberSeen` 和訊息走同一段寫入:帳號沒有就建(第一次看到就有人物),沒有列就新增,離開過的清掉 `left_at`、更新 `last_seen`。每個互動都會呼叫,所以一分鐘內已經寫過、沒離開、名字沒變的就不寫。不認得的 Space 略過。
- 會員網站:Discord 登入只要 `identify`,不知道這個人在哪些伺服器。哪裡都不是成員的人照舊拿到主要的、`member: false`;他在伺服器裡用一次任何指令或按鈕就是成員了。

## 2. 每個功能的範圍(定案)

| 功能 | 範圍 |
|---|---|
| 錢包、簽到、運勢、餵食、任務、禮物、卡片、羈絆、人物筆記 | 每個人,全域 |
| 交易所(市場、價格) | 全域。富豪榜、成交量榜:全域,也有每個 Space 的(那個 Space 的成員) |
| 贊助榜 | 全域,也有每個 Space 的 |
| 拍賣、樂透 | 每個 Space |
| 點歌優先券 | 價格和每天上限全域;用在那個 Space 的佇列 |
| 預測 | 每個 Space(成員看得到、能下注);錢還是全域的。懸賞:每個 Space |
| 卡拉 OK | 歌、參考、分數是每個人全域;KTV 房和留言頻道每個 Space |
| 貼圖、表情和它們的說明 | 每個 Space |
| 問題回報 | 全域;記下發生的地方當脈絡 |
| 她的房間基金、彈幕、螢幕留言、摸頭 | 全域(一個舞台、一個直播) |
| 卡片掉落 | 每個 Room 自己開;每人每天上限全域 |

設定也照這張表標:每個 Space 的是 `market.*`、`karaoke.comment_channel`、`cards.drops` / `drop_channels`、Discord 的 `ambient_text`、表情和貼圖、`queue.*`;每個 Room 的是話多話少、語音的模式和活躍度、新的 `language`、`actions.forbidden`(union)、Discord 的跟隨頻道。她自己的時鐘(`arbiter.day_start_hour`、`llm.budget.timezone_offset_hours`)和每個人的日界(`utc_offset_minutes` 那幾個)留在全域。

## 3. 設定怎麼解析

欄位在 zod 上用 `setting({...})` 標(v5-settings §2),多兩個 meta:

- `scope`:`cluster`(預設,一個值)、`space`(每個伺服器可以不同)、`room`(每個頻道可以不同,沒設的頻道跟它的 Space)。
- `merge`:`replace`(預設,最近的贏)或 `union`(只對清單有意義:每一層的項目都算)。

只有 `scope` 是 `space` 或 `room` 的欄位會疊。一個欄位的值,依序取第一個有的:

1. 這個 Room 的(`place_settings` scope `room`)
2. 這個 Room 的上層頻道的(討論串的頻道)
3. 這個 Space 的(scope `space`)
4. cluster 的值:模組啟動時的段落(`miyoria.toml` 加面板的那一層)
5. schema 的預設值

`space` 欄位跳過 1、2。之後 agent 自己再套 profile 的預設(值是 `null` 時)。

**兩條規則**:

- **頻道要在那個 Space 裡**:`channel` 種類的欄位,解析給 Space S 的值如果指到不在 S 的頻道,就不算:單一頻道退回 schema 的預設值(通常是空的 = 關),清單拿掉那幾個。不然 cluster 層的拍賣頻道會讓第二個伺服器發到第一個伺服器去。怎麼知道頻道在哪:context key(`discord:<guild>:<channel>`)自己寫著伺服器;裸的頻道 id 先查 identity 的 `rooms`,沒看過的再問 Discord 的即時清單(`PlaceDirectoryKey`)。**都不知道的頻道**:主要的 Space 照用(今天的單一伺服器就是這樣),其他 Space 只有在值是它自己設的(Room 或 Space 那一層)時才用。這裡用的是「主要的」不是「原有的」:兩個原有的伺服器都照用同一個不知道在哪的頻道,同一個工作(拍賣、樂透)就會跑兩次。
- **union 合併**:`merge: "union"` 的清單是 cluster ∪ Space ∪ 上層頻道 ∪ Room(去重,照這個順序),所以禁止清單這種東西,一個頻道沒辦法解開 cluster 禁止的。

**不用重啟**:結果照地方快取;模組的 `place_settings` 一寫(`PlaceSettings.onChange`)或有新的 Space、Room(`Places.onChange`)快取就丟掉,下一次 `for()` 就是新的值,`onChange` 的監聽者會收到是哪裡變了。所以模組要在用到值的地方讀 `cfg.for(...)`,不要在 `start` 讀一次存起來。cluster 層的值(面板的模組設定)照舊是存了就重啟那個模組(v5-settings §5.1)。地方的值不合 schema 時,那一個欄位略過並記一次警告,其他照用。

## 4. 模組怎麼找到自己的 Space

| 從哪裡 | 怎麼做 |
|---|---|
| 指令、一輪對話 | `places.at(inv.context)`;設定直接 `cfg.for(inv.context)` |
| 匯流排的事件 | 信封的 `space_id` |
| 會員路由 | `memberSpace(state, person, input.query.space)`(`api/src/space-param.ts`) |
| 管理路由 | `adminSpace(state, input.query.space)` |
| 每個 Space 一份的排程 | `places.spaces()` 逐一跑,`cfg.for({ space_id })` 有開的才做 |

`home` 不屬於任何 Space(§8 的 P3)。

## 5. Migration

`identity` v2(`store/src/identity/migrations.ts`,在所有外掛之前跑):

```sql
ALTER TABLE spaces ADD is_primary integer DEFAULT false NOT NULL;
UPDATE spaces SET is_primary = 1 WHERE id = (她還在的 Space 裡成員最多的,同數取最早加入的,再取 id 最小的);
CREATE INDEX space_members_account_idx ON space_members (account_id) WHERE left_at IS NULL;
CREATE UNIQUE INDEX spaces_primary_idx ON spaces (is_primary) WHERE is_primary = 1;
```

- 原地升級:不搬檔案、不刪任何列、已經跑過的 migration 不改(有 checksum)。今天的安裝只有一個伺服器,它就是主要的。
- 一個 Space 都沒有的資料庫沒有主要的;`Identity` 之後看到的第一個 Space 變成主要的。
- 已經在兩個以上伺服器的資料庫:選成員最多的那個。之後要換是 owner 的事(還沒有指令,§8)。
- 測試:`store/test/migrate.test.ts` 在一個只跑到 v1 的資料庫上放好每張表的列,升級後每張表的列數一樣,零個、一個、兩個 Space 各一個案例。
- 計畫裡選用的 `core` v8(`events (space_id, type, at)` 索引)這一步沒做:P1 沒有查詢用到它,等 P4/P5 真的有按 Space 查事件的查詢再加。

`identity` v3(`members_who_acted`,只有資料):升級以前,只有說話會變成成員,只用指令或只待在語音裡的人沒有 `space_members` 的列,升級後會從伺服器的榜上消失、不能押那個伺服器的預測。v3 從記錄裡補上能證明在那個 Space 有動作的人,只用寫著那個 Space 的資料:

- 事件自己的 `space_id`(identity 從事件的地方解析出來的)加上做事的帳號 `account_id`。
- 她的語音在場記錄(facts 的觀察,來源是 `voice.joined` / `voice.participants`,存著參與者的帳號):在那個 Space 的語音頻道裡被看到的人,`is_self` 的不算。被遺忘(redact)的記錄不算;環境觀察 14 天後會被摺疊,所以只有最近的。
- 只補 identity 已經有的帳號,平台要和 Space 一樣,她自己的帳號(`is_self`)不算。已經有列的(包括離開的)一律不動,所以離開的人還是離開。重跑不會多寫。
- 補不到的:指令和按鈕沒有留下帶著 Space 的記錄(`economy.posted` 沒有地方,稽核記錄沒有地方),所以只用過指令的人要等他下一次在伺服器裡有動作。經濟和市集的表(下注、樂透券、點歌券)也不用:它們的 `space_id` 是之前的 migration 照主要的 Space 填的,不是看到的,而且那些外掛的 migration 在 identity 之後才跑。語音參與者分不出是不是機器人;機器人的帳號通常是它自己發訊息時才建的,那時候本來就已經是成員。
- 測試:`store/test/migrate.test.ts` 的 identity v3,在 v2 的資料庫上放事件:只有寫著 Space 的列補上成員,別的表列數不變,離開的人不動,重跑不變。

`identity` v4(`established`):`spaces` 多一欄 `established integer DEFAULT false NOT NULL`,升級時已經有的每一列設成 1。之後第一次看到的 Space 是 0,只有新安裝的第一個(主要的)建立時就是 1。`SpaceRef.established` 是這一欄,主要的一定是 true;`GET /api/places/spaces` 和 `/api/member/spaces` 的每個 Space 多一個 `established`。測試:`store/test/migrate.test.ts` 的 identity v4(兩個伺服器加一個離開過的,三個都是原有的、列數不變;之後看到的不是;離開過又回來的還是),`core/test/established-spaces.test.ts`(兩個原有的伺服器、一個 cluster 的拍賣頻道:只有頻道所在的那個跑),`discord/test/gate.test.ts`、`brain/agent/test/place-levels.test.ts`(原有的第二個伺服器和主要的一樣,新的先安靜)。

## 6. API 和面板

| 路由 | 誰 | 回什麼 |
|---|---|---|
| `GET /api/places/spaces` | 管理 | 她在的每個 Space(主要的在前)、每個的成員數、`default`(主要的,沒有就第一個) |
| `GET /api/member/spaces` | 會員 | 登入的人自己是成員的 Space、`default`(主要的如果他在裡面,不然他的第一個;哪裡都不是成員的人拿到主要的) |

- `SpaceQuery`(`contracts/api/src/shared.ts`)是 `?space=<id>`,每條要分 Space 的路由把它放進 query。
- `memberSpace`:問了一個 Space:她不在那裡(或不存在)是 404「找不到這個伺服器」,這個人不是成員是 403「你不在這個伺服器裡」。沒問:他的主要的、不然他唯一(第一個)的;哪裡都不是成員的人拿到主要的,`member: false`,只給成員用的路由自己拒絕。她一個 Space 都沒有是 404。
- `adminSpace`:問了不存在的是 404;沒問是主要的,沒有就第一個,一個都沒有是 `null`。
- 面板:`app/space.ts` 的 `useAdminSpace()` 讀網址的 `?space=`(可以分享、重新整理還在),沒有就用 Core 的預設;`setSpace` 改網址。`pages/public/member-space.tsx` 的 `useMemberSpace()` 和 `SpacePicker`:公開頁沒有 router,選的伺服器記在這個瀏覽器。`SpacePicker` 只有一個伺服器(或沒有)時什麼都不畫,所以單一伺服器的安裝看起來一樣;四個以內是 `Segmented`,更多用 `Select`。這一步沒有接到任何頁面上。

## 7. 用法

標一個欄位(模組的 `config.ts`):

```ts
auction_channel: channel().meta(
  setting({ kind: "channel", ref: "id", scope: "space", label: "拍賣頻道" }),
),
forbidden: z.array(z.string()).default([]).meta(
  setting({ kind: "multi", scope: "room", merge: "union", label: "不能用的功能" }),
),
```

模組裡(和其他核心服務一樣從 `ctx.services` 拿;`placeConfig` 在沒有 Core 的服務時,例如單元測試,每個地方都給 cluster 的值):

```ts
import { placeConfig } from "@miyoria/runtime/kernel";
import { PlacesKey } from "@miyoria/types";

async start(ctx: ModuleContext) {
  const cfg = placeConfig(ctx, MarketConfigSchema);  // 在 start 裡;段落不合會丟 ConfigError
  const places = ctx.services.get(PlacesKey);        // 沒有 Core 時是 undefined

  // 指令或一輪對話:那個地方的值,每次用的時候讀
  const channel = cfg.for(inv.context).auction_channel;
  const where = places?.at(inv.context);             // { space_id, room_id, parent_room_id, session } | null

  // 每個 Space 一份的排程
  for (const space of places?.spaces() ?? []) {
    if (cfg.for({ space_id: space.id }).auction) schedule(space.id);
  }
  // 某個地方的設定改了、或有 Space 加入或離開(room_id 是 null);模組停了自動取消
  cfg.onChange(({ space_id }) => reschedule(space_id));
}
```

寫一個地方的設定(P2 的面板和指令會這樣寫;經 store 的那一個 `PlaceSettings`,寫了就生效):

```ts
store.config.places.set("space", spaceId, "market", "auction_channel", "123456789012345678", "panel:discord:1");
```

一條會員路由:

```ts
// contract:.input(z.object({ query: SpaceQuery }))
handler: async ({ input, context }) => {
  const person = await memberPerson(context.state, context.c);
  const space = memberSpace(context.state, person, input.query.space);  // 404 / 403
  ...
}
```

面板:

```tsx
const { space } = useAdminSpace();                    // 管理頁:傳 { query: { space: space ?? undefined } }
const { space, spaces, setSpace } = useMemberSpace(); // 會員頁
<SpacePicker value={space} spaces={spaces} onChange={setSpace} />
```

## 8. 這一步沒做的(P2–P5)

| 項目 | 給誰 |
|---|---|
| 設定匯入成一版、面板改每個 Space 的設定(`?space=&room=`、`source: "space" \| "room"`)、殼的 Space 切換器 | P2 |
| agent 的話多話少和 `language` 用 `PlaceConfig`、舊的 `channel_mode:*` 搬家、Discord 每個伺服器都註冊指令、`GuildCreate` / `GuildDelete` 呼叫 `places.seen` / `left`、home 的收件匣按 Space 過濾、拿掉 `?? "discord"` | P3 |
| 錢和榜:每個 Space 的列表、預測和懸賞的 `space_id` | P4 |
| 拍賣、樂透、佇列、卡拉 OK 房每個 Space 一份,外掛表的 migration | P5 |
| 換主要的 Space 的指令或面板動作;`db doctor` 列出 Space 和會被選成主要的那個 | 還沒排 |

## 9. 每個地方的聊天、Discord 的多伺服器、home(P3,做成的樣子)

**聊天等級**(`brain/agent`):`place_settings` 外掛 `agent` 的鍵是 `mode`、`activeness_level`、`voice.mode`、`voice.activeness_level`、`language`(`LEVEL_KEYS`)。主動程度不叫 `activeness`:那個鍵是檔案裡每個 context 的表,型別不同。一個地方的值依序:她自己暫時調的(只有主動程度)→ 這個 Room → 討論串的頻道 → 這個 Space → `[modules.agent] channels` / `activeness` 表 → 新的伺服器(不是原有的)是「只回提及」/「低」→ `default_mode` / `default_activeness` → profile。私訊沒有 Space,讀它自己 Room 的列。`language` 有值時她的情境多一行「這裡用某某語言聊天」。

- `/channel mode`、`/channel activeness` 多一個選項 `範圍: 這個頻道|整個伺服器`;沒選是這個頻道。面板的聊天等級卡片跟著 `?space=`,有好幾個伺服器(或那個伺服器自己設過)時多一列「整個伺服器」;`PUT /api/channels/space-level` 是它的路由。
- 舊的 `channel_mode:*` / `activeness:*`(`plugin_state`)在 agent 啟動時搬一次到 Room 的列(`updated_by = "migration"`),標記 `agent:places_v1` 記著搬了幾個、哪些還在等。Room 還沒出現的鍵記一筆警告、先從記憶體照用,下次啟動再搬;舊鍵留著,搬過的不再讀。執行時的設定本來就贏過檔案,所以設定匯入(`import`)寫的同一格會被蓋過,面板或指令後來設的不會。
- 一個還沒有人說過話的頻道(identity 沒有這個 Room):設定只放在記憶體到重新啟動為止,指令會說。

**Discord**(`discord`):`ambient_text`、`ambient_channels`、表情和貼圖的 `enabled`、`descriptions` 是每個 Space;新的 `ambient_follow` 是每個 Room(`true` 跟隨、`false` 不跟隨、沒設照清單)。`command_guilds = ["*"]` 註冊到她在的每個伺服器,加入新的伺服器時只同步那一個;伺服器模式不再清別的伺服器的指令(以前第二個伺服器因此沒有斜線指令),只在每次啟動清一次全域的。`GuildCreate` 和連線時的每個伺服器呼叫 `Places.seen`,`GuildDelete` 呼叫 `Places.left`(`available: false` 是 Discord 斷線,不算離開);成員離開由 Core 的 `followMembers` 寫到 `Places.memberLeft`(P1 已接)。

**新的伺服器先安靜**(owner 的預設,Q5):新的伺服器是升級以後才第一次看到的(不是原有的,`SpaceRef.established` 是 false;`discord/src/gate.ts` 的 `newGuild`、`brain/agent/src/handle.ts` 的 `inNewSpace`)。還沒替它設的時候,閘門是 `allowlist` 而且沒有跟隨的頻道(檔案的頻道本來就被頻道規則擋掉),只有提及她、回覆她的訊息進得來;聊天等級是只回提及、主動程度低;檔案裡表情和貼圖的意思是原有的伺服器的,不帶過去。替那個伺服器(或它的頻道)設了什麼,就照設的。原有的伺服器(主要的,和升級時她已經在的其他伺服器)和以前一模一樣:升級演練的資料庫本來就有兩個伺服器(58 個成員的變主要的,另一個 5 個),兩個都是原有的。

**沒有預設平台**:`recipient`(私訊對象)、語音的能力、Go Live 跟著開 OBS、卡片指令的冪等鍵,平台都從 context、請求的人或帳號(語音節點)來,都沒有就拒絕。`actions.forbidden` 可以每個 Space、每個 Room 設,是 union:頻道只能多禁,不能解開上一層禁的。`core/test/no-platform-default.test.ts` 掃網域程式碼裡的 `"discord"` 預設值,允許清單分兩組:Discord 自己的(OAuth、v4 的 fixture),和等 P4、P5 修的(修好就拿掉)。

**home 和收件匣**(`initiative` v2):`initiative_inbox`、`initiative_schedules` 多 `space_id`,舊列照自己的 `context` 補(`json_extract` 對 identity 的 `spaces`),沒有 context 的留 `NULL`(home)。一輪對話看得到的是:它自己地方的、它的 Space 的 home 項目、和沒有 Space 的(她自己的計時、早上)。某個伺服器語音裡的事放進 home 時記著是那個伺服器的,不會出現在別的伺服器;只有 home 地方在那個伺服器時才會叫醒她。`schedule_list` 只列這個伺服器的和沒有伺服器的。

**日記**:還是 owner 選的一個頻道。那一天在別的伺服器也有聊天時,日記不用反省的總結(它是所有地方的),改用日記頻道那個伺服器自己頻道的前情提要,加上心情、學到的事、目標。只在一個伺服器聊的日子照舊。

**home 看別的地方**(`brain/selfhost` 的 `initiative.ts`、`look-tool.ts`):

- 在 home 那個地方(`[modules.agent.initiative] home`)跑的一輪,收件匣多一塊「別的地方在等你的事」:home 所在的伺服器以外,每個有未看項目的 Space 一行,只有名字和各種類的件數(`- 伺服器B:2 件(時間到了 1、外面的事 1)`),不給內容。最多 4 個地方,會叫醒她的件數多的、最新的排前面,其餘合成「還有 N 個地方也有事」。她離開的 Space 不列。在別的地方跑的一輪沒有這一塊;逐字稿從來不合併。
- `look(place)`(核心工具,唯讀):place 是那一行的名字或 Space 的代號。看的規則就是記憶的 `disclose`(`memory/memory/src/places.ts`),觀看者是這一輪所在的地方,home 也一樣:home 對收件匣來說不屬於任何 Space,但她在 home 寫的字是寫在一個真的頻道或私訊裡,那裡的人看得到。所以:
  - 一個項目的來處是它的地方;沒有地方的(放進 home 的語音事件)是那個 Space 本身。`disclose` 是 `show` 才給:同一個伺服器的頻道看得到(owner 隱藏的、`PlaceAccess` 說這裡有人看不到的除外);私訊裡只看得到對方也在場的(項目的 `person` 是對方);伺服器的頻道看別的伺服器的,永遠看不到。
  - 一件都不能給:回一個看得到的拒絕(那裡有幾件、在這裡不能看),不是默默給空的。不認得的地方、她離開的地方也拒絕。
  - 最多 8 件(最新的);其餘說「還有 N 件在這裡不能看」「還有 N 件更早的」。看了不算看過,項目照樣等那個地方的一輪。
  - 回答開頭是 `ELSEWHERE_MARK`(`〔別的地方的事〕`)加「以下是某某的事,只在那裡說」,內容在 `look` 的資料區塊裡。記憶的段落整理(`notes` 的 segment pass)跳過這種工具結果,所以她看到的不會變成這個地方的筆記、再被帶到別的地方去。
  - 結果是:home 設成伺服器的頻道時,別的伺服器的事只看得到合併那一行;home 設成和某人的私訊時,看得到那個人在場的事。要讓她在 home 看別的伺服器的全部,得先有一個沒有別人讀的 home(v5-architecture §6 的 home session),還沒有。
- 從 home 說話:已經有 `say(place, text)`(`brain/self/src/say.ts`),對別的頻道說一句,照常過 guard 和 outlet;私訊走 `message_dm`。這一步沒有加新的說話方式。
- 測試:`brain/selfhost/test/home-places.test.ts`(兩個以上 Space:合併的那一行和上限、在 A 跑的一輪沒有 B 的任何東西、`look` 在別的伺服器和頻道 home 被拒、不認得和離開的地方被拒、同一個伺服器和私訊 home 看得到的部分),`memory/notes/test/elsewhere.test.ts`(段落整理跳過 `look` 的結果)。

## 10. 拍賣、樂透、佇列、點歌、卡片掉落(P5,做成的樣子)

**市集**(`play/market`):每個 Space 一個 `MarketService`(`markets.ts` 的 `Markets`,`MarketKey.of(space)`),各自的列(`MarketStore.forSpace`)和設定(`placeConfig`,用到時才讀,改了不用重啟);點歌優先券另外一個,大家共用。標成 `scope: "space"` 的是拍賣和樂透的開關、兩個頻道、星期幾、幾點、`utc_offset_minutes`(這個伺服器的日子;優先券的「一天」還是 cluster 的,每個人共用)。價格、上限、拍品是 cluster 的。

- 主要的 Space 照舊:有拍賣頻道就拍;cluster 完全沒設頻道時,樂透沒有頻道也賣(以前的單一伺服器)。其他 Space 只有在那個伺服器自己的頻道時才拍、才賣,所以沒設過的伺服器什麼都不跑、不寫任何列。cluster 的頻道在哪個伺服器,拍賣和樂透就只在那裡跑:兩個原有的伺服器、cluster 的拍賣頻道在第二個的時候,第二個照以前那樣拍、賣,主要的不會另外再開一個沒有頻道的樂透(`markets.ts` 的 `secondary`;測試在 `core/test/established-spaces.test.ts`)。這裡的規則看「主要的」,不看「原有的」。
- 她離開的伺服器:還開著的拍品取消、押著的全退,這週的樂透全額退回,不再發公告;列都留著。
- 公告用那個 Space 的 context(`{platform, scope: guild, channel}`);沒有 identity 的時候用 sink 的平台。
- 指令和按鈕用它們所在伺服器的市集,私訊是主要的;會員路由 `?space=`(`memberSpace`),管理路由 `?space=`(`adminSpace`,預設主要的)。

`market` v3(需要 identity,在它後面跑):`market_lots`、`market_lottery_tickets`、`market_song_tickets` 多 `space_id`;拍品照它頻道的 room 補,其他的補主要的 Space。拍品的唯一索引從 `(week)` 換成 `(space_id, week)`。樂透改用新的 `market_lottery_draws`(主鍵 `(space_id, week)`),從 `market_lottery_weeks` 複製過去、放在主要的 Space 底下;舊表不動、不再寫,什麼都沒刪。資料庫那時還沒有任何 Space 的話,列是 `NULL`(樂透是 `''`),模組在有主要的 Space 之後把它們給它(`adopt`)。`retireMarketSql` 跟著改成看新表、也刪新表。

**請求佇列**(`play/queue`):一個 `queue:state` 快照,每個項目帶 `space`,每個 Space 自己的暫停、公平輪替和投票放在 `spaces`;最上層的 `paused`、`served`、`vote`、`last_vote` 還是寫(主要的 Space 的),舊版讀得懂。舊快照照原樣讀:它的暫停、輪替和投票是主要的 Space 的,每個項目照它 context 的伺服器、沒有就主要的。項目編號全域唯一。指令和按鈕用所在伺服器的佇列;`/api/queue*` 有 `?space=`,跳過和移動回那個項目所在的佇列。`queue.changed` 只帶變了的那個佇列。

**唱歌**(`sing`):項目多一個 `guild`(在伺服器外點的歌要在哪個伺服器唱)。在伺服器裡點的,就在那個伺服器唱;私訊或會員頁點的,在指定的伺服器(會員頁 `POST /api/member/songs?space=`,在好幾個伺服器的人用 `SpacePicker` 選),沒指定就是點歌的人自己的(她正在那裡語音的、主要的、第一個)。她在別的伺服器語音時這首就等,下次她在那個伺服器的語音再唱,回答裡說為什麼要等。`pending` / `setlist`(`VoiceFloor`)、自動開唱、提醒、她的 `sing_start` 都只看那個伺服器的歌;沒有伺服器的歌(階段 6 以前的)到處都算。重新啟動時,還沒唱、在伺服器外點的舊歌給主要的伺服器;正在唱的歌不受影響(這些只決定下一首)。優先券的價格和每天上限全域,記錄用在哪個 Space 的佇列;沒唱到的照舊退回。`GET /api/public/songs?space=`,沒給是主要的。

**卡片掉落**(`play/cards`):`drop_channels` 是每個 Space 的清單,`drops` 每個 Room 可以自己開關;一個頻道在它伺服器的清單裡、而且開著才會掉。其他數字是 cluster 的,每人每天能撿幾張跨伺服器算。

**卡拉 OK**(`play/karaoke`):講評頻道和指令的字不再只認 Discord。KTV 房每個 Space 一份;歌、參考、分數照舊是每個人全域的。

- 一間房屬於開房時的 Space(`RoomPlaces`,`module.ts` 的 `roomPlaces`):會員頁的 `?space=`(`memberSpace`)、指令所在的伺服器(私訊是主要的),都沒有就是主要的。只有她在那個 Space 的語音頻道時才能開、能開始;她離開那個 Space 的語音,那裡的房間關掉(別的伺服器的語音不算)。房間的公告和給她的通知走那個 Space 的 `comment_channel`(`placeConfig`,用到時才讀,改了不用重啟;頻道要在那個 Space 裡的規則照用)。
- 原有的伺服器照以前:她在那裡的語音就能開房。新的伺服器在替它設好自己的講評頻道之前沒有房間(「這個伺服器還沒有設定唱 K 的講評頻道」)。
- 一個人同時只在一間房(不分伺服器);房號照舊是全域的,拿到房號或連結就能加入。同時最多幾間房(`room_max`)是全部伺服器加起來(一台唱歌的機器在算分)。直播的唱 K 場景還是一個舞台。
- 一個人自己唱的講評還是 cluster 的講評頻道(分數是每個人全域的,沒有伺服器)。
- `GET` / `POST /api/member/karaoke/rooms` 有 `?space=`(不在的伺服器 404,不是成員 403;沒給是他自己的);`/me play karaoke` 列它所在伺服器的房間(加上他自己在的那間)。`GET /api/karaoke/results?space=`:那個伺服器的房間加上自己唱的,每筆多 `space`;沒給是全部。會員頁的「一起唱」用 `useMemberSpace()`,在好幾個伺服器的人才有 `SpacePicker`(「在哪個伺服器開房」),能不能按開房看的是那個伺服器的語音。
- `karaoke` v6(需要 identity):`karaoke_rooms.space_id REFERENCES spaces(id)`。房間的列沒有記頻道或伺服器(公告的頻道沒存),所以舊的房間都補主要的 Space;那時一個 Space 都沒有的資料庫留 `NULL`。只加欄位,不搬不刪。
- 測試:`play/karaoke/test/spaces.test.ts`(v6 的補值、兩個 Space 各自的房間、公告和通知、每個 Space 自己的語音、新的伺服器、一人一間)、`api/test/karaoke-rooms.test.ts`(`?space=` 的 403 / 404、預設、管理頁的結果)、面板 `rooms.test.tsx`(一個和兩個伺服器)。

**面板**:經濟 / 市集和即時的佇列卡跟著殼的 `?space=`;會員頁的市集和點歌用自己的伺服器,只在好幾個伺服器時有選擇。
