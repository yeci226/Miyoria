// `miyoria host invite | join | ls | approve | remove` and the host part of `status --all`: a
// machine joins the cluster and the owner manages the machines (docs/design/v5-hostd.md §7, §10).
// Everything on the Core side goes through the admin API; everything on the joining side is a
// file (`<state>/host.key`, `[cluster]` of `host.toml`) plus, when a hostd runs here, one
// `host.relink` so it dials without a restart.

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, hostname as osHostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { ClientError } from "@miyoria/api";
import { type ClusterHostView, ClusterJoinResultSchema } from "@miyoria/contracts/api";
import {
  HOST_LINK_PATH,
  type HostInfo,
  type HostLinkState,
  type HostRelinkResult,
} from "@miyoria/contracts/host";
import {
  HOST_KEY_FILE,
  HostdClient,
  HostRpcError,
  type LoadedHostConfig,
  loadCatalog,
  loadHostConfig,
  stateLayout,
} from "@miyoria/hostd";
import type { Config } from "@miyoria/runtime/kernel";
import { cliVersion } from "../assets.js";
import { TomlDocument } from "../toml-patch.js";
import { bold, dim, green, note, ok, println, red, section, warn, yellow } from "../ui.js";
import {
  ago,
  catalogRoot,
  displayWidth,
  HostCommandError,
  type HostTarget,
  linkText,
  loadHost,
  serviceTable,
} from "./host.js";
import { loadConfig } from "./node.js";
import * as remote from "./remote.js";

/** The state folder `host.toml` names when it names none (the schema's default). */
const DEFAULT_STATE = "data/host";
/** `[modules.cluster] bind` when it is not set (packages/cluster). */
const DEFAULT_CLUSTER_BIND = "127.0.0.1:7880";
const DEFAULT_TTL_MINUTES = 10;
const MAX_TTL_MINUTES = 7 * 24 * 60;

// ---- helpers ---------------------------------------------------------------------------------

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** Local `YYYY-MM-DD HH:MM`. */
function localMinute(ts: string): string {
  const d = new Date(Date.parse(ts));
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** The message of a `ClientError` without its `admin API returned 409 Conflict:` prefix. */
function detailOf(error: ClientError): string {
  return error.message.replace(/^admin API returned \d+ [^:]*: /, "");
}

/** What a failed admin call says to the owner. Anything that is not an API failure passes. */
function coreProblem(error: unknown): unknown {
  if (!(error instanceof ClientError)) return error;
  if (error.kind === "transport") {
    return new HostCommandError(`連不上 Core 的管理 API:${error.message}(Core 有在執行嗎?)`);
  }
  switch (error.status) {
    case 401:
    case 403:
      return new HostCommandError("Core 的管理 API 不接受這個 token(檢查 MIYORIA_API_TOKEN)");
    case 503:
      return new HostCommandError(
        "Core 的 cluster 模組沒有在執行(`miyoria module list` 看狀態,它需要資料庫)",
      );
    default:
      return new HostCommandError(`Core 回應:${detailOf(error)}`);
  }
}

async function viaCore<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw coreProblem(error);
  }
}

/** Core's admin API as `config` describes it. */
async function coreOf(target: HostTarget): Promise<{ config: Config; client: remote.Remote }> {
  const config = await loadConfig(target.configPath);
  try {
    return { config, client: remote.clientFor(config) };
  } catch (error) {
    throw new HostCommandError(errorText(error));
  }
}

function statusLabelOf(status: ClusterHostView["status"], text: string): string {
  switch (status) {
    case "approved":
      return green(text);
    case "pending":
      return yellow(text);
    default:
      return red(text);
  }
}

function statusLabel(h: ClusterHostView): string {
  return statusLabelOf(h.status, h.status);
}

/** A plain table: dim header, columns padded to the widest cell (CJK counts double). */
function table(
  head: readonly string[],
  rows: ReadonlyArray<readonly string[]>,
  colour: (row: number, column: number, text: string) => string = (_r, _c, t) => t,
): string[] {
  const widths = head.map((_, i) =>
    Math.max(...[head, ...rows].map((r) => displayWidth(r[i] ?? ""))),
  );
  // Colours go on after padding, so the columns line up on the plain text.
  const line = (cells: readonly string[], paint: (column: number, text: string) => string) =>
    cells
      .map((c, i) => {
        const padding =
          i === cells.length - 1 ? "" : " ".repeat((widths[i] ?? 0) - displayWidth(c));
        return paint(i, c) + padding;
      })
      .join("  ")
      .trimEnd();
  return [
    dim(line(head, (_, t) => t)),
    ...rows.map((row, r) => line(row, (c, t) => colour(r, c, t))),
  ];
}

// ---- invite ----------------------------------------------------------------------------------

/** `host:port` or `[v6]:port` split; `null` when it is neither. */
function splitBind(bind: string): { host: string; port: string } | null {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(bind.trim());
  return m === null ? null : { host: (m[1] ?? m[2]) as string, port: m[3] as string };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "::1" || host.startsWith("127.");
}

/** This machine's first LAN address, else its name: what a wildcard bind is reached by. */
function lanAddress(): string {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) return a.address;
    }
  }
  return osHostname();
}

/** The admin API's address as another machine would use it, and whether it can. */
export function publicApiAddress(config: Config): { url: string; reachable: boolean } {
  const { bind } = remote.apiEndpoint(config);
  const parts = splitBind(bind);
  if (parts === null) return { url: `http://${bind}`, reachable: true };
  if (isLoopbackHost(parts.host)) {
    return { url: `http://${parts.host}:${parts.port}`, reachable: false };
  }
  const wildcard = parts.host === "0.0.0.0" || parts.host === "::";
  const host = wildcard ? lanAddress() : parts.host;
  return {
    url: `http://${host.includes(":") ? `[${host}]` : host}:${parts.port}`,
    reachable: true,
  };
}

export interface InviteOptions {
  name?: string;
  /** Minutes the code works; default 10. */
  ttlMinutes?: number;
}

export async function invite(target: HostTarget, options: InviteOptions = {}): Promise<void> {
  const ttl = options.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_TTL_MINUTES) {
    throw new HostCommandError(`--ttl 要是 1 到 ${MAX_TTL_MINUTES} 的整數(分鐘)`);
  }
  const { config, client } = await coreOf(target);
  const made = await viaCore(() =>
    client.rpc.cluster.invite({
      body: { ttl_s: ttl * 60, ...(options.name !== undefined ? { name: options.name } : {}) },
    }),
  );
  const address = publicApiAddress(config);
  const nameArg = options.name !== undefined ? ` --name ${options.name}` : "";
  ok(`邀請碼 ${bold(made.code)}`);
  println(
    `   有效到 ${localMinute(made.expires_at)}(${ttl} 分鐘內),只能用一次${
      options.name !== undefined ? `,只給叫 ${options.name} 的電腦` : ""
    }`,
  );
  println("\n在要加入的那台電腦上執行:");
  println(`  ${bold(`miyoria host join ${address.url} --code ${made.code}${nameArg}`)}`);
  if (!address.reachable) {
    warn(
      `Core 的管理 API 只聽 ${remote.apiEndpoint(config).bind}(本機),別台電腦連不到它。要讓別台電腦加入,把 [modules.api] bind 設成這台電腦的區網或 tailnet 位址(例如 192.168.1.10:7878)再重啟 core,並把上面指令裡的位址換成那個`,
    );
  }
}

// ---- join ------------------------------------------------------------------------------------

export interface JoinOptions {
  /** The Core's admin API base URL (not with `local`). */
  coreUrl?: string;
  code?: string;
  name?: string;
  /** This machine runs Core: no code, the admin API makes the host. */
  local?: boolean;
  force?: boolean;
}

/** `192.168.1.10:7878` and `http://core/` both become a base URL without a trailing slash. */
export function normalizeCoreUrl(text: string): string {
  const trimmed = text.trim();
  const withScheme = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new HostCommandError(`\`${text}\` 不是網址(例如 http://192.168.1.10:7878)`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new HostCommandError("Core 的位址要用 http:// 或 https://");
  }
  return url.origin;
}

/** Where this machine's state folder is: `host.toml`'s `[paths] state`, else the default. */
function stateRootOf(target: HostTarget): { root: string; host: LoadedHostConfig | null } {
  if (existsSync(target.hostToml)) {
    const host = loadHostConfig(target.hostToml);
    return { root: host.state.root, host };
  }
  return { root: stateLayout(resolve(dirname(target.hostToml), DEFAULT_STATE)).root, host: null };
}

/**
 * `<state>/host.key`, as JSON `{ id, key }`, readable by this user only where the platform can.
 * `local: true` marks a host made through the admin API for the machine Core runs on (`join
 * --local`, or `up` on its own): only those are approved again by `up` when the services change.
 */
export function writeHostKey(
  stateRoot: string,
  id: string,
  key: string,
  options: { local?: boolean } = {},
): string {
  const file = join(stateRoot, HOST_KEY_FILE);
  mkdirSync(stateRoot, { recursive: true });
  const body = options.local === true ? { id, key, local: true } : { id, key };
  writeFileSync(file, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  if (process.platform !== "win32") chmodSync(file, 0o600);
  return file;
}

/**
 * Points `host.toml` at Core: `[cluster] url`, and `name` when it is given. Creates a minimal
 * file when there is none; an existing file keeps its other content and comments.
 */
export function writeClusterToml(hostToml: string, url: string, name: string): void {
  if (!existsSync(hostToml)) {
    mkdirSync(dirname(hostToml), { recursive: true });
    writeFileSync(
      hostToml,
      `name = ${JSON.stringify(name)}\n\n[cluster]\nurl = ${JSON.stringify(url)}\n`,
      "utf8",
    );
    return;
  }
  const doc = TomlDocument.parse(readFileSync(hostToml, "utf8"));
  doc.set(["cluster", "url"], url);
  if (doc.get(["name"]) !== name) doc.set(["name"], name);
  writeFileSync(hostToml, doc.toString(), "utf8");
}

/** What asking hostd to dial Core came to. */
export type RelinkResult =
  | { kind: "no-daemon" }
  | { kind: "old-daemon" }
  | { kind: "failed"; reason: string }
  | { kind: "link"; link: HostLinkState };

/** Asks the hostd of `stateRoot` to dial Core now (`host.relink`) and waits for the answer. */
export async function relink(stateRoot: string): Promise<RelinkResult> {
  const daemon = await HostdClient.connect(stateRoot);
  if (daemon === null) return { kind: "no-daemon" };
  try {
    let link = (await daemon.call<HostRelinkResult>("host.relink")).link;
    for (let i = 0; i < 25 && link === "connecting"; i++) {
      await sleep(300);
      link = (await daemon.call<HostInfo>("host.info")).link ?? "none";
    }
    return { kind: "link", link };
  } catch (error) {
    if (error instanceof HostRpcError && error.code === -32601) return { kind: "old-daemon" };
    return { kind: "failed", reason: errorText(error) };
  }
}

/** What `host join` says when hostd answers `host.relink`, or when it cannot. */
async function relinkDaemon(stateRoot: string): Promise<void> {
  const result = await relink(stateRoot);
  switch (result.kind) {
    case "no-daemon":
      note("這台的 hostd 沒有在執行:`miyoria up` 啟動時會連上 Core");
      return;
    case "old-daemon":
      warn("這個 hostd 不認得 host.relink(版本太舊):`miyoria down` 之後再 `miyoria up`");
      return;
    case "failed":
      warn(`請 hostd 連上 Core 失敗:${result.reason}(\`miyoria down\` 再 \`miyoria up\` 也可以)`);
      return;
    case "link":
      println(`hostd 與 Core 的連線:${linkText(result.link)}`);
  }
}

/** The key and `[cluster]` are in place: say so, tell hostd, say what is left. */
async function finishJoin(
  stateRoot: string,
  name: string,
  approvedAlready: readonly string[] | null,
): Promise<void> {
  await relinkDaemon(stateRoot);
  if (approvedAlready === null) {
    println(
      `\n還差一步:在 Core 那台執行 ${bold(`miyoria host approve ${name}`)}(或用面板)核准這台電腦;核准之前它的服務不會被使用`,
    );
  } else {
    ok(
      `已核准:${approvedAlready.join("、") || "(host.toml 沒有啟用任何服務)"}。這台電腦不需要再核准`,
    );
  }
}

function joinFailure(url: string, status: number, body: string, retryAfter: string | null): Error {
  let detail = body.trim();
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") detail = parsed.error;
  } catch {
    // not JSON: the text as it is
  }
  switch (status) {
    case 403:
      return new HostCommandError(
        "邀請碼不能用:不存在、已用過或已過期。到 Core 那台重新執行 `miyoria host invite`",
      );
    case 409:
      return new HostCommandError(
        `Core 不接受這個名字:${detail}。用 --name 換一個,邀請碼沒有被用掉`,
      );
    case 429: {
      const secs = Number.parseInt(retryAfter ?? "", 10);
      return new HostCommandError(
        `試太多次了,Core 暫時不理這個位址${Number.isFinite(secs) ? `;${secs} 秒後再試` : ",稍後再試"}`,
      );
    }
    case 503:
      return new HostCommandError("Core 的 cluster 模組沒有在執行,現在不能加入");
    case 404:
      return new HostCommandError(
        `${url} 沒有 /api/cluster/join:這不像 Miyoria Core 的管理 API 位址,或 Core 太舊`,
      );
    default:
      return new HostCommandError(`Core 回應 ${status}${detail !== "" ? `:${detail}` : ""}`);
  }
}

/** The OS host name as a Core host name: lower case, the characters a name may carry. */
function osName(): string {
  return osHostname().toLowerCase() || "host";
}

/** `miyoria host join <core-url> --code CODE`: one call with the code, then two files. */
async function joinRemote(target: HostTarget, options: JoinOptions): Promise<void> {
  if (options.coreUrl === undefined) throw new HostCommandError("缺少 Core 的位址:<core-url>");
  if (options.code === undefined || options.code.trim() === "") {
    throw new HostCommandError("缺少邀請碼:--code(在 Core 那台執行 `miyoria host invite` 取得)");
  }
  const base = normalizeCoreUrl(options.coreUrl);
  const { root, host } = stateRootOf(target);
  const keyFile = join(root, HOST_KEY_FILE);
  if (existsSync(keyFile) && options.force !== true) {
    throw new HostCommandError(
      `這台已經加入過一個 Core(${keyFile} 存在)。要換成別的,先在原來的 Core 上 \`miyoria host remove\`,再加 --force`,
    );
  }
  const name = options.name ?? host?.config.name ?? osName();
  // Fail on an unwritable folder before the code is used up.
  try {
    mkdirSync(root, { recursive: true });
  } catch (error) {
    throw new HostCommandError(`不能寫入 ${root}:${errorText(error)}`);
  }

  let response: Response;
  try {
    response = await fetch(`${base}/api/cluster/join`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: options.code.trim(),
        name,
        platform: process.platform,
        version: cliVersion(),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : null;
    throw new HostCommandError(
      `連不上 ${base}:${cause !== null ? cause.message : errorText(error)}。位址對嗎?Core 的 [modules.api] bind 是不是只聽本機?`,
    );
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw joinFailure(base, response.status, text, response.headers.get("retry-after"));
  }
  let joined: ReturnType<typeof ClusterJoinResultSchema.parse>;
  try {
    joined = ClusterJoinResultSchema.parse(JSON.parse(text));
  } catch {
    throw new HostCommandError(`${base} 的回答不是 Miyoria Core 的加入結果`);
  }

  const file = writeHostKey(root, joined.host_id, joined.key);
  writeClusterToml(target.hostToml, joined.link_url, name);
  ok(`已加入 Core,名字 ${bold(name)}`);
  note(`金鑰寫在 ${file}(不要給別人);${target.hostToml} 的 [cluster] url = ${joined.link_url}`);
  await finishJoin(root, name, null);
}

/** The capabilities every enabled service of `host.toml` provides, per the catalog. */
export function localCapabilities(target: HostTarget, host: LoadedHostConfig): string[] {
  const catalog = loadCatalog(catalogRoot(target.hostToml));
  const caps = new Set<string>();
  for (const [name, service] of Object.entries(host.config.services)) {
    if (!service.enabled) continue;
    for (const c of catalog.services.get(name)?.descriptor.provides ?? []) caps.add(c);
  }
  return [...caps].sort();
}

/** `ws://127.0.0.1:<port>/cluster-link` from `[modules.cluster] bind`. */
export function localLinkUrl(config: Config): string {
  const section = config.module("cluster").config;
  const bind =
    section !== null && typeof section === "object" && !Array.isArray(section)
      ? section.bind
      : undefined;
  const parts = splitBind(typeof bind === "string" && bind !== "" ? bind : DEFAULT_CLUSTER_BIND);
  return `ws://127.0.0.1:${parts?.port ?? "7880"}${HOST_LINK_PATH}`;
}

/** What creating this machine's host on a local Core left behind. */
interface LocalHost {
  name: string;
  capabilities: string[];
  keyFile: string;
}

/**
 * Makes this machine's host on Core through the admin API, already approved for what its enabled
 * services provide, and writes `host.key` (marked local) and `[cluster] url`. Shared by `join
 * --local` and by `up`.
 */
async function createLocalHost(
  target: HostTarget,
  host: LoadedHostConfig,
  name: string,
): Promise<LocalHost> {
  const { config, client } = await coreOf(target);
  const capabilities = localCapabilities(target, host);
  let created: { id: string; name: string; key: string };
  try {
    created = await client.rpc.cluster.create({ body: { name, capabilities } });
  } catch (error) {
    if (error instanceof ClientError && error.status === 409) {
      throw new HostCommandError(
        `Core 裡已經有叫 ${name} 的電腦:先 \`miyoria host remove ${name}\` 再重做,或用 --name 換個名字`,
      );
    }
    throw coreProblem(error);
  }
  const keyFile = writeHostKey(host.state.root, created.id, created.key, { local: true });
  writeClusterToml(target.hostToml, localLinkUrl(config), name);
  return { name, capabilities, keyFile };
}

/** `miyoria host join --local`: the machine Core runs on; the admin token is the credential. */
async function joinLocal(target: HostTarget, options: JoinOptions): Promise<void> {
  if (options.code !== undefined) throw new HostCommandError("--local 不用邀請碼");
  const host = loadHost(target);
  const keyFile = join(host.state.root, HOST_KEY_FILE);
  if (existsSync(keyFile) && options.force !== true) {
    throw new HostCommandError(
      `這台已經加入過 Core(${keyFile} 存在)。要重做,先 \`miyoria host remove <名字>\`,再加 --force`,
    );
  }
  const made = await createLocalHost(target, host, options.name ?? host.config.name);
  ok(`這台電腦已加入本機的 Core,名字 ${bold(made.name)}`);
  note(`金鑰寫在 ${made.keyFile}(不要給別人)`);
  await finishJoin(host.state.root, made.name, made.capabilities);
}

export function joinHost(target: HostTarget, options: JoinOptions): Promise<void> {
  return options.local === true ? joinLocal(target, options) : joinRemote(target, options);
}

// ---- the machine Core runs on links itself (`up`) ---------------------------------------------

/** `host.key` of this machine, when it can be read. */
function readKeyFile(file: string): { id: string; local: boolean } | null {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown; local?: unknown };
    return typeof raw.id === "string" ? { id: raw.id, local: raw.local === true } : null;
  } catch {
    return null;
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** The one line `up` prints about the link state, as a clause. */
function linkClause(result: RelinkResult): string {
  switch (result.kind) {
    case "link":
      return result.link === "connected" ? "已連上" : `連線狀態:${result.link}`;
    case "no-daemon":
      return "hostd 沒有在執行";
    case "old-daemon":
      return "這個 hostd 不認得 host.relink,`miyoria down` 再 `miyoria up` 就會連上";
    case "failed":
      return `請 hostd 連上失敗:${result.reason}`;
  }
}

/**
 * `miyoria up` on the machine Core runs on, once Core answers. Without a `host.key` and without a
 * `[cluster] url` it does what `host join --local` does; a host it made itself (`"local": true` in
 * `host.key`) is approved again when the services of `host.toml` changed. A host that joined with a
 * code, or was linked by hand, is never touched. One line says what happened; a problem is a
 * line too, never an error: `up` goes on.
 */
export async function selfLink(target: HostTarget, host: LoadedHostConfig): Promise<void> {
  const keyFile = join(host.state.root, HOST_KEY_FILE);
  try {
    if (!existsSync(keyFile)) {
      if (host.config.cluster?.url !== undefined) return; // pointed at a Core by hand
      const made = await createLocalHost(target, host, host.config.name);
      const link = await relink(host.state.root);
      ok(
        `這台電腦已連上本機的 Core(名字 ${made.name},核准:${made.capabilities.join("、") || "沒有"});${linkClause(link)}`,
      );
      return;
    }
    const key = readKeyFile(keyFile);
    if (key === null || !key.local) return; // joined with a code: somebody else's business
    const { client } = await coreOf(target);
    const hosts = await viaCore(() => client.rpc.cluster.hosts());
    const mine = hosts.find((h) => h.id === key.id);
    if (mine === undefined) {
      warn(
        `Core 裡沒有這台電腦了(${key.id}):\`miyoria host join --local --force\` 重新加入,沒有自動連上`,
      );
      return;
    }
    const wanted = localCapabilities(target, host);
    if (mine.status === "revoked") {
      warn(`${mine.name} 在 Core 裡被撤銷了,沒有自動核准`);
      return;
    }
    if (mine.status === "approved" && sameSet(mine.capabilities, wanted)) return;
    const view = await viaCore(() =>
      client.rpc.cluster.approve({ params: { name: mine.name }, body: { capabilities: wanted } }),
    );
    ok(`已重新核准這台電腦(${view.name}):${view.capabilities.join("、") || "沒有"}`);
  } catch (error) {
    warn(`這台沒有自動連上本機的 Core:${errorText(error)}`);
  }
}

// ---- ls --------------------------------------------------------------------------------------

function connectedText(h: ClusterHostView, now: number): string {
  if (!h.connected) return dim("未連線");
  const since =
    h.connected_since !== null ? `(${ago(now - Date.parse(h.connected_since))}前起)` : "";
  return `${green("已連線")}${since}`;
}

function lastSeen(h: ClusterHostView, now: number): string {
  return h.last_seen_at === null ? "-" : `${ago(now - Date.parse(h.last_seen_at))}前`;
}

export function hostTable(hosts: readonly ClusterHostView[], now = Date.now()): string[] {
  const head = ["名稱", "狀態", "連線", "核准的能力", "平台", "版本", "最後上線"];
  // The colours go on after padding, so the columns line up on the plain text.
  const rows = hosts.map((h) => [
    h.name,
    h.status,
    h.connected
      ? `已連線${h.connected_since !== null ? `(${ago(now - Date.parse(h.connected_since))}前起)` : ""}`
      : "未連線",
    h.capabilities.join("、") || "-",
    h.platform ?? "-",
    h.version ?? "-",
    lastSeen(h, now),
  ]);
  return table(head, rows, (r, column, text) => {
    const h = hosts[r];
    if (h === undefined) return text;
    if (column === 1) return statusLabelOf(h.status, text);
    if (column === 2) return h.connected ? green(text) : dim(text);
    return text;
  });
}

export async function ls(target: HostTarget): Promise<void> {
  const { client } = await coreOf(target);
  const hosts = await viaCore(() => client.rpc.cluster.hosts());
  if (hosts.length === 0) {
    println(
      "Core 還沒有任何電腦。`miyoria host invite` 產生邀請碼,或 `miyoria host join --local` 加入這一台",
    );
    return;
  }
  for (const line of hostTable(hosts)) println(line);
}

// ---- approve ---------------------------------------------------------------------------------

/** What a host's services provide, without the ones that are disabled. */
export function providedBy(info: Pick<HostInfo, "services">): string[] {
  const caps = new Set<string>();
  for (const s of info.services) {
    if (s.state === "disabled") continue;
    for (const c of s.provides) caps.add(c);
  }
  return [...caps].sort();
}

export async function approve(
  target: HostTarget,
  name: string,
  capabilities: readonly string[],
): Promise<void> {
  const { client } = await coreOf(target);
  let asked = [...new Set(capabilities)];
  if (asked.length === 0) {
    let info: Awaited<ReturnType<typeof client.rpc.cluster.info>>;
    try {
      info = await client.rpc.cluster.info({ params: { name } });
    } catch (error) {
      if (error instanceof ClientError && error.status === 404) {
        throw new HostCommandError(`Core 沒有叫 ${name} 的電腦(\`miyoria host ls\` 看有哪些)`);
      }
      if (error instanceof ClientError && error.status === 409) {
        throw new HostCommandError(
          `${name} 現在沒有連線,Core 不知道它提供什麼:請自己列出要核准的能力,例如 \`miyoria host approve ${name} asr tts\``,
        );
      }
      throw coreProblem(error);
    }
    asked = providedBy(info);
    if (asked.length === 0) {
      throw new HostCommandError(`${name} 沒有回報任何服務能力:請自己列出要核准的能力`);
    }
  }
  let view: ClusterHostView;
  try {
    view = await client.rpc.cluster.approve({ params: { name }, body: { capabilities: asked } });
  } catch (error) {
    if (error instanceof ClientError && error.status === 404) {
      throw new HostCommandError(`Core 沒有叫 ${name} 的電腦(\`miyoria host ls\` 看有哪些)`);
    }
    throw coreProblem(error);
  }
  ok(`已核准 ${bold(view.name)}:${view.capabilities.join("、") || "(沒有能力)"}`);
}

// ---- remove ----------------------------------------------------------------------------------

export async function removeHost(
  target: HostTarget,
  name: string,
  options: { yes: boolean; confirm: ((message: string) => Promise<boolean>) | null },
): Promise<void> {
  const { client } = await coreOf(target);
  const hosts = await viaCore(() => client.rpc.cluster.hosts());
  const found = hosts.find((h) => h.name === name);
  if (found === undefined) {
    throw new HostCommandError(`Core 沒有叫 ${name} 的電腦(\`miyoria host ls\` 看有哪些)`);
  }
  if (!options.yes) {
    if (options.confirm === null) {
      throw new HostCommandError("不是互動式終端機:要移除請加 -y");
    }
    const yes = await options.confirm(
      `移除 ${name}(${found.status}${found.connected ? ",目前連線中" : ""})?它的金鑰會失效、連線會斷開、它的服務會從 Core 的端點移除`,
    );
    if (!yes) {
      note("沒有移除");
      return;
    }
  }
  try {
    await client.rpc.cluster.remove({ params: { name } });
  } catch (error) {
    if (error instanceof ClientError && error.status === 404) {
      throw new HostCommandError(`${name} 已經不在 Core 裡了`);
    }
    throw coreProblem(error);
  }
  ok(`已移除 ${name}`);
}

// ---- status --all ----------------------------------------------------------------------------

/** The hosts of Core and, for each connected one, its services: `status --all`. */
export async function hostsSection(client: remote.Remote): Promise<void> {
  let hosts: ClusterHostView[];
  try {
    hosts = await client.rpc.cluster.hosts();
  } catch (error) {
    const problem = coreProblem(error);
    println(`\n${dim(`(查不到各台電腦:${errorText(problem)})`)}`);
    return;
  }
  section("所有電腦(Core)");
  if (hosts.length === 0) {
    println(dim("Core 還沒有任何電腦(`miyoria host invite`)"));
    return;
  }
  const now = Date.now();
  for (const h of hosts) {
    println(
      `\n${bold(h.name)}  ${statusLabel(h)}  ${h.connected ? connectedText(h, now) : `${dim("未連線")}  ${dim(`最後上線 ${lastSeen(h, now)}`)}`}${
        h.capabilities.length > 0 ? `  ${dim(`核准:${h.capabilities.join("、")}`)}` : ""
      }`,
    );
    if (!h.connected) continue;
    try {
      const info = await client.rpc.cluster.info({ params: { name: h.name } });
      if (info.services.length === 0) println(dim("  沒有任何服務"));
      for (const line of serviceTable(info.services, now)) println(`  ${line}`);
    } catch (error) {
      println(dim(`  (查不到服務:${errorText(coreProblem(error))})`));
    }
  }
}
