# Extension RPC 協定(v1)

Core 的擴充宿主(`@miyoria/ext-host`,module id `extensions`)和每個擴充套件行程之間的協定。TS 擴充用 `@miyoria/sdk` 就不用自己處理這些細節;其他語言照這份文件實作即可(`packages/ext-host/test/fixtures/test-ext/index.mjs` 是一個不用 SDK、約 150 行的完整範例)。

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

LSP 風格:header、空行、UTF-8 JSON 本文。`Content-Length` 是本文的**位元組數**(不是字元數);header 名稱不分大小寫,其他 header(例如 `Content-Type`)會被忽略。本文上限 16 MiB。

```
Content-Length: 51\r\n
\r\n
{"jsonrpc":"2.0","id":1,"method":"log","params":{}}
```

## 生命週期

1. 宿主啟動行程,立刻送 `initialize`(request)。
2. 擴充在逾時內(`init_timeout_ms`,預設 10 秒)回傳 `contributions`。SDK 會在這段時間執行 `activate(ctx)`,把裡面註冊的工具、指令、prompt、訂閱收集起來一次回傳。
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
  "protocol":1,
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
{"jsonrpc":"2.0","id":1,"result":{"contributions":{
  "tools":[{"name":"dice","description":"擲骰子","parameters":{"type":"object","properties":{"sides":{"type":"integer"}},"required":[]},"permission":null}],
  "commands":[{"path":["hello"],"description":"跟 Miyoria 打招呼","args":[{"name":"name","description":"要打招呼的對象","kind":{"type":"string"},"required":false}],"permission":"","ephemeral":false}],
  "prompts":["facts"],
  "subscriptions":["agent.turn.completed"]
}}}
```

`contributions` 的每個欄位都可以省略。`tools[]` 的格式同 `tools.register`,`commands[]` 同 `commands.register`。

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

事件匯流排上的事件,只送**有訂閱且有權限**的 topic,不送擴充自己發佈的事件。`params` 是匯流排的 envelope 加上 `topic`:

```json
{"jsonrpc":"2.0","method":"event","params":{
  "topic":"agent.turn.completed",
  "id":"01JC0000000000000000000001","ts":"2026-11-01T10:00:01.123Z",
  "source":"agent","causation":null,"correlation":"01JC0000000000000000000000",
  "event":{"type":"agent_turn_completed","data":{"turn":"01JC0000000000000000000000","context":{"platform":"discord","scope":"123","channel":"456","kind":"channel"},"text":"沒幹嘛啊"}}
}}
```

`event` 是 `@miyoria/types` 的 `Event` 的 JSON(`{"type", "data"}`);自訂事件是 `{"type":"custom","data":{"topic":"…","payload":…}}`。完整型別見 `packages/sdk/src/types.ts`。擴充處理太慢、宿主的送出佇列滿了時,事件會被丟棄(會記警告)。

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

結果:`{"topics":[目前所有訂閱]}`。pattern 規則:`"*"` = 全部;`"a.b.*"` = `a.b.` 底下所有 topic;其他要完全相同。實際送出的事件 = 訂閱 ∩ 權限 `events`,所以訂閱 `"*"` 也只會收到被授權的 topic。

### `events.publish`

```json
{"jsonrpc":"2.0","id":2,"method":"events.publish","params":{
  "topic":"ext.miyoria.hello.greeted","payload":{"who":"Owen"},"correlation":null
}}
```

發佈一個 `Custom` 事件,`source` 是 `ext.<id>`。允許的 topic:

- `ext.<id>.*`(自己的命名空間)永遠可以;
- `game.<遊戲 id>.*`:只有宣告了這個遊戲的 game adapter 可以(不需要 `events` 權限,見〈Game adapter〉);
- 其他 topic 要符合權限 `events` 的某個 pattern,而且**不能**在保留前綴 `platform`、`agent`、`voice`、`action`、`system`、`game` 底下(防止偽造內建事件和遊戲事件)。

`correlation`(選填)是 TurnId,讓事件掛在某個回合底下。

### `tools.register` / `tools.unregister`

名稱以 `internal.` 開頭的工具(登記成 `internal_...`)只給 Core 的模組呼叫,不會提供給模型。

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
| `events` | 決定送哪些事件、能發佈哪些 topic(見上) |
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
- **事件**:adapter 可以發佈 `game.<id>.<type>`(例如 `game.minecraft.death`),不需要 `events` 權限。別的擴充即使有 `events = ["game.*"]` 也只能**訂閱**、不能發佈 `game.*`。
- **工具**:`game.<id>.observe`、`game.<id>.act`(登記成 `game_<id>_observe` / `game_<id>_act`;慢迴路 `@miyoria/game` 就是呼叫這兩個)。`game.` 底下的工具名稱只保留給該 adapter。
- **prompt**:`prompt.register` 的 key 照常加上 `ext.<id>.` 前綴。

SDK 的 `ctx.game.registerAdapter(adapter)` 負責這些對應;`describe().id` 必須等於 `ctx.game.id`(= `extension.game`),否則丟出錯誤、啟動失敗。事件的 `payload` 是 `GameEvent`:

```json
{"type":"death","data":{"text":"死掉了(被殭屍打死)","last_damage_source":"mob"},"important":true}
```

`type` 是 topic 最後的部分;`important: true` 表示值得立刻實況評論;`data.text`(選填)是一句繁體中文描述,給實況提示用。

## 逾時

| 方向 | 方法 | 設定(`[modules.extensions]`) | 預設 |
|---|---|---|---|
| Host → Ext | `initialize` | `init_timeout_ms` | 10000 |
| Host → Ext | `tools.call`、`commands.invoke` | `call_timeout_ms` | 30000 |
| Host → Ext | `prompt.contribute` | `prompt_timeout_ms` | 3000 |
| 停止 | `shutdown` 後等待結束 | `shutdown_grace_ms` | 2000 |

逾時的 request 在呼叫端得到 `-32002`,之後才到的 response 會被忽略;連線本身不受影響。SDK 對宿主的 request 預設 10 秒逾時。

## 錯誤碼

| code | 意義 |
|---|---|
| -32700 | JSON 解析失敗 |
| -32600 | 不是合法的 request |
| -32601 | 沒有這個方法 / 工具 / 指令 / prompt key |
| -32602 | 參數不對 |
| -32603 | 內部錯誤(handler 丟出的例外) |
| -32001 | 權限不足 |
| -32002 | 逾時(只在呼叫端產生,不會在線上傳) |
| -32003 | 名稱衝突 |
| -32004 | 宿主服務不存在(工具 registry、指令 registry、storage…) |
| -32005 | 連線已關閉(只在呼叫端產生) |

## 設定與 manifest

```toml
[modules.extensions]
dirs = ["extensions"]     # 找擴充的目錄(相對於工作目錄);`ext install` 裝到第一個
dev = false               # true = 檔案變動就重啟擴充
watch_poll_ms = 1000
```

宿主在每個 `dirs` 裡往下找最多三層含 `miyoria.extension.toml` 的目錄(略過 `node_modules`、`dist`、`.git`、隱藏目錄)。manifest 格式見 `docs/ARCHITECTURE.md` §9.2;`placement = "stage"` 的擴充不會在 Core 上執行(由 Stage 節點負責),`core` 和 `any` 會。`[[mcp_servers]]` 宿主只解析,透過 `Arc<ExtensionCatalog>` 服務提供給 MCP 模組。
