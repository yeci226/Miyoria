# Roadmap

> 每個 phase 結束時都要有**實際能用的東西**。順序依你說的重點排:先讓她在 Discord 文字頻道活起來,再加語音,最後才是直播與遊戲。架構細節見 [ARCHITECTURE.md](ARCHITECTURE.md)。

## V5(現在)

規劃與現況在 [design/v5-architecture.md](design/v5-architecture.md)(各階段的 PR 和日期在 §15),還沒做的事和等 owner 決定的事在 [design/backlog.md](design/backlog.md)。

- [x] 階段 0 清場(2026-11-14)
- [x] 階段 1 契約與瘦身(PR #53,2026-11-15):`contracts`、套件整併、新的資料庫與事件紀錄、刪 V2 管線
- [x] 階段 2 管家(PR #55,2026-11-16):`service.toml`、hostd、登記處;線上由 hostd 管理
- [x] 階段 3 大腦(PR #56,2026-11-17):新的回合跑者、提示詞版面、子代理、記憶分層
- [x] 階段 4 心(PR #63,2026-11-17):人物模型、`<feel>`、每晚反思、人物頁
- [x] 階段 5 玩(PR #64、#67 起到 #93,2026-11-17 到 11-21,分批合併):每日卡、經濟的去處、每日任務、派對遊戲、直播彈幕、唱 K 第 1 步
- [ ] 階段 5 剩下的:深海交易所([design/exchange.md](design/exchange.md));生圖卡等模型選定([design/v5-play.md](design/v5-play.md))
- [ ] 階段 6 很多地方(Space / Room、每個 Space 的設定、檔案網域):還沒開始
- [ ] 階段 7 身體(活動契約、Neuro SDK、表演者與渲染器分開、Minecraft):還沒開始;Minecraft 暫停,筆記在 [design/minecraft-findings.md](design/minecraft-findings.md)

## 歷史:V5 之前的階段清單

下面的 Phase 0–8、TypeScript 改寫、v2、v4 是當時的清單,勾選狀態停在當時,不再更新;裡面提到的模組有些已經被取代或移除(例如 `@miyoria/initiative`、`@miyoria/heart/social`、TurnCoordinator、Attention、PostgreSQL)。現在還沒做的事以 [design/backlog.md](design/backlog.md) 為準。

## Phase 0:地基與技術驗證(spikes)

先把最大的不確定性消掉,再開始寫正式的程式碼。

- [x] Monorepo 骨架:pnpm workspace、CI(Biome / typecheck / Vitest / build)、`.editorconfig`
- [ ] 授權(待決定)
- [ ] **Spike:Discord self 帳號**(spike 程式已移除,留在 git 歷史):候選 self-bot 函式庫能不能在 DAVE 加密下分別接收每個人的音訊、送出音訊、推 Go Live(風險 R1);同一個伺服器裡 bot 帳號和 self 帳號同時在線
- [ ] **Spike:ASR 評測**(評測程式已移除,留在 git 歷史):SenseVoice-Small vs Qwen3-ASR-0.6B / 1.7B(Whisper turbo 當參考),用 Discord 真實錄音(台灣腔、夾日英、遊戲用語),量準確率、每段延遲、VRAM
- [ ] **Spike:TTS 評測**(評測程式已移除,留在 git 歷史):Qwen3-TTS(Base 複製、VoiceDesign → Clone)vs GPT-SoVITS(CosyVoice、IndexTTS2 有空再測),在 4070S 上跟遊戲同時跑,量首包延遲、即時率、VRAM、中日混說與情緒表現
- [ ] **Spike:DeepSeek-chan 的聲音**:用 Qwen3-TTS VoiceDesign 依 `voice.toml` 的描述生成多個候選,挑一個固定成參考音
- [ ] **Spike:VTS 嘴型**:匯入 DeepSeek-chan 模型,列出它的 expression / 參數,從音訊注入 `MouthOpen`,確認同步效果
- [x] **Spike:LLM 抽象**:決定自己寫薄介面 + OpenAI 相容 provider(`@miyoria/llm/llm`)
- [ ] 寫下評測結果,更新 DECISIONS.md 的 🧪 項目

**完成條件**:所有 🧪 項目有結論;repo 能 build、CI 綠燈。

## Phase 1:Kernel + 文字聊天 MVP

- [x] `@miyoria/types`、`@miyoria/runtime/kernel`(Module、Supervisor、事件匯流排、service registry、設定與 JSON Schema)
- [x] `@miyoria/store`(SQLite、migrations)、`deploy/docker-compose.yml`(V5 拿掉了沒測過的 Postgres)
- [x] `@miyoria/llm/llm`(OpenAI 相容供應者 + DeepSeek 專屬處理:推理內容過濾、前綴快取友善的 prompt 順序;依用途路由、成本記錄)
- [x] `@miyoria/runtime/profile`(載入、驗證、執行期修改人格段落;所有資料帶 `profile_id`)+ 把 `profiles/deepseek-chan/` 定案
- [x] (歷史,V5 階段 3 換掉)`@miyoria/brain/agent`:Stimulus、Conversation Session(working memory)、TurnCoordinator(debounce / 合併)、Attention 第一、二層、Expression Parser(文字部分)
- [x] `@miyoria/runtime/scheduler`:`text` lane
- [x] `@miyoria/discord`:文字收發、輸入中、反應、rate limit(尚未連真的 Discord 測)
- [x] `@miyoria/commands` 框架 + `/ping`、`/admin module ...`
- [x] `/mode`、`/activeness`、`/persona show`(設定存進 DB,重開還在)
- [x] 工具呼叫迴圈(`ToolRegistry`、觸發者權限檢查、內建 `react`)
- [x] CLI:`init`、`doctor`、`core`、`chat`(REPL)、`module list`、`profile validate`
- [x] CLI `status`、`module list/enable/disable/restart`、`decisions`、`events`、`persona show/set`(透過 Admin API)
- [x] Decision Trace 以事件發佈(`agent.decision`)
- [x] Decision Trace 存進 DB(`miyoria decisions` 可查)

**完成條件**:她在 Discord 有自己的個性,會判斷要不要回、不會洗版;可以用 CLI 和指令開關子系統。

## Phase 2:語音

- [x] `apps/voice-node`(TS):self 帳號登入、進出語音、每人 PCM 串流、播放音訊;用 [Voice Link 協定](protocols/voice-link.md)(WebSocket)接 Core
- [x] 雙帳號整合:bot 收 `/join`、self 帳號執行;`voice:*` lane 經 `VoiceSink` 播放;self 掉線時語音降級、文字照常
- [x] `@miyoria/voice/speech`:ASR / TTS 介面、fallback chain;provider:`http-worker`、OpenAI 相容(雲端備援)、GPT-SoVITS
- [x] `workers/`:ASR(SenseVoice / Qwen3-ASR)與 TTS(Qwen3-TTS,逐句串流)的 FastAPI worker、Docker、聲音設計工具、假 worker
- [x] `@miyoria/voice/voice`:每人能量 VAD + 斷句、ASR、轉繁體、幻聽過濾、Voice Room 成員
- [x] 語音版 Attention(更保守)+ 逐句送 TTS + `voice` lane + barge-in(被打斷就丟掉那一輪剩下的句子)
- [x] 語音同意流程(`/voice consent`、進頻道公告;預設 opt-out)
- [x] `/join`、`/leave`、`/voice mode`、`/voice consent`
- [x] 延遲事件(`voice.latency`,可用 `miyoria events 'voice.*'` 看)
- [x] 端到端測試(假語音節點 + 假 worker + 假 LLM):講完到開口約 0.74 秒
- [ ] **實測**:真的 Discord(self 帳號 + DAVE)、真的 ASR / TTS 模型、真的 DeepSeek
- [ ] Silero VAD(目前是能量 VAD,吵雜環境可能需要)
- [ ] ASR 部分結果(partial)— 目前是整段辨識

**完成條件**:她在語音頻道聽得懂大家在講什麼,偶爾自然地插話;延遲中位數 ≤ 2.5 秒。(待實測)

## Phase 3:記憶、社交、權限

- [x] `@miyoria/memory/memory`:Episode / Fact / Self note / Followup、背景 consolidation、混合檢索(全文 + 向量 + 新舊 + 重要度 + 在場者)、隱私範圍(私訊內容不外流)、jieba 斷詞、可選 embeddings、遺忘
- [x] `/memory show / forget / export`;工具 `remember` / `recall`
- [x] (歷史,現為 `@miyoria/heart/person`)`@miyoria/heart/social`:Person / Account、`/link`、Relationship、Appraisal(規則 + LLM)、每日上限與報酬遞減、`/me`、`/admin person …`
- [x] Mood 模組(往基準值回歸、日夜曲線、事件推動)
- [x] (歷史:V2 換成 Arbiter,V5 換成 `@miyoria/brain/selfhost` 的 initiative)`@miyoria/initiative`:冷場、followup、打招呼、有人進語音;每日上限、沒人理就退避、安靜時段
- [x] `@miyoria/auth`:RBAC(owner / admin / moderator / trusted / user / restricted / blocked)、全域 / 伺服器 / 頻道範圍、Discord 角色對應、防越權、稽核紀錄
- [x] LLM 價格、每日 / 每月預算、降級與停止、用量持久化
- [ ] 實測:真的 DeepSeek 上 consolidation 的 JSON 品質、好感變化是否合理
- [x] `/link` 合併兩個人的記憶(連同好感一起搬到保留的那個人)

**完成條件**:她記得人、記得發生過的事,對不同人態度不同,會主動找人聊天;權限控管完整。(待實測)

## Phase 4:Admin API + Panel

- [x] `@miyoria/api`:REST + SSE、bearer token、稽核;人物、記憶、權限、擴充、MCP、佇列、Stage、語音、花費等路由(型別現在在 `packages/contracts/api`)
- [x] Core 直接提供面板網頁(`panel_dir`)
- [x] `apps/panel`:深色極簡(impeccable)、總覽、子系統、決策追蹤、人格編輯 + 歷史、即時事件、人物與好感、記憶、權限、擴充、MCP、佇列、Stage、語音監控
- [x] CLI 透過 API 操作執行中的 core
- [x] Discord OAuth2 登入(面板「使用 Discord 登入」;token 照樣能用)
- [x] 人物列表列出所有認識的人(包含還沒有好感紀錄的)
- [x] API 的記憶搜尋走記憶模組的混合檢索(memory 模組沒開時退回全文)
- [x] 量測 `llm_first_token` 延遲(面板語音監控、`/metrics`)

**完成條件**:不用碰設定檔就能管理她的一切。

## Phase 5:擴充系統 + MCP

- [x] `@miyoria/plugin-host/ext-host`:manifest、JSON-RPC over stdio、每個擴充是一個可啟停的 module、權限、熱重載(`miyoria ext dev`)
- [x] `@miyoria/sdk`(TS):tools / commands / events / prompt / storage / game adapter
- [x] `miyoria ext new / list / install / validate / dev`;範例 `extensions/examples/hello`
- [x] `@miyoria/plugin-host/mcp`:MCP client(`@modelcontextprotocol/sdk`)、允許 / 禁止清單、權限、重連;可選唯讀 MCP server
- [ ] WASM 擴充(可選)

**完成條件**:用 TS 寫一個新子系統或工具,`miyoria ext dev` 就能熱載入;MCP 工具可以安全地開放給她用。

## Phase 6:Stage — VTuber 化

- [x] Stage link(WebSocket,見 `docs/protocols/stage-link.md`)+ `miyoria stage`
- [x] VTube Studio:表情 / hotkey、嘴型同步(voice node 推送播放音量)、頭部與視線
- [x] OBS:場景、開始 / 停止直播、字幕文字來源;`/stream start / stop / scene / status`
- [x] Overlay(`apps/overlay`):字幕、情緒、狀態、佇列
- [x] Go Live(self 帳號,hybrid / exclusive 模式)
- [ ] 實測:真的 VTube Studio(部分 API 欄位待確認)、OBS、Discord Go Live 與語音能否同時
- [ ] Twitch / YouTube 聊天室 adapter(做成可開關的 platform module)

**完成條件**:她能以 VTuber 樣子開播,講話時嘴型、表情同步,讀直播聊天室並回應。

## Phase 7:遊戲

- [x] Game adapter 協定:`game = "<id>"` 的擴充擁有 `game.<id>.*` 命名空間
- [x] `extensions/minecraft/mod`:Fabric 1.21.1 橋接模組(Baritone + 可選 AltoClef),`gradlew build` 通過
- [x] `extensions/minecraft/adapter`:TS game adapter
- [x] `@miyoria/play/game`:遊戲導演(慢迴路決策、目標延續、觀眾點單變目標、實況評論限流、死亡反應、mood 推動)、`/game start / stop / goal / status`
- [x] `@miyoria/play/queue`:觀眾請求、公平排序、投票、overlay 顯示
- [ ] 實測:真的 Minecraft 客戶端 + 她的帳號
- [x] 不作弊:Baritone legit 設定、只看得到 / 挖得到看得見的方塊、工具等級不夠就拒絕並說缺什麼、`craft` / `smelt` / `place`(2026-11-02,還沒在遊戲裡實測)
- [x] 自己開遊戲:`game.start` 時遊戲沒開,導演透過閘門送 adapter 的 `launch`,adapter 用 Prism Launcher 的 CLI 開實例(`--launch <實例> --world <最近玩的存檔>`,執行檔可設定、預設自動找)並等模組連上、世界載入;開不起來 / 逾時是失敗的動作並帶原因;`game.stop` 只關她自己開的遊戲(2026-11-03,只在測試裡驗證,還沒真的開過 Prism)
- [x] 反射層(模組裡每 tick 跑,不經過 LLM):岩漿 / 溺水 / 窒息 / 落沙逃生、依血量反擊或逃跑、餓了自動吃、卡住約 20 秒自動脫身、挖完撿掉落物;打斷動作時發事件讓她知道(參考 Mindcraft 的 modes、mc_aiplayer 的 Safety Net)(2026-11-03,決策邏輯有 JUnit;遊戲裡的實際動作還沒實測)
- [x] 取得物品的規劃器:她只說目標(例如「鐵鎬」),程式依配方與工具等級往回推出砍樹 → 工作台 → 木鎬 → 石頭 → 石鎬 → 鐵 → 熔爐 → 鐵鎬,逐步執行並回報(參考 mc_aiplayer 的 GoalPlanner)(`obtain` 動作,2026-11-03,對假世界測過;還沒在遊戲裡跑完整條路線)
- [x] 失敗後的防呆:動作失敗後暫時不給低階移動 / 挖掘,逼她換方法或換目標(`[modules.game] failure_guard_secs` / `guarded_actions`,2026-11-03)
- [ ] 實測(自主能力):真的用 Prism 開關遊戲、各種反射在遊戲裡的動作、`obtain iron_pickaxe` 從空手跑到底
- [ ] 已知限制:只隔著樹葉看到的原木 Baritone 會立刻停;只支援一般熔爐;平滑轉頭在 ±180° 附近可能甩一下;遊戲內聊天預設「安靜」等級;`obtain` 看不到礦時只會 `explore`(不盲挖),埋在地下的鐵常要先去洞穴;反射打斷 Baritone 後原本的工作不會自動接續(她收到事件後再決定)
- [x] 唱歌(點歌):`workers/sing`(yt-dlp / 本機歌庫 → Demucs → Seed-VC 歌聲轉換 → 混音 + lrclib 歌詞,快取)、`@miyoria/sing`(歌單、`sing_request` / `sing_start` / `sing_stop`、她決定什麼時候唱、`/queue song request | list | skip | stop`、`[modules.queue]` 的 `song` 項目)、嘴型跟人聲走(Voice Link `0x03` 嘴型音軌)、歌詞字幕(見 [design/autonomy.md](design/autonomy.md) §22)
- [x] 唱歌時放原曲影片:worker 平行抓影片(H.264 ≤ 1080p,`video.mp4`,本機歌庫用旁邊的 `video.*`)、`song_video` 訊息、Stage 用 OBS 媒體來源靜音播放並跟歌同步(`latency_ms` + 位置校正)、場景用途 `sing`(導演切過去、唱完回原場景)
- [x] 高音不破音:轉換前清理 F0(八度錯誤、尖刺、短暫掉格)、自動挑音高看歌的最高音對她的上限、必要時整首往下轉調(伴奏用 Rubber Band)、參考音可以多段
- [x] 做歌時獨佔顯示卡:TTS / ASR worker 的 `POST /offload` / `POST /reload`、歌曲 worker `SING_OFFLOAD_URLS`、她先說「我去準備一下歌喔」再開始、暫停期間不說不聽、overlay「準備歌曲中…」
- [x] 歌單在 Core 重開後還在(settings store),接回 worker 的工作
- [ ] 實測:在真的 Discord 語音 + VTS + Go Live(`GOLIVE_AUDIO=true`)唱一首,含 `唱歌` 場景的影片同步、獨佔顯示卡的整段流程

**完成條件**:她能直播玩 Minecraft,邊玩邊實況,觀眾可以點單、投票影響她的行動。(待實測)

## Phase 8:強化與維運

- [x] `deploy/Dockerfile.core`(Node 24)、compose(core profile)、CI(TS / Python / Docker build / compose 驗證)
- [x] `docs/OPERATIONS.md`(備份 / 還原腳本已不在,資料庫備份見 OPERATIONS §7)
- [x] SIGTERM 正常關機;Windows 上 `Ctrl+C`(以及 Ctrl+Break、關掉主控台視窗)也驗證過會正常關機
- [x] Prometheus metrics:`GET /metrics`(bus 事件、LLM 首 token 延遲與用量等)
- [ ] OpenTelemetry
- [ ] 長時間穩定性測試(連續直播 6 小時以上)
- [ ] 多角色同時上線(可選)

## TypeScript 改寫

Phase 0–8 先用 Rust 寫成原型(留在 git 歷史裡),之後整個改寫成 TypeScript(理由見 [DECISIONS.md](DECISIONS.md) ADR 13)。

- [x] pnpm workspace(Node 24):`packages/*` 的 `@miyoria/*` 套件逐一移植,module id、設定鍵、事件、JSON 格式與預設值照舊,測試一併移植
- [x] Store:SQLite(`node:sqlite`)跑一份行為測試(PostgreSQL 在 V5 拿掉)
- [x] 端到端驗證:假 LLM + 假語音節點 + 假 worker 跑完整流程(文字、語音、Stage)
- [x] npm 套件 `miyoria`:esbuild 打包(內含管理面板、內建角色、migrations),`pnpm dlx miyoria@latest init` 就能開始;已可發佈(`pnpm release:publish`)
- [x] Docker 映像檔、CI 換成 Node 版本
- [ ] 實測(跟上面各 phase 的「實測」項目相同):真的 DeepSeek、Discord(bot + self 帳號)、VTube Studio / OBS、Minecraft、Go Live

## v2 架構重整

設計與 review 見 [design/v2-architecture.md](design/v2-architecture.md)。

- [x] 階段 0–1:對話管線(回合擁有權、選擇性 barge-in、延遲、prompt 編譯器、推理分級、人設重寫)
- [x] 階段 2:Arbiter(Impulse、唯一底線、Ledger;取代 initiative)
- [x] 階段 3:ActivityManager(presence / broadcast / activity 狀態機、task id、notice)
- [x] 階段 4:情緒與關係(遞減、互斥、一人一卡)
- [x] 階段 5:計畫與日程(Appraise / Plan / Reflect、Goal agenda、日計畫)
- [x] 階段 6:遊戲任務契約(task id + 原因碼)
- [x] 回放測試(`tools/replay`)、面板的活動 / 帳本 / 情緒 / 目標 / prompt 檢視
- [ ] 實測並對照 §4 的驗收指標(語音 p50 < 2.5 s、文字 p50 < 3 s、被叫開口率 > 70%、主動被擋率 < 20%)
- [ ] Minecraft 換方法(另外討論)
- [ ] 決定中日雙語語音是否保留;speculative 生成;Silero VAD

## v4(程式已合進 `main`)

從「管住她」到「讓她有能力」:agent 迴圈和 context、人格重寫、開口節奏、她自己的生活、一起玩、經濟 2.0、遊戲。實測數字、原因、分階段和目前 PR 的處理見 [design/v4-plan.md](design/v4-plan.md)。

v4 新增的模組(設定見 `miyoria.example.toml`):

- [x] 網路:搜尋與讀網頁(一頁最多 12,000 字,內容當資料不當指令),Stage 的 `browse` 場景
- [x] 沙箱:有名字的工作區(寫檔、讀檔、跑程式)和只准連白名單的網路
- [x] 筆記本與記憶:最近對話、每個人的資料、她自己的筆記本頁,本機 embedding(`provider = "local"`)
- [x] 技能:她自己寫、自己存、之後再用的做法(`[modules.skills]`)
- [x] 直播頁(`[modules.live]`)與一起玩(`[modules.party]`):觀眾點單、投票、獎勵與權限
- [x] 主線預算(`[modules.agent.mainline]`)與推理分級(`chat_tools` / `chat_question`)
- [x] 她自己的生活:mind 的日程與每日貼文(`[modules.mind.daily_posts]`),經濟 2.0(卡片、歌、螢幕、轉帳、錢包、目標、懸賞)
- [x] 提醒(`tools.remind`):一般成員可用
- [x] 評測:人格盲測(`pnpm --filter @miyoria/eval blind`)、十個多步驟工具任務、方法守門的重放
- [ ] 實測:人格盲測要真的模型和新舊兩份人設

## 後續可以考慮

更多遊戲 adapter、Telegram / LINE adapter、唱歌進階(和聲、即時翻唱、自己寫詞)、記憶視覺化、她自己寫日記 / 發社群貼文、影像理解(看觀眾貼的圖)、vLLM-Omni 的 WebSocket 文字串流輸入(邊生成邊合成)。
