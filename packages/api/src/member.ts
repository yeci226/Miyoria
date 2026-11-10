// The member view (docs/design/v3-architecture.md §17.1): 她眼中的你. A person logged in with
// Discord sees what she has of them, and nothing of anyone else.
//
// * `GET /api/member/session`: who is logged in, as far as they need to see it.
// * `GET /api/member/me`: how she calls them, the relationship in words, shared memories, their
//   own song requests.
// * `GET /api/member/export`: the same as a file, with what `/me memory export` would give, minus
//   what belongs to others.
// * `POST /api/member/forget` `{ confirm: true }`: `/me memory forget all`.
// * `POST /api/member/songs` `{ query }`: a song request, as if said in chat.
// * `GET /api/member/card`, `POST /api/member/card` `{}`: the card she gives them, the card view
//   below frozen with a serial (`card.ts`).
// * `/api/member/wallet`, `checkin`, `feed`, `letter`, `expression`, `frame`: their coins
//   (`wallet.ts`). Forgetting keeps the wallet: coins are not her memory of them.
//
// The person comes from the session and from nowhere else: no route takes an id, a query parameter
// or a body field that could name somebody, and bodies with unknown fields are refused. Responses
// are built field by field; numbers never leave here, only their bands.
//
// A blocked person gets the answers of a stranger she has never met, from every route, so nothing
// on the page says they are blocked: an empty view, a forget that finds nothing, a refused song.

import { ActuatorRegistryKey } from "@miyoria/actions";
import {
  FORGET_KEEPS,
  FORGET_REMOVES,
  MemoryEngineKey,
  ownMemories,
  visibleToSelf,
} from "@miyoria/memory";
import { SingerKey, type SongEntry } from "@miyoria/sing";
import { type MemoryRecord, MessageLogKey, PeopleStoreKey, type Person } from "@miyoria/store";
import {
  type AccountRef,
  AffectStateKey,
  AuthorizerKey,
  accountRefString,
  ephemeralHandlesIn,
  holdsBack,
  inspectInput,
  mentionsAnother,
  type NameSplit,
  type PersonCard,
  Principals,
  SocialSignalsKey,
  sameAccount,
  splitNames,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import {
  type CardHolder,
  canIssue,
  cardsOf,
  deleteCards,
  issueCard,
  memberCards,
  posesFor,
  rerollCard,
} from "./card.js";
import { type CardWords, writeCard } from "./card-words.js";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { deleteFortunes, fortunesOf } from "./fortune.js";
import { dateOf, localDay, tooMany } from "./public.js";
import { json, type Route } from "./route.js";
import type { SessionRecord } from "./session.js";
import type { ApiContext, ApiState } from "./state.js";
import type {
  MemberCard,
  MemberDay,
  MemberExport,
  MemberForgetResult,
  MemberMemory,
  MemberSession,
  MemberSong,
  MemberView,
} from "./types.js";
import { keyOf, walletExport } from "./wallet.js";

/** Nodes of `/me memory`: a role that may not use those may not use these. */
const NODE_SHOW = "memory.self.show";
const NODE_EXPORT = "memory.self.export";
const NODE_FORGET = "memory.self.forget";

/** Days of activity the page charts, today included. */
export const MEMBER_DAYS = 30;
/** Lines read for the chart at most: a month of a very talkative person. */
const MAX_ACTIVITY_LINES = 50_000;

/** How many memories the page shows, newest first. */
const MAX_SHOWN_MEMORIES = 30;
const MAX_QUERY_CHARS = 120;
const MAX_NAME_CHARS = 64;

/** The one answer to a song the page will not pass on, whatever the reason. */
const SONG_REFUSED = "目前沒辦法點這首歌";

const SongRequestSchema = z.strictObject({
  query: z.string().trim().min(1).max(MAX_QUERY_CHARS),
});
const ForgetSchema = z.strictObject({ confirm: z.literal(true) });
const CardSchema = z.strictObject({
  pose: z.string().max(16).optional(),
  foil: z.boolean().optional(),
});
const RerollSchema = z.strictObject({});

// ---- bands ----------------------------------------------------------------------------------

/** Words, never numbers: a number on a page is something to farm (§17.1). */
export function affinityBand(value: number): string {
  if (value <= -50) return "很差";
  if (value <= -15) return "不太好";
  if (value < 15) return "普通";
  if (value < 45) return "不錯";
  if (value < 75) return "很好";
  return "非常好";
}

export function trustBand(value: number): string {
  if (value < 15) return "還不信任";
  if (value < 40) return "有點信任";
  if (value < 70) return "信任";
  return "很信任";
}

export function familiarityBand(value: number): string {
  if (value < 3) return "陌生";
  if (value < 10) return "見過幾次";
  if (value < 30) return "有點熟";
  if (value < 60) return "熟";
  return "很熟";
}

// ---- who is asking --------------------------------------------------------------------------

/** The logged-in person as far as she knows them. */
interface Member {
  account: AccountRef;
  person: Person | null;
  card: PersonCard | null;
  /** Answers exactly like someone she has never met. */
  hidden: boolean;
}

function record(c: ApiContext): SessionRecord {
  return c.get("member");
}

/**
 * Whether `account` is blocked, in any of the ways there are: the social tag, the card, or a role
 * that took `/me memory` away. When none of that can be read, the answer is yes: a page must not
 * open up because a module is down.
 */
function isBlocked(state: ApiState, account: AccountRef, card: PersonCard | null): boolean {
  const social = state.optional(SocialSignalsKey);
  const affect = state.optional(AffectStateKey);
  const authorizer = state.optional(AuthorizerKey);
  if ((!social && !affect) || !authorizer) return true;
  if (social?.attitude(account)?.blocked || card?.blocked) return true;
  return !authorizer.allows(account, NODE_SHOW);
}

async function member(state: ApiState, c: ApiContext): Promise<Member> {
  return memberOf(state, record(c).account);
}

/** Who `account` is to her, for the member page and for the commands that do what it does. */
async function memberOf(state: ApiState, account: AccountRef): Promise<Member> {
  const people = state.optional(PeopleStoreKey);
  const person = (await people?.personByAccount(account)) ?? null;
  const card = person ? (state.optional(AffectStateKey)?.card(person.id) ?? null) : null;
  return { account, person, card, hidden: isBlocked(state, account, card) };
}

/** The session account and every account of the person she knows them as. */
function accountsOf(who: Member): AccountRef[] {
  const accounts = who.person?.accounts.map((a) => a.account) ?? [];
  if (!accounts.some((a) => sameAccount(a, who.account))) accounts.push(who.account);
  return accounts;
}

/** Whose names are whose for this person; `null` when the names cannot be read. */
async function namesFor(state: ApiState, who: Member): Promise<NameSplit | null> {
  const known = await state.publicSide.names(state.ctx);
  if (known === null) return null;
  const accounts = who.person?.accounts.map((a) => a.account) ?? [];
  const split = splitNames(known, who.person?.id ?? null, [who.account, ...accounts]);
  const card = who.card;
  return {
    others: split.others,
    own: [...split.own, ...(card ? [card.handle, card.call_name ?? ""] : [])],
  };
}

/** `text` when it may be shown to this person: nobody else named, passed by moderation. */
function shown(state: ApiState, text: string, names: NameSplit | null): string | null {
  const line = text.trim();
  if (line === "" || names === null || ephemeralHandlesIn(line).length > 0) return null;
  if (mentionsAnother(line, names)) return null;
  return state.publicSide.passes(state, line) ? line : null;
}

// ---- views ----------------------------------------------------------------------------------

function cardView(state: ApiState, who: Member, names: NameSplit | null): MemberCard {
  const card = who.hidden ? null : who.card;
  if (!card) {
    return {
      call_name: null,
      relationship: null,
      affinity: null,
      trust: null,
      familiarity: null,
      public_feeling: null,
    };
  }
  const call = (card.call_name ?? card.handle).trim();
  return {
    call_name: call !== "" && state.publicSide.passes(state, call) ? call : null,
    relationship: card.label,
    affinity: affinityBand(card.affinity),
    trust: trustBand(card.trust),
    familiarity: familiarityBand(card.familiarity),
    // Only the line written for them: her private `feeling` names other people.
    public_feeling: shown(state, card.public_feeling ?? "", names),
  };
}

/** A memory somebody else told her is theirs to know about, not this person's to read. */
function toldByAnother(r: MemoryRecord, account: AccountRef): boolean {
  if (r.source) return !sameAccount(r.source.account, account);
  return r.origin === "told";
}

/** What may leave for this person; her own notes are her inner life. */
function memoryLine(
  state: ApiState,
  r: MemoryRecord,
  account: AccountRef,
  names: NameSplit | null,
): string | null {
  if (r.kind === "self_note" || toldByAnother(r, account)) return null;
  return shown(state, r.content, names);
}

function memoryView(text: string, r: MemoryRecord): MemberMemory {
  return { text, kind: r.kind, date: r.created_at.slice(0, 10) };
}

function songView(e: SongEntry): MemberSong {
  return {
    title: e.song?.title || e.query,
    artist: e.song?.artist ?? null,
    state: e.state,
    requested_at: e.created_at,
  };
}

/** Their own requests only; the query shown is what they typed themselves. */
function ownSongs(state: ApiState, who: Member): MemberSong[] {
  if (who.hidden) return [];
  const list = state.optional(SingerKey)?.list.all() ?? [];
  return list
    .filter((e) => e.requester !== null && sameAccount(e.requester, who.account))
    .reverse()
    .map(songView);
}

/** The song request permission, as the capability has it. */
function canRequest(state: ApiState, who: Member): boolean {
  if (!state.publicSide.config.song_requests || who.hidden || who.person === null) return false;
  const capability = state.optional(ActuatorRegistryKey)?.get("sing.request");
  if (!capability) return false;
  const node = capability.permission;
  return node === null || state.optional(AuthorizerKey)?.allows(who.account, node) === true;
}

/**
 * Their own lines per local day, text and voice apart. Only what they wrote is counted, never what
 * she or anyone else said, and only as numbers: no text, channel or time of day leaves here.
 */
async function activity(state: ApiState, who: Member): Promise<MemberDay[]> {
  const offset = state.publicSide.config.utc_offset_minutes;
  const today = localDay(state.now(), offset);
  const first = today - MEMBER_DAYS + 1;
  const days: MemberDay[] = [];
  for (let d = first; d <= today; d++) days.push({ date: dateOf(d), text: 0, voice: 0 });
  const log = state.optional(MessageLogKey);
  if (who.hidden || !log) return days;
  const authors = accountsOf(who);
  const since = toTimestamp(first * 86_400_000 - offset * 60_000);
  try {
    const lines = await log.authoredSince(state.profile(), authors, since, MAX_ACTIVITY_LINES);
    for (const line of lines) {
      const day = days[localDay(Date.parse(line.ts), offset) - first];
      if (!day) continue;
      if (line.kind === "voice") day.voice += 1;
      else day.text += 1;
    }
  } catch {
    // The chart is a nicety: without the log it stays empty.
  }
  return days;
}

/** The memories the member page shows this person, newest first. */
async function shownMemories(
  state: ApiState,
  who: Member,
  names: NameSplit | null,
): Promise<MemberMemory[]> {
  const engine = state.optional(MemoryEngineKey);
  const memories: MemberMemory[] = [];
  if (!who.hidden && engine) {
    const { records } = await ownMemories(
      engine,
      who.account,
      (r, person) => visibleToSelf(r.scope, who.account, person),
      { derived: false },
    );
    for (const r of records) {
      if (memories.length >= MAX_SHOWN_MEMORIES) break;
      if (r.kind !== "episode" && r.kind !== "fact") continue;
      const text = memoryLine(state, r, who.account, names);
      if (text !== null) memories.push(memoryView(text, r));
    }
  }
  return memories;
}

async function memberView(state: ApiState, c: ApiContext): Promise<MemberView> {
  const who = await member(state, c);
  const names = who.hidden ? null : await namesFor(state, who);
  const memories = await shownMemories(state, who, names);
  return {
    card: cardView(state, who, names),
    memories,
    songs: ownSongs(state, who),
    activity: await activity(state, who),
    can_request_song: canRequest(state, who),
    forget: { removes: FORGET_REMOVES, keeps: FORGET_KEEPS },
  };
}

async function exportMine(state: ApiState, c: ApiContext): Promise<Response> {
  const { account } = record(c);
  const wait = state.publicSide.admitHeavy(accountRefString(account));
  if (wait !== null) return tooMany(wait);
  const who = await member(state, c);
  const allowed = !who.hidden && state.optional(AuthorizerKey)?.allows(account, NODE_EXPORT);
  const names = allowed ? await namesFor(state, who) : null;
  const engine = state.optional(MemoryEngineKey);
  const memories: MemberExport["memories"] = [];
  let withheld = 0;
  if (allowed && engine) {
    const { records, derived } = await ownMemories(engine, account, (r, person) =>
      visibleToSelf(r.scope, account, person),
    );
    for (const r of records) {
      const text = memoryLine(state, r, account, names);
      if (text === null) {
        withheld += 1;
        continue;
      }
      memories.push({ ...memoryView(text, r), derived_from_you: derived.has(r.id) });
    }
  }
  const at = toTimestamp(state.now());
  const body: MemberExport = {
    exported_at: at,
    card: cardView(state, allowed ? who : { ...who, hidden: true }, names),
    memories,
    withheld,
    songs: allowed ? ownSongs(state, who) : [],
    // Their cards are theirs whatever she thinks of them now: each holds what it held then.
    cards: await cardsOf(state, accountsOf(who)),
    // A blocked person's wallet is a stranger's, like everywhere else.
    wallet: await walletExport(state, account),
    // Their fortune slips, like their cards.
    fortunes: await fortunesOf(state, accountsOf(who)),
  };
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="miyoria-me-${at.slice(0, 10)}.json"`,
    },
  });
}

async function forgetMine(state: ApiState, c: ApiContext): Promise<Response> {
  await readJson(c, ForgetSchema);
  const { account } = record(c);
  const actor = accountRefString(account);
  const wait = state.publicSide.admitHeavy(actor);
  if (wait !== null) return tooMany(wait);
  const who = await member(state, c);
  // Cards go for everyone, so a forget that finds nothing still leaves no card that checks out.
  await deleteCards(state, accountsOf(who));
  await deleteFortunes(state, accountsOf(who));
  const nothing: MemberForgetResult = { deleted: 0, about: 0, derived: 0, unverified: 0 };
  const allowed = !who.hidden && state.optional(AuthorizerKey)?.allows(account, NODE_FORGET);
  if (!allowed) return json(nothing);
  const engine = state.optional(MemoryEngineKey);
  if (!engine) throw ApiError.unavailable("not available right now");
  const person = who.person?.id ?? null;
  const report = await engine.forget(person, account, null);
  // The line was written from those memories; it goes with them.
  if (person !== null) {
    await state
      .optional(AffectStateKey)
      ?.adjustBond(person, { public_feeling: null, why: "本人要求忘記" }, "panel");
  }
  await state.auditAs(actor, "member.forget", actor, { deleted: report.deleted }, true);
  const body: MemberForgetResult = {
    deleted: report.deleted,
    about: report.about,
    derived: report.derived,
    unverified: report.unverified,
  };
  return json(body);
}

const SONG_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "bilibili.com",
  "www.bilibili.com",
  "m.bilibili.com",
  "b23.tv",
]);

/**
 * A song name or a YouTube / bilibili link. The song worker also takes files of its library and any other
 * link; a page open to the internet has no business naming either.
 */
export function acceptableQuery(query: string): boolean {
  if (/^\s*library:/i.test(query)) return false;
  for (const link of query.match(/https?:\/\/[^\s<>"'「」]+/gi) ?? []) {
    try {
      if (!SONG_HOSTS.has(new URL(link).hostname.toLowerCase())) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/**
 * A song request from the page. It enters like a line in chat: moderation reads it as input, then
 * the gate runs it for a `user`, which means the rules, the permission and the rate limits apply,
 * and she may turn it down. `actAs` (the panel) would skip those, and force the song.
 */
async function requestSong(state: ApiState, c: ApiContext): Promise<Response> {
  const session = record(c);
  const { account } = session;
  const wait = state.publicSide.admitMember(`song:${accountRefString(account)}`);
  if (wait !== null) return tooMany(wait);
  const { query } = await readJson(c, SongRequestSchema);
  const who = await member(state, c);
  const refused = () => new ApiError(403, SONG_REFUSED);
  if (!canRequest(state, who) || !acceptableQuery(query)) throw refused();
  const verdict = inspectInput(state.ctx.services, { text: query, source: "web", author: account });
  if (verdict === null || holdsBack(verdict) || verdict.action !== "pass") throw refused();
  if (!state.publicSide.passes(state, query)) throw refused();
  const actuators = state.optional(ActuatorRegistryKey);
  if (!actuators) throw ApiError.unavailable("not available right now");
  const by = [...session.name.trim()].slice(0, MAX_NAME_CHARS).join("");
  const outcome = await actuators.invoke({
    principal: Principals.user(account, state.monitor.voiceContext()),
    capability: "sing.request",
    args: by === "" ? { query } : { query, by },
    why: "公開頁點歌",
    turn: null,
  });
  // What stopped it stays here: a rule's words and a worker's address are not for the page.
  if (outcome.status === "denied") {
    if (outcome.decision.stage === "rate") throw new ApiError(429, "今天點歌的次數到上限了");
    throw refused();
  }
  if (outcome.status === "failed") throw new ApiError(502, "歌曲服務暫時無法使用");
  return json({ accepted: true });
}

function holderOf(c: ApiContext, who: Member): CardHolder {
  return cardHolder(record(c), who);
}

/** Whose cards these are: the session's account and name and every account of the person. */
export function cardHolder(session: CardHolder["session"], who: Member): CardHolder {
  return { session, accounts: accountsOf(who), person: who.person?.id ?? null };
}

async function cardsMine(state: ApiState, c: ApiContext): Promise<Response> {
  const who = await member(state, c);
  const view = cardView(state, who, null);
  return json(await memberCards(state, holderOf(c, who), view));
}

/**
 * What she writes on a card, for the card routes: only for someone she knows (a hidden person's
 * card stays a stranger's and says nothing),.
 */
export async function cardWords(
  state: ApiState,
  name: string,
  who: Member,
  view: MemberCard,
  poses: readonly string[],
): Promise<CardWords | null> {
  if (who.hidden || view.relationship === null) return null;
  const names = await namesFor(state, who);
  return writeCard(
    state,
    {
      name,
      view,
      memories: (await shownMemories(state, who, names)).slice(0, 5).map((m) => m.text),
      poses,
    },
    (text) => shown(state, text, names),
  );
}

/**
 * A card of what the page shows them now, with a picture of their choosing (`card_pose`) and a
 * foil finish (`card_foil`) if they pay for them. A hidden person gets a stranger's card, stored
 * and counted like anyone's, so neither the card nor the limit says anything.
 */
async function issueMine(state: ApiState, c: ApiContext): Promise<Response> {
  const { pose = null, foil = false } = await readJson(c, CardSchema);
  const who = await member(state, c);
  const names = who.hidden ? null : await namesFor(state, who);
  const holder = holderOf(c, who);
  const view = cardView(state, who, names);
  // She writes only on a card that will be issued, and knows the picture when it was chosen.
  const card = await issueCard(
    state,
    holder,
    view,
    async () =>
      (await canIssue(state, holder))
        ? cardWords(
            state,
            record(c).name,
            who,
            view,
            pose !== null ? [pose] : posesFor(view.affinity),
          )
        : null,
    { pose, foil, key: keyOf(c) },
  );
  const actor = accountRefString(record(c).account);
  await state.auditAs(actor, "member.card", actor, { serial: card.serial }, true);
  return json(card);
}

/** Today's newest card is voided and she writes a new one (`card_reroll`). */
async function rerollMine(state: ApiState, c: ApiContext): Promise<Response> {
  await readJson(c, RerollSchema);
  const who = await member(state, c);
  const names = who.hidden ? null : await namesFor(state, who);
  const view = cardView(state, who, names);
  const card = await rerollCard(
    state,
    holderOf(c, who),
    view,
    () => cardWords(state, record(c).name, who, view, posesFor(view.affinity)),
    keyOf(c),
  );
  const actor = accountRefString(record(c).account);
  await state.auditAs(actor, "member.card.reroll", actor, { serial: card.serial }, true);
  return json(card);
}

function session(c: ApiContext): MemberSession {
  const { name, avatar_url } = record(c);
  return { name, avatar_url };
}

/** Runs `handler` unless this account has been asking too much. */
function limited(state: ApiState, handler: (c: ApiContext) => Promise<Response>) {
  return async (c: ApiContext): Promise<Response> => {
    const wait = state.publicSide.admitMember(accountRefString(record(c).account));
    return wait !== null ? tooMany(wait) : handler(c);
  };
}

/** The member routes; none when `[modules.api.public] enabled` is off. */
export function memberRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  const routes: Route[] = [
    {
      method: "GET",
      path: "/api/member/session",
      handler: limited(state, async (c) => json(session(c))),
    },
    {
      method: "GET",
      path: "/api/member/me",
      handler: limited(state, async (c) => json(await memberView(state, c))),
    },
    { method: "GET", path: "/api/member/export", handler: (c) => exportMine(state, c) },
    { method: "POST", path: "/api/member/forget", handler: (c) => forgetMine(state, c) },
    { method: "POST", path: "/api/member/songs", handler: (c) => requestSong(state, c) },
    {
      method: "GET",
      path: "/api/member/card",
      handler: limited(state, (c) => cardsMine(state, c)),
    },
    {
      method: "POST",
      path: "/api/member/card",
      handler: limited(state, (c) => issueMine(state, c)),
    },
    {
      method: "POST",
      path: "/api/member/card/reroll",
      handler: limited(state, (c) => rerollMine(state, c)),
    },
  ];
  return routes.map((r) => ({ ...r, member: true }));
}

// What `fortune-routes.ts` builds a slip from: the same views the page and the cards use.
export type { Member as MemberContext };
export {
  accountsOf,
  cardView,
  member as loadMember,
  memberOf as loadMemberOf,
  namesFor,
  shown,
  shownMemories,
};
