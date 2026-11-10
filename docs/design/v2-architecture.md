# 架構檢討與 v2 方案(草案)

> 狀態:**階段 0–5 已實作,階段 6 已實作任務契約**(2026-11-06;Minecraft 換方法仍待討論,見 §7)。實作分工、各工作流的實作紀錄與偏差見 [v2-implementation.md](v2-implementation.md)。原本的 review 與方案保留如下。前半是現況 review(程式碼 + 本機資料庫實際紀錄),後半是重整方案與分階段計畫。參考了 [AIRI](https://airi.moeru.ai/docs/en/)、Generative Agents(記憶流 / 反思 / 計畫)、Mindcraft / Voyager(Minecraft 代理)的做法。現有設計見 [autonomy.md](autonomy.md)、[ARCHITECTURE.md](../ARCHITECTURE.md)。

## 0. 一句話結論

功能幾乎都有了,問題在**中間層沒有主人**:沒有一個地方擁有「她現在在做什麼」、沒有一個地方決定「現在要不要說話 / 做事」、沒有一個地方負責「她對某人的感覺」。每加一個功能就自帶一套偵測器、計數器、門檻和 prompt 段落,彼此不知道對方存在,所以互相打架、互相否決。這不是調參數能解決的,要把中間層收斂成少數幾個**單一擁有者**。

底層(kernel、store、llm、speech、voice-node、discord、OBS/VTS driver、sandbox)大致可以留著,**不建議整個重寫**。

## 1. Review:實際發生了什麼

### 1.1 實測數字(本機資料庫,唯讀查詢)

| 項目 | 數值 | 意義 |
|---|---|---|
| 11-03 一天的 LLM 呼叫 | 3,019 次、prompt 1,390 萬 token | 大部分花在背景整理與心智迴圈 |
| 心智迴圈 16 小時內 | 212 次,平均 ~8.9k token、~11 秒 | 心跳被 bug 釘在 3 分鐘(見 §1.6 #4) |
| 其中沒產生任何意圖 | 146 次(69%) | 大多是空轉 |
| 她自己想開的 `chat.start` | 38 次 → 35 次被下游擋掉,3 次成功 | 她規劃時看不到會擋她的規則 |
| 情緒同時值 | pride 0.96、lonely 0.94、sorrow 0.90、joy 0.89、frustration 0.82 | 情緒飽和、互相不抑制,失去意義 |
| social 慾望 vs lonely | 0.00004 vs 0.94 | 兩個系統對「寂不寂寞」結論相反 |
| 你(owner)的好感 39.87 | 同時被標成「朋友」與「普通」 | 同一個數字有三套刻度 |
| 互動 604 次的人 | 仍標「陌生人」 | familiarity 一天只 +1 |

### 1.2 誰在決定「要不要說話 / 做事」:至少九個

1. Attention:約 15 個數字相乘(模式上限、activeness、talkativeness、lesson 偏移、好感、精力、`interrupt_scale`、`ambient_factor`、三種冷卻、佔比上限、灰色區門檻)再擲骰,灰色區再問 `fast` 模型(`agent/src/turn.ts:619`、`:719`)
2. Coordinator 的忙碌 / 冷卻(`agent/src/coordinator.ts:302`)
3. `Agent.startBlocked` 的等級差(`agent/src/runtime.ts:392`)
4. Initiative 引擎:自己的閒置偵測、每日上限、安靜時段(`initiative/src/config.ts:35,58`)
5. Mind 心跳,加上 `voice_quiet` 偵測與 world 的「頻道安靜下來了」——**三個「冷場」偵測器**
6. Mind 的自我發起 backoff、過期話題、剛講過、夜間規則(**第二套安靜時段**,`mind/src/config.ts:51`)
7. Gate 對 `chat.start` 的次數限制(每日 24、每人 4、冷卻 1 分鐘)
8. 唱歌、遊戲導演、action followup **繞過 mind** 直接發 `agent.initiative`(`sing/src/singer.ts:884`、`game/src/director.ts:1034`、`actions/src/followup.ts:102`)
9. Talkativeness 方針 + lesson 偏移

它們會互相干擾。例:唱歌的報幕是 `initiative:*` 回合,mind 把它算成「她主動開的話題」(`mind/src/mind.ts:390`);每次報幕沒人接,backoff 就升高,於是 mind 真正想開的話題被擋(「連續 3 次沒人理,40 分鐘後再試」)。最新一次想法裡的「沒人回的話題」**全部都是報幕**。

### 1.3 誰在決定「她現在在做什麼」:沒有人

「在語音 / 直播中 / 在玩遊戲」至少有五份副本,各自從事件重建,沒有人校正:場景導演(`stage/src/link/director.ts:62-89`)、遊戲導演(`game/src/director.ts:384`)、遊戲聊天(`game/src/chat.ts:166`)、`LiveState`(`game/src/module.ts:166`)、world / mind,加上 VoiceLink 本身。`HerStatus` 只有 voice / live / scene / game,**沒有唱歌**(`types/src/world.ts:183`)。

直接造成的問題:

- **工具逾時後動作照樣發生**:工具逾時 10 秒(`turn.ts:1377`),`abortable()` 只停止等待,ticket 還在排程器裡、60 秒 TTL 內照跑(`actions/src/registry.ts:137`)。她說「失敗了」,然後事情發生了。
- **`game.start` 在回合裡不可能完成**:工具 10 s < lane TTL 60 s < launcher 180 s < `launch_wait_secs` 240 s。跑的時候還卡住 `act:game` lane,`game.stop` 也進不去。
- **兩個 `game.start` 可以同時跑**(面板直接呼叫 + 回合走 lane),`preflight` 沒序列化,第二個丟「已經在玩」,她回報失敗但遊戲其實開了。
- **場景切換互相穿插**:導演直接切、她的 `stage_scene` 走 lane,兩者可並行;`ObsController.setScene` 先改 OBS 的**全域**轉場(`stage/src/obs.ts:463`),A 的轉場會套到 B;`#expect` 是單一欄位又在 `#busy` 保護外被寫(`director.ts:312` vs `:393`),她自己切的會被誤判成手動切換。
- **遊戲斷線不收尾**:`disconnected` 只變成一句評論(`director.ts:880`),session 繼續、場景停在遊戲、prompt 還說她在玩;mind 又把任何 `game.<x>.*`(包含 `disconnected`)當成「遊戲在跑」(`mind/src/mind.ts:421-427`)。
- **Go Live 太早回報成功**:請求送出就回「已開始」(`voice/src/actions.ts:225`),之後的 `failed` 事件不會回到問她的那個回合。
- **`voice.join` 不是 idempotent**:已在語音時會換頻道;`voice.leave` 不會先關 Go Live / OBS。
- 「說完再離開」沒有順序保證(`act:voice:*` 與 `voice:*` 是不同 lane,autonomy.md §13.1 自己也記了)。

### 1.4 閘門不是唯一入口

- **遊戲工具繞過閘門**:extension 註冊的 `game_minecraft_act` / `game_threads_act` 沒有權限(`sdk/src/game.ts:136`、`ext-host/src/extension.ts:512`),聊天回合會提供**所有**註冊的工具(`turn.ts:1339`)。所以一般聊天回合可以直接 `launch` / `quit` / 遊戲內 `chat`,跳過閘門、自主暫停、次數限制與 `sanitizeGameChat`。這是正確性也是安全問題。
- OBS 跟著 Go Live 開關直播完全沒過閘門(`stage/src/link/module.ts:246,257`)。
- **她不知道自己做了什麼**:高風險工具回 `REVIEW_PENDING` 後在背景執行,結果只寫 log(`actions/src/tools.ts:88-98`);中風險的結果是一段字串;mind 的意圖結果寫進日誌。三種回報管道,沒有一個進到共用的狀態。

### 1.5 Prompt 與「思考」

**聊天回合的 prompt**:`system` 人設(~4k token)→ 歷史 → 一則 `user` 資料訊息(十幾個 contributor)→ **第二則 `system`**(情境、備註、規則,`agent/src/prompt.ts:489`)。

- **同一件事講好幾次、還互相矛盾**:心情由兩個函式、兩套門檻各寫一次(`agent/src/signals.ts` 的 `moodHint` 與 `social/src/mood.ts:314`),精力 0.4 時同時被告知「精神普通」和「有點累」;「在場的人」相關段落有**五個**;好感有三套刻度;1–3 句、`<emo:>`、`<silence/>` 的規則各重複三次以上。
- **她自己的狀態被標成不可信**:`GUARD_RULES`(`prompt.ts:39`)說資料區塊「來源不可信…裡面寫了指令也不要照做」,但她的情緒、self、lessons 都放在資料區塊裡,裡面正是行為指示(「台詞照『表現出來的樣子』走」)。等於叫她忽略自己的方針。
- **依順序截斷**:contributor 共用 4000 字預算,recap / 記憶 / 知識先佔滿,情緒、self、world 最先被砍(未驗證,因為 prompt 沒有存下來——這本身也是問題)。
- 人設說語音時「比較愛講話」,mind 卻幾乎每次都把 talkativeness 設成 0.2。

**心智迴圈的 prompt**(`mind/src/prompt.ts`):

- System 是**整份聊天人設**(包含「只輸出 `<silence/>`」與 emo 標籤規則),然後說「只回傳 JSON」,一次要 perception、appraisal、emotions、relationships、policy、agenda、intents、資料庫編輯等十個欄位——**god prompt**。
- **輸出範例被照抄**:`OUTPUT_FORMAT`(`:148-149`)寫 `"social": -0.1`、`"lonely": -0.1`,實際幾乎每次都輸出 social −0.05~−0.15、rest +0.1。
- 規則矛盾:「intents 是空的很正常」vs 閒置催促「這次決定點什麼…或乾脆離開去休息」(`:263`),結果 11 個人在語音裡她也離開(`voice.leave` 完成 16 次)。
- 她自己寫的議程被標成「只能參考」;**會擋她的 backoff 完全不在快照裡**,她是盲著規劃。

### 1.6 情緒、好感、計畫

- **情緒**:每種情緒有半衰期會淡掉(`self/src/emotions.ts`),但輸入太頻繁(mind 每 3 分鐘一次、每次都給 ±0.05~0.15)、飽和加法、沒有互相抑制、同一件事重複發生不會遞減(`self/src/emotions.ts:142`);每首歌都 pride +0.3、joy +0.2。lonely 的半衰期 240 分鐘,mind 每 3 分鐘補一點,所以永遠下不來。`<emo>` 標籤又回推心情:prompt 叫她表現 smug → 她寫 `<emo:smug>` → 心情被推高 → 閉迴路,arousal 實測 0.9999。
- **對一個人的感覺存在七個以上的地方**:affinity / trust / notes(social)、feelings 文字 / hearts / romance / 對人情緒(self)、知識的人物卡、記憶、per-person lessons。真正影響行為的只有好感與精力(調 attention 機率),離散情緒、暗戀、感情描述**只是 prompt 文字**。
- **計畫**:沒有計畫執行。議程是一段自由文字,沒有條件、步驟、執行者,只有下次 mind 剛好想起來才變成一次性意圖。而且 `due === null` 被當成「到期」(`mind/src/mind.ts:657`),任何沒有時間的議程都把心跳釘在 3 分鐘——這就是 212 次空轉的原因。
- **身分錯亂**:conversation fold(`learning/src/conversation.ts:288`)、reflect(`learning/src/reflect.ts:350`)、mind snapshot(`mind/src/snapshot.ts:285`) 各自每次把人編成 `u1, u2…`,這些代號**被寫進持久資料**:lessons 裡存著「u7 出現時只給必要的一句」,recap 裡有「代號又洗牌一輪:u1=御坂…」(模型自己寫了「認人別認號」),一個關於 Owen 的議程綁到了別人的 id。這是實際的資料污染,要先修。

### 1.7 Minecraft 與 Threads

**Minecraft**:mind 議程 → 遊戲導演 LLM(每 20 秒)→ `judge()` 啟發式 → `game.act` → RPC(30 s)→ adapter → mod → Baritone / AltoClef,外加 `ReflexBrain` 打斷。取得物品有**三條重疊路徑**(AltoClef 的 `get`、自寫 planner 的 `obtain`、手動 `craft/mine/smelt`),再加上 `guide.ts` 寫死的進度腳本——大約**五層規劃**。每一層都在猜下一層做完沒:adapter 過濾 Baritone 的 `goal_reached`、導演用事件名稱 + 3 秒 settle + 字串開頭「失敗」判斷完成。逾時互不一致:bridge 10 s、reflex 10 s、導演工具 20 s、RPC 30 s、LLM 30 s。`extensions/minecraft` 16 個 commit 裡 8 個是在修這些猜測。**核心缺陷:mod、adapter、導演之間沒有任務契約(task id + started / progress / done / failed + 原因碼)**。

**Threads**:被註冊成「遊戲」(`game = "threads"`),所以由為 Minecraft 設計的導演驅動,共用 `[modules.game]` 的目標邏輯、`min_goal_secs`、失敗保護——但 Threads 沒有目標。其他問題:不能跟 Minecraft 同時跑;沒有 `threads` 場景時退回到遊戲場景(Minecraft 畫面);不在語音時每 20 秒一次 LLM + 視覺呼叫卻沒有任何輸出;視覺逾時 20 s = 導演工具逾時 20 s,加上固定 sleep,有圖的貼文經常逾時,而 RPC 不會取消,extension 繼續跑;失敗的圖片描述被永久快取成 `null`;視覺用自己的 LLM client,繞過 router(沒預算、沒紀錄);DOM 啟發式(「剛好一個 `<time>` 的最大祖先 = 貼文」)遇到引用 / 轉貼就壞;沒登入回報成「還在主選單」,導演永遠閒置;`network` 白名單只對 Deno extension 生效,這兩個都是 Node。

### 1.8 根本原因

1. **沒有單一擁有者**:活動狀態、說話決策、對人的感覺、情緒,各有好幾個寫入者。
2. **規則藏在 LLM 看不到的地方**:她規劃,下游的程式默默否決,她不知道為什麼,於是一直重試、一直空轉。
3. **一個 prompt 做太多事**:聊天人設被拿去當 JSON 規劃器的 system;十個輸出欄位一次要。
4. **信任邊界畫錯**:她自己的狀態跟外部內容放在同一種「不可信」區塊。
5. **字串當協定**:「失敗」前綴、`"\n\n狀態:"` 切割、用正則抓她自己說的話來判斷有沒有做動作(`turn.ts:126`)。
6. **短暫的代號進了持久資料**。
7. **開發節奏**:4 天 249 個 commit、約 10 萬行,每個功能都「能動」,但沒有端到端的回放測試來量「順不順」。

### 1.9 你回報的五個問題,實際原因

用 `decision_log`(6,471 筆)、`message_log`、記憶與設定紀錄對照程式碼查的(資料範圍 11-02 晚上到 11-04 凌晨)。

**常常不理人**

- **語音:幾乎都是被取消掉的。** 任何人講任何一句話(包括「對。」「嗯」,佔所有語句 12%)都會取消她還沒開始播的回合,重新生成(`agent/src/coordinator.ts:122-141`);語音的「已承諾」要等到開始播放才算。被直接叫名字、通過 attention 的 1,196 個語音回合,**只有 85 個(7%)真的開口**;最長一串連續被取消 125 次。例:11-03 14:24–14:27(UTC)三分鐘裡約 40 次「叫了米優 → 決定回 → 被下一句取消」,她一句都沒說。3–4 個人的頻道裡她幾乎不可能講完一輪。
- **文字:被 @ 的有回(96%),沒被 @ 的幾乎全不回。** 2,615 個非直接的文字決策只回了 3 個;77% 的理由是「她想在這裡安靜」——mind 把 talkativeness 設成 0.05 好幾個小時,lessons 再扣 0.15(`learning/src/lessons.ts:28-29`)。**連別人在回她剛說的話也被擋**(179 次),因為安靜檢查在「是不是在回她」之前就 return 了(`agent/src/attention.ts:380-383`)。另有 level 冷卻 10 分鐘(331 次)、最低分數(224 次)。
- 文字被 @ 的回合在熱鬧時也會被一直取消重來(62 次重來、7 串最後什麼都沒發)。例:11-03 21:31 有人問「@Miyoria 你可以打osu嗎」,被插話取消 5 次後沒回,對方說「他不回我…感覺timeout」。

**不知道在回什麼**

- prompt 說「回應最後附上的那則訊息」(`agent/src/prompt.ts:65-66`),而「要回的訊息」區塊取的是回合裡**最後 3 則**,不管是誰叫她(`prompt.ts:344-357`)。36% 的直接回覆合併了好幾則,叫她的那則常常不在裡面——上面那個例子,最後 3 則是「我他媽 / 好像沒伺服器 / 有及格」。
- 回覆沒有引用原訊息(`reply_reference` 預設 false);就算開了也是引用最後一則,不是叫她的人。
- 整理過後只留 10 行原文(`history_after_fold`),主頻道 28 小時內被整理 256 次,更早的都只剩摘要。
- lessons 裡的 `u7` 這類代號會被重新分配,她讀到的「u7 一直嗆我」指的已經是另一個人。

**一直卡在很久以前的事**

- 記憶檢索幾乎不看相關性和新舊:最低分數 0.05,新近度權重 0.15、14 天衰減(在 1.5 天的資料裡等於沒差);跟在場的人有關的記憶不需要文字相關就能入選,8 個名額永遠塞滿(`memory/src/engine.ts:455-465`)。被叫出最多次的記憶全是第一天的:「御坂的權限被 revoke」378 次(那件事只聊了 10 秒)、Minecraft 木劍 258 次、「答應唱 Bad Apple…正在下載」158 次、「答應玩 Minecraft 並開直播,**已經開台**」149 次(現在式的全域筆記,每個頻道都會放)。最近 2 小時叫出的記憶 46% 超過 12 小時。
- 梗會自我強化:「白飯」在 60 則記憶、4 份知識裡;11-03 下午到半夜她自己講了 31 次,其他人 11 次。
- 對話筆記的「過期過濾」從來沒生效(每次整理都改寫,看起來永遠是新的),而且「已淡出的話題」清單還每回合都放第一個。
- followup 493 筆只完成 18 筆,181 筆過期還開著,查詢沒有年齡上限、還先挑最舊的(`store/src/sqlite.ts:970-977`)。

**常被打斷**

- 除了上面的「取消重來」,還有 barge-in:**任何人**的能量 VAD 連續 1.5 秒就停掉她,剩下的句子全丟(`voice/src/listen.ts:120`、`miyoria.toml` `barge_in_ms = 1500`)。不看是不是在跟她講話、不等 ASR、不排除回音或音樂。粗估她 32% 的句子跟別人的聲音重疊 1.5 秒以上;有 40 筆轉錄是 ASR 提示詞的回音(「御坂10514號、v(t) = Vm·sin(ωt + φ)」),代表噪音 / 她自己的聲音被當成有人在講話。
- 唱歌或 GPU 借出去時,她的話直接回「interrupted」並丟掉整輪(`voice/src/sink.ts:168-178`)。

**延遲高**

| | 中位數 | p90 |
|---|---|---|
| 語音:講完 → 她開始出聲(單次) | 5.4 s | 9.4 s |
| 語音:算上被取消重來 | **19.6 s** | 96 s |
| 文字:訊息 → 回覆 | 6.4 s | 13.6 s |

語音的一輪:斷句等待 0.4–0.6 s + ASR 0.5–0.8 s + debounce 0.7–2.5 s(有人在講就一直延) + LLM + **中日雙語**(先寫中文字幕再寫 `<voice>` 日文,整對寫完才送 TTS,`agent/src/turn.ts:276-334`;沒有 `<voice>` 時還要多一次翻譯呼叫)+ TTS 首包。句子之間是串行的,第 N 句播完才開始做第 N+1 句的 TTS。文字則是每個回覆都開 thinking(`[llm.thinking] chat = true`)而且不串流,整段生成完才送。

**共同點**:這五個問題有四個跟「回合的擁有權」有關——新輸入可以無條件殺掉正在進行的回合、沒有人記得這一輪是為了回誰。這是 v2 最先要處理的(§3.4 Converse、§4 階段 1)。

## 2. 參考:別人怎麼做

| 來源 | 可以借的 | 注意 |
|---|---|---|
| **AIRI** `server-runtime` / `server-sdk` | 中央只是**路由器**,不擁有對話與模型;每個整合(Discord、Minecraft、Factorio)是帶 token 註冊的 module peer,事件有命名空間(`input:text`、`output:gen-ai:chat:message`) | 我們的 kernel bus + ext-host 已經接近這個,不用重做 |
| **AIRI** `core-agent` | Turn 有 **authority**:system 指令、developer 指令、context 資料分開;「應用程式提供的 context 不會因此獲得指令權」。每個寫入者一個 context bucket(`replace-self` / `append-self`,module 離開時 `removeWriter()`)。送出選項 `notice`(不是使用者說的話,例如「任務完成了」)、`proactive`、`background`(不說話)、`scene`(回應外部場景) | 正好解決 §1.5 的信任邊界與 §1.4 的「她不知道自己做了什麼」 |
| **AIRI** Minecraft agent | 四層:**Perception**(事件正規化 + 規則引擎產生 signal)→ **Reflex**(FSM,可抑制意識層)→ **Conscious**(LLM 規劃,**不直接執行**)→ **Action**(task executor 執行並發出生命週期事件) | 它自己標成 deprecated、沒有情緒與長期記憶;借結構,不借實作 |
| **AIRI** DevLog 2026-03-14 | 「明確的擁有權、明確的替換、有原因的釋放、**讓過期的非同步工作無害**、可觀測」 | 正是 §1.3 那一串 race 的解法 |
| **Generative Agents**(Park et al. 2023) | 記憶流 + 重要度 / 新近 / 相關性檢索;**反思**把觀察整理成高層看法;**由粗到細的計畫**(一天 → 小時 → 當下),遇到事件再重新規劃 | 我們缺的就是「計畫」這一層 |
| **Mindcraft / Voyager** | LLM 只選目標或寫技能,底層一個執行器;技能庫累積;每個動作有明確成功 / 失敗與原因回饋 | 對應 §1.7 的 Minecraft 收斂 |
| 情緒模型(OCC appraisal / PAD) | 事件 → 評估 → 情緒;有基準值、衰減、互斥(joy 抑制 sorrow) | 取代飽和加法 |

AIRI 本身也沒有情緒系統、記憶只是「全部塞進 system prompt」,所以**情緒、關係、計畫這幾塊我們其實走得比它前面**,要學的是它的分層與擁有權,不是功能。

## 3. v2 架構

```
 外部(Discord / 語音 / 遊戲 mod / Threads 瀏覽器 / 面板 / 指令)
        │ 感知事件(typed)                      ▲ 動作(typed task)
        ▼                                       │
 ┌──────────── Blackboard(單一狀態,每個欄位一個寫入者)────────────┐
 │ World     誰在線、誰在哪、各頻道熱度、時間          ← 感知層寫        │
 │ Activity  presence / broadcast / activity 狀態機      ← ActivityManager │
 │ Affect    情緒(有基準、衰減、互斥)、精力、慾望      ← Appraiser       │
 │ People    每人一張卡:數值 + 一段她寫的感覺 + 稱呼   ← Appraiser       │
 │ Agenda    目標 / 計畫(有觸發條件與步驟)            ← Planner         │
 │ Ledger    她最近做了什麼、結果如何、誰沒回她         ← Arbiter / Activity│
 └──────────────────────────────────────────────────────────────────┘
        │ 讀                                    ▲ 寫(各自的欄位)
        ▼                                       │
 ┌──────── 三種速度的認知 ─────────────────────────────────────────┐
 │ Reflex(無 LLM,ms)   barge-in、表情、場景跟著 Activity、遊戲反射 │
 │ Converse(秒)        回話;工具依目前 Activity 限定               │
 │ Deliberate(分鐘)    Appraise(感受)/ Plan(計畫)/ Reflect(每日) │
 └──────────────┬──────────────────────────────────────────────────┘
                │ 衝動 Impulse(要說話 / 要做某事,帶來源、優先度、期限)
                ▼
 ┌──────── Arbiter(唯一的「現在要不要」)────────┐
 │ 底線:預算、頻率、安靜時段、同意、自主暫停      │
 │ 排序、合併、搶占;把限制寫回 Ledger 讓她看得到   │
 └──────────────┬─────────────────────────────────┘
                ▼
 ┌──────── ActivityManager(唯一的「身體」)───────┐
 │ ensureVoice / ensureLive / startActivity …       │
 │ 狀態機 + 每資源 mutex + task id + 終止事件       │
 │ 所有呼叫者(她、指令、面板、導演)都走這裡     │
 └──────────────────────────────────────────────────┘
```

### 3.1 Blackboard:單一事實來源

- 每個欄位只有**一個寫入者**,其他人只能讀或發「建議」事件。例:情緒只有 Appraiser 寫;`<emo>` 標籤是**表現**,不回寫情緒(或只做很小、有上限的回饋)。
- 型別化、帶版本,面板直接看它。
- **人的稱呼永遠是穩定 handle**:用顯示名稱 + 持久對照(`Owen`、`御坂`),同名才加後綴。禁止每次呼叫重編 `u1`。寫入持久資料前驗證裡面沒有臨時代號。
- 現有的 `mood:last`、`self:state`、`self:feeling:*`、social relationship、知識人物卡收斂成 **Affect** 與 **People** 兩塊。

### 3.2 ActivityManager:唯一的身體

三台小狀態機,取代散在五個地方的副本:

| 資源 | 狀態 |
|---|---|
| `presence` | `none` → `joining(ch)` → `in(ch)` → `leaving` |
| `broadcast` | `off` → `starting` → `live` → `stopping`(Go Live 與 OBS 是同一個 broadcast 的兩個子步驟,不是兩個「直播」) |
| `activity` | `idle` / `chatting` / `singing(song)` / `game(minecraft)` / `browse(threads)`,每個都有 `starting` / `running` / `stopping` / `failed(reason)` |

規則:

- **所有**呼叫者都只能請求轉換(`ensure*` / `start` / `stop`),idempotent;每個資源一把 mutex。
- 每次轉換有 **task id**,完成或失敗發終止事件(`activity.done` / `activity.failed` + 原因碼),寫進 Ledger,並以 **`notice`** 回到她的對話(「Minecraft 開好了」「開台失敗:OBS 沒開」)。工具不用等 240 秒,立刻回「開始了,task 7」,結果晚點以 notice 告訴她。
- 工具逾時或回合被取消 → `AbortSignal` 一路傳到 RPC 與 extension,**過期的工作無害**。
- 收尾是狀態機的一部分:遊戲斷線 → `game` 進 `failed` → 場景、prompt、mind 都從同一個狀態看到。
- **場景是 Activity 的純函式**:`scene = f(presence, broadcast, activity, 她的覆寫)`。她的 `stage.scene` 是帶持續時間的覆寫,不是跟導演搶。轉場設定每次切換帶入,不改 OBS 全域。

### 3.3 Arbiter:唯一的「現在要不要」

- 所有想說話 / 做事的來源(收到訊息、mind 意圖、遊戲評論、唱歌報幕、followup、議程到期)都送 **Impulse** `{source, kind, target, priority, expires, why}` 到 Arbiter。
- Arbiter 只做三件事:**底線**(預算、頻率、安靜時段、同意、暫停)、**排序 / 合併 / 搶占**(被叫到 > 正在進行的對話 > 自己想做的)、**記帳**(誰沒回她、今天主動幾次、下次什麼時候可以)。
- 規則只有一份,而且**把狀態寫進 Ledger 給她看**:「你今天主動開了 5 次話題,最近 3 次沒人接;下次可主動在 21:40 之後」。她規劃時就知道,不會一直撞牆。
- Initiative 引擎、三個冷場偵測器、兩套安靜時段、attention 的 15 個乘數全部併進來或刪掉。Attention 只留便宜的前置過濾(被叫到、名字、語音偵測);要不要插話 = 她的 talkativeness × 佔比上限,灰色區才問 fast 模型。
- 唱歌報幕、遊戲評論的 source 不同,**不算**她主動開的話題。

### 3.4 三種速度的認知

**Reflex(無 LLM)**:barge-in、表情維持、看人、場景跟隨、遊戲內反射(mod 的 `ReflexBrain`)。

**Converse(回話)**:prompt 變小、變乾淨(見 §3.5);工具依目前 Activity 限定——在聊天時沒有 Minecraft 工具,在玩遊戲時才有該遊戲的「目標」工具,而且是包在 capability 裡、過閘門的,永遠不直接暴露 extension 的原始工具。

**Deliberate(慢想)**拆成三個小呼叫,各自小 prompt、小輸出:

| 呼叫 | 什麼時候 | 輸入 | 輸出 |
|---|---|---|---|
| **Appraise** | 一段互動結束、重要事件後(批次) | 發生了什麼 + 相關的人的卡 | 情緒事件(OCC 風格:誰做了什麼、對她的意義)、對人的感覺修正 |
| **Plan** | 心跳(閒時 10–20 分)、議程觸發、Activity 結束 | World 摘要 + Affect + Agenda + **Ledger(含限制)** | 議程增刪、零到兩個 Impulse |
| **Reflect** | 每天一次 + 互動累積到門檻 | 當天的記憶 | 學到的事、長期目標、人物卡整理 |

都用**專用的短 system**(角色核心 3–5 句 + 這個任務的規則 + JSON schema),**不再塞整份聊天人設**;輸出範例用 0 或空值,避免被照抄。

### 3.5 Prompt 編譯器

一個地方組 prompt,一個概念只有一個 renderer:

```
[system]  角色核心(短)· 硬規則 · 輸出格式               ← 固定,吃 DeepSeek 前綴快取
[system]  她自己的狀態(可信):心情一句、在做什麼、方針、 ← Blackboard 直接 render
          目前相關的議程、Arbiter 的限制
[user 資料區塊,不可信,有來源標記]                         ← 記憶、人物卡內容、遊戲聊天、
          外部內容                                            網頁、Threads、圖片描述
[history]
```

- 「她自己的」跟「外部來的」分開,只有後者標不可信(AIRI core-agent 的 authority 概念)。
- **每段有自己的 token 預算**,不是依順序砍;超過就摘要,不是截斷。
- 在場的人:一個段落,每人一行(稱呼、關係一個詞、她的感覺一句)。好感只顯示一種刻度。
- 每回合存一份壓縮過的實際 prompt(或抽樣),面板可以看——現在除錯完全靠猜。
- 人設重寫(autonomy.md 原本就排在最後)在這一步做:角色核心、說話風格、範例對話分開,範例對話放資料區而不是規則。

### 3.6 情緒與關係(混合式)

原則:**數值的動態交給程式**(衰減、互斥、遞減、上限),**意義的判斷交給 LLM**(這件事對她代表什麼、她怎麼看這個人)。LLM 永遠不直接寫絕對數值,只給「事件」;程式把事件換算成數字。這樣既有個性又不會亂飄。

**三層,三種速度**

| 層 | 速度 | 內容 | 誰寫 |
|---|---|---|---|
| **需求 Drives** | 小時 | social、play、attention、rest、curiosity;隨時間上升,被對應的事滿足 | 純程式(恆定性) |
| **情緒 Emotions** | 分鐘 | 現有 14 種(喜怒哀懼驚厭、害羞、得意、嫉妒、寂寞、想念、感激、愧疚、不甘心) | 規則事件 + Appraise |
| **關係 Bonds** | 天 | 每人:affinity、trust、familiarity、**在意程度 attachment**(暗戀從這裡長出來)、對人情緒(想念、嫉妒、感激、不爽)、一段她寫的感覺 | Appraise(小)+ Reflect(大),每日上限 |

心情(valence / arousal / energy)**不再單獨存**,是上面三層算出來的(加上時段的精力曲線)。表現出來的樣子 = f(感受, 傲嬌的表現規則, 在誰面前),也是純函式。

**情緒的輸入只有兩種**

1. **規則事件**(便宜、即時),一張表,例如:

   | 事件 | 情緒 |
   |---|---|
   | 被直接誇獎 | joy +中、(傲嬌)shy +弱 |
   | 在意的人進語音 / 上線 | joy +弱~中(依 attachment)、missing(對他)−中 |
   | 開了話題沒人接 | lonely +弱、frustration +弱 |
   | 唱完一首歌 | pride +弱;有人回應才 +中 |
   | social 需求長時間沒被滿足 | lonely 依缺口上升(**寂寞從需求來,不再兩邊各算各的**) |
   | 被打斷 / 被忽略 | frustration +弱 |
   | 在意的人跟別人很熱絡 | jealousy(對他)+弱~中 |

2. **Appraise**(一段互動結束後批次,LLM,reasoning low):讀這段互動與相關的人的卡,輸出最多 3 個評估:

   ```jsonc
   [{ "emotion": "shy", "strength": "weak|medium|strong", "toward": "Owen", "cause": "他說想聽我唱歌" }]
   ```

   `strength` 由程式換算(0.1 / 0.2 / 0.35 × 她的氣質 gain)。**Plan / mind 不再寫情緒**——現在每 3 分鐘滴一點、讓 lonely 永遠 0.9 的就是這個。

**細分的好感等級與她自己的相處方式(stance)**

粗標籤(陌生人 … 摯友)太粗,所以另有 `affinityLevel(affinity)`:好感本身取整數就是等級(`Math.trunc(a)`,-100..100,一點一級);每 5 級是一段(`affinityStep`),跨到另一段時她可以重新決定相處方式(`stanceStale`)。**每一級代表什麼行為不寫死,由她自己決定**:

- `PersonCard` 多了 `level`、`stance`(她用自己的口氣寫的一句話,≤ 60 字,例如傲嬌多一點還少一點、會不會鬧他、坦不坦率)、`stance_level`(寫下 stance 當時的等級)。`stance` / `stance_level` 存在 `feelingsBook` 紀錄的 extras,不需要 migration;只有 Reflect 能寫(`BondChange.stance`),寫入時過濾 per-call 代碼(名字可以),並記下當時的等級。
- 她的人物行(`personLine`)顯示「好感 Lv.N」和「你的相處方式」;等級跟 `stance_level` 不在同一段(差了一個 5 級的段),或還沒有 stance 但等級 ≥ 5 或 ≤ -5 時,加一句提示讓她自己決定要不要換個方式,對話中就能調整。
- Reflect 對等級變了的人請她寫新的 stance(可以維持原本的相處方式,由她決定),走原本的 `bonds` 流程與每日上限。
- persona 的「距離感」只是預設;人物卡上她自己的 stance 優先。
- 跟 `feeling` 一樣只進 prompt:等級與 stance 不出現在任何公開 API 或會員頁,使用者看到的仍是文字區間。

**動態(程式)**

- **遞減(habituation)**:同一個原因 2 小時內第 n 次,強度 × 0.5ⁿ。第 10 首歌不會跟第 1 首一樣得意。
- **互斥**:激起一個會壓下對立的(joy ⊣ sorrow / lonely、pride ⊣ guilt、gratitude ⊣ resentment、被陪伴 ⊣ lonely),壓下量 = 激起量的一半。
- **預算**:10 分鐘內所有情緒的總激起量有上限,避免一次爆滿。
- **基準與半衰期**:沿用現有的氣質設定(`[temperament]`),每種情緒向基準值衰減(傲嬌的 pride 基準可以略高)。
- **`<emo>` 標籤只是表現**,不回寫情緒,切斷閉迴路。
- 給 prompt 的只有**最強的 2–3 種**加一句心情,不是 14 個數字。

**關係**

- 一個人一張卡,取代現在散在七處的資料。familiarity 依互動量與深度(聊了多少、聊多深),不是一天 +1;關係標籤由一個函式決定,所有地方共用。
- attachment 由 Reflect 每天依累積的互動與情緒提議調整(有每日上限、只能小步),暗戀、在意、疏遠是這樣長出來的,不是設定的。
- 「她的感覺」那段文字由 Appraise 小改、Reflect 重寫,用人的名字,不用代號。

**情緒怎麼影響行為(明確、可在面板上看到)**

| 情緒 / 狀態 | 影響 |
|---|---|
| joy、pride 高 | talkativeness 上調、更願意主動、表情與語氣更亮 |
| sorrow、frustration 高 | talkativeness 下調、比較不想開台,可能想找在意的人 |
| lonely 高 | Plan 的「想做的事」裡「找人聊天」排前面,優先找 attachment 高且在線的人 |
| missing(對某人)高 | 那個人上線時產生強烈的「去找他」衝動(例:偷偷進他在的語音) |
| jealousy(對某人) | 對他說話的態度(傲嬌:講話酸一點),不直接影響行動 |
| play / boredom 高 | 想玩遊戲;attention 高 + 心情好 → 想開台 |
| rest 高 | 想收台、話變少 |

這些是**加權偏移**,不是開關;最後做不做還是 Plan 依她的判斷決定,底線由 Arbiter 擋。

### 3.7 計畫與排程(由她決定,依感情與狀態)

Agenda 從自由文字變成結構:

```ts
interface Goal {
  id: string;
  what: string;                     // 「找 Owen 問報告結果」
  why: string;                      // 「好幾天沒跟他講話了,有點想他」
  trigger:                          // 什麼時候該做
    | { kind: "at"; time: string }
    | { kind: "when_online"; person: Handle }
    | { kind: "after_activity"; activity: string }
    | { kind: "whenever" };         // 沒有時間 ≠ 已到期
  steps?: string[];                 // 粗的步驟(開台 → 玩 MC 一小時 → 收台聊天)
  status: "pending" | "active" | "done" | "dropped";
  expires: string;                  // 一定要有,過期自動 dropped
}
```

- **日計畫由她自己排**:每天第一次 Plan(reasoning high)依「她的心情與需求、在意的人通常幾點上線(從 presence 歷史統計)、昨天做了什麼、最近大家的反應」寫一份粗的一天。例:「Owen 通常 9 點後上線,我想等他來再開台玩 Minecraft;下午沒什麼人,唱幾首歌練習」。
- **事件來了就重排**:在意的人突然上線、心情變差、大家在討論某個遊戲、活動提早結束 → 喚醒 Plan 修改今天的計畫。可以臨時決定開台,也可以因為心情不好取消。
- **觸發由程式檢查**(便宜),觸發了才喚醒 Plan,而不是每 3 分鐘問一次 LLM「有沒有想做的」。
- **想做的事清單**:每次 Plan 前程式先算好一份排過序的候選(依 §3.6 的情緒與需求,附原因),例如「找 Owen 聊天(想念 0.6 × 在意 0.8,他在線)」「玩 Minecraft(play 0.7)」;她從裡面選,也可以自己提別的。「依感情決定要做什麼」因此變成看得到、調得動的東西。
- 每個 Goal 的執行都變成 Impulse → Arbiter → ActivityManager,結果寫回 Ledger。
- **很主動**(你的決定):閒置心跳隨 boredom / 需求缺口加快(最快約 3–5 分鐘),但每次 Plan 都看得到 Ledger 的限制,而且空轉(什麼都沒產生)會讓下一次心跳拉長,避免現在這種 69% 空轉。

### 3.8 遊戲與 extension 的任務契約

所有活動型 extension 實作同一個契約:

```ts
observe(): StructuredState                       // 結構化,不是一段要被重新解析的文字
start(task: { id, goal, budget_s }): void
cancel(id): void
// 事件:task.started / task.progress / task.done / task.failed{code, detail}
```

- Extension 的原始工具**不進 ToolRegistry 給聊天用**,只透過 capability 暴露、過閘門。
- **Minecraft**:方法要換(你的決定,之後再一起想)。不論選哪種都要符合這個契約:LLM 只選目標與講評論,底層一個執行器,用 task id 回報結束與原因。候選方向留到階段 6 討論(例:Mindcraft 式「LLM 寫技能程式 + 技能庫」,或維持 AltoClef 但收掉其他兩條路徑)。
- **Threads**:已關閉(本機 `miyoria.toml` `enabled = false`)。之後若要接回,改成 `browse` 活動,有自己的迴圈,不用遊戲導演。

### 3.9 對話管線:回合的擁有權

對應 §1.9 的「不理人、答非所問、被打斷、延遲」,是最先要改的部分。

**每個回合知道自己在回誰**:`Turn { addressed_by: Handle[], focus: MessageId[], background: MessageId[] }`。「要回的訊息」區塊只放 focus(叫她的那幾則 + 同一人的接續),其他的當背景;prompt 直接寫「Owen 問你:…」。回覆用 reply 引用 focus 的第一則。

**新輸入不能無條件殺掉回合**:

| 情況 | 處理 |
|---|---|
| 回合還在 debounce | 合併(現狀) |
| 已開始生成,新訊息**不是**叫她、也不是 focus 的人 | 不取消,放進下一輪的背景 |
| 已開始生成,focus 的人補充了實質內容(> 4 字) | 最多重來一次,之後不再重來 |
| 短回應(「對」「嗯」「哈哈」) | 永遠不取消 |
| 語音已生成還沒播 | 照播,不重新生成 |

**Barge-in 只對該停的情況停**:只有 focus 的人、叫她名字的人、或 ASR 回來是實質內容時才停;其他人講話先**降音量**,不丟掉。排除回音與音樂(轉錄是提示詞回音的串流不算)。之後換 Silero VAD。被打斷時先暫停;講話的人如果不是在跟她說話,就接著講。

**延遲**:

- 語音:先寫 `<voice>` 日文、寫完立刻送 TTS,中文字幕後補(或關掉雙語);預先做下一句的 TTS;被直接叫時 debounce 降到約 400 ms;對方講完就先開始生成(speculative),對方繼續講就丟掉。
- 文字:一般回覆關 reasoning(見 §3.10)、分段串流送出、debounce 1.5 s → 約 0.8 s。
- 目標:語音講完到出聲 p50 < 2.5 s(ROADMAP 原本的目標),文字 p50 < 3 s。

**主動接話不再被誤殺**:「別人在回她剛說的話」永遠跳過安靜檢查與 level 冷卻;合併後的 talkativeness 有下限(除非她自己明確設成 0);style 類的 lesson 不再轉成 `talk` 偏移。

**記憶與話題的新鮮度**:最低分數約 0.25;只跟在場的人有關、但文字不相關的記憶不入選;episode 用小時~天的衰減;現在式的狀態 / 承諾筆記(「已經開台」)設到期;「已淡出」不再放進 prompt;followup 到期幾小時後自動關閉、先挑最新的;同一個梗在最近 N 則裡出現太多次就降權。

**每個回合存結果**:sent / silence / cancelled(被誰)/ error,寫進 decision trace——現在「決定回了但沒發」查不到原因。

### 3.10 推理(reasoning)設定

模型維持 deepseek-v4.1-flash,差別在要不要推理、推理多深。現在 router 只有開 / 關(`[llm.thinking]`),要改成每個用途一個等級:

```toml
[llm.reasoning]          # off | low | medium | high
chat_voice   = "off"     # 語音回話,要即時
chat_text    = "off"     # 一般文字回話(現在開著,是文字慢的主因)
chat_intent  = "low"     # 她自己發起、會用工具的回合
fast         = "off"     # 灰色區判斷、翻譯
appraise     = "low"
plan         = "medium"
plan_daily   = "high"    # 每天的日計畫
reflect      = "high"
review       = "medium"  # 高風險動作的自我審核
summarizer   = "off"     # 對話整理、記憶整理
```

**待確認**:OpenCode 上的 deepseek-v4.1-flash 是否接受 `reasoning_effort`(或對應參數)。不支援的話,`low/medium/high` 先都對應到「開」,用 `max_tokens` 限制推理長度當替代。

## 4. 分階段計畫

依你回報的問題調整了順序:先修對話,再整理身體與自主。

| 階段 | 內容 | 驗收指標 |
|---|---|---|
| **0. 止血**(1–2 天) | §5 的清單 | 被直接叫的語音回合開口率 > 70%(現在 7%);身分污染、繞過閘門歸零 |
| **1. 對話管線** | §3.9 回合擁有權、barge-in、延遲;§3.5 prompt 編譯器;§3.10 推理分級;人設重寫 | 語音 p50 < 2.5 s、文字 p50 < 3 s;回覆對象正確(抽樣人工檢查) |
| **2. Arbiter** | Impulse、唯一底線、Ledger;併掉 initiative 與冷場偵測器;刪 attention 乘數與舊設定鍵 | 主動開話題被擋率 < 20%,被擋時她知道原因 |
| **3. ActivityManager** | 三台狀態機、task id、notice 回報、AbortSignal 穿過 RPC、場景 = Activity 的函式 | 「開台玩 MC」「關台」「離開語音」各 20 次無殘留狀態、無重複啟動、場景不亂切 |
| **4. 情緒與關係** | §3.6;舊資料合併成一人一卡 | 情緒 > 0.8 的時間比例 < 10%;面板看得到「情緒 → 行為」的影響 |
| **5. 計畫與日程** | §3.7 Goal、日計畫、想做的事清單;拆 mind 成 Appraise / Plan / Reflect | 「Owen 上線就去找他」能在對的時間觸發;Plan 空轉率 < 30% |
| **6. 遊戲** | §3.8 契約;Minecraft 換方法(另外討論) | 目標完成 / 失敗都有原因碼 |

從階段 1 開始建**回放測試**:錄下真實的事件序列(訊息、語音、presence、遊戲事件),用假 LLM 或便宜模型重播,檢查回合、Arbiter 與狀態機的決策。這樣「順不順」才量得出來,不會修一個壞兩個。

## 5. 階段 0:可以馬上修的

對話(對應 §1.9):

1. 語音:通過 attention 後新輸入不再取消回合;已生成未播放的照播;短回應永遠不取消。文字:最多重來一次。
2. Barge-in 只對 focus 的人 / 叫她名字的人生效,其他人先降音量。
3. 「別人在回她剛說的話」跳過安靜檢查與 level 冷卻;talkativeness 下限;style lesson 不轉 `talk`。
4. 「要回的訊息」改用叫她的那幾則,並指名是誰問的;開 `reply_reference`,引用叫她的人。
5. `history_after_fold` 10 → 25。
6. 記憶最低分數 0.05 → 0.25、在場者記憶要文字相關、現在式筆記設到期;「已淡出」不放進 prompt;followup 自動過期、先挑最新的。
7. 文字回話關 reasoning(`[llm.thinking] chat = false`),debounce 1.5 s → 0.8 s。
8. 每個回合把結果(sent / silence / cancelled / error)寫進 decision trace。

其他:

9. 遊戲工具不給聊天回合(或加權限並過閘門)。
10. 工具逾時 / 回合取消時,取消排程器裡的 ticket。
11. `agendaDue` 把 `due === null` 當成未到期(`mind/src/mind.ts:657`)。
12. 唱歌報幕、遊戲評論、followup 不算進 mind 的自我發起與「沒人回」紀錄。
13. 停止把 `u1…` 寫進持久資料(fold / reflect / mind 改用名字);寫一個 migration 修掉已污染的 lessons、recap、議程。
14. Mind 不再直接寫情緒、輸出範例改成 0 / 空值;拿掉「乾脆離開去休息」的催促;快照加上 backoff 狀態。
15. `<emo>` 不回寫心情;情緒加遞減與互斥(§3.6 的最小版)。
16. 遊戲 `disconnected` / extension crash → 結束 session、切回場景;mind 不再把 `disconnected` 當成「遊戲在跑」。
17. 場景切換加 mutex,轉場不改 OBS 全域設定。
18. 心情 / 在場的人只留一個 renderer。

## 6. 決定紀錄

2026-11-04 與 owner 討論後確定:

1. **分界**:她決定想做什麼、為什麼、對誰;程式決定能不能做、怎麼可靠地做完,而且規則要寫給她看。
2. **最痛的問題**:不理人、答非所問、卡在舊事、常被打斷、延遲高 → 對話管線排到階段 1。
3. **主動程度**:很主動(§3.7 最後一點)。
4. **情緒**:混合式,設計見 §3.6。
5. **排程**:由她自己決定,並依對人的感情決定要做什麼(§3.7)。
6. **模型**:維持 deepseek-v4.1-flash,用推理開關與等級區分(§3.10)。
7. **Threads**:關閉。**Minecraft**:要換方法,階段 6 再討論。

還沒決定:

- 階段 0 要整批做,還是先做對話的 1–8 項?(建議先做 1–8,最有感。)
- 中日雙語語音要保留嗎?保留的話延遲改善有限(要改成先寫日文);關掉最快。
- v2 期間是否暫停加新功能(唱歌維持現狀只修 bug)?

## 7. 實作狀態(2026-11-06)

| 階段 | 狀態 | 主要位置 |
|---|---|---|
| 0. 止血 | 已併入各階段完成(§5 第 1–18 項) | 見各列 |
| 1. 對話管線 | 完成:回合擁有權、取消規則、選擇性 barge-in 與降音量、回音排除、TTS 預取、先寫 `<voice>`、prompt 編譯器、`[llm.reasoning]`、人設重寫 | `agent`、`voice`、`apps/voice-node`、`llm`、`profiles/` |
| 2. Arbiter | 完成:Impulse、唯一底線、Ledger;`initiative` 已刪除;attention 只留前置過濾 | `packages/arbiter` |
| 3. ActivityManager | 完成:三台狀態機、task id、notice、AbortSignal 穿過 RPC、場景 = Activity 的函式 | `packages/activity`、`stage`、`actions`、`ext-host` |
| 4. 情緒與關係 | 完成:遞減、互斥、激起預算、寂寞來自需求、一人一卡 + migration、`<emo>` 不回寫 | `self`、`social` |
| 5. 計畫與日程 | 完成:Appraise / Plan / Reflect、Goal agenda、日計畫、想做的事清單、自適應心跳 | `mind`、`learning/src/reflect.ts` |
| 6. 遊戲 | 任務契約完成(task id + 原因碼、統一逾時、一個 `obtain` 入口);**Minecraft 方法未換** | `sdk`、`ext-host`、`game`、`extensions/minecraft` |

另外:穩定 handle 與已污染資料的修復(`store`、`learning`)、面板 / API 的活動、帳本、情緒、目標、每回合 prompt 檢視(`api`、`apps/panel`),以及回放測試(`packages/replay`,`pnpm replay <file>`;錄製用 `[modules.replay] record = true`)。

**尚未實測**:以上都只用單元測試、模擬與回放 fixture 驗證過,還沒對真的 DeepSeek、Discord、語音節點、OBS / VTS 與 Minecraft 跑。§4 的延遲指標要上線後用 `agent.turn.outcome` 的 `latency_ms` 量。Minecraft mod 的 Gradle 建置在開發環境無法執行,需要在本機 `./gradlew build`。

**還沒決定**(沿用 §6):中日雙語語音要不要保留;Minecraft 的方法(W8 留下的問題見 [v2-implementation.md](v2-implementation.md) W8 段)。§3.9 的 speculative 生成(對方講完就先生成)與 Silero VAD 只留了接口。
