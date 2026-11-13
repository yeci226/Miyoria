import { Check, Copy } from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import type { PublicSong, PublicSongs, PublicStatus } from "@/api/types";
import { useApi } from "@/app/connection";
import { loginNext } from "@/app/session";
import { LIVE_PAGE } from "../live/path";
import { STATE, stateLabel, usePublicSongs, usePublicStatus } from "../status";
import { mountBlackHole } from "./blackhole";
import basinPoster from "./her/basin.webp";
import basinLoop from "./her/basin.webm";
import chestPoster from "./her/chest.webp";
import chestLoop from "./her/chest.webm";
import fingerPoster from "./her/finger.webp";
import fingerLoop from "./her/finger.webm";
import glassesPoster from "./her/glasses.webp";
import glassesLoop from "./her/glasses.webm";
import grassPoster from "./her/grass.webp";
import grassLoop from "./her/grass.webm";
import heartPoster from "./her/heart.webp";
import heartLoop from "./her/heart.webm";
import singPoster from "./her/sing.webp";
import singLoop from "./her/sing.webm";
import { mountSea } from "./sea";
import "./landing.css";

const REPO = "https://github.com/owenliu0924/Miyoria";
const NAME = "Miyoria";

const STEPS = [
  "git clone https://github.com/owenliu0924/Miyoria",
  "cd Miyoria && node scripts/setup.mjs",
  "pnpm dev doctor",
  "pnpm dev core",
];

const SECTIONS = [
  { id: "moments", label: "日常" },
  { id: "songs", label: "歌單" },
  { id: "watch", label: "直播" },
  { id: "host", label: "自己架" },
];

type Loop = { src: string; poster: string };
const HER = {
  heart: { src: heartLoop, poster: heartPoster },
  glasses: { src: glassesLoop, poster: glassesPoster },
  basin: { src: basinLoop, poster: basinPoster },
  grass: { src: grassLoop, poster: grassPoster },
  sing: { src: singLoop, poster: singPoster },
  finger: { src: fingerLoop, poster: fingerPoster },
  chest: { src: chestLoop, poster: chestPoster },
} satisfies Record<string, Loop>;

const still = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function title(s: PublicSong | null | undefined) {
  return s?.title ?? "還不知道歌名";
}

/** How far outside the screen (a share of its height) a loop starts loading. */
const NEAR = "50% 0px";

/**
 * Her, moving: a 4 s loop recorded from her model (only the recording ships, never the model).
 * Nothing is downloaded until it comes near the screen (`eager`: at once, for the cover), and it
 * plays only while it can be seen. With reduced motion it never plays, as before.
 */
export function Her({
  loop,
  className,
  style,
  label,
  eager = false,
}: {
  loop: Loop;
  className?: string;
  style?: CSSProperties;
  label?: string;
  eager?: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [moving] = useState(() => !still());
  const [near, setNear] = useState(eager);
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    if (typeof IntersectionObserver !== "function") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (!entry) return;
        if (entry.isIntersecting) {
          setNear(true);
          // The first time the source is not set yet: `autoPlay` starts it once it loads.
          if (moving && v.currentSrc !== "") v.play().catch(() => undefined);
        } else if (moving) {
          v.pause();
        }
      },
      { rootMargin: NEAR },
    );
    io.observe(v);
    return () => io.disconnect();
  }, [moving]);
  return (
    <video
      ref={video}
      className={className}
      style={style}
      src={near ? loop.src : undefined}
      poster={near ? loop.poster : undefined}
      autoPlay={moving}
      loop
      muted
      playsInline
      preload={near && moving ? "auto" : "none"}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-drift
    />
  );
}

/** A heading whose letters rise one after another once it scrolls in. */
function Rise({ children, id }: { children: string; id?: string }) {
  let i = 0;
  const lines = children.split("\n");
  return (
    <h2 className="ml-h2 ml-rv" id={id} aria-label={children.replace("\n", "")}>
      {lines.map((line, li) => (
        <span key={line} aria-hidden>
          {[...line].map((ch) => (
            <span key={i} className="ml-ch" style={{ "--i": i++ } as CSSProperties}>
              {ch}
            </span>
          ))}
          {li < lines.length - 1 && <br />}
        </span>
      ))}
    </h2>
  );
}

/** The sea under the page and the hole on the cover, both drawn while they can be seen. */
function useScenes(sea: React.RefObject<HTMLCanvasElement | null>, hole: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const seaCanvas = sea.current;
    const holeCanvas = hole.current;
    if (!seaCanvas || !holeCanvas) return;
    const water = mountSea(seaCanvas, Math.min(1, 1.25 / window.devicePixelRatio));
    const bh = mountBlackHole(holeCanvas, window.innerWidth < 700 ? 640 : 1024);
    if (!water && !bh) return;
    if (bh) holeCanvas.dataset.on = "true";
    let scroll = window.scrollY / window.innerHeight;
    const frame = (ms: number) => {
      scroll += (window.scrollY / window.innerHeight - scroll) * 0.08;
      if (bh && window.scrollY < window.innerHeight * 1.1) bh.render(ms / 1000);
      if (water && window.scrollY > window.innerHeight * 0.3) water.render(ms / 1000, scroll);
    };
    const onResize = () => water?.resize();
    window.addEventListener("resize", onResize);
    if (still()) {
      bh?.render(2);
      water?.render(2, 1);
      return () => {
        window.removeEventListener("resize", onResize);
        bh?.dispose();
      };
    }
    let raf = requestAnimationFrame(function loop(ms) {
      if (!document.hidden) frame(ms);
      raf = requestAnimationFrame(loop);
    });
    water?.render(0, 1);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      bh?.dispose();
    };
  }, [sea, hole]);
}

/** Things print in as they come into view, and her pictures drift a little against the scroll. */
function useReveal(root: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("ml-in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.2 },
    );
    const watch = () => {
      for (const n of el.querySelectorAll(".ml-rv:not(.ml-in)")) io.observe(n);
    };
    watch();
    const mo = new MutationObserver(watch);
    mo.observe(el, { childList: true, subtree: true });
    const drift = () => {
      for (const v of el.querySelectorAll<HTMLElement>("[data-drift]")) {
        const r = v.getBoundingClientRect();
        const c = (r.top + r.height / 2 - window.innerHeight / 2) / window.innerHeight;
        v.style.setProperty("--py", `${(c * -40).toFixed(1)}px`);
      }
    };
    if (!still()) window.addEventListener("scroll", drift, { passive: true });
    drift();
    return () => {
      io.disconnect();
      mo.disconnect();
      window.removeEventListener("scroll", drift);
    };
  }, [root]);
}

/** Her mark: a crescent moon whose lower tip curls up into a whale's tail. */
function Mark() {
  return (
    <svg viewBox="0 0 100 100" fill="currentColor" aria-hidden>
      <path d="M71.62 12.34 69.23 10.95 66.12 9.42 63.57 8.39 60.29 7.30 56.92 6.49 54.20 6.02 51.45 5.72 48.00 5.60 45.23 5.69 41.79 6.04 39.08 6.52 36.39 7.16 33.74 7.98 30.52 9.22 27.40 10.72 24.40 12.44 21.56 14.40 19.40 16.12 17.34 17.98 15.40 19.95 13.60 22.05 11.53 24.81 9.68 27.73 8.37 30.16 7.21 32.68 6.22 35.26 5.19 38.56 4.56 41.25 4.11 43.98 3.77 47.42 3.70 50.18 3.85 53.63 4.16 56.38 4.38 57.75 5.12 61.13 5.69 63.13 6.34 65.09 7.65 68.29 9.19 71.38 10.24 73.18 11.36 74.92 13.40 77.70 15.66 80.32 18.13 82.75 20.77 84.98 23.57 87.00 26.51 88.79 29.61 90.36 32.80 91.68 34.10 92.13 36.75 92.92 40.13 93.67 43.54 94.15 44.93 94.28 47.69 94.39 50.45 94.33 51.83 94.23 55.26 93.81 57.31 93.43 59.32 92.95 61.31 92.38 63.42 91.66 66.04 90.54 67.59 89.72 69.10 88.77 70.79 87.48 71.76 86.61 72.81 85.53 74.07 83.97 74.81 82.85 75.62 81.34 76.27 79.76 76.72 78.27 76.95 77.69 77.33 77.16 77.86 76.70 78.89 76.10 80.15 75.57 86.73 73.60 89.15 72.72 90.94 71.92 92.64 70.95 94.22 69.79 95.63 68.38 96.14 67.62 96.29 66.89 96.12 66.25 95.65 65.68 94.91 65.24 94.44 65.06 93.34 64.84 90.37 64.50 87.24 64.36 85.55 64.45 84.31 64.61 82.72 64.95 81.56 65.31 80.81 65.61 79.34 66.33 77.94 67.26 76.57 68.39 76.42 67.96 75.90 66.75 75.30 65.63 74.87 64.93 74.14 63.94 73.34 63.03 72.46 62.19 71.51 61.41 70.50 60.70 68.66 59.61 67.06 58.84 62.88 57.20 62.36 57.06 61.43 56.99 61.01 57.04 60.33 57.32 60.07 57.53 59.74 58.13 59.66 58.95 60.11 60.71 60.60 61.93 61.19 63.10 62.24 64.76 63.85 66.80 65.59 68.66 69.70 72.68 70.91 74.12 71.53 75.13 71.67 75.45 71.85 76.10 71.86 76.74 71.59 77.83 71.11 79.01 70.35 80.34 69.42 81.59 68.59 82.46 67.68 83.29 66.59 84.12 65.10 85.05 63.15 86.03 61.46 86.71 60.29 87.08 59.11 87.35 57.29 87.57 55.46 87.58 54.22 87.48 53.02 87.32 50.62 86.78 48.33 86.00 46.13 85.04 44.57 84.23 42.13 82.71 39.89 81.03 37.87 79.25 35.71 77.00 34.15 75.09 32.75 73.14 31.31 70.80 30.10 68.47 28.81 65.40 27.94 62.77 27.38 60.55 26.90 58.03 26.56 55.21 26.44 53.14 26.44 50.76 26.58 48.40 26.76 46.74 26.96 45.41 27.49 42.74 28.12 40.41 29.03 37.72 29.87 35.69 31.03 33.30 31.99 31.58 33.07 29.86 34.04 28.46 35.65 26.39 37.17 24.66 38.86 22.96 40.34 21.63 42.36 20.00 44.11 18.76 46.00 17.56 48.02 16.45 49.62 15.66 51.30 14.93 54.26 13.86 56.14 13.32 58.74 12.73 60.76 12.38 62.84 12.15 64.98 12.02 67.16 12.00 69.38 12.11 71.62 12.34Z" />
    </svg>
  );
}

function DiscordGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="#5865f2" aria-hidden>
      <path d="M20.3 4.4A19.6 19.6 0 0 0 15.4 3l-.6 1.3a18 18 0 0 0-5.6 0L8.6 3a19.6 19.6 0 0 0-4.9 1.5C.6 9.1-.3 13.7.1 18.2a19.8 19.8 0 0 0 6 3l1.3-2.1a12.8 12.8 0 0 1-2-1l.5-.4a14 14 0 0 0 12.2 0l.5.4-2 1 1.3 2.1a19.7 19.7 0 0 0 6-3c.5-5.2-.8-9.8-3.6-13.8ZM8 15.4c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Zm8 0c-1.2 0-2.2-1.1-2.2-2.4s1-2.4 2.2-2.4 2.2 1.1 2.2 2.4-1 2.4-2.2 2.4Z" />
    </svg>
  );
}

/** Her state, in one plain line over her name. */
function Now({ status, songs, failed }: { status?: PublicStatus; songs?: PublicSongs; failed: boolean }) {
  let text: ReactNode;
  if (!status) text = failed ? "現在看不到她在幹嘛" : "正在看她在不在…";
  else if (songs?.playing) text = `${stateLabel(status)}，唱到〈${title(songs.playing)}〉了`;
  else text = stateLabel(status);
  return (
    <section className="ml-now ml-fx" style={{ animationDelay: "0.05s" }} aria-label="她現在">
      {status && STATE[status.state].pulse && <span className="ml-now-dot" aria-hidden />}
      <span>{text}</span>
      {status?.live && (
        <a href={LIVE_PAGE} className="ml-now-go">
          去看
        </a>
      )}
    </section>
  );
}

function Av({ me, color }: { me?: boolean; color?: string }) {
  return <span className={me ? "ml-av ml-av-me" : "ml-av"} style={color ? { background: color } : undefined} />;
}

function Msg({ who, me, color, time, children }: { who: string; me?: boolean; color?: string; time?: string; children: ReactNode }) {
  return (
    <div className="ml-msg">
      <Av me={me} color={color} />
      <div>
        <b className={me ? "ml-bot" : undefined}>{who}</b>
        {me && <span className="ml-tag">BOT</span>}
        {time && <time>{time}</time>}
        <p>{children}</p>
      </div>
    </div>
  );
}

function Moments() {
  return (
    <section className="ml-sec" id="moments" aria-labelledby="ml-moments">
      <div className="ml-wrap">
        <Rise id="ml-moments">她平常在群組裡</Rise>
        <p className="ml-sub ml-rv">不用指令，直接標她就好。</p>
        <div className="ml-moments">
          <article className="ml-tile ml-big ml-rv">
            <Her loop={HER.glasses} className="ml-cut ml-cut-big" />
            <div className="ml-dc ml-seq">
              <Msg who="阿哲" color="#f59e0b" time="今天 23:41">
                @{NAME} 明天微積分期中，極限到底怎麼算
              </Msg>
              <div className="ml-typing" aria-hidden>
                <i />
                <i />
                <i />
                <span>{NAME} 正在輸入…</span>
              </div>
              <Msg who={NAME} me time="今天 23:41">
                你現在才問？好啦，先把式子貼上來，我一題一題帶你寫。寫完去睡覺喔
              </Msg>
            </div>
            <h3>
              聊天<small>會記得你上次說過什麼，也會記仇</small>
            </h3>
          </article>
          <article className="ml-tile ml-rv">
            <Her loop={HER.basin} className="ml-cut ml-cut-small" />
            <div className="ml-vc ml-seq">
              <div className="ml-vc-ch">🔊 深夜閒聊</div>
              <div className="ml-vc-u ml-talk">
                <Av me />
                {NAME}
              </div>
              <div className="ml-vc-u">
                <Av color="#22c55e" />
                小魚乾
              </div>
              <div className="ml-vc-u">
                <Av color="#f472b6" />
                Mika
              </div>
            </div>
            <h3>
              語音<small>進來陪你講話，被吐槽會躲起來</small>
            </h3>
          </article>
          <article className="ml-tile ml-rv">
            <Her loop={HER.grass} className="ml-cut ml-cut-small" />
            <div className="ml-dc ml-dc-short ml-seq">
              <Msg who={NAME} me>
                我在 Minecraft 蓋了一間房子！！雖然門是歪的
              </Msg>
            </div>
            <h3>
              遊戲<small>自己決定要玩什麼</small>
            </h3>
          </article>
        </div>
      </div>
    </section>
  );
}

function Songs({ songs }: { songs?: PublicSongs }) {
  const playing = songs?.playing ?? null;
  const queue = [
    ...(songs?.upcoming ?? []).map((s) => ({ s, tag: s.ready ? "練好了" : "還在練" })),
    ...(songs?.recent ?? []).map((s) => ({ s, tag: "剛唱完" })),
  ].slice(0, 4);
  const thumbs = [HER.heart.poster, HER.chest.poster, HER.finger.poster, HER.glasses.poster];
  return (
    <section className="ml-sec" id="songs" aria-labelledby="ml-songs">
      <div className="ml-wrap">
        <Rise id="ml-songs">點一首歌給她</Rise>
        <p className="ml-sub ml-rv">她會自己去練，練好了就排進歌單唱給大家聽。</p>
        <div className="ml-songs">
          <Her loop={HER.sing} className="ml-sing ml-rv" />
          <div className="ml-player ml-rv">
            {playing ? (
              <div className="ml-playing">
                <div className="ml-art" />
                <div>
                  <small>
                    <span className="ml-eq" aria-hidden>
                      <i />
                      <i />
                      <i />
                    </span>
                    正在唱
                  </small>
                  <b>{title(playing)}</b>
                  {playing.artist && <span>{playing.artist}</span>}
                </div>
              </div>
            ) : (
              <p className="ml-quiet">她現在沒在唱。登入之後，下一首可以是你點的。</p>
            )}
            {playing && (
              <div className="ml-bar" aria-hidden>
                <i />
              </div>
            )}
            {queue.length > 0 && (
              <ol className="ml-queue ml-seq">
                {queue.map((r, i) => (
                  <li key={`${title(r.s)}-${i}`}>
                    <i style={{ backgroundImage: `url(${thumbs[i % thumbs.length]})` }} />
                    <div>
                      {title(r.s)}
                      {r.s.artist && <em>{r.s.artist}</em>}
                    </div>
                    <span>{r.tag}</span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Watch({ live }: { live: boolean }) {
  return (
    <section className="ml-sec" id="watch" aria-labelledby="ml-watch">
      <div className="ml-wrap">
        <Rise id="ml-watch">什麼時候開台，她自己決定</Rise>
        <p className="ml-sub ml-rv">
          開了就在直播間，聊天室的留言她都看得到。<a href={LIVE_PAGE}>{live ? "她正在直播，去看" : "去她的直播間"}</a>
        </p>
        <a className="ml-stage ml-rv" href={LIVE_PAGE} aria-label="去她的直播間">
          <span className="ml-room" />
          <Her loop={HER.finger} className="ml-stage-her" />
          <span className="ml-lv">
            {live ? <b>LIVE</b> : <em>還沒開台</em>}
          </span>
          <span className="ml-cap">「等一下，這首歌的高音我昨天練了一整晚，你們不准笑」</span>
          <span className="ml-chat" aria-hidden>
            {[
              ["阿哲", "", "可以唱アイドル嗎"],
              ["Mika", "p", "她又在拖延了 www"],
              ["小魚乾", "y", "女僕裝今天也很可愛"],
              ["路人A", "", "第一次來，這是真人嗎"],
              ["Mika", "p", "不是喔是鯨魚"],
            ].map(([who, tone, text], i) => (
              <span key={`${who}${text}`} style={{ animationDelay: `${0.5 + i * 0.7}s` }}>
                <b className={tone}>{who}</b>
                {text}
              </span>
            ))}
          </span>
        </a>
      </div>
    </section>
  );
}

function Host() {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const all = STEPS.join("\n");
  return (
    <section className="ml-sec" id="host" aria-labelledby="ml-host">
      <div className="ml-wrap">
        <Rise id="ml-host">想在自己的群組養一隻？</Rise>
        <p className="ml-sub ml-rv">整個專案都是開源的。設定精靈會一步步問你 bot token、模型、要不要開語音。</p>
        <div className="ml-host">
          <div className="ml-term ml-rv">
            <div className="ml-term-bar">
              <i />
              <i />
              <i />
              <button
                type="button"
                className="ml-cp"
                aria-label={copied ? "已複製" : "複製這幾行指令"}
                onClick={() => {
                  void navigator.clipboard?.writeText(all).then(() => setCopied(true));
                }}
              >
                {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
              </button>
            </div>
            <pre>
              {STEPS.map((cmd, i) => (
                <span key={cmd} className="ml-line" style={{ animationDelay: `${0.3 + i * 0.75}s` }}>
                  <span className="ml-p">$ </span>
                  {cmd}
                </span>
              ))}
              <span className="ml-line ml-ok" style={{ animationDelay: `${0.3 + STEPS.length * 0.75}s` }}>
                ✓ {NAME} 已上線
              </span>
              <span className="ml-caret" />
            </pre>
          </div>
          <Her loop={HER.chest} className="ml-host-her" />
          <div className="ml-note ml-rv">
            需要 Node 22、pnpm、一個 Discord bot，跟任何 OpenAI 相容的 API。只聊天的話連顯卡都不用。
            <a className="ml-gh" href={REPO} target="_blank" rel="noreferrer">
              在 GitHub 上看 →
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Her front door, for anyone not logged in: a black hole on the cover with her name and state, then
 * the night sea under what she does in the server, her songs, her live room and how to host her.
 */
export default function Landing({ discord, notice }: { discord: boolean; notice?: string | null }) {
  const api = useApi();
  const status = usePublicStatus();
  const songs = usePublicSongs();
  const loginUrl = discord ? api.discordLoginUrl(loginNext()) : null;
  const live = status.data?.live ?? false;
  const root = useRef<HTMLDivElement>(null);
  const sea = useRef<HTMLCanvasElement>(null);
  const hole = useRef<HTMLCanvasElement>(null);
  useScenes(sea, hole);
  useReveal(root);

  return (
    <div className="ml" ref={root}>
      <canvas className="ml-sea" ref={sea} aria-hidden />
      <nav className="ml-nav" aria-label="這一頁">
        <a className="ml-wm" href="#top">
          <Mark />
          <span>{NAME}</span>
        </a>
        <div className="ml-links">
          {SECTIONS.map((s) => (
            <a key={s.id} href={`#${s.id}`}>
              {s.label}
            </a>
          ))}
        </div>
        <div className="ml-right">
          {loginUrl ? (
            <a className="ml-login" href={loginUrl}>
              <DiscordGlyph />
              用 Discord 登入
            </a>
          ) : (
            <a className="ml-login" href={LIVE_PAGE}>
              去她的直播間
            </a>
          )}
        </div>
      </nav>

      <main>
        <header className="ml-hero" id="top">
          <canvas className="ml-hole" ref={hole} aria-hidden />
          <div className="ml-scrim" aria-hidden />
          <Her loop={HER.heart} className="ml-hero-her" eager label={`${NAME}，藍色長髮、戴著鯨魚耳朵的女僕裝女孩`} />
          <div className="ml-copy">
            <Now status={status.data} songs={songs.data} failed={status.isError} />
            <h1>
              <span className="ml-ln">
                <span>{NAME}</span>
              </span>
              <span className="ml-ln">
                <span>住在 Discord</span>
              </span>
            </h1>
            <p className="ml-lede ml-fx" style={{ animationDelay: "0.35s" }}>
              一隻穿女僕裝的鯨魚。會跟你聊天、唱你點的歌，
              <br />
              無聊的時候自己跑去玩 Minecraft。
            </p>
            {notice && (
              <p role="alert" className="ml-notice">
                {notice}
              </p>
            )}
            <div className="ml-cta ml-fx" style={{ animationDelay: "0.5s" }}>
              {loginUrl && (
                <a className="ml-b1" href={loginUrl}>
                  用 Discord 登入 <b>→</b>
                </a>
              )}
              <a className={loginUrl ? "ml-b2" : "ml-b1"} href={LIVE_PAGE}>
                {live ? "她正在直播，去看" : "看她直播"}
              </a>
            </div>
          </div>
          <span className="ml-hint ml-fx" style={{ animationDelay: "1.2s" }} aria-hidden>
            <i />
            往下看她平常在做什麼
          </span>
        </header>

        <Moments />
        <Songs songs={songs.data} />
        <Watch live={live} />
        <Host />
      </main>

      <footer className="ml-foot">
        <div className="ml-wrap ml-fgrid">
          <div className="ml-fbrand">
            <a className="ml-wm" href="#top">
              <Mark />
              <span>{NAME}</span>
            </a>
            <p>住在 Discord 的鯨魚女僕。開源，可以自己架一隻。</p>
          </div>
          <nav aria-label="她">
            <h4>她</h4>
            <a href="#moments">日常</a>
            <a href="#songs">歌單</a>
            <a href={LIVE_PAGE}>直播間</a>
          </nav>
          <nav aria-label="自己架">
            <h4>自己架</h4>
            <a href={REPO} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href="#host">安裝步驟</a>
          </nav>
          <nav aria-label="其他">
            <h4>其他</h4>
            {loginUrl && <a href={loginUrl}>登入</a>}
            <a href="/login">管理面板</a>
          </nav>
        </div>
        <div className="ml-wrap ml-fbot">
          <span>
            {NAME}・開源專案
          </span>
          <span>立繪：神宫凉子・黑洞 shader：glsl-black-hole（MIT）</span>
        </div>
      </footer>
    </div>
  );
}
