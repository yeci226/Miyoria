# 暫緩與待決定清單

統一記錄 owner 說「暫緩」「先記錄」的事、還沒做決定的問題和已知但還沒修的問題。新的暫緩項目加在這裡;詳細內容在各自的文件,這裡只放一行和連結。最後整理:2026-11-18。

## 暫緩的功能

| 項目 | 狀態 | 詳細 |
|---|---|---|
| 第二個平台(Telegram、QQ)和直播聊天室輸入 | owner 2026-11-14:暫緩,先把 Discord 做完善 | [v5-architecture.md](v5-architecture.md) §6 |
| 生圖卡池開放([image-cards.md](image-cards.md):主題池、底片庫、覺醒、分解、SSR「和你」)和你畫我猜 | 生圖經 ComfyUI 的 API;模型等十二月的新模型再選。設計已寫完,和模型無關的部分階段 5 先做、旗標關著 | [v5-play.md](v5-play.md) §3 |
| Minecraft 幾乎不能玩(任務迴圈、技能庫、狀態快照、食物動作、生存反射) | 調查做一半暫停,原因還沒對照程式碼確認 | [minecraft-findings.md](minecraft-findings.md) |
| 自我修復、自我改進(失敗後換方法、改動要過評測才留下、在沙箱寫修正開 PR) | owner 說先不做;沙箱要先有 Docker | 本文件 §4 |
| 大家線上唱 K(她當主持人的 KTV 房) | owner 2026-11-15 提的想法,還沒決定做不做。**做到的時候先問 owner 細節,不要照下面的草稿自己做**(owner 2026-11-16);以下只是當時的初步看法。不把舊的 `karaoke` 專案(SUMI,單人桌面練歌室,Tauri)整個搬進來;要拿的是三塊:參考音符的擷取(ROSVOT,加進唱歌 worker)、瀏覽器端的即時音高和評分、歌詞和音高導引的畫面。下載、分離伴奏、歌詞對時、點歌佇列、派對遊戲的框架這邊已經有。難的是延遲:伴奏要在唱的人自己的瀏覽器播、在本機評分,別人聽到的要是混好的一軌。最早放在階段 5(玩)或階段 7(活動契約),要先有階段 6 的公開站拆分。版權要先想清楚(把伴奏和歌詞送到每個人的瀏覽器) | 這一列 |
| 直播上用魚幣付費的彈幕 | owner 2026-11-18:**正在做**,排在卡拉 OK 之後。他看過的其他直播互動(花魚幣指定表情或摸摸、帶你名字的螢幕特效、花魚幣投票)**現在不做**,以後要做先問 owner | 這一列 |
| 聊天事件的 CG(聊天裡偶爾出現特殊事件時給一個提示,可以花魚幣解鎖那一刻的 CG;每張獨一無二,只有買的人看得到,用 AI 生圖) | owner 2026-11-17 提的想法,以後做:生圖的模型還沒決定。做的時候先問 owner 細節(什麼算特殊事件、誰決定、價格、要不要進圖鑑)。生圖一律經 ComfyUI 的 API;內容照她的界線(擦邊可以,不描寫真正的性行為);圖只給本人看,用產物庫的私有產物。和生圖卡池是同一批前置(模型、檢查管線) | 這一列;[v5-play.md](v5-play.md) §3 |
| 服務的模型檔自動下載(`service.toml` 宣告需要哪些檔案、來源和檢查碼;`add` / `update` 補齊缺的,`doctor` 驗證) | **機制做好了(2026-11-18)**:`[[install.files]]`(來源、SHA-256、大小、授權,只從允許的主機、可續傳、先問一次)、`doctor` 驗證並記住雜湊、`doctor --print-hashes`、缺必要檔案 hostd 不啟動。**sing 的兩個分離模型已經自動下載(2026-11-18)**:MelBandRoformer.ckpt、becruily 的 .ckpt 和它的設定檔,固定 commit 和 SHA-256 對過實際檔案;becruily 的 repository 沒標授權,owner 決定自動下載。舊的手動位置 `workers/models/` 繼續有效(worker 先找新位置、退回舊位置;`update` 看到舊位置的檔案檢查碼相同就用硬連結接過來,`adopt_from`)。**還差**:turn 的 smart-turn / silero-vad 沒有 SHA-256 和固定 commit,先註解掉、照舊列成手動(turn 因此暫時不再自動下載),要在有這些檔案的電腦上 `miyoria doctor --print-hashes turn` 填進去、查 commit、取消註解;MelBandRoformer 的 `.yaml`(sha256 f63f38eb…,1721 bytes)還沒有確認過的固定來源,仍然手動(`workers/README.md` 說它是 MSST 的 `config_vocals_mel_band_roformer_kj.yaml`,要查到哪個 commit 的內容一模一樣才能填)。Seed-VC 原始碼、MediaMTX 執行檔、她的 RVC 模型和參考音維持手動 | [v5-hostd.md](v5-hostd.md) §9.1;`workers/turn/service.toml`、`workers/sing/service.toml` 的 `TODO(owner machine)` |
| 每日貼文(她做完自己想做的事之後,在 owner 指定的一個頻道貼一則,一天幾則,內容只能是真的做過的事) | owner 2026-11-16 決定先擱置,不是壞掉。程式、`[modules.mind.daily_posts]` 和 `DailyPostsKey` 都刪了;舊設定檔裡還有這一段會被忽略並在啟動時警告。它是走提案板和舊主線送出去的,兩個都在 V5 刪了,所以從第一步起就沒貼過。要重做就接到新跑者的 initiative(`packages/brain/selfhost/src/initiative.ts`),當成多一種機會:由 `LifeBook`(她做過什麼的日誌,留著)餵,設定一個專屬頻道和每日上限 | [v4-plan.md](v4-plan.md) §8.4、§16 第 8 列(舊設計) |
| 經濟系統:點歌券、她自己的錢包、她的訊息上附「餵她」按鈕 | 刻意不做 | [economy.md](economy.md) §9.1 |
| 檔案附件的後續:音檔(轉文字)、掃描或中日韓字型的 PDF(要 OCR 或帶套件的沙箱映像)、舊版 .doc/.xls/.ppt、壓縮檔、一次傳很多檔、讓她把讀過的檔案記進筆記 | 第一版只做文字/程式碼/csv/json/pdf(純文字層、簡單字型)/docx/xlsx/pptx | [file-attachments.md](file-attachments.md) §6 |
| RVC 唱歌的咬字 | 2026-11-09 測完:RVC 轉她自己的說話幾乎不掉字(7.9%,原音 5.3%),轉別人的歌聲就糊(《雪は何色》對真歌詞 45%,原唱 27%)。試過 48k 頻寬擴展、加 YingMusic 產的歌聲資料、Rigel 底模(含日文和歌聲)、檢索率 0、protect、第 1–40 epoch,都沒有明顯改善;原因是 ContentVec 聽不清日文歌聲加上她只有說話資料。目前最好的是 YingMusic → RVC 串接(38.7%)。試驗在 `data/rvc-test/`、`data/rvc-train-songs/` | [backlog 本節下方](#唱歌轉換還沒做的) |

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

> 2026-11-16 補註:這一節是 hostd 之前寫的。`miyoria start`、`miyoria install`、`[machine]`、`[stack]` 和三個角色已經被 hostd、`service.toml`、`host.toml` 取代(見 [v5-hostd.md](v5-hostd.md)):服務死了會自動重啟,有 `down`、`restart` 和守衛,環境用 uv 和 lock 檔,worker 有 token 檢查,推論機不再限一台。下面仍成立的只有:Minecraft 擴充在 Core 那台開遊戲、新手要自己放 TTS 的聲音參考音、`add` 不管 Docker / JDK / Minecraft mod,以及最後「只在乾跑和單元測試驗證過」裡跨電腦和 Linux 那兩項(現在的做法見上面「V5 階段 2」)。其餘留作歷史。

三個角色(直播機、Bot 服務機、GPU 推論機)分到不同電腦時,`miyoria init / install / start / doctor` 已經能設定、啟動和檢查,但下面這些還不行或還沒決定:

- **Minecraft 擴充在 Core 那台開遊戲**:擴充(`extensions/minecraft`)用 Prism Launcher 開遊戲,開的是 Core 所在的電腦,不是直播機。要改成由直播機上的節點開遊戲。
- **自動重啟**:`miyoria start` 只開分頁,服務死了不會拉起來(分頁會停在錯誤訊息上)。要不要加重啟、怎麼避免重啟打斷開著的 Go Live 和唱到一半的歌,還沒決定。
- **沒有 `miyoria stop`**:停止就是關分頁或在分頁裡按 Ctrl+C。要不要加指令、怎麼避免誤停直播,還沒決定。
- **角色名稱還沒定案**:`broadcast`、`core`、`inference` 和它們的中文名稱都在 `packages/cli/src/stack/roles.ts` 一個地方,改名只要改那裡和文件。
- **推論機只能有一台**:`[machine.hosts] inference` 是一個位址,asr、tts、sing 要在同一台(sing 做歌時要它們讓出顯卡)。sing 的卸載網址是 worker 的 host + port。
- **LAN 上的 worker 沒有認證**:推論機的 worker 綁在區網位址,同網段的人都連得到;目前靠防火牆。Miyoria 不會替你改防火牆,`doctor` 只會檢查連不連得到。要不要幫 worker 加 token,還沒決定。
- **voice node 的重複啟動偵測靠行程清單**:voice node 沒有埠,`start` 看行程清單裡有沒有 node / cmd 的命令列含 `apps/voice-node`(不管是誰啟動的),讀不到清單就當作「可能在跑」、不啟動。只在 Windows 有效;從別的資料夾(例如複製出去的 `dist`)跑的偵測不到。更穩的做法是 voice node 自己持有鎖檔,或 Core 的管理 API 回報 voice.link 有沒有節點連著(現在要驗證登入,`start` 沒有 token),都還沒做。`up` 也沒有這個檢查。
- **`install` 只下載 turn 的兩個小模型**:smart-turn 和 silero-vad(約 11 MB)由 `install` 從官方來源下載;sing 的 RVC / 分離模型、Seed-VC 原始碼、她的聲音參考音沒有文件化的下載網址,仍由人放。Qwen3-ASR 和 Qwen3-TTS 的權重會在第一次啟動時自己下載(數 GB)。
- **`install` 不管 Docker、JDK、Minecraft mod**:Docker Desktop(檔案沙箱)要自己裝,`doctor` 只在沙箱啟用時檢查;mod jar 仍用 `miyoria update`。
- **`start` 只支援 Windows**:分頁靠 Windows Terminal(沒有就開一般的 console 視窗);其他系統用 `miyoria up`(背景執行,日誌寫檔)。
- **`up` 和 `start` 兩套**:`up` 在背景執行、Ctrl+C 一起停;`start` 開分頁。兩個都讀 `[machine]`,要不要合併成一個,還沒決定。
- **`[stack]` 的舊寫法**:設了 `[machine]` 之後,`[stack]` 的 `core` / `voice_node` / `stage` 不再有作用,只有 `[stack.workers.<name>]` 還會覆蓋 worker 的細節。確認沒人用舊寫法後可以拿掉。
- **新手要自己放 TTS 的聲音參考音**:預設角色 `deepseek-chan` 的聲音檔 `workers/voices/deepseek-chan/ref.wav`(加 `ref.txt`)不在 repo 裡,tts 沒有它就不能用;sing 的 `reference` 預設也指到這個檔。要不要附一個授權乾淨的範例聲音、或讓 `init` 問聲音名稱,還沒決定。
- **`install` 沒用 uv**:venv 和 pip 用系統的 Python。uv 比較快,但 torch 要指定 CUDA 的 `--index-url`,uv 的 index 規則不同,沒有驗證過,所以沒採用。
- **這一輪的新功能只在乾跑和單元測試驗證過**:
  - 真的開 Windows Terminal 分頁(`wt -w miyoria new-tab …`):只測過產生的引數和 `.cmd`,沒有在乾淨的機器上實際開過;
  - 真的建 venv、pip 安裝、下載模型:只測過計畫和假的下載,沒有真的裝;
  - 跨電腦執行:三個角色分到不同電腦,沒有實際跑過;
  - Linux / macOS:`install` 的套件管理員對應和印出的 apt / dnf 指令只用假的指令執行器測過,`start` 在這些系統上只會提示改用 `miyoria up`;
  - Core 在「沒有任何 worker」時用預設的本機 ASR / TTS 網址能不能乾淨開機(純文字聊天),沒有實測。
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

- V5 還沒定的:十二月的生圖模型、ComfyUI 跑在哪一台、她的 LoRA 的授權;「玩」剩下的([v5-play.md](v5-play.md) §8:水族箱要先看示意圖;交易所的開戶門檻、持有上限、指數基金、放空);圖片訊息的背景暫時沿用遊戲美術那一張,之後要換;Minecraft 的志向清單 / 誰算主人 / AltoClef。其餘十一項已決定:[v5-architecture.md](v5-architecture.md) §16。
- 貨幣系統 §9 的問題已先用建議值上線,隨時可改:[economy.md](economy.md) §9.1。
- 人設要不要加一句:肚子餓時可以被零食收買,不情願地配合可愛的小要求(現在人設寫著『現在你是一隻貓』這類要求要吐槽回去)。
- `ambient_text` 怎麼設。
- `deny` 規則要不要也綁住 owner 本人。
- 刪除確認按鈕的顏色。
- 語音場次開始時要不要重設「沒人回應」的計數。
- 公開頁的背景圖(遊戲美術)要不要對外顯示。
- 任何 Discord 帳號都能成為成員,要不要限制(例如必須是伺服器成員)。
- 網頁點歌預設開啟,要不要維持。
- 被封鎖的人「請她忘記我」時怎麼處理。
- admin、moderator 角色缺 `admin.directive.*`、`queue.song.request|list|play`、`tools.web`、`tools.file`(Core 啟動時有提示;有萬用權限所以實際不受影響),要不要補上。
- owner 的 Discord 帳號 `owenliu` 現在是 `member`,要不要升成 admin。
- 要不要 push:`main` 比 `origin/main` 多 14 個 commit(2026-11-09)。
- 唱歌混音的預設要不要去掉和聲(現在保留原和聲,放回伴奏;去掉的版本聽過了,沒決定)。
- Core 要不要在有新 commit 時趁她閒置自己重啟,或授權我修完直接重啟(現在每次都問)。
- `apps/panel/.tmp-build`(build 時的 Node 編譯快取)可以刪,沙箱不讓我移到資源回收筒。
- owner 的 Temp 資料夾有大約八個不認得的、各約 150 MB 的資料夾,清硬碟那次沒有動(2026-11-18);要先看是什麼再決定刪不刪。`uv cache clean` 也沒能執行:有 `uv run` 的程序佔著快取。等那些程序結束後再清(uv 的快取可以放心清,下次會重新下載)。

## 已知但還沒修

- **「修進度條」已修(2026-11-18,分支 `v5fix-bar`,待合併)**:主線是她現在在做的事(說話、思考、唱歌、用工具、玩遊戲),準備歌曲變成旁邊一個小的第二行(歌名 + 一條整體進度),只有她閒著時才佔主線;每個 worker 階段都有白話標籤(`SONG_PREPARE_STAGES` 加 `STAGE_LABELS` 加 worker 的來源掃描測試,三邊對不上會失敗);進度在 worker 和發布端都只進不退,影片階段有自己的份量;排隊 / 等待是不確定的微光;換歌立刻重來;顯示的歌固定一首(只有還在排隊的會讓給 worker 已經在跑的);沒標題時顯示「某某 點的歌」或「連結」;工具和遊戲有自己的活動(新事件 `agent.tool.running`,只帶工具名);過期狀態都處理了(Core 掉線連 notice 一起清、送失敗會重送、正在唱依歌長逾時、worker 連不上 20 秒後顯示「連不上」、再 60 秒收起)。還沒做:實況上看過一輪;`party_*` 遊戲(派對)沒有自己的活動,只有 `game.director.session` 的遊戲;面板「直播頁」(`apps/panel` 的 `LiveActivityKind`)還只認得舊的四種 `kind`,新的 `tool` / `game` 和第二行要等面板那邊接;點歌以外的背景工作(畫圖等)還沒有第二行。
- **點歌從 2026-11-17 晚上壞到 2026-11-18 早上**:拿掉固定網址之後,點歌模組看不到叢集裡的 worker(修在 PR 69)。**還沒有人確認過一首真的歌經過朋友那台**:這要有人實際點一首、等到播出來。
- **她讀不到連結裡的圖,也不能真的瀏覽網頁**(2026-11-17):現況和可以做的三件事在 [v5-play.md](v5-play.md) §10.3。
- **主人規則沒寫進去**(2026-11-10 加了保險):回合裡有人明說「不要玩 <她有的遊戲>」而她這回合沒自己呼叫 `directive_add` 時,回合結束前用說這句話的人的身分替她寫一條 deny(`packages/brain/agent/src/prohibition.ts`、`turn.ts` 的 `keepRules`;規則服務照樣判斷這個人能不能立規則;「先 / 今天」是 6 小時)。只認得 Minecraft、osu 和幾個別名;事故評測 `mc-owner-rule-never-written` 要重新錄才會翻成通過。
- **她把自己的盤算講出來**(2026-11-10 先用規則擋):送出前把「第三人稱講對方 + 對自己下指令」的那一行拿掉(`packages/brain/agent/src/leak.ts` 的 `isSelfTalk`,只拿掉那行、其他照送,有「你」的不算)。還沒做事故評測題、也還沒看真實頻率;規則抓不到的說法要再補。
- **抓被回覆的訊息為什麼會失敗**:2026-11-08 14:19、14:22 兩次回覆都沒帶到被回覆的那句。已改成先用 Discord 隨回覆送來的引用內容、抓到再換成完整的,失敗會記 `could not fetch reply parents` 警告;原本為什麼抓不到(逾時、權限或 Discord 錯誤)還沒查,重啟後看警告。
  - 2026-11-10:找到一個會讓它抓不到的情況並修掉:被回覆的是她自己的卡片(斜線指令的回覆、收據,Components V2、`content` 是空的)時,以前算「沒內容」直接丟掉;現在讀卡片上的文字(`componentsText`),指令回覆也算可以回覆的訊息。抓取失敗改記 warning(`cannot fetch the replied-to message`,帶頻道和錯誤),拿到但沒內容記 info 和訊息類型。14:19 那兩次是不是這個原因還沒對照。
  - 2026-11-11 再查程式:引用內容先從 gateway 快取拿、沒有就 `fetchReference`,兩邊都失敗時才會沒有被回覆的那句;最可能是那個頻道沒給 bot「讀取訊息歷史」(Read Message History,`docs/OPERATIONS.md` 的邀請權限有列),快取裡沒有的舊訊息就抓不到。重啟後看 `cannot fetch the replied-to message` 警告裡的錯誤:`Missing Access` / `Missing Permissions` 就是權限。
  - 同一天修掉相關的看圖問題:14:22 她把對方之前貼的截圖當成答案,原因是同一個人 2 分鐘內的圖會一起給她看,而每張圖都只標「某某傳的圖片」。現在每張圖標明是這則訊息附的、被回覆的那則裡的、還是幾秒前另外傳的(不是這則訊息附的);回覆別人的訊息時不再帶同一個人更早的圖(`packages/brain/agent/src/vision.ts`)。
- **主線提示詞的「新東西別說不存在」只有一句短的**:主線固定提示詞已貼著 4000 token 的上限(`prompt-budget` 測試),完整版(產品、版本、事件、日期)只在 V2 規則裡。要放完整版得先騰出空間。
- 語音視窗跑到 92.5 秒,超過 90 秒的上限。2026-11-11 查過:程式裡找不到叫「語音視窗」、上限 90 秒的東西(`speech_hold_max_ms` 是 90 秒,但每 250 ms 檢查一次,不會超過 2.5 秒),這一行也沒附記錄;下次看到時記下是哪一行記錄。
- 網頁的直播卡「OBS 推流」只控制 OBS。
- Discord 指令拿不到互動 ID,錢包操作防不了網路重送造成的重複扣款(面板有防)。
- 事故評測還有 9 題標成已知失敗,修好、重新錄製後才會翻成通過:`pnpm eval`。
- **經濟 §13 還沒做或沒驗證的**(2026-11-08):
  - Discord 不能指定立繪(選圖要看著圖挑,留在會員頁)。籤詩(2026-11-17 起是 `/me checkin fortune:true`)、今天的卡(`/me card`)早就有;2026-11-12 `/me card` 加了 `action:再發一張`(可加 `foil` 做成閃卡)和 `action:重抽`,價錢和次數跟會員頁一樣。
  - 面板新區塊(閃卡、籤詩、目標、懸賞、轉帳、排行榜)只跑了測試,還沒在瀏覽器裡實際看過;overlay 留言卡看過了。
- **檔案附件沒在真的 Docker 跑過**:這台的 Docker 沒開,所以她現在會婉拒所有非圖片檔(zip 本來就不支援);容器裡的寫入權限、刪檔、`python:3.12-slim` 的實際行為沒驗證。
- **好感等級的「相處方式」還沒看過她實際寫什麼**:要等她下一次反省。面板的人物卡從 2026-11-12 起顯示等級(Lv.)和相處方式(寫的等級和現在不同時註明「Lv.N 時寫的」),可以在那裡看。
- **`accept_food` 沒有人跟她說話時被擋**(`she claimed without doing`,info):她說了「開動了」這類話卻沒呼叫工具,防線照設計要她重做一次;沒有說話的人時那次重做也收不下(工具要有說話的人)。要省掉那次重做,得讓能力標明「要有說話的人」、沒有時不提供,牽涉 actions / agent / economy,沒有記錄能確認情況,先不做。
- **歌詞:QQ 音樂沒接、簡繁 / 羅馬拼音只靠 LLM**:現在的來源是 lrclib 和網易雲(非官方介面,可能被擋或改版);沒做 QQ 音樂(要簽章)、也沒本地的簡繁轉換(OpenCC)和日文假名 / 羅馬拼音互轉,這些只靠 LLM 給的別名。LLM 不認得的歌(同人曲、很冷門的原創)還是找不到。
- **歌詞整段偏移**(2026-11-10 處理):同步歌詞拿去跟主唱 / 人聲軌比對「什麼時候在唱」和「每句什麼時候開始」,整段差超過 0.5 秒且明顯比不移好時整段移過去(±45 秒內,`workers/sing/lyrics_align.py`,meta 的 `lyrics.offset_s`)。只在合成的測試音訊驗證過,還沒拿真的歌試;每句各自不準(不是整段偏)的情況不處理。
- **歌詞 ASR 抽查的門檻只用兩首實測**:正確歌詞 1.00、別首歌 0.28,門檻 0.35 / 0.6 是照這個抓的;日文漢字和 ASR 輸出的寫法不同時可能誤拒,等累積更多歌再調。
- **MelBand karaoke 模型的原始授權**沒確認。
- **becruily BS-RoFormer karaoke 的授權**:HF 上沒標(`becruily/bs-roformer-karaoke`);現在是唱歌預設的主唱模型,只在本機跑、沒散布。
- **「伴唱也轉」(`backing=convert`)**沒實測:伴唱常是好幾個聲音疊在一起,RVC 的 RMVPE 只抓一條音高,可能轉得很怪。
- **推理外洩的源頭沒查實**:2026-11-09 15:29 她在一回合(`reasoning` off、4.9 秒、23 則)把整段思考當回覆一行一行發出去。DB 的訊息和 `turn_outcomes` 看得出推理在 content 裡(provider 已把 `reasoning_content` 分開,不是它併進來的),但 LLM 呼叫的原始回應只存在 Core 記憶體,查不到;最可能是 opencode 上的 `deepseek-v4.1-flash` 收了 `thinking: disabled` 卻仍把思考寫在 content。已加的是送出前的防線(`packages/brain/agent/src/leak.ts`)和提示詞一行;要根治得在 Core 重啟後的面板呼叫檢視器看原始回應,再決定是換模型、改 `thinking_off`,還是讓 `chat_text` 開 `low`。防線擋不住不含「情緒標記 / 回覆要短 / 可以說:」這類字眼的純驗算自言自語(要兩行以上才算外洩)。
- **連結預覽的圖沒用 Geist 字型**:resvg 吃不了 woff2,預覽圖和羈絆環用專案帶的 Noto Sans TC(`packages/card-face/fonts`,2026-11-17 起不再用系統字型),拉丁字和面板上的卡(Geist)略有差;要一致得把 Geist 的 ttf 放進 repo。另外 Discord 對同一個圖片網址的快取時間沒實測:網址帶 `?v=` 版本,卡變了網址就變,但已經貼出去的舊訊息可能還是舊圖。
- **卡的現場立繪還沒進產物庫**(2026-11-17):會員頁、卡片頁、`/me card` 和連結預覽現在拿的是同一張現場算的圖(2026-11-17 做了,`/api/public/card-art/<編號>.png`)。圖還沒進產物庫(`cards_card.artifact_id` 空著;快取在 `data/cards/portraits`,依規格雜湊、不會自己清)。「別台電腦替 Core 算卡圖」(`renderer` 能力)也還沒有。閃卡的彩虹遮罩原本用固定立繪的透明背景,現場算的圖不透明,遮罩變成整塊立繪、彩虹只剩立繪以外;要不要重做遮罩等 owner 看過實頁的樣稿。見 [cards.md](cards.md) §6.2。
- **Core 從 `/` 起的非公開頁(`/me`、管理頁)只有靜態標題**,沒有各自的預覽;要的話在 `meta.ts` 的 `pageMeta` 加。
- **叫了這回合沒提供的工具,她說「等我一下」就沒下文**:那個工具不在現在的範圍、也不是迴圈裡的工具時,工具沒有執行,她卻已經說了等一下的話(`稍等喔。` 這類),後面沒有任何結果或下一句(`packages/brain/agent/test/tool-scope.test.ts` 的 `refuses a call of a tool that is not offered now` 照現在的樣子寫)。V5 階段 3 做工具迴圈時一起修。

### V4 實作(分支 `v4-int`)留下的

整份見 [v4-plan.md](v4-plan.md) §14 最後。沒上線、沒驗證的事在那裡;這裡只列已知沒做完或有洞的:

- **「不要記住這個」擋不乾淨**:訊息紀錄的編號不是平台的訊息編號,只能靠內容雜湊比對;人物筆記沒有記來源,篩不掉;之後有人引用那則訊息回覆,引用的文字還是會進來。
- **推理外洩的根因沒找到**:外洩的文字是模型直接寫在回覆欄位裡的。剩三種可能,現有紀錄分不出來;下次發生時該查什麼寫在 [v4-patches.md](v4-patches.md) §5。 2026-11-14 補:在現在的端點上,關掉思考的五個請求都乾淨(沒有推理欄位、推理 token 是 0),所以「該關的時候其實還開著」這個可能性變小;沒有重現外洩。
- **事後修正還在**:18 處只收窄 2 處,4 處有開關。等上線後面板上的觸發次數接近零再關。
- **本機向量檢索**:記憶紀錄和筆記本(每一行,2026-11-16,見 [v5-brain.md](v5-brain.md)「筆記的 embedding」)都接上了,背景補向量也做了;執行環境(`@huggingface/transformers`)和選定的模型(Harrier-OSS-v1 270M fp16)沒裝,預設關。開的步驟在範例設定檔的「長期記憶」那段。沒有用真的模型跑過。
- **Minecraft**:打獵要動物剛好在準星上,Java 模組的 `nearby_entities` 要加座標才能直接瞄準(模組沒改);導演在工作車道上的行為沒進過遊戲。
- **沙箱網路白名單**:代理和設定做了,沒在真的 Docker 上跑過(`MIYORIA_LIVE_WORKSPACE_TESTS=1`)。
- **面板的活動表是 API 裡的一份複本**(有測試防它走樣),`packages/heart/mind` 還沒有可讀的服務。
- **網頁現場的角色是另外畫的**,不是她的樣子;她的 Live2D 能不能放上網頁要先確認授權。
- **PR 8 還沒收**:`v4-int` 只挑了它的兩個 CI 修復。它的資料表遷移編號和 `turn.ts` 會和 `v4-int` 衝突。

### V5 階段 1 做的過程中留下的(2026-11-15)

**等階段 1 做完再做(owner 決定)**

- **landing 頁的細節打磨**,不是重新設計:owner 覺得現在的樣子不錯,但有些地方的細節可以更好。動手前先把整頁看過一遍,列出要改的細節給 owner 挑。
- **kcy3f0 的三個 Minecraft PR(#44、#45、#46)**:全部做完之後再看怎麼處理。`v5` 合進 `main` 之後它們會因為資料夾搬動而衝突,要請對方 rebase。草稿 PR #30(自主遊玩的 P0、P1)到階段 7 重新套到新的結構上再接著做;它和那三個 PR 動的是同一塊,到時候先讀完再決定順序。

**上線前要做的**

- voice link 改成契約之後沒有對真的 Discord 測過:進出語音頻道、對話、打斷、唱歌(嘴型)、Go Live、重啟 Core。
- Python worker 的請求模型改成由契約產生之後,沒有跑過真的 worker:各 worker 啟動、唱一首歌、一次 offload 和 reload。
- 這個分支沒有 push 過,CI 一次都沒跑(包括新加的 pnpm 安裝測試和 Python 的產生檢查)。
- 拿線上資料庫的複本演練匯入(`miyoria db doctor`、`db import-links --dry-run`),確認人數和帳號數。
- 主 checkout 裡沒進版控的 `apps/card-studio/vendor/` 要手動搬到 `tools/card-studio/vendor/`。

**小的、還沒做**

- 面板少了兩個「她為什麼沒說話」的原因標籤(`repeat`、`nobody`),現在直接顯示英文。
- 產物庫每天的清理還沒有排程去跑它;對外提供檔案的路由和她的「分享」動作是之後的步驟。
- overlay 的嘴型音量最多接受 16 個頻帶,契約允許 32 個;現在 Core 送的沒有超過。
- 「忘了我」不會去改 LLM 呼叫的 JSONL 檔(那些檔 14 天後過期)。
- 她在一個還沒有人說過話的私訊裡的第一句話,存的時候沒有場所。
- lyrics 服務和 turn worker 的錯誤回應是 FastAPI 預設的格式,和其他 worker 不一樣(測試裡標成已知)。
- `@miyoria/contracts` 依賴 `@orpc/contract`,所以裝 SDK 的擴充作者也會裝到它;之後可以把路由那一部分拆出去或改成 peer 相依。
- 路由搬到 oRPC 之後幾個使用者碰不到的差別:同一個查詢參數重複出現會回 400(以前取最後一個);幾個 `limit` 格式錯誤的訊息文字不同(狀態碼一樣)。
- `miyoria config set` 現在要載入所有模組的設定 schema,打包後的 CLI 量起來約 1.7 到 2.0 秒(`--version` 約 0.9 秒),比改之前多了大約 0.7 秒。要更快的話,可以在打包時先把整份 schema 算好。
- 線上 `miyoria.toml` 的三處修改還沒做(剩下的設定相容層要先改它才能拿掉);`/api/facts/context` 和 `/api/facts/retryable` 擁有者確認沒人在用,兩條路由已經刪掉。

- **第 14 步留下的**(2026-11-16):舊的 store 介面大多還在(呼叫的地方多,跟著各套件重寫再換);五個已經沒人呼叫的方法還掛在介面上(`MessageLog.purge`、`IdentityStore.setPersonName`、`DecisionLog.appendOutcome`、`MemberCardStore.countSince`、`SettingsStore.deletePrefix`);人物卡不再於啟動時替羈絆超過 25 的人種依附(原本是 V4 搬移程式順便做的),階段 4 決定依附從哪來。詳見 [v5-data.md](v5-data.md)。
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
- **只在機器很忙時失敗的測試**:`apps/voice-node` 的 `link.test.ts`(「sends hello… answers ping」)在同時跑很多東西時失敗過一次,單獨跑會過。再出現就改成等條件成立。
- **範例擴充的端對端測試在 CI 被跳過**:它要先 build 才會跑,CI 是先測試;本機的整體檢查會跑。要不要讓 CI 也跑,等決定。

### V5 階段 2(hostd)做的過程中留下的(2026-11-16)

- **voice node 還沒有跟著套件發行**:`miyoria add voice-node` 只能在有 repository 的資料夾裡做。`apps/voice-node/service.toml` 用 `pnpm start`(tsx 從原始碼跑),沒有 repository 的安裝(`npm i -g miyoria`)沒有東西可跑。要先有一個編譯好的進入點,再換掉描述檔的 `command`。
- **`install.manual` 的路徑在套件安裝時會落在套件資料夾裡**:路徑(`workers/models/applio`、`workers/voices/<聲音>/ref.wav` 等)是從目錄根(repository 的根)算起。從 repository 跑時那就是使用者放東西的地方;套件安裝時目錄根是套件資料夾,不是使用者的資料夾。用套件安裝的人要把這些東西放在哪裡,還沒定。(2026-11-18:改成自動下載的 `[[install.files]]` 不受影響,一律放在 `host.toml` 的狀態資料夾 `<state>/models`;手動項目也可以用 `{models}` / `{state}` 開頭的路徑,turn 的兩個已經這樣寫。私人的 `workers/models/applio`、`workers/voices/...` 等還是從目錄根算。)
- **Docker 的檔案還是舊的,也沒有跑過**:`workers/docker-compose.yml`、`workers/asr/Dockerfile`、`workers/tts/Dockerfile` 和 `deploy/` 仍用 `requirements*.txt`(不是 uv 專案)、舊的埠(asr 在 8001),`deploy/docker-compose.yml` 沒有發佈 `7880`,所以 Docker 的 Core 收不到別台電腦的連線。這一輪沒有改它們,也沒有 build 過。
- **Linux 只被 CI 的單元測試跑過**:hostd、安裝和更新在 Linux 上只被 CI 的單元測試跑過,沒有在 Linux 上用真的 worker 跑過;macOS 的登入時自動啟動(`host autostart`)還不支援。
- **voice link 和 stage link 的用戶端沒有改用共用的重連工具**:`packages/hostd/src/link/reconnect.ts` 有退避、看門狗和「哪些關閉碼不該再撥」的規則,註解寫明 voice node 和 Stage 之後可以搬過去(列在 H12)。目前 `apps/voice-node/src/link.ts` 和 Stage 的連線(`packages/stage/src/link/`)還是各寫各的重連。
- **生圖的顯卡讓出還在 Core 裡**:`ImageGenService` 在唱歌事件時自己暫停批次、請 ComfyUI 釋放(`pause_while_singing`、`free_on_sing`),沒有走 hostd 的顯卡仲裁。等生圖模組開放、hostd 的仲裁(`v5-gpu.md`)上線後再搬。
- **有一個中繼測試只在機器很忙時失敗過一次**:`packages/cluster/test/relay.test.ts` 的 `aborts mid-body`(中途中斷時讀的一方失敗、服務看到關閉)在負載高時失敗過一次,之後每次重跑都過。再出現就改成等條件成立,不要加長逾時。
- **MediaMTX 有三個埠,不進登記處**:API(9997)、RTMP(1935)、LL-HLS(8888),voice node 的編碼器用其中一個,所以 `[modules.live.video]` 仍然自己寫位址。hostd 只啟動它和探測行程。`workers/mediamtx/start.ps1` 和 `workers/mediamtx/README.md` 裡講它的部分還沒刪(`v5-hostd.md` §12)。
- **`check_imports` 每個服務只有一份清單**:`doctor --deep` 用服務自己環境的 Python 去 import `service.toml` 的 `check_imports`,那份清單是預設後端的。換了後端(ASR 的 `sensevoice`、TTS 的 `qwen-tts`)後,清單裡的套件(`torch`、`qwen_asr`、`faster_qwen3_tts`)可能不在環境裡,會誤報失敗。要讓清單跟著 extras 走,還沒做。

### V5 階段 2 合併之後還沒做的收尾(2026-11-16)

階段 2 在 2026-11-16 合併(PR #55)。下面是 `v5-hostd.md` 切換清單第三段還沒做的,照建議的順序:

- **登入時自動啟動還沒開**:`miyoria host autostart on` 要 owner 自己執行,再照清單檢查四點(工作是用自己的帳號、沒有視窗、手動觸發能帶起服務、登出再登入後會回來)。這個指令從來沒有在真的 Windows 帳號上註冊過。在那之前,重開機後要手動 `miyoria up`。
- **朋友那台(翻唱)還沒升級**:照 `docs/sing-remote-host.md`。現在它是設定檔裡的靜態登記(`[modules.sing] url`),沒有 token;他那台的歌詞語音辨識抽查會被這台擋下(這台的語音辨識現在要 token)。經控制連線的中繼也因此還沒有被真的另一台電腦用過。
- **hostd 的顯卡仲裁沒有在真的顯卡上跑過**:這台是 `[gpu] arbiter = "worker"`,而且沒有跑翻唱。2026-11-16 修的兩件事(伴唱也轉換時和重新載入的語音搶顯卡、預設策略下無限等)只通過對照表和模擬情境。要測得在這台唱一次歌:owner 明確同意、`host.toml` 設 `[gpu] arbiter = "hostd"`、加上翻唱服務、在語音裡點一首歌。
- **刪除只為了搬遷留著的東西**(另開一個 PR,`v5-hostd.md` §12):`[stack]` 和 `[machine]`、`host migrate`、`stack/roles.ts`、`stack/config.ts`、`workers/mediamtx/start.ps1`。下面兩項要等前面的事:設定裡的位址鍵和它們的靜態登記(等朋友那台升級);唱歌 worker 自己的顯卡判斷、`SING_OFFLOAD_URLS`、`SING_YIELD_URLS`、Core 對 worker 的 `/gpu/context` 推送(等顯卡仲裁實測過)。
- **舊的 Python 環境還在**:`workers/.venv-asr`、`.venv-tts`、`.venv-turn` 是換成 uv 之前的環境,留著當退路;`data/backups/host.toml.old-venvs-20261116` 有換回去要用的那幾行。uv 的環境穩定一陣子之後可以刪。
- **她的聲音少一個檔**:`workers/voices/deepseek-chan/ref.txt`(參考音實際說的內容)不在,語音合成因此用只看音色的模式載入,`doctor` 會提醒。切換前就是這樣。
- **npm 還沒發佈**(owner 2026-11-15:晚點)。

### V5 階段 3 合併之後還沒做的收尾(2026-11-17)

階段 3 在 2026-11-17 合併(PR #56),live 在同一天凌晨切到新的腦:記憶重建跑完(318 段、521 行、230 則情節,約 1.08 美元),本機 embedding(Harrier)在跑,`[modules.agent.initiative] home` 設好了。下面是還沒做的:

- **owner 的實測還沒做完**:語音插話她會不會停、唱歌的報幕(歌等報幕講完)和唱完的回報、`@名字` 是不是真的 tag、`schedule` 到時間會不會來、審核過的工具晚到的結果。這些只有模擬事件的測試,沒有在真的 Discord 和語音上看過。
- **記憶重建丟掉約三成的行**(寫入 521、丟掉 212),9 段因為模型回的格式不能用而放棄。還沒看是哪一類被丟(沒有出處、重複、超過長度),也沒看放棄的段落能不能重試。
- **重建的花費預估差了六倍**(預估 0.17 美元,實際 1.08):`estimateRebuild` 每段只算約 350 個輸出 token,實際約 3,000 到 3,700,因為 `summarizer = "medium"` 的思考也算輸出。預估要把推理等級算進去。
- **搬舊筆記時有 95 筆對不到歸屬**(`notebook and knowledge moved into the notes`:128 份文件、1,023 行、unmapped 95)。沒搬的還在舊表裡,沒有看是什麼。
- **新記憶的 recall 還沒量**:舊的基準是 recall@5 0.80、MRR 0.63(`data/eval/sets/memory.json`)。`pnpm eval --live --suite memory --memory-set <set> --memory-target notes` 還沒跑;「找回不相關」的三個門檻(`[modules.memory.notes_recall]`)是預設值,沒用真實題目調過。
- **「只回受理了就說做好了」沒有完全消掉**:修正評測最後一輪 117 次裡 1 次(`c04-file-receipt`)。
- **修正評測的一個已知誤判**:`c03-alarm-no-tool` 把她對對方說的「你設好了跟我說」當成她宣稱設好了。
- **承諾的預設期限偏急**:沒講時間的承諾 2 分鐘到期,而段落整理要對話停 5 分鐘才跑,所以一記下就過期。超過 24 小時才到期的承諾,Core 重啟後會掉(`CommitmentBook` 只從最近 24 小時的紀錄重建)。她明講不做了的承諾不會關。
- **願望檢查在她自己起頭、沒有 @ 人、房間裡有好幾個人時**,仍然對每個人都檢查,可能誤擋。
- **面板的新頁面沒有在瀏覽器看過**(評測、筆記、回合頁的工具呼叫、提示詞頁);**夜間評測沒有實際跑過**(`[modules.eval]` 預設關)。
- **`share` 的圖片 metadata 沒有清除**(沒有加編碼器依賴)。
- **CLI 用相對路徑匯入 notes**,`packages/cli` 還沒有 `@miyoria/memory` 這個依賴。
- **live 的 `miyoria.toml` 還有不再被讀的鍵**(啟動時的警告列了 `llm.thinking`、`modules.agent.max_tool_steps`、`tool_timeout_ms`、`max_tool_result_chars`;`[llm.reasoning] chat_intent` 也沒有作用了),可以刪。
- **退路的備份**:`data/backups/core-db-before-v5p3-20261117/` 和 `miyoria.toml.before-v5p3-20261117`;`data/backups/core.db.rebuild-dryrun-20261116` 是估花費用的複本,可以刪。

### 設定鍵清理之後留下的(2026-11-16)

舊的主線和舊的工作線被新跑者換掉之後,沒有人讀的設定鍵和服務鍵清掉了(哪些見 [v5-brain.md](v5-brain.md) 「2026-11-16 的檢查」最後一段)。下面是清的時候發現、但不屬於清理的:

- **`PlaceAccessKey` 沒有人提供**:「別的地方」(`elsewhere`)和「剛才」(`just_now`)問它哪些地方她看得到,沒有人提供時每個地方都算看得到。要不要有真正的存取規則,還沒決定;有之前不要把它刪掉,讀它的地方是對的。
- **`ImageGenKey` 沒有工具**:生圖服務有、鍵有人提供,但新跑者沒有生圖的工具,她叫不到。要等生圖開放(見上面「生圖卡池開放」)。
- **遊戲導演還在縮減過的工作線上**:`[modules.agent.work]` 只剩 `enabled`、`daily_tokens`、`result_chars`、`did_lines`、`keep_ended`,只有遊戲導演一步一步做決定時用。要把它搬到小幫手(delegate)的跑者上,才能刪掉整條工作線和這一節設定。
- **mind 的主動開口間隔還在**:`self_start_gap_*` 和 `self_start_max_backoff`(`[modules.mind]`)的帳本 `SelfStarts` 沒有人餵(日誌的 `intent` 和 `intent:` 理由都沒了),所以那幾個鍵沒有作用。要刪就得改 `mind.ts` 和 `selfstart.test.ts`,這次沒有動。
- **`GameControlKey`、`PartyTableKey` 只有測試在讀**:正式程式沒有人用,測試靠它們控制導演和派對。要刪就得先換測試的做法。
- **舊的 `KnowledgeStore` 在 `learning` 模組裡還會載入和寫回**:沒有資料庫時(測試用的空架子)它是整個知識庫,有資料庫時只有匯入工具會讀。要拿掉就得先決定沒有資料庫的情況怎麼辦。
- **`agent.initiative` 事件沒有人發**:agent 和 facts 還訂閱它,事件的 schema 在 SDK 和面板的型別裡,SDK 的相容性測試也列著它。要拿掉是改公開的事件合約,另外決定。
- **`[llm.reasoning]` 的 `chat_voice` 和 `work` 沒有作用**:語音這一輪和小幫手都在 profile 裡固定了推理等級,不看這兩個鍵。範例檔已經這樣註明,鍵本身留著。
- **移除 `[llm.thinking]` 的行為差異**:舊設定檔裡有 `[llm.thinking]` 的,現在那些用途改用 `[llm.reasoning]` 或預設值(例如 `mind = true` 以前等於 `medium`,現在是沒列的用途 = 不思考)。啟動時會警告,但要不要在 `[llm.reasoning]` 補上,要 owner 看自己的設定檔。


### V5 階段 4 第 4、5 步留下的(2026-11-17)

- **`task_together` 證據沒有人寫**:任務、懸賞完成時沒有記;Minecraft 沒有玩家名單,也沒記 `played_together`。
- **V4 的分級對照表還是手抄的**(`store` 的切換程式):V4 切換拿掉時一起刪,或改成從 `BOND_TIERS` 產生。
- **`tools/replay` 的 `announcements-not-her-topics.jsonl` 還帶著 `plans`**:Plan 刪了以後腳本不讀它,留著不影響結果;下次重錄時拿掉。
- **self 裡「暗戀」的名字還在**(`crushPerson`、`crush_spoke`、`crush_message_longing` 這些):讀的已經是 heart 算的「最在意的人」(H5),只是名字沒改;設定鍵要改名得一起改 `removed-config.ts` 和範例檔。
- **`relationships`、`relationship_deltas`、`self:feeling:*`、`self:state` 沒人寫了**,只有搬移讀;等 v5-data §8 第 14 步刪表。

### V5 階段 4 稽核之後留下的(2026-11-17)

- **多個 profile 共用 `heart_person`**(稽核 M10):表沒有 profile 欄,同一個資料庫開兩個角色時她們對人的數值是同一份;要分開得加欄位和搬移,等 Space / 角色分開(階段 6)時一起做。
- **稽核 M18 的既有競態**:階段 4 之前就有,這一輪沒有修;細節在稽核報告裡,修的時候先寫一個會失敗的測試。
- **合併兩個人時事件不改名下**:`heart.changed`、`heart.evidence` 是只能附加的,被併的人的事件留在原來的 id 下,留下的人的變動紀錄和當天的上限看不到它們(列已經合成一列)。要看得到得讓讀的一方把 `absorbedInto` 的 id 一起查。
- **「忘記我」沒清舊的 `self:feeling:<person>` 卡片**:搬移讀完就沒人讀,v5-data §8 第 14 步刪表時一起刪;在那之前它們還留著她以前寫的感覺。

## 4. 自我修復與自我改進(備忘)

三層,越下面風險越高:

1. **自我修復**:同一件事用同一種方式失敗三次就換方法或說出來。
2. **自我改進**:她提出的改動(教訓、技能、設定)先跑事故評測,分數變好、沒有退步才留下;提示詞和人設要 owner 在面板看過。
3. **改程式碼**:只由她自己的失敗紀錄觸發,在沙箱寫修正、跑測試和評測、開 PR,由 owner merge;絕不直接改正在跑的 Core。

前提是評測要可靠(已有 `tools/eval` 的事故題庫),第 3 層要先有 Docker 沙箱。
