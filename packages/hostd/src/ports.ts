// Ports: whether one is free, a free one from the OS, and whether something answers on one.
// Nothing here changes system settings.

import { createConnection, createServer } from "node:net";

/** `denied` is Windows refusing the bind although nothing listens: a reserved port range. */
export type PortState = "free" | "in-use" | "denied" | "error";

export type PortProbe = (port: number, host?: string) => Promise<PortState>;

/** Tries to bind the port briefly. No data is sent. */
export const probePort: PortProbe = (port, host = "127.0.0.1") =>
  new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve("in-use");
      else if (error.code === "EACCES" || error.code === "EPERM") resolve("denied");
      else resolve("error");
    });
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolve("free"));
    });
  });

/** A port the OS says is free on `host` now. Another program may take it before it is used. */
export function freePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ port: 0, host, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no port from the OS"))));
    });
  });
}

/** Whether a TCP connection to host:port succeeds within the timeout. */
export function tcpConnect(host: string, port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** What to do about a port Windows refuses to bind (the text `miyoria doctor --deep` uses too). */
export const PORT_DENIED_HINT =
  "Windows 保留了這個埠(動態埠範圍從 1024 開始時常見):用系統管理員 PowerShell 執行 net stop winnat 再 net start winnat;`miyoria doctor --deep` 有長期做法,Miyoria 不會替你改系統設定";

/** The address a local client uses to reach something bound to `bind`. */
export function localAddress(bind: string): string {
  if (bind === "0.0.0.0" || bind === "") return "127.0.0.1";
  if (bind === "::" || bind === "[::]") return "::1";
  return bind;
}

/** `host` as it goes into a URL: IPv6 addresses in brackets. */
export function urlHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
