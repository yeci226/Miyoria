# 暫緩與待決定清單

統一記錄 owner 說「暫緩」「先記錄」的事、還沒做決定的問題和已知但還沒修的問題。新的暫緩項目加在這裡;詳細內容在各自的文件,這裡只放一行和連結。最後整理:2026-11-10。

## 暫緩的功能

| 項目 | 狀態 | 詳細 |
|---|---|---|
| Minecraft 幾乎不能玩(任務迴圈、技能庫、狀態快照、食物動作、生存反射) | 調查做一半暫停,原因還沒對照程式碼確認 | [minecraft-findings.md](minecraft-findings.md) |
| 自我修復、自我改進(失敗後換方法、改動要過評測才留下、在沙箱寫修正開 PR) | owner 說先不做;沙箱要先有 Docker | 本文件 §4 |
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

三個角色(直播機、Bot 服務機、GPU 推論機)分到不同電腦時,`miyoria init / install / start / doctor` 已經能設定、啟動和檢查,但下面這些還不行或還沒決定:

- **歌曲影片是本機路徑**:Core 把唱歌的影片當成檔案路徑交給 stage(`packages/sing/src/player.ts` 的 `songVideoPath`),路徑是推論機上的;stage 在直播機時開不到檔案。要傳檔案、掛網路磁碟或改成 stage 從 worker 的 `/songs/{id}/files/video.mp4` 下載。
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

## 等 owner 決定

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

## 已知但還沒修

- **主人規則沒寫進去**(2026-11-10 加了保險):回合裡有人明說「不要玩 <她有的遊戲>」而她這回合沒自己呼叫 `directive_add` 時,回合結束前用說這句話的人的身分替她寫一條 deny(`packages/agent/src/prohibition.ts`、`turn.ts` 的 `keepRules`;規則服務照樣判斷這個人能不能立規則;「先 / 今天」是 6 小時)。只認得 Minecraft、osu 和幾個別名;事故評測 `mc-owner-rule-never-written` 要重新錄才會翻成通過。
- **她把自己的盤算講出來**(2026-11-10 先用規則擋):送出前把「第三人稱講對方 + 對自己下指令」的那一行拿掉(`packages/agent/src/leak.ts` 的 `isSelfTalk`,只拿掉那行、其他照送,有「你」的不算)。還沒做事故評測題、也還沒看真實頻率;規則抓不到的說法要再補。
- **抓被回覆的訊息為什麼會失敗**:2026-11-08 14:19、14:22 兩次回覆都沒帶到被回覆的那句。已改成先用 Discord 隨回覆送來的引用內容、抓到再換成完整的,失敗會記 `could not fetch reply parents` 警告;原本為什麼抓不到(逾時、權限或 Discord 錯誤)還沒查,重啟後看警告。
  - 2026-11-10:找到一個會讓它抓不到的情況並修掉:被回覆的是她自己的卡片(斜線指令的回覆、收據,Components V2、`content` 是空的)時,以前算「沒內容」直接丟掉;現在讀卡片上的文字(`componentsText`),指令回覆也算可以回覆的訊息。抓取失敗改記 warning(`cannot fetch the replied-to message`,帶頻道和錯誤),拿到但沒內容記 info 和訊息類型。14:19 那兩次是不是這個原因還沒對照。
- **回覆時附上同一個人早先貼的圖**:14:22 她把對方之前貼的截圖當成答案。看圖的範圍要不要限制在被回覆的那則和這則本身,待查。
- **主線提示詞的「新東西別說不存在」只有一句短的**:主線固定提示詞已貼著 4000 token 的上限(`prompt-budget` 測試),完整版(產品、版本、事件、日期)只在 V2 規則裡。要放完整版得先騰出空間。
- `sing.play` 帶 `song: 0` 會被拒絕。
- 做歌期間 TTS 回 503。
- 語音視窗跑到 92.5 秒,超過 90 秒的上限。
- 網頁的直播卡「OBS 推流」只控制 OBS。
- 經濟系統的 Postgres 版本沒測過(這台是 SQLite)。
- Discord 指令拿不到互動 ID,錢包操作防不了網路重送造成的重複扣款(面板有防)。
- 事故評測還有 12 題標成已知失敗,修好、重新錄製後才會翻成通過:`pnpm eval`。
- **經濟 §13 還沒做或沒驗證的**(2026-11-08):
  - 募資達標只會告訴她「你答應過要…」,沒有寫進她的承諾簿:`CommitmentBook` 在 agent 套件裡,沒有對外的 service key。
  - Discord 抽不了籤詩,也沒有抽卡、重抽、指定立繪、閃卡;這些只有面板能用。籤詩要用 LLM,寫在 API 套件裡。
  - 已經聽得到的歌被中途跳過,點歌券和獻詞的錢不退;要不要改成「沒唱完就退」等 owner 決定。
  - 面板新區塊(閃卡、籤詩、目標、懸賞、轉帳、排行榜)只跑了測試,還沒在瀏覽器裡實際看過;overlay 留言卡看過了。
  - 新表(0013、0014)的 Postgres 版本沒測過。
- **檔案附件沒在真的 Docker 跑過**:這台的 Docker 沒開,所以她現在會婉拒所有非圖片檔(zip 本來就不支援);容器裡的寫入權限、刪檔、`python:3.12-slim` 的實際行為沒驗證。
- **好感等級的「相處方式」還沒看過她實際寫什麼**:要等她下一次反省;面板的 `PersonCard` 型別沒加 `level` / `stance`(面板不顯示,API 有帶)。
- **她會把整串 context key 當頻道 ID**:語音加入已修(`d0f5eac`);其他吃頻道 ID 的工具還沒檢查會不會一樣。
- **Core 記錄裡反覆出現的錯誤**:對話摘要 `notes` 超過 2500 字被拒(`fold failed`)、每日反省 `insights` / `lessons` 超過上限(`reflection failed`)、`accept_food` 沒有人跟她說話時被擋(`she claimed without doing`)。
- **歌詞:QQ 音樂沒接、簡繁 / 羅馬拼音只靠 LLM**:現在的來源是 lrclib 和網易雲(非官方介面,可能被擋或改版);沒做 QQ 音樂(要簽章)、也沒本地的簡繁轉換(OpenCC)和日文假名 / 羅馬拼音互轉,這些只靠 LLM 給的別名。LLM 不認得的歌(同人曲、很冷門的原創)還是找不到。
- **歌詞整段偏移**(2026-11-10 處理):同步歌詞拿去跟主唱 / 人聲軌比對「什麼時候在唱」和「每句什麼時候開始」,整段差超過 0.5 秒且明顯比不移好時整段移過去(±45 秒內,`workers/sing/lyrics_align.py`,meta 的 `lyrics.offset_s`)。只在合成的測試音訊驗證過,還沒拿真的歌試;每句各自不準(不是整段偏)的情況不處理。
- **歌詞 ASR 抽查的門檻只用兩首實測**:正確歌詞 1.00、別首歌 0.28,門檻 0.35 / 0.6 是照這個抓的;日文漢字和 ASR 輸出的寫法不同時可能誤拒,等累積更多歌再調。
- **MelBand karaoke 模型的原始授權**沒確認。
- **becruily BS-RoFormer karaoke 的授權**:HF 上沒標(`becruily/bs-roformer-karaoke`);現在是唱歌預設的主唱模型,只在本機跑、沒散布。
- **「伴唱也轉」(`backing=convert`)**沒實測:伴唱常是好幾個聲音疊在一起,RVC 的 RMVPE 只抓一條音高,可能轉得很怪。
- **推理外洩的源頭沒查實**:2026-11-09 15:29 她在一回合(`reasoning` off、4.9 秒、23 則)把整段思考當回覆一行一行發出去。DB 的訊息和 `turn_outcomes` 看得出推理在 content 裡(provider 已把 `reasoning_content` 分開,不是它併進來的),但 LLM 呼叫的原始回應只存在 Core 記憶體,查不到;最可能是 opencode 上的 `deepseek-v4.1-flash` 收了 `thinking: disabled` 卻仍把思考寫在 content。已加的是送出前的防線(`packages/agent/src/leak.ts`)和提示詞一行;要根治得在 Core 重啟後的面板呼叫檢視器看原始回應,再決定是換模型、改 `thinking_off`,還是讓 `chat_text` 開 `low`。防線擋不住不含「情緒標記 / 回覆要短 / 可以說:」這類字眼的純驗算自言自語(要兩行以上才算外洩)。
- **連結預覽的圖沒用 Geist 字型**:resvg 吃不了 woff2,預覽圖用系統的中文字型(Windows 微軟正黑體),和面板上的卡字型略有差;要一致得把 Geist 的 ttf 放進 repo。另外 Discord 對同一個圖片網址的快取時間沒實測:網址帶 `?v=` 版本,卡變了網址就變,但已經貼出去的舊訊息可能還是舊圖。
- **Core 從 `/` 起的非公開頁(`/me`、管理頁)只有靜態標題**,沒有各自的預覽;要的話在 `meta.ts` 的 `pageMeta` 加。

### V4 實作(分支 `v4-int`)留下的

整份見 [v4-plan.md](v4-plan.md) §14 最後。沒上線、沒驗證的事在那裡;這裡只列已知沒做完或有洞的:

- **「不要記住這個」擋不乾淨**:訊息紀錄的編號不是平台的訊息編號,只能靠內容雜湊比對;人物筆記沒有記來源,篩不掉;之後有人引用那則訊息回覆,引用的文字還是會進來。
- **推理外洩的根因沒找到**:外洩的文字是模型直接寫在回覆欄位裡的。剩三種可能,現有紀錄分不出來;下次發生時該查什麼寫在 [v4-patches.md](v4-patches.md) §5。
- **事後修正還在**:18 處只收窄 2 處,4 處有開關。等上線後面板上的觸發次數接近零再關。
- **本機向量檢索**:介面和背景補向量的工作做了,套件和模型(約 120 MB)沒裝,預設關。
- **Minecraft**:打獵要動物剛好在準星上,Java 模組的 `nearby_entities` 要加座標才能直接瞄準(模組沒改);導演在工作車道上的行為沒進過遊戲。
- **沙箱網路白名單**:代理和設定做了,沒在真的 Docker 上跑過(`MIYORIA_LIVE_WORKSPACE_TESTS=1`)。
- **經濟 2.0 的 Postgres 那一半**沒有資料庫可測。
- **面板的活動表是 API 裡的一份複本**(有測試防它走樣),`packages/mind` 還沒有可讀的服務。
- **網頁現場的角色是另外畫的**,不是她的樣子;她的 Live2D 能不能放上網頁要先確認授權。
- **PR 8 還沒收**:`v4-int` 只挑了它的兩個 CI 修復。它的資料表遷移編號和 `turn.ts` 會和 `v4-int` 衝突。

## 4. 自我修復與自我改進(備忘)

三層,越下面風險越高:

1. **自我修復**:同一件事用同一種方式失敗三次就換方法或說出來。
2. **自我改進**:她提出的改動(教訓、技能、設定)先跑事故評測,分數變好、沒有退步才留下;提示詞和人設要 owner 在面板看過。
3. **改程式碼**:只由她自己的失敗紀錄觸發,在沙箱寫修正、跑測試和評測、開 PR,由 owner merge;絕不直接改正在跑的 Core。

前提是評測要可靠(已有 `packages/eval` 的事故題庫),第 3 層要先有 Docker 沙箱。
