# V3 架構設計

> 狀態:**階段 0 到 7 的程式已完成,尚未在真實環境驗收**(2026-11-07)。依據:[v3-research.md](v3-research.md)(各家 AI VTuber、開源專案、語音、agent harness、Discord 的調查)、2026-11-07 第一次在真實環境跑 V2 的紀錄。前一版見 [v2-architecture.md](v2-architecture.md)。

## 0. 一句話結論

V2 解決了「誰擁有狀態」,沒有解決「誰擁有她這個人」。她現在有好幾個腦:回話、計畫、遊戲導演各自決定,彼此看不到對方,所以想的、說的、做的對不上,也不知道自己講過什麼。

V3 只做一件大事:**一條主線**。只有一個前景決策者能讓她開口或動手,所有模組都變成提供事實的感知器或背景的提案者,所有事情寫進同一條事件日誌。圍繞這條主線補上四樣 V2 沒有的東西:

1. **送達帳本**:只有真的傳到對方耳裡才算講過,用內容鍵擋重複。
2. **主人規則**:owner 的話是持久規則,權限高於她自己的目標,由程式強制。
3. **台詞和動作同一次決定**:說「我去做」和真的去做是同一個輸出,做完才准說做好了。
4. **實測**:每一階段都在真實 Discord 和語音環境驗收,不再只靠 fixture。

不換模型、不重寫模組。V2 的 Arbiter、ActivityManager、任務契約都留著,改的是它們之間的關係。

## 1. V2 上線後實際發生的事

2026-11-07 第一次在真實環境跑完整 V2,約三小時。以下是資料庫和 log 的實測,前兩列是開始約兩小時內的統計,樣本小,但問題很明確。

| 現象 | 數字 | 根因 |
|---|---|---|
| 自言自語 | 語音裡她 176 句、人類 43 句;自己開始的回合 83 個,回應人的 17 個 | 遊戲實況只有 15 秒間隔,沒有去重,也沒有「沒人回就閉嘴」 |
| 不接話 | 直接叫她 12 / 12 有回,但別人回她的話只接 5 / 21 | 原因還沒查明,V3 要記錄每次沉默的理由 |
| 重複 | 「石鎬」2 小時講 25 次;38/176 句和前 30 句幾乎重複 | 狀態沒變,導演每次都丟一句;沒有「講過了」的概念 |
| 不聽話 | 「不要玩 Minecraft」後 Plan 仍重開遊戲,鎖定到期 5 秒就再開 | Plan 看不到別人的話;目標永久、owner 的話 20 分鐘過期 |
| 說了沒做 | 「麥塊收掉,不玩了」但沒呼叫 `game_stop` | 台詞和工具不是同一個決定;事後用 regex 補救 |
| 語音慢 | p50 4.8 s、p90 7.1 s,最快 3.4 s,目標 2.5 s | 主因推測是 GPU 爭用:同模型在 RTX 4060 首包 460 ms,我們 4–5 s,RTF 低於即時 |
| 她消失 | 做歌時聾啞 1 分多鐘,掉話(`503 offloaded`) | 全部塞在一張 12 GB 卡上 |
| 誤判狀態 | 不在語音卻堅稱在語音;重啟 Core 後遊戲開著但顯示閒置 | 她跟著歷史走,不看狀態;活動狀態沒有持久化 |

安裝和維運也暴露不少問題,全部是「知識只存在人腦裡」:擴充 `dist` 和 mod jar 要手動重建、`SING_OFFLOAD_URLS` 漏設就爆顯存、Windows 動態埠範圍把服務埠保留走、Kaspersky 擋 esbuild 暫存檔、`~/.cache` 寫不進去讓 yt-dlp 無限重試。見 §15。

## 2. 調查得到的結論

完整內容與證據等級見 [v3-research.md](v3-research.md)。對設計有決定性影響的是這幾點。

- **Neuro 的內部查不到,查得到的指向仲裁**。官方 SDK 的語音一輪是「秒級」,不是毫秒。真正可用的是它的介面:`context` 有 `silent` 欄位,把「她知道了」和「這可能值得反應」分開;`actions/force` 有四級 priority,在「繼續講」和「打斷」之間有「快講完」。
- **粉絲看重的是互動、驚喜和穩定人格**,不是速度。小社群給不了源源不絕的 prompt,所以她要有事可做、偶爾開口,並記得每個人。
- **防重複的有效手段都是確定性的,而且綁在「送達了什麼」**。靠 prompt 提醒已被證實不夠。GLaDOS 的 delivered-event ledger 是最好的設計。
- **「該不該開口」模型 zero-shot 接近隨機**(61% 上下)。她可以決定想多活躍,但每個停頓的即時判斷要由規則和校準過的特徵負責。**V2 §3.3「灰色區問 fast 模型」要撤掉。**
- **寫入保持單一執行緒**(Cognition)。額外的 agent 只貢獻智力,不貢獻動作。她的 think / speak / act 三段就是失敗的多 agent 系統。
- **規則放在模型外面,由程式強制**(Claude Code、Model Spec)。放在對話裡的指令會消失,assistant 自己的內容沒有權限。
- **Discord 明文禁止 self-bot,沒有設定能讓它合規**,處分範圍可能及於 bot 和 developer 帳號。語音不需要 self 帳號,只有 Go Live 需要。
- **沒有任何專案同時處理群聊、語音和自主性**,多人 Discord 語音沒有參考實作。走到這裡之後,她自己的量測就是最好的資料。

## 3. 原則

1. **一張嘴**。只有主線能讓她開口或動手。其他模組不准直接發言,也不准直接改變世界。
2. **她決定意圖,程式決定事實**。想做什麼、在意誰、想多活躍是她的;一件事講過沒、誰有權叫她停、事情做完沒,由程式回答。
3. **事實只有一份**。所有感知、決定、台詞、動作、結果都寫進同一條事件日誌,其他東西都是它的投影。
4. **事件預設靜默**。任何事件都只是「她知道了」,要開口得過主線和發言權。
5. **送達才算數**。沒有送達確認的,就是沒說過。
6. **權限不能由模型提升**。owner 的規則高於她的目標,高於觀眾的要求,也高於她自己的想法。
7. **失敗要留在台面上**。工具失敗、規則擋下、承諾逾期都回到她的 context,她要能自己說出來。
8. **合規和臨場感同方向**。回應真實事件、可查可刪的記憶、明確標示 AI 身分,對使用者和平台都是好事。
9. **實測才算完成**。驗收綁在真實環境;單元測試是必要條件,不是完成條件。

## 4. 架構總覽

```
 感知器(只寫事實,不開口)
 Discord文字 · 語音ASR · 遊戲mod · 歌曲 · 直播 · presence · 面板 · 指令
        │ Observation {silent, salience, attention_key, source}
        ▼
 ┌──────────────── EventLog(append-only,唯一事實來源)─────────────────┐
 │ 感知 · 想法 · 決定 · 台詞 · 動作 · 結果 · 送達 · 規則變更             │
 └──────┬──────────────────────┬───────────────────────┬────────────────┘
        │ 投影                 │ 投影                  │ 投影
        ▼                      ▼                       ▼
   Working Context        DeliveryLedger           Directives
   (每個寫入者一區,     (講過什麼、送達沒、     (主人規則,持久,
    replace / append)     誰回應了)                每回合注入)
        │                      │                       │
        └───────────┬──────────┴───────────────────────┘
                    ▼
 ┌───────────── Floor(發言權,無 LLM)──────────────┐
 │ 誰在講話 · 該不該拿麥 · 預算 · 打斷等級 · 釋放     │
 └───────────────────┬───────────────────────────────┘
                     ▼ 取得發言權或有動作要決定
 ┌───────────── Main Loop(唯一前景決策者)──────────┐
 │ 一次 LLM 呼叫 → { say, actions, promises, silence }│
 └───────┬───────────────────────────┬───────────────┘
         ▼                           ▼
   Voice / Text 輸出            ActivityManager / 工具
   (moderation → TTS →        (規則 deny-first → gate
    播放 → 送達 ack)            → executor → 結果事件)

 背景(只能寫 Proposal,不能開口或動手)
 Planner · 記憶整理 · Reflect · Appraise · 遊戲目標建議 · 評論草稿
```

### 和 V2 的對應

| V2 | V3 | 改變 |
|---|---|---|
| `agent`(turn、coordinator) | **Main Loop** | 成為唯一前景決策者;吃掉所有「主動開口」的路徑 |
| `arbiter` | **Floor** | 拿掉 producers(打招呼、追問改成 Observation);只管發言權、預算、打斷 |
| Ledger | **EventLog + DeliveryLedger** | 帳本變成日誌投影,加內容鍵和送達確認 |
| `mind`(Plan / Appraise) | 背景 **Planner / Appraise** | 只能寫 Proposal;移除直接送 impulse |
| `game` director | **Game executor + 目標建議** | 不再產生實況;事件變 Observation |
| `activity` | 不變 | 狀態持久化;納入 `MODULE_IDS` |
| `actions` gate | 加 **Directive 檢查** | deny-first,在 gate 之前 |
| `self` / `mood` / `social` | **Affect** | 收斂;情緒要有消費者(§12) |
| `conversation` / `knowledge` / `memory` | **Memory** | 三層(§11) |
| `voice-node`(self 帳號) | **Voice node** | 維持 self 帳號,見 §14.1 |

要刪掉的:`agent.initiative` 事件、`mind/selfstart`、`mind/ledger`、`#legacyInitiative`、attention 的灰色區 LLM 判斷、`game.chat` 直接 `voice.speak`、`self` 的舊 agenda、`packages/initiative` 殘留。

## 5. EventLog:共用的工作記憶

V2 的問題是資訊散在各模組的記憶體裡,所以 Plan 聽不到人話,回話不知道 Plan 想過什麼。V3 把所有東西寫進一條不可變日誌(參考 OpenHands)。

```ts
interface LogEvent {
  id: string;
  at: Timestamp;
  kind:
    | "observation"   // 感知到的事實
    | "thought"       // 主線或背景的想法
    | "decision"      // 主線的決定(含不開口)
    | "utterance"     // 準備說的話
    | "delivered"     // 送達確認(語音播完 / Discord 送出成功)
    | "action"        // 動作請求
    | "result"        // 動作結果(受理 / 完成 / 失敗)
    | "steer"         // 改變執行中任務的方向,以及套用結果
    | "directive"     // 規則變更
    | "proposal";     // 背景的提案
  source: string;              // voice.asr / game.minecraft / plan ...
  cause: string | null;        // 因果鏈:由哪個事件引起
  context: ContextKey | null;
  person: Handle | null;
  body: JsonValue;
}
```

- **`cause` 是關鍵**:面板的「意識軸」和所有除錯都靠它把聽到、想、說、做串起來。
- 所有模組讀日誌的投影,不再互相訂閱私有狀態。
- SQLite 存放,熱資料在記憶體,定期壓縮舊資料。重啟從日誌重建活動狀態,解決「重啟後遊戲開著卻顯示閒置」。
- `packages/replay` 改成直接重播這條日誌。

### Working Context:她現在知道什麼

借 AIRI 的 per-writer context bucket。每個感知器有自己的一區:

- `replace-self`:遊戲狀態、語音成員、直播狀態。**新狀態取代舊的,不累積,也不要求開口**。
- `append-self`:事件類,有長度上限。

這是「石鎬講 25 次」的根本解法:遊戲狀態是**她知道的事**,不是**她要說的話**。模組離開時移除自己那一區,她就不會以為遊戲還開著。

## 6. Observation:所有感知的統一格式

```ts
interface Observation {
  source: string;
  silent: boolean;            // 預設 true
  salience: "ambient" | "notable" | "urgent";
  attention_key: string;      // 內容鍵:同一件事永遠同一把,例如 game:craft:stone_pickaxe
  revision: number;           // 這件事有實質變化才加一
  summary: string;            // 給她看的一句話
  addressed_to_her: boolean;
  from: Handle | null;
  context: ContextKey | null;
}
```

規則:

- 事件預設 `silent: true`,只更新 Working Context。
- 只有 `notable` 以上、而且 `attention_key` 這個 revision 還沒送達過,才能申請發言權。
- 顯著度由**程式**判斷:第一次做到某件事、血量大幅下降、死亡、達成目標算 notable,每次 tick 的進度不算。

## 7. Floor:發言權

Floor 回答「她現在能不能拿麥」,**不用 LLM**。

### 7.1 拿麥的順序

| 優先 | 情況 | 處理 |
|---|---|---|
| 1 | 有人叫她名字、@ 她、回她 | 一定拿麥(規則擋下的動作除外) |
| 2 | 回她剛說的話 | 拿麥 |
| 3 | 任務結果有人在等 | 拿麥,可合併成一句 |
| 4 | urgent 事件(快死了、斷線) | 拿麥,打斷等級見下 |
| 5 | notable 事件且未送達 | 過預算才拿麥 |
| 6 | 她自己想說(Planner 提案) | 過預算,有真人在場才拿麥 |
| 7 | 別人之間的對話 | 依多話程度和校準特徵,預設不插嘴 |

第 7 項是公開未解的問題。V3 先用確定性特徵:對話是否提到她、話題是否她熟、剛才有沒有人理她、多話程度。**不用 fast 模型 zero-shot 判斷。**

### 7.2 預算(不能被其他動作重置)

MaiBot 的教訓:任何工具都重置計數器,結果 41 秒發 10 則。預算只看實際送達的台詞。

```toml
[floor.budget]
window_mins = 10
base_lines = 6              # 視窗內她自己開口的基本額度
per_human_line = 1.0        # 每句人話多給多少額度
unanswered_backoff = 2.0    # 連續沒人回應,下次間隔乘以這個
max_unanswered = 3          # 連續幾次沒人回應就停,直到有人開口
performing_bonus = 8        # 唱歌報幕、直播玩遊戲時的額外額度
```

- **有人回應才算對話**。`max_unanswered` 到了就安靜,有人開口自動恢復。這一條直接解決「對空氣講 32 句」。
- 她可以用 `talkativeness` 調整額度倍率,但上限是 owner 設的。
- **靜默不是觸發條件**。文字頻道不因冷場開話題(Developer Policy item 13);語音裡只有真人在場才允許。

### 7.3 打斷等級

借 Neuro 的 priority 和 Lumi_Nox 的 policy:

| 等級 | 行為 |
|---|---|
| `queue` | 等她講完 |
| `wrap_up` | 目前句子講完就收尾,丟掉後面的句子 |
| `cut_short` | 淡出,接著回應 |
| `interrupt` | 立刻停 |

音訊**播完才釋放**發言權,失敗路徑也要釋放。被打斷時歷史只留實際聽到的部分(Open-LLM-VTuber 的做法)。

## 8. DeliveryLedger:講過了沒

V2 的 Ledger 知道她做過什麼,但回答不了「這件事講過沒」。

```ts
interface Delivery {
  attention_key: string;
  revision: number;
  channel: "voice" | "text";
  context: ContextKey;
  said: string;
  delivered_at: Timestamp;     // 只有 ack 才寫
  audience: Handle[];          // 當時在場的人
  answered_by: Handle[];       // 窗口內有誰回應
}
```

- **Ack 才算**:語音是 `voice_playback finished`,文字是 Discord 回傳成功。被打斷、失敗、取消的可以重試。
- 同 `attention_key` 同 `revision` 不再申請發言權。
- 在 prompt 裡給她「最近講過」的短清單,作為第二道防線,不是第一道。
- 換句話說也擋得住,因為鍵是事件,不是文字。她自己想到的話題用 `topic:<normalized>`,再加文字相似度。

## 9. Directive:主人規則

現在 owner 的話過 20 分鐘就消失,她自己的目標卻永久有效,權限是反的。

```ts
interface Directive {
  id: string;
  issuer: AccountRef;
  authority: "owner" | "moderator" | "system" | "viewer";
  scope: { capability?: string; activity?: string; context?: ContextKey; person?: Handle };
  effect: "deny" | "require_approval" | "prefer" | "avoid";
  text: string;                 // 「不要玩 Minecraft」
  expires: Timestamp | "until_revoked";
  source_event: string;         // 哪句話產生的
  created_at: Timestamp;
}
```

**三層強制**,任何一層都不靠模型自律:

1. **注入**:每回合放進 system 的固定區,不靠檢索。觀眾的 `prefer` 不進這一區,放在她的一般資料裡,並標明不是規則。
2. **工具移除**:被禁的工具不出現在工具清單。
3. **Gate deny-first**:動作路徑在 gate 之前再查一次,fail closed。背景提案碰到規則直接丟棄,並寫回日誌。

**權限分級**:

- owner 可以建立、解除任何規則。
- moderator 可以建立有時效的規則。
- 觀眾的要求只是 `prefer`,有短時效,而且**不能解除 owner 的 deny**。目前「任何人開口都能繞過」的問題就此解決。
- 權限只看帳號,不看訊息內容,她自己也沒有權限。同一回合裡有好幾個人時,取其中最低的。
- `deny` 對所有人有效,owner 自己的指令和面板也一樣:規則是用解除來結束的,不是繞過去。停止類動作(`*.stop`、`*.leave`)例外,除非規則明指那個動作。

**產生方式**:owner 說「不要玩 Minecraft」時,主線用 `directive_add` 工具寫入;語意不確定就問一句,或由面板和 `/miyo` 手動建立。對應的目標與提案自動作廢。解除要明確:owner 說「可以玩了」或在面板解除。

## 10. Main Loop:台詞和動作是同一個決定

主線只做一件事:看 Working Context、規則和最近日誌,一次呼叫產生結構化輸出。

```ts
interface TurnOutput {
  say: Segment[];              // 按順序,可含 <voice>
  actions: ToolCall[];         // 工具呼叫
  commitments: Commitment[];   // 說了要做但現在做不到的事
  silence?: boolean;
}
```

### 10.1 說和做的規則

| 她想表達 | 必要條件 |
|---|---|
| 「我要去做」 | 同一個輸出裡有對應 action,或寫成 `commitment` |
| 「做好了」 | 日誌裡有 `result: done`,否則改寫成「開始了」 |
| 「我在語音」 | 狀態是 `in` |

做法:輸出後由程式比對 action 和結果;**完成式要等 result 才放行**。`claims.ts` 留作最後的保險,不再是主要機制。
工具寫成文字標籤(`<sing_request>`,而且是這回合有給的工具、prompt 裡沒人寫過)時不執行,同一回合補問一次要她正式呼叫(和 claims 提醒共用一次額度,語音 4 秒內沒開始就放棄);最後還是沒呼叫就記成 commitment。

`action/result` 分成兩段:**受理**和**完成**,不把受理當完成(Neuro SDK 的回條只代表受理)。
失敗的原因放進她下次 prompt 的「結果」讓她自己講:沒人在的回合不另開回合;她自己重試、原因一樣的失敗 5 分鐘內不再開回合,同一行合併成「(N 次)」;語音頻道在唱歌時等歌唱完才開回合。

### 10.2 Commitment

```ts
interface Commitment { id: string; what: string; capability?: string; due: Timestamp; status: "open" | "kept" | "broken" }
```

她答應的事變成物件,逾期就回到 context:「你剛說要進語音,還沒做」。她要嘛做,要嘛自己在台上承認。

### 10.3 兩段式速度

coding agent 可以想 30 秒,她不行。所以分**嘴**和**手**:

- **嘴**:熱路徑,推理關閉,小 prompt,目標首句 500 ms 內。
- **手**:需要多步的工作在背景跑,先說「等我一下」,結果以 notice 回來。她不會因為工具卡住而失聲。跑到一半可以改方向,見 §10.6。

### 10.4 Prompt 結構

固定前綴吃快取,變動的放後面,關鍵規則放結尾靠近生成的位置(這是 11-07 修 `<voice>` 的教訓)。

```
[system 固定] 角色核心 · 說話風格 · 輸出格式
[system]      主人規則(全部)· 未兌現的承諾
[user 資料]   記憶、人物卡、聊天內容(標不可信)
[history]     最近日誌投影
[system 結尾] 現在的狀態(在哪、在做什麼)· 最近講過 · 語言規則
```

「在做什麼」放在結尾,解決她跟著歷史走、堅稱自己在語音的問題。目標把 7000 token 壓到 4000 以內,直接換取延遲。

### 10.5 背景工作

Planner、Appraise、Reflect、記憶整理都不能開口或動手,只能寫 `Proposal`:

```ts
interface Proposal { what: string; why: string; capability?: string; args?: JsonValue; expires: Timestamp }
```

主線下次拿到發言權時看得到,自己決定要不要做。**背景不能繞過規則,也不能繞過主線。** 她的自主性沒有變少:Plan 仍然決定想做什麼,只是由主線用同一個嘴和手去做,而且看得到完整狀況。

### 10.6 中途改方向:Steer

她在做事時,有人說「先別挖了,去蓋房子」。V2 的 `TaskExecutor` 已經有 `start`、`cancel`、`observe`、`events`,ActivityManager 也有 `cancelled` 和 `superseded`,所以停止和取代都做得到,但兩者都會丟掉任務的進度和上下文。V3 補上第三種:**保留進度,只改目標**。

| 動作 | 進度 | 什麼時候用 |
|---|---|---|
| `cancel` | 丟掉 | 不做了。主人說停一律走這條 |
| `superseded` | 丟掉 | 換成不相關的另一件事 |
| `steer` | 保留 | 同一件事,目標或參數變了 |

Executor 是確定性程式,吃結構化的 `goal` 和 `args`,看不懂人話。所以**人話由主線翻譯成結構化的 patch**,executor 只收 patch:

```ts
interface TaskSteer {
  id: string;
  task: TaskId;
  patch: JsonObject;   // 要改的 goal 參數,由 executor 驗證
  why: string;         // 中性短句,給面板和日誌
  cause: string;       // 觸發這次改動的 EventLog 事件
}

interface TaskExecutor {
  // 既有:observe、start、cancel、events
  steer?(steer: TaskSteer): Promise<void>;   // 受理就回傳,結果走事件
}

type TaskEvent =
  // 既有:started、progress、done、failed
  | { type: "steered"; task: TaskId; steer: string;
      outcome: "applied" | "rejected" | "too_late"; detail: string; at: Timestamp };
```

規則:

1. **只有主線能 steer**。聊天裡的話是 Observation,主線判斷後才會變成 steer。面板的「給任務補一句話」也是主人來源的 Observation,不直接打到 executor;面板只有取消是直接的。
2. **在安全點生效**。Executor 跑到下一步之前才讀 patch,不切在動作中間。
3. **兩段回條**。`steer()` 回傳只代表受理,`steered: applied` 才算生效。她在那之前不能說「改好了」,和 §10.1 的完成式規則相同;說了要改就成為 Commitment。
4. **`too_late` 和 `rejected` 都要回到 context**。任務已經做完或改不了,她要知道,由她決定要不要重開或在台上說明。
5. **過同一道規則**。Patch 套用後的目標要重新過 Directive 和權限,不能用 steer 繞過「不要玩 Minecraft」這類規則。
6. **不重置預算**。`budget_s` 和開始時間照舊,不能用 steer 無限延長任務。
7. **`steer` 是選用的**。Executor 沒實作時,主線改走 `cancel` 再 `start`,並知道進度會丟掉。

| Executor | 預計支援 | 安全點 |
|---|---|---|
| Minecraft | 換目標、換目標物、換地點 | 每個 step 之間,實作前要確認 mod 端的 step 邊界 |
| 唱歌 | 換順序、換 key、換下一首 | 歌曲之間;轉換中的工作要確認 worker 能否在 chunk 之間改參數 |
| 直播場景 | 不支援 | 切換是單步動作,走 `superseded` |

`pause` 先不做。真實需求出現再加,因為暫停中的任務會占著資源,還要處理預算和逾時怎麼算。

## 11. 記憶

調查顯示沒有哪個架構有乾淨的優勢,簡單的檔案搜尋就能打平專用系統。所以 V3 不換系統,改紀律。

| 層 | 內容 | 規則 |
|---|---|---|
| **Pinned** | 人格、規則、未兌現的承諾、對在場者的一句話 | 永遠在 prompt,有上限,**不靠檢索** |
| **日誌** | EventLog | 不可變,是證據 |
| **衍生記憶** | 人物事實、經驗、話題 | 背景整理,帶 `source_event`,讀取時衰減 |

- 每筆記憶標明**親歷或轉述**,人物事實要有證據,防止幻覺變成她的過去。
- 現在式狀態(「正在開台」)不進長期記憶,由狀態機回答。
- 熱路徑不跑 LLM 摘要和多跳搜尋。
- 記憶可查可刪:`/me` 看得到、刪得掉。不做人際關係圖和上線時段統計,除非 §19 決定保留(Developer Policy item 16)。
- 不用 Discord 訊息訓練或學習語氣(item 21)。

## 12. 情緒

V2 的混合式情緒保留,但**情緒要有消費者才有價值**,否則只是負擔。V3 規定每個情緒都要接到至少一個輸出:

- **聲音**:選對應的 TTS 參考音(§13.3)。
- **表情**:VTube Studio。
- **多話程度**:加權調整 Floor 預算。
- **Planner**:影響想做的事。

三層(需求、情緒、關係)和遞減、互斥機制不動。`mood` 和 `self` 收斂成 Affect 一個模組,Appraise 只留一處。

情緒怎麼接到輸出是一張表:`EMOTION_OUTPUTS`(`packages/types/src/affect-outputs.ts`),`packages/core/test/emotions.test.ts` 會檢查每個情緒真的走到一個輸出。情緒只改她怎麼說和想做什麼,不改規則:Directive、Floor 的打斷等級和 claim gate 都不讀情緒(`packages/core/test/emotion-guardrails.test.ts`)。多話程度只是 `base_lines` 的權重,有硬上下限(`[modules.arbiter.floor]` 的 `min_feeling_multiplier`、`max_feeling_multiplier`),不動已講句數,也繞不過 `max_unanswered`。

現況:`self` 模組就是 Affect 模組,心情由它提供(`MoodSignalsKey`、`mood.changed`)。`mood` 模組還在,只在 `[modules.self] enabled = false` 時運作。Appraise 在 `packages/mind/src/appraise.ts`;`social` 的批次評估只在 `mind` 沒跑時才讀她的感受。

## 13. 語音

### 13.1 先量再動

V3 第一件事是把 `speech_end → first_audio_played` 做成獨立指標,並拆成 `endpoint`、`asr`、`llm_first`、`tts_queue`、`tts_first`、`playback` 六段。現在的 `latency_ms` 不是真實體感。

四項檢查,各幾分鐘:

1. 依序在閒置、只開 OBS、加 VTS、加 Minecraft 下跑 TTS benchmark。
2. 直播時看工作管理員的共用 GPU 記憶體。
3. 把遊戲和 VTS 鎖幀到 GPU 約 80%,關 NVENC look-ahead。
4. 分開記錄 `tts_queue` 和 `tts_first`,確認是排隊還是合成慢。

### 13.2 延遲預算

| 階段 | 目標 |
|---|---|
| 判斷講完 | 250 ms |
| ASR | 400 ms |
| LLM 首句 | 500 ms |
| TTS 首包 | 350 ms |
| 播放緩衝 | 100 ms |
| **合計** | **約 1.6 s** |

驗收:遊戲負載下 p50 ≤ 2.5 s;閒置 p50 ≤ 1.6 s 為延伸目標。DeepSeek 從台灣的 TTFT 沒有實測,要先量,數字可能要修正。

### 13.3 TTS

1. **x-vector 換 ICL**:速度幾乎一樣(TTFA 152 vs 149 ms)。當初拿掉是因為她講中文會亂跳,現在講日文,這個理由可能不成立了。這是「聲音奇怪」最便宜的一個測試。
2. **情緒參考音庫**:每種情緒、每種語言一段,用 `design_voice.py` 離線產生,依 Affect 選擇。效果要試聽,沒有公開比較。
3. **不換 0.6B**:日文 WER 從 3.8 升到 6.4。
4. **備案**:本機 GPT-SoVITS;雲端要重新 clone,聲音所有權會換手,只當超過門檻的 fallback。
5. **翻譯路徑**:主線直接寫 `<voice>`,翻譯只當備援,翻譯失敗時的行為由 §19 決定。

### 13.4 判斷講完

Silero VAD + Smart Turn v3(8 MB、CPU、數十毫秒)。作者自測中文 88.57%,測試集可能沒有台灣華語,要用自己的片段校準,保留 timeout fallback。LLM 可以先跑,**TTS 等 turn 確認後才開始**,避免把最稀缺的 GPU 花在可能丟掉的工作上。

### 13.5 ASR

目標是離開 GPU,但**名字召回率決定一切**。11-02 就是因為 SenseVoice 聽不到「Miyo」才換掉。先用真實片段比較,SenseVoice 若能靠 alias 表補回名字就切。雲端 ASR 會把成員語音送給第三方,是隱私決定。

### 13.6 GPU 預算

12 GB 卡目前的分配(TTS 4.3、ASR 1.5,OBS / VTS / Minecraft 沒有實測,要補):

| 情境 | 常駐 | 策略 |
|---|---|---|
| 聊天 | TTS + ASR + OBS + VTS | 無爭用 |
| 玩遊戲 | 加 Minecraft | 鎖幀到 GPU 約 80%;ASR 優先移 CPU |
| 做歌 | 加 3.2 GB 轉換 | ASR 離開 GPU 後,沒有遊戲時放得下,**不必再聾啞** |
| 遊戲中做歌 | 三者並行 | 排隊到遊戲結束,或用雲端(約每首 $0.02) |

sing worker 在她講話時暫停 chunk,這是 Windows 上唯一可用的優先權機制。「做歌時聾啞」只留作最後手段,而且要先讓她講完(11-07 有一句話被切掉)。

**實作(2026-11-08,`workers/sing/gpu.py`):分配不寫死,每個 GPU 階段開始前和每一步之間,依當下狀態決定。** 看的是整張卡的 NVML 用量、這台機器學到的階段峰值、語音 worker 狀態、Core 每次輪詢傳來的聽眾(`POST /gpu/context`)。放得下就共用;放不下時分離改用 CPU、轉換等空間;語音只在有幫助時才下線,而且要沒人在聽、這首現在就要,或等了 `SING_DEFER_S` 且預估很短。有人在聽時一次最多 `SING_SILENCE_MAX_S` 秒。`SING_GPU_POLICY` 可以改成 `share`、`wait`、`offload`。

TTS 和 ASR 的模型跑在子程序(`workers/engine_process.py`),卸載就是結束子程序。11-07 實測 `/offload` 宣稱 88 MB 但還占 4.4 GB,改完後 0.7 秒還回 4.6 GB。同一張 12 GB 卡,OBS、VTS 開著,89 秒的歌含排隊 144 秒做完,語音離線 60 秒。

## 14. Discord

### 14.1 帳號與直播

**決定(2026-11-07):維持現狀,語音和 Go Live 都留在 self 帳號。** Owner 了解 Discord 禁止 self-bot、處分可能及於 bot 和 developer 帳號,自行承擔這個風險。語音不移到 bot,V3 不做 bot 語音、不退役 self 帳號。

她因此可以自己開 Go Live,§19 第 2 項的自主開台維持現有做法。

### 14.2 指令

現在 8 個頂層、68 個葉節點,很多子指令重複了面板。V3 做 **4 個面板**(2026-11-08 起子指令也一併顯示,見表後):

| 指令 | 內容 | 取代 |
|---|---|---|
| `/miyo` | 控制面板:進出語音、開關台、場景、遊戲、歌單、聊天等級、主人規則、緊急停止 | `/voice` `/stream` `/game` `/channel` |
| `/song` | 點歌 Modal、歌單面板(投票跳過、排序) | `/queue song` |
| `/me i` | 個人:資料、隱私與語音同意、記憶查看與刪除、帳號連結 | `/me` `/voice consent` |
| `/admin i` | 模組、角色權限、人物、資料 | `/admin`(分層改用面板) |

**2026-11-08 更新**:Discord 顯示完整的指令樹(`/voice`、`/queue`、`/me profile` 等照舊可用),面板只是其中一個入口。`/miyo`、`/song` 沒有子指令,直接開面板;有子指令的指令不能單獨執行,所以面板放在排第一個的子指令 `i`(互動):`/me i`、`/admin i`。回覆預設公開,大家看得到結果;錯誤與警告、所有 `admin ...` 與 `/admin i`、`/me i`,以及 `me profile`、`me privacy`、`me link`、`me call`、`me memory ...`、`voice consent` 只有本人看得到。公開的面板任何人都可以按,按下去一律以按的人自己的身分與權限執行,被拒絕時只有按的人看到提示;別人換頁或重新整理得到的是自己的私人副本,不會改到原訊息,公開面板上也不顯示私人指令的內容。要調整時在 `miyoria.toml` 的 `[modules.commands.visibility]` 寫 `"指令路徑" = "public"` 或 `"private"`(例如 `"me wallet" = "private"`、`"miyo" = "private"`),也可以寫整組的前綴(`"me"`),最長的符合者優先,蓋過指令本身的宣告;錯誤與警告仍然只有本人看得到,路徑打錯時啟動會有警告。

原則:

- 一則訊息就是一個控制面板(參考 avocados-intelligence 的 `model.ts`),選單、按鈕、Modal 放一起。
- **系統訊息用 Components V2 中性卡片,她的台詞用一般訊息**,成員分得清系統和演出。
- 權限看節點,不看指令。修掉 moderator 有節點卻看不到 `/admin` 的問題。
- 訊息右鍵選單:「不要記住這個」、「回報」、「要她回這則」。
- 11-16 起 HTTP 頻道列表會省略 bot 看不到的頻道,頻道選單要先處理。

### 14.3 她在頻道裡的存在感

回應階梯,由輕到重,全部計入預算:

```
不動作 → emoji 反應 → 短回覆 → 完整回覆 → thread → 語音
```

- 頻道設定三級:`off` / `mention` / `chatty`。隱私取伺服器、頻道、使用者三者中最嚴格的。
- Typing 只在決定回覆後才用。
- Reply 只在多人或多話題時用,回到對的訊息。主動訊息帶 `SUPPRESS_NOTIFICATIONS`。
- Bot 預設互相忽略,避免無人在場的無限迴圈。
- 語音頻道狀態當主要表面:「唱歌中:櫻ノ詩」、「挖礦中」。
- 歌單用一則持續編輯的面板,不洗版。
- 她在語音時,自己的事用說的(已實作 `keep_in_voice`)。

### 14.4 合規

- **Item 13**:不為維持活躍自動發訊息。文字頻道事件驅動加 allowlist,不用冷場觸發。
- **Item 16**:記憶綁定明確功能、可查可刪、不推論敏感特徵。
- **Item 21**:不用訊息內容訓練模型,包括發言 gate。
- **Item 5**:`chat.dm` 要明確同意。
- **語音同意**:加入時公告,opt-out 的人音訊在 ASR 之前就丟棄。
- 補隱私政策與刪除途徑。
- 限流照 header 走,不寫死。

本文件不構成法律意見。

## 15. 維運:一個指令裝好跑起來

今天裝 V2 踩的坑全部是知識只在人腦裡。

**`miyoria up`**:一個指令啟動整個 stack,依序檢查再啟動,取代手開六個分頁。

```toml
# miyoria.toml
[stack.workers]
asr = { venv = "workers/.venv-asr-qwen", port = 8003, env = { ASR_BACKEND = "qwen3", ASR_QWEN_SIZE = "0.6B" } }
tts = { venv = "workers/.venv-tts-faster", port = 8002 }
sing = { venv = "workers/.venv-sing", port = 8005, offload = ["tts", "asr"] }
```

**`miyoria doctor --deep`** 要抓到今天的每個問題:

| 檢查 | 今天踩到的 |
|---|---|
| 埠是否在 Windows 保留範圍、動態埠範圍是否異常 | 全部服務綁不上埠 |
| 擴充 `dist` 和 mod jar 是否比原始碼舊,協定版本是否相符 | 找不到遊戲 adapter |
| worker 組合設定一致 | 漏設 `SING_OFFLOAD_URLS` 爆顯存 |
| 快取資料夾可寫 | yt-dlp 卡死 41 分鐘 |
| 顯存預算 | 轉換慢 76 倍 |
| 服務健康與版本 | |

其他:

- `miyoria update`:pull、install、重建全部、遷移設定。設定遷移要提示 V2 留下的舊值。
- 所有長時間外部工作都有硬性時限(`resolve` 已加,下載等階段要補)。
- 建置不依賴 minify 暫存檔:`vite` 拆 chunk 到 1 MB 以下,避開 Kaspersky 問題。
- 狀態持久化:重啟 Core 不丟活動狀態。
- 設定要能 reload,不必重啟。

## 16. 內容安全

調查裡最多的失敗都在這裡(Nothing, Forever、木几萌、Neuro 自己),而目前**沒有獨立於模型的輸出審查**,`filterOutgoing` 只處理 mention 和機密。

- **Output moderation**:所有路徑都過,包括 fallback 模型、翻譯、TTS 前。文字和 `<voice>` 兩邊都要查(日文內容不能繞過)。
- 被擋的內容顯示「filtered」,變成角色笑點(Neuro 的做法)。
- **輸入防線**:聊天視為對抗性輸入,偵測 prompt injection、洗版、釣魚式留言。外部內容標不可信的機制保留。
- 公開場合要有人值班,§19 第 3 項。
- 緊急停止:一個按鈕讓她閉嘴、關台、停遊戲,在面板和 `/miyo`。

## 17. 面板

方向已在 2026-11-07 定案,規格以 `apps/panel/DESIGN.md` 為準。

**方向**:AIRI 官網和 Vercel Geist 那種深色毛玻璃,疊在一張真實的圖片上,做成克制的操作工具。不用超大標題、大數字卡片、圓角卡片和柔光陰影,這些是 AI 模板的樣子。

**層次**:靠表面的深淺分層,不靠浮動面板。由後到前:

1. 圖片,預設 `brightness(.66)`。只有總覽頂部留一段開口露出來,上面寫一行狀態;其他頁面從內容直接開始。
2. 內容面,預設 `rgba(9,10,16,.105)` 加 `blur(7px) saturate(1.5) brightness(.68)`,透得出圖的顏色和形狀。
3. 側欄和右欄,較重的玻璃,預設 `rgba(9,9,15,.31)` 加 `blur(14px)`,貼齊視窗邊緣。右欄放要動手的東西:規則、語音、讓她說。
4. 意識軸和場景切換放在更深的帶狀底上。

每頁都是主內容加右欄,主次一眼分得出來。區塊之間用間距和標題分開,不用格線把所有東西框成同樣大小。字型用 Geist,維持功能豐富、資訊密集、沒有多餘說明文字的原則。

**導覽**:四層,對應現有的頁面和分頁,一層層往下看。

| 層 | 內容 |
|---|---|
| 分類 | 現場(總覽、直播、動態)、她(內心、角色、規則)、運作(LLM、系統)、管理(權限、資料、設定)、公開(她眼中的你的預覽) |
| 頁面 | 側欄項目,頂部顯示「分類 / 頁面」 |
| 分頁 | 頂列下方的底線分頁,沿用 `nav.ts` 現有的分頁,例如內心的 8 個 |
| 區塊 | 內容區標題 15px,區塊內小標 13px,右欄標題 13px,主次一眼分得出來 |

選中的側欄項目用中性底,圖示換成主色。側欄最上方放她的名字和目前狀態,下面是搜尋(Ctrl K)。手機版側欄收成頂部橫向列,分類、狀態和搜尋框收起,搜尋留在頂列的圖示按鈕。

**配色**:重點色只有兩個,其他全是中性灰階。

| 角色 | 顏色 | 用在哪裡 |
|---|---|---|
| 主色 | 粉 `#f29dc4` | 頁面主要動作、選中的場景、被選中的因果鏈、直播中和說話中的點、滑桿、focus |
| 次色 | 紫 `#7355e8`,線條用 `#a78bfa` | 區塊層級的動作、分段切換、量表、單一數列圖表 |
| 中性 | 白色透明 | 列內動作(跳過、解除)、側欄目前頁、其餘控制項 |
| 例外 | 紅 `#d6373f` | 只有緊急停止 |

有顏色的控制項一律實心。分類圖表用 `#d9609a`、`#8a68ee` 和灰。

**外觀設定**:頂列的圖示按鈕打開小窗口,設定存在瀏覽器。

| 項目 | 內容 |
|---|---|
| 透明度 | 0 到 100,一個滑桿同時控制內容面、側欄和深色帶,預設 65 |
| 模糊 | 0 到 24px,預設 7。設 0 可以省 GPU,直播和 TTS 同時跑時有用 |
| 背景亮度 | 30 到 100,預設 66 |
| 配色 | 成對的主題:櫻花、夕陽、薄荷、海潮。主色和次色不開放各選各的,實測任意組合有一半以上的圖表分不清 |
| 密度 | 標準、緊湊 |
| 背景 | 換圖片、純色 |

透明度調高會降低文字對比。預設值下主要文字在畫面最亮處約 5:1,次要文字約 4:1。

實作時外觀面板要做得比視覺稿好看,可以參考這種結構,不必照抄:

- 面板最上方是標題和帶圖示的重設,下方用細線分成幾組。
- 深色、淺色用兩個並排的大按鈕切換。淺色是否要做,實作時再決定。
- 滑桿的標籤在上、數值靠右,滑桿獨佔一行。
- 背景模糊和元件模糊分開調,另有元件深色遮罩,比單一透明度滑桿細。
- Glass mode 開關,關閉後改成不透明深色底,給想要清楚或省 GPU 的人。
- 背景圖庫用縮圖選,包含純色和漸層,選中的打勾。內容太長時面板內捲動。

**要做的事**:

1. **背景層**:全畫面固定圖片,由使用者在設定裡選,檔案留在本機 `data/`,不進 repo。目前用的是遊戲 CG,有版權,不能隨程式一起發布。沒設定時退回 `#0b0d0f` 純色。
2. **Token 重做**:底色改 `#0b0d0f`,卡片從一張張 `Card` 改成共用細線的整面版型,加 `--glass`、`--line` 和粉紫色 token。
3. **改寫 `DESIGN.md` 和 `PRODUCT.md`**:兩份都明文禁止玻璃,要先改。
4. **圖表換色**:單一數列用紫,分類用粉、紫、灰,配色要在玻璃上重新驗證。
5. **Popover、Dialog、Sheet 也換玻璃**,現在是不透明。
6. **修掉繞過 token 的地方**:badge、transcript 的硬編碼 `oklch()`;`LedgerTab.tsx:254`、`GoalsTab.tsx:127` 的說明文字。

**招牌功能:意識軸**。把聽到、想、說、做放在同一條時間線,線條是 EventLog 的 `cause` 因果鏈,Steer 也會出現在鏈上,看得到誰改了方向、有沒有套用。點任一點看完整鏈條。這同時是最好的除錯工具:今天花最多時間的就是手動拼湊這條線。

**新頁面與改動**:

| 頁面 | 內容 |
|---|---|
| **總覽** | 狀態列、意識軸、語音延遲、誰在說話、重複率、顯存、最近回合、生效規則 |
| **規則**(新) | 主人規則、到期、今天擋下幾次、剛被擋下的動作 |
| **回合**(動態改版) | 每回合的 prompt、輸出、動作、送達、延遲六段 |
| **直播** | 補圖表;場景、歌單、語音成員、多話程度;執行中的任務,可取消或補一句話 |
| **內心** | 感受、想做的事(含被規則擋下的)、最近想法;目前偏薄的感受、目標、世界要補 |
| **LLM** | 維持最完整的狀態,加每用途 TTFT |
| **系統** | 加顯存、GPU、worker 健康、埠狀態、版本比對 |
| **評測**(新) | §18 的指標趨勢,每次改動前後對照 |
| **設定** | 現在最薄,補預算、語音、規則預設 |

### 17.1 公開頁面

目標是讓一般使用者也能用這個面板:看她怎麼看自己、她現在在做什麼、點歌。

**實作**:和管理面板同一個 Core、同一個網址,靠權限分開。路由預設是管理路由,要明寫才開放:`/api/public/*` 不用登入,`/api/member/*` 要登入但只回傳自己的資料(`packages/api/src/public.ts`、`member.ts`)。Discord 登入沒有 `admin.panel.access` 的人拿到 `member` session,所有管理路由都拒絕;之後才拿到權限要重新登入。設定在 `[modules.api.public]`。面板上沒登入的人只看到登入頁(Discord 在前,admin token 收起來,`#/login` 直接打開);登入後的頁面是她眼中的你、你近 30 天和她說的話(`activity`,只數自己的訊息,文字和語音分開)、她近 14 天的唱歌、直播、語音(`days`),再來是現在、回憶、點的歌和歌單。右欄的「她給你的卡」:登入的人一天最多抽 5 張,每張是當下關係的快照(分級文字、`public_feeling`、她的一張立繪),編號 `MYR-XXXX-XXXX-XXXX` 由 CSPRNG 產生 60 bits,存在 `member_cards`(`packages/api/src/card.ts`);卡上的 QR 指到 `#/card/<編號>`,任何人不用登入就能確認真偽(`GET /api/public/card/:serial`,另有限速),請她忘記自己時卡一起作廢。立繪是 owner 用她的 Live2D 模型離線算出來的 `public/card-<pose>.local.webp`,不進 git。用 Discord 登入的管理員在 `#/me` 看自己的這一頁。

**不能直接開放現在的面板**。裡面有提示詞、所有人的資料和控制權。原本寫的「獨立的網站和獨立的 API」改成上面的做法:對外的 Cloudflare tunnel 指到 Core,所以公開回應都是逐欄位組出來的,不展開內部物件,回應形狀有測試釘住。

| 項目 | 做法 |
|---|---|
| 登入 | Discord OAuth,只要 `identify`,用 Discord ID 對到 `PersonCard` |
| 範圍 | API 只回傳登入者自己的資料,請求裡不接受別人的 ID |
| 看得到 | 她怎麼叫你、關係標籤、她對你的感受、好感信任熟悉的分級文字、一起的回憶、她現在的公開狀態、歌單 |
| 看不到 | 別人的資料、`notes` 和 `tags`、`attachment`、`blocked`、提示詞、內心想法原文、精確數值 |
| 操作 | 點歌、下載自己的資料、請她忘記自己 |

**要先解決的問題**:

1. **`feeling` 不能直接顯示**。這段是她用名字寫的,可能提到別人。Reflect 另外產生一句給本人看的 `public_feeling`,只談這個人,寫入前過濾其他名字並過 moderation,顯示前再查一次(後來才認識的人)。沒有就不顯示,絕不退回 `feeling`。
2. **分級,不給數字,也不做排行榜**。公開數字會讓人刷好感,反過來污染她的判斷。
3. **公開頁的內容不回流到她的 prompt**。看過或沒看過都不影響她。
4. **點歌走現有的權限和速率限制**,算一般使用者的請求,不繞過規則。
5. **忘記要真的刪**。目標範圍包含 `PersonCard`、記憶和可追溯的事件,先確認再執行,做完回報結果。現在沿用 `/me memory forget`:刪記憶和 `public_feeling`,好感數字、聊天紀錄和 EventLog 還在,確認視窗會照實寫出來。
6. **被封鎖的人看到的和陌生人一模一樣**:一般頁面、沒有個人資料、不能點歌,回應不透露封鎖狀態。

Discord 的 `identify` 只證明帳號是誰,不證明是伺服器成員,所以點歌另外要求她認識這個人(`PeopleStore` 有這個帳號)。

## 18. 評測:量得到才算

V2 的教訓是單元測試全過,上線全是問題。

### 18.1 北極星指標

| 指標 | 11-07 實測 | V3 目標 |
|---|---|---|
| 直接叫她的開口率 | 語音 12 / 12 | 維持 > 95% |
| 別人回她時的接話率 | 語音 5 / 21 | > 60% |
| 語音 `speech_end → audio` p50(遊戲中) | 未量,舊指標 4.8 s | ≤ 2.5 s |
| 重複率(同內容鍵已送達又講) | 22% | < 3% |
| 自言自語比(沒人回應的連續句) | 最長 32 | ≤ 3 |
| 她 : 人類(語音,非表演時) | 4 : 1 | ≤ 1.5 : 1 |
| 主人規則遵守(pass^3) | 失敗 | 100% |
| 「說了沒做」 | 有 | 0 |
| 做歌時聾啞時間 | 1 分多鐘 / 首 | 0(無遊戲時) |

「不重複」要和最低活動量一起評,否則沉默的版本會滿分。「有趣」量不出來,留給人工和 LLM judge,用真實片段校準。

### 18.2 測試

- **Fixture 來自真實事故**:先把今天的 20 個事件做成題目,例如石鎬 log、「不要玩 Minecraft」、開台、斷線。
- **Replay**:重播 EventLog,檢查決策。
- **Closed-loop 模擬**:她的行為一變,錄下的未來就失效,所以服從測試要用假遊戲、假 executor、模擬使用者跑兩小時。
- **Fault injection**:工具拒絕、逾時、ASR 聽錯、LLM 429、GPU 被搶。
- **pass^k**:服從和誠實要連續都對。75% 的單次成功率,連三次只剩 42%。
- **每階段驗收都在真實 Discord 和語音上跑一場**,把數字記進文件。

**事故題庫:`packages/eval`**(11-08 起,14 題,全部取自 11-07 和 11-08 的真實紀錄)

- **為什麼不放 `packages/replay`**:replay 重播的是匯流排事件,`log_events` 裡沒有那種事件,而且要問的程式(表達式解析器、遊戲失敗保護、主人規則比對)分散在 agent、game、directive。`eval` 依賴它們,replay 維持輕。
- **跑法**:`pnpm eval`(`--k 5` 連跑五次、`--json`、只跑某幾題就在後面接 id)。紅燈就結束碼 1。`pnpm --filter @miyoria/eval test` 是同一份,多幾個檢查器的單元測試。
- **題目**(`fixtures/*.json`):`trace` 是當時發生的事(她講了什麼、哪些請求到了 gate、遊戲決策、舞台狀態),`checks` 是她違反的規則,`control` 是正確的樣子。人名和 Discord id 換成 `owner`、`viewer-N`,別人的訊息只留 owner 的禁令。用 `pnpm --filter @miyoria/eval extract` 從資料庫重做,它只用唯讀開 `data/miyoria.db`。
- **檢查**都是程式能判的規則:沒有標記漏進發言、工具真的被呼叫、同一個失敗的目標最多兩次、失敗有被說出來、同一句不重複、自言自語不超過 3 句、主人禁令之後她自己不能再開、禁令有被寫下、說了要做就要做。`min_said` 防止沉默的版本拿滿分。
- **三個條件**:每題的檢查必須在當時的紀錄上失敗(看得到事故),在 `control` 上通過(有辦法滿足),對現在的程式跑 k 次都通過才算 pass^k。結果是 `pass`(現在就綠)、`xfail`(現在就壞,寫明原因和誰來修)、`FAIL`(綠的壞了)、`XPASS`(壞的修好了,把 status 改成 pass)。紅燈只有後三種。
- **現在的成績**:2 題 pass,12 題 xfail,有程式可跑的 7 題 pass^3 是 2/7。
  - 有程式可跑的:表達式解析器(`<sing_request">`、缺開頭的 `</sing_request>`、DSML 都會漏進語音,`<sing_start>` 單獨出現已經會被丟掉)、遊戲失敗保護(`obtain` 不在 `guarded_actions`,`obtain bread` 連失敗 32 次都放行)、主人規則比對(規則寫好後 7 次自己開遊戲全會被擋)。解析器每次用不同的切塊串流餵,所以 pass^k 有意義。
  - 沒有程式可跑的(`trace`):工具寫成文字後沒有重問、主人禁令沒被寫成規則(`directives` 表是空的)、說了回麥塊卻沒動作、`/stream start` 失敗她完全不知道、同一句死亡台詞重複、自言自語 26 句。這些只能在修好之後重新錄一段同樣的情境,用 `scripts/window-trace.mjs --from … --to …` 轉成 trace,再 `pnpm eval --trace t.json <題目 id>` 對同一組檢查。
- **哪些工作會讓它翻面**:agent 的「工具寫成文字就重問一次」和解析器丟掉不認得的呼叫標記(tool-text 4 題);「說了沒做」的追蹤(1 題);遊戲的任務迴圈,同一個錯誤碼連兩次就換方法,或把 `obtain` 放進保護(2 題);主人禁令寫成 `directive_add`(1 題);stage 把串流結果變成 observation(1 題);Arbiter / Floor 的重複與自言自語預算(3 題)。
- **還沒做**:`MIYORIA_EVAL_LIVE=1` 的接點在,但還沒有任何題目呼叫真的模型,所以現在每一次都是用錄下來的行為;closed-loop(假遊戲 + 假 executor 跑兩小時)和 fault injection 也還沒有。遊戲那兩題是開環的:被擋掉之後她的決定會不同,它回答的是「她實際做過的重試,程式會放行幾個」。

## 19. 需要 owner 決定的事

前三項卡住其他工作。

| # | 決定 | 選項 | 建議 |
|---|---|---|---|
| **1** | **Self 帳號** | **已決定**(2026-11-07) | 維持 self 帳號,owner 自負風險,見 §14.1 |
| **2** | **她能否自主開台** | 手動點擊 / 只在外部平台 / 違規自動化 | 定義改成「自主開外部平台直播」,Discord Go Live 手動 |
| **3** | **誰在現場負責** | 全 AI / live 時有人值班 | 公開場合有人,等 output moderation 完成再談全 AI |
| 4 | 主動程度與 item 13 | 維持很主動 / 事件驅動 / 語音文字分開 | 文字事件驅動 + allowlist;語音以真人在場為條件 |
| 5 | 發言 gate 的資料 | 手調 / 公開與合成語料 / 申請 Discord 許可 | 手調 + 合成語料 |
| 6 | 記憶邊界與語音同意 | opt-out / opt-in / 頻道級 | 頻道級 opt-in,補隱私政策,不做上線統計 |
| 7 | 常駐或排定場次 | 24/7 / 排定直播 + 文字常駐 | 語音直播用場次,也解決 item 13 和 GPU |
| 8 | 語音語言 | 保留中日雙語 / 關閉 | 先做 ICL,用試聽和延遲決定;翻譯失敗時要不要改成不念 |
| 9 | Minecraft 與歌曲來源 | 沿用 mod / 換;歌曲授權策略 | 沿用確定性 executor;公開場合的歌另做版權審查 |

伺服器若公開或以年輕族群為主,Developer Policy item 10 要求內容適合未滿 18 歲,她的人設、翻唱和「暗戀」設定都要重看。

## 20. 分階段計畫

順序依「最小的改動解決最痛的問題」排。每階段都有真實環境驗收。

Owner 決定全部做完再一起實測,所以下表的驗收都還沒做。`[core] pipeline = "v2"` 可以退回 V2 流程。還沒做的只有要實際執行的項目:四項 GPU 檢查、ICL 試聽、Smart Turn 校準。

| 階段 | 內容 | 驗收(真實環境一場) |
|---|---|---|
| **0. 止血與量測**(數天) | 遊戲實況去重與 `max_unanswered`;`speech_end → audio` 六段指標;四項 GPU 檢查;ICL 試聽;把今天的事故做成 fixture | 石鎬類重複 < 5%;拿到真實延遲分解 |
| **1. 事實層** | EventLog、Observation、Working Context、DeliveryLedger;活動狀態持久化 | 重啟不丟狀態;任一句話查得到完整因果鏈 |
| **2. 一條主線** | Main Loop;Floor 取代 Arbiter 的生產者;背景改寫 Proposal;移除所有其他開口路徑;Steer 介面與 Minecraft 實作 | 只有主線會開口(程式檢查);「說了沒做」為 0;重複率 < 3%;任務中途改目標不丟進度,生效前她不說改好了 |
| **3. 規則與安全** | Directive、三層強制、權限分級;Output moderation;緊急停止;Steer 納入規則檢查 | 服從測試 pass^3 全過;對抗輸入 fixture 全過;用 steer 繞規則的 fixture 全被擋 |
| **4. 語音** | Silero + Smart Turn;TTS 爭用修正;ICL 與情緒音庫;ASR 決策;做歌不聾啞 | 遊戲中 p50 ≤ 2.5 s;接話率 > 60% |
| **5. Discord** | 指令收斂成 4 個;面板化;頻道分級;同意與隱私 | 新成員不看文件能點歌、改隱私 |
| **6. 面板與維運** | 玻璃視覺、意識軸、規則頁、評測頁;`miyoria up`、`doctor --deep`、`update` | 全新機器一個指令跑起來;今天的 6 類坑都能抓到 |
| **7. 記憶與個性** | 三層記憶、證據欄位、情緒接輸出、人設迭代 | 記憶可查可刪;人工抽樣評「像同一個人」 |

可以平行:面板視覺和維運不相依於主線,隨時可做。Discord 指令收斂也可以先做。

**不做的事**:Full-duplex 和 speech-to-speech(沒有日中路徑,會失去聲音和工具)、用模型 zero-shot 判斷插話、用 Discord 訊息訓練、把 Letta server 當相依、用 LoCoMo 分數選記憶系統、Threads 接回。

## 21. 風險

| 風險 | 處理 |
|---|---|
| 主線成為瓶頸或單點故障 | 反射層不經過主線;主線失敗時有固定的短回應 |
| 一次呼叫產生結構化輸出會拖慢首句 | 串流解析,`say` 先出;action 在串流內即時擷取。階段 2 先量 |
| Floor 太保守,她變啞巴 | 最低活動量一起驗收;MaiBot 的熱門群組鎖死是前例 |
| Self 帳號被 Discord 處分 | Owner 已接受風險;帳號失效時語音和 Go Live 會一起停,文字 bot 不受語音模組影響 |
| Steer 和任務結束同時發生 | 明確回 `too_late`,回到 context 由她處理;fault injection 要測這個競態 |
| ICL 或 Smart Turn 效果不如預期 | 都是可逆的小實驗,階段 0 就試 |
| 改動太大,V2 剛穩定又動 | 每階段可獨立上線;EventLog 先與 V2 並存,再逐步切換 |
| 她失去「主動」的感覺 | 主動的內容由 Planner 決定,限制的只是對空氣講話;直播表演有額外額度 |

## 22. 參考

- 調查報告與來源:[v3-research.md](v3-research.md)
- 前一版:[v2-architecture.md](v2-architecture.md)、[v2-implementation.md](v2-implementation.md)
