# v2 實作分工(平行工作的 brief)

> 狀態:**已完成**(2026-11-06;W1–W10 都已合併,各段末尾附實作紀錄)。原本是平行工作的 brief(2026-11-04)。設計見 [v2-architecture.md](v2-architecture.md)(以下「§」都指那份);kernel / module / service key 模型見 [ARCHITECTURE.md](../ARCHITECTURE.md) §2;程式慣例見 [TS-CONVENTIONS.md](../TS-CONVENTIONS.md);commit 規則見 `AGENTS.md`。共用契約已經放進 `packages/types/src`(下面 §1),各工作流**照契約寫,不要各自再定義一份**。
>
> 行號是寫這份文件當下(commit `2a86ff0` 之後)的位置;動手前用旁邊寫的識別字 grep 一下確認。

## 0. 共用檔案規則

平行的 worktree 最後要合在一起,共用檔案只能做「不會衝突」的修改:

| 檔案 | 規則 |
|---|---|
| `packages/types/src/**` | **只新增檔案**。`index.ts` 只能在檔尾追加 export;既有型別不改名、不改欄位。真的要擴充既有 union(例如 `SpeakOutcome`)時,只能在 union **尾端追加成員**,並在 PR 說明列出。新的 bus topic 一律用 custom event + `*_TOPIC` 常數(見 `v2-topics.ts`),**不要**動 `event.ts` 的 `Event` union / `EVENT_TOPICS`(SDK 有一份對應的副本) |
| `packages/core/src/modules.ts` | 只追加小 hunk(新 module 一行、import 一行),不重排既有順序 |
| `packages/core/src/boot.ts`、`packages/core/src/recorder.ts` | 同上,只追加 |
| `miyoria.example.toml` 與 `packages/cli/templates/miyoria.example.toml` | 兩份要一起改(內容相同);只追加新的 section / key,舊 key 的刪除留到該階段收尾 |
| `docs/design/*.md` | 各工作流只在自己的小節追加實作紀錄 |

其他規則:

- 每個工作流只改「擁有」欄列出的路徑;要改別人的檔案就在 PR 說明寫「需要 Wx 配合」,不要直接改。下面列出的例外(某工作流可以改別人檔案裡的某個 hunk)才可以。
- 消費別人還沒做好的服務時,一律 `ctx.services.get(XKey)`,拿不到就走**現在的行為**(fallback),這樣每個工作流都能單獨合併。
- 新的 config key 照 TS-CONVENTIONS §6:zod schema、每個欄位有預設值,預設值等於 example toml。

## 1. 共用契約(`packages/types/src`,本次新增)

| 檔案 | 內容 | 提供者 | 主要消費者 |
|---|---|---|---|
| `handle.ts` | `Handle`、`HandleEntry`、`HandleDirectory` + `HandleDirectoryKey`;`isEphemeralHandle()`(擋 `u1`/`p2`/`g3`)、`ephemeralHandlesIn(text)`、`assignHandle()`(同名才加 `#2`)、`handleBase()`、`isValidHandle()` | W5(store + `core/src/boot.ts`) | 全部 |
| `turn.ts` | `TurnFocus{addressed_by, addressed_accounts, focus, background, phase, restarts}`、`TurnFocusView` + `TurnFocusViewKey`、`inputDisposition()`(§3.9 取消規則表)、`isShortReply()`、`TurnOutcome`(sent / silence / cancelled{cause, by} / error)、`TurnOutcomeRecord`;topic `agent.turn.focus`、`agent.turn.outcome` | W1(agent) | W2、W6、面板 |
| `prompt-block.ts` | `PromptAuthority`(`self` 可信 / `data` 不可信)、`PromptBlock extends PromptSection`(authority、source、`budget_chars`、overflow)、`asPromptBlock()`、`SELF_BLOCK_KEYS`、`CompiledBlock`、`SavedPrompt` | W1 | 所有 prompt contributor |
| `reasoning.ts` | `ReasoningLevel`(off/low/medium/high)、`REASONING_PURPOSES`(§3.10 的十個)、`DEFAULT_REASONING`、`reasoningFor()`、`reasoningEnabled()` | W1(llm) | 所有呼叫 LLM 的模組 |
| `activity.ts` | `HerPresence` / `HerBroadcast` / `HerActivity`(三台狀態機)、`ActivitySnapshot`(帶 `version`、`scene`、`override`)、`ActivityRequest`(ensure_voice / leave_voice / ensure_live / stop_live / start / stop / scene_override / clear_override)、`ActivityTransition`(principal、turn、context)、`TransitionResult`(started / already / queued / refused,帶 task id)、`ActivityTask`、`ActivityTaskEvent`、`Notice`、`ActivityManager` + `ActivityManagerKey`;topic `activity.changed|started|done|failed`、`agent.notice` | W3(新 `packages/activity`) | W1、W4、W6、W7、stage |
| `task.ts` | `TaskId`、`TaskSpec{id, goal, args, budget_s}`、`TaskEvent`(started / progress / done / failed{code, detail})、`TASK_FAILURE_CODES`、`StructuredState`、`TaskExecutor`(observe / start / cancel / events)、`taskTopic()` / `parseTaskTopic()`(`<owner>.task.<type>`) | W3(ActivityManager)、W8(extension) | W3、W7、W8 |
| `arbiter.ts` | `Impulse{source, kind, target, priority, expires_at, why, hint, coalesce_key, goal}`、`IMPULSE_SOURCES`、`isSelfInitiated()`(只有 plan / agenda 算她主動)、`ArbiterDecision{verdict, reason, detail, retry_at}`、`LedgerEntry` / `LedgerLimits` / `LedgerView` / `LedgerRecord`、`Arbiter` + `ArbiterKey`;topic `arbiter.impulse|decision|ledger` | W6(新 package) | W1、W3、W7、所有發 initiative 的地方 |
| `affect.ts` | `AppraisalEvent{emotion, strength: weak|medium|strong, toward, cause}`、`APPRAISAL_STRENGTH`(0.1/0.2/0.35)、`AffectEvent` + `AFFECT_EVENT_KINDS`(規則事件)、`AffectInput`、`AppliedAppraisal`、`PersonCard`(一人一卡,含 `attachment`、`feeling`、`label`)、`BondChange`、`RelationshipLabel` + `relationshipLabel()`(唯一刻度,門檻同現在 `social/src/rel.ts:308`)、`AffectBiases`、`AffectSnapshot`(`top` 2–3 種、`mood` 推導、`mood_line`)、`AffectState` + `AffectStateKey`;topic `affect.event`、`affect.changed`。沿用 `self.ts` 的 `Drives`、`EmotionName`、`PersonEmotionName`、`EmotionReading`、`ShownEmotion` 與 `social.ts` 的 `Mood` | W4(self module) | W1、W6、W7 |
| `plan.ts` | `Goal`(§3.7,`expires` 必填,`steps: string[]`)、`GoalTrigger`(at / when_online(Handle) / after_activity / whenever)、`triggerFires()` / `goalDue()`(**whenever 永遠不是到期**)、`isGoalExpired()`、`Desire`(想做的事清單)、`PlanWake`、`GoalAgenda` + `GoalAgendaKey`;topic `plan.goal` | W7 | W6、W1 |
| `v2-topics.ts` | `V2TopicPayloads`(topic → payload 型別表)、`V2_TOPICS`、`V2_TOPIC_PREFIXES`、`v2Event()`、`v2Payload()` | — | 全部 |

形狀規則照 TS-CONVENTIONS §2:序列化的欄位 snake_case、可選值是 `T | null`;訊息用既有的 `MessageRef`(語音句子是 `{context, id: utterance.id}`,`agent/src/runtime.ts:640` 已經這樣包)。v2 的 topic 都是 custom event;`activity` / `arbiter` / `affect` / `plan` 這四個前綴要加進 extension host 的保留前綴(見 W3)。

## 2. 工作流

### W1 Converse(對話管線、prompt 編譯器、推理分級、人設)

**擁有**:`packages/agent/**`、`packages/llm/**`、`profiles/**`;`packages/core/src/recorder.ts` 追加 outcome 紀錄的 hunk;兩份 example toml 的 `[llm.reasoning]`、`[modules.agent]` 段。

**提供**:`TurnFocusViewKey`(agent module `ctx.provide`)、topic `agent.turn.focus` / `agent.turn.outcome`、prompt 編譯器(`PromptBlock` 的唯一消費者)、`[llm.reasoning]`(router 依 `ReasoningPurpose` 決定推理等級)、notice 的呈現。

**消費**:`HandleDirectoryKey`(fallback:`safeName(display_name)`)、`AffectStateKey`(fallback:`SelfStateKey` + `MoodSignalsKey`)、`ActivityManagerKey`(fallback:`WorldStateKey` 的 `her`)、`ArbiterKey.ledger()`(fallback:`MindKey.unanswered`)、`GoalAgendaKey`(fallback:`SelfState.agenda()`)、topic `agent.notice`、`voice.barge_in`。

**階段 0**:1、3、4、5、7、8、18。

| 要改的地方 | 現況 |
|---|---|
| `agent/src/coordinator.ts:122-141` | 新訊息無條件 `#abort` 未 committed 的回合;語音已生成未播放的也 `#cancel` 重生成 → 改用 `inputDisposition()`;`#abort`(`:433`)要帶 cancel cause |
| `agent/src/coordinator.ts:302-345` | `#initiative` 的 busy / cooldown / `startBlocked` 判斷(W6 之後移到 Arbiter,W1 先別刪) |
| `agent/src/attention.ts:380-383` | talkativeness ≤ 靜音門檻就 return,在「是不是在回她」之前 → 回她剛說的話要先跳過安靜檢查與 level 冷卻;talkativeness 下限 |
| `agent/src/prompt.ts:39` `GUARD_RULES`、`:65-66` `ADDRESSED`、`:344-357` `focusMessage()`(取最後 3 則 `current`)、`:486-489`(資料區塊 + 第二則 system) | §3.5 編譯器:self 可信 system 區塊 / data 不可信區塊;focus 只放 `TurnFocus.focus`,寫「Owen 問你:…」 |
| `agent/src/turn.ts:803-810` | contributor 收集後 `renderSections(…, max_context_chars)` 依順序截斷(`agent/src/config.ts:323` 預設 4000)→ 每段自己的 budget(`asPromptBlock()`) |
| `agent/src/turn.ts:1044` | `reply_reference` 引用最後一則 → 引用 `focus[0]`;`agent/src/config.ts:299` 預設改 true |
| `agent/src/turn.ts:1155-1163` | **文字回覆的 thinking 寫死在這裡**(`thinking: !this.voice`),不是 `[llm.thinking] chat`;改成 `reasoningFor("chat_text" / "chat_voice" / "chat_intent")` |
| `agent/src/turn.ts:733-741` | gray-zone `fast` 檢查的 thinking |
| `agent/src/turn.ts:276-344` `#sentence` | 雙語:中文字幕先寫、`<voice>` 日文後寫,整對寫完才送 TTS → 先寫 `<voice>`,寫完立刻送(§3.9 延遲) |
| `agent/src/turn.ts:923`、`agent/src/config.ts:265` | `history_after_fold` 10 → 25 |
| `agent/src/config.ts:252` | 文字 debounce 1500 → 800 |
| `agent/src/turn.ts:562`、`agent/src/runtime.ts:421`、`:517` | 發 `agent_decision` 的三處;回合結束時另發 `agent.turn.outcome`(不要改 `DecisionTrace`) |
| `agent/src/turn.ts:1339` `#toolSpecs` | 工具依 `ActivitySnapshot.activity` 限定(§3.4);**階段 0 item 9 不在這裡修**(W3 在 ext-host 源頭擋) |
| `agent/src/turn.ts:126` `CLAIMS` | 用正則抓她說的話判斷有沒有做動作 → 改看 `TransitionResult` / notice(W3 之後) |
| `agent/src/turn.ts:1446` | 發 `agent.emotion`(Stage 表情要用,照發;回寫心情的是 W4 的 `social/src/mood.ts:294`) |
| `agent/src/signals.ts:74-78`(冷淡/普通/親近)、`:136` `moodHint` | 第二、三套刻度與第二個心情 renderer → `relationshipLabel()` 與 `AffectSnapshot.mood_line` |
| `llm/src/module.ts:78`、`llm/src/router.ts:171` `#thinkingFor` | `[llm.thinking]` 開關 → `[llm.reasoning]` 等級;舊 key 先保留當 fallback(`true` 視為 `medium`)|
| `core/src/recorder.ts:88` | 目前只把 `agent_decision` 寫進 decision log;追加 `agent.turn.outcome` 的紀錄(store 需要的方法請 W5 加,見 W5) |

**單一 renderer(item 18)**:W1 的編譯器直接從服務 render `SELF_BLOCK_KEYS`(心情、在做什麼、方針、議程、Ledger、notice);「在場的人」由 W1 render 成**一個** data 段落(每人一行:handle、`relationshipLabel`、她的感覺一句)。現有 contributor 中跟它重複的(key `mood` — `social/src/mood.ts:426`;`emotion`、`self` — `self/src/prompt.ts:128`、`:48`;`social` — `social/src/prompt.ts:9`;`world` 裡她自己的狀態)由 W1 在編譯器裡**忽略**(列在 agent 自己的 superseded 清單),W4 之後再刪掉那些 contributor。

**W1 實作紀錄**:

- 回合擁有權在 `agent/src/focus.ts`(`selectFocus`、`callKind`、`TurnFocusBoard` = `TurnFocusViewKey`)與 `coordinator.ts`(只用 `inputDisposition()`)。`NewInputFacts` 追加了可選的 `selfStarted`:她自己開的回合(initiative / intent / notice)遇到有人叫她就讓出(`cancelled{cause: "superseded"}`)。
- `agent.turn.outcome`:正常結束的回合由 turn 發,被取消的(`input` / `superseded` / `shutdown`,intent 的 `expired` / `superseded`)由 coordinator 發;`barge_in` 從 `voice.barge_in`(`action: "stop"`、`turn`、`account`)記下是誰。`core/src/recorder.ts` 用 `store.decisions.appendOutcome?.({id, profile, ts, outcome})` 寫入——**需要 W5 在 `DecisionLog` 加這個 optional 方法**(形狀見 `recorder.ts` 的 `TurnOutcomeEntry`)。
- 編譯器在 `agent/src/compiler.ts`(預算、`SUPERSEDED`、`SavedPrompts` = `SavedPromptsKey`、topic `agent.prompt`)與 `self-block.ts`(每個概念一個 renderer,服務不在就 fallback)。順序維持前綴快取友善:`[system 人設 + 規則] [user 範例對話] [history] [user 資料 + 要回的訊息] [system 情境 + 你自己的狀態]`。面板要看 prompt 的 API 路由還沒做(`packages/api` 不屬於 W1):讀 `SavedPromptsKey.recent(context, n)` / `get(turn)` 即可。
- 雙語語音先寫 `<voice>`,寫完立刻送 TTS(speak 的 text 是那句日文,`prepare(line, line)`),中文寫完後發 `agent.subtitle {turn, context, spoken, text}`、歷史改成中文。**Stage 字幕要換成中文需要 W3 訂閱 `agent.subtitle`**(現在字幕先顯示日文);`[modules.agent.voice] voice_first = false` 回到舊行為。
- Attention 只改了「回她剛說的話」跳過安靜檢查與 level 冷卻、talkativeness 下限(`attention.talk_floor`)、有 `AffectStateKey` 時用 `biases.talkativeness` 取代好感 / 精力乘數;冷卻、level 間隔、initiative 的 busy / cooldown / `startBlocked` 都還在(W6 的 seam,註解有標)。

### W2 Voice(barge-in、ducking、回音排除、TTS 預取、唱歌 / GPU)

**擁有**:`packages/voice/**`(**除了** `packages/voice/src/actions.ts`,那是 W3 的)、`apps/voice-node/**`、`docs/protocols/voice-link.md`;需要時可改 `packages/sing` 裡 `VoiceFloor` / `SpeechPause` 的提供端(只限那部分)。

**提供**:選擇性 barge-in;topic `voice.barge_in`(新增在 `packages/voice/src/topics.ts`,payload `{context, turn, account, action: "duck"|"pause"|"resume"|"stop", reason}`;W1 用它把 `TurnOutcome` 記成 `cancelled{cause: "barge_in", by}`;如果要跨套件共用型別,在 `packages/types/src` 新增檔案);voice link 的 duck / resume 訊息。

**消費**:`TurnFocusViewKey.current(voiceContext)`(`addressed_accounts` = 該停的人;拿不到就維持現在的行為,但先改成 duck);`isShortReply()`(ASR 回來是短回應就不停)。

| 要改的地方 | 現況 |
|---|---|
| `voice/src/listen.ts:120` | 每個 frame `barge.observe(guild, speechRunMs)`,不看是誰 → 帶上說話者 account |
| `voice/src/barge.ts:47-55` `observe` | 任何人連續 `barge_in_ms` 就 `stop` → 只有 focus 的人 / 叫她名字 / ASR 實質內容才停,其他人先 duck;被打斷先 pause,不是在跟她說話就 resume |
| `voice/src/config.ts:38` | `barge_in_ms` |
| `voice/src/listen.ts` `#transcribe` | 回音排除:轉錄是 ASR 提示詞回音(「御坂10514號…」)或她自己的聲音就丟掉、不算有人講話 |
| `voice/src/sink.ts:168-178` | 唱歌(`VoiceFloor`)或 GPU 借出(`SpeechPause`)時直接回 `"interrupted"` 丟掉整輪 → 等 / 延後,或回報明確原因(`SpeakOutcome` 要加成員就照 §0 尾端追加) |
| `voice/src/sink.ts:146` `prepare` | TTS 預取:下一句在上一句播放時就先合成 |
| `apps/voice-node/src/playback/` | duck / pause / resume 的實作 |

**整合**:W1 負責「語音已生成未播放就照播、不重生成」(coordinator);W2 負責「播放中被誰、怎麼打斷」。兩邊的交界是 `voice_playback`(既有)+ `voice.barge_in`(新)。

### W3 Activity(ActivityManager、任務契約、閘門缺口)

**擁有**:新 `packages/activity/**`、`packages/stage/**`、`packages/game/**`、`packages/actions/**`、`packages/sdk/**`、`packages/ext-host/**`、`packages/voice/src/actions.ts`;`packages/world/src/engine.ts` 的 `her()`(`:475`)改成讀 `ActivitySnapshot` 的 hunk;`core/src/modules.ts` 加 `ActivityModule` 一行。

**提供**:`ActivityManagerKey`、topic `activity.*`、`agent.notice`(`Notice`)、場景 = `f(snapshot, override)`。

**消費**:`ArbiterKey.record()`(有就寫 Ledger,沒有就只發 topic)、`task.ts` 契約(遊戲 adapter 先用 `TaskEvent` 包現有的事件)。

**階段 0**:9、10、16、17。

| 要改的地方 | 現況 |
|---|---|
| `ext-host/src/extension.ts:500-516`、`sdk/src/game.ts:131-140` | extension 的 `game.<id>.observe` / `.act` 直接進 `ToolRegistry`,聊天回合全部拿得到(`agent/src/turn.ts:1339`)→ 不登記給聊天用,只透過 capability、過閘門(item 9) |
| `ext-host/src/extension.ts:74` `RESERVED_PREFIXES` | 加上 `activity`、`arbiter`、`affect`、`plan`(`V2_TOPIC_PREFIXES`),否則有 `events` 權限的 extension 可以偽造 v2 事件 |
| `actions/src/registry.ts:137` `abortable()` | 只停止等待,ticket 還在排程器裡照跑 → 工具逾時 / 回合取消時取消 ticket(item 10;W1 的 `turn.ts:1377` 已經把 signal 傳進工具) |
| `actions/src/tools.ts:88-98` | 高風險工具回 `REVIEW_PENDING` 後結果只寫 log → 結果變成 `Notice` |
| `actions/src/followup.ts:102` | 直接發 `agent_initiative`(W6 之後改 Impulse,見 §3) |
| `voice/src/actions.ts:225` | `goliveStart` 送出就回「Go Live started」→ `ensure_live` task,結果走 `activity.done/failed` |
| `voice/src/actions.ts`(`voice.join` / `voice.leave`) | join 不是 idempotent(已在語音時會換頻道);leave 不先收 broadcast |
| `stage/src/link/director.ts:62-89` | 她在做什麼的第一份副本(golive、obsStreaming、playing、game、singing…)→ 讀 `ActivitySnapshot` |
| `stage/src/link/director.ts:312`、`:393`(`#expect`)、`:357-368`(`#busy`) | `#expect` 在 `#busy` 保護外被寫,她自己切的被當成手動切換 → 場景切換 mutex(item 17) |
| `stage/src/obs.ts:463` `setScene` | 先改 OBS 的**全域**轉場 → 轉場每次切換帶入(item 17) |
| `stage/src/link/module.ts:246`、`:257` | OBS 跟著 Go Live 開關,沒過閘門 → broadcast 狀態機的子步驟 |
| `game/src/director.ts:384-386`(`#voices`、`#session`)、`game/src/chat.ts:164`、`game/src/module.ts:166`(`LiveState`,`game/src/live.ts:9`) | 其他副本 → 讀 `ActivitySnapshot` |
| `game/src/director.ts:810-821`、`:886-887` | `game.<id>.*` 事件進 `#onGameEvent`;`disconnected` 落到 `default` 只變成一句評論,session 不收尾 → `activity` 進 `failed(disconnected)`、場景切回(item 16) |
| `game/src/director.ts:850-856` | 用事件名稱 + `settle_secs` 猜目標完成 / 失敗 → `TaskEvent`(完整收斂是 W8) |

**狀態機注意**:`presence` 只有一份(她的語音帳號同時只能在一個語音頻道),但現有 capability 參數都以 guild 為單位(`voice/src/actions.ts` 的 `GuildArgs`);跨 guild 的 `ensure_voice` = 先離開再加入。

**實作紀錄(W3)**:

- **路由在閘門之後**:capability 多了 `activity(args, principal) → ActivityRequest[]`(`voice.join`、`voice.leave`、`stream.start`、`stream.stop`、`game.start`(`stream: true` 多一個 `ensure_live`)、`game.stop`、`stage.scene`(導演以外的人 → `scene_override`))。`activity` module 啟動時把 `ActivityService` 裝成 `ActuatorRegistry.setActivityRouter`:所以她的工具、指令、面板 API、mind、導演**全部**先過閘門,再交給 manager。`InvokeOptions.activity`:`wait`(預設;指令 / 面板 / mind 等結果,錯誤帶原本的 `cause`)、`detach`(`CapabilityTool` 用:立刻回「開始了(task XXXXXX)」)、`direct`(manager 自己的步驟)。沒有 `activity` module 時一切照舊直接執行。
- **步驟**:主步驟 = 原本的 capability(閘門已放行,`ExecContext.task` 有值);隱含步驟(OBS 跟著 Go Live、離開前關台、跨伺服器先離開)以原本的 principal(指令 / 面板)或 `director` 過閘門,`InvokeOptions.implied`:暫停、禁止、同意、權限、預算照常,中風險不重複算次數限制。
- **鎖**:每個 task 鎖它碰到的資源(固定順序 presence → broadcast → activity;`ensure_voice` / `leave_voice` / `ensure_live` 鎖 presence + broadcast)。反向的要求取代進行中的(`stop` 取消還在開的遊戲、`leave_voice` 取消 join、`stop_live` 取消開台)。被取消的 task 立刻結束(步驟忽略 signal 也一樣),之後才到的結果無害。
- **狀態從匯流排推出來**:`voice.joined/left/participants`、`voice.golive`、`stage.status`、`game.director.session`(現在多帶 `code` / `reason`)、`sing.cue`、`agent.turn.started/completed`,加上進行中的 task 的 phase。`activity.changed` 只在 snapshot 變了才發(`version` +1)。
- **說完再離開**:`leave_voice` 有 turn 時先等那個回合結束(`speech_wait_ms`),再把 `voice.leave` 排進她的語音 lane(`voice:<platform>:<guild>`,priority `idle`),排在那個回合所有句子後面。
- **遊戲**:`disconnected`(`[modules.game] end_events`)或 extension 掛掉(`system.module.state` 之後 adapter 工具不見了 / observe 時不見了)→ 導演結束 session(`code: disconnected | crashed`,不送 stop / quit)→ manager `failed(code)` 留 `failed_hold_ms`、notice 給開遊戲的人、場景切回。遊戲還在開時她設的 `game_goal` 等 session 開始才套用。導演的 `voiceContext`、`game.chat` 的投遞、`LiveState` 有 manager 時讀 snapshot。
- **場景**:`stage/src/link/scene-rule.ts` 的純函式 `sceneWants(factsOf(snapshot), memory, …)`;導演有 manager 時只吃 `activity.changed`(`onSnapshot`),並提供 `SceneRuleKey` 讓 `snapshot.scene` 是同一個答案。導演與結尾幕共用一把 mutex(`#expect` 只在鎖內寫);`stage.scene` capability 與節點的 `ObsController.setScene` 也各自序列化;轉場改用目標場景的轉場覆寫(`SetSceneSceneTransitionOverride`),不再改 OBS 全域轉場。「開台中但還沒真的 live」不算 live,失敗的開台不會「開場 → 結尾」亂切。
- **閘門缺口**:ext-host 把 `game_*` 工具登記在 `GatedToolsKey`(`@miyoria/actions`,由 `extensions` module 提供),不進 `ToolRegistry`;保留前綴加上 `activity`、`arbiter`、`affect`、`plan`、`gate`、`actions`;`Peer.request` 逾時 / 中止時送 `$/cancelRequest`,SDK 中止處理函式的 signal(`ToolCallContext.signal`、`GameAdapter.act(action, signal)`)。排程器的 ticket 在等待的工具逾時 / 回合取消時取消(排隊的不會跑,跑到一半的 signal 被中止)。中 / 高風險的結果(含被擋下的)寫成 `LedgerRecord`(有 `ArbiterKey` 就 `record`,沒有就發 `actions.outcome`);高風險 `REVIEW_PENDING` 的結果另外發 `agent.notice`。
- **對 types 的增補**:新檔 `scene-rule.ts`(`SceneRule`、`SceneRuleKey`);`HerStatus.singing?: string | null`(選填,舊的 producer 不用改)。world 的 `her()` 有 snapshot 時從它讀(`world/src/module.ts` 多傳一個 snapshot getter)。

### W4 Affect(驅力、情緒動態、一人一卡)

**擁有**:`packages/self/**`、`packages/social/**`;例外:可改 `mind/src/mind.ts:963-969`(mind 直接 `self.feel`)與 `mind/src/prompt.ts:145-149`(`OUTPUT_FORMAT` 的情緒 / 驅力範例值)這兩個 hunk,做 item 14 的「mind 不再寫情緒」部分。

**提供**:`AffectStateKey`(由 `self` module 提供,跟 `SelfStateKey` 並存;`SelfState` 先保留給舊消費者)、`PersonCard`、`relationshipLabel()` 的實際使用(`social/src/rel.ts:308` `label()` 改成呼叫它)、topic `affect.changed`。

**消費**:`HandleDirectoryKey`(卡片的 `handle`)、topic `affect.event`(Arbiter 的 `topic_ignored` 等)、既有 topic:`social.event`、`social.appraisal`、`sing.cue`(`ended` → `song_finished`)、`voice_playback`(`interrupted`)、`activity.done/failed`(`task_succeeded/failed`)。規則事件能從既有事件推導的就自己訂閱,不要求別人改。

**階段 0**:15(以及 14 的情緒部分)。

| 要改的地方 | 現況 |
|---|---|
| `self/src/emotions.ts:142` `stir` | 飽和加法、沒有遞減 → habituation(2 小時內同原因 ×0.5ⁿ)、互斥(壓下量 = 一半)、10 分鐘總量預算 |
| `self/src/emotions.ts:195` `feel`、`self/src/state.ts:96`、`:103` | 唯一寫入路徑改成 `appraise(AffectInput)`;`feel` 先保留但走同一套動態 |
| `self/src/rules.ts:139` `EmotionRules` | 規則事件表(§3.6) |
| `social/src/mood.ts:294-299` | `agent.emotion`(她的 `<emo>` 標籤)回推心情 → 刪掉(切斷閉迴路) |
| `social/src/mood.ts:314` `describe`、`agent/src/signals.ts:136` `moodHint` | 兩個心情 renderer → `AffectSnapshot.mood_line`(agent 那份由 W1 換) |
| `social/src/rel.ts:308` `label`(與 `social/src/engine.ts:828`、`:1047`、`:1081`、`social/src/commands.ts:282`、`:327`) | → `relationshipLabel()` |
| `social/src/engine.ts` familiarity | 一天 +1 → 依互動量與深度 |
| `self/src/heart.ts`、`self/src/feelings.ts` | romance / hearts / feelings → `PersonCard.attachment`、`emotions`、`feeling` |
| contributor:`social/src/mood.ts:499`、`social/src/module.ts:149`、`self/src/module.ts:224` | W1 的編譯器接手後刪掉(先別刪,W1 會忽略它們) |

**W4 實作紀錄**(2026-11-04):

- `self` 提供 `AffectStateKey`(`self/src/affect.ts`),跟 `SelfStateKey` 並存。情緒只有兩種輸入:規則事件表(`self/src/events.ts`,`applyEvent` / `applySocial`,來源有 `affect.event`、`social.event`、`sing.cue`、`voice.playback`、`activity.done|failed`、`game.*`、`llm.budget`)和評估(`appraise`:strength → 0.1 / 0.2 / 0.35 × gain,`social.appraisal` 先轉成評估)。動態在 `self/src/dynamics.ts`(遞減、互斥、10 分鐘預算)與 `emotions.ts`(`excite`、基準值、`hold`)。`feel` / `feelToward` 保留,走同一套動態。
- 寂寞:`SelfEngine` 的 pressure 直接是 social / attention 缺口的函式,以 `hold` 撐住,需求被滿足(`adjust`)就立刻鬆開;不再有第二個半衰期。
- 心情不存:`types/src/affect-mood.ts` 的 `deriveMood`(基準 + 時段 + 情緒 + 慾望)。`social` 的 `MoodState` 在有 `AffectStateKey` 時直接回傳推導值,`mood.nudge` / `social.relationship` / `agent.emotion` 都不再動它(沒有 `self` 時才用舊的衰減引擎)。
- **`<emo>` 回寫在 `social/src/mood.ts`**(`eventNudge` 的 `agent.emotion` 分支與 `emotionNudge`),已刪;`agent/src/turn.ts:1446` 只發 `agent.emotion` 給 Stage,沒有回寫,W1 不用改。
- 單一 renderer 在 `types/src/affect-mood.ts`:`moodLine`、`renderAffectMood(snapshot)`、`renderPersonLine` / `renderPeople`;`AffectState.renderMood?()` / `renderPeople?(people)` 是同一份的捷徑。W1 的編譯器用它們,`agent/src/signals.ts` 的 `moodHint` 與三套刻度由 W1 換掉。
- 一人一卡:卡片存在 `self:feeling:<person>`(`text` / `updated_at` / `by` 維持舊形狀,其餘在 `card` 底下),數字(好感 / 信任 / 熟悉度)仍由 social 寫、卡片讀 `Attitude`(`Attitude` 多了 optional 的 `owner` / `display_name` / `interactions` / `last_interaction`);attachment = 舊的 romance(`HeartBook`),不再由事件自己長,只有 `adjustBond`(`reflect` / `panel`)能動,每步 ≤ 0.03、每天 ≤ 0.06。好感 / 信任 / 熟悉度的 `BondChange` 經 `affect.bond` topic 給 social 套用。migration 在 `self/src/migrate.ts`,模組啟動時跑,冪等(每張卡 `migrated_at`),舊 key 一個都不刪。
- familiarity:`social/src/rel.ts` `familiarityChange` 依每句話的深度(`lineDepth`)× `familiarity_per_line`,往 100 慢下來;delta 紀錄每 0.5 點才寫一筆。
- mind:`mind/src/mind.ts` 不再套用 `reply.emotions` 與 `feelings[].emotions`(parser 照舊解析,只是忽略);`OUTPUT_FORMAT` 拿掉情緒欄位、drives 範例改成 0,並刪掉要求輸出 emotions 的那一條規則(`mind/src/prompt.ts`,比 brief 列的兩個 hunk 多這一行)。
- 已知落差:`[temperament]` 的 `baseline`(profile 套件的 schema)還沒有,程式內建的預設基準值是傲嬌 pride 0.12;`store/src/data.ts` 沒有新的 key(卡片用既有的 `self:feeling:` 前綴,`self:cards:migration` 是新的,wipe / export 要加)。

### W5 Memory / Learning(新鮮度、followup 到期、穩定 handle + migration)

**擁有**:`packages/memory/**`、`packages/store/**`(含 `packages/store/migrations/**`)、`packages/learning/**`;`core/src/boot.ts:187-203` 追加 `HandleDirectoryKey` 的 provide;例外:`mind/src/snapshot.ts:285`(people 的 `u${n}` ref)與 `mind/src/mind.ts` 對應的 ref 解析(`:923`、`:1051`、`:1161`)這幾個 hunk。

**提供**:`HandleDirectory` 實作(store 一張表或 `ProfileDataStore` key,開機時 provide);`DecisionLog` 上 W1 需要的 outcome 寫入方法(新增 optional 方法,W1 用 `?.` 呼叫);migration。

**消費**:`ephemeralHandlesIn()`(寫入 lessons / recap / knowledge / 記憶前驗證)。

**階段 0**:6、13;以及 item 3 的「style lesson 不再轉成 `talk` 偏移」(在 learning 裡)。

| 要改的地方 | 現況 |
|---|---|
| `learning/src/conversation.ts:288` | fold 每次重編 `u1, u2…` → handle |
| `learning/src/reflect.ts:350`(與 `:356` 的 `p${n}`) | reflect 每次重編 → handle;place 代號也不能寫進持久資料 |
| `learning/src/drafts.ts:98-111`、`learning/src/conversation.ts:407`、`learning/src/reflect.ts:533` | 把模型輸出的 ref 解析回人;改成用 handle 解析 |
| `learning/src/reflect.ts:111` | prompt 範例 `"person": "u1 或 null"` |
| `mind/src/snapshot.ts:285` | mind 快照的 `u${people.length + 1}`(例外 hunk) |
| `learning/src/lessons.ts:28-29`、`:81` `talkShift` | lesson 的 `talk` 偏移;style 類 lesson 不再轉 `talk` |
| `memory/src/config.ts:97` `min_score` 0.05 → 0.25;`:12` `recency`、`:100` `recency_tau_days` 14 | §3.9 新鮮度;episode 改小時~天的衰減 |
| `memory/src/engine.ts:455-465` | 在場的人的記憶不需要文字相關就入選 → 要文字相關 |
| `store/src/sqlite.ts:970-977`、`store/src/postgres.ts:1022` `dueFollowups` | 沒有年齡上限、`ORDER BY due ASC` 先挑最舊 → 到期幾小時後自動關、先挑最新 |
| 記憶寫入(`memory/src/extract.ts`) | 現在式的狀態 / 承諾筆記(「已經開台」)設到期 |
| learning 的 conversation 狀態 | 「已淡出的話題」不放進 prompt(prompt 端由 W1 不 render,資料端由 W5 不產生) |

**Migration**:一次性修掉已污染的 lessons、recap、議程(`self:state` 裡的 agenda 文字;那個 key 屬於 W4 的 self module,migration 只改文字欄位、不改形狀,PR 裡要寫明)。無法確定是誰的 `u7` 一律刪掉該句,不要猜。

**實作紀錄(W5)**:

- `HandleDirectory`:`StoredHandleDirectory`(`store/src/handles.ts`),一人(帳號)一列存在節點層級的 settings(`_global` 的 `handle:<platform>:<id>`,資料分類 `people`);`boot.ts` 開機時載入並 provide,`recorder` 第一次看到帳號時就定下 handle。`ofAccount()` 多一個可選的 `person` 參數(`types/src/handle.ts`)。同名只有第二個人加 `#2`,大小寫不同也算同名。
- 不再寫入臨時代號:conversation fold、reflect、mind 快照(`u${n}` → handle,`personByRef` 另外容許同一份快照裡的舊 `u<N>`,只在解析時用,不會存);fold 的 recap / notes、reflect 的 summary / insight / feeling / lesson / goal、記憶的 episode / fact / note / followup、知識文件的 draft 寫入前都過 `repairHandleText`(`types/src/handle-text.ts`):同一段文字裡有定義(`u1=御坂`、`御坂(u1)`)就換成名字,lesson 只剩一個代號時用 `person` 的 handle,其餘整句刪掉;什麼都不剩就拒絕寫入。地點(`p1`)改成直接用 context 字串。
- Migration:`repairEphemeralHandles`(`learning/src/repair.ts`)修 lessons、對話 recap / notes、`self:state` 的 `agenda[].text / why`(只改文字,不改形狀;議程的 `person` 欄位不可信,所以不拿它來猜代號,剩下的代號換成「某人」)。冪等。`ModuleCatalog.migrateStoredData` 在 `boot.ts` 載入 handle 之後、任何 module 啟動之前呼叫(module 啟動後會把舊文字存回去)。
- 新鮮度:`min_score` 0.25;記憶要有共同的字或 `min_vector`(0.3)以上的 embedding 才算相關(在場的人也一樣);episode 用 `episode_recency_tau_days`(1.5);現在式的 fact / self_note 用 summarizer 給的 `valid_hours` 或字面判斷(已經開台、正在…)設到期,存在 `due`(**非 followup 的 `due` 是失效時間**,recall 跳過,maintenance 刪除過期一週以上的);followup 到期 `followup_max_age_hours`(6)後自動關閉、先挑最新、查詢帶年齡上限;最近 `repeat.window` 個回想裡同一個梗超過 `allowed` 次就降權。
- 對話筆記:改寫不會更新年齡(`touchUnits` 依同一欄位 / 清單的相似度繼承舊時間),所以過期過濾真的生效;`drop_thread_mins`(240)沒人碰的就由 fold 直接刪。**這份程式裡找不到把「已淡出的話題」放進回合 prompt 的地方**(`render` 本來就不放過期的);fold 輸入裡「超過 N 分鐘沒人提的部分」仍保留,它是整理用的,不是回合 prompt。
- Style lesson:只有內容本身在講話多話少(`isTalkLesson`)的 lesson 才會有 `talk` 偏移;`panel` 來源的照設定。
- 回合結果:`DecisionLog.appendOutcome?` / `recentOutcomes?`(表 `turn_outcomes`,migration 0005,sqlite + postgres),`recorder` 訂閱 `agent.turn.outcome`。

### W6 Arbiter(第二波;§3.3)

**擁有**:新 `packages/arbiter/**`;刪除 `packages/initiative/**`;下面列的發 initiative 的 hunk;`core/src/modules.ts` 換掉 `InitiativeModule`(`:126`)。

**提供**:`ArbiterKey`、topic `arbiter.*`、`affect.event` 的 `topic_ignored`。

| 要改的地方 | 現況 |
|---|---|
| `sing/src/singer.ts:884`、`game/src/director.ts:1034`、`actions/src/followup.ts:102`、`initiative/src/engine.ts:51` | 直接發 `agent_initiative` → `Impulse`(source `song` / `game` / `followup` / `world`) |
| `mind/src/mind.ts:381-383` | `initiative:*` 回合(報幕)被算成她主動開的話題 → `isSelfInitiated(source)`(item 12) |
| `agent/src/coordinator.ts:302-345`、`agent/src/runtime.ts:392` `startBlocked` | agent 裡的第二、三道關卡 → 併進 Arbiter(跟 W1 約好再刪) |
| `initiative/src/config.ts:58`、`:64`、`mind/src/config.ts:51-52` | 兩套安靜時段 → 一份 |
| `world/src/engine.ts:435`(`channel_quiet`)、`mind/src/mind.ts` `voice_quiet`(`:569-595`)、initiative 的 idle 偵測 | 三個冷場偵測器 → 一個 |
| `agent/src/attention.ts` 的乘數、`agent/src/turn.ts:619` `#decide` | 只留便宜前置過濾;灰色區才問 fast |

Arbiter 接受 `speak` impulse 後,開回合仍走既有的 `agent_initiative` 事件 / `IntentSinkKey`(不另開新路徑);接受 `act` impulse 後呼叫 capability(活動類走 `ActivityManagerKey.request`)。

**W6 實作紀錄**:

- `packages/arbiter`(module `arbiter`,`ArbiterKey`):`ArbiterCore`(`arbiter.ts`)只做三件事。底線依序是暫停、預算(exhausted 全擋;degraded 只擋 `plan` / `agenda` / `world`)、同意(`target.account` 被 social 封鎖)、`disabled_contexts`、頻道等級(`off` / `mention-only`)、語音不在場;`plan` / `agenda` 再加安靜時段,而她自己的 `speak`(`isSelfTalk`,即 `chat.start` / `chat.dm`)另有每日 / 每地 / 每人上限、任兩次間隔、同一地方的間隔(沒人接就加倍,`max_backoff`)、等級的間隔(`ConversationFacts.start_gap_ms`)與「剛講完話」。**她看得到的規則一律 `rejected` + `retry_at`**(她帶著帳本重新計畫);只有當下的事實(地方忙、`world` 打招呼時她剛講完)才 `deferred`,每 `retry_ms` 依優先度重試到過期。同 `coalesce_key` 合併(新的贏);某個 impulse 拿到地方後,排在那裡的她自己的願望 `preempted`;有人叫她(`agent.turn.focus` reason `addressed` / `reply_to_her`)也一樣。
- 帳本(`ledger.ts`):每個不是「go」的決定都寫一筆 `denied`(`detail` = `<reason>: <她看得懂的說明>`)並發 `arbiter.decision` / `arbiter.ledger`;`LedgerView.limits.next_initiative_at` 用同一套時間規則反覆推算(`ledger(context)` 含那個地方的間隔與等級間隔)。她開的話題:`agent.turn.completed` 記下她說的話,之後在 `reply_window_*` 內有人叫她 / 回她(別人的 `agent.turn.outcome` reason `addressed` / `reply_to_her`,或提及 / 回覆 / 私訊)就 `ok`,否則 `ignored` → streak +1、該地方間隔加倍、發 `affect.event` `topic_ignored`。沒開口(silence / cancelled / error)不算話題。狀態存在 `_global` 的 `arbiter:state`(資料分類沿用 `initiative`)。
- 給 agent 的接縫是新的 `types/src/impulse.ts`:`newImpulse()`(speak 的舊 initiative reason 放 `args.reason`,`impulseReason()` 讀回)、`isSelfTalk()`、`ImpulseHost` + `ImpulseHostKey`(agent 提供:`facts(context)` 給底線用,`open(impulse)` 開回合)。Arbiter 接受後,她自己的(`plan` / `agenda`,含 act)與 `chat.*` 走 `AgentIntents` 原本的路徑(閘門 → coordinator 等地方空出來);其他 speak 是 coordinator 的 initiative 回合,coordinator 只回答「現在忙不忙」(`ImpulseRun` busy → Arbiter 稍後再試)。不是她的 `act` impulse 由 Arbiter 經 `ActuatorRegistry` 執行(`game` 用 `director` principal)。
- agent:`agent.initiative` 與 notice 在有 Arbiter 時都轉成 impulse(`initiativeSource()`);`arbiter.impulse` 在沒有 Arbiter 時由 agent 當舊的 initiative 處理(fallback)。`startBlocked` 有 Arbiter 時讀 `ledger(context).limits.next_initiative_at`,`noteStart` 不再記(Arbiter 自己記),Arbiter 放行的意圖帶 `IntentTurn.gated`,不會被自己剛記的那次擋住。`chat.start` 的閘門次數(每日 24、每人 4、1 分鐘)搬進 Arbiter 的 `max_per_day` / `max_per_person_per_day` / `min_gap_secs`,閘門只留防迴圈的上限(200 / 50 / 0);`chat.dm` 的閘門限制沒動(私訊的安全線)。
- 來源:唱歌報幕(`song`,開始 / 準備的那句 6 秒內不說就算了)、遊戲實況(`game`,同一地方合併)、動作結果(`followup`,reason `action_result`)都發 `arbiter.impulse`;歌好了要不要唱(`#remind`)仍交給她的心智迴圈。mind 只把 `intent:` 回合算成她開的話題(item 12)。
- initiative 刪除:打招呼、進語音問候、追問變成 Arbiter 的 producer(`producers.ts`,source `world` / `followup`;追問只有被接受或延後才 `markDone`);上限與安靜時段併進 `[modules.arbiter]`;舊的 `[modules.initiative]` 段照樣能讀,搬過來的 key 會帶進來並警告(`INITIATIVE_KEYS`,`core/src/modules.ts` 傳 `legacyInitiative`)。冷場:world 的 `channel_quiet` 現在也涵蓋她所在的語音頻道。
- attention:只剩前置過濾(模式、被叫到、名字、她剛講完的問句、一對一、語音裡有人還在講就不插嘴)+ 她的 talkativeness(含 lesson、`AffectSnapshot.biases`、下限;activeness 只把預設移 −0.25 / +0.17,數學上等於舊的 ×0.5 / ×1.6)× 分數、佔比上限、灰色區 `fast`。好感 / 精力 / activeness 倍率、語音 `ambient_factor` / `interrupt_scale`、灰色區門檻隨 talkativeness 縮放、三種冷卻與等級冷卻都刪了;`attention.cooldown_ms`、`min_cooldown_ms`、`voice.ambient_factor`、`cooldown_ms`、`min_cooldown_ms`、`interrupt_scale` 留著也能讀,啟動時警告(`deprecatedAgentKeys`)。
- 回放測試(`arbiter/test/replay.test.ts`):30 小時的腳本(有人聊天、忙碌、唱歌、遊戲實況、約 4 成有人接),她的 Plan 看帳本才開口時被擋率 0%(三個 seed,< 20% 的驗收),每個擋下都有 reason 與帳本紀錄;盲著規劃(舊 mind)被擋 > 80%。
- 沒做 / 留給別人:她的 Plan 直接 `ArbiterKey.submit(impulse)`(W7 已接上);W7 的 mind 還留著自己的語音冷場偵測(當 Plan 的喚醒;world 的 `channel_quiet` 分數 0.3 低於 mind 的 `SALIENT_MIN_SCORE` 0.5,所以沒有直接拿掉);收到訊息的回合(source `message`)不經過 Arbiter(回話仍是 agent 自己的回合機制,Arbiter 從 focus / outcome 得知「有人在跟她說話」)。

### W7 Mind → Appraise / Plan / Reflect + Goal agenda(第二波;§3.4、§3.7)

**擁有**:`packages/mind/**`(W4、W5 的例外 hunk 合併之後)。

**提供**:`GoalAgendaKey`、topic `plan.goal`、Appraise 的 `AffectInput`(呼叫 `AffectState.appraise`)、Plan 的 `Impulse`(source `plan` / `agenda`)。

| 要改的地方 | 現況 |
|---|---|
| `mind/src/mind.ts:657` | `agendaDue` 把 `due === null` 當到期,心跳被釘在 3 分鐘(`mind/src/pace.ts:38`)→ `goalDue()`(item 11) |
| `mind/src/mind.ts:421-427` `GAME_EVENT` | 任何 `game.<x>.*`(含 `disconnected`)都當成遊戲在跑 → 讀 `ActivitySnapshot` |
| `mind/src/prompt.ts:263` | 「乾脆離開去休息」催促(item 14) |
| `mind/src/prompt.ts` system | 整份聊天人設 + god prompt → 三個專用短 system(reasoning:`appraise` / `plan` / `plan_daily` / `reflect`) |
| 快照 | 加上 `LedgerView.limits`(她看得到 backoff 與限制) |

**W7 實作紀錄**(2026-11-04):

- 三個小呼叫,各自一份短 system(`characterCore()`:角色核心 3–5 句,`types/src/persona-core.ts`,從 `PersonaHandle.corePrompt()` 取;任務規則;輸出格式的範例值全是 0 / 空值),不再有聊天人設、`<silence/>`、`<emo>`。`core/src/modules.ts` 給 mind 與 reflect 的 persona 改成 `corePrompt()`(兩行)。推理等級用 `reasoning_purpose`:`appraise` / `plan` / `plan_daily` / `reflect`;模型鏈仍是 `[modules.mind] purpose`(`mind`)與 reflect 的 `purpose`。
- **Appraise**(`mind/src/appraise.ts`):`Segments` 依 context 收集訊息、語音、她自己的話;她有參與(她說話或被叫)的段落安靜 `appraise_quiet_secs` 後(或活動提早結束這類重要事件後)批次送一次;輸出 ≤3 個 `AppraisalEvent` → `AffectState.appraise({source: "appraise", …})`(`toward` 只接受已知的 handle),感覺小改 → `adjustBond(person, {feeling, affinity ±1}, "appraise")`。沒有 `AffectStateKey` 就不跑。她的回合結束不再喚醒 Plan。
- **Plan**(`mind/src/mind.ts`、`prompt.ts`、`reply.ts`):喚醒 = 目標觸發(程式檢查,`TriggerWatch`)、活動結束(`activity.changed` / `done` / `failed`)、在意的人上線(`world.salient` + `cared_attachment`)、心情掉 `mood_drop`(`affect.changed`)、salient、suggestion、語音冷場、心跳。心跳 `heartbeat_mins`(15)依無聊 / 需求缺口加快到 `min_heartbeat_mins`(4),空轉一次 ×1.5(最多 4 次、上限 `max_heartbeat_mins`),Arbiter 的安靜時段 ×3;只有心跳、而且狀況指紋(想做的事前三名、目標、在意的人在不在、在做什麼)跟上次 Plan 一樣時**不呼叫模型**。輸入:world 摘要、`AffectSnapshot`(mood_line、最強情緒、需求)、目標、Ledger(含 limits,system 裡只有數字與時間,原因在 data)、排好的 `Desire[]`(`desire.ts`)。輸出:目標 add / edit / done / drop、0–2 個 `Impulse`(source:為了剛觸發的目標是 `agenda`,其他 `plan`)、`day_plan`。
- **Arbiter**:有 `ArbiterKey` 就 `submit(impulse)`,`ArbiterDecision` 換成日誌的 intent 狀態(`outcomeOf`);沒有就把同一件事換成 `Intent` 走 `IntentSinkKey`,並套用 mind 自己的底線(自我發起 backoff、沒人接的話題、頻道等級、失敗暫停),這些也以 `PlanLimits`(`source: "mind"`)給她看。W6 合併後:mind 不用改,`ArbiterKey` 一出現就走 Arbiter;mind 的 `SelfStarts` 只剩 `MindKey.unanswered` 的紀錄。
- **目標**(`mind/src/goals.ts`,`GoalBook` = `GoalAgendaKey`):一目標一列 `mind:goal:<id>`,文字一律過 `repairHandleText`,一定有 `expires`(`goal_max_days` 內),過期在 sweep 時自動 dropped;`whenever` 永遠不是 due。舊的 `SelfState.agenda()` 開著的項目在模組啟動時轉成 `whenever` 目標(預設 `goal_default_days`),轉過的 id 記在 `mind:plan:migration`,冪等;舊議程本身沒動(`self:state` 是 W4 的)。目標的 impulse 被接受、目標沒有 steps 就標成 done。followup suggestion 變成 `when_online` 目標。topic `plan.goal`。
- **日計畫**:每天 `daily_hour` 之後第一次 Plan 是 `plan_daily`;資料多了在意的人通常幾點出現(`presence.ts`:從訊息紀錄 `MessageLogKey` 每天種一次 + 即時的訊息 / 語音 / 上線事件,每人每天第一次出現的時間,留 14 天)、昨天做了什麼(日誌的 intents、ActivityManager 的 tasks、昨天的計畫)、大家的反應(`ReflectionKey.feedback(1)`)。`mind:plan:state` 存 `last_daily`、今天 / 昨天的計畫、presence 統計。
- 刪掉:mind 寫情緒 / 驅力 / 多話程度 / 主動程度 / 好感提示 / documents 的路徑(感覺改由 Appraise、文件與人物卡由 Reflect)、「乾脆離開去休息」催促與 idle 計數、mind 的夜間規則(`quiet_start_hour` / `quiet_end_hour` 留著但不用)、`game.*` 當成遊戲在跑(改讀 `ActivityManagerKey` / `activity.changed`,沒有時用 world 的 `her.game`)、prompt 裡的 `u1` / `p1`(人 = handle,地點 = context 字串,目標 = `G` + 5 碼)。
- **Reflect**(`learning/src/reflect.ts`):短 system + `reasoning_purpose: "reflect"`;輸出多了 `bonds`(人物卡整理)→ `adjustBond(..., "reflect")`,attachment ±0.03、affinity / trust ±2、感覺過 `repairHandleText`,每人每天一次(`reflect:state` 的 `bonds_day` / `bonds_people`)、一次最多 `max_bonds`;長期目標寫進 `GoalAgendaKey`(`whenever`,source `reflect`)。沒有 `AffectStateKey` / `GoalAgendaKey` 時照舊寫 `SelfState`。互動門檻:自上次反思後累積 `light_after_total_lines`(300)句,安靜時做一次不限 context 的 light 反思。
- 面板 / API:`MindKey` 形狀不變(Appraise 與 Plan 都記成 `Thought`;Appraise 的 trigger 是 `turn`,Plan 的目標觸發 / 活動結束 / 心情是 `salient`,detail 有前綴)。目標還沒有 API 路由:**`packages/api` 需要加 `GET /api/mind/goals`(`GoalAgendaKey.goals()` / `GoalBook.all()`)與日計畫**。`store/src/data.ts` 的 `inner` 多了 `mind_goals`(`mind:goal:`、`mind:plan:`)。

### W8 遊戲 / extension 任務契約(第二波;§3.8)

**擁有**:`packages/sdk/**`、`packages/ext-host/**`、`packages/game/**`、`extensions/**`(W3 合併之後)。SDK 不依賴 `@miyoria/types`,`task.ts` 的形狀要在 `sdk/src` 帶一份相同的副本(JSON 形狀一致,有測試對照)。Extension 的 task 事件發在 `game.<id>.task.<type>`(`taskTopic("game.<id>", …)`,在 game adapter 自己的命名空間內);ext-host 的 proxy 實作 `TaskExecutor`,`cancel` 與 `AbortSignal` 要一路傳到 RPC。

**實作紀錄(W8)**:

- **SDK**(`sdk/src/task.ts`):`task.ts` 的副本(`TASK_FAILURE_CODES`、`TaskSpec`、`TaskEvent`、`StructuredState`、`TaskExecutor`、`taskTopic`),加上 `TaskRunner`:擴充只寫 `TaskWorker { observe, run(spec, task), resource? }`;`run` 回傳 = `done`、丟 `TaskFailure(code, detail)` = `failed`、其他例外 = `internal`;預算(`timeout`)、`cancel`(`cancelled`)、同一資源上的新任務(`superseded`)、`close`(`disconnected`)都由它處理,`task.signal` 帶著 `TaskFailure` 中止,一個 id 只有一個終止事件,之後的結果無害。`ctx.tasks.register(executor, info)` 註冊(contribution `executor` / request `tasks.register`),主機請求 `task.start|cancel|observe`,事件用 notification `task.event` 送回。`registerAdapter` 註冊 adapter 的 `tasks`,沒有的就把 `act` 包成一步的任務(`ActionResult.code`);**不再登記原始的 `game.<id>.observe|act` 工具**。對照測試在 `ext-host/test/tasks.test.ts`。
- **ext-host**(`ext-host/src/tasks.ts`):每個註冊了執行器的擴充一個 `ProxyExecutor`(`RegisteredTaskExecutor`,`info` 有 owner、名稱、目標與建議預算、guide),放在 `extensions` module 提供的 `TaskExecutorsKey`(新檔 `types/src/task-executors.ts`,`index.ts` 尾端追加)。owner:game adapter = `game.<id>`,其他 = `ext.<id>`。事件驗證(`parseTaskEvent`)後發佈 `<owner>.task.<type>`;已結束 id 的事件丟掉;接受後 `budget_s + task_grace_ms`(新 key,預設 5 s)沒結束 → 主機自己發 `failed/timeout` 並送 `task.cancel`;行程掛掉 → `crashed`,主機停止 → `disconnected`。`start` 的 `AbortSignal` 會送 `$/cancelRequest` 並取消任務。
- **遊戲導演**(`game/src/director.ts`):LLM 只選目標與講評論;每個目標用 `game.act`(過閘門,principal `director`)以導演選的 task id + 預算(目標建議的 `budget_s`,否則 `task_budget_secs`,上限 `max_goal_secs`)開始,`wait: false` 只等「接受」;結束只看 `game.<id>.task.done|failed`(id 不對的忽略)。拿掉了 `reached_events`、`failed_events`、`settle_secs`、`launch_poll_secs`、`splitObservation` 與「失敗」前綴判斷;`judge` 用「目標的任務還在跑嗎」取代 `busy` + settle。失敗碼:`disconnected` / `crashed` → session 結束;`cancelled` / `superseded` / `busy`(反射打斷)→ 不算失敗;`died` 交給 `death`;其他 → 失敗防呆 + 次數。要求的目標(指令 / 觀眾)的一步做完不算目標完成,由模型說 done。每個結束的目標發 `game.director.goal`(`GoalEnd`,`code`:`done` / `reported` / `gave_up` / 失敗碼)。換目標、指令改目標、停止、模組停止都會 `cancel` 目前的任務。`game.act` 預設等任務結束(遊戲內聊天用),回傳 `GameTaskError{code}`;ActivityManager 的 `failureCode` 先讀錯誤的 `code`(`activity/src/port.ts` 一個小 hunk)。
- **開遊戲**:`game.start` 把 `ExecContext.task`(manager 的 task id)傳給 `GameControl.start` → `preflight` → `launch` 任務(預算 `launch_wait_secs`)等它的終止事件,不再每 2 秒 observe 輪詢;manager 對 `game.director.session` 的確認仍保留(session 是同步發出的,只是確認)。取消 `game.start`(停止 / 取代)會取消 launch 任務。
- **逾時**(`game/src/timeouts.ts`,module 啟動時檢查順序並警告):模組請求 10 s < 控制呼叫 `tool_timeout_secs` 20 s < 主機 RPC `call_timeout_ms` 30 s < 任務預算 < 預算 + `task_grace_ms` < `max_goal_secs` 600 s;`launch_wait_secs` 240 s < `game_timeout_ms` 300 s。反射等待在任務裡由預算限制,不再是獨立的 10 s。
- **非目標的活動**:`[modules.game] directed_games`(預設 `["minecraft"]`):導演拒絕其他遊戲(Threads 維持關閉,README 已註明;之後接回改成 `browse` 活動)。
- **Minecraft adapter**:`adapter.tasks`(`TaskRunner`)是唯一入口;`obtain` 是取得物品的唯一目標,三條舊路變成策略 `plan`(規劃器認得時)、`altoclef`(裝了 AltoClef)、`craft`(做一次),`strategy` 可強制;`get` / `craft` / `smelt` 只當隱藏別名。工作請求帶 `task` id;模組回報 `capabilities.tasks` 時完全照 `task_done` / `task_failed{code}`,舊模組才讀工作自己的事件(`goto` 的 `goal_reached`、`baritone_idle`、`craft_*`)。工作事件與 `plan_step/finished/failed` 不再轉送給導演。`launch` 任務等連上與世界載入。被取消 / 逾時的任務送 `stop`。
- **Mod**(Java):`game/TaskTracker.java`(純邏輯,JUnit `TaskTrackerTest`,在這裡以 javac + JUnit standalone 跑過);`BridgeRuntime` 的小 hunk:工作請求讀 `task`、`begin` / `stopped`、`emit` 經過 tracker(工作事件加上 `task` 欄位,之後送 `task_*`)、AltoClef 的 tick、`hello_ack.capabilities.tasks`。協定版本仍是 1(只加欄位與事件),`PROTOCOL.md` §5、§6.1。這裡的 Gradle 抓不到 fabric-loom(離線),整個 mod 沒有編譯過。
- **Stage 字幕**:`stage/src/link/forward.ts` 收 `agent.subtitle {turn, context, spoken, text}`,把字幕裡她先說出的(日文)那句換成寫好的(中文)句子並重送(已是 final 就送 final);比播放先到的先記著,播放時直接顯示中文。

### W9 整合(第三波)

**實作紀錄(W9)**:

- **工具依活動限定**(§3.4,`agent/src/tool-scope.ts`):聊天回合的工具每一步依 `ActivityManagerKey.snapshot()`(沒有就 world 的 `her`;都沒有 = 全給,舊行為)決定:`game_goal` / `game_stop` 只在遊戲 starting / running 時有,`sing_stop`、`stream_stop`、`voice_leave` 只在唱歌 / 直播 / 在語音時有;開始類工具一直都有。extension 的原始遊戲工具(`game_<id>_*` 且不是 `CapabilityTool`)不論狀態都不給(W3 在 ext-host 已擋,這裡是第二道)。沒提供的工具被呼叫就當成不存在。
- **`CLAIMS` 正則**(§1.8 #5,`agent/src/claims.ts`):「她說的事有沒有發生」改看結構化訊號:這個回合要求、被接受的 ActivityManager task(她的工具拿到的 `TransitionResult`,`tasks()` 依 `turn` 找)、這個回合告訴她的 `agent.notice`(依 task id)、這個回合成功的工具呼叫、snapshot(本來就在語音 / 在直播)。有任何一個撐住的說法不再被提醒或扣住。**保留的安全網**:只用短語清單判斷「她說了做了某事」——這是唯一沒有結構化訊號的部分;拿掉的話她可以跟人說「我游過去了」但什麼都沒發生(模型真的會這樣),所以留著,但它只負責發現說法,不決定事實。
- **刪掉的死碼**:`mood`(`social/src/mood.ts` 的 `MoodPrompt` 與 `describe`)、`social`(`SocialPrompt`、`Social.describePeople`)、`self` / `emotion`(`self/src/prompt.ts` 整個檔)四個 contributor;agent 的 `moodHint` 換成唯一的 `moodLine`。編譯器的 `SUPERSEDED` 留著擋 extension。只剩被解析的舊 key 一律刪掉並在啟動時警告(新的 `presentKeys`,`@miyoria/kernel`):`[modules.self] prompt`、`[modules.social] prompt_max_people`、`[modules.mind] quiet_start_hour` / `quiet_end_hour` / `voice_quiet_secs`。
- **一個冷場偵測器**:mind 收到 world 的 `channel_quiet` 時,她所在語音頻道的那種不看分數直接喚醒 Plan(沒有 Arbiter 時照 mind 自己的自我發起間隔);文字頻道的照舊低於門檻。mind 的語音 room、5 秒輪詢與 `voice_quiet_secs` 刪掉。
- **開遊戲**:`game.start` 的結果帶 `data.session {game, game_name, context}`(launch 任務 `done`、session 已開始才回);ActivityManager 直接拿它當事實,不再等 `game.director.session` 確認(事件之後到也只是再確認一次)。停止仍等 session 結束的事件(這次沒動)。
- **一份議程**:mind 啟動把 `SelfState.agenda()` 遷移成目標後,把遷移過的舊議程項目(含之前啟動就遷移過、還開著的)`dropAgenda`。agent 的 self 區塊與 reflect 本來就先讀 `GoalAgendaKey`,沒有 mind 時才退回舊議程。
- **回放測試**(`packages/replay`,§4):`ReplayRecorderModule`(`[modules.replay] record = false`,`<dir>/<日期>.jsonl`,core 在 recorder 後面多一行);`replay(log, {clock})` 用同一個 supervisor 跑真正的 agent、actions(閘門)、activity、world、self、arbiter、mind,假的只有 LLM(`ScriptedLlm`:回話照腳本、Plan 讀帳本限制「現在不行」就回 `{}`)、排程器 / 平台(`ReplaySink`,依序播放她的句子並發 `voice.playback`)與時間(呼叫端的 fake timers)。只重播她感知到的事件(`isReplayInput`;`arbiter.impulse` 只重播沒在跑的 module 發的,例如 sing)。報告:每回合結果、被叫有沒有回、focus 對不對(叫她的那則在 focus、focus 只有叫她的人、引用的是叫她的那則)、語音直接叫的開口率、Arbiter 的結果與擋下原因、她自己的衝動被擋率、沒人接的話題數、ActivityManager 殘留狀態。`pnpm replay <file> [--json] [--seed N]`(在 Vitest 裡跑,用它的 fake timers)。三個 fixture(`packages/replay/test/fixtures`):語音四個人一直「對 / 嗯」時被叫 8 次 → 開口 8/8、focus 8/8、沒有被輸入取消;「@Miyoria 你可以打osu嗎」等三個提問各被 5 句插話淹沒 → 3/3 回覆、3/3 引用提問的人;8 次報幕沒人接、她自己的 4 個話題 → 被擋 0/4、沒人接的話題 0。
- **需要 W10**:面板 / API 沒有任何 W9 的路由需求;注意 `self:state` 的舊議程遷移後會變成 dropped,面板的「議程」若還讀 `SelfState`,要改讀 `GoalAgendaKey`(目標)。回放報告目前只有 CLI,沒有 API。

## 3. 跨工作流整合

**誰發 Impulse(W6 之後)**:收到訊息(agent,source `message`)、Plan / 議程(W7,`plan` / `agenda`)、followup(memory 與 `actions/src/followup.ts`,`followup`)、activity 結果(W3,`notice`)、遊戲評論(game director,`game`)、唱歌報幕(sing,`song`)、上線打招呼(world,`world`)。只有 `plan` / `agenda` 算她主動。W6 之前大家照舊發 `agent_initiative`;W6 逐一改掉上面 §2 W6 表裡的發送點。

**W1 怎麼 render 黑板**:每回合從服務直接讀(不要經過 contributor):`AffectState.snapshot()` → `self.mood`(`mood_line` + `top`);`ActivityManager.snapshot()` → `self.activity`;`Arbiter.ledger(context)` → `self.ledger`(含 `limits`,例如「今天主動 5 次,最近 3 次沒人接,下次 21:40 之後」);`GoalAgenda.goals()` → `self.goals`;未讀的 `Notice` → `self.notices`。這些都進**可信的 system 區塊**;人物卡的感覺文字、記憶、遊戲聊天進 data 區塊。服務不在時用 §2 W1 列的 fallback。

**語音 barge-in 怎麼知道這回合的 focus**:agent 在回合狀態改變時更新 `TurnFocusView`(並發 `agent.turn.focus`);voice 在 VAD / ASR 熱路徑上同步呼叫 `ctx.services.get(TurnFocusViewKey)?.current(voiceContext)`,比對說話者是否在 `addressed_accounts`;ASR 結果用 `isShortReply()` 判斷是不是實質內容。voice 不需要訂閱任何 agent 事件。

**取消的規則只有一份**:`inputDisposition()`(`turn.ts`)。W1 的 coordinator 用它決定 merge / restart / background;要調整規則就改那個函式和它的測試,不要在 coordinator 裡另外加條件。

**Notice 的路徑**:W3 發 `agent.notice`(帶 `turn`、`context`)→ W1 在下一個回合的 `self.notices` 顯示;如果問的那個回合已經結束、她也沒在講話,W6 之前 W1 自己用既有 initiative 路徑(reason `notice`)開一個短回合,W6 之後改成 `Impulse{source: "notice"}`。

**工具與 Activity**:聊天回合的工具清單 = 一般工具 + 依 `ActivitySnapshot.activity` 加上的 capability 工具(例如在 `game(minecraft)` 時才有遊戲的「目標」工具);extension 的原始工具永遠不進聊天(W3 在 ext-host 擋)。`game.start` 之類的工具立刻回 `TransitionResult`(「開始了,task 7」),不等 240 秒。

**情緒的輸入**:只有 `AffectState.appraise()`(Appraise / Reflect,W7 之前由 social appraisal 轉送)與 `affect.event` 規則事件。mind 不寫情緒(W4 的例外 hunk);`<emo>` 不回寫(W4)。Plan 讀 `AffectSnapshot.biases` 與 W7 算的 `Desire[]`。

**Handle**:寫入持久資料前一律 `ephemeralHandlesIn(text).length === 0`;prompt 裡給模型的人一律用 handle(同一個人每次一樣),模型回來的 `person` 用 `HandleDirectory.resolve()` 解析。`GoalTrigger.when_online.person`、`ImpulseTarget.person`、`AppraisalEvent.toward`、`TurnFocus.addressed_by` 都是 handle。

**推理等級**:W1 在 llm 加 `[llm.reasoning]` 與 request 層級的 reasoning purpose;其他模組的呼叫(memory 整理 = `summarizer`、social appraisal → 之後的 `appraise`、高風險審核 = `review`、mind → `plan`)在各自工作流改成帶 purpose。舊的 router purpose(`chat`、`fast`、`mind`、`review`、`summarizer`,`[llm.purposes]`)是**模型鏈**,跟 reasoning purpose 是兩件事。

**建議的合併順序**:types(本 commit)→ 第一波 W1–W5 任意順序(都有 fallback)→ W6 → W7 → W8。第一波合併後跑一次全部測試,再開第二波的 worktree。
