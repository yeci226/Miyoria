# Minecraft:為什麼幾乎不能玩(調查筆記)

狀態:**已照 V4 §11.2 修了程式,還沒實際玩過**(2026-11-10)。§1 到 §5 是 11-08 那場的資料重建和推測(原因後來在 `docs/design/v4-plan.md` §11.1 對照程式碼確認);改了什麼見 §6,只有實際玩一場才看得出來的見 §7。

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
- 11-08 的整理腳本和匯出:`C:\Users\owenl\AppData\Local\Temp\claude\7c9b4a3fb3bcf931\21133156-8dd1-418f-b1ce-c02de590be57\scratchpad\mc-logs\`(暫存資料夾,可能會被清掉;要重做就照 §1 的資料來源重查)

## 6. 改了什麼(2026-11-10,V4 §11.2)

每一項對應 §11.1 確認的原因;遊戲裡還沒跑過,驗證都是單元測試(假執行器、假模組、11-08 的紀錄)。

| §11.2 | 改法 | 在哪裡 |
|---|---|---|
| 1 導演有紀錄 | 導演記得這場每一步:動作、結果(有進展 / 沒有進展 / 失敗 / 被打斷)、失敗碼、遊戲的說明,每次決定都看得到,和事件分開一欄。**還沒做**:變成工作車道上的任務(多輪紀錄、工具迴圈),工作車道還沒有 | `packages/game/src/record.ts`、`director.ts` |
| 2 目標有成功條件 | 決定多了 `want: {item, count}`(`obtain` 沒給就用它的物品);背包有了才算完成,她說完成但背包沒有不算。失敗一次不再結束目標(自己的目標也是),`max_attempts` 3 次、`max_goal_steps` 8 步、`max_goal_secs` 600 秒 | `decision.ts`、`director.ts`、`config.ts` |
| 3 做完要有變化 | adapter 每個用身體的任務前後各看一次背包(加上 `item_picked`),`done` 帶 `data.outcome`;導演把沒有進展的 `done` 當一次失敗。空的 `mine`、拿已經有的東西、`explore` 沒看到新東西都是沒有進展。`stop` 變成即時動作,不是目標也不算成功 | `packages/types/src/game-outcome.ts`、adapter `progress.ts` |
| 4 食物 | `obtain` 認得食物:打獵(跟著動物、準心對到就打)、熔爐烤熟、`farm` 收小麥再做麵包、`{item:"food"}` 挑附近最容易的;另有 `hunt {entity}` | adapter `planner.ts`、`obtain.ts` |
| 5 換方法 | 同一個做法(動作 + 物品,例如 `obtain:bread`)同一個失敗碼兩次就暫停 10 分鐘;`invalid` 的物品做法整場不再用;用完次數的目標也暫停。別的做法成功不會解除。用 11-08 的紀錄重播:`obtain bread` 32 次裡只會放行 9 次,每 10 分鐘最多兩次 | `methods.ts`、`test/methods.test.ts` |
| 6 少叫醒她 | `hostile_near`、`reflex_end` 不再觸發決定;失敗紀錄是獨立一欄(第 1 項) | `config.ts` |
| 7 天黑和死掉 | adapter 從快照看出黃昏就送 `night_started`;導演自己開始 `shelter`(有床就睡,沒有就往下挖三格、從裡面封頂,等到天亮)。死掉記住位置和身上的東西,5 秒後自己開始 `recover` 走回去撿。被打斷的目標結束後回來 | adapter `survival.ts`、`adapter.ts`;`director.ts` |
| 8 技能 | 有 `want` 的目標達成時,這個目標裡有進展的步驟存成技能,下次同樣的東西放進 prompt,也發 `game.director.skill`。**還沒做**:存下來跨重開(§8.3 的工作區),現在只活在模組裡 | `skills.ts` |
| 9 紀錄和推理 | 決定的 trace 多了看到的狀態摘要、`want`、暫停中的做法;決定用 `reasoning: "low"`;11-08 的紀錄是測試。**還沒做**:`packages/eval` 的 `guard` 題目還是舊的防呆,要換成新的才會翻過來 | `director.ts`、`config.ts` |

模組(Java)沒有改。

PR 8 同時寫了另一個重複保護(同一個目標用參數字串當鍵,連續失敗兩次暫停 10 分鐘,`invalid` 整場暫停,她的提示詞列出暫停的目標)。合進 `v4-int` 時留下第 5 項的做法,沒有兩個保護一起跑:暫停的目標本來就由 `methods.ts` 的 `lines` 列進提示詞,被擋時也會催她換一次。它的設定名 `repeat_failure_limit` / `repeat_guard_secs` 當成 `method_repeat_limit` / `method_hold_secs` 的舊名,兩個都寫時以新名為準。

## 7. 只有實際玩一場才能確認的

- 打獵:模組的 `nearby_entities` 沒有座標,只能靠 Baritone `follow` 走到旁邊時準心剛好對到動物,不然往下看 25 度再試。會不會一直打空要實際看;打不到的話,模組在 `nearby_entities` 加上 `position`,adapter 已經會直接瞄準。
- 收成:Baritone `farm` 在附近沒有成熟作物時會不會馬上閒下來(adapter 靠這個判斷「附近沒有」)。
- 避難:Baritone 會不會真的直直往下挖三格(底下是洞穴、水、岩漿時);從坑底看牆面右鍵放方塊會不會剛好封在頭頂;`select_slot` 只找快捷列,方塊在背包上半部時封不了頂。床:`place` 放床、看著它右鍵能不能睡、附近有怪時多久放棄。
- 天黑:黃昏送 `night_started` 時她來不來得及躲好(殭屍 13000 tick 才生);早上她爬不爬得出坑。
- 撿東西:死後 5 秒開始是否已經重生;死在水裡、岩漿或很遠時 `goto` 走不走得到;撿到的東西靠 `item_picked` 和背包差算,掉的東西是死前最後一次快照的背包,可能舊。
- 進展:任務結束後等 1 秒再看一次背包,夠不夠等撿東西的反射。
- 新的 prompt(紀錄、暫停的做法、`want`)加上 low 推理後,她會不會真的換做法,還是換說法;決定一次的延遲和花費。
- 驗收:用 11-08 的開頭重玩一場(晚上、海裡、8 血),看木鎬要多久、目標有進展的比例、`obtain bread` 這種重複還有沒有。
