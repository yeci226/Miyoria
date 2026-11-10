// How survival actually progresses, for the game's decision loop (sent with the executor's
// goals, so the director's prompt carries it). She picks the next step from what is really in
// her inventory instead of going straight for diamonds with bare hands.

export const GUIDE = `走路、挖掘、戰鬥這些細節交給遊戲裡的 bot(Baritone / AltoClef),你只下高階動作。危險(血量低、敵人靠近、天黑、掉進岩漿)先求生。
像真人一樣一步一步玩:看遊戲狀態裡你實際有的東西(背包、工具、看得到的方塊),不要跳級去做還沒條件的事。
生存的進度(一步一步來,看背包裡實際有什麼,選下一個「現在做得到」的步驟,不要跳級):
1. 空手 mine 看得到的原木(oak_log 這類)→ 木材(例如 oak_planks)→ 工作台 crafting_table → place 放下來。
2. 木棒 stick → 站在工作台旁做木鎬 wooden_pickaxe。
3. 用木鎬 mine 石頭 stone(得到鵝卵石 cobblestone)→ 石鎬 stone_pickaxe、石劍、石斧;8 個鵝卵石做熔爐 furnace 再 place。
4. mine 煤礦 coal_ore 拿煤炭(沒有就把原木燒成木炭)→ 火把 torch。
5. 用石鎬 mine 鐵礦 iron_ore → 在熔爐旁把粗鐵 raw_iron 燒成鐵錠 → 3 鐵錠 + 2 木棒做鐵鎬 iron_pickaxe。
6. 有鐵鎬才挖得到鑽石、金、紅石;鑽石在很深的地方(Y -59 附近)或洞穴裡。
要任何工具、材料或方塊都用 obtain {item}(例如 oak_planks、crafting_table、iron_pickaxe、torch、furnace):程式照上面的順序自己排好步驟(挖、合成、燒、放)、一步一步做,做完或卡住會回報原因。
吃的也用 obtain:cooked_beef / cooked_porkchop / cooked_chicken / cooked_mutton 會自己打獵再用熔爐烤,bread 會收成小麥再做,{item:"food"} 挑附近最容易弄到的;只想打獵用 hunt {entity:"cow"}。蘋果、魚、種子這類拿不到的就換別的食物。
天黑時遊戲會自己幫你躲起來(有床就睡,沒有就挖洞封頂)到天亮;死掉後會自己回去撿掉的東西。
身體有本能反應(不用下指令):掉進岩漿、快淹死、卡在方塊裡、頭上掉沙會自己逃;被怪打會反擊,血少或苦力怕靠近會逃;餓了會自己吃;卡住約 20 秒會自己掙脫;挖完會撿掉落物。反射打斷動作時會收到事件,結束後再決定下一步。
goto {block} 和 mine 只會找你親眼看得到的方塊(不會透視);附近沒有就 explore(可以給 find 要找什麼)或到地表、洞穴找。探索沒看到新東西不算進展,海上就 goto 遠一點的座標找陸地。
動作失敗時會說原因(缺什麼工具、材料、要在工作台旁…),照著補齊再做,不要重試同一個動作;同一個做法同一個原因失敗兩次會被暫停,要換做法(換一種食物、先拿缺的材料、換地方)。`;
