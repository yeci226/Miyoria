// Settings shared by `miyoria init` and `miyoria config`: field specs, asking for one field
// (Enter keeps the current value), and the steps that touch several keys at once (LLM,
// database, OAuth, tokens). What a field's value may be is checked by the root schema where it
// describes the key (`validate.ts`); the labels, choices and defaults here are the prompts'.

import { randomBytes } from "node:crypto";
import type { Prompter } from "./prompt.js";
import { maskUrl, singleRef } from "./refs.js";
import {
  formatKey,
  isTable,
  parseKey,
  plainValue,
  type TomlDocument,
  type TomlValue,
} from "./toml-patch.js";
import type { Check, SchemaContext } from "./validate.js";
import * as validate from "./validate.js";
import type { Workspace } from "./workspace.js";

export const DEFAULT_REDIRECT_URI = "http://127.0.0.1:7878/api/auth/oauth/callback";
export const DEFAULT_SQLITE_URL = "sqlite:data/miyoria.db";
export const LLM_KINDS = ["deepseek", "openai", "openai-compatible", "opencode"] as const;

export function defaultBaseUrl(kind: string): string | undefined {
  switch (kind) {
    case "deepseek":
      return "https://api.deepseek.com";
    case "openai":
      return "https://api.openai.com/v1";
    case "opencode":
      return "https://opencode.ai/inference/go/v1";
    default:
      return undefined;
  }
}

function defaultModel(kind: string): string {
  return kind === "deepseek" ? "deepseek-chat" : "";
}

function apiKeyVar(kind: string): string {
  return kind === "opencode" ? "OPENCODE_API_KEY" : "LLM_API_KEY";
}

export type Kind =
  | { type: "text" }
  | { type: "url" }
  | { type: "ws_url" }
  | { type: "bind" }
  | { type: "port" }
  | { type: "bool" }
  /** Optional Discord id. */
  | { type: "id" }
  /** Comma separated Discord ids, stored as an array of strings. */
  | { type: "ids" }
  | { type: "secret" }
  | { type: "choice"; options: readonly string[] };

const TEXT: Kind = { type: "text" };
const URL_KIND: Kind = { type: "url" };
const SECRET: Kind = { type: "secret" };

/**
 * The CLI's own check of a kind of field. `described`: the root schema describes the key, so
 * the range of a port and what a list of ids may hold are its to say; the formats it does not
 * say (a URL, `host:port`, one Discord id) are checked either way.
 */
function formatCheck(kind: Kind, described: boolean): Check | undefined {
  switch (kind.type) {
    case "url":
      return validate.httpUrl;
    case "ws_url":
      return validate.wsUrl;
    case "bind":
      return validate.bind;
    case "port":
      return described ? undefined : validate.port;
    case "id":
      return validate.optionalDiscordId;
    case "ids":
      return described ? undefined : validate.discordIds;
    default:
      return undefined;
  }
}

/** The prompt's check of a field: the root schema where it describes the key, then the format. */
export function checkOf(field: Field, ctx: SchemaContext | null): Check | undefined {
  const path = field.key === null ? null : parseKey(field.key);
  const described = path !== null && validate.described(ctx, path);
  const format = formatCheck(field.kind, described);
  if (path === null || !described) return format;
  return (s) => {
    if (field.kind.type === "port" && !/^\d+$/.test(s.trim())) return "port 要是整數";
    return validate.schemaCheck(ctx, path, typed(field.kind, s)) ?? format?.(s) ?? null;
  };
}

/**
 * One editable setting: a `miyoria.toml` key, a `.env` variable, or a key whose secret lives in
 * `.env` (`env` names the variable to use when the key has no `${VAR}` reference yet).
 */
export interface Field {
  label: string;
  key: string | null;
  env: string | null;
  kind: Kind;
  default: string;
}

export function tomlField(
  label: string,
  key: string,
  kind: Kind,
  extra: Partial<Field> = {},
): Field {
  return { label, key, env: null, kind, default: "", ...extra };
}

export function envField(label: string, env: string, kind: Kind): Field {
  return { label, key: null, env, kind, default: "" };
}

export const PROFILE = tomlField("角色(profiles/ 底下的資料夾名稱)", "core.profile", TEXT);
export const DATABASE = tomlField("DATABASE_URL", "core.database_url", TEXT, {
  env: "DATABASE_URL",
});
export const DISCORD_TOKEN = tomlField(
  "Discord bot token(可留空,之後再填)",
  'modules."platform.discord.bot".token',
  SECRET,
  { env: "DISCORD_BOT_TOKEN" },
);
export const DISCORD_GUILDS = tomlField(
  "立即生效的伺服器 id(逗號分隔,空 = 全域)",
  'modules."platform.discord.bot".command_guilds',
  { type: "ids" },
);
export const OWNER = envField("你的 Discord user id(擁有者權限,可留空)", "MIYORIA_OWNER_ID", {
  type: "id",
});
export const OAUTH_CLIENT_ID = tomlField(
  "Discord OAuth client id(Developer Portal → OAuth2)",
  "modules.api.discord_oauth.client_id",
  { type: "id" },
  { env: "DISCORD_CLIENT_ID" },
);
export const OAUTH_SECRET = tomlField(
  "Discord OAuth client secret",
  "modules.api.discord_oauth.client_secret",
  SECRET,
  { env: "DISCORD_CLIENT_SECRET" },
);
export const OAUTH_REDIRECT = tomlField(
  "OAuth redirect URI",
  "modules.api.discord_oauth.redirect_uri",
  URL_KIND,
  { default: DEFAULT_REDIRECT_URI },
);
export const API_BIND = tomlField(
  "Admin API / 面板位址",
  "modules.api.bind",
  { type: "bind" },
  {
    default: "127.0.0.1:7878",
  },
);

export const VOICE: readonly Field[] = [
  tomlField("ASR worker URL", "speech.asr.local.url", URL_KIND, {
    default: "http://127.0.0.1:8003",
  }),
  tomlField("TTS worker URL", "speech.tts.local.url", URL_KIND, {
    default: "http://127.0.0.1:8002",
  }),
  tomlField("TTS 聲音", "speech.tts.local.voice", TEXT),
  tomlField(
    "語音節點連入位址(voice link)",
    'modules."voice.link".bind',
    { type: "bind" },
    {
      default: "127.0.0.1:7879",
    },
  ),
  tomlField(
    "收音同意",
    "modules.voice.consent",
    { type: "choice", options: ["opt-out", "opt-in"] },
    {
      default: "opt-out",
    },
  ),
  tomlField(
    "有人插話時",
    "modules.voice.barge_in",
    // `[modules.voice] barge_in`'s own values and default (`selective`).
    { type: "choice", options: ["selective", "stop", "ignore"] },
    {
      default: "selective",
    },
  ),
];

export const STAGE: readonly Field[] = [
  tomlField(
    "Stage 節點連到 core 的位址",
    "stage.core_url",
    { type: "ws_url" },
    {
      default: "ws://127.0.0.1:7882/stage-link",
    },
  ),
  tomlField(
    "core 等 Stage 節點連入的位址",
    'modules."stage.link".bind',
    { type: "bind" },
    {
      default: "127.0.0.1:7882",
    },
  ),
  tomlField("VTube Studio", "stage.vts.enabled", { type: "bool" }, { default: "true" }),
  tomlField("OBS", "stage.obs.enabled", { type: "bool" }, { default: "false" }),
  tomlField("OBS 主機", "stage.obs.host", TEXT, { default: "127.0.0.1" }),
  tomlField("OBS WebSocket port", "stage.obs.port", { type: "port" }, { default: "4455" }),
  tomlField("OBS WebSocket 密碼", "stage.obs.password", SECRET, { env: "OBS_PASSWORD" }),
];

/** Every static field, for `miyoria config set` on known secret keys. */
export function allFields(): Field[] {
  return [
    PROFILE,
    DATABASE,
    DISCORD_TOKEN,
    DISCORD_GUILDS,
    OWNER,
    OAUTH_CLIENT_ID,
    OAUTH_SECRET,
    OAUTH_REDIRECT,
    API_BIND,
    ...VOICE,
    ...STAGE,
  ];
}

/** `[variable, keys referencing it, what uses it]`. */
export const TOKENS: ReadonlyArray<readonly [string, readonly string[], string]> = [
  ["MIYORIA_API_TOKEN", ["modules.api.token"], "Admin API(CLI、面板)"],
  [
    "VOICE_LINK_TOKEN",
    ['modules."voice.link".token'],
    "語音節點(apps/voice-node 的 .env 要填同一個)",
  ],
  ["STAGE_LINK_TOKEN", ['modules."stage.link".token', "stage.token"], "Stage 節點"],
];

/** 52 random hex characters (208 bits); only authenticates local nodes / the CLI. */
export function newToken(): string {
  return randomBytes(26).toString("hex");
}

/** Current value of a field (references expanded; empty when unset). */
export interface Current {
  value: string;
  /** The key (or variable) exists at all. */
  present: boolean;
}

export function current(ws: Workspace, field: Field): Current {
  if (field.key === null) {
    const found = ws.lookup(field.env ?? "");
    return { present: found !== undefined, value: found?.[0] ?? "" };
  }
  const value = ws.item(field.key);
  if (value === undefined || isTable(value)) return { value: "", present: false };
  return {
    value: typeof value === "string" ? ws.resolve(value)[0] : plainValue(value),
    present: true,
  };
}

/** `label  [current]` for pick lists; secrets only say whether they are set. */
export function fieldLabel(ws: Workspace, field: Field): string {
  const cur = current(ws, field);
  let shown: string;
  if (field.kind.type === "secret") shown = cur.value === "" ? "未設定" : "已設定";
  else if (cur.value === "") shown = field.default === "" ? "未設定" : `預設 ${field.default}`;
  else shown = maskUrl(cur.value);
  return `${field.label}  [${shown}]`;
}

export function secretLabel(label: string, isSet: boolean): string {
  return isSet ? `${label} [已設定(按 Enter 保留)]` : `${label} [未設定,可留空]`;
}

/**
 * Asks for one field with the current value as default; writes only when the answer differs.
 * Returns whether anything changed.
 */
export async function ask(p: Prompter, ws: Workspace, field: Field): Promise<boolean> {
  const cur = current(ws, field);
  let next: string;
  const kind = field.kind;
  if (kind.type === "secret") {
    const typed = (await p.secret(secretLabel(field.label, cur.value !== ""))).trim();
    if (typed === "") return false;
    next = typed;
  } else if (kind.type === "choice") {
    const want = cur.value === "" ? field.default : cur.value;
    const start = Math.max(kind.options.indexOf(want), 0);
    next = kind.options[await p.select(field.label, [...kind.options], start)] as string;
  } else if (kind.type === "bool") {
    const initial = cur.present ? cur.value === "true" : field.default === "true";
    next = String(await p.confirm(field.label, initial));
  } else {
    const initial = cur.present && cur.value !== "" ? cur.value : field.default;
    const ctx = field.key === null ? null : await validate.schemaContext(ws.doc.data);
    next = (await p.text(field.label, initial, checkOf(field, ctx))).trim();
  }
  const unchanged = cur.present ? next === cur.value : next === "" || next === field.default;
  if (unchanged) return false;
  apply(ws, field, next);
  return true;
}

/**
 * Writes a field: into the `.env` variable a key references, as a new `${VAR}` reference for
 * secrets, or as a typed TOML value.
 */
export function apply(ws: Workspace, field: Field, next: string): void {
  if (field.key === null) {
    ws.setEnv(field.env ?? "", next);
    return;
  }
  const existing = ws.item(field.key);
  const referenced = typeof existing === "string" ? singleRef(existing)?.name : undefined;
  if (referenced !== undefined) {
    ws.setEnv(referenced, next);
    return;
  }
  if (field.env !== null && (existing === undefined || field.kind.type === "secret")) {
    ws.set(field.key, `\${${field.env}:-}`);
    ws.setEnv(field.env, next);
    return;
  }
  ws.set(field.key, typed(field.kind, next));
}

function typed(kind: Kind, s: string): TomlValue {
  switch (kind.type) {
    case "bool":
      return s === "true";
    case "port": {
      // The range is checked before (the schema's, or `validate.port`); this is the parse.
      if (!/^\d+$/.test(s.trim())) throw new Error("port 要是整數");
      return BigInt(s.trim());
    }
    case "ids":
      return s
        .split(/[, ]/)
        .map((p) => p.trim())
        .filter((p) => p !== "");
    default:
      return s;
  }
}

/** Multi-select which fields to change, then ask each. */
export async function editFields(
  p: Prompter,
  ws: Workspace,
  fields: readonly Field[],
): Promise<void> {
  const labels = fields.map((f) => fieldLabel(ws, f));
  const picked = await p.multiSelect("要修改哪些?", labels, []);
  for (const i of picked) await ask(p, ws, fields[i] as Field);
}

// ---- profile -----------------------------------------------------------------------------

export async function profileStep(p: Prompter, ws: Workspace): Promise<boolean> {
  const ids = ws.listProfiles();
  if (ids.length === 0) return ask(p, ws, PROFILE);
  const cur = current(ws, PROFILE).value;
  if (cur !== "" && !ids.includes(cur)) ids.push(cur);
  const start = Math.max(ids.indexOf(cur), 0);
  const picked = ids[await p.select("角色", ids, start)] as string;
  if (picked === cur) return false;
  apply(ws, PROFILE, picked);
  return true;
}

// ---- LLM ---------------------------------------------------------------------------------

export interface LlmState {
  provider: string;
  kind: string;
  model: string;
  /** `provider:model` the chat purpose uses now. */
  reference: string | null;
}

function providers(ws: Workspace): Array<[string, string]> {
  const table = ws.item("llm.providers");
  if (!isTable(table)) return [];
  return Object.entries(table).map(([name, item]) => {
    const kind = isTable(item) && typeof item.kind === "string" ? item.kind : "openai-compatible";
    return [name, kind];
  });
}

function chatRef(doc: TomlDocument | undefined): string | null {
  const item = doc?.get(["llm", "purposes", "chat"]);
  if (Array.isArray(item)) return typeof item[0] === "string" ? item[0] : null;
  return typeof item === "string" ? item : null;
}

export function llmState(ws: Workspace): LlmState {
  const reference = chatRef(ws.profileDoc()) ?? chatRef(ws.doc);
  const list = providers(ws);
  let provider: string;
  let model: string;
  const colon = reference?.indexOf(":") ?? -1;
  if (reference !== null && colon !== -1) {
    provider = reference.slice(0, colon);
    model = reference.slice(colon + 1);
  } else {
    provider = list[0]?.[0] ?? "deepseek";
    model = "";
  }
  const kind =
    list.find(([n]) => n === provider)?.[1] ??
    ((LLM_KINDS as readonly string[]).includes(provider) ? provider : "openai-compatible");
  return { provider, kind, model, reference };
}

function providerKey(provider: string, field: string): string {
  return `llm.providers.${formatKey([provider])}.${field}`;
}

/**
 * Uses a provider of `kind`: an existing one, a new `[llm.providers.opencode]`, or the current
 * provider with its kind changed.
 */
function switchKind(ws: Workspace, provider: string, kind: string): string {
  const existing = providers(ws).find(([, k]) => k === kind);
  if (existing) return existing[0];
  const name = kind === "opencode" ? "opencode" : provider;
  ws.set(providerKey(name, "kind"), kind);
  if (kind === "opencode") {
    if (ws.item(providerKey(name, "base_url")) === undefined) {
      ws.set(providerKey(name, "base_url"), defaultBaseUrl(kind) ?? "");
    }
    if (ws.item(providerKey(name, "api_key")) === undefined) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} reference
      ws.set(providerKey(name, "api_key"), "${OPENCODE_API_KEY:-}");
    }
  }
  return name;
}

function setModelRef(ws: Workspace, old: string | null, next: string): void {
  let hit = false;
  if (old !== null) {
    hit = ws.doc.replaceStringInArrays(["llm", "purposes"], old, next) || hit;
    const profile = ws.profileDoc();
    if (profile) hit = profile.replaceStringInArrays(["llm", "purposes"], old, next) || hit;
  }
  if (!hit) ws.set("llm.purposes.chat", [next]);
}

/** The API key field of the provider the chat purpose uses. */
export function llmApiKeyField(ws: Workspace): Field {
  const st = llmState(ws);
  return tomlField("LLM API key", providerKey(st.provider, "api_key"), SECRET, {
    env: apiKeyVar(st.kind),
  });
}

export function llmSummary(ws: Workspace): string {
  const st = llmState(ws);
  return st.model === "" ? st.kind : `${st.kind} · ${st.model}`;
}

/**
 * Provider kind, base URL, API key and chat model. With `pick`, asks which of them to change
 * first.
 */
export async function llmStep(p: Prompter, ws: Workspace, pick: boolean): Promise<void> {
  const st = llmState(ws);
  const baseField = (provider: string, kind: string): [string, string] => [
    providerKey(provider, "base_url"),
    defaultBaseUrl(kind) ?? "",
  ];
  let todo = [true, true, true, true];
  if (pick) {
    const [baseKey, baseDefault] = baseField(st.provider, st.kind);
    const effective = ws.effective(baseKey);
    const baseNow = effective === undefined || effective === "" ? baseDefault : effective;
    const keyMissing =
      current(ws, tomlField("", providerKey(st.provider, "api_key"), SECRET)).value === "";
    const labels = [
      `服務類型  [${st.kind}]`,
      `Base URL  [${baseNow}]`,
      `API key  [${keyMissing ? "未設定" : "已設定"}]`,
      `模型  [${st.model}]`,
    ];
    const chosen = await p.multiSelect("要修改哪些?", labels, []);
    todo = [0, 1, 2, 3].map((i) => chosen.includes(i));
  }

  let provider = st.provider;
  let kind = st.kind;
  if (todo[0]) {
    const options = [...LLM_KINDS];
    const start = Math.max(options.indexOf(kind as (typeof LLM_KINDS)[number]), 0);
    const nextKind = options[await p.select("LLM API 類型", options, start)] as string;
    if (nextKind !== kind) {
      provider = switchKind(ws, provider, nextKind);
      kind = nextKind;
      // The endpoint has to match the new kind; a new provider also needs a key and a model.
      todo[1] = true;
      if (provider !== st.provider) {
        todo[2] = true;
        todo[3] = true;
      }
    }
  }

  if (todo[1]) {
    const [key, def] = baseField(provider, kind);
    const field = tomlField("LLM base URL", key, URL_KIND, { default: def });
    const suggest = kind !== st.kind && provider === st.provider && def !== "";
    if (suggest) {
      // Same provider, new kind: offer the new kind's endpoint.
      const typedUrl = (await p.text(field.label, def, validate.httpUrl)).trim();
      if (typedUrl !== current(ws, field).value) apply(ws, field, typedUrl);
    } else {
      await ask(p, ws, field);
    }
  }

  if (todo[2]) {
    const field = tomlField("LLM API key", providerKey(provider, "api_key"), SECRET, {
      env: apiKeyVar(kind),
    });
    await ask(p, ws, field);
  }

  if (todo[3]) {
    const def = provider === st.provider && st.model !== "" ? st.model : defaultModel(kind);
    const model = await p.text("模型 id(會寫進角色的 profile.toml)", def, validate.modelId);
    const nextRef = `${provider}:${model.trim()}`;
    if (st.reference !== nextRef) setModelRef(ws, st.reference, nextRef);
  }
}

// ---- database ----------------------------------------------------------------------------

export async function databaseStep(p: Prompter, ws: Workspace): Promise<void> {
  const cur = current(ws, DATABASE).value;
  const options = ["SQLite(推薦,存在 data/miyoria.db)", "memory://(不保存,先試用)"];
  const pick = await p.select("資料庫", options, cur === "memory://" ? 1 : 0);
  const next = pick === 1 ? "memory://" : cur.startsWith("sqlite:") ? cur : DEFAULT_SQLITE_URL;
  if (next !== cur) apply(ws, DATABASE, next);
}

// ---- panel login -------------------------------------------------------------------------

export function oauthReady(ws: Workspace): boolean {
  return [OAUTH_CLIENT_ID, OAUTH_SECRET, OAUTH_REDIRECT].every((f) => current(ws, f).value !== "");
}

/** Discord login for the admin panel (`[modules.api.discord_oauth]`). */
export async function oauthStep(p: Prompter, ws: Workspace, init: boolean): Promise<void> {
  const configured = ws.item("modules.api.discord_oauth") !== undefined;
  const fields = [OAUTH_CLIENT_ID, OAUTH_SECRET, OAUTH_REDIRECT, API_BIND];
  let todo: number[];
  if (init) {
    if (!(await p.confirm("設定管理面板的 Discord 登入(OAuth)?", configured))) return;
    todo = [0, 1, 2];
  } else {
    todo = await p.multiSelect(
      "要修改哪些?",
      fields.map((f) => fieldLabel(ws, f)),
      [],
    );
  }
  for (const i of todo) await ask(p, ws, fields[i] as Field);
  const redirectKey = OAUTH_REDIRECT.key ?? "";
  if (ws.item("modules.api.discord_oauth") !== undefined && ws.item(redirectKey) === undefined) {
    apply(ws, OAUTH_REDIRECT, DEFAULT_REDIRECT_URI);
  }
  if (oauthReady(ws)) {
    p.note(
      `Discord Developer Portal → OAuth2 → Redirects 要加上 ${current(ws, OAUTH_REDIRECT).value}`,
    );
  } else if (ws.item("modules.api.discord_oauth") !== undefined) {
    p.warn("client id、client secret、redirect URI 都填了才會開啟 Discord 登入");
  }
}

// ---- tokens ------------------------------------------------------------------------------

/**
 * Generates tokens that are missing (never replaces one that is set) and adds missing `${VAR}`
 * references. Returns the generated variables.
 */
export function ensureTokens(ws: Workspace): string[] {
  const generated: string[] = [];
  for (const [variable, keys] of TOKENS) {
    for (const key of keys) {
      if (ws.item(key) === undefined) ws.set(key, `\${${variable}:-}`);
    }
    const found = ws.lookup(variable);
    if (found === undefined || found[0] === "") {
      ws.setEnv(variable, newToken());
      generated.push(variable);
    }
  }
  return generated;
}
