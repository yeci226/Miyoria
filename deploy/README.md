# deploy

Docker 部署:Core 容器(Node 24,內含管理面板),資料存在容器 volume 裡的 SQLite。完整的部署、升級、備份流程見 [docs/OPERATIONS.md](../docs/OPERATIONS.md)。

> 不用 Docker 也能跑:`pnpm dlx miyoria@latest init` → `pnpm dlx miyoria core`,資料預設存在 SQLite(`data/miyoria.db`),不需要另外裝資料庫。

| 檔案 | 用途 |
|---|---|
| `docker-compose.yml` | `core` 服務 |
| `Dockerfile.core` | Core 映像檔:多階段(pnpm install → build 面板與 `miyoria` 套件 → `pnpm deploy`),非 root、`/data` volume、healthcheck |
| `miyoria.docker.toml` | Core 容器用的設定(內建一份,compose 也會掛進去) |
| `.env.example` | compose 變數(埠、映像檔、設定檔,都是可選的),複製成 `deploy/.env` |
| `speech/` | 語音辨識 / 合成放在 Linux server 的 compose,見 [speech/README.md](speech/README.md) |

build 時排除的檔案(`.env`、`node_modules`、`dist`、`legacy`、`spikes`、`data`、授權不能散佈的模型檔……)在根目錄的 [`.dockerignore`](../.dockerignore)。

## Core 也放進 Docker(server 部署)

```sh
cp deploy/.env.example deploy/.env   # 可選:改埠、映像檔、設定檔
pnpm dlx miyoria init                     # 在專案根目錄產生 .env(LLM key、Discord token、各種 token)
docker compose -f deploy/docker-compose.yml up -d --build
docker compose -f deploy/docker-compose.yml ps      # core 要變成 healthy
docker compose -f deploy/docker-compose.yml logs -f core
```

- 兩個 `.env`:`deploy/.env` 給 compose(埠、映像檔),根目錄 `.env` 給 Miyoria(秘密)。容器內的 `DATABASE_URL` 由 compose 設成 `sqlite:/data/miyoria.db`(存在 `core-data` volume);要換路徑就在 `deploy/.env` 設 `CORE_DATABASE_URL`。
- **綁定位址**:容器裡的 Admin API、voice link、stage link 一定要綁 `0.0.0.0`(`miyoria.docker.toml` 已經這樣設);綁 `127.0.0.1` 的話 Docker 的埠映射連不進去。給宿主機用的 `miyoria.toml`(綁 `127.0.0.1`)不要直接掛進容器;要自訂就複製 `miyoria.docker.toml`,保留三個 `bind`,在 `deploy/.env` 設 `MIYORIA_CONFIG_FILE`。
- 宿主機端的埠一律只綁 `127.0.0.1`:`7878` Admin API / 管理面板、`7879` voice link、`7882` stage link。別台機器要連,走 Tailscale / SSH tunnel / wss 反向代理(見 OPERATIONS §9),不要把 compose 的 `ports:` 改成 `0.0.0.0`。
- 管理面板已經在映像檔裡(`MIYORIA_PANEL_DIR=/opt/miyoria/dist/panel`),開 http://127.0.0.1:7878/ 就是。
- `profiles/` 以讀寫掛載到 `/profiles`(映像檔也內建一份預設角色);`core-data` volume 掛在 `/data`(SQLite、擴充套件 `/data/extensions`)。
- 單獨 build / 跑映像檔(在專案根目錄):

  ```sh
  docker build -f deploy/Dockerfile.core -t miyoria-core .
  docker run --rm --env-file .env -e DATABASE_URL=sqlite:/data/miyoria.db     -p 127.0.0.1:7878:7878 -v miyoria-data:/data miyoria-core          # 用 SQLite 跑 core
  docker run --rm --env-file .env -e DATABASE_URL=sqlite:/data/miyoria.db     -v miyoria-data:/data miyoria-core doctor                          # 其他子指令
  ```

  `ENTRYPOINT` 已經帶 `--config /etc/miyoria/miyoria.toml`,後面接的是 `miyoria` 的子指令(預設 `core`)。`-e DATABASE_URL=...` 是因為 `.env` 裡給宿主機用的 `sqlite:data/miyoria.db` 在容器裡會變成相對於設定檔的資料夾(`/etc/miyoria`,容器使用者寫不進去)。
- 容器內的 ASR / TTS 預設連 `host.docker.internal:8001/8002`;在根目錄 `.env` 設 `ASR_URL` / `TTS_URL` 可改。
- `docker stop` 送 SIGTERM,Core 會正常關機(`stop_grace_period: 30s`)。

## DATABASE_URL(Core 在宿主機時)

預設 `sqlite:data/miyoria.db`(相對於 `miyoria.toml` 的資料夾)。只支援 SQLite:`postgres://` 之類的網址會讓 Core 啟動失敗。

不想保存資料(測試)時可以用 `DATABASE_URL=memory://`,重啟就沒了。

## 備份

停掉 Core 複製 `data/`,或 `sqlite3 data/miyoria.db ".backup <檔案>"`。見 [OPERATIONS §7](../docs/OPERATIONS.md#7-備份與還原)。
