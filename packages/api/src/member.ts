// The member view (docs/design/v3-architecture.md §17.1): 她眼中的你. A person logged in with
// Discord sees what she has of them, and nothing of anyone else.
//
// The routes but the export are on the route table (`memberRpc`); `GET /api/member/export` is a file
// and stays a plain route.
//
// * `GET /api/member/session`: who is logged in, as far as they need to see it.
// * `GET /api/member/me`: how she calls them, the relationship in words, shared memories, their
//   own song requests.
// * `GET /api/member/export`: the same as a file, with what `/me memory export` would give, minus
//   what belongs to others.
// * `POST /api/member/forget` `{ confirm: true }`: `/me memory forget all`.
// * `POST /api/member/songs?space=` `{ query, priority? }`: a song request, as if said in chat; with
//   `priority`, paid with a song priority ticket (`409` with the reason when it cannot be). It is
//   sung in one server: the one asked for (`404` / `403` as every member route), else their own;
//   while she is in voice in another server it waits for her there, and the answer says so.
// * `GET /api/member/card`, `POST /api/member/card` `{ foil? }`: the daily card she gives them,
//   the card view below frozen with a serial and the parts drawn onto it (`card.ts`); the rest of
//   their cards (the dex, the pity, the wishlist) is `cards-routes.ts`.
// * `/api/member/wallet`, `checkin`, `feed`, `frame`: their coins
//   (`wallet.ts`). Forgetting keeps the wallet: coins are not her memory of them.
//
// The person comes from the session and from nowhere else: no route takes an id, a query parameter
// or a body field that could name somebody, and bodies with unknown fields are refused. Responses
// are built field by field; numbers never leave here, only their bands.
//
// A blocked person gets the answers of a stranger she has never met, from every route, so nothing
// on the page says they are blocked: an empty view, a forget that finds nothing, a refused song.

import type {
  IssueCardRequest,
  IssuedCard,
  IssuedFortune,
  MemberBond,
  MemberCard,
  MemberCards,
  MemberDay,
  MemberForgetResult,
  MemberMemory,
  MemberSession,
  MemberSong,
  MemberView,
  SongAccepted,
} from "@miyoria/contracts/api";
import type { WalletExport } from "@miyoria/economy";
import { ActuatorRegistryKey } from "@miyoria/gate/actions";
import { BLOCKED_TAG, type HeartPerson, hasTag, publicBond } from "@miyoria/heart/person";
import {
  FORGET_KEEPS,
  FORGET_REMOVES,
  MemoryEngineKey,
  ownMemories,
  visibleToSelf,
} from "@miyoria/memory/memory";
import { SingerKey, type SongEntry, SongPriorityError } from "@miyoria/sing";
import { type MemoryRecord, MessageLogKey, PeopleStoreKey, type Person } from "@miyoria/store";
import {
  type AccountRef,
  AuthorizerKey,
  accountRefString,
  bondBand,
  ephemeralHandlesIn,
  familiarityBand,
  HandleDirectoryKey,
  holdsBack,
  inspectInput,
  mentionsAnother,
  type NameSplit,
  PlacesKey,
  Principals,
  SocialSignalsKey,
  sameAccount,
  splitNames,
  tierStanding,
  toTimestamp,
  trustBand,
} from "@miyoria/types";
import { type CardHolder, cardsOf, deleteCards, issueCard, memberCards } from "./card.js";
import { keepsakeFor } from "./card-faces.js";
import { type CardWords, writeCard } from "./card-words.js";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { deleteFortunes, fortunesOf } from "./fortune.js";
import { heartRows } from "./heart-rows.js";
import { dateOf, localDay, tooMany } from "./public.js";
import type { Route } from "./route.js";
import type { SessionRecord } from "./session.js";
import { memberSpace } from "./space-param.js";
import type { ApiContext, ApiState } from "./state.js";
import { keyOf, walletExport } from "./wallet.js";

/** `GET /api/member/export` (a file, so not on the route table). */
export interface MemberExport {
  exported_at: string;
  card: MemberCard;
  memories: (MemberMemory & { derived_from_you: boolean })[];
  /** Memories left out because they hold someone else's name or words, or her own notes. */
  withheld: number;
  songs: MemberSong[];
  /** The cards she gave them, newest first. */
  cards: IssuedCard[];
  /** Their coins: the balance and every line of the ledger, newest first. */
  wallet: WalletExport;
  /** The fortune slips she wrote for them, newest first. */
  fortunes: IssuedFortune[];
}

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
const MAX_NAME_CHARS = 64;

/** The one answer to a song the page will not pass on, whatever the reason. */
const SONG_REFUSED = "目前沒辦法點這首歌";
/** A song taken while she is in voice in another server. */
const SONG_WAITS = "她現在在別的伺服器的語音裡,這首歌排在你選的伺服器,等她下次到那裡的語音就會唱。";

// ---- bands ----------------------------------------------------------------------------------

/**
 * Words, never numbers: a number on a page is something to farm (§17.1). The bond's words cover
 * the whole scale up to 1000, and live with trust's and familiarity's in `@miyoria/types`.
 */
export { bondBand, familiarityBand, trustBand };

// ---- who is asking --------------------------------------------------------------------------

/** The logged-in person as far as she knows them. */
interface Member {
  account: AccountRef;
  person: Person | null;
  /** Their heart row (`heart_person`); `null` before she has one for them. */
  row: HeartPerson | null;
  /** Answers exactly like someone she has never met. */
  hidden: boolean;
}

function record(c: ApiContext): SessionRecord {
  return c.get("member");
}

/**
 * Whether `account` is blocked, in any of the ways there are: the `blocked` tag on their heart
 * row (by account or by person), or a role that took `/me memory` away. When none of that can be
 * read, the answer is yes: a page must not open up because a module is down.
 */
function isBlocked(state: ApiState, account: AccountRef, row: HeartPerson | null): boolean {
  const social = state.optional(SocialSignalsKey);
  const authorizer = state.optional(AuthorizerKey);
  if (!social || !authorizer) return true;
  if (social.attitude(account)?.blocked || (row !== null && hasTag(row, BLOCKED_TAG))) return true;
  return !authorizer.allows(account, NODE_SHOW);
}

async function member(state: ApiState, c: ApiContext): Promise<Member> {
  return memberOf(state, record(c).account);
}

/** Who `account` is to her, for the member page and for the commands that do what it does. */
async function memberOf(state: ApiState, account: AccountRef): Promise<Member> {
  const people = state.optional(PeopleStoreKey);
  const person = (await people?.personByAccount(account)) ?? null;
  const row = person ? (heartRows(state)?.get(person.id) ?? null) : null;
  return { account, person, row, hidden: isBlocked(state, account, row) };
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
  const handle = who.person ? state.optional(HandleDirectoryKey)?.ofPerson(who.person.id) : null;
  return {
    others: split.others,
    own: [
      ...split.own,
      ...(handle ? [handle] : []),
      ...(who.row?.call_name ? [who.row.call_name] : []),
    ],
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
  const row = who.hidden ? null : who.row;
  if (!row) {
    return {
      call_name: null,
      relationship: null,
      affinity: null,
      trust: null,
      familiarity: null,
      public_feeling: null,
    };
  }
  const handle = state.optional(HandleDirectoryKey)?.ofPerson(row.person_id) ?? "";
  const call = (row.call_name ?? handle).trim();
  return {
    call_name: call !== "" && state.publicSide.passes(state, call) ? call : null,
    // What a person reads (the card's title, its words): the tier with its stage (H10).
    relationship: tierStanding({
      affinity: row.bond,
      met: row.interactions > 0 || row.bond !== 0,
    }).label,
    affinity: bondBand(row.bond),
    trust: trustBand(row.trust),
    familiarity: familiarityBand(row.familiarity),
    // Only the line written for them: her private impression names other people.
    public_feeling: shown(state, row.public_feeling ?? "", names),
  };
}

/**
 * Where they are with her: the tier, how far to the next and the ring, from `publicBond`, which
 * only gives the ring's lap and fill and the progress in steps of a twentieth. `null` for someone
 * she does not know (or will not say).
 */
function bondView(who: Member): MemberBond | null {
  const row = who.hidden ? null : who.row;
  if (row === null) return null;
  const { tier, stage, tier_label, next_tier, next_label, tier_progress, ring } = publicBond(row);
  return {
    tier,
    stage,
    tier_label,
    next_tier,
    next_label,
    tier_progress,
    ring: { lap: ring.lap, fraction: ring.fraction, full: ring.full },
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
    bond: bondView(who),
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
    cards: await cardsOf(state, accountsOf(who), who.person?.id ?? null),
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

async function forgetMine(state: ApiState, c: ApiContext): Promise<MemberForgetResult> {
  const { account } = record(c);
  const actor = accountRefString(account);
  const wait = state.publicSide.admitHeavy(actor);
  if (wait !== null) throw ApiError.tooMany(wait);
  const who = await member(state, c);
  // Cards go for everyone, so a forget that finds nothing still leaves no card that checks out.
  await deleteCards(state, accountsOf(who), who.person?.id ?? null);
  await deleteFortunes(state, accountsOf(who));
  const nothing: MemberForgetResult = { deleted: 0, about: 0, derived: 0, unverified: 0 };
  const allowed = !who.hidden && state.optional(AuthorizerKey)?.allows(account, NODE_FORGET);
  if (!allowed) return nothing;
  const engine = state.optional(MemoryEngineKey);
  if (!engine) throw ApiError.unavailable("not available right now");
  const person = who.person?.id ?? null;
  // Everything of theirs goes in one transaction, the heart's words and the member page's line
  // with it (the heart plugin's "forget me" hook); her numbers for them stay.
  const report = await engine.forget(person, account, null);
  await state.auditAs(actor, "member.forget", actor, { deleted: report.deleted }, true);
  return {
    deleted: report.deleted,
    about: report.about,
    derived: report.derived,
    unverified: report.unverified,
  };
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
async function requestSong(
  state: ApiState,
  c: ApiContext,
  query: string,
  priority = false,
  requested?: string,
): Promise<SongAccepted> {
  const session = record(c);
  const { account } = session;
  const wait = state.publicSide.admitMember(`song:${accountRefString(account)}`);
  if (wait !== null) throw ApiError.tooMany(wait);
  const who = await member(state, c);
  const refused = () => new ApiError(403, SONG_REFUSED);
  if (!canRequest(state, who) || !acceptableQuery(query)) throw refused();
  const verdict = inspectInput(state.ctx.services, { text: query, source: "web", author: account });
  if (verdict === null || holdsBack(verdict) || verdict.action !== "pass") throw refused();
  if (!state.publicSide.passes(state, query)) throw refused();
  const actuators = state.optional(ActuatorRegistryKey);
  if (!actuators) throw ApiError.unavailable("not available right now");
  const by = [...session.name.trim()].slice(0, MAX_NAME_CHARS).join("");
  // The server it is sung in (phase 6): the one they picked, else their own. Where she is in
  // voice there, it is asked for there; else it waits for her to be in voice there.
  const singer = state.optional(SingerKey);
  let context = state.monitor.voiceContext();
  let guild: string | null = null;
  if (state.optional(PlacesKey) !== undefined) {
    guild = memberSpace(state, who.person?.id ?? null, requested).external_id;
    context = singer?.voiceContext(guild) ?? null;
  }
  const outcome = await actuators.invoke({
    principal: Principals.user(account, context),
    capability: "sing.request",
    // A song priority ticket is theirs to use here: their own request, with no turn of hers.
    args: {
      query,
      ...(by === "" ? {} : { by }),
      ...(priority ? { priority: true } : {}),
      ...(guild === null ? {} : { guild }),
    },
    why: "公開頁點歌",
    turn: null,
  });
  // What stopped it stays here: a rule's words and a worker's address are not for the page.
  if (outcome.status === "denied") {
    if (outcome.decision.stage === "rate") throw new ApiError(429, "今天點歌的次數到上限了");
    throw refused();
  }
  if (outcome.status === "failed") {
    // A ticket that could not be taken says why (their coins, the day's limit); nothing was charged.
    if (outcome.cause instanceof SongPriorityError) throw new ApiError(409, outcome.error);
    throw new ApiError(502, "歌曲服務暫時無法使用");
  }
  return singer?.waitsElsewhere(guild) === true
    ? { accepted: true, waiting: SONG_WAITS }
    : { accepted: true };
}

function holderOf(c: ApiContext, who: Member): CardHolder {
  return cardHolder(record(c), who);
}

/** Whose cards these are: the session's account and name and every account of the person. */
export function cardHolder(session: CardHolder["session"], who: Member): CardHolder {
  return { session, accounts: accountsOf(who), person: who.person?.id ?? null };
}

async function cardsMine(state: ApiState, c: ApiContext): Promise<MemberCards> {
  const who = await member(state, c);
  // Someone from before the cards finds their keepsake the first time they look.
  await keepsakeFor(state, who, record(c).name, record(c).avatar_url);
  return memberCards(state, holderOf(c, who));
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
): Promise<CardWords | null> {
  if (who.hidden || view.relationship === null) return null;
  const names = await namesFor(state, who);
  return writeCard(
    state,
    {
      name,
      view,
      memories: (await shownMemories(state, who, names)).slice(0, 5).map((m) => m.text),
      poses: [],
      names,
    },
    (text) => shown(state, text, names),
  );
}

/**
 * A daily card of what the page shows them now, with a foil finish if they pay for it. A hidden
 * person gets a stranger's card with no words, and pays and counts like anyone, so neither the card
 * nor the limit says anything. She writes only once the day and the coins allow the card.
 */
async function issueMine(
  state: ApiState,
  c: ApiContext,
  request: IssueCardRequest,
  idempotencyKey: string | undefined,
): Promise<IssuedCard> {
  const { foil = false } = request;
  const who = await member(state, c);
  const names = who.hidden ? null : await namesFor(state, who);
  const view = cardView(state, who, names);
  const card = await issueCard(
    state,
    holderOf(c, who),
    view,
    () => cardWords(state, record(c).name, who, view),
    { foil, key: keyOf(idempotencyKey) },
    who.hidden,
  );
  const actor = accountRefString(record(c).account);
  await state.auditAs(actor, "member.card", actor, { serial: card.serial }, true);
  return card;
}

function session(c: ApiContext): MemberSession {
  const { name, avatar_url } = record(c);
  return { name, avatar_url };
}

/** The member route that is not on the route table: a file. None when the public side is off. */
export function memberRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  const routes: Route[] = [
    { method: "GET", path: "/api/member/export", handler: (c) => exportMine(state, c) },
  ];
  return routes.map((r) => ({ ...r, member: true }));
}

/** The member routes on the route table; served only while the public side is on (see `rpc.ts`). */
export const memberRpc = {
  session: os.member.session.handler(({ context }) => session(context.c)),
  me: os.member.me.handler(({ context }) => memberView(context.state, context.c)),
  forget: os.member.forget.handler(({ context }) => forgetMine(context.state, context.c)),
  requestSong: os.member.requestSong.handler(({ input, context }) =>
    requestSong(
      context.state,
      context.c,
      input.body.query,
      input.body.priority === true,
      input.query?.space,
    ),
  ),
  cards: os.member.cards.handler(({ context }) => cardsMine(context.state, context.c)),
  issueCard: os.member.issueCard.handler(({ input, context }) => {
    return issueMine(context.state, context.c, input.body, input.headers?.["idempotency-key"]);
  }),
};

// What `fortune-routes.ts` builds a slip from and `pictures.ts` draws someone's own pictures from:
// the same views the page and the cards use.
export type { Member as MemberContext };
export {
  accountsOf,
  activity,
  bondView,
  cardView,
  member as loadMember,
  memberOf as loadMemberOf,
  namesFor,
  ownSongs,
  shown,
  shownMemories,
};
