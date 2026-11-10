// The way out of the sandbox for runs that ask for the network. Docker cannot filter by host
// name, so the mechanism is topology plus one small proxy:
//
// * an `--internal` Docker network (no route to anything outside Docker) holds the run
//   container and the proxy container;
// * the proxy container (the node image running `EGRESS_PROGRAM`) is on the default bridge as
//   well, so it is the only thing that can reach the internet;
// * the run gets `HTTP_PROXY` / `HTTPS_PROXY` pointing at the proxy. A program that ignores them
//   has no other route; the proxy lets through only the configured hosts, on ports 80 and 443,
//   and never to a private, loopback, link-local or metadata address (it resolves the name
//   itself and connects to the address it checked, so a DNS answer cannot change in between).
//
// Everything here is argument building and the proxy's source; starting it is `DockerSandbox`.

import { LABEL, LABEL_INSTANCE, LABEL_KIND, NAME_PREFIX } from "./args.js";
import type { SandboxNetwork } from "./config.js";

/** Alias the proxy has on the internal network (what `HTTP_PROXY` names). */
export const EGRESS_ALIAS = "egress-proxy";

export function egressNetworkName(instance: string): string {
  return `${NAME_PREFIX}net-${instance}`;
}

export function egressProxyName(instance: string): string {
  return `${NAME_PREFIX}egress-${instance}`;
}

/** Environment a run on the egress network gets (the proxy is its only way out). */
export function proxyEnv(port: number): Record<string, string> {
  const url = `http://${EGRESS_ALIAS}:${port}`;
  return {
    HTTP_PROXY: url,
    HTTPS_PROXY: url,
    http_proxy: url,
    https_proxy: url,
    NO_PROXY: "",
    no_proxy: "",
  };
}

/** `docker network create --internal`: containers on it have no route out. */
export function networkCreateArgs(name: string, instance: string): string[] {
  return [
    "network",
    "create",
    "--internal",
    "--label",
    `${LABEL}=1`,
    "--label",
    `${LABEL_INSTANCE}=${instance}`,
    name,
  ];
}

export function networkInspectArgs(name: string): string[] {
  return ["network", "inspect", "--format", "{{.Name}}", name];
}

export function networkRemoveArgs(name: string): string[] {
  return ["network", "rm", name];
}

/** Puts the proxy on the internal network under `EGRESS_ALIAS`. */
export function networkConnectArgs(network: string, container: string): string[] {
  return ["network", "connect", "--alias", EGRESS_ALIAS, network, container];
}

/** `docker exec` that succeeds once the proxy accepts connections (inside its container). */
export function egressReadyArgs(name: string, port: number): string[] {
  const probe =
    `require("net").connect(${port}, "127.0.0.1")` +
    `.on("connect", () => process.exit(0)).on("error", () => process.exit(1))`;
  return ["exec", name, "node", "-e", probe];
}

/**
 * `docker run -d` of the proxy: the node image, read-only, no capabilities, non-root, small.
 * It starts on the default bridge (the way out); `networkConnectArgs` then adds the internal
 * network. The allowlist travels in its environment, the program in `node -e`.
 */
export function egressProxyArgs(options: {
  name: string;
  instance: string;
  image: string;
  network: SandboxNetwork;
}): string[] {
  const { name, instance, image, network } = options;
  return [
    "run",
    "--rm",
    "-d",
    "--name",
    name,
    "--label",
    `${LABEL}=1`,
    "--label",
    `${LABEL_INSTANCE}=${instance}`,
    "--label",
    `${LABEL_KIND}=egress`,
    "--pull",
    "never",
    "--log-driver",
    "none",
    "--network",
    "bridge",
    "--read-only",
    "--user",
    "65534:65534",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--ipc",
    "none",
    "--memory",
    `${network.proxy_memory_mb}m`,
    "--memory-swap",
    `${network.proxy_memory_mb}m`,
    "--cpus",
    "0.5",
    "--pids-limit",
    "64",
    "--init",
    "--env",
    `EGRESS_ALLOW=${network.allow.join(",")}`,
    "--env",
    `EGRESS_PORT=${network.proxy_port}`,
    image,
    "node",
    "-e",
    EGRESS_PROGRAM,
  ];
}

/**
 * The proxy. Plain JavaScript (`node -e`), no dependencies. Environment: `EGRESS_ALLOW` (comma
 * separated hosts and `*.suffix` patterns), `EGRESS_PORT` (0 = any, printed on stdout),
 * `EGRESS_PORTS` (ports a target may have, default `80,443`) and `EGRESS_ALLOW_PRIVATE=1`
 * (tests only: lets it reach loopback). Answers 403 to a host or port outside the list.
 */
export const EGRESS_PROGRAM = String.raw`
const http = require("http");
const net = require("net");
const dns = require("dns").promises;
const allow = (process.env.EGRESS_ALLOW || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const ports = new Set((process.env.EGRESS_PORTS || "80,443").split(",").map(Number));
const allowPrivate = process.env.EGRESS_ALLOW_PRIVATE === "1";
function hostOk(host) {
  const h = host.toLowerCase().replace(/\.$/, "");
  return allow.some((p) => (p.startsWith("*.") ? h.endsWith(p.slice(1)) && h.length > p.length - 1 : h === p));
}
function private4(a) {
  const p = a.split(".").map(Number);
  return p[0] === 0 || p[0] === 10 || p[0] === 127 || p[0] >= 224 ||
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127) || (p[0] === 169 && p[1] === 254) ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) ||
    (p[0] === 192 && p[1] === 0 && p[2] === 0) || (p[0] === 198 && (p[1] === 18 || p[1] === 19));
}
function privateAddr(a) {
  if (net.isIPv4(a)) return private4(a);
  const l = a.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  if (mapped) return private4(mapped[1]);
  return l === "::" || l === "::1" || l.startsWith("::ffff:") || /^f[cd]/.test(l) || /^fe[89ab]/.test(l);
}
async function resolve(host) {
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((x) => x.address);
  if (addrs.length === 0) throw new Error("no address");
  if (!allowPrivate && addrs.some(privateAddr)) throw new Error("private address");
  // IPv4 first: the plain-HTTP path connects to the first address only (the bridge has no IPv6).
  return addrs.sort((a, b) => Number(net.isIPv6(a)) - Number(net.isIPv6(b)));
}
function connectAny(addrs, port, done) {
  const [first, ...rest] = addrs;
  const socket = net.connect({ host: first, port }, () => done(null, socket));
  socket.once("error", (err) => {
    socket.destroy();
    if (rest.length > 0) connectAny(rest, port, done); else done(err, null);
  });
}
function split(target) {
  const m = /^(.+):(\d+)$/.exec(target);
  return m ? [m[1].replace(/^\[|\]$/g, ""), Number(m[2])] : [target, 443];
}
const server = http.createServer(async (req, res) => {
  const deny = (code, text) => { res.writeHead(code, { "content-type": "text/plain" }); res.end(text); };
  let url;
  try { url = new URL(req.url); } catch { return deny(400, "absolute URL needed"); }
  const port = Number(url.port || 80);
  if (url.protocol !== "http:" || !hostOk(url.hostname) || !ports.has(port)) return deny(403, "host not allowed");
  let addrs;
  try { addrs = await resolve(url.hostname); } catch { return deny(403, "host not allowed"); }
  const headers = { ...req.headers, host: url.host };
  for (const k of Object.keys(headers)) if (k.startsWith("proxy-")) delete headers[k];
  const out = http.request({ host: addrs[0], port, path: url.pathname + url.search, method: req.method, headers, timeout: 60000 }, (r) => {
    res.writeHead(r.statusCode || 502, r.headers);
    r.pipe(res);
  });
  out.on("error", () => deny(502, "upstream failed"));
  out.on("timeout", () => out.destroy());
  req.pipe(out);
});
server.on("connect", async (req, client, head) => {
  const [host, port] = split(req.url || "");
  const refuse = () => { client.end("HTTP/1.1 403 Forbidden\r\n\r\n"); };
  client.on("error", () => client.destroy());
  if (!hostOk(host) || !ports.has(port)) return refuse();
  let addrs;
  try { addrs = await resolve(host); } catch { return refuse(); }
  connectAny(addrs, port, (err, upstream) => {
    if (err || !upstream) return client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length > 0) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    upstream.setTimeout(300000, () => upstream.destroy());
  });
});
server.maxConnections = 64;
server.listen(Number(process.env.EGRESS_PORT || 3128), "0.0.0.0", () => {
  console.log("listening " + server.address().port);
});
`;
