// How survival actually progresses, for the game's decision loop (appended to the act tool's
// description, so the director's prompt carries it). She picks the next step from what is really
// in her inventory instead of going straight for diamonds with bare hands.

export const GUIDE = `走路、挖掘、戰鬥這些細節交給遊戲裡的 bot(Baritone / AltoClef),你只下高階動作。危險(血量低、敵人靠近、天黑、掉進岩漿)先求生。
像真人一樣一步一步玩:看遊戲狀態裡你實際有的東西(背包、工具、看得到的方塊),不要跳級去做還沒條件的事。
生存的進度(一步一步來,看背包裡實際有什麼,選下一個「現在做得到」的步驟,不要跳級):
1. 空手 mine 看得到的原木(oak_log 這類)→ craft 木材(例如 oak_planks)→ craft 工作台 crafting_table → place 放下來。
2. craft 木棒 stick → 站在工作台旁 craft 木鎬 wooden_pickaxe。
3. 用木鎬 mine 石頭 stone(得到鵝卵石 cobblestone)→ craft 石鎬 stone_pickaxe、石劍、石斧;8 個鵝卵石 craft 熔爐 furnace 再 place。
4. mine 煤礦 coal_ore 拿煤炭(沒有就 smelt 原木燒成木炭)→ craft 火把 torch。
5. 用石鎬 mine 鐵礦 iron_ore → 在熔爐旁 smelt 粗鐵 raw_iron 成鐵錠 → 3 鐵錠 + 2 木棒 craft 鐵鎬 iron_pickaxe。
6. 有鐵鎬才挖得到鑽石、金、紅石;鑽石在很深的地方(Y -59 附近)或洞穴裡。
想要某個工具或材料時可以直接 obtain {item}(例如 iron_pickaxe、torch、furnace):程式照上面的順序自己排好步驟、一步一步做,做完或卡住會回報。
天黑前(看時間)先準備:食物(殺動物、蘋果、麵包)、床(3 羊毛 + 3 木材)或躲進封起來的小屋 / 洞裡。
身體有本能反應(不用下指令):掉進岩漿、快淹死、卡在方塊裡、頭上掉沙會自己逃;被怪打會反擊,血少或苦力怕靠近會逃;餓了會自己吃;卡住約 20 秒會自己掙脫;挖完會撿掉落物。反射打斷動作時會收到事件,結束後再決定下一步。
goto {block} 和 mine 只會找你親眼看得到的方塊(不會透視);附近沒有就 explore 或到地表、洞穴找,不要硬去找礦。
動作失敗時會說原因(缺什麼工具、材料、要在工作台旁…),照著補齊再做,不要重試同一個動作;失敗後有一陣子不能用 goto / mine,要換個方法(obtain、explore、craft)或換個目標。`;
