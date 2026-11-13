# 生圖模塊(imagegen)

模組 `imagegen`(`packages/imagegen`)連 ComfyUI 的 HTTP API 生圖,提供服務 `ImageGen`(`ImageGenKey`,型別在 `@miyoria/types` 的 `imagegen.ts`)給她的其他系統用。**沒有指令、沒有工具,成員叫不到它。** 第一個使用者會是抽卡(之後再做),所以佇列、每日上限、批次時段都是為大量背景生圖設計的。

預設關閉:`[modules.imagegen] enabled = true` 才會啟動(和 `sandbox` 一樣是 opt-in)。設定範例在 `miyoria.example.toml`。

## 1. 流程

```
其他模組 ── ImageGen.submit(request, { purpose, priority, key }) ──> 檢查、補預設、存成 jobs/<id>.json (queued)
                                                                      │
                     runner(一次一個;interactive 先於 batch,同級 FIFO)
                                                                      │  唱歌/準備唱歌、batch 不在 batch_hours、ComfyUI 連不上 → 等
                                                                      ▼
   內建模型:檢查檔案(GET /models)→ buildModelGraph       workflow:fillWorkflow + 上傳起始圖
                                                                      ▼
                          POST /prompt(自己給 prompt_id)→ 輪詢 /history,WebSocket 只拿進度
                                                                      ▼
            GET /view 下載 → <output_dir>/<YYYY-MM>/<purpose>/<job>-<n>.png + <job>.json(請求、graph、檔名)
                                                                      ▼
                                       ImageJob succeeded,事件 `imagegen.job` 發到 bus
```

每次狀態變化都發 `imagegen.job` 事件(`ImageJobEvent`),等結果可以用 `wait(id)` 或訂閱事件。

## 2. 請求

`ImageRequestInput`:`model` 或 `workflow` 二選一(都沒給就用 `default_model`),加上 `prompt`、`negative`、`width`、`height`、`seed`、`steps`、`cfg`、`sampler`、`scheduler`、`batch`、`loras`、`init_image`(以圖生圖)、`denoise`、`params`(workflow 的自訂參數)。

- 沒給的取模型 variant 的預設;尺寸對齊模型的倍數並夾在上下限內;沒給 seed 就隨機,實際用的值都寫回 job,同一個 request 可以重現。
- `init_image` 只能是 `input_dir` 裡的檔案(或 ComfyUI input 裡已有的檔名),不讀任意路徑。
- `purpose` 是小寫 slug,決定輸出資料夾和每日上限(`daily_limits`)。`key` 是冪等鍵:同 purpose 同 key 回傳已有的 job,不會重生。
- 錯誤用 `ImageGenError`(狀態碼 400 / 404 / 409 / 429 / 503)。

## 3. 內建模型

節點和預設值都照 ComfyUI 官方 workflow 模板(`Comfy-Org/workflow_templates`)。共用一個 graph 形狀:loaders → LoRA 鏈 →(MOSS:SLG)→ 正/負 prompt → 空 latent 或起始圖 VAEEncode → KSampler → VAEDecode → SaveImage。

| id | variants | text encoder(`CLIPLoader` type) | 預設 | 備註 |
| --- | --- | --- | --- | --- |
| `krea2` | `turbo`(預設)、`raw` | qwen3vl_4b(`krea2`) | turbo 8 步 cfg 1;raw 52 步 cfg 3.5 | 沒有負向 prompt(負向是 `ConditioningZeroOut`);RAW 的檔名是猜的,要在設定改成實際檔名 |
| `moss_image` | `sft`(預設)、`base` | qwen3.5_9b(`moss_image`) | sft 25 步 cfg 2.5 er_sde;base 50 步 cfg 3 | `EmptyFlux2LatentImage`,邊長 16 的倍數;`slg = true` 開 skip-layer guidance |
| `anima` | `base`(預設)、`turbo` | qwen_3_06b(`stable_diffusion`) | base 30 步 cfg 4;turbo 是 LoRA,8 步 cfg 1 | 動漫;有預設負向;授權非商用(生成的圖可商用) |

每個模型的檔名、variant、尺寸、預設負向、`prompt_prefix` 都能在 `[modules.imagegen.models.<id>]` 改;`enabled = false` 關掉一個。`models()` 回傳每個模型的 `prompt_hint`,給之後寫 prompt 的程式參考。

## 4. Workflow 檔

在 ComfyUI 編輯器做好 graph,用「Export (API)」存成 `<workflows_dir>/<id>.json`。程式只填宣告的參數,不動其他節點,所以換模型、加 upscaler、ControlNet 都在編輯器裡做。

- 裸的 API export:依慣例找參數(標題含 positive 的 `CLIPTextEncode` 是 `prompt`、negative 是 `negative`、第一個 KSampler 的 seed/steps/cfg/sampler/scheduler/denoise、第一個空 latent 的 width/height/batch、第一個 `LoadImage` 是 `image`)。
- 包一層 `{ "description", "params": { "<name>": { "node" | "targets", "input", "type", "default", "required", "min", "max", "options" } }, "outputs", "graph" }` 可以自己宣告參數。`node` 用節點 id 或標題。型別:`string`、`int`、`float`、`bool`、`seed`、`image`(會先上傳)、`enum`。
- 編輯器格式(有 `nodes` 陣列)會被拒絕並提示改用 Export (API)。綁定在讀檔時就檢查,壞檔不會等到跑才失敗。

## 5. GPU 和唱歌

她唱歌(`sing.cue`)或準備唱歌(`sing.prepare`)時,`pause_while_singing` 讓新工作等著;正在跑的 batch 工作會被 `/interrupt` 中斷並重新排隊(不算一次嘗試),`free_on_sing` 叫 ComfyUI 卸載模型。閒置 `free_after_idle_s` 秒也會卸載。`batch_hours` 讓 batch 工作只在指定時段跑(例如半夜)。

## 6. 可靠性

- 每個 job 一個 JSON(先寫暫存檔再 rename,同一個 job 的寫入排隊),重啟時 running 的改回 queued;已經送出的會先查 `/history` 和 `/queue`,還在的就接著等,不重送。
- ComfyUI 連不上:退避重試(10 秒 × 次數),最多 `max_attempts` 次。graph 被拒(400 node_errors)或執行錯誤不重試,錯誤訊息寫進 job。
- 超過 `timeout_s` 中斷並失敗。`keep_days` 清掉舊 job 和圖。
- 模組健康檢查:ComfyUI 不回應時是 degraded。

## 7. 之後

- 抽卡接上:卡面 prompt 由她(或規則)寫,`purpose = "gacha"`,`key` 用卡片 id。
- 角色一致性:她的 LoRA(`loras`)或參考圖 workflow。
- 多台 ComfyUI、優先度更細的排程。
