# 暫緩與待決定清單

統一記錄 owner 說「暫緩」「先記錄」的事、還沒做決定的問題和已知但還沒修的問題。新的暫緩項目加在這裡;詳細內容在各自的文件,這裡只放一行和連結。最後整理:2026-11-21(階段 5 的清理:修好的拿掉了,要 owner 決定的整理成「等 owner 決定」的選擇題)。

## 暫緩的功能

| 項目 | 狀態 | 詳細 |
|---|---|---|
| 第二個平台(Telegram、QQ)和直播聊天室輸入 | owner 2026-11-14:暫緩,先把 Discord 做完善 | [v5-architecture.md](v5-architecture.md) §6 |
| 生圖卡池開放([image-cards.md](image-cards.md):主題池、底片庫、覺醒、分解、SSR「和你」)和你畫我猜 | 生圖經 ComfyUI 的 API;模型等十二月的新模型再選。設計已寫完,和模型無關的部分階段 5 先做、旗標關著 | [v5-play.md](v5-play.md) §3 |
| Minecraft 幾乎不能玩(任務迴圈、技能庫、狀態快照、食物動作、生存反射) | 調查做一半暫停,原因還沒對照程式碼確認 | [minecraft-findings.md](minecraft-findings.md) |
| 自我修復、自我改進(失敗後換方法、改動要過評測才留下、在沙箱寫修正開 PR) | owner 說先不做;沙箱要先有 Docker | 本文件 §4 |
| 大家線上唱 K(她當主持人的 KTV 房) | owner 2026-11-15 提的想法,還沒決定做不做。**做到的時候先問 owner 細節,不要照下面的草稿自己做**(owner 2026-11-16);以下只是當時的初步看法。不把舊的 `karaoke` 專案(SUMI,單人桌面練歌室,Tauri)整個搬進來;要拿的是三塊:參考音符的擷取(ROSVOT,加進唱歌 worker)、瀏覽器端的即時音高和評分、歌詞和音高導引的畫面。下載、分離伴奏、歌詞對時、點歌佇列、派對遊戲的框架這邊已經有。難的是延遲:伴奏要在唱的人自己的瀏覽器播、在本機評分,別人聽到的要是混好的一軌。最早放在階段 5(玩)或階段 7(活動契約),要先有階段 6 的公開站拆分。版權要先想清楚(把伴奏和歌詞送到每個人的瀏覽器) | 這一列 |
| 直播上用魚幣付費的彈幕 | owner 2026-11-18 要做,排在卡拉 OK 之後;**已經做完上線**([v5-play.md](v5-play.md) §11.6)。他看過的其他直播互動(花魚幣指定表情或摸摸、帶你名字的螢幕特效、花魚幣投票)**現在不做**,以後要做先問 owner | 這一列 |
| 聊天事件的 CG(聊天裡偶爾出現特殊事件時給一個提示,可以花魚幣解鎖那一刻的 CG;每張獨一無二,只有買的人看得到,用 AI 生圖) | owner 2026-11-17 提的想法,以後做:生圖的模型還沒決定。做的時候先問 owner 細節(什麼算特殊事件、誰決定、價格、要不要進圖鑑)。生圖一律經 ComfyUI 的 API;內容照她的界線(擦邊可以,不描寫真正的性行為);圖只給本人看,用產物庫的私有產物。和生圖卡池是同一批前置(模型、檢查管線) | 這一列;[v5-play.md](v5-play.md) §3 |
| 服務的模型檔自動下載(`service.toml` 宣告需要哪些檔案、來源和檢查碼;`add` / `update` 補齊缺的,`doctor` 驗證) | **機制做好了(2026-11-18)**:`[[install.files]]`(來源、SHA-256、大小、授權,只從允許的主機、可續傳、先問一次)、`doctor` 驗證並記住雜湊、`doctor --print-hashes`、缺必要檔案 hostd 不啟動。**sing 的兩個分離模型已經自動下載(2026-11-18)**:MelBandRoformer.ckpt、becruily 的 .ckpt 和它的設定檔,固定 commit 和 SHA-256 對過實際檔案;becruily 的 repository 沒標授權,owner 決定自動下載。舊的手動位置 `workers/models/` 繼續有效(worker 先找新位置、退回舊位置;`update` 看到舊位置的檔案檢查碼相同就用硬連結接過來,`adopt_from`)。**還差**:turn 的 smart-turn / silero-vad 沒有 SHA-256 和固定 commit,先註解掉、照舊列成手動(turn 因此暫時不再自動下載),要在有這些檔案的電腦上 `miyoria doctor --print-hashes turn` 填進去、查 commit、取消註解;MelBandRoformer 的 `.yaml`(sha256 f63f38eb…,1721 bytes)還沒有確認過的固定來源,仍然手動(`workers/README.md` 說它是 MSST 的 `config_vocals_mel_band_roformer_kj.yaml`,要查到哪個 commit 的內容一模一樣才能填)。Seed-VC 原始碼、MediaMTX 執行檔、她的 RVC 模型和參考音維持手動 | [v5-hostd.md](v5-hostd.md) §9.1;`workers/turn/service.toml`、`workers/sing/service.toml` 的 `TODO(owner machine)` |
| 每日貼文(她做完自己想做的事之後,在 owner 指定的一個頻道貼一則,一天幾則,內容只能是真的做過的事) | owner 2026-11-16 決定先擱置,不是壞掉。程式、`[modules.mind.daily_posts]` 和 `DailyPostsKey` 都刪了;舊設定檔裡還有這一段會被忽略並在啟動時警告。它是走提案板和舊主線送出去的,兩個都在 V5 刪了,所以從第一步起就沒貼過。要重做就接到新跑者的 initiative(`packages/brain/selfhost/src/initiative.ts`),當成多一種機會:由 `LifeBook`(她做過什麼的日誌,留著)餵,設定一個專屬頻道和每日上限 | [v4-plan.md](v4-plan.md) §8.4、§16 第 8 列(舊設計) |
| 經濟系統:點歌券、她自己的錢包、她的訊息上附「餵她」按鈕 | 刻意不做 | [economy.md](economy.md) §9.1 |
| 檔案附件的後續:音檔(轉文字)、掃描或中日韓字型的 PDF(要 OCR 或帶套件的沙箱映像)、舊版 .doc/.xls/.ppt、壓縮檔、一次傳很多檔、讓她把讀過的檔案記進筆記 | 第一版只做文字/程式碼/csv/json/pdf(純文字層、簡單字型)/docx/xlsx/pptx | [file-attachments.md](file-attachments.md) §6 |
| RVC 唱歌的咬字 | 2026-11-09 測完:RVC 轉她自己的說話幾乎不掉字(7.9%,原音 5.3%),轉別人的歌聲就糊(《雪は何色》對真歌詞 45%,原唱 27%)。試過 48k 頻寬擴展、加 YingMusic 產的歌聲資料、Rigel 底模(含日文和歌聲)、檢索率 0、protect、第 1–40 epoch,都沒有明顯改善;原因是 ContentVec 聽不清日文歌聲加上她只有說話資料。目前最好的是 YingMusic → RVC 串接(38.7%)。試驗在 `data/rvc-test/`、`data/rvc-train-songs/` | [backlog 本節下方](#唱歌轉換還沒做的) |
| 用「裝技能」取代「每樣新能力都要一個套件」:技能是組合一小組通用但有圍欄的基本能力的指示,像 agent 的技能那樣。要評估的提案:在沙箱跑程式(不能連外)、只能連允許清單的 HTTP、每個技能自己的小儲存、排程、在頻道貼套版的卡片或訊息、把 HTML 樣板畫成圖;錢、即時音訊和直播、GPU 工作仍然是套件。護欄是誰可以觸發技能、技能碰得到什麼(她在 Discord 對任何人說話,所以不給通用 shell)。owner 點名的第一個用途:每天一次,她找當天最值得看的 AI 新聞,自己做成一張圖卡貼到群組;要的是排程、網路搜尋和抓網頁、她自己挑和寫、從樣板畫出來的卡片(字多,用樣板畫,不用生圖)、貼到設定好的頻道。之後也收通用的開放格式技能(一個資料夾,裡面有 `SKILL.md`:開頭的 name / description、指示,可以附腳本和參考檔),讓別的 agent 用的技能裝得進來:讀格式很簡單;能不能跑要看上面那組有圍欄的基本能力,因為這種技能預設有 shell、Python 和檔案,在這裡只能是沙箱;第三方技能是不可信的指示加不可信的程式碼,所以裝之前要審過,跑的時候沒有任何密鑰、除了允許清單之外不能連外,絕不給錢、管理(禁言等)或 admin 的工具;用到之前只載入 description。成員可以把現成的技能(一個連結,加一句為什麼想要)投到許願清單;admin 在面板逐一審(看它的 `SKILL.md`、腳本和它會碰到什麼,然後核准、附理由拒絕,或先放著),只有核准的才會裝。投稿只是連結和文字,admin 打開之前什麼都不抓、不跑;每個人有上限防洗版;結果會告訴投稿的人;其他人可以幫一個願望加票,清單就看得出大家想要什麼;核准之後裝是另一個 admin 動作 | owner 2026-11-19 提的想法,還沒決定;考慮放在之後的階段(不是階段 5),放哪個階段由 owner 決定。**動手前**先讀現有的 `skills` 和 `sandbox` 模組已經做了什麼、還缺什麼;還沒有設計,也不要先做 | 這一列 |

### 唱歌轉換還沒做的
- **主唱分離的三模型平均**(2026-11-09 決定先不做,維持 becruily 單一模型):Gabox IS(`GaboxR67/MelBandRoformers` 的 `bsroformers/bs_karaoke_gabox_IS.ckpt`,動畫歌為主)+ becruily + anvuew 三個 BS-RoFormer 平均,MVSep 主唱 SDR 10.43(becruily 單獨 10.06–10.10),切主唱時間約 3 倍。更高分的(Play da Segunda 11.08、MVSep 124 bands 10.79、tf-frazer)都沒公開。

- **分離掉字的段落改用人聲版**:主唱分離在和聲大的段落會切掉字(《雪は何色》1:10–1:30)。只在那些段落改用「沒分離和聲的人聲」當內容、音高仍讀主唱,其他段落照舊;逐段判斷可以用 ASR 比對主唱和人聲。整首都換反而變差(和聲會混進字)。
- **翻唱的混音處理鏈**:現在只調音量和響度;參考 dsh-cover-pipeline 加 EQ、壓縮、去齒音、混響、母帶限制。
- **DDSP-SVC**:截圖那套用的(DDSP + Rectified Flow + PC-NSF-HiFiGAN),可以用她的資料訓練一個來比,沒試。
- **微調 Seed-VC / YingMusic**:用她 80 分鐘說話資料微調,可能讓聲音更穩,沒試。
- **從歌詞唱(SVS)**:字從文字來會最清楚;SoulX-Singer 等開源模型不支援日文。
- **她的聲音本身被限制在 12 kHz**:TTS 輸出 24 kHz,`voices/deepseek-chan/ref.wav` 也是;換一個語音合成引擎(IndexTTS、CosyVoice 等,VoiceStudio 可以試聽)或即時做頻寬擴展,沒做。
- **面板 / 點歌時選分離器或轉換器**:現在只能用環境變數(`SING_SEPARATOR_MODEL`、轉換器設定)。
- **Applio、訓練資料佔的空間**:`workers/models/applio`(含 Rigel、48k 預訓練和各版本訓練存檔)、`data/rvc-train-songs`、`data/rvc-test`,沒用到的可以清。

### 多台電腦(角色分機)還沒做的

> 2026-11-16 補註:這一節是 hostd 之前寫的。`miyoria start`、`miyoria install`、`[machine]`、`[stack]` 和三個角色已經被 hostd、`service.toml`、`host.toml` 取代(見 [v5-hostd.md](v5-hostd.md))。
>
> 2026-11-21 清理:被 hostd 取代的項目拿掉了(對過程式:服務死了 hostd 會退避重啟,`packages/hostd/src/service.ts`;有 `down`、`restart`,`packages/cli/src/cli.ts`;worker 每條路由都驗 token,`workers/service_auth.py`;登記處收每台核准的電腦的服務,推論機不限一台,`packages/cluster/src/registry.ts`;`start`、`install` 指令和靠行程清單的 voice node 偵測都已經沒有;`miyoria add` 用 uv,`packages/cli/src/commands/services.ts`)。角色名稱和 `[stack]` 舊寫法併進下面「V5 階段 2 合併之後」的「刪除只為了搬遷留著的東西」。剩下仍成立的是下面幾項。

- **Minecraft 擴充在 Core 那台開遊戲**:擴充(`extensions/minecraft`)用 Prism Launcher 開遊戲(`extensions/minecraft/adapter/src/launcher.ts`),開的是 Core 所在的電腦,不是直播機。要改成由直播機上的節點開遊戲。(Minecraft 暫停到階段 7。)
- **`add` 不管 Docker、JDK、Minecraft mod**:Docker Desktop(檔案沙箱)要自己裝,`doctor` 只在沙箱啟用時檢查;mod jar 仍用 `miyoria update`。
- **新手要自己放 TTS 的聲音參考音**:預設角色 `deepseek-chan` 的聲音檔 `workers/voices/deepseek-chan/ref.wav`(加 `ref.txt`)不在 repo 裡,tts 沒有它就不能用;sing 的 `reference` 預設也指到這個檔。要不要附一個授權乾淨的範例聲音、或讓 `init` 問聲音名稱:見「等 owner 決定」第 28 題。
- **只在單元測試驗證過的**:
  - 跨電腦執行:目前只有朋友那台(翻唱)經控制連線的中繼真的用過(見「已知但還沒修」的長歌那一條);其他服務分到別台電腦沒有實際跑過;
  - Linux / macOS:見下面「V5 階段 2」的「Linux 只被 CI 的單元測試跑過」;
  - Core 在「沒有任何 worker」時能不能乾淨開機(純文字聊天),沒有實測(現在沒有預設的 ASR / TTS 網址,沒有 `url` 時找登記處的 `asr` / `tts`,`packages/voice/speech/src/asr.ts`)。
- **公開站的渲染方式,需要時再評估**(2026-11-17,owner 問要不要從 React + Vite 搬到 Next;同一天決定面板不拆成 `admin` / `web`):
  - 現在不搬。面板在登入後面,SPA 就夠;API 在 Core(oRPC),不會搬到 Next;連結預覽 Core 已經自己改寫 meta 和產生圖。
  - 代價是多一個 Node 伺服器(hostd 多管一個服務,和 Core 之間要處理登入和轉發),或用靜態匯出而失去大部分好處;「Core 一個程式就送出面板」也會沒了。
  - 值得再看的時機:公開站要做搜尋引擎找得到的內容頁(歌單、每個人的公開頁)。到時先比較 Vite 加預先渲染這種不用多跑伺服器的做法,再考慮 Next。管理面板不搬。
- **上網查東西的方式,找時間比較一次**(2026-11-17,owner:現在查東西要一直用付費的 API):
  - 現況:她的 `web_search` 有 Tavily 金鑰就用 Tavily(每次查詢算點數),沒有就退回 DuckDuckGo;`web_read` 讀單一網頁。
  - 要看的:DeepSeek 自己的 harness 怎麼搜、Agora(自帶金鑰的用戶端)怎麼搜,還有不用付費 API 的做法(自己架的 SearXNG、模型供應商內建的搜尋、瀏覽器式的抓取)。
  - 比的項目:每次查詢的花費、結果品質(中文和時事)、速度、被擋的機率、要不要多跑一個服務。
  - 還沒查任何資料,這一條只是記下要做。

### 卡拉 OK 等模型的(2026-11-18)

第 1 步(單人網頁唱 K)沒有下載任何新模型;下面這些要新模型才做得到,細節在 [karaoke.md](karaoke.md) 的「等模型、還沒做的」。**下載任何候選模型之前要先問 owner**(他還沒同意下載,硬碟也快滿)。

- **歌詞對整首辨識**:歌詞要先對過聽到的,現在每行 `check: "unchecked"`;要整首辨識(WhisperX、或拿主唱跑現在的 Qwen3-ASR)再逐行比對,owner 看過實測再定模型。
- **每個字的時間**:強制對齊(WhisperX 的 wav2vec2、MFA、SOFA 實測),日文漢字先轉讀音;現在 `chars: null`,不逐字上色。
- **照字切音符**:字的時間出來之後,音符才能照字切;現在只用音高切。準的音符(GAME / ROSVOT)要 owner 同意下載後在朋友那台試。
- **第二個偵測器**:瀏覽器背景的神經網路(SwiftF0 或 RMVPE 的 ONNX)接成另一個 `ScoreTrackSource`;先拿真人清唱比 McLeod 差多少,夠準就不做。

## 等 owner 決定

照編號和字母回就好,例如「1A 2B 3C」;沒回的照「建議」做之前會再問一次。每題的「建議」是我的選擇和一句理由。已經定了、不在這裡的:V5 的十一項([v5-architecture.md](v5-architecture.md) §16);階段 5 後半的一批([v5-play.md](v5-play.md) §11.1,包括交易所的開戶門檻(連結滿 7 天、羈絆到「認識」)、持有上限(可以隨羈絆或開戶時間放寬)、放空(可以做)、指數基金(先不做))。

**她說話的方式**

1. **人設要不要加一句「肚子餓時可以被零食收買」**:不情願地配合可愛的小要求;現在人設寫著「現在你是一隻貓」這類要求要吐槽回去。
   - A:加,只在餓的時候,而且要不情願。
   - B:不加,維持吐槽。
   - C:加,但只對羈絆到某一級以上的人。
   - 建議 A:餵食已經會讓 `hunger` 下降,這一句讓「餵她」在對話裡看得到,又不會變成誰都能使喚她。
2. **「新東西別說不存在」要不要寫完整版**:完整版(產品、版本、事件、日期)以前只在刪掉的 V2 規則裡,主線只放一句短的,因為那時有 4000 token 的上限;現在沒有上限了,但人設和提示詞裡都找不到這一句。
   - A:把完整版寫進主線提示詞。
   - B:只放一句短的。
   - C:不放。
   - 建議 A:當初只放短的是因為上限,這個理由已經不在了。
3. **要不要重做「有人說不要玩就替她寫規則」的保險**:2026-11-10 加的那層在階段 3 跟著舊回合刪掉了,現在只靠她自己呼叫 `directive_add`,事故評測 `mc-owner-rule-never-written` 還是已知失敗(見「已知但還沒修」)。
   - A:在新跑者上重做(回合結束前替她補寫 deny,和以前一樣只認得幾個遊戲名)。
   - B:不重做,改提示詞和評測。
   - C:等階段 7 做 Minecraft 時一起看。
   - 建議 A:主人的規則是底線,不該只靠她記得。

**權限和帳號**

4. **`deny` 規則要不要也綁住 owner 本人**:現在綁,沒有人豁免(只有「停下來」例外,`packages/brain/directive/src/service.ts`)。
   - A:維持,owner 也要先解除那條規則。
   - B:owner 豁免。
   - 建議 A:規則是她答應過的事,先解除再做,紀錄比較清楚。
5. **任何 Discord 帳號都能成為成員,要不要限制**:
   - A:不限制(現在)。
   - B:必須是她所在伺服器的成員。
   - C:伺服器成員,或拿到 owner 給的邀請。
   - 建議 B:最簡單,也擋得掉不相干的人。
6. **admin、moderator 角色缺 `admin.directive.*`、`queue.song.request|list|play`、`tools.web`、`tools.file`**(Core 啟動時有提示;有萬用權限所以實際不受影響):
   - A:補上。
   - B:不補,靠萬用權限。
   - 建議 A:啟動時不再提示,之後收窄萬用權限時也不會漏。
7. **owner 的 Discord 帳號 `owenliu` 現在是 `member`**:
   - A:升成 admin。
   - B:給 owner 角色,或列進 `[modules.commands] owners`(面板「更新別台電腦」這類 `owner.*` 的事只有這樣才能做)。
   - C:不動。
   - 建議 B:如果已經在 `owners` 名單裡,選 C 就好(我不讀線上的設定檔,看不到)。
8. **被封鎖的人「請她忘記我」時怎麼處理**:
   - A:照一般人刪,封鎖的標記留著。
   - B:不讓被封鎖的人用。
   - C:照一般人刪,連封鎖一起清掉。
   - 建議 A:隱私的要求要照辦,但「忘記我」不能變成解除封鎖的方法。

**面板、公開站和 Discord**

9. **`ambient_text` 怎麼設**:現在是 `"allowlist"`(只讀提及她、回覆她的訊息,和 `ambient_channels` 裡的頻道);`"tiers"` 是每則都給她,由 `/miyo` 的聊天等級決定插不插話(沒設的文字頻道預設 `quiet`)。
   - A:維持 `allowlist`。
   - B:改成 `tiers`。
   - 建議 B:由她自己判斷、人只設底線(聊天等級就是底線),不用再手動維護頻道清單;改之前先把不想讓她聊的頻道設成「關閉」。
10. **刪除確認按鈕的顏色**:
    - A:紅色,只有最後確認的那一顆。
    - B:和一般按鈕一樣。
    - 建議 A:會刪東西的那一下要看得出來。
11. **公開頁的背景圖(遊戲美術)要不要對外顯示**:
    - A:顯示。
    - B:不顯示,換一張授權乾淨的。
    - C:先確認授權再決定。
    - 建議 C:那是遊戲的美術,授權沒確認過;第 12 題的圖片訊息也用同一張。
12. **圖片訊息的背景**:現在沿用公開頁那一張遊戲美術(做成了設定),之後要換。
    - A:維持。
    - B:換一張專用的(要畫,或找授權乾淨的圖)。
    - 建議 B,和第 11 題一起換:同一張圖、同一個授權問題。
13. **網頁點歌預設開啟,要不要維持**:
    - A:維持開啟。
    - B:預設關閉。
    - 建議 A:維持現狀,有人濫用再關。
14. **landing 頁的細節打磨**(owner 說階段 1 做完再做;不是重新設計,動手前先列出細節給 owner 挑):
    - A:現在把整頁看一遍,列出要改的細節給你挑。
    - B:等階段 6 的公開站拆分再一起做。
    - 建議 A:只是列清單,不改東西。

**語音、唱歌和卡拉 OK**

15. **語音場次開始時要不要重設「沒人回應」的計數**:
    - A:重設。
    - B:不重設。
    - 建議 A:新的一場在場的人可能不同,上一場沒人回不該讓她這一場一開始就不敢開口。
16. **唱歌混音的預設要不要去掉和聲**(現在保留原和聲,放回伴奏;去掉的版本聽過了,沒決定):
    - A:維持保留。
    - B:去掉。
    - 建議 A:維持現狀,兩個都聽過也沒有偏好時不改。
17. **卡拉 OK 的加油要不要花魚幣、要不要和彈幕合在一起**([karaoke.md](karaoke.md) S1、S2;S3「唱的人看得到誰加油,看不到次數」照現在):
    - A:維持:免費、只有次數限制,只出現在那個人的跑道旁邊。
    - B:花魚幣(例如免費的有上限、花 1 魚幣可以多喊、或花錢的字比較大)。
    - C:和直播彈幕合在一起。
    - 建議 A:卡拉 OK 還沒對成員開放,先看大家怎麼用再定價。
18. **直播上要不要放成員的 Discord 頭像**(karaoke.md S4;現在只有名字第一個字):
    - A:維持名字第一個字。
    - B:放頭像(要先讓 Core 拿到頭像網址)。
    - 建議 A:直播是公開的,放頭像之前先讓成員知道會這樣。

**錢**

19. **預測的抽成 `prediction_rake`**:2026-11-21 上線,預設 5%:有人猜中時從獎池抽走燒掉,全部退回的不抽([v5-play.md](v5-play.md) §11.8)。
    - A:維持 5%。
    - B:10%。
    - C:不抽。
    - 建議 A:§4.2 寫的是 5% 到 10%,先用低的,看回收的量再調。
20. **貨幣系統 §9 的問題**:已先用建議值上線,隨時可改([economy.md](economy.md) §9.1)。
    - A:維持。
    - B:逐題再看一次。
    - 建議 A:沒有人反映問題。

**Core 和電腦**

21. **Core 要不要在有新 commit 時趁她閒置自己重啟,或授權我修完直接重啟**(現在每次都問):
    - A:維持每次都問。
    - B:趁她閒置自己重啟。
    - C:授權我修完直接重啟,她在唱歌或直播時不動。
    - 建議 C:比 B 保守,而且是我知道改了什麼的時候才重啟。
22. **登入時自動啟動**:`miyoria host autostart on` 要 owner 自己執行,再照 `v5-hostd.md` 的清單檢查四點(工作是用自己的帳號、沒有視窗、手動觸發能帶起服務、登出再登入後會回來);這個指令從來沒有在真的 Windows 帳號上註冊過。
    - A:現在開。
    - B:先不開,重開機後手動 `miyoria up`。
    - 建議 A:重開機後不用記得手動開。
23. **hostd 的顯卡仲裁實測**(見「V5 階段 2 合併之後」):要 owner 明確同意,在 `host.toml` 設 `[gpu] arbiter = "hostd"`、加上翻唱服務、在語音裡點一首歌。
    - A:現在測。
    - B:等之後。
    - 建議 A:唱歌 worker 自己的顯卡判斷、`SING_OFFLOAD_URLS`、`SING_YIELD_URLS` 和 `/gpu/context` 要等這個測過才能刪。
24. **用套件安裝(`npm i -g miyoria`)的人,`install.manual` 的東西放哪裡**(見「V5 階段 2」):
    - A:手動項目一律改成 `{state}` / `{models}` 開頭的路徑。
    - B:維持從目錄根算,只支援從 repository 跑。
    - 建議 A:套件安裝時目錄根是套件資料夾,東西放進去會被更新蓋掉。
25. **範例擴充的端對端測試在 CI 被跳過**(它要先 build,CI 是先測試):
    - A:CI 先 build 再跑它。
    - B:維持跳過,本機的整體檢查會跑。
    - 建議 A:CI 多幾十秒,換到每個 PR 都驗擴充的路。
26. **Docker 的 Core 預設連的 asr 埠**(`deploy/` 預設 `host.docker.internal:8001`,配 Docker 跑的 asr;hostd 跑的 asr 在 8003):
    - A:維持 8001。
    - B:改成 8003。
    - C:維持 8001,文件寫清楚 hostd 的要設 `ASR_URL`。
    - 建議 C:Docker 那條路自己是一致的,只缺一句說明。
27. **npm 發佈**(owner 2026-11-15:晚點):
    - A:現在發。
    - B:維持晚點。
    - 建議 B:voice node 還沒有編譯好的進入點(見「V5 階段 2」),發了也跑不了語音。
28. **新手的 TTS 聲音參考音**(預設角色的 `ref.wav` 不在 repo 裡):
    - A:附一個授權乾淨的範例聲音。
    - B:`init` 問聲音名稱,請他自己放。
    - C:兩個都做。
    - 建議 B:授權乾淨的聲音不好找,先讓 `init` 講清楚要放什麼。

**清檔案和設定(都在 owner 的電腦上,我不碰)**

29. **`apps/panel/.tmp-build`**(build 時的 Node 編譯快取,2026-11-21 還在)可以刪,沙箱不讓我移到資源回收筒:
    - A:你自己刪。
    - B:授權我永久刪掉(不經資源回收筒)。
    - C:留著。
    - 建議 A:只是快取,誰刪都一樣,你刪最不意外。
30. **Temp 資料夾和 uv 快取**:owner 的 Temp 有大約八個不認得的、各約 150 MB 的資料夾,清硬碟那次沒有動(2026-11-18);`uv cache clean` 沒能執行,有 `uv run` 的程序佔著快取(uv 的快取可以放心清,下次會重新下載)。
    - A:一起看那些資料夾是什麼再決定;uv 的快取等那些程序結束後清。
    - B:都留著。
    - 建議 A:先看再刪。
31. **退路的備份**:`data/backups/core-db-before-v5p3-20261117/`、`miyoria.toml.before-v5p3-20261117`;`data/backups/core.db.rebuild-dryrun-20261116` 是估花費用的複本。
    - A:刪估花費的複本,階段 3 的備份留到階段 6。
    - B:全部刪。
    - C:全部留。
    - 建議 A:估花費的複本已經沒用了,階段 3 的備份是最後一份切換前的資料。
32. **舊的 Python 環境**:`workers/.venv-asr`、`.venv-tts`、`.venv-turn` 是換成 uv 之前的,留著當退路;`data/backups/host.toml.old-venvs-20261116` 有換回去要用的那幾行。
    - A:刪掉環境,備份檔留著。
    - B:再留一陣子。
    - 建議 A:uv 的環境從 2026-11-16 跑到現在;要換回去還有備份檔裡的那幾行。
33. **線上 `miyoria.toml` 的舊鍵**:啟動時的警告列了 `llm.thinking`、`modules.agent.max_tool_steps`、`tool_timeout_ms`、`max_tool_result_chars`,`[llm.reasoning] chat_intent` 也沒有作用了;還有階段 1 留下的三處修改(剩下的設定相容層要先改它才能拿掉);舊設定檔裡有 `[llm.thinking]` 的,那些用途現在改用 `[llm.reasoning]` 或預設值(例如 `mind = true` 以前等於 `medium`,現在沒列的用途 = 不思考),要不要在 `[llm.reasoning]` 補上要看你的設定。
    - A:你照啟動的警告自己改。
    - B:授權我讀線上的設定檔,列出要改的行給你看,你同意了再改。
    - 建議 A:那份檔案有金鑰,我不讀它比較好;警告會列出每一個鍵。
34. **她的聲音少 `ref.txt`**:`workers/voices/deepseek-chan/ref.txt`(參考音實際說的內容)不在,語音合成因此用只看音色的模式載入,`doctor` 會提醒(切換前就是這樣)。
    - A:你把參考音說的話寫給我(或自己放),我放成 `ref.txt`。
    - B:維持只看音色。
    - 建議 A:有文字的模式比較穩,`doctor` 也不再提醒。

**授權**

35. **唱歌用的分離模型的授權**:MelBand karaoke 模型的原始授權沒確認;becruily BS-RoFormer karaoke 在 HF 上沒標(`becruily/bs-roformer-karaoke`),是唱歌預設的主唱模型,只在本機跑、沒散布;becruily 的自動下載是 owner 決定的。
    - A:去問作者或查清楚。
    - B:維持只在本機用、不散布。
    - 建議 B:只在本機跑、不散布,碰不到散布的條款;要散布(例如附在安裝裡給別人)之前再選 A。
36. **她的 Live2D 能不能放上網頁**(網頁現場的角色現在是另外畫的,不是她的樣子):
    - A:問清楚授權再放。
    - B:維持另外畫的。
    - 建議 A:公開站上是她的樣子比較對,但要先確認。

**V5 之後的**

37. **生圖**:十二月的生圖模型、ComfyUI 跑在哪一台、她的 LoRA 的授權。
    - A:等十二月的模型出來時一起定。
    - B:現在先定 ComfyUI 跑在這台。
    - 建議 A:三件事互相綁著,模型沒定前定了也可能要改。
38. **水族箱**([v5-play.md](v5-play.md) §4.6;示意圖在 `docs/design/mock/aquarium.html`):
    - A:看過可以,照示意圖做。
    - B:要改(告訴我哪裡)。
    - C:不做。
    - 建議 A:設計照 §4.6 寫的,示意圖是照它畫的;看了有不對的再選 B。
39. **Minecraft 的志向清單、誰算主人、AltoClef**(Minecraft 暫停到階段 7):
    - A:階段 7 再定。
    - B:現在定。
    - 建議 A:暫停中,定了也用不到。
40. **kcy3f0 的三個 Minecraft PR(#44、#45、#46)和草稿 PR #30(自主遊玩的 P0、P1)**:`v5` 合進 `main` 後會因為資料夾搬動衝突,要請對方 rebase;#30 動的是同一塊,到時先讀完再決定順序。
    - A:現在請對方照新的結構 rebase。
    - B:維持等到階段 7(全部做完之後再看)。
    - 建議 B:owner 原本就說全部做完之後再看,Minecraft 也暫停到階段 7。
41. **沒人發的 `agent.initiative` 事件**(agent 和 facts 還訂閱它,schema 在 SDK 和面板的型別裡,SDK 的相容性測試也列著它):
    - A:從公開的事件合約拿掉,SDK 先標成過時。
    - B:留著。
    - 建議 A:沒有人發,留著只會讓擴充作者以為等得到它。
42. **`PlaceAccessKey`**(「別的地方」「剛才」問它哪些地方她看得到,沒有人提供時每個地方都算看得到):
    - A:維持都看得到。
    - B:做真正的存取規則,和階段 6 的 Space / Room 一起。
    - 建議 B:誰在哪裡看得到什麼本來就是階段 6 的事;在那之前不刪它,讀它的地方是對的。
43. **舊的 `KnowledgeStore`**(`learning` 模組沒有資料庫時它是整個知識庫,有資料庫時只有匯入工具會讀):
    - A:不再支援沒有資料庫,測試改用記憶體的 SQLite,拿掉它。
    - B:留著。
    - 建議 A:正式跑一定有資料庫,只為測試留一套舊的儲存不划算。
44. **self 裡「暗戀」的名字**(`crushPerson`、`crush_spoke`、`crush_message_longing` 等,讀的已經是 heart 算的「最在意的人」):
    - A:改名,設定鍵一起改(舊鍵進 `removed-config.ts`、範例檔照改)。
    - B:維持舊名。
    - 建議 A:名字和意思對不上,之後讀程式的人會誤會;要先問,是因為設定鍵改名你的設定檔也要跟著改。
45. **閃卡的彩虹遮罩**(現場算的圖不透明,遮罩變成整塊立繪、彩虹只剩立繪以外;[cards.md](cards.md) §6.2):
    - A:我做一張重做遮罩的樣稿給你看。
    - B:維持現在的樣子。
    - 建議 A:要不要重做本來就說要先看樣稿。

## 已知但還沒修

- **「修進度條」已修(2026-11-18,分支 `v5fix-bar`,PR #76 已合併)**:主線是她現在在做的事(說話、思考、唱歌、用工具、玩遊戲),準備歌曲變成旁邊一個小的第二行(歌名 + 一條整體進度),只有她閒著時才佔主線;每個 worker 階段都有白話標籤(`SONG_PREPARE_STAGES` 加 `STAGE_LABELS` 加 worker 的來源掃描測試,三邊對不上會失敗);進度在 worker 和發布端都只進不退,影片階段有自己的份量;排隊 / 等待是不確定的微光;換歌立刻重來;顯示的歌固定一首(只有還在排隊的會讓給 worker 已經在跑的);沒標題時顯示「某某 點的歌」或「連結」;工具和遊戲有自己的活動(新事件 `agent.tool.running`,只帶工具名);過期狀態都處理了(Core 掉線連 notice 一起清、送失敗會重送、正在唱依歌長逾時、worker 連不上 20 秒後顯示「連不上」、再 60 秒收起)。還沒做:實況上看過一輪;`party_*` 遊戲(派對)沒有自己的活動,只有 `game.director.session` 的遊戲(派對的工具只顯示「操作遊戲中」,`packages/stage/src/link/activity.ts`);面板「直播頁」的 `LiveActivityKind` 已經認得 `tool`、`game`、`song_prepare`(`apps/panel/src/pages/public/live/feed.ts`),但第二行(準備中的歌)還沒接:面板的 `LiveActivity` 沒有 `secondary`;點歌以外的背景工作(畫圖等)還沒有第二行。
- **點歌從 2026-11-17 晚上壞到 2026-11-18 早上**:拿掉固定網址之後,點歌模組看不到叢集裡的 worker(修在 PR 69)。**還沒有人確認過一首真的歌經過朋友那台**:這要有人實際點一首、等到播出來。
- **朋友那台做的長歌唱不出來(2026-11-19 改)**:開唱時才把整首的原始 PCM(混音加嘴型用的人聲,4 分鐘的歌約 50 MB)經控制連線從朋友家的上傳拿過來,總時限 200 秒,長歌都拿不完,她卻一直顯示「正在唱」。中繼本身量過不是瓶頸(模擬 4 Mbit/s、來回 200 ms 的上傳,2 × 40 MB 用 160 秒,達鏈路的 99.8%;2 Mbit/s 加 1 MB 數據機緩衝也是 99.8%,`packages/cluster/test/relay-uplink.test.ts`,`RELAY_BENCH=1`)。現在:worker 做好後先把音檔傳到 Core(`[modules.sing] audio_dir`,階段 `fetch`「拿歌中」),傳完才算準備好,唱的時候從 Core 讀;拿檔案只看進度(`fetch_stall_secs` 秒沒有任何位元組才放棄),斷掉的從 `.part` 續傳;每次傳完記大小、秒數和速率(`song worker file fetched`),卡住記警告(`a song worker file stopped arriving`)。**還沒做**:在真的連線上看那兩行記錄的速率(記錄裡 45 秒完全沒收到東西而斷線、`host.info` 30 秒逾時,比幾 Mbit/s 慢很多或整條卡住,要看記錄才知道是哪個);控制訊息排在幾 MB 的資料後面(hostd 的 socket 最多排 1 MiB,慢的上傳要好幾秒),要讓 hostd 優先送文字框或降低高水位,這要朋友那台更新(**2026-11-19 做了**:高水位降到 128 KiB、等 socket 改成寫出去就叫醒;在本機模擬 0.64 Mbit/s 上傳、同時傳兩個檔,`host.info` 從 21–25 秒降到約 9 秒,剩下的是核心的送出緩衝和網路上的排隊,程式管不到;Core 會把長度不對的內容當失敗,hostd 會把服務中途斷掉的回應 abort 並記警告,另外記每個 1 MB 以上回應的大小、秒數和 MB/s,`fetch` 只說 `terminated` 的原因也會一起記);**還不知道**:為什麼經中繼只有約 0.6 Mbit/s,本機的真實元件(Core、`CoreLink`、uvicorn 的 `FileResponse`)在迴路上有 70–80 MB/s,量不出慢;朋友那台為什麼在結尾斷(本機以每秒一塊的速度讀 161 秒也收齊),要等朋友更新 hostd 後看新的記錄(`a relayed response broke` 的 `err`);傳壓縮過的音檔(worker 要能做 AAC/Opus、Core 解碼)和邊傳邊唱都沒做。
- **她讀不到連結裡的圖,也不能真的瀏覽網頁**(2026-11-17):現況和可以做的三件事在 [v5-play.md](v5-play.md) §10.3。
- **主人規則沒寫進去**:2026-11-10 加過保險:回合裡有人明說「不要玩 <她有的遊戲>」而她這回合沒自己呼叫 `directive_add` 時,回合結束前用說這句話的人的身分替她寫一條 deny(`packages/brain/agent/src/prohibition.ts`、`turn.ts` 的 `keepRules`;規則服務照樣判斷這個人能不能立規則;「先 / 今天」是 6 小時;只認得 Minecraft、osu 和幾個別名)。**2026-11-21 查:這層保險已經不在了**,跟著舊的回合在階段 3 一起刪掉(commit `17f5c02e`;現在寫規則只靠她自己的 `directive_add`,`packages/brain/directive/src/tools.ts`)。面板評測頁還留著它的標籤 `prohibition_written`(`apps/panel/src/pages/eval/Participation.tsx`,舊紀錄讀得出來)。事故評測 `mc-owner-rule-never-written` 仍是已知失敗;要不要在新跑者上重做這層保險,沒有決定。要決定的見「等 owner 決定」第 3 題。
- **她把自己的盤算講出來**(2026-11-10 先用規則擋):送出前把「第三人稱講對方 + 對自己下指令」的那一行拿掉(`packages/brain/agent/src/leak.ts` 的 `isSelfTalk`,只拿掉那行、其他照送,有「你」的不算)。還沒做事故評測題、也還沒看真實頻率;規則抓不到的說法要再補。
- **抓被回覆的訊息為什麼會失敗**:2026-11-08 14:19、14:22 兩次回覆都沒帶到被回覆的那句。已改成先用 Discord 隨回覆送來的引用內容、抓到再換成完整的,失敗會記 `could not fetch reply parents` 警告;原本為什麼抓不到(逾時、權限或 Discord 錯誤)還沒查,重啟後看警告。
  - 2026-11-10:找到一個會讓它抓不到的情況並修掉:被回覆的是她自己的卡片(斜線指令的回覆、收據,Components V2、`content` 是空的)時,以前算「沒內容」直接丟掉;現在讀卡片上的文字(`componentsText`),指令回覆也算可以回覆的訊息。抓取失敗改記 warning(`cannot fetch the replied-to message`,帶頻道和錯誤),拿到但沒內容記 info 和訊息類型。14:19 那兩次是不是這個原因還沒對照。
  - 2026-11-11 再查程式:引用內容先從 gateway 快取拿、沒有就 `fetchReference`,兩邊都失敗時才會沒有被回覆的那句;最可能是那個頻道沒給 bot「讀取訊息歷史」(Read Message History,`docs/OPERATIONS.md` 的邀請權限有列),快取裡沒有的舊訊息就抓不到。重啟後看 `cannot fetch the replied-to message` 警告裡的錯誤:`Missing Access` / `Missing Permissions` 就是權限。
  - 同一天修掉相關的看圖問題:14:22 她把對方之前貼的截圖當成答案,原因是同一個人 2 分鐘內的圖會一起給她看,而每張圖都只標「某某傳的圖片」。現在每張圖標明是這則訊息附的、被回覆的那則裡的、還是幾秒前另外傳的(不是這則訊息附的);回覆別人的訊息時不再帶同一個人更早的圖(`packages/brain/agent/src/vision.ts`)。
- **主線提示詞的「新東西別說不存在」**:以前只有一句短的,因為主線固定提示詞貼著 4000 token 的上限(`prompt-budget` 測試),完整版(產品、版本、事件、日期)只在 V2 規則裡。2026-11-21 查:上限和那個測試都沒了(現在沒有提示詞的 token 上限),V2 規則也刪了;在 `profiles/` 和 `packages/brain` 裡找不到這一句(找「不存在」沒有結果)。要不要把完整版寫回去是人設的文字,見「等 owner 決定」第 2 題。
- 語音視窗跑到 92.5 秒,超過 90 秒的上限。2026-11-11 查過:程式裡找不到叫「語音視窗」、上限 90 秒的東西(`speech_hold_max_ms` 是 90 秒,但每 250 ms 檢查一次,不會超過 2.5 秒),這一行也沒附記錄;下次看到時記下是哪一行記錄。
- 網頁的直播卡「OBS 推流」只控制 OBS。
- Discord 指令拿不到互動 ID,錢包操作防不了網路重送造成的重複扣款(面板有防)。2026-11-21 查:還是這樣,錢包指令每次用新的亂數鍵(`packages/economy/src/commands.ts`、`commands-v2.ts` 的 `discord:${newId()}`),`InvocationData` 沒有互動 ID(`packages/commands/src/spec.ts`)。
- 事故評測還有 9 題標成已知失敗,修好、重新錄製後才會翻成通過:`pnpm eval`(2026-11-21 數過還是 9 題:`mc-owner-rule-never-written`、`mc-said-back-to-minecraft-no-action`、`repeat-death-quips`、`self-talk-death-spiral-26`、`self-talk-screen-switch-22`、`stage-stream-failure-unseen`、`tool-text-never-called-natively`、`tool-text-sing-request-headless-close`、`tool-text-sing-request-malformed-tag`)。
- **經濟 §13 還沒驗證的**(2026-11-08):
  - 指定立繪和重抽在 V5 拿掉了(`card_pose`、`card_reroll` 在 `packages/core/src/removed-config.ts`),`/me card` 現在是再發一張(可加 `foil`)、圖鑑、機率、保底、願望單(`packages/commands/src/keepsakes.ts`);籤詩是 `/me checkin fortune:true`。
  - 面板新區塊(閃卡、籤詩、懸賞、轉帳、排行榜;目標已經拿掉)只跑了測試,還沒在瀏覽器裡實際看過;overlay 留言卡看過了。
- **檔案附件沒在真的 Docker 跑過**:這台的 Docker 沒開,所以她現在會婉拒所有非圖片檔(zip 本來就不支援);容器裡的寫入權限、刪檔、`python:3.12-slim` 的實際行為沒驗證。
- **好感等級的「相處方式」還沒看過她實際寫什麼**:要等她下一次反省。面板的人物卡從 2026-11-12 起顯示等級(Lv.)和相處方式(寫的等級和現在不同時註明「Lv.N 時寫的」),可以在那裡看。
- **歌詞:QQ 音樂沒接、簡繁 / 羅馬拼音只靠 LLM**:現在的來源是 lrclib 和網易雲(非官方介面,可能被擋或改版);沒做 QQ 音樂(要簽章)、也沒本地的簡繁轉換(OpenCC)和日文假名 / 羅馬拼音互轉,這些只靠 LLM 給的別名。LLM 不認得的歌(同人曲、很冷門的原創)還是找不到。
- **歌詞整段偏移**(2026-11-10 處理):同步歌詞拿去跟主唱 / 人聲軌比對「什麼時候在唱」和「每句什麼時候開始」,整段差超過 0.5 秒且明顯比不移好時整段移過去(±45 秒內,`workers/sing/lyrics_align.py`,meta 的 `lyrics.offset_s`)。只在合成的測試音訊驗證過,還沒拿真的歌試;每句各自不準(不是整段偏)的情況不處理。
- **歌詞 ASR 抽查的門檻只用兩首實測**:正確歌詞 1.00、別首歌 0.28,門檻 0.35 / 0.6 是照這個抓的;日文漢字和 ASR 輸出的寫法不同時可能誤拒,等累積更多歌再調。
- **MelBand karaoke 模型的原始授權**沒確認。要決定的見「等 owner 決定」第 35 題。
- **becruily BS-RoFormer karaoke 的授權**:HF 上沒標(`becruily/bs-roformer-karaoke`);現在是唱歌預設的主唱模型,只在本機跑、沒散布。要決定的見「等 owner 決定」第 35 題。
- **「伴唱也轉」(`backing=convert`)**沒實測:伴唱常是好幾個聲音疊在一起,RVC 的 RMVPE 只抓一條音高,可能轉得很怪。
- **推理外洩的源頭沒查實**:2026-11-09 15:29 她在一回合(`reasoning` off、4.9 秒、23 則)把整段思考當回覆一行一行發出去。DB 的訊息和 `turn_outcomes` 看得出推理在 content 裡(provider 已把 `reasoning_content` 分開,不是它併進來的),但 LLM 呼叫的原始回應只存在 Core 記憶體,查不到;最可能是 opencode 上的 `deepseek-v4.1-flash` 收了 `thinking: disabled` 卻仍把思考寫在 content。已加的是送出前的防線(`packages/brain/agent/src/leak.ts`)和提示詞一行;要根治得在 Core 重啟後的面板呼叫檢視器看原始回應,再決定是換模型、改 `thinking_off`,還是讓 `chat_text` 開 `low`。防線擋不住不含「情緒標記 / 回覆要短 / 可以說:」這類字眼的純驗算自言自語(要兩行以上才算外洩)。
- **連結預覽的圖沒用 Geist 字型**:resvg 吃不了 woff2,預覽圖和羈絆環用專案帶的 Noto Sans TC(`packages/card-face/fonts`,2026-11-17 起不再用系統字型),拉丁字和面板上的卡(Geist)略有差;要一致得把 Geist 的 ttf 放進 repo(owner 2026-11-17 同意字型檔進 git,[v5-play.md](v5-play.md) §11.1;還沒放,repo 裡只有面板用的 woff2 套件)。另外 Discord 對同一個圖片網址的快取時間沒實測:網址帶 `?v=` 版本,卡變了網址就變,但已經貼出去的舊訊息可能還是舊圖。
- **卡的現場立繪還沒進產物庫**(2026-11-17):會員頁、卡片頁、`/me card` 和連結預覽現在拿的是同一張現場算的圖(2026-11-17 做了,`/api/public/card-art/<編號>.png`)。圖還沒進產物庫(`cards_card.artifact_id` 空著;快取在 `data/cards/portraits`,依規格雜湊;2026-11-21 查:快取已經有容量上限,滿了刪最久沒用的,`[modules.cards] portrait_cache_max_mb` 預設 2048,`packages/play/cards/src/portrait-cache.ts`)。「別台電腦替 Core 算卡圖」也還沒有:`renderer` 能力現在只有 Stage 在用,`cards` 沒有接(`CardStore.setArtifact` 只有測試呼叫)。閃卡的彩虹遮罩原本用固定立繪的透明背景,現場算的圖不透明,遮罩變成整塊立繪、彩虹只剩立繪以外;要不要重做遮罩等 owner 看過實頁的樣稿。見 [cards.md](cards.md) §6.2。要決定的見「等 owner 決定」第 45 題。
- **Core 從 `/` 起的非公開頁(`/me`、管理頁)只有靜態標題**,沒有各自的預覽;要的話在 `meta.ts` 的 `pageMeta` 加。

### V4 實作(分支 `v4-int`)留下的

整份見 [v4-plan.md](v4-plan.md) §14 最後。沒上線、沒驗證的事在那裡;這裡只列已知沒做完或有洞的:

- **「不要記住這個」擋不乾淨**:訊息紀錄的編號不是平台的訊息編號,只能靠內容雜湊比對;之後有人引用那則訊息回覆,引用的文字還是會進來。(筆記的部分 2026-11-21 修了:筆記的每條證據記著訊息編號(`notes_evidence.message_id`),記憶模組收到 `agent.message.excluded` 時用 `NotesStore.redactEvidence` 拿掉那則的引用,只靠它的行變成過時、沒有字;沒有證據可對的舊行還是篩不掉。)
- **推理外洩的根因沒找到**:外洩的文字是模型直接寫在回覆欄位裡的。剩三種可能,現有紀錄分不出來;下次發生時該查什麼寫在 [v4-patches.md](v4-patches.md) §5。 2026-11-14 補:在現在的端點上,關掉思考的五個請求都乾淨(沒有推理欄位、推理 token 是 0),所以「該關的時候其實還開著」這個可能性變小;沒有重現外洩。
- **事後修正還在**:18 處只收窄 2 處,4 處有開關。等上線後面板上的觸發次數接近零再關。
- **本機向量檢索**:記憶紀錄和筆記本(每一行,2026-11-16,見 [v5-brain.md](v5-brain.md)「筆記的 embedding」)都接上了,背景補向量也做了;程式預設關,開的步驟在範例設定檔的「長期記憶」那段。線上 2026-11-17 起開著、跑 Harrier(見下面「V5 階段 3 合併之後」);門檻還沒用真實對話調過(見「embedding 上線後要調的」)。
- **Minecraft**:打獵要動物剛好在準星上,Java 模組的 `nearby_entities` 要加座標才能直接瞄準(模組沒改);導演在工作車道上的行為沒進過遊戲。
- **沙箱網路白名單**:代理和設定做了,沒在真的 Docker 上跑過(`MIYORIA_LIVE_WORKSPACE_TESTS=1`)。
- **面板的活動表是 API 裡的一份複本**(有測試防它走樣),`packages/heart/mind` 還沒有可讀的服務。
- **網頁現場的角色是另外畫的**,不是她的樣子;她的 Live2D 能不能放上網頁要先確認授權。要決定的見「等 owner 決定」第 36 題。

### V5 階段 1 做的過程中留下的(2026-11-15)

**等階段 1 做完再做(owner 決定)**

- **landing 頁的細節打磨**,不是重新設計:owner 覺得現在的樣子不錯,但有些地方的細節可以更好。動手前先把整頁看過一遍,列出要改的細節給 owner 挑。要決定的見「等 owner 決定」第 14 題。
- **kcy3f0 的三個 Minecraft PR(#44、#45、#46)**:全部做完之後再看怎麼處理。`v5` 合進 `main` 之後它們會因為資料夾搬動而衝突,要請對方 rebase。草稿 PR #30(自主遊玩的 P0、P1)到階段 7 重新套到新的結構上再接著做;它和那三個 PR 動的是同一塊,到時候先讀完再決定順序。要決定的見「等 owner 決定」第 40 題。

**上線前要做的**(階段 1 在 2026-11-15 合併並上線了;下面三項沒有紀錄顯示逐項做過)

- voice link 改成契約之後沒有對真的 Discord 逐項測過:進出語音頻道、對話、打斷、唱歌(嘴型)、Go Live、重啟 Core。
- Python worker 的請求模型改成由契約產生之後,沒有逐項跑過真的 worker:各 worker 啟動、唱一首歌、一次 offload 和 reload(這台的 asr、tts、turn 從階段 2 起由 hostd 跑著)。
- 拿線上資料庫的複本演練匯入(`miyoria db doctor`、`db import-links --dry-run`),確認人數和帳號數:線上已經切到新的資料庫,有沒有先演練沒有紀錄。

**小的、還沒做**

- 產物庫對外的檔案網域和分享連結 2026-11-22 做了(v5-architecture §11.3),等 owner 在 Cloudflare 加主機名、設 `[modules.api.files] origin` 才會發連結。還沒做的:圖片送出前的 NSFW 分類(還沒有分類器);產物頁的「檢舉」;每個 Space 的容量額度(現在只有每人每天的連結數);別台電腦做的產物經 hostd 拉進產物庫;S3 相容的儲存。每天的清理已經排程了(`packages/memory/facts/src/module.ts` 的 `ArtifactSweepSchedule`)。
- 管理 token 的失敗限制是記憶體裡的小限制器(`packages/api/src/admin-limit.ts`);設計寫的 `rate-limiter-flexible` 要能跑 `pnpm install` 時再決定要不要換。
- 「忘了我」不會去改 LLM 呼叫的 JSONL 檔(那些檔 14 天後過期)。
- 她在一個還沒有人說過話的私訊裡的第一句話,存的時候沒有場所(`packages/store/src/events/log.ts` 的註解寫著)。
- lyrics 服務和 turn worker 的錯誤回應是 FastAPI 預設的格式,和其他 worker 不一樣(測試裡標成已知)。
- `@miyoria/contracts` 依賴 `@orpc/contract`,所以裝 SDK 的擴充作者也會裝到它;之後可以把路由那一部分拆出去或改成 peer 相依。
- 路由搬到 oRPC 之後幾個使用者碰不到的差別:同一個查詢參數重複出現會回 400(以前取最後一個);幾個 `limit` 格式錯誤的訊息文字不同(狀態碼一樣)。
- `miyoria config set` 現在要載入所有模組的設定 schema,打包後的 CLI 量起來約 1.7 到 2.0 秒(`--version` 約 0.9 秒),比改之前多了大約 0.7 秒。要更快的話,可以在打包時先把整份 schema 算好。
- 線上 `miyoria.toml` 的三處修改還沒做(剩下的設定相容層要先改它才能拿掉);`/api/facts/context` 和 `/api/facts/retryable` 擁有者確認沒人在用,兩條路由已經刪掉。

- **第 14 步留下的**(2026-11-16):舊的 store 介面大多還在(呼叫的地方多,跟著各套件重寫再換);五個已經沒人呼叫的方法還掛在介面上(`MessageLog.purge`、`IdentityStore.setPersonName`、`DecisionLog.appendOutcome`、`MemberCardStore.countSince`、`SettingsStore.deletePrefix`;2026-11-21 查過:正式程式沒有人呼叫,只有 store 自己的測試和其他套件測試裡的替身。要拿掉得一起改 memory、learning、facts、selfhost、api、voice 的測試替身,這次沒有動);人物卡不再於啟動時替羈絆超過 25 的人種依附(原本是 V4 搬移程式順便做的),階段 4 決定依附從哪來。詳見 [v5-data.md](v5-data.md)。
- **embedding 上線後要調的**:相似度門檻(`min_vector`,現在 0.5)、分數門檻、向量的權重,都是用 200 筆人造資料調的;沒答案的問題仍有五到七成會帶進記憶。有了真實對話後重測,資料和腳本在 `research_notes/v5/embedding-trial/`。筆記本的行用同一組門檻和權重,沒有另外調過;`--memory-target notes` 可以拿同一組題目量筆記。語音回合等查詢向量的 150 ms(`notes_vector_voice_wait_ms`)是估的:背景補向量和查詢共用同一個 worker,一批 8 行還沒算完時查詢會排在後面,實際會不會常常等不到要上線後看 log。
- **段落整理上線後留下的**(2026-11-16,見 [v5-brain.md](v5-brain.md)「段落整理上線」):
  - 切換要 `miyoria memory rebuild --apply` 整個跑完一次;新裝的機器沒有舊記憶也一樣要跑一次(沒有事件時很快、不花錢),不然一直停在舊的整理。
  - 追問的關閉、去重和她的承諾已經接回段落整理(見 v5-brain.md「段落整理上線」)。還沒做的:承諾的期限超過一天時,Core 重啟後讀不回來(`CommitmentBook` 只從 log 重建最近 24 小時);沒說期限的承諾從段落整理記下時算 120 秒(段落結束至少 5 分鐘後),所以通常一記下就快過期;過期 30 分鐘還沒做的記成沒做到,不等下一段整理;她說了不做的承諾不會被關掉,只等過期。這些都沒有接真的模型跑過。
  - 她自己的經歷、決定(舊的 `self_note`)不再從對話寫;只經情節進每晚反思,由反思改寫她自己的文件。私訊的情節不進每晚反思(`curatable`,和以前私訊的 `self_note` 一樣)。
  - 舊的 prompt contributor `memory`(`MemoryContributor`,第 6 區之前的寫法)還是只讀 `memory_records`;新的跑者讀的是 `MemoryRetrievalKey`,不經過它。
  - 段落整理沒有自己的花費上限:用 `[modules.memory] purpose`(預設 `summarizer`)經 router,算在 router 的每日預算裡;用了多少只在 log 和 `LiveSegments.stats`,沒有進面板。
  - 一段落後太久(壓縮後的行在 `sweep` 前,預設 30 天)沒整理到,就整理不到了。
  - 評測(`--memory-target notes`)每題都搜所有文件,沒有照 `recall` 先找在場的人和這個地方;題組的記憶也不是段落整理寫的。
  - 精準度的三個數字(`[modules.memory.notes_recall]`)是預設值,沒有用真實的題組調過。
  - 切換後讀哪些舊紀錄是看紀錄 id(ULID)裡的時間和 rebuild 開始的時間;rebuild 要在寫那些紀錄的機器上跑,兩台時鐘差很多會讀錯。
- **範例擴充的端對端測試在 CI 被跳過**:它要先 build 才會跑,CI 是先測試;本機的整體檢查會跑。要不要讓 CI 也跑,等決定。要決定的見「等 owner 決定」第 25 題。

### V5 階段 2(hostd)做的過程中留下的(2026-11-16)

- **voice node 還沒有跟著套件發行**:`miyoria add voice-node` 只能在有 repository 的資料夾裡做。`apps/voice-node/service.toml` 用 `pnpm start`(tsx 從原始碼跑),沒有 repository 的安裝(`npm i -g miyoria`)沒有東西可跑。要先有一個編譯好的進入點,再換掉描述檔的 `command`。
- **`install.manual` 的路徑在套件安裝時會落在套件資料夾裡**:路徑(`workers/models/applio`、`workers/voices/<聲音>/ref.wav` 等)是從目錄根(repository 的根)算起。從 repository 跑時那就是使用者放東西的地方;套件安裝時目錄根是套件資料夾,不是使用者的資料夾。用套件安裝的人要把這些東西放在哪裡,還沒定。(2026-11-18:改成自動下載的 `[[install.files]]` 不受影響,一律放在 `host.toml` 的狀態資料夾 `<state>/models`;手動項目也可以用 `{models}` / `{state}` 開頭的路徑,turn 的兩個已經這樣寫。私人的 `workers/models/applio`、`workers/voices/...` 等還是從目錄根算。)要決定的見「等 owner 決定」第 24 題。
- **Docker 的檔案還是舊的,也沒有跑過**:`workers/docker-compose.yml`、`workers/asr/Dockerfile`、`workers/tts/Dockerfile` 和 `deploy/` 仍用 `requirements*.txt` 和 pip(不是 uv 專案),`deploy/docker-compose.yml` 只發佈 7878、7879、7882,沒有發佈 `7880`(控制連線),所以 Docker 的 Core 收不到別台電腦的連線;Docker 的 worker 沒有設 `MIYORIA_SERVICE_TOKEN`,不驗 token。埠(2026-11-21 對過):Docker 這兩條路自己是一致的,asr 都在 8001(`workers/asr/Dockerfile` 的 `PORT=8001`、兩份 compose、`deploy/speech/README.md`);hostd 跑的 asr 在 8003(`workers/asr/service.toml`)。所以 `deploy/` 的 Core 容器預設連 `host.docker.internal:8001`(`deploy/miyoria.docker.toml`、`deploy/README.md`)只接得到 Docker 或手動跑的 asr,接 hostd 跑的要設 `ASR_URL`;文件沒有改,要不要改預設見「等 owner 決定」第 26 題。2026-11-21 修了 `workers/asr/Dockerfile` 一行多出來的 `\n`(會多建一個叫 `n` 的資料夾);還是沒有 build 過。
- **Linux 只被 CI 的單元測試跑過**:hostd、安裝和更新在 Linux 上只被 CI 的單元測試跑過,沒有在 Linux 上用真的 worker 跑過;macOS 的登入時自動啟動(`host autostart`)還不支援。
- **voice link 和 stage link 的用戶端沒有改用共用的重連工具**:`packages/hostd/src/link/reconnect.ts` 有退避、看門狗和「哪些關閉碼不該再撥」的規則,註解寫明 voice node 和 Stage 之後可以搬過去(列在 H12)。目前 `apps/voice-node/src/link.ts` 和 Stage 的連線(`packages/stage/src/link/`)還是各寫各的重連。
- **生圖的顯卡讓出還在 Core 裡**:`ImageGenService` 在唱歌事件時自己暫停批次、請 ComfyUI 釋放(`pause_while_singing`、`free_on_sing`),沒有走 hostd 的顯卡仲裁。等生圖模組開放、hostd 的仲裁(`v5-gpu.md`)上線後再搬。
- **有一個中繼測試只在機器很忙時失敗過一次**:`packages/cluster/test/relay.test.ts` 的 `aborts mid-body`(中途中斷時讀的一方失敗、服務看到關閉)在負載高時失敗過一次,之後每次重跑都過。再出現就改成等條件成立,不要加長逾時。
- **MediaMTX 有三個埠,不進登記處**:API(9997)、RTMP(1935)、LL-HLS(8888),voice node 的編碼器用其中一個,所以 `[modules.live.video]` 仍然自己寫位址。hostd 只啟動它和探測行程。`workers/mediamtx/start.ps1` 和 `workers/mediamtx/README.md` 裡講它的部分還沒刪(`v5-hostd.md` §12)。
- **`check_imports` 每個服務只有一份清單**:`doctor --deep` 用服務自己環境的 Python 去 import `service.toml` 的 `check_imports`,那份清單是預設後端的。換了後端(ASR 的 `sensevoice`、TTS 的 `qwen-tts`)後,清單裡的套件(`torch`、`qwen_asr`、`faster_qwen3_tts`)可能不在環境裡,會誤報失敗。要讓清單跟著 extras 走,還沒做。

### V5 階段 2 合併之後還沒做的收尾(2026-11-16)

階段 2 在 2026-11-16 合併(PR #55)。下面是 `v5-hostd.md` 切換清單第三段還沒做的,照建議的順序:

- **登入時自動啟動還沒開**:`miyoria host autostart on` 要 owner 自己執行,再照清單檢查四點(工作是用自己的帳號、沒有視窗、手動觸發能帶起服務、登出再登入後會回來)。這個指令從來沒有在真的 Windows 帳號上註冊過。在那之前,重開機後要手動 `miyoria up`。要決定的見「等 owner 決定」第 22 題。
- **朋友那台(翻唱)升級**:照 `docs/sing-remote-host.md`。2026-11-16 時它是設定檔裡的靜態登記(`[modules.sing] url`),沒有 token,他那台的歌詞語音辨識抽查會被這台擋下。之後(2026-11-19 之前)他那台已經經控制連線的中繼接上來,翻唱和卡拉 OK 的檔案都經中繼傳(見「已知但還沒修」的長歌那一條和「卡拉 OK 第二次實測留下的」);他那台的 hostd 要更新到 2026-11-19 的高水位修正才看得到新的記錄。`[modules.sing] url` 這個靜態登記 Core 還接受(`packages/sing/src/config.ts`、`packages/core/src/endpoints.ts`),等確認沒人用再刪(見下面「刪除只為了搬遷留著的東西」)。
- **hostd 的顯卡仲裁沒有在真的顯卡上跑過**:這台是 `[gpu] arbiter = "worker"`,而且沒有跑翻唱。2026-11-16 修的兩件事(伴唱也轉換時和重新載入的語音搶顯卡、預設策略下無限等)只通過對照表和模擬情境。要測得在這台唱一次歌:owner 明確同意、`host.toml` 設 `[gpu] arbiter = "hostd"`、加上翻唱服務、在語音裡點一首歌。要決定的見「等 owner 決定」第 23 題。
- **刪除只為了搬遷留著的東西**(另開一個 PR,`v5-hostd.md` §12):`[stack]` 和 `[machine]`(CLI 的檢查還認得,`packages/cli/src/validate.ts`;設了 `[machine]` 後 `[stack]` 的 `core` / `voice_node` / `stage` 本來就沒作用)、`host migrate`、`stack/roles.ts`(三個角色的名稱,只剩搬遷在用)、`stack/config.ts`、`workers/mediamtx/start.ps1`(`workers/mediamtx/README.md` 還叫人執行它)。2026-11-21 查過都還在。下面兩項要等前面的事:設定裡的位址鍵和它們的靜態登記(等朋友那台升級);唱歌 worker 自己的顯卡判斷、`SING_OFFLOAD_URLS`、`SING_YIELD_URLS`、Core 對 worker 的 `/gpu/context` 推送(等顯卡仲裁實測過)。
- **舊的 Python 環境還在**:`workers/.venv-asr`、`.venv-tts`、`.venv-turn` 是換成 uv 之前的環境,留著當退路;`data/backups/host.toml.old-venvs-20261116` 有換回去要用的那幾行。uv 的環境穩定一陣子之後可以刪。要決定的見「等 owner 決定」第 32 題。
- **她的聲音少一個檔**:`workers/voices/deepseek-chan/ref.txt`(參考音實際說的內容)不在,語音合成因此用只看音色的模式載入,`doctor` 會提醒。切換前就是這樣。要決定的見「等 owner 決定」第 34 題。
- **npm 還沒發佈**(owner 2026-11-15:晚點)。要決定的見「等 owner 決定」第 27 題。

### V5 階段 3 合併之後還沒做的收尾(2026-11-17)

階段 3 在 2026-11-17 合併(PR #56),live 在同一天凌晨切到新的腦:記憶重建跑完(318 段、521 行、230 則情節,約 1.08 美元),本機 embedding(Harrier)在跑,`[modules.agent.initiative] home` 設好了。下面是還沒做的:

- **owner 的實測還沒做完**:語音插話她會不會停、唱歌的報幕(歌等報幕講完)和唱完的回報、`@名字` 是不是真的 tag、`schedule` 到時間會不會來、審核過的工具晚到的結果。這些只有模擬事件的測試,沒有在真的 Discord 和語音上看過。
- **記憶重建丟掉約三成的行**(寫入 521、丟掉 212),9 段因為模型回的格式不能用而放棄。還沒看是哪一類被丟(沒有出處、重複、超過長度),也沒看放棄的段落能不能重試。
- **搬舊筆記時有 95 筆對不到歸屬**(`notebook and knowledge moved into the notes`:128 份文件、1,023 行、unmapped 95)。沒搬的還在舊表裡,沒有看是什麼。
- **新記憶的 recall 還沒量**:舊的基準是 recall@5 0.80、MRR 0.63(`data/eval/sets/memory.json`)。`pnpm eval --live --suite memory --memory-set <set> --memory-target notes` 還沒跑;「找回不相關」的三個門檻(`[modules.memory.notes_recall]`)是預設值,沒用真實題目調過。
- **「只回受理了就說做好了」沒有完全消掉**:修正評測最後一輪 117 次裡 1 次(`c04-file-receipt`)。
- **修正評測的一個已知誤判**:`c03-alarm-no-tool` 把她對對方說的「你設好了跟我說」當成她宣稱設好了。
- **承諾的預設期限偏急**:沒講時間的承諾 2 分鐘到期,而段落整理要對話停 5 分鐘才跑,所以一記下就過期。超過 24 小時才到期的承諾,Core 重啟後會掉(`CommitmentBook` 只從最近 24 小時的紀錄重建)。她明講不做了的承諾不會關。
- **願望檢查在她自己起頭、沒有 @ 人、房間裡有好幾個人時**,仍然對每個人都檢查,可能誤擋。
- **面板的新頁面沒有在瀏覽器看過**(評測、筆記、回合頁的工具呼叫、提示詞頁);**夜間評測沒有實際跑過**(`[modules.eval]` 預設關)。
- ~~`share` 的圖片 metadata 沒有清除~~:2026-11-22 起 `api` 模組提供重新編碼的副本(`packages/api/src/files/clean.ts`),沒有 `api` 模組時才照原樣送。
- **CLI 用相對路徑匯入 notes**,`packages/cli` 還沒有 `@miyoria/memory` 這個依賴(2026-11-21 查過還是這樣,`packages/cli/src/commands/memory.ts`;加依賴要跟著更新 `pnpm-lock.yaml`,要在能跑 `pnpm install` 的時候做)。
- **live 的 `miyoria.toml` 還有不再被讀的鍵**(啟動時的警告列了 `llm.thinking`、`modules.agent.max_tool_steps`、`tool_timeout_ms`、`max_tool_result_chars`;`[llm.reasoning] chat_intent` 也沒有作用了),可以刪。要決定的見「等 owner 決定」第 33 題。
- **退路的備份**:`data/backups/core-db-before-v5p3-20261117/` 和 `miyoria.toml.before-v5p3-20261117`;`data/backups/core.db.rebuild-dryrun-20261116` 是估花費用的複本,可以刪。要決定的見「等 owner 決定」第 31 題。

### 設定鍵清理之後留下的(2026-11-16)

舊的主線和舊的工作線被新跑者換掉之後,沒有人讀的設定鍵和服務鍵清掉了(哪些見 [v5-brain.md](v5-brain.md) 「2026-11-16 的檢查」最後一段)。下面是清的時候發現、但不屬於清理的:

- **`PlaceAccessKey` 沒有人提供**:「別的地方」(`elsewhere`)和「剛才」(`just_now`)問它哪些地方她看得到,沒有人提供時每個地方都算看得到。要不要有真正的存取規則,還沒決定;有之前不要把它刪掉,讀它的地方是對的。要決定的見「等 owner 決定」第 42 題。
- **`ImageGenKey` 沒有工具**:生圖服務有、鍵有人提供,但新跑者沒有生圖的工具,她叫不到。要等生圖開放(見上面「生圖卡池開放」)。
- **遊戲導演還在縮減過的工作線上**:`[modules.agent.work]` 只剩 `enabled`、`daily_tokens`、`result_chars`、`did_lines`、`keep_ended`,只有遊戲導演一步一步做決定時用。要把它搬到小幫手(delegate)的跑者上,才能刪掉整條工作線和這一節設定。
- **`GameControlKey`、`PartyTableKey` 只有測試在讀**:正式程式沒有人用,測試靠它們控制導演和派對。要刪就得先換測試的做法。
- **舊的 `KnowledgeStore` 在 `learning` 模組裡還會載入和寫回**:沒有資料庫時(測試用的空架子)它是整個知識庫,有資料庫時只有匯入工具會讀。要拿掉就得先決定沒有資料庫的情況怎麼辦。要決定的見「等 owner 決定」第 43 題。
- **`agent.initiative` 事件沒有人發**:agent 和 facts 還訂閱它,事件的 schema 在 SDK 和面板的型別裡,SDK 的相容性測試也列著它。要拿掉是改公開的事件合約,另外決定。要決定的見「等 owner 決定」第 41 題。
- **`[llm.reasoning]` 的 `chat_voice` 和 `work` 沒有作用**:語音這一輪和小幫手都在 profile 裡固定了推理等級,不看這兩個鍵。範例檔已經這樣註明,鍵本身留著。
- **移除 `[llm.thinking]` 的行為差異**:舊設定檔裡有 `[llm.thinking]` 的,現在那些用途改用 `[llm.reasoning]` 或預設值(例如 `mind = true` 以前等於 `medium`,現在是沒列的用途 = 不思考)。啟動時會警告,但要不要在 `[llm.reasoning]` 補上,要 owner 看自己的設定檔。要決定的見「等 owner 決定」第 33 題。


### V5 階段 4 第 4、5 步留下的(2026-11-17)

- **`task_together` 證據沒有人寫**:任務、懸賞完成時沒有記;Minecraft 沒有玩家名單,也沒記 `played_together`。
- **V4 的分級對照表還是手抄的**(`store` 的切換程式):V4 切換拿掉時一起刪,或改成從 `BOND_TIERS` 產生。
- **`tools/replay` 的 `announcements-not-her-topics.jsonl` 還帶著 `plans`**:Plan 刪了以後腳本不讀它,留著不影響結果;下次重錄時拿掉。
- **self 裡「暗戀」的名字還在**(`crushPerson`、`crush_spoke`、`crush_message_longing` 這些):讀的已經是 heart 算的「最在意的人」(H5),只是名字沒改;設定鍵要改名得一起改 `removed-config.ts` 和範例檔。要決定的見「等 owner 決定」第 44 題。
- **`relationships`、`relationship_deltas`、`self:feeling:*`、`self:state` 沒人寫了**,只有搬移讀;等 v5-data §8 第 14 步刪表。

### V5 階段 4 稽核之後留下的(2026-11-17)

- **多個 profile 共用 `heart_person`**(稽核 M10):表沒有 profile 欄,同一個資料庫開兩個角色時她們對人的數值是同一份;要分開得加欄位和搬移,等 Space / 角色分開(階段 6)時一起做。
- **稽核 M18 的既有競態**:階段 4 之前就有,這一輪沒有修;細節在稽核報告裡,修的時候先寫一個會失敗的測試。
- **合併兩個人時事件不改名下**:`heart.changed`、`heart.evidence` 是只能附加的,被併的人的事件留在原來的 id 下,留下的人的變動紀錄和當天的上限看不到它們(列已經合成一列)。要看得到得讓讀的一方把 `absorbedInto` 的 id 一起查。
- **「忘記我」沒清舊的 `self:feeling:<person>` 卡片**:搬移讀完就沒人讀,v5-data §8 第 14 步刪表時一起刪;在那之前它們還留著她以前寫的感覺。

### 卡拉 OK 第二次實測留下的(2026-11-19,owner 說之後再修)

那一場(兩個人、一回合)直播上沒有影片、沒有多人的即時音高,owner 覺得整個流程也怪。查到的:

- **到 worker 那台的線路整條只有約 0.6 Mbit/s**:同時六個檔在傳時合計就是這個數,同一時間對那台的 ICMP 來回 0.4 到 3 秒、掉 6%(閒置時 2 ms)。壅塞在網路層,不在 relay 的程式;那一端的上傳為什麼這麼小還不知道(要他那邊量上傳速度)。
- **影片拿不到**:卡拉 OK 的影片是 worker 裁過、壓過的,只能從那台拿,幾十 MB 在這條線上要十幾分鐘。可以讓 Core 這台自己抓原片(翻唱已經這樣做),或讓 worker 出一份小很多的。
- **傳檔互搶**:影片、翻唱的音檔、卡拉 OK 的檔同時傳,誰都慢。該排隊:一次一個大檔,影片最後,房間有回合在唱時暫停。
- **音檔是沒壓縮的 PCM**(一首歌 `play_mix.pcm` 加 `play_vocals.pcm` 可以到 60 MB):改成壓縮傳、Core 這邊解開,量少十倍。要 worker 那台更新。
- **那一場兩個人的正式分數是 1.2 和 1.4**(瀏覽器估 0 和 1.7),沒有人算唱完:還沒查是真的沒唱、麥克風沒收到,還是算錯。
- **流程怪**:owner 沒說是哪裡,修之前先問他。
- **直播上沒有成員的 Discord 頭像**:跑道上只有名字第一個字的圓標;Core 沒有成員的頭像網址,要的話得先讓 Core 拿到(karaoke.md「要 owner 決定的」S4)。要決定的見「等 owner 決定」第 18 題。
- 加油要不要花魚幣、要不要和彈幕合在一起(karaoke.md S1、S2):見「等 owner 決定」第 17 題。

(2026-11-21:「即時音高靠 worker 來回」已經改成直播的音高道用瀏覽器自己算的音高(`POST …/pitch`,`packages/play/karaoke/src/rooms.ts`),worker 的只在落後不到 4 秒時拿來用,見 karaoke.md「第二次實測之後」;從這裡拿掉了。)

### 這幾天新做、還沒對真的東西跑過的(2026-11-21)

- **每晚整理筆記**(`[modules.reflect.tidy]`,`packages/memory/notes/src/tidy.ts`):預設關,沒有對真的模型跑過;只有假模型的測試。
- **從面板更新別台電腦**(hostd 照 Core 指定的 commit 更新自己,[v5-hostd.md](v5-hostd.md)):預設開、只有 owner 能按,沒有對真的另一台電腦跑過;更新不會重建面板、overlay、SDK、擴充,hostd 自己要那台 `miyoria down` 再 `up` 才換新的程式。
- **她的小幫手(curator)只碰得到叫它那個地方寫的行**:別的地方(別的伺服器、私訊)寫的筆記它看不到也改不到;每晚整理筆記看得到全部,但只在同一個範圍裡合併([v5-brain.md](v5-brain.md)「每晚整理筆記」)。
- **預測的抽成**(`prediction_rake`,預設 5%)已經上線,等 owner 確認比例:見「等 owner 決定」第 19 題。
- **問題回報和成員連結 GitHub**:沒有對真的 GitHub 跑過,見下一節。

### 問題回報第一版留下的(2026-11-21)

`[modules.report]`(`@miyoria/brain/report`,面板 運作 / 回報,設定步驟寫在 `packages/brain/report/src/config.ts` 開頭和兩份範例設定檔)。第一版是先存草稿、owner 核准才開 issue;第二版加了 GitHub App 和成員自己連結 GitHub。

- **沒有對真的 GitHub 跑過**:REST 呼叫(搜尋、開 issue、留言、讀 issue、用 id 查帳號)、App 的 JWT 換 installation token、成員連結的 OAuth(換 token、`GET /user`、撤銷 token)都只在測試裡對假的 `fetch` 跑過;第一次開的時候先拿一個測試用的 repo 和 App 試。
- **連結只標記在核准開的 issue 上**:「改成加到 #N 的留言」不寫回報者的 `@`。
- **還在連結途中的狀態只在記憶體裡**:Core 重新啟動時,剛按下「連結 GitHub」還沒回來的人要再按一次。
- **找重複只比標題**:GitHub 的搜尋對中文斷詞不準,找不到的時候只是沒有提示,不會擋;要更準得把內文也拿來比,或用向量。
- **修好的通知靠記憶的 follow-up**:issue 關掉(做完)時寫一則到期的 follow-up,由 initiative 照平常的關卡叫醒她在回報的地方說;那時記憶模組沒開,這一次就不會再補(面板看得到「沒有提醒」)。
- **重複和留言的 issue 也會追**:標成 #N 的重複、或加到 #N 的留言,#N 關掉時一樣會通知回報的人,不管 #N 是不是從回報開的。

### 階段 6 的市集、佇列、點歌留下的(2026-11-22)

[v5-places.md](v5-places.md) §10 是做成的樣子。

- **她離開的伺服器的歌**:在那個伺服器點、還沒唱的歌會一直等,直到她回去或有人取消;沒有自動取消退券。
- **管理頁的歌單卡**(即時 / 歌)還是她全部的歌,沒有標是哪個伺服器的,也沒有跟著殼的伺服器切換。
- **佇列的 overlay**:`queue.changed` 的信封現在帶 `space_id`(2026-11-22),讀的人分得出是哪個伺服器的。overlay 還是沒有真的佇列:`apps/overlay` 的 `queue` 只是 demo,Core 不送;要顯示她正在唱的那個伺服器的佇列,得在 stage link 和 overlay 的契約各加一個 `queue` 訊息,Core 轉給 Stage 時只轉她在語音(或正在唱)的那個 Space 的,兩邊一起更新。

### 伺服器推送留下的(2026-11-22)

[v5-architecture.md](v5-architecture.md) §11.4 是做成的樣子。

- **還沒上線看過**:Cloudflare tunnel 對長連線的行為、經 tunnel 的每位址限制、Core 重啟時的重連;怎麼看寫在 §11.4 最後。
- **管理的即時頁是「事件來了就重抓」**,不是把值推過來:每個變化多一次請求(每個最多一秒一次),`/api/events` 也不能從 `Last-Event-ID` 接著送,斷過就全部重抓。要改成值得把那幾條路由也寫成 `Watch`,加一條管理的推送串流(只在 `bind`)。
- **交易所沒有「報價更新了」的事件**:推送每 10 秒自己重算一次,報價最晚還是差一輪(預設 60 秒)加 10 秒。要更快得讓交易所每一輪結束時發一個事件。
- **完全不讀的讀者**(伺服器這邊):沒有新東西要送時,只剩 15 秒一個的 `ping` 和註解卡在 socket 的緩衝裡,要等 TCP 自己放棄;有新東西卡超過 30 秒才會被斷掉。頁面那一側的「連線死了卻沒關」已經由看門狗處理(§11.4)。
- **直播頁自己的 `/api/public/live` 沒有看門狗**:它本來就只有推送、沒有輪詢可退,用瀏覽器的 `EventSource` 跟;tunnel 抓著死連線時那頁會停在最後的樣子,直到瀏覽器自己發現。要補得讓它也送一個看得到的心跳事件,頁面 45 秒沒聽到就重開。
- **限制在記憶體裡**:每位址、每帳號、全部的串流數,重啟就歸零(和管理 token 的鎖定一樣)。
- 會員頁的「歌單」和首頁還是主要伺服器的歌(和輪詢時一樣),沒有跟著會員選的伺服器;推送的 `songs~<space>` 已經可以帶伺服器。

### 階段 6 的卡拉 OK 房和 home 留下的(2026-11-22)

[v5-places.md](v5-places.md) §9、§10 是做成的樣子。

- **一個人自己唱的講評**還是 cluster 的講評頻道:分數沒有伺服器,要分得讓會員頁開唱時也帶 `?space=`。
- **`room_max` 是全部伺服器加起來的**:一個伺服器開滿,別的伺服器就開不了;要每個伺服器各自的上限得先確定唱歌的機器撐得住。
- **`look` 不知道 owner 隱藏的頻道**:那是記憶的 `recent.hidden_channels`,selfhost 拿不到;現在靠平台的 `PlaceAccess`。
- **home 的合併只到 Space**:home 所在伺服器的其他頻道、私訊裡在等的事沒有合併成一行(它們在自己的地方醒來時會看到)。
- **home 是伺服器的頻道時,`look` 看不到別的伺服器**:照 `disclose`,那裡的人會聽到她說的;要在 home 看全部得先有沒有別人讀的 home session(v5-architecture §6)。

### 每個對話每小時的上限改成設定之後留下的(2026-11-22)

[v5-brain.md](v5-brain.md)「設計的結論」裡「每個對話每小時的上限」是做成的樣子。

- **上限的數字要 owner 決定**:`session_usd_per_hour` 先維持 1 美元、`session_tokens_per_hour` 3,000,000(和改之前一樣);2026-11-22 一個忙的頻道半小時就到了,之後她沉默了半小時。
- **重啟會忘記這一小時**:帳本只在記憶體裡,Core 或 agent 模組重啟(改了 cluster 層的設定也會重啟模組)之後從 0 算。`llm.call` 事件有 `cost_usd`、用量、`module` / `label` 和信封上的 `turn`,但沒有 session;要接回來得用同一個 `turn` 去對 `agent.turn.outcome` 的 `context` 再換成 session(`transcript.sessionFor`),而且要一條新的 store 查詢(現在的 `LlmCallStore` 只有按模型的總數)。
- **總覽的「需要注意」沒有列出被擋的對話**:它讀 `/api/llm/cost`(router 的每天預算),每個對話的帳本在 selfhost 的跑者裡,API 拿不到。現在看得到的是記錄裡的警告和回合結果(活動頁、意識流寫「這個對話這一小時的花費到上限了」)。要列出來得加一個服務和一條路由。

## 4. 自我修復與自我改進(備忘)

三層,越下面風險越高:

1. **自我修復**:同一件事用同一種方式失敗三次就換方法或說出來。
2. **自我改進**:她提出的改動(教訓、技能、設定)先跑事故評測,分數變好、沒有退步才留下;提示詞和人設要 owner 在面板看過。
3. **改程式碼**:只由她自己的失敗紀錄觸發,在沙箱寫修正、跑測試和評測、開 PR,由 owner merge;絕不直接改正在跑的 Core。

前提是評測要可靠(已有 `tools/eval` 的事故題庫),第 3 層要先有 Docker 沙箱。
