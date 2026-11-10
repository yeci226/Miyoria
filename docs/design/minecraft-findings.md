# Minecraft:為什麼幾乎不能玩(調查筆記)

狀態:**暫停**(2026-11-08)。已做的是昨晚那場的資料重建和別人的做法對照;讀程式碼找原因做到一半就停了,下面的原因都還是**從資料推的,沒有對照程式碼確認**。

## 1. 昨晚那場(2026-11-08 00:08–02:21)

資料來源:

- `data/miyoria.db` 的 `log_events`(`at` 是微秒,`kind`、`source`、`body` JSON)。相關的 `source`:`game.minecraft`(adapter 事件:task 開始 / 失敗 / 完成 / 進度、reflex、damage、death、item_picked、hostile_near、night_started、low_health)、`game.director`(`thought`:她的決定,有 `goal`、`action`、`verdict`、`commentary`;`observation`:目標結果,有 `code`、`detail`;`proposal`:她要講的話)、`game.session`、`arbiter.game`。這段時間 1929 筆。讀的時候用唯讀開(`file:...?mode=ro`),Core 在用。
- 遊戲 log:`%APPDATA%\PrismLauncher\instances\Miyoria-1.21.1\.minecraft\logs\latest.log`(資料夾是 `.minecraft`)。只多確認了死亡,沒有目標的資訊。
- 沒有 recorder / replay 檔,adapter 也沒有自己的 log。

經過:

- 一進去就是晚上、在水裡、8 血。一開始就用 `obtain bread`(缺小麥、沒工作台)和 `obtain cooked_beef`(「沒有合成配方」)要食物。
- 前半小時被屍殼追,逃跑反射一直打斷探索和移動(`busy`)。
- 00:33–00:39 有一段真的有進度:石鎬、木劍、石斧、木材、木棒。
- 晚上被溺屍和骷髏打死,鎬子掉了要重做;木鎬重做花了大約 22 分鐘。
- 最後半小時漂在海上:`explore` 一次跑 119 秒、看不到陸地也算「完成」,飢餓 8 → 0,02:21 第 5 次死掉(溺屍,x 1392, z 1849,離起點很遠),結束。
- 遊戲裡 20 分鐘一個晝夜,她很多時間在晚上。

數字:

| 項目 | 值 |
|---|---|
| 目標結果(150 筆) | precondition 52、done 41、invalid 35、timeout 7、unreachable 5、not_found 5、gave_up 3、reported 2 |
| 不同的目標文字 | 70 個;問題一樣,只是換說法 |
| 連續沒做成 | 最長 25 次;同一個錯誤碼最長連 6 次 |
| 目標之間的間隔 | 中位數 5 秒(很多是 3–5 秒的失敗迴圈),平均 52 秒 |
| 她的動作 | obtain 135、stop 64、mine 31、explore 26、goto 8、follow 3、chat 3;571 個 thought 裡 275 個有動作 |
| 最常見 | stop 64、`obtain bread` 35、`obtain fishing_rod` 19、`obtain wooden_pickaxe` 18、`explore` 16、`mine stone` 16 |
| task 層的失敗(141) | precondition 54、invalid 37、superseded 15、busy 11、timeout 7、unreachable 6、cancelled 6、not_found 5 |
| 其他 | 死亡 5、受傷 36、反射 55(溺水 23、逃跑 22、反擊 8、脫困 2)、敵人靠近 57、撿到東西 57 |
| 41 個「done」 | 真的讓背包有變化的只有約 8 個;19 個是 `stop`,7 個是 `explore` 跑滿時間沒找到東西,4 個是「已經有木劍 / 木鎬」 |

錯誤說明的原文(遊戲回給她的 `detail`),寫得其實不差:

- precondition:「材料不夠:還缺 小麥×3,而且要站在工作台旁邊做」
- invalid:「參數不對:no crafting recipe makes cooked_beef」(`apple`、`cod` 也是)
- timeout:「取得木鎬失敗,卡在「砍原木×2」:挖原木挖太久了」、「took longer than 300 s」
- not_found:「附近看不到石頭、鵝卵石(只能找、挖你親眼看得到的,不會透視)。換個地方 explore」、「附近看不到…原木…探索了 90 秒也沒找到」
- unreachable:「看得到的橡木原木在 19 格外(-722, 75, 829),先 goto {"block":"oak_log"} 走過去再做」
- busy:「interrupted by a reflex: flee」;superseded:「replaced by stop」;gave_up:「做不到」;reported:「她說完成了」

遊戲回給她的資訊:每個 task 有錯誤碼和一句說明,多步驟的 `obtain` 有進度(「取得石鎬:第 4/6 步,放下工作台」);事件有受傷(量、來源、剩餘血量)、死亡、低血量(血、飽食)、敵人靠近、天黑、撿到東西、反射。**沒有定期的背包、位置、生態域、飢餓度快照**,血量和飢餓只在出事時才看得到。

## 2. 推測的原因(還沒對照程式碼)

1. **她拿不到完整的狀態。** 沒有背包、位置、飢餓的定期快照,她在用猜的,連在不在海上都要從自己的評論推。
2. **動作的切法讓她一直選錯。** `obtain` 只會合成,她拿它來弄食物:invalid + precondition 共 87 次。缺「打獵 / 收集 / 煮熟 / 吃」這類動作。
3. **「done」不代表有進展。** `stop`、`explore` 跑滿時間都算成功,她看到的是一直成功,其實沒變化。
4. **少了一直開著的生存反射。** 有逃跑、溺水、反擊、脫困,沒有自己吃東西、天黑前躲起來;死掉就掉鎬子,重做很久。
5. **失敗後沒有換方法的規則。** 說明有回給她,但她換個說法再要一次一樣的東西。

讀程式碼那一段要回答、但還沒做完的:目標是誰寫的(哪個模型、哪個 prompt)、每個錯誤碼在哪裡產生、為什麼 `done` 之後馬上又是同一個目標、invalid 和 precondition 為什麼每幾秒輪流出現、失敗資訊有多少回到下一次決定、執行器實際能做什麼(mod 裡有 `baritoneStub`,昨晚 bridge 連上時是 Baritone 開、AltoClef 關)。從 `game.director`、`extensions/minecraft/adapter/src`(planner、obtain、steer、actions、guide)、`extensions/minecraft/mod/.../bridge/game`(TaskTracker、GameActions、Reflexes)讀起。

## 3. 別人怎麼做

- **AIRI**(`moeru-ai/airi` 的 `services/minecraft`,原本的 `airi-minecraft` 2025-02 封存):用 mineflayer,bot 用自己的帳號連進伺服器當一個玩家,不是操作實況主看到的客戶端。程式分 `mineflayer/`、`skills/`、`agents/`、`prompts/`,致謝 Mindcraft。LLM 能用的動作和失敗後怎麼重新規劃,公開文件沒寫。
- **Mindcraft**(`kolbytn/mindcraft`,印象中的做法,沒有這次重新確認):LLM 下高階指令(收集 N 個方塊、合成、找方塊、看背包),指令自己處理中間步驟;保命、脫困、逃跑、自衛這類反射一直開著;LLM 也可以自己寫新技能的程式碼。
- **Neuro-sama**:Minecraft 怎麼接沒公開,也確認不了有沒有用 mineflayer。公開的是 Neuro Game SDK:遊戲擁有邏輯和驗證,先註冊動作(名稱、一兩句說明、JSON schema),她只從裡面挑;每個動作回成功或失敗,失敗要附她看得懂、知道下一步的說明;遊戲自己挑時機送狀態,只給人類看得到的,但要「非常明確」;可以強制她從幾個動作裡挑一個,強制時失敗會整組重試。另外她玩 Minecraft 本來就很笨,效果多半來自好笑的失敗。

我們其實已經是 Neuro SDK 那種架構(高階動作 + 錯誤碼 + 說明),差在 §2 的五點。

## 4. 之後想做的方向(還沒決定)

- **遊戲目標的任務迴圈**:每個目標有完成條件、步數和時間預算;同一個錯誤碼連兩次就要換方法;做完或真的卡住才交回給她。做在 `game` 模組,不用接 DeepSeek Harness。
- **技能庫**:成功過的步驟存成技能(「沒石頭時怎麼做石鎬」、「在海上怎麼找食物」),下次直接用,只在相關時放進提示詞。
- 加上 §2 的:定期狀態快照、食物類動作、`done` 只在有變化時才算、吃東西和天黑避難的反射。
- 驗收用昨晚這場當題目(v3 §18 的真實事故題目)。

## 5. 來源

- [moeru-ai/airi services/minecraft](https://github.com/moeru-ai/airi/tree/57be907359e162dc0dce071be29bd42c6040c10b/services/minecraft)、[airi-minecraft(封存)](https://github.com/moeru-ai/airi-minecraft)
- [Neuro Game SDK API README](https://raw.githubusercontent.com/VedalAI/neuro-game-sdk/main/API/README.md)、[規格](https://raw.githubusercontent.com/VedalAI/neuro-game-sdk/main/API/SPECIFICATION.md)、[最佳實踐](https://raw.githubusercontent.com/VedalAI/neuro-game-sdk/main/API/BEST_PRACTICES.md)
- 昨晚的整理腳本和匯出:`C:\Users\owenl\AppData\Local\Temp\claude\7c9b4a3fb3bcf931\21133156-8dd1-418f-b1ce-c02de590be57\scratchpad\mc-logs\`(暫存資料夾,可能會被清掉;要重做就照 §1 的資料來源重查)
