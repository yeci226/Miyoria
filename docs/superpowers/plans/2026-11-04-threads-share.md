# 她滑 Threads 並分享到文字頻道 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 她閒著時自己滑 Threads,把對得上群體興趣的貼文截圖和評語發到 Discord 文字頻道。

**Architecture:** `threads` 外掛只管瀏覽器,註冊隱藏工具 `internal.threads.*`。新模組 `packages/share` 負責上限、挑候選、比對、寫評語和發文,用能力 `share.browse` 接上心智迴圈。`OutgoingMessage` 加上附圖,由 Discord sink 送出;她的訊息會經 gateway 回到 `platform.message.created`,自然進入對話紀錄和記憶。

**Tech Stack:** TypeScript(Node 24、vitest、zod)、discord.js REST、playwright-core、`@miyoria/llm` 的 `completeJson`。

**Spec:** `docs/superpowers/specs/2026-11-04-threads-share-design.md`

## Global Constraints

- 所有改動在 `yeci` 分支;`share` 列入 `OPT_IN_MODULES`,預設不啟用;外掛的 `headless` 預設 `false`、`game` 預設 `true`,主分支行為不變。
- 預設值:`when = "anytime"`、`max_per_day = 3`、`min_gap_mins = 120`、`browse_per_day = 6`、`posts = 10`、`quiet_hours = "01:00-08:00"`、`channels = []`、`exclude = []`、`keep_hours = 24`。
- 上限、間隔、安靜時段、黑白名單、禁發私訊都由程式檢查,模型無法繞過。
- 判斷不確定時一律不發;有圖但 `description` 為 `null` 的貼文不發。
- 貼文、留言、圖片描述、記憶、筆記都用 `dataBlock` 包起來。
- 沒有按讚、留言、發文、追蹤的動作;程式不碰帳號密碼。
- 時間以 Core 所在機器的本地時區計算,一天從 00:00 起算。
- 測試:`corepack pnpm --filter <pkg> test`;全部:`corepack pnpm -r typecheck`、`corepack pnpm -r test`(在 PowerShell 執行)。
- Commit:Conventional Commits 含 scope,不加任何署名、AI 工具名稱或 emoji;不改 git identity。每個 task 只 stage 自己的檔案,不動 `start-voice-stage.bat`、`patches/`、`package.json` 裡未提交的 pacer 修補。

## Review Focus

- 貼文含 `@everyone`、`<@123>`、「忽略以上指示」→ 留在資料區塊,發出去不標到任何人(Task 3、Task 7 測試)。
- 模型回傳候選外的頻道或不存在的貼文 → 當作 `skip`,不發文(Task 7 測試)。
- 安靜時段跨午夜、跨日歸零、Core 重啟 → 次數正確,不會因重啟超過上限(Task 6 測試)。
- 入選貼文全部有圖但沒有描述 → 不呼叫第 6 步模型,也不發文(Task 8 測試)。
- 滑到一半外掛重啟,工具消失 → 這輪結束,不丟未處理錯誤,暫存截圖清掉(Task 8 測試)。

---

### Task 1: Mac 上驗證瀏覽器能跑

先確認最大的不確定性,結果決定 `headless` 是否可行。不寫產品程式碼。

**Files:** 無(腳本放 scratchpad,不進 repo)

**Interfaces:**
- Produces:一句結論(headless 能不能打開 `https://www.threads.com/` 並讀到 `<time>` 或登入連結),記到 Task 10。

- [ ] **Step 1: 在 Mac 建置前置項目**

Run: `ssh <mac-host> 'cd ~/miyoria && export PATH=$HOME/miyoria-runtime/node/bin:$PATH && pnpm --filter @miyoria/sdk build && cd extensions/threads && pnpm browser && pnpm build'`
Expected:`packages/sdk/dist/index.js`、`extensions/threads/dist/index.js` 存在,`~/Library/Caches/ms-playwright/chromium-1248` 存在。不要動 `miyoria.toml`,不重啟 Core。

- [ ] **Step 2: 用 pm2 同一種背景工作階段跑 headless 探測**

用暫時的 pm2 app `threads-probe`(只跑一次,跑完 `pm2 delete threads-probe`;不碰其他 app)執行腳本:`chromium.launchPersistentContext(tmpDir, { channel: "chromium", headless: true })`,打開首頁,印出 `page.url()`、`<time>` 數量、`a[href*="/login"]` 數量。
Expected:沒有丟錯,且 `<time>` 或登入連結數量大於 0。

- [ ] **Step 3: 記錄結論**

headless 被擋時,Task 10 改用 `headless = false`,並把「需要 Mac 保持登入桌面」加進 README。

---

### Task 2: 隱藏工具

現在註冊的工具都會出現在每個對話回合的 `tools` 裡,會多花 token,她也可能直接呼叫。

**Files:**
- Modify: `packages/tools/src/`(`ToolRegistry` 所在檔)
- Modify: `packages/agent/src/turn.ts:1341`
- Test: `packages/tools/test/`、`packages/agent/test/`

**Interfaces:**
- Produces:`isInternalTool(name: string): boolean`(`name.startsWith("internal_")`),由 `@miyoria/tools` 匯出。`ToolRegistry.get` 仍能拿到;`ToolRegistry.specs()` 不回傳。

- [ ] **Step 1: 寫失敗測試**

`specs() leaves internal tools out`:註冊 `internal_threads_feed` 和 `react`,`specs()` 名稱只有 `react`,`get("internal_threads_feed")` 仍有值。
agent 測試 `an internal tool cannot be called by name from a turn`:模型呼叫 `internal_threads_feed`,結果是 `error: unknown tool`。

- [ ] **Step 2: 確認失敗**

Run: `corepack pnpm --filter @miyoria/tools test`
Expected:FAIL。

- [ ] **Step 3: 實作**

`specs()` 過濾 `isInternalTool`;`Turn.#offers` 加上 `!isInternalTool(name)`。`packages/mcp/src/server.ts` 用的是 `registry.specs()`,確認隱藏工具也不會透過 MCP 暴露。

- [ ] **Step 4: 確認通過**

Run: `corepack pnpm --filter @miyoria/tools test`、`corepack pnpm --filter @miyoria/agent test`
Expected:PASS。

- [ ] **Step 5: Commit**

`feat(tools): internal tools are not offered to the model`

---

### Task 3: 訊息附圖

**Files:**
- Modify: `packages/types/src/platform.ts:202`
- Modify: `packages/discord/src/sink.ts:80-115`
- Test: `packages/discord/test/sink.test.ts`

**Interfaces:**
- Produces:

```ts
export interface OutgoingFile { name: string; path: string; contentType: string }
export interface OutgoingMessage {
  text: string;
  reply_to: MessageRef | null;
  files?: OutgoingFile[];
  /** `false`: nobody is pinged, not even users. */
  mentions?: boolean;
}
```

`RestRequest` 新增 `files?: { name: string; data: Buffer; contentType: string }[]`(對應 discord.js REST 的 `files`)。

- [ ] **Step 1: 寫失敗測試**

- `attaches files to the first chunk only`:3000 字加一張圖,第一次 POST 有 `files`,第二次沒有。
- `reads the file from its path`:`data` 等於暫存檔內容。
- `sends no pings when mentions is false`:文字 `<@123> @everyone`,body 的 `allowed_mentions` 為 `{ parse: [] }`,內容不含 `@everyone`。
- `fails when a file cannot be read`:路徑不存在時丟 `DiscordSendError`,REST 沒被呼叫。

- [ ] **Step 2: 確認失敗**

Run: `corepack pnpm --filter @miyoria/discord test`
Expected:FAIL。

- [ ] **Step 3: 實作**

先讀完所有檔案再送第一段,讀檔失敗就不送任何內容。

- [ ] **Step 4: 確認通過並跑型別檢查**

Run: `corepack pnpm --filter @miyoria/discord test`、`corepack pnpm -r typecheck`
Expected:PASS。

- [ ] **Step 5: Commit**

`feat(discord): messages can carry files and send no pings`

---

### Task 4: 能力可以暫時不提供

**Files:**
- Modify: `packages/actions/src/capability.ts:81`
- Modify: `packages/mind/src/snapshot.ts:397`、`packages/mind/src/prompt.ts:111`、`packages/mind/src/mind.ts:737`
- Test: `packages/mind/test/`

**Interfaces:**
- Produces:`Capability.available?(): boolean`;`share.browse` 的 `SOLO` 文字「去滑一下 Threads,看到想分享的就發」;mind prompt 輸入新增 `threadsGame: boolean`。

- [ ] **Step 1: 寫失敗測試**

- `capabilityInfo leaves out an unavailable capability`:`available: () => false` 不在結果中,沒定義 `available` 的仍在。
- `offers share.browse when nobody is around`:`capabilities` 含 `share.browse` 時,prompt 含「去滑一下 Threads」。
- `does not mention Threads as a game without the adapter`:`threadsGame: false` 時,`game.start` 那行不含 `threads`;`true` 時維持原文。

- [ ] **Step 2: 確認失敗**

Run: `corepack pnpm --filter @miyoria/mind test`
Expected:FAIL。

- [ ] **Step 3: 實作**

`threadsGame` 由 `ToolRegistryKey` 查 `game_threads_observe` 是否存在。

- [ ] **Step 4: 確認通過**

Run: `corepack pnpm --filter @miyoria/mind test`、`corepack pnpm --filter @miyoria/actions test`
Expected:PASS。

- [ ] **Step 5: Commit**

`feat(mind): capabilities can be unavailable for a while`

---

### Task 5: Threads 外掛的分享工具

**Files:**
- Modify: `extensions/threads/src/browser.ts`、`src/feed.ts`、`src/index.ts`、`config.schema.json`、`package.json`、`README.md`
- Create: `extensions/threads/src/share.ts`、`src/login.ts`
- Test: `extensions/threads/test/share.test.ts`

**Interfaces:**
- Consumes:Task 2 的 `internal_` 前綴。
- Produces:工具 `internal.threads.feed {limit}`、`internal.threads.capture {link}`、`internal.threads.close {}`,註冊後為 `internal_threads_feed` 等。回傳皆為 JSON 字串:

```ts
interface FeedPost { link: string; author: string; age: string | null; body: string; images: number }
interface FeedResult { logged_in: boolean; posts: FeedPost[] }
interface CaptureResult { jpeg: string | null; description: string | null }
```

`src/share.ts` 匯出 `class ShareTools { constructor(browser: Browser, pictures: Pictures | null, seen: SeenStore, deadlineMs?: number) feed(limit: number): Promise<FeedResult>; capture(link: string): Promise<CaptureResult>; close(): Promise<void> }`。`SeenStore` 為 `{ load(): Promise<string[]>; save(links: string[]): Promise<void> }`。`Browser` 介面新增 `url(): string`。`feed.ts` 新增 `worthReading(post: Post): boolean`。

- [ ] **Step 1: 寫失敗測試**

- `worthReading drops ads and short posts`:含「贊助」或 `Sponsored` 行、沒有連結、無圖且 `body` 少於 8 字都回傳 `false`。
- `feed returns unseen posts up to the limit and remembers them`:第二次呼叫不再回傳同一連結。
- `the seen list keeps the newest 500`。
- `feed reports logged_in false on the login page`:不回傳貼文。
- `feed treats a page off threads.com as not logged in`:`url()` 為 `https://www.instagram.com/challenge/` 時 `logged_in` 為 `false`。
- `feed stops at the deadline with what it has`:假 `Browser` 永遠沒有新貼文、`deadlineMs` 很小時,會回傳而不是卡住。
- `capture finds the post by link again`:位置改變後仍截到同一則。
- `capture with pictures but no description`:`description` 為 `null`,`jpeg` 仍有值。
- `capture of a post that is gone`:回傳 `{ jpeg: null, description: null }`。
- `does not register the game adapter when game is false`。

- [ ] **Step 2: 確認失敗**

Run: `corepack pnpm --filter @miyoria/ext-threads test`
Expected:FAIL。

- [ ] **Step 3: 實作 `ShareTools` 和瀏覽器設定**

- `feed`:`launch` → `home` → `loggedIn` → 重複 `posts` 和 `scrollBy`,預設 `deadlineMs = 25_000`。
- `BrowserOptions` 加 `headless: boolean`,`headless` 時用固定 `viewport`,不帶 `--app`。
- `capture`:用 `posts()` 找 `link` 對應的索引再 `shot`;`images > 0` 才描述。
- 設定新增 `headless`、`game`,`config.schema.json` 同步。

- [ ] **Step 4: 實作 `pnpm run login`**

`src/login.ts` 用同一個 `profile_dir` 開有視窗的瀏覽器,等視窗關閉後結束。資料夾來源:環境變數 `MIYORIA_THREADS_PROFILE`,否則 `defaultProfileDir()`。`package.json` 加 `"login": "node dist/login.js"`。

- [ ] **Step 5: 確認通過並更新 README**

Run: `corepack pnpm --filter @miyoria/ext-threads test`、`corepack pnpm --filter @miyoria/ext-threads typecheck`
Expected:PASS。README 加上分享用途、`headless`、`game`、`pnpm run login`;提醒登入前先確認 Core 沒有正在滑(同一個資料夾不能同時開)。

- [ ] **Step 6: Commit**

`feat(threads): tools for reading the feed and capturing a post`

---

### Task 6: `share` 套件骨架、設定與上限

**Files:**
- Create: `packages/share/package.json`、`tsconfig.json`、`tsconfig.build.json`、`vitest.config.ts`(照 `packages/sing`)
- Create: `packages/share/src/config.ts`、`src/limits.ts`、`src/index.ts`
- Test: `packages/share/test/limits.test.ts`

**Interfaces:**
- Produces:

```ts
export const ShareConfigSchema; export type ShareConfig;
export type Pause = "login" | "no_posts" | null;
export interface LimitState { day: string; posts: number; rounds: number; last_post_ms: number | null; pause: Pause; empty_rounds: number }
export class Limits {
  constructor(config: ShareConfig, state?: unknown);
  quiet(nowMs: number): boolean;
  canBrowse(nowMs: number): boolean;
  canPost(nowMs: number): boolean;
  noteRound(nowMs: number): void;
  notePost(nowMs: number): void;
  noteEmpty(): boolean;   // true when this makes three in a row
  noteFound(): void;
  pause(why: Exclude<Pause, null>): boolean;  // true only on the transition
  resume(): void;
  get paused(): Pause;
  snapshot(): LimitState;
}
```

- [ ] **Step 1: 寫失敗測試**

- 預設值完全等於 Global Constraints。
- `quiet_hours` 格式錯誤時 `ShareConfigSchema.parse` 丟錯;空字串代表關閉。
- `quiet handles a range over midnight`:`23:00-02:00` 時 00:30 為 `true`,12:00 為 `false`;`01:00-08:00` 時 08:00 為 `false`。
- `counts reset on a new local day`。
- `canBrowse is false at browse_per_day, at max_per_day, inside the gap, while quiet and while paused`。
- `canPost is false at max_per_day and inside the gap`。
- `pause reports only the first transition`。
- `a restored state keeps today's counts`;`unreadable state starts empty`。

- [ ] **Step 2: 確認失敗**

Run: `corepack pnpm install`、`corepack pnpm --filter @miyoria/share test`
Expected:測試 FAIL(套件有被安裝)。

- [ ] **Step 3: 實作 `config.ts`、`limits.ts`**

- [ ] **Step 4: 確認通過**

Run: `corepack pnpm --filter @miyoria/share test`
Expected:PASS。

- [ ] **Step 5: Commit**

只 stage 新套件和 `pnpm-lock.yaml` 中屬於 `share` 的改動;若 lockfile 混有未提交的 pacer 修補,用 `git add -p`。

`feat(share): settings and limits for sharing what she reads`

---

### Task 7: 選頻道與模型判斷

**Files:**
- Create: `packages/share/src/channels.ts`、`src/judge.ts`
- Test: `packages/share/test/channels.test.ts`、`test/judge.test.ts`

**Interfaces:**
- Consumes:`WorldState.snapshot().channels`、`IntentSink.ceiling(context)`、`MemoryEngine.recall`、`ConversationStates.get`、`visibleScopes`、`tokenize`、`completeJson`、`dataBlock`。
- Produces:

```ts
export interface Candidate { link: string; author: string; body: string; images: number; description: string | null; jpeg_path: string | null }
export interface ChannelMatch { context: ContextKey; name: string; memories: string[]; notes: string; score: number }
export function eligibleChannels(channels: ChannelActivity[], ceiling: (c: ContextKey) => TalkCeiling | null, config: ShareConfig): ChannelActivity[];
export async function matchChannels(channels: ChannelActivity[], query: string, deps: MatchDeps, nowMs: number): Promise<ChannelMatch[]>;
export async function pickPosts(router: Completer, persona: string, posts: FeedPost[], signal?: AbortSignal): Promise<string[]>;
export async function decide(router: Completer, persona: string, candidates: Candidate[], channels: ChannelMatch[], signal?: AbortSignal): Promise<Decision | null>;
export interface Decision { link: string; context: ContextKey; comment: string }
```

- [ ] **Step 1: 寫失敗測試**

`eligibleChannels`:
- 只留 `kind === "channel"` 且 `scope` 不為 `null`,私訊、語音頻道的文字區都排除。
- `mode` 為 `off`、`mention-only` 的頻道排除。
- `channels` 非空時只留清單內;`exclude` 優先於 `channels`。

`matchChannels`:
- 取分數前 3 個,零分的不回傳,全部零分時回傳空陣列。
- 查記憶時 `scopes` 只有該伺服器的 `guild`、該頻道的 `channel`,不含 `global`、`person`、`dm`,`present` 為空。
- 對話筆記(`recap` + `notes`)和貼文用 `tokenize` 有交集才算分。

`pickPosts`、`decide`:
- 兩個 prompt 的 system 都含 persona 和「色情、血腥、仇恨、霸凌、個資」。
- `pickPosts` 最多回傳 2 則,不在清單內的連結丟掉。
- `decide` 的 `channel` 不是候選之一、或 `post` 不是候選之一時回傳 `null`。
- `action = "skip"` 回傳 `null`;模型輸出不合格式或 provider 錯誤也回傳 `null`,不丟錯。
- 貼文內容含「忽略以上指示」時位於 `dataBlock` 內。
- `comment` 超過 300 字時回傳 `null`。

- [ ] **Step 2: 確認失敗**

Run: `corepack pnpm --filter @miyoria/share test`
Expected:FAIL。

- [ ] **Step 3: 實作**

- 分數:記憶命中數 × 2 + 筆記 token 交集數(上限 5)。
- 用途都是 `chat`,`json_mode: true`,`pickPosts` 的 `max_tokens = 200`,`decide` 的 `max_tokens = 400`。
- 兩次呼叫都包 `withLlmTag({ feature: "share" }, ...)`。
- prompt 用繁體中文;`decide` 要求評語是她自己的話,不重複貼文內容,也不提「截圖」。

- [ ] **Step 4: 確認通過**

Run: `corepack pnpm --filter @miyoria/share test`
Expected:PASS。

- [ ] **Step 5: Commit**

`feat(share): she picks posts and the channel that would care`

---

### Task 8: 一輪分享流程

**Files:**
- Create: `packages/share/src/feed.ts`、`src/sharer.ts`
- Test: `packages/share/test/sharer.test.ts`

**Interfaces:**
- Consumes:Task 5 的工具和結果型別、Task 6 的 `Limits`、Task 7 的函式、Task 3 的 `OutgoingMessage`。
- Produces:

```ts
export class ThreadsFeed {
  constructor(tools: () => ToolRegistry | undefined, ctx: ToolContext);
  get ready(): boolean;
  feed(limit: number): Promise<FeedResult>;
  capture(link: string): Promise<CaptureResult>;
  close(): Promise<void>;   // never throws
}
export class Sharer {
  constructor(config: ShareConfig, deps: SharerDeps, dataDir: string);
  available(nowMs: number): boolean;
  start(signal: AbortSignal): boolean;  // false when a round is running or not available
  flush(signal: AbortSignal): Promise<void>;  // `active`: tries waiting candidates
  probe(signal: AbortSignal): Promise<void>;  // paused: checks the login, no tokens
  restore(): Promise<void>;
}
```

`SharerDeps` 集中所有外部依賴(模型、記憶、world、ceiling、sink、settings、feed、owners、persona、clock),測試全部用假物件。狀態存在 settings store,profile `_global`,key `share:state`(含 `Limits` 和 `active` 候選)。

- [ ] **Step 1: 寫失敗測試**

- `one round posts one message`:順序為 `feed` → `pickPosts` → `matchChannels` → `capture` → `decide` → `send` → `close`;訊息是 `評語\n<https://www.threads.com/@a/post/1>`,帶 `files` 和 `mentions: false`。
- `the temp image is deleted after sending`,發送失敗時也刪除。
- `no pick ends the round with one model call and no capture`。
- `no matching channel ends before capture and decide`。
- `a post with pictures and no description is dropped`:全部被丟掉時 `decide` 沒被呼叫。
- `a failed send does not count against the limit`。
- `limits are checked again right before sending`:`decide` 期間達到上限時不送。
- `a decision for a channel now excluded is not sent`。
- `only one round at a time`:第二次 `start` 回傳 `false`。
- `login lost pauses and tells each owner once`:連續兩輪只私訊一次。
- `three empty rounds pause and tell the owners`。
- `probe resumes when logged in, spends no tokens`。
- `the extension going away mid round`:`feed` 丟錯或工具消失,這輪結束,`close` 不丟錯,截圖清掉。
- `model failure ends the round`,不重試,計入 `rounds`。
- `active keeps candidates until a channel is lively`:`flush` 在沒有 `lively` 頻道時不呼叫模型;有時才 `decide`。
- `active drops candidates after keep_hours`,檔案一併刪除。
- `state survives a restart`:新的 `Sharer` 經 `restore` 後次數相同。

- [ ] **Step 2: 確認失敗**

Run: `corepack pnpm --filter @miyoria/share test`
Expected:FAIL。

- [ ] **Step 3: 實作 `ThreadsFeed`、`Sharer`**

- 暫存截圖放 `dataDir`,檔名 `<隨機 id>.jpg`,`capture` 的 base64 解碼後寫入。
- 發送用 `PlatformSinks.get(platform).send` 直接呼叫,才能拿到失敗結果。
- `filterOutgoing` 由 sink 套用,`Sharer` 不重複處理。
- `start` 立刻回傳,流程在背景跑,結束時一定呼叫 `close`。
- `available` 為 `limits.canBrowse && !running && feed.ready`,`active` 模式下有候選在等時回傳 `false`。

- [ ] **Step 4: 確認通過**

Run: `corepack pnpm --filter @miyoria/share test`
Expected:PASS。

- [ ] **Step 5: Commit**

`feat(share): a round of reading Threads and sharing a post`

---

### Task 9: 模組、能力與接線

**Files:**
- Create: `packages/share/src/actions.ts`、`src/module.ts`
- Modify: `packages/share/src/index.ts`
- Modify: `packages/core/src/module-ids.ts`、`packages/core/src/modules.ts`、`packages/core/package.json`
- Modify: `miyoria.example.toml`、`docs/protocols/extension-rpc.md`、`docs/superpowers/specs/2026-11-04-threads-share-design.md`
- Test: `packages/share/test/module.test.ts`、`packages/core/test/`

**Interfaces:**
- Consumes:`Sharer`、`Capability.available`。
- Produces:`class ShareModule { static ID = "share"; constructor(options: { baseDir: string; persona: (s: ServiceLookup) => string; owners: () => string[] }) }`,能力 `share.browse`。

- [ ] **Step 1: 寫失敗測試**

- `share.browse is not offered to chat`:能力沒有 `tool`,`risk` 為 `medium`。
- `share.browse starts a round and returns at once`:流程未完成時 `execute` 就回傳。
- `refuses while not available`:`check` 回傳原因,`available()` 為 `false`。
- `share is opt-in`:`OPT_IN_MODULES` 含 `share`,沒有設定段時不啟動。
- `a stopped module aborts its round`。

- [ ] **Step 2: 確認失敗**

Run: `corepack pnpm --filter @miyoria/share test`
Expected:FAIL。

- [ ] **Step 3: 實作模組**

- `manifest`:`optional: ["mind", "memory", "world", "agent", "conversation", "actions"]`。
- 背景工作:每分鐘呼叫一次 `flush`;暫停時每 6 小時呼叫一次 `probe`。
- 工具用 `ToolContext`:`principal` 為 `Principals.self`,比照 `@miyoria/game` 導演的做法。
- `dataDir`:`resolve(baseDir, "data/threads-share")`,啟動時建立,並清掉沒有被候選引用的舊檔。

- [ ] **Step 4: 接到 Core**

`module-ids.ts` 在 `sing` 後加 `share`,`OPT_IN_MODULES` 加 `share`。`modules.ts` 在 `SingModule` 後加 `ShareModule`,`persona` 比照 `MindModule`,`owners` 用 `authOwners(config)`。`miyoria.example.toml` 加註解掉的 `[modules.share]` 範例。

- [ ] **Step 5: 同步文件**

規格改成實際做法:工具名 `internal.threads.*`、不靠 `#offers` 而是 `internal_` 前綴、Discord 直接用 sink 發送、暫停時每 6 小時檢查一次登入。`extension-rpc.md` 註明 `internal.` 開頭的工具不提供給模型。

- [ ] **Step 6: 全部驗證**

Run: `corepack pnpm -r typecheck`、`corepack pnpm -r test`
Expected:全部 PASS。失敗要先修,不能略過。

- [ ] **Step 7: Commit**

`feat(share): she shares Threads posts on her own`

---

### Task 10: Mac 上線與實機測試

需要擁有者先開好 Threads 帳號,並用螢幕共用登入。

**Files:** Mac 的 `~/miyoria/miyoria.toml`(不進 repo,先備份)

**Interfaces:**
- Consumes:Task 1 的 headless 結論。

- [ ] **Step 1: 部署**

本機 `git push mac yeci:yeci-pc`,Mac 上 `git merge --ff-only yeci-pc`,`pnpm install --frozen-lockfile`,重新 build `@miyoria/sdk` 和 Threads 外掛。Push 前先徵得擁有者同意。

- [ ] **Step 2: 擁有者登入**

請擁有者在 Mac 的終端機執行 `cd ~/miyoria/extensions/threads && pnpm run login`,登入後關閉視窗。全程不經手帳號密碼。

- [ ] **Step 3: 改設定並只重啟 `miyoria`**

`[extensions."miyoria.threads"]`:`enabled = true`、`headless = true`、`game = false`;`[modules.share]`:`enabled = true`、`channels = ["<擁有者指定的測試頻道>"]`。順便拿掉上次沒有效果的 `golive_start_delay_ms = 12000`。只跑 `pm2 restart miyoria`,不碰其他 app。

- [ ] **Step 4: 觸發一輪並驗證**

等她閒置時自己選,或暫時調低 `min_interval_secs`。
Expected:
- 測試頻道出現一則訊息,有截圖、評語、原文連結,截圖只有貼文本身。
- 沒有標到任何人。
- 之後問她剛剛發了什麼,她答得出來。
- `miyoria-out.log` 有 `feature: share` 的用量紀錄,記下實際 token 數,和規格估算比較。

- [ ] **Step 5: 交給擁有者決定**

回報實測結果,由擁有者決定何時清空 `channels`,開放她自己挑頻道。
