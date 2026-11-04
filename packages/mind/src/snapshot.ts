// The compact snapshot one thought sees: the relevant server's world summary, places and people
// with short refs, her own state, agenda, recent thoughts and what she remembers about the
// people and place involved. No long chat transcripts.

import type { ActuatorRegistry } from "@miyoria/actions";
import { errorMessage, getLogger, type ServiceLookup, withTimeout } from "@miyoria/kernel";
import {
  type AccountRef,
  CHAT_DM,
  CHAT_START,
  type ContextKey,
  ConversationStatesKey,
  contextKeyString,
  dataBlock,
  IntentSinkKey,
  KnowledgeKey,
  type KnowledgeSubject,
  LessonsKey,
  type MindSuggestion,
  newId,
  PERSON_EMOTION_LABELS,
  PERSON_EMOTION_NAMES,
  type PersonId,
  PlatformSinksKey,
  type ProfileId,
  PromptContributorsKey,
  type PromptSection,
  type SalientEvent,
  type SelfState,
  SelfStateKey,
  SocialSignalsKey,
  SpeechPauseKey,
  sameAccount,
  type ThoughtTrigger,
  toTimestamp,
  type VoiceChannelState,
  VoiceFloorKey,
  type WorldSnapshot,
  WorldStateKey,
} from "@miyoria/types";
import type { AgendaRef, CapabilityInfo, PersonRef, PlaceRef } from "./prompt.js";

const log = getLogger("mind.snapshot");

/** Capabilities that are not hers to start (the panel's "say", the director's game moves). */
export const NOT_FOR_HER: readonly string[] = ["speak", "game.act", "stage.stream", "message.dm"];

const MAX_PLACES = 8;
const MAX_PEOPLE = 10;
const MAX_CHANNELS = 5;
const MAX_AGENDA = 8;
const CONTRIBUTOR_TIMEOUT_MS = 1500;
const LABEL_TIMEOUT_MS = 500;
const MAX_MEMORY_CHARS = 2500;
const MAX_DOCUMENT_CHARS = 1500;
const MAX_LESSONS = 8;

export interface Gathered {
  focus: ContextKey | null;
  world: string;
  places: PlaceRef[];
  people: PersonRef[];
  agenda: AgendaRef[];
  memories: string | null;
  /** Her documents about the people and place involved and herself (rendered outline). */
  documents: string | null;
  /** Lessons that apply here. */
  lessons: string[];
  /** Her notes' recap of the conversation in focus. */
  recap: string | null;
}

export interface GatherInput {
  services: ServiceLookup;
  profile: ProfileId;
  now: number;
  triggers: readonly ThoughtTrigger[];
  suggestions: readonly MindSuggestion[];
  salient: readonly SalientEvent[];
  contributors: readonly string[];
  /** Human names of contexts, cached between thoughts. */
  labels: Map<string, string>;
  signal?: AbortSignal;
}

/** The context the thought is mostly about. */
export function focusOf(
  triggers: readonly ThoughtTrigger[],
  suggestions: readonly MindSuggestion[],
  world: WorldSnapshot | null,
): ContextKey | null {
  for (const t of triggers) if (t.context !== null) return t.context;
  for (const s of suggestions) if (s.context !== null) return s.context;
  if (world?.her.voice) return world.her.voice;
  const busiest = world?.channels.find((c) => c.lively) ?? world?.channels[0];
  return busiest?.context ?? null;
}

async function label(
  services: ServiceLookup,
  labels: Map<string, string>,
  context: ContextKey,
  fallback: string,
): Promise<string> {
  const key = contextKeyString(context);
  const cached = labels.get(key);
  if (cached !== undefined) return cached;
  const sink = services.get(PlatformSinksKey)?.get(context.platform);
  let name: string | null = null;
  if (sink?.describe) {
    try {
      name = (await withTimeout(sink.describe(context), LABEL_TIMEOUT_MS)) ?? null;
    } catch {
      name = null;
    }
  }
  const out = name ?? fallback;
  if (name !== null) labels.set(key, out);
  return out;
}

/**
 * How much is being said in a voice channel (`;正在聊天:最近 5 分鐘 12 句,最後一句 8 秒前`), so
 * a busy channel never reads as quiet; empty when unknown.
 */
export function voiceTalk(v: VoiceChannelState, deaf = false): string {
  // While a song is prepared her listening is off: no utterances does not mean nobody talks.
  if (deaf) return ";你現在聽不到這裡的人說話";
  const a = v.activity;
  if (!a) return "";
  if (a.recent_utterances === 0 || a.secs_since_last === null) return ";最近沒人說話";
  const last =
    a.secs_since_last < 60
      ? `${a.secs_since_last} 秒前`
      : `${Math.round(a.secs_since_last / 60)} 分鐘前`;
  const who = a.recent_speakers.length > 0 ? `(${a.recent_speakers.slice(0, 4).join("、")})` : "";
  return `;${a.lively ? "正在聊天:" : ""}最近 ${a.recent_utterances} 句${who},最後一句 ${last}`;
}

/**
 * What she is singing where she is in voice (`guild`), and whether she can hear the voice
 * channel. Without it she took people listening to her song for a silent channel, and thought
 * the set list was done while songs were still playing and queued.
 */
export function singing(
  services: ServiceLookup,
  guild: string | null,
): { note: string; deaf: boolean } {
  const floor = guild === null ? undefined : services.get(VoiceFloorKey);
  const deaf = services.get(SpeechPauseKey)?.paused() === "song";
  const lines: string[] = [];
  if (guild !== null && floor) {
    const now = floor.holder(guild) !== null;
    if (now) lines.push("你正在唱歌:語音裡安靜是大家在聽,不是沒人。");
    const left = (floor.pending?.(guild) ?? 0) - (now ? 1 : 0);
    if (left > 0) lines.push(`歌單還有 ${left} 首在準備或等著唱,還沒唱完。`);
  }
  if (deaf) {
    lines.push(
      "歌正在做(顯示卡給了唱歌),你暫時聽不到語音裡的人說話,也不能講話;聽不到不代表沒人講。",
    );
  }
  if (lines.length === 0) return { note: "", deaf };
  return { note: ["唱歌:", ...lines.map((l) => `- ${l}`)].join("\n"), deaf };
}

/** Her crush and her emotions toward someone (`你偷偷喜歡的人;想念 0.40`); `null` if nothing. */
export function heartLine(self: SelfState | undefined, person: PersonId): string | null {
  if (!self?.heart) return null;
  const parts: string[] = [];
  if (self.crush?.()?.person === person) parts.push("你偷偷喜歡的人");
  const h = self.heart(person);
  for (const name of PERSON_EMOTION_NAMES) {
    const v = h?.emotions[name] ?? 0;
    if (v >= 0.2) parts.push(`${PERSON_EMOTION_LABELS[name]} ${v.toFixed(2)}`);
  }
  return parts.length === 0 ? null : parts.join(";");
}

export async function gather(input: GatherInput): Promise<Gathered> {
  const { services } = input;
  const worldState = services.get(WorldStateKey);
  const world = worldState?.snapshot() ?? null;
  const focus = focusOf(input.triggers, input.suggestions, world);
  const guild = focus?.scope ?? null;
  const inGuild = (c: ContextKey) => guild === null || c.scope === guild;
  const songs = singing(services, world?.her.voice?.scope ?? null);
  const deaf = songs.deaf;
  const summary = [
    worldState?.summary(focus !== null && focus.kind !== "dm" ? { context: focus } : {}) ?? "",
    songs.note,
  ]
    .filter((part) => part !== "")
    .join("\n");

  // ---- places
  const places: PlaceRef[] = [];
  const seen = new Set<string>();
  const addPlace = async (context: ContextKey, fallback: string, note: string) => {
    const key = contextKeyString(context);
    if (seen.has(key) || places.length >= MAX_PLACES || context.kind === "dm") return;
    seen.add(key);
    const here =
      context.kind === "voice" &&
      world?.her.voice?.channel === context.channel &&
      world.her.voice.scope === context.scope;
    places.push({
      ref: `p${places.length + 1}`,
      context,
      label: await label(services, input.labels, context, fallback),
      note,
      here,
    });
  };
  const voiceName = (c: ContextKey) =>
    world?.voice_channels.find((v) => v.channel === c.channel && v.guild === c.scope)?.name ?? null;
  const placeName = (c: ContextKey) =>
    c.kind === "voice" ? `語音頻道 ${voiceName(c) ?? c.channel}` : `文字頻道 ${c.channel}`;
  if (focus !== null) await addPlace(focus, placeName(focus), "");
  if (world?.her.voice && inGuild(world.her.voice)) {
    await addPlace(world.her.voice, placeName(world.her.voice), "");
  }
  for (const c of (world?.channels ?? [])
    .filter((c) => inGuild(c.context))
    .slice(0, MAX_CHANNELS)) {
    const topic = c.topic.length > 0 ? `,話題:${c.topic.slice(0, 5).join("、")}` : "";
    await addPlace(
      c.context,
      placeName(c.context),
      `最近 ${c.recent_messages} 則${c.lively ? "(很熱鬧)" : ""}${topic}`,
    );
  }
  for (const v of world?.voice_channels ?? []) {
    if (guild !== null && v.guild !== guild) continue;
    const people = v.members.filter((m) => !m.is_self);
    if (people.length === 0) continue;
    const context: ContextKey = {
      platform: v.platform,
      scope: v.guild,
      channel: v.channel,
      kind: "voice",
    };
    await addPlace(
      context,
      `語音頻道 ${v.name ?? v.channel}`,
      `裡面有 ${people.map((m) => m.display_name).join("、")}${voiceTalk(v, deaf)}`,
    );
  }
  // Fill in the notes of places added first (focus, her voice channel).
  for (const p of places) {
    if (p.note !== "") continue;
    const activity = world?.channels.find(
      (c) => contextKeyString(c.context) === contextKeyString(p.context),
    );
    if (activity) p.note = `最近 ${activity.recent_messages} 則`;
    const v = world?.voice_channels.find(
      (x) => x.channel === p.context.channel && x.guild === p.context.scope,
    );
    if (v && p.context.kind === "voice") {
      const people = v.members.filter((m) => !m.is_self).map((m) => m.display_name);
      p.note = people.length > 0 ? `裡面有 ${people.join("、")}${voiceTalk(v, deaf)}` : "沒有人";
    }
  }
  // The owner's level of each text channel: a ceiling on her talking there.
  const sink = services.get(IntentSinkKey);
  for (const p of places) {
    const ceiling = sink?.ceiling?.(p.context) ?? null;
    if (ceiling === null) continue;
    const level = `聊天等級「${ceiling.label}」${ceiling.blocked === null ? "" : ",現在不能主動開口"}`;
    p.note = p.note === "" ? level : `${p.note};${level}`;
  }

  // ---- people
  const social = services.get(SocialSignalsKey);
  const self: SelfState | undefined = services.get(SelfStateKey);
  const people: PersonRef[] = [];
  const addPerson = (account: AccountRef, name: string | null) => {
    if (people.length >= MAX_PEOPLE || people.some((p) => sameAccount(p.account, account))) return;
    const presence = worldState?.person(account) ?? null;
    const attitude = social?.attitude(account) ?? null;
    if (attitude?.blocked) return;
    const person = attitude?.person ?? presence?.person ?? null;
    const activity = presence?.activities.find((a) => a.type !== "custom") ?? null;
    people.push({
      ref: `u${people.length + 1}`,
      account,
      person,
      name: name ?? presence?.display_name ?? account.id,
      relation:
        attitude === null
          ? null
          : `${attitude.label || "認識的人"},好感 ${Math.round(attitude.affinity)}、熟悉 ${Math.round(attitude.familiarity)}`,
      feeling: person === null ? null : (self?.feeling(person)?.text ?? null),
      heart: person === null ? null : heartLine(self, person),
      doing:
        activity === null
          ? presence?.voice
            ? "在語音頻道"
            : null
          : `${activity.type === "playing" ? "在玩" : activity.type === "listening" ? "在聽" : "在看"} ${activity.name}`,
    });
  };
  for (const e of input.salient) if (e.account) addPerson(e.account, e.display_name);
  for (const s of input.suggestions) for (const a of s.about) addPerson(a, null);
  for (const v of world?.voice_channels ?? []) {
    if (guild !== null && v.guild !== guild) continue;
    for (const m of v.members) if (!m.is_self) addPerson(m.account, m.display_name);
  }

  // ---- agenda
  const agenda: AgendaRef[] = (self?.agenda() ?? [])
    .slice(0, MAX_AGENDA)
    .map((item, i) => ({ ref: `g${i + 1}`, item }));

  // ---- memories
  let memories: string | null = null;
  const registry = services.get(PromptContributorsKey);
  if (registry && focus !== null && focus.kind !== "dm" && input.contributors.length > 0) {
    const query = [...input.triggers.map((t) => t.detail), ...input.suggestions.map((s) => s.hint)]
      .join("\n")
      .trim();
    const request = {
      profile: input.profile,
      turn: newId(),
      context: focus,
      participants: people.map((p) => ({
        account: p.account,
        display_name: p.name,
        person: p.person,
      })),
      speakers: [],
      query,
      recent: [],
      voice: focus.kind === "voice",
      now: toTimestamp(input.now),
    };
    const sections: PromptSection[] = [];
    for (const contributor of registry.all()) {
      if (!input.contributors.includes(contributor.key)) continue;
      const controller = new AbortController();
      try {
        const got = await withTimeout(
          contributor.contribute(request, controller.signal),
          CONTRIBUTOR_TIMEOUT_MS,
        );
        if (got === undefined) controller.abort();
        else sections.push(...got);
      } catch (error) {
        log.debug({ contributor: contributor.key, err: errorMessage(error) }, "contributor failed");
      }
    }
    // Bodies are cut before wrapping, so every block stays closed.
    const per = Math.floor(MAX_MEMORY_CHARS / Math.max(sections.length, 1));
    const rendered = sections
      .filter((s) => s.body.trim() !== "")
      .map((s) => {
        const body = [...s.body.trim()];
        const cut = body.length > per ? `${body.slice(0, per).join("")}…` : body.join("");
        return dataBlock(s.key, s.title, cut);
      })
      .join("\n\n");
    memories = rendered === "" ? null : rendered;
  }

  // ---- her own notes: documents, lessons, the conversation's recap
  const persons = people.flatMap((p) => (p.person === null ? [] : [p.person]));
  let documents: string | null = null;
  const kb = services.get(KnowledgeKey);
  if (kb) {
    const subjects: KnowledgeSubject[] = persons.map((person) => ({ type: "person", person }));
    if (focus?.scope && focus.kind !== "dm") {
      subjects.push({ type: "guild", platform: focus.platform, guild: focus.scope });
    }
    subjects.push({ type: "self" });
    const text = kb.render(subjects, { context: focus, maxChars: MAX_DOCUMENT_CHARS });
    documents = text === "" ? null : text;
  }
  const lessons = (services.get(LessonsKey)?.applicable(focus, persons) ?? [])
    .slice(0, MAX_LESSONS)
    .map((l) => l.text);
  const recap = focus ? (services.get(ConversationStatesKey)?.get(focus)?.recap ?? null) : null;

  return {
    focus,
    world: summary,
    places,
    people,
    agenda,
    memories,
    documents,
    lessons,
    recap: recap === null || recap.trim() === "" ? null : recap,
  };
}

/** The capabilities she may start, besides `chat.start` / `chat.dm` (described separately). */
export function capabilityInfo(registry: ActuatorRegistry | undefined): CapabilityInfo[] {
  if (!registry) return [];
  return registry
    .names()
    .filter((n) => !NOT_FOR_HER.includes(n) && n !== CHAT_START && n !== CHAT_DM)
    .flatMap((n) => {
      const c = registry.get(n);
      if (!c || c.available?.() === false) return [];
      return [
        {
          name: c.name,
          summary: c.summary,
          risk: c.risk,
          params: Object.keys(c.tool?.properties ?? {}),
        },
      ];
    });
}
