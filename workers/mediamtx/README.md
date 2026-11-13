# MediaMTX:OBS 和觀眾之間的中轉

OBS 推一路 RTMP 給 MediaMTX,Discord Go Live(voice node 拉 RTMP)和網頁現場(Core 轉 LL-HLS)都從這裡拿。設計見 `docs/design/v4-plan.md` §9.2 第 4 項。

```
OBS ──RTMP──▶ 127.0.0.1:1935/live/miyoria ─┬─▶ voice node(golive_listen = false,拉流)
                                           └─▶ LL-HLS 127.0.0.1:8888 ─▶ Core /api/public/live/video/ ─▶ /watch
```

全部只綁 127.0.0.1;外面只能經過 Core 拿到影像,Core 決定開不開。

## 安裝

`mediamtx.exe` 不進 git。從 <https://github.com/bluenviron/mediamtx/releases> 下載 `mediamtx_v1.21.3_windows_amd64.zip`(用同一頁的 `checksums.sha256` 核對),把 `mediamtx.exe` 放在這個資料夾。

## 啟動

```powershell
& workers\mediamtx\start.ps1
```

它從 repo 的 `.env` 讀 `MIYORIA_HLS_SECRET`,當成 `MTX_HLSCDNSECRET` 交給 MediaMTX。

`MTX_HLSCDNSECRET` 要跟 Core 的 `MIYORIA_HLS_SECRET` 一樣。沒設的話 MediaMTX 的 HLS 會要 cookie,Core 代理拿不到播放清單。

檢查:`curl http://127.0.0.1:9997/v3/paths/get/live%2Fmiyoria` 在 OBS 推流時回 `"ready":true`。

## OBS

伺服器 `rtmp://127.0.0.1:1935/live`、金鑰 `miyoria`,跟以前一樣。關鍵影格間隔設 1 秒(輸出 → 串流 → 關鍵影格間隔),LL-HLS 的片段才會短。

## 從舊接法切過來

舊接法是 voice node 的 ffmpeg 自己聽 :1935,所以兩個不能同時跑。她直播中不要切。

1. 關掉 Go Live 和 OBS 推流。
2. 啟動 MediaMTX(上面)。
3. `miyoria.toml`:
   ```toml
   [modules.voice]
   golive_listen = false        # Go Live 從 MediaMTX 拉,不再自己聽 :1935

   [modules.activity]
   obs_hub = true               # 先開 OBS 再開 Go Live;關 Go Live 不關 OBS(網頁還在看)

   [modules.live]
   pats = true

   [modules.live.video]
   enabled = true
   secret = "${MIYORIA_HLS_SECRET}"
   # head / face / body:她在畫面上的位置(0..1 的 [x0, y0, x1, y1]),點到哪裡算摸頭、戳臉、碰身體;
   # 預設值是估的,照 OBS 裡她的位置改
   ```
4. 重開 Core 和 voice node,重新 build 面板和 overlay。
5. OBS 開始推流:網頁 `/watch` 出現畫面(`/live` 是管理面板的直播頁)。之後要 Discord Go Live 照舊用 `/voice golive start`。

## 頻寬

每個網頁觀眾都從 Core 拿一份完整位元率。片段經 MediaMTX 的 CDN 模式回 `Cache-Control: public`,Cloudflare 的邊緣會快取 `.mp4` 片段,同時看的人多時省上傳;播放清單不快取。人真的多了換 Cloudflare Stream(§9.2)。
