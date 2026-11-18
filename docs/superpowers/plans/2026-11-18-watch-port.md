# 把「看 Go Live 直播」接回新架構

狀態:待擁有者審閱(2026-11-18)

## 為什麼

`yeci` 在 2026-11-17 合併上游時,本機的看直播功能整個不見了(`packages/watch`、voice node 的 `watch/`、
語音連線的看直播訊息、聽直播聲音、LLM 指定看得懂圖的模型)。設定裡 `[modules.watch] enabled = true` 還在,
但沒有程式讀它。功能的設計沒有變,照 [2026-11-05-watch-stream-design.md](../specs/2026-11-05-watch-stream-design.md);
這份文件只講怎麼把它接到上游 11/14 之後重排過的架構上。

舊程式在 `464a8a03`(最後一個還有它的 commit)。看內容:`git show 464a8a03:<路徑>`。

## 目標和不做的事

- 目標:第一階段(Discord Go Live)回到 11/13 的行為:她在語音時能自己決定看誰的直播、換人、離開;
  安靜看,有值得講的才開口;直播的聲音不被當成有人對她說話;本人可以拒絕被看。
- 不做:第二階段(Twitch / YouTube / Bilibili 的瀏覽器來源)。Threads 分享、歌詞卡另外補。
- 不改上游已經有的行為;模組預設關閉。

## 舊的東西現在在哪

| 舊的 | 行數 | 現在 | 怎麼接 |
|---|---|---|---|
| `apps/voice-node/src/watch/{connection,manager,rtp,snapshot}.ts` | 955 | 沒有 | 幾乎原樣放回;它們只依賴 voice node 自己的東西 |
| `apps/voice-node/src/node.ts`、`protocol.ts` 的看直播部分 | 約 130 | `protocol.ts` 改成由契約產生 | 訊息要先加進契約(下一列),`node.ts` 的接線重寫 |
| `packages/voice/src/protocol.ts`、`link/link.ts`、`link/conn.ts`(看直播訊息、開始、要截圖) | 約 220 | 訊息定義搬到 `packages/contracts/voice-link`,連線在 `packages/voice/voice/src/link` | 在契約加 `watch_start` / `watch_stop` / `watch_snapshot` 和節點的回報,重新產生 schema,再把 `link.ts` 的方法接回 |
| `packages/voice/src/hearing.ts`(直播聲音轉成字,不當成對她說話) | 69 | 沒有 | 放回 `packages/voice/voice/src`,接到現在的 ASR 路徑 |
| `packages/llm/src/router.ts`、`structured.ts`、`types.ts`(請求堅持用看得懂圖的模型,`NoImageModelError`) | 約 60 | `packages/llm/llm/src`;上游已有 `[llm.image_input]` | 先看上游現有的夠不夠;不夠才補「堅持」那一段 |
| `packages/actions/src/{privacy,commands,registry,capability}.ts`(不讓她看我的直播、看人要有人開口) | 約 60 | `packages/gate/actions/src` | 照新的 capability 寫法補回 |
| `packages/watch/*`(模組、watcher、look、notes、speak、prompt、actions、discord 來源) | 約 1,900 | 沒有 | 放成 `packages/watch`,改 import;和「她的腦」接的地方重寫(見下) |
| `packages/mind/src/{mind,snapshot,selfstart,prompt}.ts`(她自己決定看誰、看到的不寫進日記) | 約 65 | mind 搬到 `packages/heart/mind`,`snapshot.ts`、`selfstart.ts` 已經沒有 | **還不知道怎麼接**,見「還沒弄清楚的」 |
| `packages/agent/src/{coordinator,claims,turn}.ts`(看直播時怎麼開口) | 約 120 | 舊的 agent 回合換成新的 runner(`packages/brain/self`、`selfhost`) | **還不知道怎麼接**,同上 |
| `packages/core/src/{modules,module-ids}.ts`、設定範例 | 約 50 | 位置沒變 | 註冊 `watch` 模組,補範例設定 |

## 還沒弄清楚的

這兩點決定第 4、5 步的做法,要先讀程式才知道,所以排在最前面當第 0 步:

1. **她自己怎麼決定去看**。舊版掛在 mind 的 SOLO 選單和 `selfstart`;新的 mind 沒有這兩個檔。要找出現在
   「她閒著時自己起頭做一件事」走哪裡(`packages/heart/mind`、`packages/brain` 的 initiative)。
2. **看的時候怎麼開口**。舊版自己組一個 agent 回合;現在所有的話都走新的 runner 和 `mainline.say`。
   要找出一個模組怎麼請她在語音說一句(遊戲實況現在怎麼做的,照它)。

## 第 0 步的結果(2026-11-18)

讀過現在的程式,兩點都有答案,而且都不是「搬回來」:

1. **看的時候怎麼開口**:舊的 `agent_initiative` 已經沒有了。現在遊戲和唱歌是送一個「衝動」(impulse)給
   arbiter(`newImpulse` + `Events.ArbiterImpulse`,例子在 `packages/play/game/src/director.ts`、
   `packages/sing/src/singer.ts`),由它排進那個地方的回合,再走平常的語音輸出。
   **但衝動的來源清單裡沒有 `watch`**(`packages/types/src/arbiter.ts`),借用 `game` 會在提示裡寫成「你正在玩的遊戲」。
   要加一個 `watch` 來源:來源清單、預設優先度、提示文字、API 契約都要動,再重新產生 schema。
2. **她自己怎麼決定去看**:舊的 mind「計畫」呼叫和 SOLO 選單整個拿掉了。現在她自己起頭只有兩條路:
   回合裡自己呼叫工具,或 world 的「值得注意的事」進她的收件匣。所以改成:
   - `watch_start` / `watch_stop` / `watch_look` 做成固定出現的工具,並加進語音回合允許的工具清單
     (`packages/brain/self/src/profiles.ts` 的 `VOICE_TOOLS`),她在語音裡自己決定要不要叫;
   - 「有人開始直播」做成 world 的一種值得注意的事,讓她知道可以去看(`SalienceKind` 現在沒有這一種,要加)。
   舊的「能力暫時不能用」(`Capability.available`)已經沒有對應,改成工具被叫時回答為什麼不行。

另外確認的:

- **看圖模型**:上游現在遇到不收圖的模型是**悄悄把圖拿掉**繼續問(`router.ts`),沒有「一定要看得懂圖」
  的選項,也沒有 `NoImageModelError`。看直播拿到沒有圖的回答等於亂講,所以舊的修補要補回。
- **聽直播聲音**:Core 現在只收一種音訊框(`TAG_CAPTURE`),看直播的音訊框要加;ASR 的並行名額是聽人講話
  那邊私有的,要拿出來共用。
- **隱私**:同意的種類現在只有 `dm`,要加 `watch`。
- **活動種類**:沒有「正在看」這一種,先不加(她看的時候不算在表演,照舊)。

對步驟的影響:第 1 到 4 步照原訂;第 5 步多一件「加 `watch` 衝動來源」;第 6 步從「接回 mind」改成
「工具固定出現 + 有人開始直播的通知」。這兩步動到上游共用的型別和契約,是之後合併最容易衝突的地方。

## 步驟

每一步各自有測試、各自一個 commit;做完一步跑全套測試再做下一步。舊的測試檔一起搬回來改。

0. **讀程式,把上面兩點寫清楚**(不改程式)。結果補進這份文件,有會改變做法的發現就先回報。
1. **語音連線的看直播訊息**:契約加訊息、重新產生 schema;Core 的 `link.ts` 能開始、停止、要截圖。
   測試:連線層的單元測試(舊的 `link` 測試搬回)。
2. **voice node 的看直播**:放回 `watch/` 四個檔,`node.ts` 接上新訊息。
   測試:舊的 RTP、生命週期、截圖測試搬回。這一步完成後可以在本機用真的 Go Live 手動驗證收不收得到畫面。
3. **聽直播聲音**:`hearing.ts` 放回,直播的聲音轉成字、不算對她說話。測試搬回。
4. **看圖模型**:確認上游的 `[llm.image_input]`;不夠就補「這個請求一定要看得懂圖的模型」。測試搬回。
5. **`watch` 模組本體**:放回 `packages/watch`,改 import 到新套件;用第 0 步找到的方式接「開口」。
   測試:watcher、look、notes、actions 的舊測試搬回。
6. **她自己決定看誰**:用第 0 步找到的方式接。測試:mind 那邊的舊測試照新結構重寫。
7. **隱私和指令**:不讓她看我的直播、看人要有人開口、`/watch` 相關指令。
8. **註冊模組、設定範例、文件**;全套測試、lint、型別檢查。
9. **部署和實測**:推到 Mac、重啟 Core、重開這台的 voice node;在語音裡開一次 Go Live 看她會不會看、會不會講。

## 風險

- 第 5、6 步的工作量取決於第 0 步;最壞情況是「開口」和「自己決定」要照新 runner 重寫,不是搬。
- voice node 用自己的 Discord 帳號收直播(self-bot),和之前一樣有帳號風險,這次不改變。
- 上游之後再重排,這些又會衝突。合併時要先看 `git diff --name-only HEAD origin/main` 有沒有碰到這些檔,
  有衝突就停下來處理,不能整包選上游。
