# 讓 Miyoria 少說、說準、守住 Discord 規則

V3 不需要換模型,也不需要重寫模組。它要做四件事:把「說什麼」和「做什麼」收斂成同一個決策,把「講過了沒」改成以實際送達為準,先清掉 GPU 爭用,再把語音移到 bot 帳號、退掉 self 帳號。公開證據顯示,Neuro-sama 的臨場感來自仲裁、互動與穩定的人格,不是毫秒級推論:官方 SDK 自己把語音一輪寫成以秒計,而她的基礎模型、參數量和 TTS 引擎都查不到第一手來源。Miyoria 的問題也在這一層。本機資料庫顯示,2026-11-07 約三小時內她在語音主動開口 201 次,回應真人只有 17 次;語音延遲 p50 為 4.8 s,連最快的一次(3.4 s)都沒達到 V2 的 2.5 s 目標;「石のツルハシ」在最近 400 句語音裡出現 37 次。V2 已經蓋好 Arbiter、ActivityManager 和任務契約,缺的是能回答「這件事講過沒」的送達紀錄、權限模型與真實環境的驗證。最急的決定是 self 帳號:Discord 明文禁止,沒有任何設定能讓它合規,而 Developer Terms 的處分範圍涵蓋 developer 帳號與 app,比 `docs/DECISIONS.md` R2 估的更大。語音不需要 self 帳號,只有 Go Live 需要,所以 owner 真正要回答的是「Go Live 值不值得這個風險」。另外三條規則直接碰到現有方向:item 13 碰「很主動」,item 16 碰依感情與上線紀錄運作的人物資料,item 21 碰用 log 訓練發言 gate。本報告不構成法律意見。

## 每項發現都帶證據等級,推論另外標明

本報告保留各份筆記的原始標籤,不把它們統一成單一量表。凡是「應該怎麼做」的段落,除非另有標示,都是推論,不是來源寫明的事實。

| 標籤 | 意義 |
|---|---|
| **[CONFIRMED]** | 讀過一手來源:官方 repo 或文件、Discord 現行條文、論文或廠商工程文章原文,或 Vedal 具名受訪。Vedal 的引述多半來自 2023 年,會註明年份。作者自報的成效仍是作者自己的數字,不代表獨立驗證 |
| **[REPORTED]** | 新聞、學術研究或二手轉述 |
| **[SPECULATION]** | 社群傳聞、粉絲 wiki 或作者自己的推測 |
| **[code] [prompt] [doc] [changelog] [issue]** | 開源專案:分別為讀過原始碼、讀過 prompt、文件自述、changelog、issue 回報(未重現)。全部是靜態閱讀,沒有實際執行 |
| **[vendor] [3rd-party] [community] [excerpt]**,以及 (secondary)、(snippet) | 語音與 harness 筆記:廠商自述、第三方量測、社群、僅讀到搜尋摘錄、未對照原始頁面 |
| **[repo]** | 本 repo 的文件、程式或專案記憶筆記,本次已對照 |
| **[repo-實測]** | 本次唯讀查詢 `data/miyoria.db` 的結果。樣本只有一段約三小時的 session,不是長期統計 |
| **[推論]** | 研究者或本報告的推理,沒有來源直接證明 |

## Neuro 的公開紀錄只證實介面,臨場感來自仲裁與人

關於 Neuro 的「大腦」,官方紀錄很薄。Vedal 在 2023 年 1 月確認她跑在 LLM 上、有多層 filter,而且當時需要真人在場 moderate **[CONFIRMED, 2023]**([Vice](https://www.vice.com/en/article/this-virtual-twitch-streamer-is-controlled-entirely-by-ai))。廣為流傳的細節都追不到第一手:2B 參數與 q2_k 只來自粉絲 wiki 一脈,Azure「Ashley」聲音也沒有出處 **[SPECULATION]**([審查頁](https://lin-guanguo.github.io/llm-memory-research/neuro-sama.research/));RTX 4090 的說法沒有人對照過頻道 **[REPORTED, unverified]**([teck78](https://teck78.blogspot.com/2025/11/my-thoughts-on-technology-behind-ai.html))。RAG、每場摘要這類記憶說法全是作者推論 **[SPECULATION]**,歌唱引擎同樣沒有來源。最大的證據缺口是 Vedal 的 dev stream 沒有逐字稿,這份研究也沒有轉錄,所以「Neuro 內部怎麼做」到今天仍是未知,不該當成 V3 的設計依據。

真正可用的是 neuro-sdk,內容更新到 2026 年 8 月的 changelog **[CONFIRMED]**。遊戲用文字描述世界並註冊動作,`context` 的 `silent` 欄位把「她知道了」和「這件事可能值得反應」分開,而非 silent 的訊息在她忙著跟別人或聊天室講話時可能被略過。`actions/force` 一次只能有一個,`priority` 分四級:low 等她講完,medium 提早收尾,high 縮短後回應,critical 立刻打斷([規格](https://raw.githubusercontent.com/VedalAI/neuro-sdk/main/API/SPECIFICATION.md))。`action/result` 是在驗證後、執行前送出,所以它只是受理回條,不是事情完成的證明。語音文件把聽、轉文字、決策、合成一輪定義為秒級,server 自己處理句尾靜音,音訊依說話者分流,`voice/cancelled` 要 client 立刻丟棄緩衝,而且遊戲流程不得依賴她開口([VOICE_CHAT](https://raw.githubusercontent.com/VedalAI/neuro-sdk/main/API/VOICE_CHAT.md))。README 明說高 APM 的遊戲要由另一套系統負責低階操作([neuro-sdk](https://github.com/VedalAI/neuro-sdk))。Best practices 還透露模型的行為:零碎訊息會讓她反應變差,不強制就會分心,動作太像會固著在少數幾個,陳述事實比讓她推理可靠得多([BEST_PRACTICES](https://raw.githubusercontent.com/VedalAI/neuro-sdk/main/API/BEST_PRACTICES.md))。**[推論]** 這些機制合起來,等於有一個中央仲裁者掌握唯一一張嘴,而且在「繼續講」和「切斷」之間存在「快講完」這個狀態,比二元 barge-in 自然。

粉絲研究量到的臨場感來源是互動,不是速度。對 334 位自選樣本的粉絲調查中,92% 認為社群與 AI 的互動重要,90% 看重不可預測的氣氛,83% 把她的行為讀成一致的人格;她的聊天室有 26% 是直接提問與命令,85% 的付費訊息在發起新話題,而 96% 的人是經由推薦片段發現她 **[REPORTED]**([Ye et al.](https://arxiv.org/pdf/2509.10427))。另一份涵蓋二十多萬則留言的研究顯示,與真人互動是最常被提到的魅力(Reddit 18%、YouTube 23%),錯誤和拒絕常被粉絲改寫成角色設定 **[REPORTED]**([Wei et al.](https://arxiv.org/html/2509.20817v1))。Vedal 也把直播從九小時縮到兩、三小時 **[REPORTED, 2023]**([Wikipedia 引 KAI-YOU](https://en.wikipedia.org/wiki/Neuro-sama))。這些資料都偏向粉絲,懷疑者被低估。沒有任何來源量過她的反應延遲、打斷頻率或靜默長度,也沒有人說明她如何避免重複;2024 年 8 月短期記憶實驗造成講話迴圈的記載,本身就暗示這個問題沒有解決 **[REPORTED, weak]**([TV Tropes](https://tvtropes.org/pmwiki/pmwiki.php/WebAnimation/NeuroSama))。她幾乎沒經歷過冷清期,因此 **[推論]** Miyoria 無法借用 Neuro 的解法:小型 Discord 社群提供不了源源不絕的 prompt,解法應該是她在做看得見的事、偶爾開口,並記得每個人。

其他 AI streamer 的內部幾乎都沒公開,失敗卻集中在同一處。Nothing, Forever 在 2023 年 2 月被 Twitch 停權至少 14 天,團隊事後說是 GPT-3 Davinci 故障時退到 Curie,並誤以為內建 moderation **[REPORTED]**([NBC](https://www.nbcnews.com/tech/twitch-temporary-ban-seinfeld-parody-ai-transphobic-remarks-rcna69389));木几萌則被觀眾用諧音和訊息一路引到禁忌話題,開播一個多月後遭到最後一次封禁 **[REPORTED]**([遊民星空](https://www.gamersky.com/news/202304/1583846.shtml));Neuro 自己也因 2022 年底的發言被禁播兩週 **[REPORTED]**([Wikipedia](https://en.wikipedia.org/wiki/Neuro-sama))。商業面最新的賭注是 a16z 領投 Shizuku,投資方明白點出主動對話缺乏資料 **[REPORTED]**([a16z](https://a16z.com/announcement/investing-in-shizuku-ai/))。**[推論]** 對 Miyoria 最直接的教訓是:內容審查必須獨立於模型、走遍每條路徑,包括 fallback。**[repo]** 本次搜尋沒有找到這一層,`filterOutgoing` 只處理 role mention、`@everyone` 和機密遮罩(`packages/types/src/untrusted.ts`)。Neuro 被過濾的內容會顯示成 filtered 字樣 **[REPORTED]**([Wikipedia](https://en.wikipedia.org/wiki/Neuro-sama)),這是把安全事件變成角色笑點的便宜做法。聊天室也要當成對抗性輸入處理,而不只是內容來源;aituber-onair 的 `comment-intelligence` 是可參考的 TypeScript 前置層,會偵測 prompt injection、洗版和釣魚式留言 **[doc]**([README](https://github.com/shinshin86/aituber-onair/blob/main/packages/comment-intelligence/README.md))。

## 開源專案的共同答案:決定開口、擁有發言權、記下送達是三件事

開源專案分成三種真正的做法,一種該淘汰。MaiBot 是 gate 再進 agent;Letta 的 Discord 範例和 AIRI 的 `spark:notify` 是 agent 用沉默工具自己決定;kimjammer/Neuro、Lumi_Nox、ChatdollKit 是純規則排程。AstrBot 預設 `possibility_reply` 0.1 的擲骰則是最差的一種 **[code]**([AstrBot](https://github.com/AstrBotDevs/AstrBot/blob/master/astrbot/builtin_stars/astrbot/group_chat_context.py))。

MaiBot 是唯一認真解決「群聊裡該不該講話」的專案。它在 2025-08-11 刪掉 willingness 純量,commit 沒有寫原因 **[code]**([commit](https://github.com/Mai-with-u/MaiBot/commit/1f91967d2d6d13b2a09fa8b96ab4c05bc1f57c9a)),現在由一串便宜的確定性階段擋在單一 Planner 前面:debounce(natural 模式安靜開頭 2 s、活躍開頭 5 s、換人 0.5 s,每批上限 8 s,被 @ 上限 1 s)**[doc]**([debounce](https://github.com/Mai-with-u/MaiBot/blob/main/src/chat/debounce/README.md)),idle backoff 為 `min(300, 15 * 2^(n-2))` 秒 **[code]**,接著是用 Planner 自己過去的決定擬合出的 logistic regression,外面再包一層一小時視窗、以 40 秒虛擬回合計算的預算控制器 **[code]**([dynamic_gate.py](https://github.com/Mai-with-u/MaiBot/blob/main/src/maisaka/turn_trigger/dynamic_gate.py))。它的失敗同樣值得學。熱門群組曾鎖死成 711 則進、0 則出,持續 3.5 小時 **[issue]**([#2109](https://github.com/Mai-with-u/MaiBot/issues/2109));反過來,因為任何非 `wait` 的工具都會重置計數器,又出現一則訊息引發 41 秒 10 則回覆 **[issue + code]**([#2127](https://github.com/Mai-with-u/MaiBot/issues/2127));模型把 `<stop>` 寫成純文字後,那段文字留在 session 裡被下一輪模仿,bot 就此沉默還繼續燒 token **[issue]**([#2346](https://github.com/Mai-with-u/MaiBot/issues/2346))。**[推論]** 權重綁在特定模型、人設和 QQ 群文化上,方法能搬,數字不能。`recent_self_ratio` 的權重是 +2.65,沒有預算就照抄,會變成她講得越多就講得越多。

GLaDOS 是目前最好的主動發言設計 **[doc]**([docs/autonomy.md](https://github.com/dnhkng/GLaDOS/blob/main/docs/autonomy.md))。各個 Mind 把證據寫進共享 slot,Autonomy reviewer 沒有工具也不排語音,只回傳 `null` 或 `prompt`,格式統一是因為混合 schema 會讓小模型偏向發話。節奏是 10 s tick、20 s cooldown,沒有事就退到 40、80、120 s,使用者互動時全部延後,新輸入取消未完成的主動工作。最關鍵的是 delivered-event ledger:只有語音或顯示的 acknowledgement 才算送達,該版本的來源進入帳本後不再被選中,失敗或取消的可以重試,穩定的 `attention_key` 擋住換句話說的重複。它的適用範圍是一個人在一個房間,不是群聊。

Lumi_Nox 是最接近 Miyoria 現場問題的專案,有兩位共同主持人和每日 Bilibili 直播。`SpeechOutputArbiter` 只有 `queue_after_current`、`drop_if_busy`、`interrupt_current` 三種 policy,音訊播完才釋放發言權,失敗路徑也會釋放 **[code]**([arbiter](https://github.com/MIO-456/Lumi_Nox/blob/main/speech_output_arbiter.py));記憶在讀取時以 168 小時半衰期衰減,人工與身分事實 pin 住 **[code]**([decay.py](https://github.com/MIO-456/Lumi_Nox/blob/main/memory/decay.py));人設與導播台沒有開源 **[doc]**。AIRI 的 ADR 讓程式依時鐘和觀察決定 trigger、不呼叫模型,自動任務在隱藏 session 跑完後送 `notice` 給主 agent,她可以講也可以不講 **[doc]**([ADR](https://github.com/moeru-ai/airi/blob/main/docs/ai/adr/2026-10-10-skills-automations-and-memory.md));但 ADR 坦承沒用真實模型、Discord 和語音驗證過,多使用者群聊則被另一份提案列為 non-goal **[doc]**([proposed ADR](https://github.com/moeru-ai/airi/blob/main/docs/ai/adr/2026-10-09-character-as-chat-member.md))。Open-LLM-VTuber 的貢獻很小但很準:被打斷時 history 只留實際聽到的部分 **[code]**([basic_memory_agent.py](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/agent/agents/basic_memory_agent.py))。沒有任何專案同時處理群聊、語音和自主性,多人 Discord 語音在這份調查裡沒有參考實作。

防止重複的強手段都是確定性的,而且綁在「送達了什麼」上,靠 prompt 提醒已被證實不夠:MaiBot 有這種提醒,仍然 41 秒發了 10 則。**[推論]** 優先順序是送達帳本、consume-once 的回覆對象、每回合回覆預算、回合結構規則、sampler,最後才是 prompt 提醒。這正好打中 Miyoria 的現況。**[repo]** 現有 Ledger 由 Arbiter、ActivityManager 和 agent 共同寫入,記錄她做過什麼與 outcome,但沒有 `attention_key`、`revision` 這類內容鍵,回答不了「這件事講過沒」;遊戲評論不受 `after_speech_*` 等待限制(`packages/arbiter/src/config.ts`),最短間隔只有 `commentary_min_secs` 15 s(`packages/game/src/config.ts`)。**[repo-實測]** 05:49 到 08:43 UTC 她在語音主動開口 201 次,最後 43 分鐘就有 82 次;最近 400 句語音裡「石のツルハシ」出現 37 次;同一時段別人回她的話有 39 次沒回(語音 16/21、文字 23/23)。這 201 句我沒有逐句分類,39 次沉默的原因也未查明,不能全算成錯誤,但整體比例是倒過來的:對空氣講得太多,對人回得太少。**[推論]** 這是 harness 的問題,不是 prompt 的問題,同樣內容的觸發反覆送進來,任何模型都會重複。

## Agent harness 能搬的是共用日誌與程式閘門,不是阻塞迴圈

強的 harness 長得很像:一個模型迴圈跑在一條 append-only 歷史上,每步都有環境回饋,規則與長期狀態放在模型外面、每次重新注入。OpenHands 把每次互動當成不可變事件,摘要也是日誌裡的一筆,靠重播恢復 **[CONFIRMED, paper]**([OpenHands](https://arxiv.org/html/2511.03690v1))。Claude Code 的權限由 harness 強制,deny 先於 allow,allow 無法在 deny 裡開例外,但逾時的 `PreToolUse` hook 不會擋住呼叫 **[CONFIRMED]**([Permissions](https://code.claude.com/docs/en/permissions)、[Hooks](https://code.claude.com/docs/en/hooks))。只在對話裡交代的指令,壓縮後常常消失 **[CONFIRMED]**([Memory](https://code.claude.com/docs/en/memory))。不能搬過來的是阻塞式的 act-observe-act:工具迴圈在終端機裡可以,放進語音就爆預算;LLM 摘要也要移到熱路徑之外。

多 agent 的爭論其實有共同結論。Anthropic 的研究系統比單一 Opus 4 高 90.2%,但 token 用量約 15 倍,而且明列即時協調不適合 **[CONFIRMED]**([Anthropic](https://www.anthropic.com/engineering/multi-agent-research-system));Cognition 的結論是寫入保持單一執行緒,額外的 agent 只貢獻智力、不貢獻動作,只分享部分 context 會導致不知情的決定 **[CONFIRMED]**([Cognition 2026](https://cognition.com/blog/multi-agents-working))。**[推論]** Miyoria 的 think、speak、act 三段呼叫是無意間形成的多 agent 系統,「我會停」這種隱含決定傳不到 act 那一側。V3 應該由一個前景決策者擁有所有會改變世界的事,讀同一份日誌;planner、記憶整理、評論草稿、新奇度評分都放背景,只能寫提案;確定性 executor 負責動作和反射。Talker-Reasoner 的方向對 **[CONFIRMED, paper]**([arXiv 2410.08328](https://arxiv.org/abs/2410.08328)),但 LiveKit 的版本沒有任何實測數字,且自認不適合需要先驗證才能說的內容 **[vendor]**([LiveKit](https://livekit.com/blog/talker-reasoner-pattern-voice-agents))。

Owner 指令是目前結構問題最明確的地方。OpenAI Model Spec 把 assistant 與 tool 訊息放在無權限層,工具輸出只算資訊 **[CONFIRMED, 2025-04 版]**([Model Spec](https://model-spec.openai.com/2025-04-11.html)),也就是她自己產生的目標權限不該高過 owner 的話。**[repo]** 我對照了筆記留下的疑問,結論是 commit `0e8856f`、`28f39af` 只修了症狀:Plan 看得到別人的話只有 20 分鐘(`HEARD_WINDOW_MS`,`packages/mind/src/mind.ts`),遊戲 hold 只有 60 分鐘(`game_hold_mins`),而且只擋她「自己想開」的動作,任何人開口要求都能繞過,沒有區分 owner 和觀眾。**[推論]** V3 需要獨立的 directive 紀錄,含 `issuer`、`authority_level`、`scope`、`effect`、`expires`(預設 `until_revoked`)、`source_event_id`,每次呼叫都注入,同時把被禁的工具從清單移除,動作路徑上再放一道 deny-first 的程式檢查,出錯時 fail closed。「說了卻沒做」的主解法是讓台詞和工具在同一次呼叫產生,而且「完成了」要等到結果回來才准講;`packages/agent/src/claims.ts` 的 regex 自己就寫明只是 safety net,結構化的那一半才值得擴充。承諾應該變成物件,逾期未兌現就回報給她,讓她在台上自己修正。

遊戲方面,LLM 選高層參數化動作、確定性程式執行與處理反射,這個模式已有多方驗證。Voyager 拿掉 self-verification 少 73% 物品、隨機課程少 93%,每個任務最多 4 輪就換題 **[CONFIRMED, paper]**,但 GPT-4 critic 會誤判([Voyager](https://arxiv.org/html/2305.16291));MINDcraft 用 47 個工具,寫程式的功能預設關閉,並警告不要在公開伺服器開啟 **[CONFIRMED]**([paper](https://arxiv.org/html/2504.17950v1)、[repo](https://github.com/mindcraft-bots/mindcraft));AIRI 用 no-action 預算和 signature 擋空轉 **[code]**([brain.ts](https://github.com/moeru-ai/airi/blob/main/integrations/minecraft/src/cognitive/conscious/brain.ts)),並規劃把 Mineflayer 換成 Fabric mod **[doc]**。**[repo]** Miyoria 已有 Fabric mod 和任務契約,所以缺口是:受理與完成分開,用程式 predicate 判定成功(「背包有 stone_pickaxe」),有界重試;Neuro 那種 force 失敗就立刻重試的做法不要帶進語音,否則會變成講話迴圈 **[推論]**。

記憶沒有哪個架構有乾淨的優勢證據,因為主要 benchmark 本身有爭議(見衝突表)。Letta 把對話放進檔案就拿到 LoCoMo 74.0%,高於 Mem0 回報的圖譜版本 **[vendor]**([Letta](https://www.letta.com/blog/benchmarking-ai-agent-memory)),簡單的基線就足以挑戰專用系統。Generative Agents 的消融顯示記憶、反思、規劃真的有用(TrueSkill 29.89 對 21.21),也記錄了 embellishment 這類失敗 **[CONFIRMED, paper]**([Park et al.](https://arxiv.org/html/2304.03442))。**[推論]** 可辯護的設計是三層:永遠在 prompt 裡、有上限的 pinned core(人格、directive、未兌現的承諾);不可變的事件日誌;帶證據指標的衍生記憶,在背景整理。Directive 不能靠檢索,漏掉一個事實只是一句尷尬的話,漏掉「不准玩」就是抗命。寫入時要帶來源與親歷與否(AIRI [#2883](https://github.com/moeru-ai/airi/issues/2883) **[issue]**),人物事實要逐條有證據(MaiBot [#2366](https://github.com/Mai-with-u/MaiBot/issues/2366) **[issue, 只讀標題]**)。Letta server repo 已在 2026-08-16 封存,自動 dreaming 在原生 Windows 預設關閉 **[doc]**([letta-code](https://github.com/letta-ai/letta-code/blob/main/README.md)),不適合當相依。

評測要用程式判定一切可檢查的規則,LLM judge 只留給品味,並用人工校準。服從與誠實要看 pass^k:單次 75% 的成功率,連三次只剩約 42% **[CONFIRMED]**([Anthropic evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents))。**[repo]** `packages/replay` 已能重播,但 V2 §7 自己寫明只跑過單元測試、模擬與 fixture。**[推論]** log 重播有一個根本限制:她的行為一旦不同,錄下來的未來就失效,所以兩小時的服從測試必須是 closed-loop,用假遊戲、假 executor 和模擬使用者。第一批 20 到 50 題直接取自真實事故,兩小時的 pickaxe log 當固定 fixture,再注入工具拒絕、逾時、ASR 聽錯。「不重複」要和最低活動量一起評,否則一個沉默的版本會滿分通過。

## 4.8 秒主要是 GPU 爭用,換模型救不了

生產級 cascade 已收斂成同一套:快速 VAD、CPU 上的小型 end-of-turn 模型、可取消的各階段、在 turn 確認前先起 LLM,以及只記錄使用者聽到的內容。Daily 指南的目標是 1,500 ms,其典型表格加總 1,293 ms **[vendor-adjacent]**([guide](https://voiceaiandvoiceagents.com/));LiveKit 預設 `preemptive_generation` 開、`preemptive_tts` 關 **[vendor]**([docs](https://docs.livekit.io/agents/logic/turns/tuning.md)),它的 adaptive interruption 自報 86% precision、100% recall,但只跑在 LiveKit Cloud,日中表現沒有公布 **[vendor]**([blog](https://livekit.com/blog/adaptive-interruption-handling))。OpenAI Realtime 用 `semantic_vad` 依語意判斷對方講完沒 **[excerpt]**([guide](https://developers.openai.com/api/docs/guides/realtime-vad)),Gemini Live 的 proactive audio 是找到的唯一會依相關性決定不回應的商用功能 **[excerpt]**([docs](https://ai.google.dev/gemini-api/docs/live-api/capabilities));Deepgram 提醒 eager end-of-turn 會讓 LLM 呼叫增加 50 到 70% **[vendor, excerpt]**([Flux](https://developers.deepgram.com/docs/flux/configuration)),speculative 不是免費的。Moshi 約 200 ms **[vendor]**([paper](https://arxiv.org/abs/2410.00037)),但沒有找到日文或中文路徑,PersonaPlex 只支援英文且在 A100 上測試 **[vendor]**([card](https://huggingface.co/nvidia/personaplex-7b-v1/blob/main/README.md)),不適用。

**[repo-實測]** 同日 17 筆語音回應的 `latency_ms` p50 為 4,808 ms、p90 為 7,083 ms、最小值 3,448 ms。這個欄位是首次輸出減去最後一則 focus 訊息的時間戳(`packages/agent/src/turn.ts`),不等於「對方講完到她出聲」,真實體感有可能更差,V3 需要獨立的 `speech_end → first_audio_played`。同樣的 Qwen3-TTS 1.7B,在較慢的 RTX 4060 Windows 上公開數據是首包 460 ms、RTF 1.83(此處 RTF 大於 1 才快於即時)**[community]**([faster-qwen3-tts](https://pypi.org/project/faster-qwen3-tts/)),Miyoria 則是 4 到 5 s、RTF 0.46 到 0.92 **[repo]**。差距約十倍,而且發生在更快的卡上。Windows 沒有跨 process 的 GPU 優先權,MPS 只支援 Linux 與 QNX **[CONFIRMED]**([NVIDIA](https://docs.nvidia.com/deploy/mps/when-to-use-mps.html)),GPU 使用率超過 95% 時 Windows 還可能優先照顧遊戲 **[CONFIRMED]**([NVIDIA](https://nvidia.com/en-us/geforce/guides/broadcasting-guide));Kyutai 在資料中心卡上也量到共用 GPU 時 TTS 從 450 ms 退到 750 ms **[vendor]**([Unmute](https://github.com/kyutai-labs/unmute))。VRAM 溢出也有第一手跡象:**[repo]** 專案筆記記錄沒有卸載模型時,歌曲轉換會從約 10 it/s 掉到約 7 s/it。不過爭用仍是推論,沒有公開測試跑過 Qwen3-TTS 和遊戲並行,log 也要先分開 `queue_wait` 和 `synth_first_audio`,因為排隊也可能是原因。

動手花錢之前,先做四項各幾分鐘的檢查:依序在閒置、只開 OBS、加 VTube Studio、加 Minecraft 下跑 benchmark;直播時看 Task Manager 的共用 GPU 記憶體;把遊戲和 VTS 鎖幀到 GPU 約 80%,關 NVENC look-ahead;分開記錄排隊與合成時間。Sysmem fallback 設定的說法來自部落格 **[community, excerpt]**([RunAIHome](https://runaihome.com/blog/shared-gpu-memory-slow-local-ai-sysmem-fallback-fix-2026/)),開之前先測,它會把變慢轉成 OOM。

ASR 是筆記和專案史直接衝突的一項。語音筆記建議 SenseVoice 上 CPU,理由是省 VRAM、少一個爭用者 **[推論]**;但 **[repo]** owner 在 2026-11-02 特地從 SenseVoice 換到 Qwen3-ASR-0.6B,因為 SenseVoice 忽略 hint,把「Miyo」聽成 meo、把「DeepSeek」聽成 deep sick,而且當時的取捨是準確度優先。叫名字是 floor policy 第一條規則,聽不到名字,再快也沒用。本報告的立場:把「ASR 離開 GPU」當目標,不當結論。先做完上面四項檢查,再用真實 log 片段比較兩者的**名字召回率**;SenseVoice 若能靠確定性的 alias 對照表補回名字,就切過去。雲端串流(Soniox 約 $0.12/hr **[vendor, excerpt]**,[定價](https://soniox.com/pricing))能給 partial transcript,但會把成員語音送給第三方,屬於 owner 要決定的隱私問題。

Turn detection 是便宜又確定的升級。**[repo]** 現在是能量門檻 `end_silence_ms` 600,V2 §7 也註明 Silero VAD 和 speculative 只留了接口。Smart Turn v3 是 8 MB int8、BSD-2、CPU 上數十毫秒,搭配 VAD `stop_secs` 0.2 **[vendor]**([repo](https://github.com/pipecat-ai/smart-turn))。作者自測日文 96.76%、中文 88.57% **[vendor]**([Daily](https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/))。**[推論]** turn detection 跑在人類的語音上,所以對 Miyoria 重要的是中文那個較弱的數字,而且測試集很可能不含台灣華語,要留 timeout fallback 並用自己的片段校準。要注意 speculative 和非串流 ASR 的相依:沒有 partial,只能在 VAD 停止、片段定稿後才起 LLM。LLM 可以先跑,TTS 要等 turn 確認,否則會把最稀缺的 GPU 花在可能丟掉的工作上。Backchannel 沒有框架會生成,要用預錄的「うん」「嗯」,配 MaAI(少數支援日中的小模型,CPU 成本未知)**[doc]**([MaAI](https://github.com/MaAI-Kyoto/MaAI))或簡單規則。

TTS 的第一步是把 x-vector 換成 ICL,速度幾乎一樣(TTFA 152 對 149 ms)**[community]**([faster-qwen3-tts](https://pypi.org/project/faster-qwen3-tts/)),配上每種情緒、每種語言一段的參考音。ZerolanLiveRobot 已經用 `[lang][sentiment]` 檔名這樣選參考音 **[code]**([tts_prompt_manager.py](https://github.com/AkagawaTsurunaki/ZerolanLiveRobot/blob/main/manager/tts_prompt_manager.py)),參考音可以用既有的 `design_voice.py` 離線產生。ICL 對情緒的實際效果沒有人比較過,要試聽。不要為了省 VRAM 換 0.6B:她講日文,而日文 WER 從 3.823 升到 6.404 **[vendor]**([報告](https://arxiv.org/html/2601.15621))。本機備案是 GPT-SoVITS(MIT、中日皆可、4060 Ti 上 RTF 0.028,此處越低越好 **[vendor]**,[repo](https://github.com/RVC-Boss/GPT-SoVITS))。雲端要付出重新 clone 的代價,聲音的所有權會換手:

| 配置 | 估計 voice-to-voice **[推論]** | 每串流小時 | 保留她的聲音 | 主要風險 |
|---|---|---|---|---|
| 本機調校後 + CPU ASR | 1.3–2 s(前提是爭用解決) | $0 | 是 | 重遊戲時仍退化 |
| Soniox + 本機 TTS | 1.2–1.9 s | 約 $0.05 | 是 | TTS 爭用還在 |
| 本機 ASR + Fish S2.1-Pro | 1.1–1.6 s | 約 $0.07 | 要重新 clone | 授權與日文品質未驗證 |
| Soniox + MiniMax HD / Eleven v3 | 1.3–2 s | 約 $0.50 | 要重新 clone | Eleven v3 為 758 ms |
| `gpt-realtime-2.1` | 只有廠商說法 | 約 $1.84 起 | 未驗證 | 失去管線控制、工具與聲音 |

成本假設每小時 24 分鐘人聲、18 分鐘她講話,不含 LLM,不含電費。延遲欄全是估計,沒有在這套環境量過,台灣到各雲端的實際延遲也沒量。Vapi 與 Coval 的提示看來是英文,日中都沒有獨立 benchmark([Vapi](https://humannessindex.vapi.ai/) **[3rd-party]**)。整條 cascade 應該保留,因為她的聲音、工具和每人邏輯比 speech-to-speech 省下的時間更重要。**筆記裡沒有任何 DeepSeek 的實測**,預算裡 400 到 650 ms 的 LLM 首子句只是其他系統的規劃數字,V3 要先量台灣到 API 的 TTFT,按 reasoning 等級分開記錄。

多人語音是公開未解的問題,而 V2 設計文件的做法需要改。「Speak or Stay Silent」顯示 zero-shot 接近隨機,Gemini 3.1 Pro 為 61.0 / 60.5 / 64.5,GPT-5.2 為 59.2 / 55.4 / 56.9;LoRA 後的小模型可到約 72%,三位人類標註者在 Friends 子集只有 60 到 66% **[CONFIRMED, paper]**([arXiv 2603.11409](https://arxiv.org/html/2603.11409))。**[repo]** V2 §3.3 寫的是灰色區交給 fast 模型判斷,這正是接近隨機的 zero-shot 用法。研究語料是會議、影集和財報電話,不含繁中或 Discord,所以 DeepSeek 在這裡的表現仍要實測。**[推論]** 她可以決定「想多活躍」,但每一個停頓點的即時判斷應該由規則加校準過的特徵負責,最差的錯誤類別是別人在談她而不是跟她講話,這類連人類也會錯。

歌唱方面,**[repo]** 目前轉換時要卸載 TTS 和 ASR,她等於失聰。ASR 離開 GPU 後 3.2 GB 的歌曲工作在沒有遊戲時放得下,sing worker 在她講話時暫停 chunk 是 Windows 上唯一可用的優先權機制 **[推論]**;遊戲中則可以把轉換丟到雲端,L4 約每首 $0.013 到 $0.027 GPU 時間,冷啟動未量 **[推論,基於 [Modal 定價](https://modal.com/pricing)]**。

## Discord:語音不需要 self 帳號,只有 Go Live 需要

### Self-bot 政策風險

條文沒有灰色地帶。Community Guidelines item 14 寫的是 "Each account must be associated with a human, not a bot." **[CONFIRMED, 2025-09 生效]**([Guidelines](https://discord.com/guidelines));Help Center 明言在 OAuth2 / bot API 之外自動化一般使用者帳號是禁止的,可能導致終止帳號 **[CONFIRMED]**([Support](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots));Platform Manipulation 說明也禁止修改 client **[CONFIRMED]**([explainer](https://discord.com/safety/platform-manipulation-policy-explainer))。Miyoria 的 voice node 用 user token 同時跑語音和 Go Live,角色帳號也不對應到真人,等於踩到 item 14 兩次,**沒有任何設定能讓它合規** **[推論]**。

**[repo]** `docs/DECISIONS.md` 第 9 條記錄 owner 在 2026-11-01 決定自負風險,R2 把影響寫成語音與 Go Live 停擺。這次研究多出來的是風險範圍:Developer Terms 的處分清單涵蓋 app、developer 帳號、developer credentials 與其他協議,而門檻是 Discord「相信」你「可能」違反,Terms 又包含 ToS 和 Guidelines **[CONFIRMED]**([Developer Terms](https://support-dev.discord.com/hc/en-us/articles/8562894815383-Discord-Developer-Terms-of-Service))。如果 Discord 把兩個帳號連起來,受影響的就不只 self 帳號,還有文字 bot 和 app;Developer Policy item 14 又限制被移除的 app 以相同形式重建 **[CONFIRMED]**([Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy))。必須誠實說明不知道的部分:**沒有權威來源說明 Discord 如何偵測 self-bot、處分比例多高、是否會連坐,或 Go Live 會不會招來額外審查**,搜到的都是揣測。這是機率未知、影響範圍比原估大的風險,不是已證實的高頻事件。規模上的前例是 2025 年 5 月 Shapes, Inc. 與據報十萬以上 bot 被封,但理由互相矛盾,來源也弱 **[REPORTED, weak]**([Gaming HQ](https://gaminghq.eu/2025/05/16/discord-bans-100000-ai-bots-from-shapes-inc-after-major-policy-violations))。另外 self 帳號沒有 Bot tag,AI 身分揭露更難做;dvs 的 README 也警告任何帳號自動化都可能導致永久封鎖 **[community]**([Discord-video-stream](https://github.com/dank074/Discord-video-stream))。

技術面同樣脆弱。Developer change log 到 2026-10-30 都沒有給 bot Go Live 或影片的項目 **[CONFIRMED]**([Change Log](https://docs.discord.com/developers/change-log))。DAVE 在 2026 年 3 月後成為強制,舊 client 無法參與 **[CONFIRMED]**([Discord Blog](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted))。dvs 的 README 完全沒提 DAVE,套件 npm 頁警告隨時會壞;**[repo]** `hybrid` 模式動到私有欄位 `_voiceConnection`,`docs/protocols/voice-link.md` 仍標示未對真實 Discord 驗證。

好消息是 voice node 已經用 `@discordjs/voice` 收發語音,它搭配 `@snazzah/davey` 支援 DAVE **[CONFIRMED]**([discord.js](https://discord.js.org/docs/packages/voice/stable)),`docs/DECISIONS.md` R2 把「bot 只說不聽」當降級方案的想法已經過時。要先驗一件事:discord.js 文件說收音行為 Discord 沒有文件化、不保證穩定,而 Discord 的 voice 文件又描述 bot 收發 Opus([Voice Connections](https://docs.discord.com/developers/topics/voice-connections) **[CONFIRMED]**)。所以第一步是一個 spike:bot 帳號在真實伺服器上、DAVE 下、每人一條串流。這個 spike 也一併驗證整個多人語音設計的前提。

| 方案 | 合規 | 她能自己開台嗎 | 代價 |
|---|---|---|---|
| **Tier A** bot 講話收音,owner 用官方 client Go Live OBS 投影視窗 | 是 | 否,每次要 owner 手動。腳本化那個 client 就回到自動化使用者帳號 | 一次點擊、一台登入的電腦 |
| **Tier B** bot 講話收音,畫面走 YouTube / Twitch 或 Activity,用頻道狀態連結 | 是 | **串流平台可以**,OBS 開播本來就能自動化 **[推論]** | 觀眾要離開 Discord 看畫面;要遵守該平台規則,而 Neuro 和 Nothing, Forever 都在 Twitch 被停權過;Activity 不支援 WebRTC,HLS 可行性未驗 **[CONFIRMED]**([Activities](https://docs.discord.com/developers/activities/development-guides/networking)) |
| **Tier C** 現狀:user token 跑語音和 Go Live | **否** | 是 | 風險範圍可能及於 bot 與 developer 帳號 |
| **Tier C′** 語音移到 bot,user token 只留 Go Live | **否** | 是 | 暴露面縮小,仍違規。只適合作過渡期 |

本報告的建議:無論最後選哪個,語音都先移到 bot 帳號,這是風險下降最大的一步,也消除了 `hybrid` 的問題。之後預設 Tier A 加 Tier B 的串流平台備案,退掉 self 帳號。**[推論]** 這會和「她自己決定開台」的目標衝突,Tier B 是唯一能保住這點又合規的路。如果 owner 選擇保留 Tier C′,至少要把風險範圍更新到 R2,把 Go Live 當成隨時會消失的可選層,並且絕不接受 owner 以外任何人的 token(Developer Policy item 4 **[CONFIRMED]**)。

### Discord 體驗

**[推論]** 最適合角色的做法和 owner 既有偏好一致:一到兩個頂層指令,其他都放進面板。Components V2 的 Container 用於系統通知和面板,角色台詞維持一般訊息,因為 `IS_COMPONENTS_V2` 會停用 `content` 且無法移除 **[CONFIRMED]**([Component Reference](https://docs.discord.com/developers/components/reference)),通知和角色語氣分開也讓成員分得清系統狀態與演出。Modal 收歌曲請求和記憶編輯,ephemeral 處理個人控制與同意狀態,message context menu 放「不要記住這個」和「回報」,額度已提高到 15 **[CONFIRMED]**([Change Log](https://docs.discord.com/developers/change-log))。Voice channel status 是語音端最醒目的表面,repo 已有 `voice_status`。歌單用一則持續編輯、debounce 的面板,加上 Jockie 式的 session owner 回答「誰能跳歌」**[CONFIRMED]**([Jockie FAQ](https://www.jockiemusic.com/api/v2/faq))。慢工作用 Midjourney 模式,把動作按鈕掛在結果上 **[CONFIRMED]**([docs](https://docs.midjourney.com/midjourney-discord))。設定分三層:伺服器、頻道(Off、Mention only、Chatty)、使用者,隱私取最嚴格者。

限制要照 header 走,不要寫死:全域 50 req/s、每 10 分鐘 10,000 個無效請求、gateway 每 60 秒 120 事件,互動回應要在 3 秒內 **[CONFIRMED]**([Rate Limits](https://docs.discord.com/developers/topics/rate-limits)、[Gateway](https://docs.discord.com/developers/events/gateway)、[Interactions](https://docs.discord.com/developers/interactions/receiving-and-responding))。Typing 只在決定回覆後才用,官方文件本來就說 bot 一般不該用它 **[CONFIRMED]**([Channel](https://docs.discord.com/developers/resources/channel))。回應階梯從便宜到貴是:不動作、emoji 反應、短回覆、完整回覆、thread、語音,而且反應也要有預算,Shapes 的 FAQ 已經有「在每個頻道都講話要怎麼停」這種條目 **[CONFIRMED]**([FAQ](https://wiki.shapes.inc/shape-creator-essentials/frequently-asked-questions/my-shape-is-talking-in-every-channel-how-can-i-stop-it-freewill-interference-solution))。Reply 只在多人或多話題時使用,主動訊息帶 `SUPPRESS_NOTIFICATIONS`。Bot 預設互相忽略,AstrBot 已出現過沒有真人在場的無限迴圈 **[issue]**([#10724](https://github.com/AstrBotDevs/AstrBot/issues/10724))。11 月 16 日起 HTTP 頻道列表會省略 bot 看不到的頻道 **[CONFIRMED]**([Change Log](https://docs.discord.com/developers/change-log)),頻道選單要先處理。

### 三條規則直接碰到現有方向

**Item 13** 禁止為了維持伺服器活躍而自動發訊息 **[CONFIRMED]**([Developer Policy](https://support-dev.discord.com/hc/en-us/articles/8563934450327-Discord-Developer-Policy)),沒有公開門檻。**[推論]** 回應真實事件(歌唱完、遊戲開始、有人進語音)、限定 allowlist 頻道、有 owner 預算的台詞比較安全;冷場後自動丟話題最接近被禁止的情況。V2 的「很主動」決定和 `channel_quiet` 喚醒要照這個標準重審。**[repo-實測]** 同一時段文字頻道只有 5 則主動訊息,實際風險目前不高,問題在設計方向。條文寫的是 messages,語音台詞是否適用沒有定論。

**Item 16** 禁止用 API Data 建立使用者、身分或人際關係的 profile **[CONFIRMED]**。**[repo]** Miyoria 有 `relationships`、`people` 資料表、`crush_threshold`,V2 §3.7 還規劃從 presence 歷史統計「在意的人通常幾點上線」。「每個人都被記得」正是小社群裡最有價值的功能 **[推論]**,但角色記憶算不算 profile 沒有判例。合理的邊界是綁定已聲明的功能、讓使用者查看與刪除、不推論敏感特徵,而統計上線時段和人際關係是最接近紅線的部分。

**Item 21** 禁止未經 Discord 明確許可就用 message content 訓練 ML 模型 **[CONFIRMED]**,本地模型同樣適用 **[推論]**。語音與開源兩份筆記都建議用 Miyoria 的 log 擬合發言 gate,這個建議撞上這條規則,MaiBot 式從群聊學語氣也一樣(見衝突表)。

語音隱私上,E2EE 擋得住 Discord 和外人,擋不住通話裡的參與者,所以她加入就能解密所有人的聲音 **[推論]**。**[repo]** 目前預設 `consent = "opt-out"`,入場會公告。Discord 筆記建議更嚴格:頻道級預設關閉,退出者的音訊在 ASR 之前就丟棄 **[推論]**。Craig 的政策立場是未告知的錄音在許多地區違法,並把顯示錄音狀態當設計目標 **[CONFIRMED]**([Craig](https://craig.chat/privacy))。Developer Terms 要求隱私政策、刪除途徑和資料用途說明 **[CONFIRMED]**,**[repo]** docs 裡沒有獨立的隱私政策文件。未查清的部分:語音音訊算不算 API Data、DeepSeek 或雲端 ASR 算不算 Service Provider、台灣法規如何,都沒有研究,需要找合格的人確認。Item 5 也直接適用,**[repo]** `chat.dm` 是她可以主動發起的能力,雖然有 gate 檢查 consent,仍要確認它代表使用者明確同意,不是預設放行。

## V3 的取捨:V2 骨架已在,缺的是送達、權限與實測

**[repo]** 這是最容易被誤讀的一點:筆記提議的 Arbiter、ActivityManager、task id、claim 檢查、回音排除都已經存在,所以 V3 不該把它們重做一次。下表的「V2 狀態」來自本次對照 repo,不是完整稽核。

| 採用 | 來源 | V2 狀態 | V3 要做的事 |
|---|---|---|---|
| 送達帳本:ack 才算講過,含 `attention_key`、`revision` | GLaDOS | **部分**,Ledger 有 outcome,沒有內容鍵 | 以 Discord 送出成功或語音播完為準,用內容鍵擋重複 |
| 遊戲事件預設 silent,只有新奇或高顯著才請求發言 | Neuro SDK | **沒有**,評論走 15 s 計時 | 評論納入同一份預算,同事件講一次就抑制 |
| 所有台詞共用一個不能被其他動作重置的預算 | MaiBot #2127 的反例 | **部分** | 計數回覆,不計 wait;每回合回覆上限 |
| Directive store:權限、範圍、`until_revoked`、deny-first | Model Spec、Claude Code | **沒有**,只有 60 分鐘 hold | 區分 owner 與觀眾,fail closed |
| 前景單一決策者,台詞與工具同一次呼叫 | Cognition | **部分** | 背景工作只能寫提案 |
| 模型無關的 output moderation,走遍每條路徑 | Nothing, Forever、Neuro | **本次未找到** | 含 fallback 路徑,用「filtered」當角色笑點 |
| Floor:QUEUE、DROP、INTERRUPT,加「快講完」狀態 | Lumi_Nox、Neuro `priority` | **部分**,已有選擇性 barge-in | 音訊結束才釋放,失敗也要釋放 |
| Silero + Smart Turn,LLM 先跑、TTS 等確認 | Pipecat、LiveKit | **只留接口** | 先用自己的片段校準中文 |
| Debounce 加 `consume` 結果,不呼叫 LLM | MaiBot #2276 | **部分** | 被 gate 擋下仍寫入 history |
| 記憶來源欄位、讀取時衰減、pin | AIRI #2883、Lumi_Nox | **部分**,R6 已有來源與信心值 | 親歷與轉述分開,人物事實要有證據 |
| 真實送出時間戳,tool 文字在送出和持久化兩處都清掉 | MaiBot #2127、#2346 | 待查 | 主動回合在送出時就寫入 history |
| pass^k、closed-loop 模擬、fault injection | Anthropic、τ-bench | **部分**,`packages/replay` | 以真實事故建 20 到 50 題 |

| 避開 | 為什麼 |
|---|---|
| 純量 willingness 與擲骰回覆 | MaiBot 已刪除,AstrBot 形成 bot 迴圈 |
| 用 fast 模型 zero-shot 判斷要不要插話 | 接近隨機;V2 §3.3 需要改 |
| 複製 MaiBot 的 Planner / Replyer 分離 | Replyer 看不到 Planner 分析,就是「我會停」的同一個失敗 |
| 沒有證據的 idle timer 提示 | Open-LLM-VTuber、kimjammer 的做法,也最接近 item 13 |
| 熱路徑上的 LLM 摘要、多跳記憶搜尋、LLM-to-LLM 協商 | 都會爆語音預算 |
| 用 LoCoMo 分數選記憶系統,或把 Letta server 當相依 | 分數有爭議、repo 已封存 |
| Full-duplex 與 speech-to-speech | 沒有日中路徑,或失去聲音與工具 |
| 本機 Fish S2 Pro、調小 `chunk_size` 當解法 | FP8 約 12 GB;chunk 只省 200 ms,差距是秒級 |
| 用 Discord 訊息訓練模型或學習語氣(含 MaiBot `ExpressionLearner` 式學習) | Item 21 |
| 先 DM、`/active` 式全頻道回覆 | Item 5、item 13 |

順序上,**[推論]** 先做不需要 owner 想太久的止血:bot 語音 spike、四項 GPU 檢查、正確的延遲指標。再做送達帳本、silent 事件和統一預算,因為這三項最小,卻能解決最顯眼的症狀。然後是 directive store 和 output moderation,之後才是 Smart Turn、ASR 切換和 ICL。Gate 要最後做,因為它需要資料,而資料的取得方式還卡在 owner 的決定。把每個階段的驗收綁在真實 Discord 和語音環境上,不要再只靠 fixture。

## 來源之間有十四處衝突,其中六處會改變設計

前六列會改變 V3 的做法,其餘需要留意,但不影響架構。

| 衝突 | 兩邊的說法 | 本報告的判斷 |
|---|---|---|
| **發言 gate 的訓練資料** | 語音與開源筆記建議用 Miyoria 自己的 log 擬合;Discord 筆記指出 item 21 看來涵蓋這件事 | Item 21 優先。只用 timing、次數這類特徵是否算「message content」沒有答案,先用公開或合成語料,或請 Discord 許可 |
| **ASR 走向** | 語音筆記建議 SenseVoice CPU;owner 於 11-02 因聽不到名字換掉它 | 名字召回率決定一切,先測再切 |
| **「決策者不該是發聲者」對「台詞與動作同一決定」** | 開源筆記歸納前者,harness 筆記主張後者 | 兩者講不同層級。Gate 決定「是否取得發言權」,單一前景呼叫決定「說什麼做什麼」。不要把 MaiBot 的 Replyer 拆法帶進來 |
| **靜默能不能當 trigger** | 語音筆記把群體靜默列為開話題的 fallback,AIRI 也有 silence trigger;Discord 筆記認為這是 item 13 最接近禁止的樣子 | 文字頻道不用靜默 trigger。語音裡只有真人在場時才允許,並與 item 13 的爭議一起記錄 |
| **每人記憶對 item 16** | Neuro 筆記與 Lumi_Nox 都顯示記得個人很有價值;item 16 禁止建立 profile | 限定功能、可查可刪、不推論,上線統計與關係圖是最後才考慮的項目 |
| **Bot 收音的穩定性** | 語音筆記把「音訊依使用者分流」當前提;Discord voice 文件描述 bot 收發 Opus;discord.js 文件卻說收音未文件化、不保證穩定 | 多人語音和移轉 bot 帳號都建立在這點上。先做 spike,並把收音當作可能變動的相依 |
| Neuro 的延遲 | GameSpot 經 Wikipedia 稱低延遲 **[REPORTED]**;SDK 寫秒級 **[CONFIRMED]** | 相容:觀感來自仲裁與填補,SDK 是一手資料 |
| Neuro 的推論位置 | 自訓自架 **[SPECULATION]** 對商用雲端 LLM **[SPECULATION]** | 兩邊都不採信,視為未知 |
| 背景 reasoner 的 context | LiveKit 不給歷史以省成本;Cognition 說部分 context 造成不知情決定 | 跟 Cognition,給修剪過的近期日誌 |
| Reviewer 放哪 | 開源筆記認為 4070S 本機可跑;語音筆記認為 4B 到 8B 太重 | 放 DeepSeek,thinking 關閉、上限約 256 token。GPU 是最稀缺的資源 |
| 情緒狀態 | MaiBot 移除 mood,GLaDOS 保留 PAD,V2 採混合式 | 狀態要有消費者才有價值。V2 情緒要接到參考音選擇和 avatar,否則就是負擔 |
| 記憶 benchmark | Mem0 自列 92.5、Letta 74.0;Letta 稱 Mem0 圖譜版 68.5;Zep 自稱 75.14 ± 0.17,Mem0 反駁為 58.44 **(secondary)** | 未解。不以這些分數決策 |
| 延遲目標 | V2 2.5 s、harness 筆記 2 s、語音筆記 1.5 s | V3 先以遊戲負載下 p50 2.5 s 為驗收,1.5 s 當延伸目標 |
| 零星事實 | Qwen3-ASR VRAM 2–3 GB 估計對專案實記約 1.5 GB;Open-LLM-VTuber 文件列 Letta 記憶,README 卻說長期記憶已移除;DAVE 強制 3/1 或 3/2;Cartesia 40–90 ms 對 Coval 188 ms;Gemini 3.1 Flash TTS 300–500 ms 對 5.06 s(量的東西不同);OpenAI `silence_duration_ms` 500 對 200;Shapes 封禁理由;Nothing, Forever 的 Curie 或 Davinci;Shizuku 募資額 | 引用時都要帶日期和測量方式;VRAM 要以本機 `nvidia-smi` 為準 |

## Owner 要拍板的九件事,第一件卡住其他決定

| # | 決定 | 選項 | 建議 | 卡住什麼 |
|---|---|---|---|---|
| 1 | **Self 帳號** | A、B、C′、維持 C | 語音移到 bot,退掉 self 帳號,走 A + 串流平台備案。Decision 9 和 R2 要改寫 | Voice node 架構、AI 身分揭露、Go Live 自主性 |
| 2 | **她能否自主開台** | 每次要人點(A);只在外部平台(B);違規自動化(C) | 接受 A 的人工點擊,或把「自主開台」的定義改成外部平台 | Autonomy 目標的範圍 |
| 3 | **誰在現場負責** | 全 AI 守則;live 時有人值班 | 公開場合要有人。Vedal 2023 年也說需要;紡ネン雖標榜全無人營運,早期詞彙卻是刻意受限的 **[REPORTED]**([Pictoria](https://prtimes.jp/main/html/rd/p/000000029.000046857.html))。全 AI 的前提是 output moderation 先完成 | 開放程度 |
| 4 | **主動程度與 item 13** | 維持「很主動」;事件驅動;語音與文字分開 | 文字頻道事件驅動加 allowlist;語音主動以「有真人在」為條件 | Arbiter 預算、`channel_quiet` 的用途 |
| 5 | **Gate 的資料來源** | 手調校準;公開或合成語料;向 Discord 申請許可 | 先手調加合成語料,logistic 擬合等 item 21 釐清 | 發言 gate 排程 |
| 6 | **人物記憶邊界與語音同意** | 維持 opt-out;改 opt-in;頻道級預設關閉。關係與上線統計保留與否 | 語音改頻道級 opt-in,補隱私政策與刪除路徑,上線統計先不做 | 記憶 schema、Discord 合規 |
| 7 | **常駐或排定場次** | 24/7;排定直播加文字常駐 | 語音直播用排定場次。Vedal 收斂到 2–3 小時,場次也讓 item 13 和 GPU 預算都好處理 | 排程、成本 |
| 8 | **語音語言與 TTS 路線** | 保留中日雙語或關閉(V2 §6 未決);本機或重新 clone 上雲端 | 先做 ICL 和爭用修正,雲端只當超過門檻時的 fallback。雙語保留與否要看 Smart Turn 和 TTS 實測 | TTS 工作量、月成本上限 |
| 9 | **Minecraft 方法與歌曲來源** | 沿用 mod + 任務契約,或換;歌曲來源的授權策略 | Minecraft 維持確定性 executor,LLM 不在公開場合寫程式;公開場合的歌曲另做版權審查。Rythm 就是被 Google 下架的前例 **[REPORTED]**([GamesRadar](https://gamesradar.com/a-discord-music-bot-with-560-million-users-is-being-taken-down)) | 公開化時程 |

伺服器的受眾也會改變幾個答案:若是公開或年輕族群為主,Developer Policy item 10 要求未標示為年齡限制的 app 必須適合未滿 18 歲 **[CONFIRMED]**,她的人設、翻唱和「暗戀」設定都要重新看過。

## Conclusion

這份研究改變的是問題的形狀。原本的問題是「怎麼做到 Neuro 那樣」,但 Neuro 的內部根本查不到,而查得到的部分指向一個不靠模型的答案:一張嘴、一個仲裁者、一份知道什麼真的傳到對方耳裡的紀錄。V2 給了 Miyoria 那個仲裁者,實測卻顯示它還沒管住她最常做的事。下一步的成敗不在於多聰明,而在於她把時間花在誰身上,以及系統能不能證明這件事。

有一個結論超出筆記本身:合規和臨場感其實指向同一個方向。Item 13 要求的「回應真實事件」,正是治好石鎬重複的同一個機制;item 16 要求的「可查可刪、不推論」,也正是讓記憶不會把幻覺寫成她的過去的同一套紀律;退掉 self 帳號換來的 Bot tag,則把「她是 AI」變成明白的賣點,而在粉絲研究裡,知道她是 AI 並沒有減少喜愛 **[REPORTED]**([Ye et al.](https://arxiv.org/pdf/2509.10427))。「她決定一切」這個目標也要收窄:她可以決定想做什麼、想多活躍、在意誰;每一個停頓要不要接話、一件事講過了沒、誰有權叫她停,這些都該由程式回答,而且要能在 replay 裡證明。還沒有人公開做到多人語音裡的 AI 角色,所以 Miyoria 走到這裡時已經沒有地圖,從現在起,她自己的量測就是最好的研究資料。
