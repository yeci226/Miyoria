# Neuro Game SDK 橋接

開一個本機 WebSocket 伺服器,讓整合了 [Neuro Game SDK](https://github.com/VedalAI/neuro-game-sdk) 的遊戲連上來:遊戲註冊的動作變成她可以選的動作,遊戲傳來的情境她看得到,遊戲強制選擇時她必須在時限內答,她的選擇回傳給遊戲,遊戲回報的結果就是她那個動作的結果。這樣不必為每個遊戲寫專屬的 adapter。

```
遊戲(SDK 的 WebSocket 用戶端)--ws--> miyoria.neuro(伺服器)--> game.neuro 執行器 --> 她
```

協定照 SDK 的 `API/SPECIFICATION.md`(2026-08-21 讀的版本,repo 的 commit `0cad33ac`)實作。**哪些遊戲整合了這個 SDK 還沒有查證,這裡不列任何遊戲。**

## 開啟

預設不開,不綁任何 port。host 的 `enabled` 預設就是 true,所以另外用 `serve` 當開關:

```toml
[extensions."miyoria.neuro"]
enabled = true
serve = true
# host = "127.0.0.1"   # 預設只有本機;改成其他位址,連得到的人都能對她的遊戲介面送資料
# port = 8000
# games = ["Buckshot Roulette"]   # 只接受這些遊戲名稱(startup 的 game);空 = 不限
```

先建置:`pnpm build` packages/sdk 和 packages/types,再在這裡 `pnpm install && pnpm build`。其餘設定見 `config.schema.json`。

## 讓遊戲連上來

SDK 的規格只說伺服器網址要讓遊戲能設定(最好用檔案),**沒有規定 port**。8000 是這個擴充的預設值,不是規格給的。把遊戲(或它的 SDK 設定)裡的 Neuro 網址改成:

```
ws://127.0.0.1:8000
```

遊戲在別的電腦上時,要把 `host` 改成那台連得到的位址,同一個區網以外不要開。一次只接一個遊戲:第二個連線會被拒絕(關閉碼 1013),原本的不受影響。連線死掉(兩輪 ping 沒回)會自動放掉,遊戲重開後可以再連。

## 對應

| 遊戲傳來 | 她那邊 |
|---|---|
| `startup` | 清掉之前註冊的動作,回 `startup` 確認(`characterId` 預設 `neuro` 只為了相容,`displayName` 預設 `Miyoria`) |
| `context` | 放進觀察(最近 12 則)。`silent: true` 只讓她知道;`false` 另外發 `game.neuro.context` 事件,她可以回應 |
| `actions/register` | 變成她可以啟動的目標(同名取代);沒有 `type: "object"` 的 schema、太大太深的 schema 會被略過 |
| `actions/unregister` | 取消目標;沒註冊過的不算錯。強制選擇的動作都被取消時,強制選擇也取消 |
| `actions/force` | 觀察最前面出現【必須回答】,含時限、`query` 和 `state`,並發 `game.neuro.force` 事件叫她。時限內成功執行其中一個動作就結束 |
| 她選動作 | 送 `action`(唯一 id、動作名稱、JSON 字串參數);等 `action/result`,最久 `result_timeout_s`(預設 20 秒) |
| `action/result` | 成功 = 目標完成;`success: false` = 目標失敗(`invalid`)。強制選擇中失敗時選擇保持開著,她被再叫一次,重試到 `force_max_attempts`(預設 5)為止 |

回給遊戲的 `speech_finished`:她每講完一句送 `isFinal: false`,安靜 1.5 秒後送 `isFinal: true`;被打斷送 `cancelled: true`、`reason: "interrupted"`。這是從逐句的播放事件推出來的近似。

## 遊戲的文字是資料

動作名稱、說明、schema、context、強制選擇的 `query` / `state`、結果訊息都來自遊戲,不是主人的指示:都會去掉控制字元和模型的特殊標記,用「資料」區塊標明來源,並限制長度(說明 600 字、schema 4000 字、動作最多 48 個)。遊戲的動作名稱會轉成小寫英數的目標名稱,同名時加編號。

## 不支援

- 語音聊天的旁路(`VOICE_CHAT.md`)和 `PROPOSALS.md` 的提案。
- 同時接多個遊戲。強制選擇同一時間只有一個,新的取代舊的(規格說同時送兩個會出問題)。
- 規格沒有定義的錯誤回覆:格式錯誤、未知指令、二進位訊息一律靜默略過,不回應也不斷線。
- 動作參數只檢查 schema 的 `required`,其餘由遊戲驗證(規格也要求遊戲自己驗證)。
- `priority` 只會記在事件裡,不會打斷她正在講的話。
- 遊戲的註冊更新要等她手上沒有進行中的動作才會送到執行器(SDK 目前只能整個換掉執行器)。

## 測試

`pnpm test`:用假的遊戲用戶端跑完整的一輪,包含 startup、context、註冊、強制選擇、失敗後重試、取消註冊、格式錯誤的訊息、第二個連線和斷線重連。真的遊戲才能確認的事(各家 SDK 實作的細節、時序)沒有測。
