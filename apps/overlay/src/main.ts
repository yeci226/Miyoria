import "./style.css";
import type { OverlayReply } from "@miyoria/contracts/overlay";
import { mountBackdrop } from "./backdrop.js";
import { parseConfig } from "./config.js";
import { connectFeed, type FeedConnection } from "./connection.js";
import { startDemo } from "./demo.js";
import { startKaraokeDemo } from "./karaoke-demo.js";
import { Overlay } from "./view.js";

const cfg = parseConfig(window.location.search, window.location);
document.documentElement.style.setProperty("--scale", String(cfg.scale));
document.documentElement.dataset.layout = cfg.layout;

const root = document.getElementById("app");
if (!root) throw new Error("#app is missing");

if (cfg.layer === "backdrop") {
  // A still page: no feed, no frame loop.
  mountBackdrop(root, cfg.layout);
} else {
  // The page's answers about danmaku lines go back on the feed socket (only while it is open; the
  // node counts what was not answered before a drop as lost). The demo has nobody to answer.
  let feed: FeedConnection | undefined;
  const reply = (r: OverlayReply): void => {
    if (cfg.demo) console.debug("overlay reply", r);
    else feed?.send(r);
  };
  const overlay = new Overlay(root, cfg, reply);

  if (cfg.demo) {
    overlay.dispatch({ type: "connection", connected: true });
    (cfg.karaokeDemo ? startKaraokeDemo : startDemo)((m) => overlay.dispatch(m));
  } else {
    // `danmaku_ready` goes out from the view on each (re)connect, when its danmaku layer is on.
    feed = connectFeed({
      url: cfg.ws,
      onMessage: (m) => overlay.dispatch(m),
      onConnection: (connected) => overlay.dispatch({ type: "connection", connected }),
    });
  }

  const tick = (now: number): void => {
    overlay.frame(now);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
