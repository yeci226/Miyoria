# Miyoria panel: design system

Operate-mode admin UI, dark only, in the direction the owner approved on 2026-11-07
(`docs/design/v3-architecture.md` §17): a restrained operating tool of see-through dark glass over
a real picture, layered by surface weight. The owner glances at it beside Discord, OBS and a
terminal on a streaming desk at night. Reference points are the AIRI site and Vercel Geist.

The panel stays detailed on purpose: every page leads with state, then trends drawn as charts,
then the controls that change them, and anything that has detail (an LLM call, a thought) opens in
full with nothing left out.

Tokens: `src/index.css` (`:root` variables + Tailwind v4 `@theme inline`). Appearance store:
`src/app/appearance.ts`. Primitives: `src/components/ui/*` (shadcn, Radix per component). App
components: `src/components/*`. Charts: `src/components/charts/*` (hand-drawn SVG, no chart
library). Chart blocks over the Core's telemetry: `src/components/trends.tsx`.

The same app is also the public site (`src/pages/public/`), for people without panel access. See
"Public site" below; everything here applies to it unless that section says otherwise.

## Rules the owner set

- No subtitle or description under page or section titles. A title, then the data.
- Empty states are one plain line ("佇列是空的"), no jokes, no advice paragraphs.
- No "原因:" / "來源:" prefixes; a column header says what the cell is.
- Every control does something the Core can do; nothing planned, nothing dead. Live controls
  go through the Core's actuator gate as the panel (principal `panel`), never around it.
- Never invented data. A feature waiting on backend work stays out of the panel.
- Rejected, not to return: oversized headings, big-number tiles, soft-shadow rounded cards,
  floating panels, glow, gradient text, more than two accents, a kicker above a heading.

## Surfaces

Depth comes from how heavy a surface is, back to front. There are no floating panels in the
page: the frame and the content are flush with the window and with each other.

| Layer | Class | Default | Holds |
|---|---|---|---|
| Picture | `.backdrop` | `brightness(.66)`, blur 0 | The chosen background, fixed behind everything. Only 總覽 leaves an opening onto it |
| Content | `.glass-sheet` | `rgba(9,10,16,.105)`, `blur(7px) saturate(1.5) brightness(.68)` | The page itself (`Page`) |
| Frame | `.glass-dock` | `rgba(9,9,15,.31)`, `blur(14px) saturate(1.4) brightness(.78)` | Sidebar, header, tab row, right rail |
| Band | `.glass-well` | `rgba(4,5,10,.29)` | Darker strips inside the content: scene switch, fields, segmented controls |
| Overlay | `.glass-float` | `rgba(15,15,21,.84)`, `blur(20px)`, 1 px line, `0 12px 32px` shadow | Popover, Dialog, Sheet, Select, DropdownMenu, Tooltip, toast |

Two surfaces with `backdrop-filter` must be siblings, never nested: a nested one only sees its
parent. That is why the tab row and the right rail sit beside `Page`, not inside it.

Blocks are separated by spacing and a heading, rows by a hairline. Nothing is boxed into equal
cells. A `Card` is only a named section now: no border, no fill, no radius.
Inside an overlay, lists and code blocks keep a hairline outline, because the overlay has no block
titles to hold them apart.

Text on the content surface carries `0 1px 2px` shadow and a lighter `--muted-foreground`
(`#dedce4`), because the picture shows through. At the defaults primary text is about 5:1 at the
brightest part of a picture and secondary text about 4:1. Raising see-through lowers this, so the
controls exist and the owner decides. Solid controls drop the text shadow.

The login screen is the one card in the panel, two columns (shadcn `login-04`): the form on overlay
glass and a clear pane that lifts the picture behind it, so it follows the chosen background. Under
`md` the pane goes and the form stands alone.

## Appearance

Header icon button, a `.glass-float` popover. Everything is applied as variables on `<html>` before
the first paint and kept per browser: settings in `localStorage` (`miyoria.panel.look`, every field
clamped on read), the owner's picture in IndexedDB (`miyoria-panel`). Never a light theme.

| Setting | Range, default | Does |
|---|---|---|
| 背景亮度 | 30 to 100, 66 | `--bg-brightness` |
| 背景模糊 | 0 to 24 px, 0 | `--bg-blur` |
| 玻璃模式 | on | Off makes every surface an opaque dark colour and drops `backdrop-filter`, for clarity or to save GPU |
| 元件模糊 | 0 to 24 px, 7 | `--blur`; the frame takes twice this. 0 saves GPU while TTS runs |
| 元件深色遮罩 | 0 to 100, 35 | One dial for content, frame and band, the mock's formula with `t = 1 - mask / 100` |
| 配色 | 櫻花 | Paired themes (below). The two accents are never chosen separately: most free pairs break the charts |
| 密度 | 標準 | 緊湊 tightens rows, sections and the sidebar through `--row-y`, `--stage-gap`, `--nav-h` |
| 背景 | 預設圖 | A gallery of thumbnails: 預設圖, 純色, 漸層, a picture the viewer adds |

The default background is the owner's picture, `public/background.local.jpg`. It is game art, so it
is ignored by git and never ships; where the file is missing the 暮色 gradient shows instead. The
login card's right half shows `public/login.local.jpg` the same way, at 82% over the frosted
backdrop, beside a lighter glass (`--login`) than the floating surfaces. Whether each file is there
is read at build time (`__PANEL_ART__` in `vite.config.ts`): a build without them never asks for
them, so adding or removing one takes a rebuild.

## Color

Two accents, everything else neutral. Coloured controls are always solid.

| Role | Token | 櫻花 value | Used for |
|---|---|---|---|
| Base | `--background` | `#0b0d12` | Behind the picture |
| Text | `--foreground` | `#f1f0f4` | |
| Secondary text | `--muted-foreground` | `#b3b1bc`, lighter per surface | |
| Primary | `--primary` | `#f29dc4`, ink `#1f1218` | The page's main action, selected scene, live and speaking dots, sliders, focus, the selected nav icon, anything that needs attention |
| Secondary | `--secondary` | `#7355e8`, ink white | Block-level actions, segmented controls |
| Secondary line | `--secondary-line` | Mixed from secondary, `#a78bfa`-like | Meters, single-series charts |
| Neutral | `--control`, `--control-hover`, `--hover` | White 10%, 17%, 7% | Row actions, the current nav item, every other control |
| Lines | `--border`, `--line-strong` | White 11%, 20% | Hairlines |
| Exception | `--stop` | `#d6373f` | The emergency stop. Nothing else is red |

| Theme | Primary | Secondary | Chart 1 | Chart 2 |
|---|---|---|---|---|
| 櫻花 | `#f29dc4` | `#7355e8` | `#d9609a` | `#8a68ee` |
| 夕陽 | `#f5a68c` | `#4a6ad8` | `#d9744f` | `#5a7fe0` |
| 薄荷 | `#8fe0c8` | `#4a6ad8` | `#2f9e84` | `#5a7fe0` |
| 海潮 | `#f5a68c` | `#0c7f7a` | `#d9744f` | `#169e97` |

State has no colours of its own. `Tone` stays semantic and each tone has a shape as well as a
colour, and always a label:

| Tone | Dot | Badge |
|---|---|---|
| `neutral` | Dim | Neutral tag |
| `success` | Light neutral | Neutral tag, bright text |
| `brand` | Solid primary | Neutral tag, primary text |
| `warning` | Hollow primary ring | Primary outline |
| `danger` | Solid primary | Solid primary |

Live is `brand`, never red. Errors read in the primary colour, with their words. Diffs mark added
lines with the secondary line and removed lines with the primary, and keep `+` and `−`.

### Chart colors

Single series use `--chart-line` (the secondary line). Categories take `--chart-1..5` in this fixed
order, never cycled: the theme's chart 1, chart 2, a light neutral `#c9c8d1`, then a deeper step of
chart 1 and of chart 2. `--chart-quiet` (white 22%) is "nothing came of it" / "other". Gridlines
`--chart-grid`, baselines and crosshairs `--chart-axis`. `--chart-surface` is the ring around a
hovered point.

Validated with the dataviz validator for all four themes on the glass (`#14151f`): adjacent pairs
pass CVD (worst ΔE 10.1) and normal vision (worst 18.7), and the first three hold for all pairs, so
scatter-like charts stop at three. The neutral is lighter than the mock's `#8b8994` because that
gray failed CVD against chart 1 (ΔE 2.8 for deutan). On the brightest part of a picture
(`#3a3b47`) chart 2 can fall just under 3:1, which the legend and the hidden table cover.

## Type

Geist Variable (`@fontsource-variable/geist`) with a CJK fallback stack: PingFang TC,
Microsoft JhengHei UI, Noto Sans TC. Geist Mono only for ids, topics, JSON, tokens, model
names, latencies, axis ticks and diffs. Scale: 11 (ticks) / 12 / 13 / **14 body** / 15 (block
title, semibold) / 24 (總覽's opening line and chart headline values, semibold). Inside blocks and
in the right rail titles are 13. Figures are tabular across the panel.

## Layout

Navigation is four levels, each visible at once:

| Level | Where |
|---|---|
| Group | Sidebar labels: 現場 (總覽, 直播, 動態), 她 (內心, 角色, 生活, 規則), 運作 (LLM, 系統, 經濟, 評測), 管理 (權限, 資料, 設定) |
| Page | Sidebar items; the header shows `分類 / 頁面` |
| Tab | The underlined row under the header, from `nav.ts` |
| Block | Block title 15, inner title 13, rail title 13 |

- Sidebar: 13 rem, flush to the left edge, collapses to 3.25 rem icons (`⌘/Ctrl+B`). Top down: the
  mark, her name and current state, search (`Ctrl K`), the groups, then connection and account. The
  selected item is a neutral fill with the icon in the primary colour. A primary dot on 直播 while
  she is live, a count on 內心 while approvals wait.
- Below `md` the sidebar becomes a row across the top: the mark and a horizontally scrolling list
  of pages. Groups, her state and the search box fold away; search stays as an icon in the header.
- Header: 60 px, flush. Sidebar toggle, `分類 / 頁面`, the page's own tags and actions (a portal
  from `PageHeader`), "自主行動已暫停" while her autonomy is stopped, then the appearance button and
  緊急停止, which is in the header on every page. On 總覽 it has no surface until the page scrolls.
- 總覽 alone opens on the picture: her state in one 24 px line and the now strip over a soft
  scrim. Every other page starts at the content directly.
- Page: `Page` is the content surface, 28 px padding (16 px on phones), `--stage-gap` (32 px)
  between blocks. `Page rail={...}` adds the right rail (19.5 rem, under the content below 1180 px).
  A rail holds things to act on, and only pages with real content for it have one: 總覽 (needs
  attention, voice, say, spend, modules), 直播 (voice, say, game, channel levels), the public site
  for someone logged in (點歌, 你的資料). Rail blocks are split by hairlines.
- Rows: hairlines, `--row-y` vertical padding, no horizontal inset, so rows align with block titles.
- Chart blocks (`ChartBlock`): title 13 muted, headline value 24 semibold with its unit and one
  muted aside, legend, then the plot. Two per row from `lg`, one below.
- Small multiples (`Facets`): one 56 px line per measure with spacing between (5 columns on `xl`,
  3 on `sm`, 2 on phones), one shared crosshair, the hovered value in each header.
- Strips of facts (now strip, LLM figures, voice latency): label over value, spaced, no cell walls.
- 直播: the scene switch is a `.glass-well` band, the selected scene solid primary.
- LLM (`/llm`): 概況, 呼叫 (the call inspector), 價格與用量. Detail sheets (`sm:max-w-3xl`) for an
  LLM call and a thought live in the URL (`?call=`, `?thought=`), so one links to the other.

## V4 pages

What V4 added, in the same blocks as everything else: `Page`, `Card` with a named section,
hairline rows, `ChartBlock` for the one chart, no tiles. Every one reads through `ModuleQuery`
(`app/v4-queries.ts`, `api/v4-endpoints.ts`): loading is a skeleton, a 503 is one `OffLine` row
("<module>沒有啟動") with 重新檢查, a 404 on the route is "這個 Core 還沒有這項功能", and an empty
answer is one plain line. Nothing here is invented: a number the Core does not send is not shown.

- 生活 (`/life`, group 她): five tabs from `LIFE_TABS`.
  - 今天: `ChartBlock` 最近七天做的事 (columns, a day each), then 今天 and 她自己記得的 as hairline rows.
  - 提醒: 她設的提醒, with a cancel in `RowActions` behind a confirm.
  - 能做的事: 她能做的事 as a `SegmentBar` with the counts in its legend.
  - 技能: 她的技能 as a list of names and descriptions; one opens its body and files in a `Sheet`.
    Skills are read through the skills module, not from the files.
  - 工作區: 她的工作區 as a table of files and sizes, a `Meter` for how full it is (brand only from 90%).
- 經濟 (`/economy`, group 運作): four tabs from `ECONOMY_TABS`. Amounts carry the currency name
  the Core sends.
  - 健康度: 這七天回收率 as one `ChartBlock` with a `TimeChart` of what went out and came back,
    怎麼算 as a `dl`, and 每天 as a table.
  - 委託: 等她做的委託 as a table. 預測: each question with its bets. 房間: 她的房間 as a table
    with a `Meter` for how much of the price is funded.
  - No ranking of people. Someone's own quests show in their page under 角色 / 人.
- 評測 (`/eval`): the participation metrics under 參與度指標, `ChartBlock`s 回合怎麼結束 and
  沒接話的原因 (a `SegmentBar` each, counts in the legend). Words for outcomes, never a score.
- 派對遊戲 (a card on 直播): from `GET /api/party`. Running games first (a pulsing brand dot, the
  game, the channel, how many are there, when it began, the scores when the game scores), then 最近的結果
  with why it ended and the final standings. "現在沒有人在玩" is an empty snapshot; the module being
  off is the `OffLine` row. It never shows what a game keeps hidden (an answer, the soup's bottom).
  The recent list lives in memory, so a restart empties it.

## Public site

What `/` shows to anyone who is not an admin. `App.tsx` picks it after `GET /api/auth/session`
answers 401 and `GET /api/public/status` answers; the admin shell, its router and its event stream
are never mounted, so nothing there can call an admin route. Without a public side on the Core
(`[modules.api.public] enabled = false`, or an older Core) the login screen shows as before. The
token form stays at `#/login`, with no link to it from the page.

| Who | Sees |
|---|---|
| Anyone not logged in | Her landing (see "Landing" below): who she is, what she is doing now, today's numbers, Discord login |
| Logged in | Also 她眼中的你, 一起的回憶, 你點的歌, and a rail with 點歌 and 你的資料 |
| Someone she does not know, or a blocked person | The same page, "她還不認識你", no 點歌. The two cannot be told apart |

- Frame: a `.glass-dock` header like the shell's: the mark, her name, her state, then login or the
  person and 登出. No sidebar, no navigation.
- Content: `Page` straight away. There is no opening on the picture; that stays 總覽's.
- 現在, 今天 and the bands of 她眼中的你 are strips of facts, label over value, at 14. Never tiles.
- Words, not numbers, for anything she feels: 好感, 信任 and 熟悉 arrive as bands from the Core.
- No ranking of people, anywhere.
- The logged-in page also holds the keepsakes (`CardSection`, `FortuneSlip`, `HoloCard`): the member
  card and today's fortune slip, the same things `/me card` and `/me fortune` give on Discord,
  through the same service, so both read alike. The card and the slip are the only decorated
  surfaces on the site; the rest stays flat, and the card's motion stops under reduced motion.
  Letters to her are written from the shop (`Wallet`) or with `/me letter`.
- 她 (the public live page at `/watch`, `LIVE_PAGE` in `pages/public/live`; `/live` stays the admin 直播 page): anyone with the link may watch, and
  patting her head needs a Discord login that returns there. No admin shell, no admin route. While
  OBS publishes (`snapshot.video.on`) the stage is the real OBS picture, never a model the page
  draws: `LivePlayer`, a 16:9 player on the Core's LL-HLS proxy (hls.js, loaded on demand; native
  HLS only where there is no Media Source, i.e. iOS Safari). It starts muted with an 開啟聲音
  button (the choice and the volume are remembered in `localStorage`), a live dot, play, volume
  and fullscreen in a bar under the picture, outside the touch layer. A network or media error is
  recovered; when it will not come back, or OBS stops, the stage drops the picture (no drawn
  stand-in for her), and tries the picture again after 20 s.
  Her state line, her lines and the pat button sit under the picture.
  Touch: a member with pats open clicks or taps the picture, and the page posts `{x, y}`, 0..1
  on the picture itself (`touch.ts` maps the click through `object-fit: contain`; a click on a bar
  is nothing). A hand and a heart show at once at the spot; other viewers' pats that carry a spot
  show as small hands there. A visitor sees a 登入後摸摸她 hint on hover and the click goes to the
  login; while pats are closed the picture takes no touch. The 摸摸頭 button stays for the
  keyboard and posts `{}`. Without a picture a pat shows only in the note and the count. Her lines
  come as they are said, with a cursor until a line is final. All motion is CSS and stops under
  `prefers-reduced-motion` (the hands and hearts just stay a moment).
- 請她忘記我 confirms with what goes and what stays, in the words `/me memory forget` uses.

## Landing

What someone who is not logged in sees at `/` (`pages/public/landing/`, loaded on demand). It is its
own world, black with her in it, and the panel's operate-mode rules above do not bind it; real data
does. Strategy and the direction contract live in `.impeccable/surfaces/src-pages-public-landing.md`.

- Black base `#000`, type `#f4f4f5`, muted `#a1a1aa`, rules white at 10%. Geist with the system
  Chinese faces; Geist Mono only for the real commands. Her name on the site is Miyoria.
- Cover: a real black hole (`blackhole.ts`, the passes of sayed1145/glsl-black-hole, MIT, licence
  kept in `blackhole-glsl.ts`). The lensing map is traced once, each frame re-lights the disc and
  blooms it; it only renders while the cover is on screen. Her animated picture stands to the
  right, her name as the `h1` with the Discord login and her live page.
- Under the cover: the night sea (`sea.ts`, our own shader), a fixed canvas of sharp-crested waves
  lit by the sky and a moon; scrolling moves the camera forward.
- Glass is light (6-8 px blur) and only where something sits over the water: tiles, the player,
  the terminal.
- Nav: a flat bar on the cover that scrolls away with it; no sticky bar over the sections.
- Mark: a crescent moon whose lower tip curls up into a whale's tail, one solid shape in a single
  colour (`docs/assets/logo/`: `miyoria-mark.svg` black, `miyoria-mark-white.svg`, and
  `miyoria-icon.svg` white on a dark tile, which is also the favicon). On the page it takes
  `currentColor`.
- Sections are pictures, not lists: 她在 Discord 的樣子 (her with mock Discord messages that pop in as
  a conversation, and a voice channel), 歌單 from `/api/public/songs`, 直播間 (a stage that links to
  `/watch`), and 自己養一隻 with the real setup commands typed out.
- Her pictures (`landing/her/*.webm`, `.webp` posters) are short loops recorded from the official
  free Live2D model by 神宫凉子. Only the recordings ship; the model and PSD stay out of the repo, as
  their guidelines ask. The footer credits the illustrator and the black hole and has no picture.
- Phones get their own layout: her above the words on the cover, each tile with the chat on top
  and her under it, a tall stage, and a three-column footer.
- Motion: headings come in a character at a time, sections rise as they arrive, her pictures drift
  with scroll. All of it stops under `prefers-reduced-motion`, and the shaders draw one frame.
- Without WebGL the cover and sea are plain black.
- The token form stays at `/login` with no link from the landing.

## Charts

`TimeChart` (lines, optional 10% area wash, crosshair + one tooltip listing every series,
arrow keys move it), `ColumnChart` (stacked columns ≤ 24 px with a 4 px rounded data end, 2 px
gaps between segments, hovered column stays, others dim to 45%), `Facets`, `SegmentBar` (one 100%
bar with counts in the legend), `BarList` (horizontal bars, largest first). Every chart has a
legend from two series up, never colors text, and carries a visually hidden table of its values.
Time axes tick on round local times. Ranges: 1 小時 / 6 小時 / 24 小時 (`Segmented`), remembered
per browser. Telemetry comes from `GET /api/telemetry` (one sample a minute, a day in memory); a
Core without it shows one line at the chart's height instead.

## Components

Button (default = primary / secondary / outline = neutral / ghost / link / stop; sizes sm, default,
icon, icon-sm; `busy` spinner; `writes` disables with the read-only hint). `stop` is the emergency
stop's alone. Badge (outline, secondary, success, warning, destructive, brand), StatusBadge /
StateBadge / Dot, Meter / Bipolar, `Segmented` (radio group of short options), Card (a named
section), Tabs, Table + `DataTable` (TanStack Table; global filter, sortable headers via
`enableSorting`), `RowActions` (⋯ DropdownMenu at row end), Select, Switch, Checkbox, Slider,
Input / Textarea, Field (label + control + error), Dialog (forms, persona edit → diff → save),
AlertDialog via `ConfirmDialog` (stays open on failure), Sheet (details: event, decision, person,
MCP tools), Command palette (pages, people, modules), Popover + Command combobox (person picker),
Tooltip, Sonner toasts (success / error with the Core's message), Skeleton rows, `DiffView`,
`JsonView`, `Facts`, `EmergencyStop`, `NowStrip`, `AppearancePopover`. Icons: lucide 16 px.

## States

`QueryView`: skeleton rows of real row height → error line with retry → one-line empty →
data. Charts: a skeleton at the chart's height → one line ("這個 Core 還沒有趨勢資料") →
plot; refetches keep the previous render. Mutations report through Sonner; dialogs close only
on success. Disabled controls say why in a tooltip (read-only account, OBS/VTS not connected,
she is not in voice). Disruptive controls confirm (stop streaming, leave voice, Go Live, stop
the game, cancel every song); routine ones act at once (scene, expression, queue order,
mute a channel), and so does 緊急停止.

## Motion

150 to 200 ms fades and zooms on overlays (tw-animate-css), sheet slide 300 ms, 120 ms column
dimming on hover, 160 ms for the header gaining its surface. Pulsing dots only for live /
transitioning states. `prefers-reduced-motion` collapses all durations.
