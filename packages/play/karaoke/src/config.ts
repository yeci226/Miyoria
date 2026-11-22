// `[modules.karaoke]` (docs/design/karaoke.md 「做了什麼(第一步)」): single-player karaoke on the
// member page. The module's own switch is `enabled` (the system page); `open` closes asking for
// and singing songs to members while the module keeps running (results and her comments still
// arrive; a panel admin can still use everything, to try it first). A person singing alone gets no
// coins (owner 2026-11-17); rooms (step 4) cost and pay coins through the economy's karaoke wallet.

import { setting, settingGroups } from "@miyoria/runtime/kernel";
import { z } from "zod";

/** A server's text channel as a context key, `<platform>:<server>:<channel>` (empty: none). */
const CONTEXT = /^([a-z][a-z0-9_]{0,31}):([A-Za-z0-9_.-]{1,64}):([A-Za-z0-9_.-]{1,64})$/;

/** A text channel of a server as a context key, `discord:<guild>:<channel>` (empty: none). */
const channel = () =>
  z
    .string()
    .regex(
      /^([a-z][a-z0-9_]{0,31}:[A-Za-z0-9_.-]{1,64}:[A-Za-z0-9_.-]{1,64})?$/,
      "<platform>:<server>:<channel>",
    )
    .default("");

/**
 * The text channel of `key` (`discord:<guild>:<channel>`, or another platform's server and
 * channel the same way), or `null` for none.
 */
export function commentContext(
  key: string,
): { platform: string; scope: string; channel: string; kind: "channel" } | null {
  const m = CONTEXT.exec(key);
  if (m === null) return null;
  return {
    platform: m[1] as string,
    scope: m[2] as string,
    channel: m[3] as string,
    kind: "channel",
  };
}

/**
 * ```toml
 * [modules.karaoke]
 * comment_channel = "discord:111111111111111111:123456789012345678"
 * ```
 */
export const KaraokeConfigSchema = z
  .object({
    /** Her local time zone as a UTC offset: what a day is for the daily limit. */
    utc_offset_minutes: z
      .number()
      .int()
      .min(-720)
      .max(840)
      .default(8 * 60),
    /** Members may ask for songs and sing. */
    open: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "開放唱 K",
          help: "關掉時會員不能點歌、唱、開房間;唱完的結果和她的講評照常。面板管理員關著時也能用,可以先試",
          group: "songs",
        }),
      ),
    /**
     * The member site's address (where `/karaoke` is), for the links of `/me play karaoke` and the
     * room notices. Empty: they say the page is on the member site, without a link.
     */
    site_url: z
      .string()
      .regex(/^(https?:\/\/[^\s/?#]+(\/[^\s?#]*)?)?$/, "http(s)://<host>")
      .default("")
      .meta(
        setting({
          kind: "text",
          label: "會員頁的網址",
          help: "例如 https://miyoria.example.com;Discord 的連結和直播上的 QR 碼用它。沒填就只說在會員頁",
          group: "songs",
        }),
      ),
    /** The longest song that may be sung, in seconds; a longer one fails its preparation. */
    max_song_secs: z
      .number()
      .int()
      .min(60)
      .max(1200)
      .default(480)
      .meta(setting({ kind: "duration", unit: "s", label: "一首最長", group: "songs" })),
    /** Songs one person may have prepared per local day (a song already prepared is free). */
    daily_songs: z
      .number()
      .int()
      .min(0)
      .max(100)
      .default(10)
      .meta(
        setting({
          kind: "number",
          label: "每人每天準備幾首",
          help: "已經準備好的歌不算;0 是只能唱準備好的",
          group: "songs",
        }),
      ),
    /** Cents either way that count as on pitch; credit falls to nothing at twice this. */
    tolerance_cents: z
      .number()
      .int()
      .min(20)
      .max(100)
      .default(50)
      .meta(
        setting({
          kind: "number",
          label: "音準容許範圍(cents)",
          help: "離原唱這麼近算唱對,兩倍遠就不算",
          step: 5,
          group: "score",
        }),
      ),
    /**
     * The official score from a recording of the singer (docs/design/karaoke.md 「做了什麼第三步」):
     * the browser records the microphone during the song and sends it once at the end; the song
     * worker reads its pitch (RMVPE) and Core scores that. The recording is deleted on both as soon
     * as it is scored. Off: only the browser's estimate (預估).
     */
    voice_score: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "用錄音算正式分數",
          help: "唱的時候錄下麥克風,唱完送到唱歌的機器讀音高、算正式分數,算完兩邊都刪掉;關掉時只有瀏覽器的預估分數",
          group: "score",
        }),
      ),
    /** She comments on a finished song (one model call, through her usual turn). */
    comment: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "她講評",
          help: "唱完把系統分數告訴她,讓她在講評頻道用自己的話講一句",
          group: "comment",
        }),
      ),
    /** Where she comments; empty: she only hears of it and says nothing. */
    comment_channel: channel().meta(
      setting({
        kind: "channel",
        room: "text",
        ref: "context",
        scope: "space",
        label: "講評頻道",
        help: "她在這個頻道講評;沒設就只讓她知道,不開口",
        group: "comment",
      }),
    ),
    /** Her comment waits this long for the official score; then she hears of the estimate. */
    voice_wait_secs: z
      .number()
      .int()
      .min(0)
      .max(600)
      .default(90)
      .meta(
        setting({
          kind: "duration",
          unit: "s",
          label: "講評等正式分數",
          help: "唱完後最多等正式分數這麼久再告訴她;等不到就用預估分數",
          group: "comment",
        }),
      ),
    /**
     * A background video for the songs prepared from now on: the source's picture, no sound, at
     * most 720p, played muted behind the lyrics on the backing's clock. Off: none is made, and
     * none already made is shown.
     */
    video: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "背景影片",
          help: "準備歌時留一份來源的畫面(最高 720p、沒有聲音),唱的時候放在歌詞後面;關掉時不做也不放",
          group: "video",
        }),
      ),
    /** Hours a song's video stays on Core after it was last sung (the worker keeps its own). */
    video_keep_hours: z
      .number()
      .int()
      .min(1)
      .max(720)
      .default(24)
      .meta(
        setting({
          kind: "number",
          label: "影片在 Core 留幾小時",
          help: "最後一次唱過後這麼久就刪掉 Core 上的那一份,再唱時從唱歌的機器再拿",
          group: "video",
        }),
      ),
    /**
     * How a song's lyrics are aligned to the singing (docs/design/karaoke.md 「做了什麼第二步」):
     * `mms` (the default), torchaudio's MMS_FA weights, far better on hard songs, licensed
     * CC-BY-NC-4.0 (non-commercial use only: this project is non-commercial; an instance that earns
     * money must switch to `w2v`); `w2v`, a wav2vec2 CTC model per language (Apache-2.0). Sent with
     * every song asked for; a song prepared before keeps its own.
     */
    aligner: z
      .enum(["w2v", "mms"])
      .default("mms")
      .meta(
        setting({
          kind: "select",
          label: "歌詞對齊",
          help: "預設 mms:難的歌準很多,但權重是 CC-BY-NC-4.0,只能非商業使用;有收入的用途請改成 w2v(Apache-2.0)。只影響之後準備的歌",
          labels: { w2v: "w2v(Apache-2.0)", mms: "mms(CC-BY-NC-4.0)" },
          group: "lyrics",
        }),
      ),
    /** A looked-up line at least this similar to what was heard is matched (aligned, notes per character). */
    lyrics_matched: z
      .number()
      .min(0)
      .max(1)
      .default(0.75)
      .meta(
        setting({
          kind: "ratio",
          label: "一行算對上",
          help: "查到的一行和聽到的至少這麼像,才逐字對齊、照字切音符",
          group: "lyrics",
        }),
      ),
    /** Below `lyrics_matched` but at least this: uncertain (shown, not aligned); below: failed. */
    lyrics_uncertain: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .meta(
        setting({
          kind: "ratio",
          label: "一行算不確定",
          help: "比這個低就算對不上",
          group: "lyrics",
        }),
      ),
    /** Of the looked-up lines, at least this share matched keeps them. */
    lyrics_keep_share: z
      .number()
      .min(0)
      .max(1)
      .default(0.5)
      .meta(
        setting({
          kind: "ratio",
          label: "整首留下查到的歌詞",
          help: "對上的行至少這麼多,查到的歌詞就用",
          group: "lyrics",
        }),
      ),
    /** Fewer than this share matched: the wrong song, the lyrics become what was heard. */
    lyrics_wrong_share: z
      .number()
      .min(0)
      .max(1)
      .default(0.2)
      .meta(
        setting({
          kind: "ratio",
          label: "整首算查錯歌",
          help: "對上的行比這個少,就不用查到的歌詞,改用聽寫",
          group: "lyrics",
        }),
      ),
    /**
     * Rooms (docs/design/karaoke.md 「做了什麼第四步」): up to `room_singers` people sing the same
     * song at once, each in their own browser, while she is in a voice channel (the comment
     * channel's server) and hosts. Opened and joined on the member page.
     */
    rooms: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "多人房間",
          help: "她在語音頻道時,會員可以在會員頁開房間,大家同時唱同一首;要先設講評頻道(房間開在那個伺服器)",
          group: "rooms",
        }),
      ),
    /** What opening a room costs (burned). 0: free. */
    room_price: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(20)
      .meta(
        setting({
          kind: "number",
          label: "開房費",
          help: "開房的人付;一輪都沒唱完就關掉的房間全退",
          group: "rooms",
        }),
      ),
    /** What the winner of a round gets (two finishers at least, the official score). 0: none. */
    room_prize: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(15)
      .meta(
        setting({
          kind: "number",
          label: "第一名獎勵",
          help: "至少兩個人唱完才有;要是正式分數、沒有被標記;同分都給",
          group: "rooms",
        }),
      ),
    /** What everyone who sings a round through gets. 0: none. */
    room_finish: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .default(3)
      .meta(
        setting({
          kind: "number",
          label: "唱完的獎勵",
          help: "唱到原唱一半以上的人各拿這麼多",
          group: "rooms",
        }),
      ),
    /** Of the song's voice a singer must have sung for the round to count as finished. */
    room_finish_share: z
      .number()
      .min(0.1)
      .max(1)
      .default(0.5)
      .meta(
        setting({
          kind: "ratio",
          label: "算唱完",
          help: "原唱有聲的地方唱到這麼多才算唱完",
          group: "rooms",
        }),
      ),
    /** Prizes one person may win per day. */
    room_prizes_per_day: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(2)
      .meta(setting({ kind: "number", label: "每人每天第一名獎勵幾次", group: "rooms" })),
    /** Finishing rewards one person may get per day. */
    room_finishes_per_day: z
      .number()
      .int()
      .min(0)
      .max(50)
      .default(5)
      .meta(setting({ kind: "number", label: "每人每天唱完獎勵幾次", group: "rooms" })),
    /**
     * Rounds one room may sing for its one opening charge; then it closes. (One charge per room,
     * not per round: the simpler rule.)
     */
    room_rounds: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(4)
      .meta(
        setting({
          kind: "number",
          label: "一間房最多唱幾首",
          help: "開房費包含這麼多首,唱完要再開一間",
          group: "rooms",
        }),
      ),
    /** Singers in a room (spectators are not counted). */
    room_singers: z
      .number()
      .int()
      .min(2)
      .max(8)
      .default(8)
      .meta(setting({ kind: "number", label: "一間房最多幾人唱", group: "rooms" })),
    /** Songs one person may have waiting in a room's queue (one being prepared counts). */
    room_queue_per_person: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2)
      .meta(
        setting({
          kind: "number",
          label: "每人最多點幾首在等",
          help: "房間裡的點歌佇列,一個人同時最多有幾首在等(準備中的也算)",
          group: "rooms",
        }),
      ),
    /** Songs a room's queue holds (failed ones are not counted). */
    room_queue_max: z
      .number()
      .int()
      .min(1)
      .max(50)
      .default(12)
      .meta(setting({ kind: "number", label: "一間房最多排幾首", group: "rooms" })),
    /** Rooms open at once, over every server (one song worker scores them all). */
    room_max: z
      .number()
      .int()
      .min(1)
      .max(10)
      .default(2)
      .meta(setting({ kind: "number", label: "同時最多幾間房", group: "rooms" })),
    /** A room with nothing going on (no round started, nobody joining) closes after this. */
    room_idle_mins: z
      .number()
      .int()
      .min(2)
      .max(120)
      .default(10)
      .meta(
        setting({
          kind: "duration",
          unit: "min",
          label: "房間閒置多久關掉",
          group: "rooms",
        }),
      ),
    /** Seconds from the start to the first beat, for everyone's browser to be ready. */
    room_countdown_secs: z
      .number()
      .int()
      .min(3)
      .max(30)
      .default(6)
      .meta(setting({ kind: "duration", unit: "s", label: "開始前倒數", group: "rooms" })),
    /**
     * The singers' microphones are streamed to a song worker during the round and scored live (the
     * official score); off, or a worker without it: the browser's estimate during the round and
     * the recording each singer uploads at the end.
     */
    room_stream: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "唱的時候即時算正式分數",
          help: "唱的時候把麥克風的聲音即時送到唱歌的機器算音高(不存);關掉時唱的時候只有預估,唱完再送錄音",
          group: "rooms",
        }),
      ),
    /**
     * A room that opens is posted in the comment channel (a neutral notice with its code and a
     * 「加入」 link, no ping), and the notice says 「已結束」 once the room closes.
     */
    room_announce: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "開房時在講評頻道貼通知",
          help: "一則系統通知:房號和「加入」的連結,不標記任何人;房間關掉時改成已結束。要有講評頻道",
          group: "rooms",
        }),
      ),
    /**
     * Her stream shows the karaoke room (the overlay's karaoke scene, step 5): the lobby, then the
     * round's lyrics, background video and board, and the results. Off: the overlay is as before.
     */
    stream_scene: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "直播畫面顯示唱 K 房間",
          help: "房間等人時角落一塊,唱的時候整個場景:歌詞、背景影片、即時排名、結果",
          group: "stream",
        }),
      ),
    /**
     * The stream's karaoke scene shows a QR code of the room's join link beside its code (in the
     * lobby, small after a round), when `site_url` is set. Anyone who sees the stream may open it;
     * the room's own rules decide who gets in.
     */
    stream_qr: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "直播上顯示加入房間的 QR 碼",
          help: "等人時在房號旁邊,唱完後小小一塊;要填會員頁的網址。看得到直播的人都能掃,誰能進房間照房間的規則",
          group: "stream",
        }),
      ),
    /** The QR code stays (small, in a corner) while a round is sung too. */
    stream_qr_while_singing: z
      .boolean()
      .default(false)
      .meta(
        setting({
          kind: "switch",
          label: "唱的時候也顯示 QR 碼",
          help: "唱的時候在角落留一個小的 QR 碼,中途進來的人只能旁觀",
          group: "stream",
        }),
      ),
    /** The stream's scene plays the round's backing (in the stream's audio, not her voice). */
    stream_backing: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "直播播伴奏",
          help: "直播的唱 K 場景播這一首的伴奏(OBS 的瀏覽器來源要讓 OBS 控制音訊)。她自己的語音頻道不播",
          group: "stream",
        }),
      ),
    /**
     * How far the stream runs behind the singers, one fixed delay per round: every relayed voice
     * is buffered to it (late audio is dropped, the delay never grows), and the backing, lyrics
     * and board on the stream follow the same delayed clock.
     */
    stream_delay_ms: z
      .number()
      .int()
      .min(1_000)
      .max(8_000)
      .default(2_000)
      .meta(
        setting({
          kind: "duration",
          unit: "ms",
          label: "直播比唱的人晚多少",
          help: "播出的歌聲要在這之前到;太晚到的那一段就是靜音,不會越拖越晚",
          group: "stream",
        }),
      ),
    /** A round's one singer may have their voice on the stream (they still opt in every round). */
    relay_solo: z
      .boolean()
      .default(true)
      .meta(
        setting({
          kind: "switch",
          label: "一個人唱時可以播出歌聲",
          help: "唱的人自己勾「讓大家聽到我」才播,每一首預設不勾;聲音不存",
          group: "stream",
        }),
      ),
    /** A new room plays its leader's voice (the opener can switch it in the lobby). */
    relay_lead: z
      .boolean()
      .default(false)
      .meta(
        setting({
          kind: "switch",
          label: "新房間預設播出第一名的歌聲",
          help: "兩個人以上唱時,直播一次播一個人:即時排名第一、沒有選「不要播我的聲音」的那位。開房的人在房間裡可以改",
          group: "stream",
        }),
      ),
    /** A new leader is put on the stream only after holding first place this long. */
    relay_hold_secs: z
      .number()
      .min(1)
      .max(30)
      .default(4)
      .meta(
        setting({
          kind: "duration",
          unit: "s",
          label: "換人前要領先多久",
          help: "新的第一名要連續領先這麼久才換成他的聲音,而且盡量換在兩句歌詞中間",
          group: "stream",
        }),
      ),
    /** The crossfade between two voices. */
    relay_fade_ms: z
      .number()
      .int()
      .min(50)
      .max(1_000)
      .default(200)
      .meta(setting({ kind: "duration", unit: "ms", label: "換人的淡入淡出", group: "stream" })),
    /** Gains of the stream's karaoke sound (0..1; the voice may go above 1). */
    stream_backing_gain: z
      .number()
      .min(0)
      .max(1)
      .default(0.8)
      .meta(setting({ kind: "number", label: "直播伴奏的音量", group: "stream" })),
    stream_voice_gain: z
      .number()
      .min(0)
      .max(4)
      .default(1.5)
      .meta(setting({ kind: "number", label: "直播歌聲的音量", group: "stream" })),
    stream_duck_gain: z
      .number()
      .min(0)
      .max(1)
      .default(0.35)
      .meta(
        setting({
          kind: "number",
          label: "她說話時唱 K 聲音降到",
          help: "她在語音頻道講話時,直播的伴奏和歌聲降到這個比例",
          group: "stream",
        }),
      ),
    /** Where the backing tracks and references are kept on Core, relative to `miyoria.toml`. */
    cache_dir: z.string().default("data/karaoke"),
  })
  .meta(
    settingGroups([
      { id: "songs", label: "點歌" },
      { id: "score", label: "評分" },
      { id: "rooms", label: "多人房間" },
      { id: "stream", label: "直播" },
      { id: "lyrics", label: "歌詞" },
      { id: "video", label: "背景影片" },
      { id: "comment", label: "講評" },
    ]),
  );

/** `karaoke_lyrics` of a song's job: the lyrics settings as the worker takes them. */
export function lyricsOptions(cfg: KaraokeConfig): {
  aligner: "w2v" | "mms";
  matched: number;
  uncertain: number;
  keep_share: number;
  wrong_share: number;
} {
  return {
    aligner: cfg.aligner,
    matched: cfg.lyrics_matched,
    uncertain: Math.min(cfg.lyrics_uncertain, cfg.lyrics_matched),
    keep_share: cfg.lyrics_keep_share,
    wrong_share: Math.min(cfg.lyrics_wrong_share, cfg.lyrics_keep_share),
  };
}
export type KaraokeConfig = z.output<typeof KaraokeConfigSchema>;

/**
 * A page of the member site (`/karaoke`, `/karaoke/room/<code>`) as a full link, from `site_url`;
 * `null` when it is not set.
 */
export function siteLink(cfg: Pick<KaraokeConfig, "site_url">, path: string): string | null {
  const base = cfg.site_url.trim().replace(/\/+$/, "");
  return base === "" ? null : `${base}${path}`;
}
