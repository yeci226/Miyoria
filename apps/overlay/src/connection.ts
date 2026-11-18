// WebSocket client for the overlay feed. Reconnects forever with a short, capped backoff: the Stage
// restarting must never need a refresh of the OBS browser source. Replies (what became of each
// danmaku line) go back on the same socket.
import type { OverlayReply } from "@miyoria/contracts/overlay";
import { type FeedMessage, parseMessage } from "./feed.js";

export interface FeedConnectionOptions {
  url: string;
  onMessage: (m: FeedMessage) => void;
  onConnection: (connected: boolean) => void;
  minDelayMs?: number;
  maxDelayMs?: number;
}

export interface FeedConnection {
  /** Sends a reply while the socket is open; false (nothing sent) otherwise. */
  send(reply: OverlayReply): boolean;
  stop(): void;
}

export function connectFeed(o: FeedConnectionOptions): FeedConnection {
  const minDelay = o.minDelayMs ?? 500;
  const maxDelay = o.maxDelayMs ?? 5000;
  let ws: WebSocket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  let stopped = false;

  const open = (): void => {
    if (stopped) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(o.url);
    } catch {
      schedule();
      return;
    }
    ws = sock;
    sock.onopen = () => {
      attempt = 0;
      o.onConnection(true);
    };
    sock.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== "string") return;
      const m = parseMessage(ev.data);
      if (m) o.onMessage(m);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      ws = undefined;
      o.onConnection(false);
      schedule();
    };
    sock.onerror = () => sock.close();
  };

  const schedule = (): void => {
    if (stopped || timer) return;
    const delay = Math.min(maxDelay, minDelay * 2 ** attempt);
    attempt++;
    timer = setTimeout(() => {
      timer = undefined;
      open();
    }, delay);
  };

  open();
  return {
    send(reply) {
      const s = ws;
      if (s === undefined || s.readyState !== WebSocket.OPEN) return false;
      try {
        s.send(JSON.stringify(reply));
        return true;
      } catch {
        return false;
      }
    },
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      const s = ws;
      ws = undefined;
      s?.close();
    },
  };
}
