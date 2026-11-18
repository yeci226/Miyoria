// A local HTTP server that plays the hosts model files come from. The downloader only speaks https
// to hosts on its list, so the tests hand it `fixture.fetch`: it sends `https://<host>/<path>` to
// this server as `http://127.0.0.1:<port>/<path>` with the host in a header, and the server answers
// per host and path. Nothing leaves the machine.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface Route {
  body?: Buffer;
  /** Answer with this status (and no body) instead. */
  status?: number;
  /** Answer 302 to this URL. */
  location?: string;
  /** Answer a Range request with the whole file (200). */
  ignoreRange?: boolean;
  /** For the next N requests, send half the body and drop the connection. */
  cut?: number;
  /** For the next N requests, answer 503. */
  unavailable?: number;
}

export interface Hit {
  host: string;
  path: string;
  range: string;
}

export interface Fixture {
  readonly fetch: typeof fetch;
  readonly hits: Hit[];
  route(url: string, route: Route): void;
  close(): Promise<void>;
}

function answer(route: Route, req: IncomingMessage, res: ServerResponse): void {
  if (route.unavailable !== undefined && route.unavailable > 0) {
    route.unavailable -= 1;
    res.writeHead(503);
    res.end();
    return;
  }
  if (route.location !== undefined) {
    res.writeHead(302, { location: route.location });
    res.end();
    return;
  }
  if (route.status !== undefined) {
    res.writeHead(route.status);
    res.end();
    return;
  }
  const body = route.body ?? Buffer.alloc(0);
  const range = req.headers.range;
  let start = 0;
  if (range !== undefined && route.ignoreRange !== true) {
    start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    if (start >= body.length) {
      res.writeHead(416, { "content-range": `bytes */${body.length}` });
      res.end();
      return;
    }
  }
  const part = body.subarray(start);
  const headers: Record<string, string | number> = { "content-length": part.length };
  if (start > 0) headers["content-range"] = `bytes ${start}-${body.length - 1}/${body.length}`;
  res.writeHead(start > 0 ? 206 : 200, headers);
  if (route.cut !== undefined && route.cut > 0) {
    route.cut -= 1;
    res.write(part.subarray(0, Math.floor(part.length / 2)), () => {
      setTimeout(() => res.socket?.destroy(), 20);
    });
    return;
  }
  res.end(part);
}

export async function startFixture(): Promise<Fixture> {
  const routes = new Map<string, Route>();
  const hits: Hit[] = [];
  const server: Server = createServer((req, res) => {
    const host = String(req.headers["x-test-host"] ?? "");
    const path = req.url ?? "/";
    hits.push({ host, path, range: req.headers.range ?? "full" });
    const route = routes.get(`${host}${path}`);
    if (route === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    answer(route, req, res);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const fixtureFetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init?.headers);
    headers.set("x-test-host", url.hostname);
    return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, { ...init, headers });
  }) as typeof fetch;
  return {
    fetch: fixtureFetch,
    hits,
    route(url, route) {
      const u = new URL(url);
      routes.set(`${u.hostname}${u.pathname}${u.search}`, route);
    },
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
}
