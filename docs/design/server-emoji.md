# 伺服器 emoji 表

狀態:**已實作**(2026-11-10)。程式在 `packages/discord/src/emoji.ts`(表、送出轉換、頻率限制、提示詞區塊)、`emoji-describe.ts`(看圖寫意思)、`packages/voice/voice/src/text.ts` 的 `stripEmoji`(語音不念)。設定見 `miyoria.example.toml` 的 `[modules."platform.discord.bot".emoji]`。和下面原設計的差別:清單不放在固定提示詞(主線固定提示詞已貼著 4000 token 上限),也沒有用 `message_log` 排最常用的,改成有意思的排前面、最多 `max_listed` 個。還沒在真的 Discord 跑過。

合進 `v4-int` 之後(V4 §4.1):主線把清單放在對話紀錄前面那段變動慢的資料裡,排在技能之後、筆記本索引之前(現在是 `packages/brain/selfhost/src/prompt.ts` 的 `SLOW_ORDER`,字數上限 `[modules.agent.mainline] emoji_chars`),表沒變時前綴留在快取。(原本另有一條 V2 管線把它當每回合的資料,V5 階段 1 已經把 V2 管線刪掉。)文字頻道「看一眼」的回應階梯最輕的一階是按表情(`react`,有 `[modules.agent.rhythm]` 的反應上限),`react` 也接受 `:名字:`,提示詞和工具說明都寫了。訊息裡的頻率限制(一則一個、最近 3 則最多 1 則、不連用)照舊在 Discord 送出時做。

(2026-11-08 owner 決定先記錄不做,2026-11-10 改為要做。)

## 現況

- 一般 emoji(🍚、🍙、🍰)原樣送到她那裡,模型認得。🍚 會被理解成白飯,所以「直接跟她講就能餵她」的工具(`accept_food`)也吃得到;單獨一個 emoji 意思模糊,她可能先問再收。
- 伺服器自訂 emoji 只剩名字:`<:fanfan:123>` 變成 `:fanfan:`(`packages/discord/src/mapping.ts:180`)。名字直白她猜得到,名字隱晦就認不出來。
- 她自己:只能用 `react` 按反應(`packages/brain/agent/src/tools.ts`,接受一般 emoji 或 `name:id`),但不知道伺服器有哪些自訂 emoji。語音的規則寫明不要 emoji(`packages/brain/agent/src/prompt.ts:74`、`mainline/prompt.ts:53`);文字沒有限制,但她只會用一般 emoji。

## 想做的樣子

1. **表從哪來**:Discord 連上時讀伺服器的自訂 emoji(名字、id、是不是動態、能不能用),有人新增或刪除時更新。
2. **每個 emoji 的意思**:名字常常看不出意思,所以每個附一句說明。新 emoji 第一次出現時用看圖模型看一次圖寫一句(例如「一碗白飯,討飯用」),存在設定裡;owner 可以在 `miyoria.toml` 自己寫或覆寫。
3. **給她看**:提示詞固定區塊裡放「伺服器表情」清單(`:名字: — 意思`),只在表變動時才變,不破壞快取。太多時取最常被用的前幾十個(可以從 `message_log` 算)。別人傳給她時她也會看到這份說明,`:fanfan:` 就知道是白飯。
4. **她怎麼用**:她寫 `:fanfan:`,送出時換成 `<:fanfan:id>`(動態的是 `<a:…>`);不在表裡的名字照原樣。`react` 也接受 `:名字:`。她照抄來的原始寫法 `<:名字:id>` 先變回 `:名字:` 再換,包在行內程式碼裡的 emoji(`` `<:名字:id>` ``,Discord 會顯示成字)也拿出來(2026-11-11 實際遇到)。`react` 也接受 `<:名字:id>`,一次可以按好幾個(`emojis`,最多 5 個;她之前以為 Discord 一次只能按一個)。
5. **不要一直用**:提示詞寫「偶爾、適時用」,程式也擋:一則訊息最多一個伺服器 emoji;同一個頻道她最近 3 則裡最多 1 則有;同一個 emoji 不連續用兩次。超過的自動拿掉。數字都可設定。
6. **語音**:照舊不用;真的寫了,TTS 前濾掉 `:名字:` 和一般 emoji。

## 動到的地方(預估)

`packages/discord`(讀表、送出時轉換、更新事件)、`packages/brain/agent`(提示詞區塊、`react` 接受名字、輸出前的頻率限制)、TTS 前的文字清理、設定(`[platforms.discord.emoji]` 或類似)、說明的快取(settings store)。

## 貼圖(2026-11-21,已實作)

v5-architecture §9.5 的「貼圖」:她認得伺服器的貼圖,也會傳。照 emoji 的做法,還沒在真的 Discord 跑過。

- **誰送**:文字訊息一律由 bot 帳號經 REST 送(`packages/discord/src/sink.ts`;self 帳號只管語音和 Go Live)。Discord 的建立訊息 API 讓 bot 用 `sticker_ids` 送**這個伺服器自己的**貼圖,不用額外權限;別的伺服器的貼圖要 Nitro,bot 送不了,所以清單只列她說話那個伺服器的。私訊沒有伺服器,不能用。Discord 的標準貼圖不列。
- **表從哪來**:`stickers.ts` 的 `StickerTable`,連上時從伺服器快取讀(`snapshotGuild`),之後跟著 `stickerCreate` / `stickerUpdate` / `stickerDelete` 更新(`GuildExpressions` intent 本來就開著)。`available = false`(伺服器掉了加成等級)的不列、不送。
- **意思**:`[modules."platform.discord.bot".stickers] descriptions` 優先,其次是看圖模型看一次寫的一句(`StickerDescriber`,存在 settings store 的 `discord.sticker.desc.<id>`),再來是伺服器自己寫的說明。Discord 的貼圖沒有圖檔雜湊,而且改貼圖只能改名字、說明和標籤、不能換圖,所以用 id 當快取的鍵。emoji 和貼圖共用一個看圖的佇列(`DescribeQueue`):一次看一張、每張每次啟動最多試一次、同樣 20 秒和 512 KiB 的上限、同一個要看得懂圖的聊天模型。動態的 Lottie 貼圖沒有圖可看,只列名字和標籤。
- **給她看**:提示詞區塊「伺服器貼圖」(contributor `server_stickers`),排在「伺服器表情」後面、筆記本索引前面(同一個 `SLOW_ORDER`),字數上限也是 `emoji_chars`。一行一張:`[貼圖: 名字] — 意思(標籤:…)`,有意思的排前面,最多 `max_listed` 張。只有文字回合、只有她說話的那個伺服器;語音和私訊沒有。名字、說明、標籤都是伺服器的資料,不是指令:每一個都先壓成一行(`safeName`:中和、去掉換行和方括號、截斷),整段再當資料區塊進提示詞。別人傳的貼圖她看到的本來就是 `[貼圖: 名字]`(`incomingText`),所以同一份清單也讓她看懂別人傳的是什麼。
- **她怎麼用**:不是工具、也不是新指令,和 `:名字:` 一樣寫在她的話裡:`[貼圖: 名字]`。送出時 sink 把它從文字裡拿掉,貼圖跟著那則訊息送(長訊息拆成幾則時跟著最後一則)。只寫貼圖的那則就是一張貼圖。Discord 拒收那張貼圖時(`50081` 或沒權限),字照樣送出去。
- **不要一直用**:一則最多一張;同一個頻道她最近 `window_messages`(5)則裡最多 `max_in_window`(1)則有;同一張不連續用;每個頻道每小時最多 `per_hour`(3)張。超過的、名字不在表裡的、私訊裡的、關掉時的,都只是拿掉,從不當字送出去;拿掉之後什麼都不剩的那則不送(scheduler 記一行 `action failed`)。emoji 的程式沒有用到她的心情,所以貼圖也沒有。
- **語音**:不給清單,`[貼圖: …]` 也在 TTS 前濾掉(`stripEmoji`)。語音的回合本來就不給她看這個區塊。
- **紀錄**:她的話照她寫的進對話紀錄(含 `[貼圖: 名字]`),所以之後她知道自己傳過哪張;被限制拿掉的那張紀錄裡還在,和 emoji 一樣。

## 只按反應的道謝、道別(2026-11-21,已實作)

§9.5 的「純道別、純道謝這類訊息可以只回一個反應,不必叫模型」。程式在 `packages/brain/selfhost/src/courtesy.ts`(比對和預算)和 `host.ts` 的 `#reactOnly`(什麼時候用、怎麼記帳),設定在 `[modules.agent.rhythm]`。

- **比對**:不叫模型、固定的規則,寧可漏掉。先拿掉她的名字、提到她的 `@`、emoji、標點和幾個語助詞(啦、喔、好、超、so、ね …),剩下的必須**全部**是已知的道謝或道別片語(繁中、英文、日文,例如「謝謝」「謝啦」「感恩」「掰掰」「晚安」「明天見」「thanks」「thank you」「bye」「good night」「ありがとう」「またね」「おやすみ」)。多一個字就不算:「謝謝你幫我查天氣」「謝謝大家」「不用謝」「沒事了謝謝」都不是。有問號或「嗎、呢」、英文的 what / how / can 這類就不算。一行超過 60 字不看。
- **什麼時候**:只有叫到她的那一行(提及、回覆、叫名字、私訊);沒有附件、貼圖、嵌入或轉傳;沒有提到別人;那個地方沒有正在跑或在等的回合、沒有排隊的事(`Lane.quiet`);沒有派對遊戲在進行(`PartyStatusKey`);她開的工作沒有在那裡等結果;她在那裡的上一句不是在問問題(最近 6 則內);不在語音;緊急停止沒開。條件都過了,再看預算(每個頻道每小時 `courtesy_per_hour`,預設 3)、機率(`courtesy_chance`,預設 0.35)和原本的反應上限(`reactions_per_hour`、`reaction_gap_ms`,這次也算一個)。有一個不過,那一行就照常叫醒她。
- **按什麼**:道謝 💕 🥰 😊、道別 👋 😊、晚安 🌙 😴 💤,隨機挑一個。
- **怎麼記帳**:當成一個「只按了反應、沒有說話」的回合,和模型自己按反應再 `<silence/>` 的回合記得一樣:`agent.turn.started`、`agent.decision`(`respond: true`,理由有 `courtesy: thanks` 和 `reaction only`)、`agent.tool`(`react`)、`agent.turn.completed`(空字)、`agent.turn.outcome`(`silence`,`addressed_by` 是那個人、`focus` 是那一行)。反應本身是同一個 turn 的 `react` action,經 scheduler 送(緊急停止照樣擋)。對話紀錄裡那一行後面加一則 note(標籤「只按了反應」),之後的回合她看得到自己按了什麼。沒有台詞,所以不佔 Floor、不進送達帳本;Arbiter 只追自己放行的回合,不受影響;她自己起頭的話題照舊因為有人說話而算有人接(`initiative.line`)。
- **測試**:`packages/brain/selfhost/test/courtesy.test.ts`(比對的正反例、預算、主機上的整個流程和每一個「不會」的情況)。測試的 harness 預設機率永遠不中,所以別的測試不會偶爾變成只按反應。
