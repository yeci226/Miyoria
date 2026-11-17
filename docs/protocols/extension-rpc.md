# Extension RPC 協定(v2)

Core 的擴充宿主(`@miyoria/plugin-host/ext-host`,module id `extensions`)和每個擴充套件行程之間的協定。TS 擴充用 `@miyoria/sdk` 就不用自己處理這些細節;其他語言照這份文件實作即可(`packages/plugin-host/ext-host/test/fixtures/test-ext/index.mjs` 是一個不用 SDK、約 230 行的完整範例)。

**訊息的形狀只寫一次**,在 `@miyoria/contracts/ext`(`packages/contracts/ext/src/`,zod schema);它的 JSON Schema 在 [`packages/contracts/schema/ext.json`](../../packages/contracts/schema/ext.json)(每個訊息一個 `$defs`,名字以 `Ext` 開頭,事件的 envelope 是 `EventsBusEnvelope`,帳號、context 等共用形狀以 `Wire` 開頭),非 TS 的實作拿它來產生型別或驗證。事件本身的型別和 payload schema 在 `@miyoria/contracts/events`(匯流排的登錄表 `BUS_EVENTS`,JSON Schema 在 [`schema/events.json`](../../packages/contracts/schema/events.json))。宿主讀擴充送來的內容用的就是這些 schema,SDK 的型別(`@miyoria/sdk` 的 `ToolDecl`、`Invocation`、`Envelope`…)也是從它們推出來的,下面的範例和說明跟 schema 不一致時以 schema 為準。協定版本、錯誤碼、訊框上限這些常數在同一個地方(`EXT_PROTOCOL_VERSION`、`EXT_ERROR_CODE`、`EXT_LIMITS`)。

**版本**:這份文件描述協定 2。雙方在 `initialize` 交換版本,不同就拒絕對方,**沒有**退回舊版的模式(見〈生命週期〉)。同一個版本內只做加法:新欄位是選填或有預設值,收到不認得的訊息、事件類型或欄位就忽略。

- **傳輸**:宿主把擴充當子行程啟動,協定走 **stdin / stdout**。**stdout 只能拿來寫協定訊框**;擴充自己的輸出請寫到 stderr(宿主會逐行轉進 Core 的 pino 日誌,logger 名稱 `miyoria_ext`)或用 `log` 方法。SDK 會自動把 `console.log / info / debug` 導到 stderr。
- **訊息**:JSON-RPC 2.0。雙方都可以送 request 和 notification;request 可以並行,用 `id` 對應 response。
- **環境變數**:`MIYORIA_RPC=stdio`、`MIYORIA_EXTENSION_ID=<id>`,加上平台白名單(`PATH`、`SystemRoot`、`TEMP`、`HOME`、`APPDATA`、語系…)、manifest `[env] pass` 列出的主機變數與 `[extensions."<id>"] env` 設定的值;**不會**繼承宿主的其他環境變數(見 [ARCHITECTURE.md](../ARCHITECTURE.md) §9.2)。工作目錄是擴充目錄。
- **啟動指令**(依 manifest 的 `runtime`):
  | runtime | 指令 |
  |---|---|
  | `node` | `node <entry>` |
  | `bun` | `bun run <entry>` |
  | `deno` | `deno run --allow-read --allow-env [--allow-net=<network>] <entry>` |
  | `binary` | `<entry>` |

  執行檔可以用 `[modules.extensions.runtimes]` 覆寫,例如 `node = "C:/tools/node.exe"`。

## 訊框

LSP 風格:header、空行、UTF-8 JSON 本文。`Content-Length` 是本文的**位元組數**(不是字元數);header 名稱不分大小寫,其他 header(例如 `Content-Type`)會被忽略。本文上限 16 MiB(`Content-Length` 超過就中斷連線);header 區塊(到空行為止)上限 8 KiB。

```
Content-Length: 51\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"log","params":{}}
```

## 生命週期

1. 宿主啟動行程,立刻送 `initialize`(request),帶著它講的協定版本 `protocol`。
2. 擴充在逾時內(`init_timeout_ms`,預設 10 秒)回傳自己講的 `protocol` 和 `contributions`。SDK 會在這段時間執行 `activate(ctx)`,把裡面註冊的工具、指令、prompt、訂閱收集起來一次回傳。**版本不同就拒絕**:擴充收到別的 `protocol` 時回錯誤 `-32600`(SDK 的訊息會說是哪一邊比較舊,例如 `the host speaks extension protocol 1 and this extension speaks 2; the host is older: update Miyoria`);宿主收到別的版本(沒有 `protocol` 欄位的結果是協定 1 的擴充)就讓啟動失敗,module 的原因寫著 `the extension speaks extension protocol 1 and the host speaks 2; the extension is older: rebuild it against a newer @miyoria/sdk`。
3. 宿主一次套用所有 contributions。**違反權限就啟動失敗**(例如沒有 `tools` 權限卻宣告工具);只是某個 registry 不存在(例如 agent 沒開)則跳過並記警告。
4. 執行中:雙方任意互送 request / notification。擴充也可以在執行中動態註冊或取消註冊。
5. 停止:宿主送 `shutdown`(notification),等 `shutdown_grace_ms`(預設 2 秒)讓擴充自己結束,逾時就強制結束行程。宿主會移除這個擴充註冊過的所有東西。
6. 崩潰:行程非預期結束(或 stdout 關閉)時,module `ext.<id>` 標成 `Failed`,由 Supervisor 以指數退避自動重啟(1 → 2 → 4 … 秒,10 分鐘內超過 5 次就停在 `Failed`,要手動 restart)。
7. 開發模式(`[modules.extensions] dev = true`):宿主每 `watch_poll_ms` 輪詢擴充檔案(manifest、config schema、entry 所在的目錄,略過 `node_modules`、`.git`),有變動且穩定一個輪詢週期後,就透過 Supervisor 重啟該擴充。

每個擴充在 Supervisor 裡是獨立的 module `ext.<id>`(例如 `ext.miyoria.hello`),可以個別 `enable / disable / restart`。它們都 `requires` `extensions`(關掉宿主 = 關掉全部擴充),並 `optional` `agent`、`commands`(確保那些 registry 先存在)。

## Host → Extension

### `initialize`(request)

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{
  "protocol":2,
  "host":{"name":"miyoria","version":"0.1.0"},
  "extension":{"id":"miyoria.hello","version":"0.1.0","dir":"C:\\Miyoria\\extensions\\examples\\hello","game":null},
  "config":{"greeting":"哈囉"},
  "permissions":{"events":["agent.turn.completed"],"tools":true,"commands":true,"network":[],"input":[]}
}}
```

- `extension.game`:宣告為 game adapter 的擴充(見〈Game adapter〉)擁有的遊戲 id,例如 `"minecraft"`;其他擴充為 `null`。
- `config`:`[extensions."<id>"]` 去掉 `enabled`、`permissions` 之後的內容。
- `permissions`:宿主**實際授予**的權限(manifest 宣告 ∩ 設定檔覆寫),見〈權限〉。

結果:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocol":2,"contributions":{
  "tools":[{"name":"dice","description":"擲骰子","parameters":{"type":"object","properties":{"sides":{"type":"integer"}},"required":[]},"permission":null}],
  "commands":[{"path":["hello"],"description":"跟 Miyoria 打招呼","args":[{"name":"name","description":"要打招呼的對象","kind":{"type":"string"},"required":false}],"permission":"","ephemeral":false}],
  "prompts":["facts"],
  "subscriptions":["agent.turn.completed"]
}}}
```

`protocol` 是擴充講的版本,必填(省略就當成 1,會被拒絕)。`contributions` 的每個欄位都可以省略。`tools[]` 的格式同 `tools.register`,`commands[]` 同 `commands.register`。

### `tools.call`(request)

agent 呼叫工具時送出。逾時 `call_timeout_ms`(預設 30 秒)。

```json
{"jsonrpc":"2.0","id":7,"method":"tools.call","params":{
  "name":"dice",
  "args":{"sides":20},
  "context":{
    "turn":"01JC0000000000000000000000",
    "context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},
    "account":{"platform":"discord","id":"789"},
    "message":{"context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},"id":"999"},
    "priority":"direct"
  }
}}
```

- `name` 是擴充註冊時的名字(可以含 `.`)。
- `context.account` 是觸發這個回合的使用者(權限是對他檢查的,不是對模型)。

結果:`{"content":"擲了 1 顆 20 面骰:17(總和 17)"}`。也接受直接回字串;其他 JSON 會被轉成字串給模型看。錯誤用 JSON-RPC error 回,`message` 會給模型看,請保持簡短。

### `commands.invoke`(request)

使用者下指令時送出。宿主已經檢查過權限與參數型別。逾時 `call_timeout_ms`。

```json
{"jsonrpc":"2.0","id":8,"method":"commands.invoke","params":{
  "path":["hello"],
  "args":{"name":"小明"},
  "invoker":{"platform":"discord","id":"789"},
  "invoker_display_name":"Owen",
  "context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},
  "invoker_is_guild_admin":false,
  "platform_roles":[],
  "resolved_users":{}
}}
```

結果:`{"text":"哈囉,小明!","ephemeral":false}`;`ephemeral` 省略時用指令宣告的預設值。也接受直接回字串。

### `prompt.contribute`(request)

agent 組 prompt 時,對每個已註冊的 prompt key 送出。逾時 `prompt_timeout_ms`(預設 3 秒;agent 本身也有逾時,慢的會被跳過)。

```json
{"jsonrpc":"2.0","id":9,"method":"prompt.contribute","params":{
  "key":"facts",
  "request":{
    "profile":"deepseek-chan","turn":"01JC0000000000000000000000",
    "context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},
    "participants":[{"account":{"platform":"discord","id":"789"},"display_name":"Owen","person":null}],
    "speakers":[{"platform":"discord","id":"789"}],
    "query":"Owen: 今天要幹嘛","recent":[],"voice":false,"now":"2026-11-01T10:00:00Z"
  }
}}
```

結果:

```json
{"sections":[{"key":"facts","title":"小知識","body":"……","order":50}]}
```

`order` 越小越前面。不想加東西就回 `{"sections":[]}`。

### `event`(notification)

事件匯流排上的事件,只送**有訂閱且有權限**的型別,不送擴充自己發佈的事件。`params` 是 `{"envelope": …}`,envelope 就是匯流排上的那一個(`BusEnvelopeSchema`,每個欄位都在,沒有值是 `null`):

```json
{"jsonrpc":"2.0","method":"event","params":{"envelope":{
  "id":"01JC0000000000000000000001","at":"2026-11-01T10:00:01.123Z",
  "type":"agent.turn.completed","v":1,
  "parent":null,"turn":"01JC0000000000000000000000",
  "session":"discord:123:456","space_id":null,"room_id":null,
  "person_id":null,"account_id":null,"key":null,"scope":null,
  "source":"agent",
  "data":{"turn":"01JC0000000000000000000000","context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},"text":"沒幹嘛啊"}
}}}
```

- `type`:點分隔的事件型別,就是訂閱和權限用的 topic(`platform.message.created`、`voice.playback`、`game.minecraft.death`、`ext.<id>.…`)。
- `v`:`data` 的 schema 版本;`data` 就是這個型別在 `v` 的 payload,形狀查 `@miyoria/contracts/events` 的登錄表(TS 擴充用 SDK 的 `Events.<定義>` 就有型別)。不認得的型別或版本就忽略。
- `parent`:造成這個事件的事件 `id`;`turn`:所屬的 agent 回合;`session`、`space_id`、`room_id`、`person_id`、`account_id`、`key`、`scope`:發佈者知道就會填。`source`:發佈的 module(`agent`、`ext.<id>`…)。
- 不送比對到的訂閱 pattern:一個事件只送一次,擴充自己拿 `type` 去比對它的訂閱(SDK 就是這樣分給各個 handler)。

完整形狀見 `ExtEventNotification`(`packages/contracts/ext/src/events.ts`)和 `EventsBusEnvelope`。擴充處理太慢、宿主的送出佇列滿了時,事件會被丟棄(會記警告)。

### `shutdown`(notification)

```json
{"jsonrpc":"2.0","method":"shutdown","params":{}}
```

擴充應該收尾後自行結束(exit code 0)。stdin 關閉也代表宿主不在了,應該結束。

## Extension → Host

所有方法都是 request(`log` 也可以用 notification)。成功時回 `{}` 或註明的結果。

### `events.subscribe` / `events.unsubscribe`

```json
{"jsonrpc":"2.0","id":1,"method":"events.subscribe","params":{"topics":["game.*","agent.turn.completed"]}}
```

結果:`{"topics":[目前所有訂閱]}`。pattern 規則(比對事件的 `type`):`"*"` = 全部;`"a.b.*"` = `a.b.` 底下所有型別;其他要完全相同。實際送出的事件 = 訂閱 ∩ 權限 `events`,所以訂閱 `"*"` 也只會收到被授權的型別。

### `events.publish`

```json
{"jsonrpc":"2.0","id":2,"method":"events.publish","params":{
  "type":"ext.miyoria.hello.greeted","data":{"who":"Owen"},
  "turn":"01JC0000000000000000000000","parent":"01JC0000000000000000000001","key":null
}}
```

發佈一個已登錄型別的事件,`source` 是 `ext.<id>`。除了 `type` 都可以省略:`data` 預設 `null`;`turn`(所屬回合)、`parent`(造成它的事件,通常是收到的 envelope 的 `id`)、`key`(注意力與去重的 key)預設 `null`。envelope 的其他欄位(`id`、`at`、地點和人的欄位、`scope`)由宿主決定,擴充不能指定。

宿主拿 `type` 去查匯流排的登錄表(`BUS_EVENTS`,`@miyoria/contracts/events`),**保留的型別直接由登錄表推出**:登錄表裡只有兩個定義是給擴充用的開放命名空間,`ext.**`(`ExtensionEvent`,payload 任意 JSON)和 `game.*.*`(`GameAdapterEvent`,payload 是 `GameEvent`);其他每個定義(固定的型別或 family)都是內建事件。規則依序是:

1. `type` 要是具體的 topic(點分隔、每段 `[a-z0-9_-]`),否則 `-32602`。
2. 被任何內建定義涵蓋的型別**一律拒絕**(`-32001`),即使在自己的命名空間裡:例如 `platform.message.created`、`gate.decision`、`game.director.goal`,以及 `ext.<id>.task.done`、`game.<id>.task.*`(被任務事件的 family `**.task.*` 涵蓋;任務事件只能經 `task.event` 由宿主檢查後發佈)。
   - 例外只有兩個,是設計給遊戲和擴充用的輸入:`self.nudge`(推她的慾望)和 `self.feel`(推她的情緒)。權限 `events` 裡有符合的 pattern(例如 `self.nudge`)才可以發,`data` 一樣要過 schema;每次的幅度由 self 模組限制。
3. `game.<遊戲 id>.…`:只有宣告了這個遊戲的 game adapter 可以(不需要 `events` 權限,見〈Game adapter〉);別人即使有 `events = ["game.*"]` 也是 `-32001`。
4. `ext.<id>.…`(自己的命名空間)永遠可以;其他型別要符合權限 `events` 的某個 pattern(例如 `ext.other.*` 讓它發佈到另一個擴充的命名空間,`source` 仍是自己),否則 `-32001`。
5. **沒有人登錄的型別**(協定 1 的自訂 topic,例如 `custom.thing`)回 `-32602`:匯流排上的每個事件都要有登錄的 schema。擴充自己的事件放在 `ext.<id>.` 底下就有(`ext.**`),payload 任意 JSON。
6. `data` 用該型別的 schema 檢查,不合就 `-32602`(訊息帶著 zod 的說明);通過後以 schema 讀出的值發佈(例如 `GameEvent` 多出來的欄位會被去掉)。

### `tools.register` / `tools.unregister`

```json
{"jsonrpc":"2.0","id":3,"method":"tools.register","params":{
  "name":"weather.now","description":"查詢某個城市現在的天氣",
  "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]},
  "permission":"tools.weather"
}}
```

- 需要權限 `tools = true`,否則 `-32001`。
- `name`:1–64 個 ASCII 英數、`_`、`-`、`.`。模型 API 不接受 `.`,所以宿主在 agent 的工具清單裡登記成 `weather_now`;`tools.call` 仍然用原名。
- `game.` 開頭(登記名 `game_` 開頭)的工具只有宣告該遊戲的 game adapter 能註冊,而且只能在 `game.<自己的遊戲 id>.` 底下;否則 `-32001`。
- 名稱已被其他模組(或其他擴充)用掉時回 `-32003`。同一個擴充重複註冊同名工具 = 取代。
- `parameters` 省略時是空物件 schema;`permission` 是觸發者需要的權限節點(選填)。
- `read_only`(選填,預設 `false`):這個工具只查不改(查詢、狀態)。模型同一步呼叫好幾個 `read_only` 工具時會同時跑,不再一個等一個。有副作用的工具不要設。SDK 寫法是 `readOnly: true`。
- 結果:`{"name":"weather_now"}`(登記用的名字)。

`tools.unregister`:`{"name":"weather.now"}`。

### `commands.register` / `commands.unregister`

`params` 是 `CommandSpec`:

```json
{"jsonrpc":"2.0","id":4,"method":"commands.register","params":{
  "path":["dice","roll"],"description":"擲骰子",
  "args":[
    {"name":"sides","description":"面數","kind":{"type":"integer"},"required":false},
    {"name":"style","description":"樣式","kind":{"type":"choice","choices":["plain","fancy"]},"required":true}
  ],
  "permission":"","ephemeral":false
}}
```

- 需要權限 `commands = true`。
- `path`:1–3 個小寫詞(Discord 對應 `/dice roll`)。`kind.type`:`string`、`integer`、`boolean`、`choice`(帶 `choices`)、`user`、`role`。
- `permission`:權限節點;`""` = 所有人,`admin.*` = 管理員,`owner.*` = 主人。
- 路徑被別人用掉、或跟既有指令互為前綴時回錯誤。

`commands.unregister`:`{"path":["dice","roll"]}`(也接受 `"dice roll"`)。

### `prompt.register` / `prompt.unregister`

```json
{"jsonrpc":"2.0","id":5,"method":"prompt.register","params":{"key":"facts"}}
```

宿主登記成 `ext.<id>.facts` 的 prompt contributor(結果 `{"key":"ext.<id>.facts"}`),之後 agent 每個回合會送 `prompt.contribute`(`key` 用原本的 `facts`)。key 長度 1–64。

### `storage.get` / `storage.set`

每個擴充自己的 KV(JSON 值),存在 Core 的 settings store(key 為 `ext:<id>:<key>`,依目前 profile 分開)。沒有 store 時回 `-32004`。

```json
{"jsonrpc":"2.0","id":6,"method":"storage.set","params":{"key":"high_score","value":{"n":3}}}
{"jsonrpc":"2.0","id":7,"method":"storage.get","params":{"key":"high_score"}}
```

`storage.get` 結果:`{"value":{"n":3}}`,不存在時 `{"value":null}`。`storage.set` 的 `value` 是 `null` = 刪除。key 長度 1–200。

### `log`

```json
{"jsonrpc":"2.0","method":"log","params":{"level":"info","message":"connected","fields":{"port":25565}}}
```

`level`:`error`、`warn`、`info`(預設)、`debug`、`trace`。

## 權限

manifest 的 `[permissions]` 是**上限**;設定檔可以再縮小,不能放大:

```toml
[extensions."miyoria.minecraft"]
enabled = true                      # 預設 true;false = 註冊但不啟動,之後可以 enable
host = "localhost"                  # 其他欄位都是擴充自己的 config
[extensions."miyoria.minecraft".permissions]
events = ["game.*"]                 # 有寫的欄位取交集
tools = true
input = ["keyboard"]                # 高風險:只有這裡也列出才會授予
```

| 權限 | 宿主怎麼執行 |
|---|---|
| `events` | 決定送哪些事件、能發佈哪些型別(見上;自己的 `ext.<id>.…` 和自己遊戲的 `game.<id>.…` 不需要) |
| `tools` | 沒有就不能註冊工具(`-32001`;在 `initialize` 裡宣告則啟動失敗) |
| `commands` | 沒有就不能註冊指令 |
| `network` | 只做標示並傳給擴充;`deno` runtime 會轉成 `--allow-net`。跨行程不是沙箱 |
| `input` | 預設**不授予**,要在設定檔的 `permissions.input` 明確列出 |

prompt 片段和 storage 不需要額外權限(都在擴充自己的命名空間)。

## Game adapter

遊戲 adapter(`docs/ARCHITECTURE.md` §12.3)擁有自己的遊戲命名空間 `game.<遊戲 id>.*`。在 manifest 宣告:

```toml
id = "miyoria.minecraft"
kind = ["game-adapter", "tools"]
game = "minecraft"          # 遊戲 id:1–32 個小寫英數、`-`、`_`(一個 topic 片段)
```

- `game` 必須搭配 kind `game-adapter`(否則 manifest 無效);只有 `game-adapter` 沒有 `game` 只會警告,但它不能發佈遊戲事件。
- 同一個遊戲 id 只能有一個擴充;第二個在 discovery 時被略過。
- 宿主在 `initialize` 的 `extension.game` 送出這個 id。
- **事件**:adapter 可以發佈 `game.<id>.<type>`(例如 `game.minecraft.death`),不需要 `events` 權限;`game.<id>.task.*` 除外(任務事件)。別的擴充即使有 `events = ["game.*"]` 也只能**訂閱**、不能發佈 `game.*`。
- **任務執行器**:adapter 是 `game.<id>` 的任務執行器(見〈任務執行器〉),慢迴路 `@miyoria/play/game` 只透過它 observe、開始 / 取消目標。SDK 的 `registerAdapter` 不再登記原始的 `game.<id>.observe` / `game.<id>.act` 工具;沒有自己執行器的 adapter,它的 `act` 會被包成一步就結束的任務。`game.` 底下的工具名稱仍只保留給該 adapter,而且**不會**出現在聊天回合的工具清單裡(宿主登記在只給能力用的 `GatedToolsKey`);她只能透過過閘門的能力(`game.start` / `game.stop` / `game.goal`,導演的 `game.act`)動到遊戲。
- **prompt**:`prompt.register` 的 key 照常加上 `ext.<id>.` 前綴。

SDK 的 `ctx.game.registerAdapter(adapter)` 負責這些對應;`describe().id` 必須等於 `ctx.game.id`(= `extension.game`),否則丟出錯誤、啟動失敗。`events.publish` 的 `data` 是 `GameEvent`(`GameAdapterEvent` 的 schema,宿主會檢查):

```json
{"type":"death","data":{"text":"死掉了(被殭屍打死)","last_damage_source":"mob"},"important":true}
```

`type` 是 topic 最後的部分;`important: true` 表示值得立刻實況評論;`data.text`(選填)是一句繁體中文描述,給實況提示用。

## 任務執行器

活動型擴充(遊戲、瀏覽器)實作任務契約(`docs/design/v2-architecture.md` §3.8;形狀是 `@miyoria/contracts/ext` 的 `ExtTaskSpec`、`ExtTaskEvent`、`ExtTaskSteer`、`ExtStructuredState`、`ExtExecutorDecl`,SDK 的型別從它們來):核心開始一個任務 `{id, goal, args, budget_s}`,擴充接受後一定以**剛好一個** `done` 或 `failed{code, detail}` 結束它。核心從不從事件名稱或結果文字猜完成。

- **註冊**(Ext → Host):`contributions.executor` 或執行中的 `tasks.register`(request),一個擴充一個:
  ```json
  {"name":"Minecraft","goals":[{"name":"goto","description":"走到…","parameters":{"type":"object"},"budget_s":120}],"guide":"生存的進度…"}
  ```
  owner(事件的 topic 前綴)由宿主決定:game adapter 是 `game.<id>`,其他擴充是 `ext.<id>`。宿主把它放進 `TaskExecutorsKey`(`get(owner)`);擴充停止時移除。
- **`task.start`**(Host → Ext,request):`{"task":{"id","goal","args","budget_s"}}` → `{}`。只表示**接受了**;結果以事件回報。連接受都不行(spec 不合法)才回錯誤,`error.data.code` 是失敗碼。呼叫端放棄等待(`$/cancelRequest`)時也會取消這個任務。
- **`task.cancel`**(Host → Ext,request):`{"task":"<id>"}` → `{}`;之後該任務會以 `failed` / `cancelled` 結束。不認得或已結束的 id 忽略。
- **`task.observe`**(Host → Ext,request):`{}` → `StructuredState` `{"at","state":{…},"task":<執行中的 id 或 null>,"summary"}`(結構化狀態,不是要再解析的文字)。
- **`task.steer`**(Host → Ext,request,選用):`{"steer":{"id","task","patch":{…},"why","cause"}}` → `{}`。中途改方向、保留進度(`docs/design/v3-architecture.md` §10.6)。和 `task.start` 一樣只表示**受理**;結果以 `steered` 事件回報,patch 在下一個安全點才讀。只有註冊時宣告了 `"steer":true` 的擴充才會收到;SDK 在執行器有 `steer` 方法時自動宣告。受理不了才回錯誤(`error.data.code`)。
- **`task.event`**(Ext → Host,notification):`{"event": TaskEvent}`,`TaskEvent` 是 `{"type":"started","task","goal","at"}`、`{"type":"progress","task","progress":0..1|null,"detail","at"}`、`{"type":"done","task","detail","data","at"}`、`{"type":"failed","task","code","detail","at"}`,或 `{"type":"steered","task","steer","outcome":"applied"|"rejected"|"too_late","detail","at"}`(不是結束,任務繼續跑)。宿主檢查後(核心讀事件用 `@miyoria/types` 的 `parseTaskEvent`:`progress` 夾進 0..1、缺的 `detail` 當成空字串、`at` 要是可解析的時間,這些規則 schema 寫不出來,所以 schema 只描述送出的形狀)發佈到匯流排 `<owner>.task.<type>`(例如 `game.minecraft.task.done`,payload 就是這個事件)。

**Steer 是選用的**:註冊內容的 `steer`(boolean,缺少就是 `false`),SDK 只在執行器有 `steer` 時才送。宿主只在宣告了 `steer` 時才給 `ProxyExecutor` 一個 `steer` 方法;沒宣告的看起來就和沒有 `steer` 的執行器一樣,核心回 `unsupported`(`fallback: cancel_then_start`),主線改走取消再開始,擴充也不會收到 `task.steer`。回應 steer 的 `steered` 事件即使任務已經結束(`too_late`)或宿主不認得它(`rejected`)也會送到匯流排,這是「已結束任務的事件一律丟掉」的唯一例外;沒有人問過的 `steered` 一律丟掉。

失敗碼(`TASK_FAILURE_CODES`):`timeout`、`cancelled`、`superseded`、`busy`、`invalid`、`not_found`、`unreachable`、`precondition`、`disconnected`、`crashed`、`died`、`denied`、`internal`。

宿主的保證:已結束任務的事件一律丟掉(過期的工作無害);接受後超過 `budget_s` + `task_grace_ms`(預設 5 秒)還沒結束,宿主自己發 `failed` / `timeout` 並送 `task.cancel`;行程中途結束,執行中的任務都發 `failed` / `crashed`(宿主停止擴充時是 `disconnected`)。

SDK:`TaskRunner`(`@miyoria/sdk`)把一個 `TaskWorker { observe, run(spec, task), resource? }` 變成執行器:`run` 回傳 = `done`、丟 `TaskFailure(code, detail)` = `failed`;預算、取消、同一個資源上新任務取代舊任務(`superseded`)都由它處理,`task.signal` 在那時中止,`task.progress(detail, p)` 回報進度。`ctx.tasks.register(executor, info)` 註冊。

## 逾時

| 方向 | 方法 | 設定(`[modules.extensions]`) | 預設 |
|---|---|---|---|
| Host → Ext | `initialize` | `init_timeout_ms` | 10000 |
| Host → Ext | `tools.call`、`commands.invoke`、`task.start` / `task.cancel` / `task.observe` / `task.steer` | `call_timeout_ms` | 30000 |
| 宿主 | 接受後沒有回報結束的任務 | `budget_s` + `task_grace_ms` | + 5000 |
| Host → Ext | `prompt.contribute` | `prompt_timeout_ms` | 3000 |
| 停止 | `shutdown` 後等待結束 | `shutdown_grace_ms` | 2000 |

逾時的 request 在呼叫端得到 `-32002`,之後才到的 response 會被忽略;連線本身不受影響。SDK 對宿主的 request 預設 10 秒逾時。

**取消**:呼叫端不再等一個 request 時(逾時,或呼叫被中止:工具逾時、回合被取消、遊戲導演的步驟逾時),**宿主**送 notification `$/cancelRequest` `{"id": <那個 request 的 id>}`(跟 LSP 一樣)。擴充可以據此停止那件工作(SDK 會中止交給處理函式的 `AbortSignal`:工具的 `ctx.signal`、執行器的 `start(spec, signal)` / `observe(signal)`),讓過期的工作無害;不認得這個 notification 的擴充照舊忽略它。之後送回的 response 會被忽略(被 SDK 取消的處理函式回 `-32800`)。方向只有宿主到擴充:擴充等宿主的 request 逾時時不會送 `$/cancelRequest`,宿主收到它會當成沒有對象而忽略。

## 錯誤碼

| code | 意義 |
|---|---|
| -32700 | JSON 解析失敗(宿主收到壞的本文時回這個並繼續讀;SDK 收到時直接中斷連線) |
| -32600 | 不是合法的 request |
| -32601 | 沒有這個方法 / 工具 / 指令 / prompt key |
| -32602 | 參數不對 |
| -32603 | 內部錯誤(handler 丟出的例外) |
| -32001 | 權限不足 |
| -32002 | 逾時(只在呼叫端產生,不會在線上傳) |
| -32003 | 名稱衝突 |
| -32004 | 宿主服務不存在(工具 registry、指令 registry、storage…) |
| -32005 | 連線已關閉(只在呼叫端產生) |
| -32800 | 呼叫端取消了這個 request(`$/cancelRequest`,LSP 的代碼;SDK 中止處理函式時用) |

## 設定與 manifest

```toml
[modules.extensions]
dirs = ["extensions"]     # 找擴充的目錄(相對於工作目錄);`ext install` 裝到第一個
dev = false               # true = 檔案變動就重啟擴充
watch_poll_ms = 1000
```

宿主在每個 `dirs` 裡往下找最多三層含 `miyoria.extension.toml` 的目錄(略過 `node_modules`、`dist`、`.git`、隱藏目錄)。manifest 格式見 `docs/ARCHITECTURE.md` §9.2;`placement = "stage"` 的擴充會被略過(宿主記為 skipped,Stage 節點沒有擴充宿主,所以不會有人跑它),只有 `core` 和 `any` 會被載入。`[[mcp_servers]]` 宿主只解析,透過 `Arc<ExtensionCatalog>` 服務提供給 MCP 模組。

## 變更紀錄

### 協定 2(`@miyoria/sdk` 0.2.0)

匯流排併成一種 envelope 之後,擴充看到的事件也換成它。沒有相容模式:宿主和擴充版本不同就互相拒絕,所以宿主和擴充要一起升級。

- `initialize`:宿主送 `"protocol":2`;結果多了必填的 `"protocol":2`。版本不同時雙方都拒絕,錯誤訊息說是哪一邊比較舊。
- `event`:`params` 從「舊 envelope(`id`、`ts`、`source`、`causation`、`correlation`、`event:{type,data}`)加上 `topic`」改成 `{"envelope": 匯流排 envelope}`。`topic` → `envelope.type`,`ts` → `at`,`causation` → `parent`,`correlation` → `turn`,`event.data`(或自訂事件的 `event.data.payload`)→ `data`;新增 `v`、`session`、`space_id`、`room_id`、`person_id`、`account_id`、`key`、`scope`。`event.type` 的底線名稱(`agent_turn_completed`、`custom`)不再出現,型別就是 topic。
- `events.publish`:`{topic, payload, correlation}` 改成 `{type, data, turn, parent, key}`。型別要在登錄表裡:自己的事件放在 `ext.<id>.` 底下(和以前一樣不需要權限),game adapter 的放在 `game.<id>.` 底下;沒有人登錄的 topic 不再接受(以前會變成 `custom` 事件)。保留的型別改由登錄表推出,不再是一串前綴;`ext.<id>.task.*` 從此也是保留的。`data` 會用型別的 schema 檢查。
- SDK:`ctx.events.publish(topic, payload, { correlation })` → `ctx.events.publish(type, data, { turn, parent, key })`;handler 收到的 `Envelope` 是新的 envelope(`envelope.type`、`envelope.data`,不再有 `envelope.topic`、`envelope.event`);新增 `ctx.events.on(Events.X, handler)` 依定義訂閱(`data` 有型別)、`Events`(每個匯流排型別的定義)、`is(Events.X, envelope)`、`EnvelopeOf`、`PublishOptions`;移除 `Event`(舊的 `{type, data}` 聯集)。`InitializeResult` 多了 `protocol`。
- 不用 SDK 的擴充:回 `initialize` 時加上 `"protocol":2`,讀 `params.envelope`,發佈時送 `type` / `data`。

### 協定 1 時期

- 協定本身沒有變動(版本仍是 1,線上的位元組跟以前一樣)。實作上:形狀改寫成 `@miyoria/contracts/ext` 的 schema(宿主和 SDK 共用);JSON-RPC 的訊框、關聯、取消、逾時只剩 `@miyoria/sdk` 裡的一份(`RpcPeer`),宿主以 `host` 角色使用它;`@miyoria/contracts` 跟 `@miyoria/sdk` 一起發佈到 npm,SDK 依賴它。
- 對 SDK 使用者:`@miyoria/sdk` 匯出的型別名稱都沒變,形狀從手寫改成推導。`IncomingMessage` 多了平台本來就會送的選填欄位(`reply_to`、`stickers`、`embeds`、`forwarded`、附件的 `id` 等),`VoiceUtterance` 多了選填的 `turn`;`RpcMessage` 的結果訊息 `result` 變成選填。`RpcError` 轉成字串時帶代碼(`denied (code -32001)`)。其餘(`ToolDecl.parameters`、`InitializeParams.config`、`TaskSpec.args`、`custom` 事件的 `payload`…)維持原本的寬鬆型別。
