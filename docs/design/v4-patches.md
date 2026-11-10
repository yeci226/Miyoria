# V4 的事後修正:清單、量測、拆除

v4-plan §2.5 說她的輸出在模型寫完之後還會被改寫、扣住或重問,大約 15 處;§4.5 定了拆的順序:先量,再對著事故題一個一個拆,外牆不拆。這份文件是那張清單,加上每一個怎麼量、哪些已經拆了、剩下的什麼時候可以關。最後整理:2026-11-10。

## 1. 怎麼量

- 每一種修正觸發時記一次,不記她說了什麼:
  - Prometheus `miyoria_agent_corrections_total{kind, channel}`,`channel` 是 `voice` 或 `text`(`packages/agent/src/metrics.ts`)。
  - 回合結果 `agent.turn.outcome` 多一個 `corrections` 欄位(`CountedOutcome`,`packages/types/src/corrections.ts`):有送到模型的回合都有,沒觸發就是 `{}`;沒送到模型的回合沒有這個欄位。整筆紀錄原樣存進 `turn_outcomes`,不用改 store。
- `GET /api/turns/metrics` 每天和整段各算一次:每一種修正在語音、文字各觸發幾次、出現在幾個回合,以及「量到的回合」有幾個(`corrections.measured`)。「佔回覆」= 有觸發的回合 / 量到的回合,舊紀錄不算進分母。
- 面板 評測 / 參與度 底下的「事後修正」:每一種的語音、文字次數和佔回覆,選一種看每天的佔比曲線和每天的表(當天量到的回合寫在旁邊)。
- 沒算進來的:被打斷或取消的回合(協調器自己發 outcome,沒有這個欄位,只有 Prometheus 有);語音逐句的推理過濾、結果回合的 keep_note 提醒(程式不在這次的範圍,見 §6)。

## 2. 清單

位置是這次 commit 之後的行號。「V4 的哪一步」是 v4-plan 裡應該讓它不需要的那個改變。

| # | 修正 | 位置 | 事故 | 對她的輸出做什麼 | V4 的哪一步 | 計數 | 現在 |
|---|---|---|---|---|---|---|---|
| 1 | 沒做卻說做了:重問 | `claims.ts:46,106,167,182`;主線 `gate.ts` 丟掉 → `main.ts:1007` → `turn.ts:2649`;V2 `turn.ts:3090` | 2026-11-08「我游過去了」;11-08 15:20 魚幣只用嘴;11-09「那我先出去喔」沒離開語音 | 那幾行不送,告訴她沒發生,多問一次 | 回合內迴圈、她看得到自己的工具結果(§4.2) | `claim_reask` | 開關 `claims` |
| 2 | 「做好了」扣留 | `gate.ts:24,103,135` | V3 §10.1 的設計(11-07),之前常說了沒做 | 說完成或說自己在某狀態的那句,和後面的,等串流結束再決定 | 同上 | `claim_held` | 開關 `claims` |
| 3 | 沒有動作的宣稱刪掉 | `gate.ts:135`(`dropped`) | 同 1 | 那句永遠不送 | 同上 | `claim_dropped` | 開關 `claims` |
| 4 | 先說「開始了,等我一下。」 | `gate.ts:21`,`main.ts:1007` | V3 §10.1:`accepted` 不是做好了 | 「做好了」那句等結果回來才送,先送固定句 | 長活動仍在手上,這個不會因 V4 消失 | `claim_parked` | 開關 `claims` |
| 5 | V2 的宣稱扣留 | `turn.ts:2034`(`TextSegments`) | 同 1 | 同 2 | V2 管線本身會退場 | `claim_held` | 開關 `claims` |
| 6 | 工具寫成文字就重問 | `claims.ts:191,203`;主線 `turn.ts:2637`;V2 `turn.ts:3090` | 2026-11-08 `<sing_request>` 寫在回覆裡 | 多問一次,要她真的呼叫 | 工具說明完整、軌跡在紀錄裡(§4.2) | `tool_text_reask` | 開關 `tool_text_reask` |
| 7 | 工具寫成文字變承諾 | `main.ts:1077` | 同 6:沒呼叫就蒸發 | 生出一個承諾,到期提醒她 | 同上 | `tool_text_commit` | 開關 `promise_commit` |
| 8 | 台詞裡的承諾變承諾 | `gate.ts:69`,`main.ts:1077` | V3 §10.1「我要去做」要有動作或承諾 | 「我馬上進語音」沒呼叫,就幫她記一個承諾 | 同上;`commit` 工具她自己會用 | `promise_commit` | 開關 `promise_commit` |
| 9 | 推理外洩過濾(文字) | `leak.ts:49,73`;V2 `turn.ts:2017`;主線 `turn.ts:2341` | 2026-11-09 一回合 23 則推理 | 第一行等第二行;判定外洩就整段之後都不送 | 根治推理外洩(§5) | `leak_dropped` | 開關 `leak_screen` |
| 10 | 推理外洩過濾(語音逐句) | `turn.ts:648`(`Speech`) | 同 9 | 那句不念 | 同上 | 沒算 | 不在這次範圍,見 §6 |
| 11 | `<emo:thinking>` 區塊當推理丟掉 | `expression.ts:26-33,132` | 2026-11-09 紀錄裡五次 | 結束標籤之前的字不給人看 | 同上 | 沒算 | 留著 |
| 12 | 罐頭等待台詞 | `main.ts:107`;`finish` `main.ts:1007`;語音迴圈內 `waitFor` `main.ts:897` | 11-08 14:46 問錢包只得到「等我一下」;11-09 21:06 歌詞 | 一則只做事沒說話的輸出,補一句固定的等待 | 迴圈內她自己會講、看得到結果(§4.5 第 1 步) | `wait_line` | **收窄**,§3 |
| 13 | 只記筆記就叫她回來 | `main.ts:1007`(`#notedQuietly`) | 11-09 21:06 記了歌詞沒說話 | 筆記的結果另開一個回合 | 筆記在迴圈內跑 | `noted_callback` | 留著(只剩超過輪數或時間的情況) |
| 14 | keep_note 提醒 | `notes.ts:30,50`;迴圈 `turn.ts:2738`;結果回合 `mainline/prompt.ts:200`;V2 `turn.ts:3240` | 11-09 查了歌詞,下一句就忘了 | 長結果後面加「下一回合就看不到了,用 keep_note」 | 軌跡留在回覆旁(§4.2) | `keep_hint` | **收窄**,§3 |
| 15 | 罐頭失敗台詞 | `main.ts:95`;`turn.ts:983` | V3 §21:呼叫失敗也要回等她的人 | 模型失敗或什麼都沒給時送固定句 | 沒有;模型失敗不會因 V4 消失 | `fallback_line` | 留著 |
| 16 | `groundArgs` | `output.ts:94`;`turn.ts:3371` | 2026-11-08 填錯的伺服器 id、把文字頻道當語音頻道 | 刪掉不對的 `guild`、`voice_join` 的 `channel` | 工具說明完整、參數說明不再被砍 | `ground_args` | 留著,先量 |
| 17 | 刪掉前一輪說過的句子 | `loop.ts:123,145`;`main.ts:842,870,951` | 2026-11-10 迴圈上線:下一輪又先說「我查一下」 | 整句一樣就不再送 | 這是迴圈帶來的,V4 沒有對應的根治 | `repeat_cut` | 留著 |
| 18 | 拿掉寫成標籤的工具和 `<span>` | `expression.ts` `parseTag` | 2026-11-08 標籤出現在她的話裡 | 標籤不給人看,也不執行 | 原生工具呼叫 | 沒算 | 留著(格式) |
| 19 | 寫給自己的盤算拿掉那行(PR 8) | `leak.ts:44,112`(`isSelfTalk`、`ReplyScreen`);主線 `turn.ts:2709`;V2 `turn.ts:2331`;語音 `turn.ts:1476`(`#selfTalk`) | 2026-11-08「莎露朵在問我上面訊息寫什麼,直接念給她聽就好。」 | 第三人稱、對自己下指令的那一行不送也不念,同一則的其他行照送;不算她說過的話 | 根治推理外洩(§5) | `self_talk_cut` | 開關 `self_talk` |
| 20 | 主人說「不要玩 X」替她寫規則(PR 8) | `prohibition.ts:49`;`turn.ts:372,1431`(`keepRules`) | `mc-owner-rule-never-written`:說了四次不要玩 Minecraft,她都答應,沒有一次呼叫 `directive_add` | 回合結束時用說話者的身分寫一條 deny,規則服務照樣判斷那個人能不能寫 | 工具說明完整、迴圈內她看得到自己沒做(§4.2) | `prohibition_written` | 開關 `prohibition_write` |
| — | 每個工具說明後的請求規則 | `actions/src/tools.ts:19` | 好感決定要不要做 | 每個能力工具說明後面附一段 | 主線已用 `slimTool` 拿掉,固定規則講一次(`output.ts:110`) | 不是輸出 | 主線已拆;V2 還在 |
| — | 高風險動作的第二次 LLM 審核 | `packages/actions` 閘門的 `review` 階段 | | 動作被擋或要 owner 核准 | | 閘門稽核本來就記 | **外牆,不拆** |
| — | `isSelfTalk` | `types/src/impulse.ts:145`,`arbiter.ts:370` | | 生成之前:自己起頭的發言受 Arbiter 限制 | | 不是輸出 | 不是事後修正;和 #19 的 `leak.ts` `isSelfTalk` 同名,是不同的東西 |
| — | 預算用完的固定句 | `signals.ts:17` | | 不呼叫模型 | | 不是輸出 | 外牆(預算) |

外牆照 §15 不動:主人規則、行動閘門(含第二次審核)、送達帳本、輸出審查(`safeOutgoing`)、發言權和 Floor 的硬上限、沒在提供清單上的工具不跑(`NOT_OFFERED`)、靜音回合不開口。

## 3. 第一步:迴圈已經涵蓋的,拆掉或收窄

### 3.1 罐頭等待台詞

讀的程式路徑(`turn.ts` `#mainCall`):

- 一則回覆只要有迴圈工具、輪數沒到 `max_tool_steps`、時間沒用完,就**不會**走到 `finish`:迴圈工具當場跑,結果以工具訊息回給她;非迴圈的呼叫回「交出去了,還沒完成」(`HANDED_OVER`),放進 `later`,然後她再回一次。
- 所以走到 `finish` 時,`output.actions` 只會是三種:`later`(前幾輪交給手的),最後一則回覆自己的非迴圈呼叫(開遊戲、唱歌、開台、進語音),以及超過輪數或時間、或修正呼叫失敗才留下的迴圈呼叫。
- 文字裡,查詢類的等待台詞從 11-10 迴圈上線起就只會在超過輪數或時間時出現;這部分不用改。

涵蓋的情況:`later` 裡的呼叫。她在同一回合已經讀到「交出去了」,之後還有一則回覆。那則回覆選了 `<silence/>`,原本還是會補「等我一下」,等於推翻她的決定。**拆掉**:最後一則回覆是 `<silence/>` 時,`later` 的呼叫不算(`main.ts` `finish` 的 `earlier`)。

留著的:最後一則回覆自己的呼叫(長活動、超過預算的查詢),最後一則回覆什麼都沒給(不是沉默是空的,仍當模型失敗補一句),以及語音迴圈內工具跑之前的那句(`waitFor`)。最後這個不是 V3 留下來的:它是 11-10 跟迴圈一起加的,照 §4.2「語音先說一句再繼續」填補工具執行時的安靜;模型會不會自己先說一句,程式證明不了,所以留著計數。

測試:`corrections.test.ts`「a call handed over in an earlier round, then silence」(新,之前會送等待句),「the last response gave nothing at all」「an activity in the last response」(留著的情況)。原本的 `mainline.test.ts` 等待句測試全部照舊通過,沒改。

### 3.2 「記筆記,不然下一回合就沒了」

讀的程式路徑:

- 迴圈的每個呼叫都進 `#trace` → `ToolTraces.put`,下一回合在她那句旁邊顯示 `traceText`:呼叫了什麼、結果開頭 `trace_result_chars`(預設 160)字,一回合合計 `trace_chars`(600),保留 `traces`(12)個回合。所以「下一回合就看不到了」對迴圈結果已經不是真的;主線的固定規則(`mainline/prompt.ts:67`)也早就寫「之後只剩幾行摘要」。
- 只是受理的呼叫(`accepted`,回條後面接「還沒完成」)真正的結果之後由手帶回,在結果回合的 `resultData` 裡,那裡自己會加提醒。
- 手帶回的結果(`resultData`)沒有軌跡,V2 管線也沒有。

**收窄**(`notes.ts` `loopKeepHint`,`turn.ts` `#inTurn`):

| 迴圈結果 | 之前 | 現在 |
|---|---|---|
| 回條(`accepted`) | 提醒 | 不提醒:結果回合會提醒 |
| 軌跡整段留得下 | 提醒 | 不提醒 |
| 軌跡只留開頭 | 「下一回合就看不到了」 | 「下一回合只會留下開頭 N 字的摘要」 |
| 這回合沒有軌跡(`traces = 0`、超過 `trace_chars`、找不到要接的那行) | 提醒 | 原來的提醒(這時是真的) |

照預設值,300 字以上才提醒、軌跡留 160 字,所以「整段留得下」要調高 `trace_result_chars` 才會發生;實際上預設設定下少掉的是回條的提醒,和一句錯的話。結果回合和 V2 的提醒不動(沒有軌跡,沒被涵蓋)。

測試:`corrections.test.ts` 的「a long result of the loop says what the trace keeps」「a result the trace keeps whole gets no reminder」「the reminder's rule」。

## 4. 第二到四步:開關,和什麼數字可以關

`[modules.agent.corrections]`,四個都預設 `true`,每個都有測試(`corrections.test.ts`「the four of v4 §4.5 steps 2 to 4」)。PR 8 合進來的兩個(#19、#20)也各有一個開關,同樣預設 `true`(`corrections.test.ts`「PR 8's two corrections」):

```toml
[modules.agent.corrections]
tool_text_reask = true   # 工具寫成文字就重問(#6)
promise_commit = true    # 台詞的承諾、寫成文字的工具變承諾(#7、#8)
claims = true            # claims.ts 的 regex:扣留、刪掉、重問、「開始了,等我一下」(#1 到 #5)
leak_screen = true       # 文字的推理過濾(#9)
self_talk = true         # 寫給自己的盤算拿掉那行,文字和語音(#19);和 leak_screen 分開
prohibition_write = true # 主人說「不要玩 X」她沒寫規則,替她寫(#20)
```

#19、#20 還沒有上線數字,關掉的門檻照下表的做法,等量到再訂。#20 另有事故題 `mc-owner-rule-never-written`(現在是 xfail:題目只有紀錄,重播不了主線的選擇)。

關掉的門檻都用面板「事後修正」讀,條件是**連續一段期間、量到的回合夠多、佔回覆低於門檻,而且 `pnpm eval` 事故題全綠**:

| 開關 | 看哪個數字 | 期間和樣本 | 門檻 | 另外要成立的 |
|---|---|---|---|---|
| `tool_text_reask` | `tool_text_reask` 佔回覆 | 連續 14 天,量到 ≥ 2,000 回合 | < 0.1%(每千則不到 1 次) | tool_as_text 的事故題沒有變紅;關掉後一週 `tool_text_commit` 沒有上升 |
| `promise_commit` | `promise_commit` + `tool_text_commit` 佔回覆 | 連續 14 天,≥ 2,000 回合 | < 0.2% | 這段期間自動生出的承諾,事後被她自己做到的(承諾紀錄 `kept`)不到一半:多半是沒有用的提醒 |
| `claims` | `claim_reask` + `claim_dropped` 佔回覆(假宣稱);`claim_held` 是扣留的代價 | 連續 30 天,≥ 5,000 回合 | 假宣稱 < 0.05%,而且 30 天內語音 0 次 | §4.5 說它是保險,預期接近 0;關掉後 `claim_parked` 會變 0,「做好了」不再等結果,要先確定長活動的回條她都不會說成做好了 |
| `leak_screen` | `leak_dropped` | 根治(§5)上線後連續 30 天,文字 ≥ 3,000 回合 | 0 次,而且 log 沒有 `leaked reasoning` | 根因查實;語音逐句過濾(#10)要一起關 |

開關只拿掉那一個修正;外牆不受影響。

## 5. 推理外洩:查到的

backlog 記的:2026-11-09 15:29,`reasoning` off 的一回合把思考當回覆發了 23 則。

讀了 `packages/llm` 和 agent 的串流處理:

1. **怎麼要求推理**:主線每次呼叫都設 `request.reasoning`(`#mainReasoning`,`chat_text` 沒設定時是 off)。路由器照它設 `thinking = reasoningEnabled(level)`(`router.ts:351-356`)。`thinking: false` 時,OpenAI 相容的請求把 `thinking_off` 合進 body(`wire.ts:69`):`deepseek`、`opencode` 預設 `{"thinking":{"type":"disabled"}}`,`openai`、`openai-compatible` 預設什麼都不送,等於用模型自己的預設。level 不是 off 時,沒有 `reasoning_effort` 的供應商**不會**送「開啟」,只把 `max_tokens` 壓到 2048 / 8192(`wire.ts:71-80`)。
2. **推理和回覆怎麼分開**:只看 SSE 的欄位。`delta.reasoning_content`(DeepSeek)或 `delta.reasoning`(OpenRouter)變 `reasoning_delta`,`delta.content` 變 `text_delta`(`provider.ts:521-523`)。內容裡的 `<think>` 不會被拆開。
3. **agent 這邊**:`reasoning_delta` 只寫 debug log,從不進回覆(`turn.ts` `#streamStep`);送回模型的 assistant 訊息只有 content 和 tool_calls(`wire.ts` `requestBody`)。內容裡的 `<think>` 不是工具標籤,解析器會保留,過濾器看得到(`leak.ts` 的 STRONG);`<emo:thinking>…</emo:thinking>` 解析器直接丟掉。

結論:程式沒有任何路徑會把分開送來的推理併進回覆。外洩的字一定是供應商放在 `content` 裡送來的。可能的原因有三個,現有資料分不出來:

- (a) 供應商收了 `thinking: disabled` 但模型還是把思考寫在 content(backlog 猜的:opencode 上的 `deepseek-v4.1-flash`);
- (b) 那次其實有在想:模型那一段沒送 `thinking_off`(`openai-compatible`,或鏈上的後備模型換了供應商),思考跑到 content;
- (c) 模型把提示詞的規則(情緒標記、回覆要短)當成要在回覆裡逐條核對的清單。

**這次在範圍內改的**:

- 被過濾器擋下的行不再算她說過的話(`main.ts` `unsent`)。之前擋下的行留在 `said` 裡,一句草稿「可以說:「嗯,我馬上進語音。」」會被當成她的承諾,決策紀錄的 `say` 也會算錯。整段被擋時,等她的人現在收到失敗的固定句(和呼叫失敗一樣),不再什麼都沒有。
- 擋下時,這回合每次呼叫的資料寫進 log(`leaked reasoning: what the provider said about the calls of this turn`,不含任何文字):呼叫 id、回答的模型、推理等級、`thinking`、推理字數、`reasoning_tokens`、回覆字數、`finish_reason`、有沒有走後備模型。

**下一次發生時要看的**(呼叫檢視器只在記憶體、留最近 200 筆,Core 重啟就沒了):

1. 那行 log:`thinking: false` 且 `reasoning_chars = 0`、`reasoning_tokens` 是 0 或 null → (a) 或 (c);`reasoning_tokens > 0` 或 `reasoning_chars > 0` → 有在想,是 (b);`fallbacks > 0` 或模型不是第一順位 → 看後備模型的供應商種類有沒有 `thinking_off`。
2. 在 Core 重啟、或再過 200 次呼叫之前,用 log 裡的呼叫 id 打開面板 LLM / 呼叫,存下完整的請求和回應(`response.text` 和 `response.reasoning`)。
3. 本機 `miyoria.toml` 裡回答那次的 provider 的 `kind` 和 `thinking_off`。
4. 要分 (a) 和 (c):同一份提示詞(若那回合有被取樣存下,`agent.prompt`)用 `chat_text = "low"` 重跑一次。思考移到 `reasoning_content`、回覆乾淨 → 根治是 `chat_text` 開 `low` 或換一個 off 模式乾淨的模型;還是寫在 content → 是模型本身,換模型。

查實並修好之前,過濾器和語音逐句過濾都留著。

## 6. 範圍外,要整合的人處理

- `turn.ts:648`(`Speech#say`,另一個工作包的範圍):語音逐句的推理過濾沒有計數也沒有開關。建議:`Speech` 收一個 `(text) => boolean` 判斷,由 `Turn` 傳入,在 `leak_screen` 關掉時不擋,擋下時 `tally.count("leak_dropped")`。
- `mainline/prompt.ts:200`(`resultData`):結果回合的 keep_note 提醒沒有計數。
- `tools.ts:67`(`keep_note` 的說明)還寫「只有這一回合看得到,下一回合就沒了」;主線上應該跟固定規則一樣寫「之後只剩幾行摘要」。
- `docs/design/backlog.md` 推理外洩那一條可以連到本文件 §5。
- `apps/panel/DESIGN.md` 的「評測」一行可以補上「事後修正」區塊(一個表、一個每日 `TimeChart` 和每天的表)。

## 7. 事故題

`packages/eval` 加了 2026-11-10 的兩題,改回去就會讓 `pnpm eval` 變紅:

- `repeat-question-one-wish`(新 harness `wish`):九點的提案、承諾、十一點的兩次私訊、S 的回答、Plan 的目標、S 在頻道說的話,依序丟進 arbiter 真正的 `WishBook`,她每一次問 S 之前先問 `screen`。現在只留 11:07 的第一則;紀錄裡是十次。她問的句子是改寫的,時間、次數和 S 說的話來自程式註解和測試。
- `attention-aside-about-her`(新 harness `attention`):「@Bob 她一直跳針,第六次了」是回覆她的訊息,但對 Bob 說;用 agent 的 `directReason` 判斷,不能當成對她說。旁邊放一則「真的假的」(不是事故裡的),讓「全部都不算對她說」的改法也會變紅。

eval 的 subject 可以是非同步的(`WishBook.screen` 是 async),`runFixture` / `runSuite` 因此改成 async。
