import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemberSession } from "@/api/types";
import { ConnectionProvider } from "@/app/connection";
import { mockFetch, testQueryClient } from "@/test/render";
import {
  connectLive,
  initialView,
  type LiveAction,
  type LiveEvent,
  type LiveSnapshot,
  liveReducer,
  parseLiveEvent,
  type SourceLike,
} from "./feed";
import { isLivePath } from "./LivePage";
import { contentBox, spotAt } from "./touch";
import { LiveStage, RETRY_VIDEO_MS } from "./LiveStage";

const NOW: LiveSnapshot = {
  presence: { place: "in_voice", game: null },
  activity: null,
  speaking: false,
  emotion: { name: "neutral", intensity: 0 },
  line: null,
  pats: { recent: 0, open: true },
  video: { on: false, src: null },
};
const VIDEO_ON = { on: true, src: "/api/public/live/video/index.m3u8" };

// hls.js is mocked: jsdom has no Media Source Extensions. Each instance is kept for the tests.
const hlsState = vi.hoisted(() => ({ supported: true, all: [] as unknown[] }));
vi.mock("hls.js", () => {
  class FakeHls {
    static isSupported = () => hlsState.supported;
    static Events = { ERROR: "hlsError", FRAG_LOADED: "hlsFragLoaded" };
    static ErrorTypes = { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" };
    handlers = new Map<string, (e: string, d: unknown) => void>();
    config: unknown;
    source: string | null = null;
    media: unknown = null;
    destroyed = false;
    started = 0;
    recovered = 0;
    constructor(config: unknown) {
      this.config = config;
      hlsState.all.push(this);
    }
    on(e: string, h: (e: string, d: unknown) => void) {
      this.handlers.set(e, h);
    }
    loadSource(s: string) {
      this.source = s;
    }
    attachMedia(m: unknown) {
      this.media = m;
    }
    startLoad() {
      this.started += 1;
    }
    recoverMediaError() {
      this.recovered += 1;
    }
    swapAudioCodec() {}
    destroy() {
      this.destroyed = true;
    }
  }
  return { default: FakeHls };
});
interface FakeHlsLike {
  config: Record<string, unknown>;
  source: string | null;
  destroyed: boolean;
  started: number;
  recovered: number;
  handlers: Map<string, (e: string, d: unknown) => void>;
}
const hlsAll = () => hlsState.all as FakeHlsLike[];

const MEMBER: MemberSession = { name: "Alice", avatar_url: null } as MemberSession;

/** An `EventSource` the test drives. */
class FakeSource implements SourceLike {
  static all: FakeSource[] = [];
  readyState = 0;
  onopen: ((ev: Event) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  readonly listeners = new Map<string, Array<(ev: MessageEvent<string>) => void>>();
  closed = false;
  constructor(readonly url: string) {
    FakeSource.all.push(this);
  }
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
    this.readyState = 2;
  }
  send(event: LiveEvent): void {
    for (const l of this.listeners.get(event.type) ?? []) {
      l(new MessageEvent(event.type, { data: JSON.stringify(event) }));
    }
  }
  fail(closed: boolean): void {
    this.readyState = closed ? 2 : 0;
    this.onerror?.(new Event("error"));
  }
}
const factory = (url: string) => new FakeSource(url);

afterEach(() => {
  FakeSource.all = [];
  hlsState.all = [];
  hlsState.supported = true;
  vi.useRealTimers();
});

function Providers({ children }: { children: ReactNode }) {
  return (
    <ConnectionProvider initial={{ baseUrl: "", token: "" }}>
      <QueryClientProvider client={testQueryClient()}>{children}</QueryClientProvider>
    </ConnectionProvider>
  );
}

function stage(member: MemberSession | null = MEMBER, loginUrl: string | null = null) {
  const view = render(
    <Providers>
      <LiveStage member={member} loginUrl={loginUrl} source={factory} />
    </Providers>,
  );
  const source = FakeSource.all.at(-1) as FakeSource;
  const send = (event: LiveEvent) => act(() => source.send(event));
  return { ...view, source, send };
}

describe("the feed on the page", () => {
  it("starts from hello and folds every change into it", () => {
    let view = liveReducer(initialView, { type: "speaking", speaking: true });
    expect(view.now).toBeNull(); // nothing before hello
    view = liveReducer(view, { type: "hello", snapshot: NOW });
    expect(view.link).toBe("open");
    view = liveReducer(view, { type: "emotion", emotion: { name: "happy", intensity: 0.7 } });
    view = liveReducer(view, { type: "line", line: { id: 2, text: "嗨", final: false, via: "voice" } });
    view = liveReducer(view, { type: "line", line: { id: 1, text: "舊的", final: true, via: "text" } });
    expect(view.now?.emotion.name).toBe("happy");
    expect(view.now?.line?.text).toBe("嗨");
    view = liveReducer(view, { type: "pat", pats: { recent: 1, open: true } });
    view = liveReducer(view, { type: "pat", pats: { recent: 0, open: true } });
    expect(view.patSeq).toBe(1);
  });

  it("takes only live events off the wire", () => {
    expect(parseLiveEvent("not json")).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ type: "speak", text: "x" }))).toBeNull();
    expect(parseLiveEvent(JSON.stringify({ type: "speaking", speaking: true }))).toEqual({
      type: "speaking",
      speaking: true,
    });
  });

  it("reconnects by itself once the Core turned the stream away, and stops when told", () => {
    vi.useFakeTimers();
    const actions: LiveAction[] = [];
    const ctl = new AbortController();
    connectLive("/api/public/live", (a) => actions.push(a), ctl.signal, factory);
    FakeSource.all[0]?.fail(false); // the browser retries this one itself
    expect(FakeSource.all).toHaveLength(1);
    FakeSource.all[0]?.fail(true);
    expect(actions.at(-1)).toEqual({ type: "link", link: "lost" });
    vi.advanceTimersByTime(3_000);
    expect(FakeSource.all).toHaveLength(2);
    ctl.abort();
    expect(FakeSource.all[1]?.closed).toBe(true);
  });

  it("says it cannot connect where the browser has no EventSource", () => {
    const actions: LiveAction[] = [];
    connectLive("/x", (a) => actions.push(a), new AbortController().signal, null);
    expect(actions).toEqual([{ type: "link", link: "lost" }]);
  });

  it("is the page at /live, and nothing else", () => {
    expect(isLivePath("/watch")).toBe(true);
    expect(isLivePath("/watch?x=1")).toBe(true);
    expect(isLivePath("/watching")).toBe(false);
    // The admin panel's 直播 page keeps `/live`.
    expect(isLivePath("/live")).toBe(false);
    expect(isLivePath("/me")).toBe(false);
  });
});

describe("the live stage", () => {
  it("connects, then shows where she is and what she says as it arrives", () => {
    const s = stage();
    expect(screen.getByTestId("live-state")).toHaveTextContent("連線中…");
    expect(s.source.url).toBe("/api/public/live");
    s.send({ type: "hello", snapshot: NOW });
    expect(screen.getByTestId("live-state")).toHaveTextContent("她在語音頻道");
    expect(screen.getByText("她現在沒在說話")).toBeInTheDocument();
    s.send({ type: "speaking", speaking: true });
    s.send({ type: "line", line: { id: 1, text: "欸,你回來啦", final: false, via: "voice" } });
    const quote = screen.getByText("欸,你回來啦");
    expect(quote).toHaveAttribute("data-final", "false");
    expect(screen.getByText("她在語音裡說")).toBeInTheDocument();
    s.send({ type: "line", line: { id: 1, text: "欸,你回來啦", final: true, via: "voice" } });
    expect(screen.getByText("欸,你回來啦")).toHaveAttribute("data-final", "true");
  });

  it("lets a line taken back disappear", () => {
    const s = stage();
    s.send({ type: "hello", snapshot: { ...NOW, line: { id: 3, text: "我跟你說", final: false, via: "voice" } } });
    expect(screen.getByText("我跟你說")).toBeInTheDocument();
    s.send({ type: "line", line: { id: 3, text: "", final: true, via: "voice" } });
    expect(screen.queryByText("我跟你說")).toBeNull();
  });

  it("shows what she is busy with, and the song by name", () => {
    const s = stage();
    s.send({
      type: "hello",
      snapshot: {
        ...NOW,
        presence: { place: "singing", game: null },
        activity: { kind: "singing", label: "正在唱", detail: "春日影", progress: null },
      },
    });
    expect(screen.getByTestId("live-state")).toHaveTextContent("她在唱歌正在唱〈春日影〉");
  });

  it("asks a visitor to log in to pat her, and offers no pat", () => {
    stage(null, "/api/auth/oauth/login?next=%2Flive");
    expect(screen.queryByRole("button", { name: /摸摸頭/ })).toBeNull();
    expect(screen.getByRole("link", { name: /登入後摸摸她/ })).toHaveAttribute(
      "href",
      "/api/auth/oauth/login?next=%2Flive",
    );
  });

  it("closes the hand while pats are off", () => {
    const s = stage();
    s.send({ type: "hello", snapshot: { ...NOW, pats: { recent: 0, open: false } } });
    expect(screen.getByRole("button", { name: /摸摸頭/ })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("摸頭還沒開放");
  });

  it("reacts to a pat at once, then sends it", async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    mockFetch((method, url, body) => {
      calls.push({ method, path: url.pathname, body });
      return { body: { pats: { recent: 1, open: true } } };
    });
    const s = stage();
    s.send({ type: "hello", snapshot: NOW });
    await userEvent.click(screen.getByRole("button", { name: /摸摸頭/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("她感覺到了"));
    expect(calls).toEqual([{ method: "POST", path: "/api/member/live/pat", body: {} }]);
    // Her own pat coming back through the feed does not count twice.
    s.send({ type: "pat", pats: { recent: 1, open: true } });
    expect(screen.getByText("這一分鐘 1 次摸頭")).toBeInTheDocument();
  });

  it("says so in words when she has been patted too fast", async () => {
    mockFetch(() => ({ status: 429, body: { error: "too many requests" } }));
    const s = stage();
    s.send({ type: "hello", snapshot: NOW });
    await userEvent.click(screen.getByRole("button", { name: /摸摸頭/ }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("摸太快了"));
  });

  it("counts somebody else's pat without a picture to show it on", () => {
    const s = stage();
    s.send({ type: "hello", snapshot: NOW });
    s.send({ type: "pat", pats: { recent: 1, open: true } });
    expect(screen.getByText("這一分鐘 1 次摸頭")).toBeInTheDocument();
  });

  it("keeps the last picture while it reconnects, and says it is lost before any", () => {
    const s = stage();
    act(() => s.source.fail(true));
    expect(screen.getByTestId("live-state")).toHaveTextContent("連不上現場");
    const t = stage();
    t.send({ type: "hello", snapshot: NOW });
    act(() => t.source.fail(false));
    expect(screen.getAllByTestId("live-state").at(-1)).toHaveTextContent("她在語音頻道· 重新連線中…");
    expect(screen.getAllByRole("button", { name: /摸摸頭/ }).at(-1)).toBeDisabled();
  });
});

describe("the picture and the touches", () => {
  it("folds the video and where a pat landed into the feed", () => {
    let view = liveReducer(initialView, { type: "hello", snapshot: NOW });
    expect(view.now?.video).toEqual({ on: false, src: null });
    view = liveReducer(view, { type: "video", video: VIDEO_ON });
    expect(view.now?.video).toEqual(VIDEO_ON);
    view = liveReducer(view, { type: "pat", pats: { recent: 1, open: true }, spot: { x: 0.25, y: 0.5 }, part: "head" });
    expect(view.patSeq).toBe(1);
    expect(view.patSpot).toEqual({ x: 0.25, y: 0.5 });
    view = liveReducer(view, { type: "pat", pats: { recent: 2, open: true } });
    expect(view.patSpot).toBeNull();
    view = liveReducer(view, { type: "video", video: { on: false, src: null } });
    expect(view.now?.video.on).toBe(false);
    expect(parseLiveEvent(JSON.stringify({ type: "video", video: VIDEO_ON }))).toEqual({ type: "video", video: VIDEO_ON });
  });

  it("maps a touch onto the picture, not the box it is letterboxed in", () => {
    // 16:9 picture in a 4:3 box: bars above and below.
    expect(contentBox(800, 600, 1920, 1080)).toEqual({ left: 0, top: 75, width: 800, height: 450 });
    // In a wide box: bars left and right.
    expect(contentBox(1600, 450, 1920, 1080)).toEqual({ left: 400, top: 0, width: 800, height: 450 });
    expect(contentBox(800, 600, 0, 0)).toBeNull();
    expect(spotAt(400, 300, 800, 600, 1920, 1080)).toEqual({ x: 0.5, y: 0.5 });
    expect(spotAt(0, 75, 800, 600, 1920, 1080)).toEqual({ x: 0, y: 0 });
    expect(spotAt(800, 525, 800, 600, 1920, 1080)).toEqual({ x: 1, y: 1 });
    expect(spotAt(200, 75 + 225, 800, 600, 1920, 1080)).toEqual({ x: 0.25, y: 0.5 });
    expect(spotAt(400, 20, 800, 600, 1920, 1080)).toBeNull(); // on the top bar
    expect(spotAt(400, 560, 800, 600, 1920, 1080)).toBeNull(); // on the bottom bar
    expect(spotAt(100, 200, 1600, 450, 1920, 1080)).toBeNull(); // on a side bar
    expect(spotAt(400, 300, 800, 600, 0, 0)).toBeNull(); // size not known yet
  });

  describe("on the stage", () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    beforeEach(() => {
      calls.length = 0;
      mockFetch((method, url, body) => {
        calls.push({ method, path: url.pathname, body });
        return { body: { pats: { recent: 1, open: true } } };
      });
      Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: () => Promise.resolve() });
      Object.defineProperty(HTMLMediaElement.prototype, "pause", { configurable: true, value: () => {} });
      Object.defineProperty(HTMLMediaElement.prototype, "load", { configurable: true, value: () => {} });
    });

    /** The `<video>` as a 800x600 box showing a 1920x1080 picture. */
    function sized(view: ReturnType<typeof stage>) {
      const video = view.container.querySelector("video") as HTMLVideoElement;
      Object.defineProperty(video, "videoWidth", { configurable: true, value: 1920 });
      Object.defineProperty(video, "videoHeight", { configurable: true, value: 1080 });
      Object.defineProperty(video, "clientWidth", { configurable: true, value: 800 });
      Object.defineProperty(video, "clientHeight", { configurable: true, value: 600 });
      video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0, toJSON: () => ({}) });
      act(() => {
        video.dispatchEvent(new Event("loadedmetadata"));
      });
      return video;
    }

    it("shows no picture while OBS is not publishing, only her state and lines", () => {
      const s = stage();
      s.send({ type: "hello", snapshot: NOW });
      expect(s.container.querySelector("video")).toBeNull();
    });

    it("plays the picture with hls.js once OBS publishes, and drops it when it stops", async () => {
      const s = stage();
      s.send({ type: "hello", snapshot: { ...NOW, video: VIDEO_ON } });
      expect(s.container.querySelector("video")).not.toBeNull();
      await waitFor(() => expect(hlsAll()).toHaveLength(1));
      const hls = hlsAll()[0] as FakeHlsLike;
      expect(hls.source).toBe("/api/public/live/video/index.m3u8");
      expect(hls.config).toMatchObject({ lowLatencyMode: true });
      expect(screen.getByRole("button", { name: "開啟聲音" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "全螢幕" })).toBeInTheDocument();
      // The state line and the pat button stay beside the picture.
      expect(screen.getByTestId("live-state")).toHaveTextContent("她在語音頻道");
      expect(screen.getByRole("button", { name: /摸摸頭/ })).toBeEnabled();
      s.send({ type: "video", video: { on: false, src: null } });
      expect(s.container.querySelector("video")).toBeNull();
      expect(hls.destroyed).toBe(true);
    });

    it("tears the player down when the page goes", async () => {
      const s = stage();
      s.send({ type: "hello", snapshot: { ...NOW, video: VIDEO_ON } });
      await waitFor(() => expect(hlsAll()).toHaveLength(1));
      s.unmount();
      expect((hlsAll()[0] as FakeHlsLike).destroyed).toBe(true);
    });

    it("plays the playlist natively where there is no Media Source (iOS Safari)", async () => {
      hlsState.supported = false;
      const canPlay = vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue("maybe");
      const s = stage();
      s.send({ type: "hello", snapshot: { ...NOW, video: VIDEO_ON } });
      const video = s.container.querySelector("video") as HTMLVideoElement;
      await waitFor(() => expect(video.getAttribute("src")).toBe("/api/public/live/video/index.m3u8"));
      canPlay.mockRestore();
    });

    it("recovers a network error, and gives the picture up when it will not come back", async () => {
      const s = stage();
      s.send({ type: "hello", snapshot: { ...NOW, video: VIDEO_ON } });
      await waitFor(() => expect(hlsAll()).toHaveLength(1));
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const hls = hlsAll()[0] as FakeHlsLike;
      const fail = (type: string) => act(() => hls.handlers.get("hlsError")?.("hlsError", { fatal: true, type }));
      fail("mediaError");
      expect(hls.recovered).toBe(1);
      fail("networkError");
      act(() => vi.advanceTimersByTime(1_100));
      expect(hls.started).toBe(1);
      expect(s.container.querySelector("video")).not.toBeNull();
      for (let i = 0; i < 5; i++) fail("networkError");
      expect(s.container.querySelector("video")).toBeNull();
      expect(screen.getByTestId("live-state")).toHaveTextContent("直播畫面連不上");
      // After a while it is tried again.
      act(() => vi.advanceTimersByTime(RETRY_VIDEO_MS + 100));
      expect(s.container.querySelector("video")).not.toBeNull();
    });

    it("sends a touch as a spot on the picture, ignores the bars, and shows the hand at once", async () => {
      const s = stage();
      s.send({ type: "hello", snapshot: { ...NOW, video: VIDEO_ON } });
      sized(s);
      const layer = await screen.findByTestId("touch-layer");
      fireEvent.click(layer, { clientX: 400, clientY: 20 }); // the bar above the picture
      expect(calls).toEqual([]);
      fireEvent.click(layer, { clientX: 200, clientY: 300 });
      expect(s.container.querySelector("[data-spot=own]")).not.toBeNull();
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("她感覺到了"));
      expect(calls).toEqual([{ method: "POST", path: "/api/member/live/pat", body: { x: 0.25, y: 0.5 } }]);
      // Her own pat coming back with its spot does not draw a second hand.
      s.send({ type: "pat", pats: { recent: 1, open: true }, spot: { x: 0.25, y: 0.5 }, part: "body" });
      expect(s.container.querySelectorAll("[data-spot]")).toHaveLength(1);
    });

    it("keeps the button for the keyboard, which pats without a spot", async () => {
      const s = stage();
      s.send({ type: "hello", snapshot: { ...NOW, video: VIDEO_ON } });
      await userEvent.click(screen.getByRole("button", { name: /摸摸頭/ }));
      await waitFor(() => expect(calls).toHaveLength(1));
      expect(calls[0]?.body).toEqual({});
    });

    it("shows another viewer's pat as a small hand where it landed", async () => {
      const s = stage();
      s.send({ type: "hello", snapshot: { ...NOW, video: VIDEO_ON } });
      sized(s);
      s.send({ type: "pat", pats: { recent: 1, open: true }, spot: { x: 0.7, y: 0.3 }, part: "face" });
      const hand = s.container.querySelector("[data-spot=other]") as HTMLElement;
      expect(hand).not.toBeNull();
      expect(hand.style.left).toBe("70%");
      expect(hand.style.top).toBe("30%");
      expect(calls).toEqual([]);
    });

    it("does not touch while pats are closed, and a visitor is sent to log in instead", () => {
      const closed = stage();
      closed.send({ type: "hello", snapshot: { ...NOW, video: VIDEO_ON, pats: { recent: 0, open: false } } });
      expect(screen.queryByTestId("touch-layer")).toBeNull();
      expect(screen.queryByTestId("touch-login")).toBeNull();
      closed.unmount();

      const visitor = stage(null, "/api/auth/oauth/login?next=%2Flive");
      visitor.send({ type: "hello", snapshot: { ...NOW, video: VIDEO_ON } });
      expect(screen.queryByTestId("touch-layer")).toBeNull();
      expect(screen.getByTestId("touch-login")).toHaveAttribute("href", "/api/auth/oauth/login?next=%2Flive");
    });

    it("remembers that the sound was turned on", async () => {
      const s = stage();
      s.send({ type: "hello", snapshot: { ...NOW, video: VIDEO_ON } });
      await userEvent.click(screen.getByRole("button", { name: "開啟聲音" }));
      expect(localStorage.getItem("miyoria.live.sound")).toBe("on");
      expect(screen.getByRole("button", { name: "靜音" })).toBeInTheDocument();
      localStorage.clear();
    });
  });
});
