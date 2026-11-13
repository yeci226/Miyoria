# 伺服器 emoji 表

狀態:**已實作**(2026-11-10)。程式在 `packages/discord/src/emoji.ts`(表、送出轉換、頻率限制、提示詞區塊)、`emoji-describe.ts`(看圖寫意思)、`packages/voice/src/text.ts` 的 `stripEmoji`(語音不念)。設定見 `miyoria.example.toml` 的 `[modules."platform.discord.bot".emoji]`。和下面原設計的差別:清單不放在固定提示詞(主線固定提示詞已貼著 4000 token 上限),也沒有用 `message_log` 排最常用的,改成有意思的排前面、最多 `max_listed` 個。還沒在真的 Discord 跑過。

合進 `v4-int` 之後(V4 §4.1):主線把清單放在對話紀錄前面那段變動慢的資料裡,排在技能之後、筆記本索引之前(`turn.ts` 的 `SLOW_ORDER`,字數上限 `[modules.agent.mainline] emoji_chars`),表沒變時前綴留在快取;V2 管線照舊是每回合的資料。文字頻道「看一眼」的回應階梯最輕的一階是按表情(`react`,有 `[modules.agent.rhythm]` 的反應上限),`react` 也接受 `:名字:`,提示詞和工具說明都寫了。訊息裡的頻率限制(一則一個、最近 3 則最多 1 則、不連用)照舊在 Discord 送出時做。

(2026-11-08 owner 決定先記錄不做,2026-11-10 改為要做。)

## 現況

- 一般 emoji(🍚、🍙、🍰)原樣送到她那裡,模型認得。🍚 會被理解成白飯,所以「直接跟她講就能餵她」的工具(`accept_food`)也吃得到;單獨一個 emoji 意思模糊,她可能先問再收。
- 伺服器自訂 emoji 只剩名字:`<:fanfan:123>` 變成 `:fanfan:`(`packages/discord/src/mapping.ts:180`)。名字直白她猜得到,名字隱晦就認不出來。
- 她自己:只能用 `react` 按反應(`packages/agent/src/tools.ts`,接受一般 emoji 或 `name:id`),但不知道伺服器有哪些自訂 emoji。語音的規則寫明不要 emoji(`packages/agent/src/prompt.ts:74`、`mainline/prompt.ts:53`);文字沒有限制,但她只會用一般 emoji。

## 想做的樣子

1. **表從哪來**:Discord 連上時讀伺服器的自訂 emoji(名字、id、是不是動態、能不能用),有人新增或刪除時更新。
2. **每個 emoji 的意思**:名字常常看不出意思,所以每個附一句說明。新 emoji 第一次出現時用看圖模型看一次圖寫一句(例如「一碗白飯,討飯用」),存在設定裡;owner 可以在 `miyoria.toml` 自己寫或覆寫。
3. **給她看**:提示詞固定區塊裡放「伺服器表情」清單(`:名字: — 意思`),只在表變動時才變,不破壞快取。太多時取最常被用的前幾十個(可以從 `message_log` 算)。別人傳給她時她也會看到這份說明,`:fanfan:` 就知道是白飯。
4. **她怎麼用**:她寫 `:fanfan:`,送出時換成 `<:fanfan:id>`(動態的是 `<a:…>`);不在表裡的名字照原樣。`react` 也接受 `:名字:`。她照抄來的原始寫法 `<:名字:id>` 先變回 `:名字:` 再換,包在行內程式碼裡的 emoji(`` `<:名字:id>` ``,Discord 會顯示成字)也拿出來(2026-11-11 實際遇到)。`react` 也接受 `<:名字:id>`,一次可以按好幾個(`emojis`,最多 5 個;她之前以為 Discord 一次只能按一個)。
5. **不要一直用**:提示詞寫「偶爾、適時用」,程式也擋:一則訊息最多一個伺服器 emoji;同一個頻道她最近 3 則裡最多 1 則有;同一個 emoji 不連續用兩次。超過的自動拿掉。數字都可設定。
6. **語音**:照舊不用;真的寫了,TTS 前濾掉 `:名字:` 和一般 emoji。

## 動到的地方(預估)

`packages/discord`(讀表、送出時轉換、更新事件)、`packages/agent`(提示詞區塊、`react` 接受名字、輸出前的頻率限制)、TTS 前的文字清理、設定(`[platforms.discord.emoji]` 或類似)、說明的快取(settings store)。
