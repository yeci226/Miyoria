import type * as Bus from "@miyoria/contracts/events";
import { accountString, contextShort } from "./format";

/** A bus envelope as the event stream sends it (`GET /api/events`). */
export type BusEnvelope = Bus.BusEnvelopeJson;

/** A bus envelope of the event `D` defines: its `type`, and `data` as its payload. */
type Of<D extends Bus.AnyEventDefinition> = Omit<BusEnvelope, "type" | "data"> & {
  type: D["type"];
  data: Bus.EventPayload<D>;
};

/** The events the list puts in words; any other shows its payload. */
type Worded =
  | Of<typeof Bus.PlatformReady>
  | Of<typeof Bus.PlatformMessageCreated>
  | Of<typeof Bus.PlatformTyping>
  | Of<typeof Bus.AgentTurnStarted>
  | Of<typeof Bus.AgentDecision>
  | Of<typeof Bus.AgentTurnCompleted>
  | Of<typeof Bus.ActionCompleted>
  | Of<typeof Bus.VoiceJoined>
  | Of<typeof Bus.VoiceLeft>
  | Of<typeof Bus.VoiceParticipants>
  | Of<typeof Bus.VoiceSpeaking>
  | Of<typeof Bus.VoiceUtteranceEvent>
  | Of<typeof Bus.VoicePlaybackEvent>
  | Of<typeof Bus.AgentInitiative>
  | Of<typeof Bus.SystemModuleState>;

/** The payload of one of those types: `Payload<"voice.utterance">`. */
export type Payload<T extends Worded["type"]> = Extract<Worded, { type: T }>["data"];

/**
 * `env` as the event its `type` names, for the types the panel reads the payload of. The payload
 * is not checked: the Core checked it against the contract before sending it.
 */
export function asEvent(env: BusEnvelope): Worded {
  return env as Worded;
}

/**
 * Same semantics as the kernel's `TopicFilter`: `*` matches everything,
 * `agent.*` matches anything below `agent` (not `agent` itself), otherwise exact.
 */
export function topicMatches(pattern: string, topic: string): boolean {
  const p = pattern.trim();
  if (!p || p === "*") return true;
  if (p.endsWith(".*")) {
    const prefix = p.slice(0, -2);
    return topic.startsWith(`${prefix}.`);
  }
  return p === topic;
}

export function matchesAny(patterns: string[], topic: string): boolean {
  const ps = patterns.map((p) => p.trim()).filter(Boolean);
  return ps.length === 0 || ps.some((p) => topicMatches(p, topic));
}

/** Parses a comma / whitespace separated topic filter. */
export const parseTopics = (raw: string): string[] => raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);

export type Tone = "neutral" | "accent" | "ok" | "warn" | "danger";

/** First segment of the topic, used to color the ticker. */
export function topicGroup(topic: string): string {
  return topic.split(".")[0] ?? topic;
}

const clip = (s: string, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface EventSummary {
  text: string;
  tone: Tone;
}

/** One-line, human description of an envelope for tickers and lists. */
export function summarize(env: BusEnvelope): EventSummary {
  const e = asEvent(env);
  switch (e.type) {
    case "platform.ready":
      return { text: `${e.data.platform} 已連線(${accountString(e.data.self_account)})`, tone: "ok" };
    case "platform.message.created":
      return { text: `${e.data.author.display_name}:${clip(e.data.text)}`, tone: "neutral" };
    case "platform.typing":
      return { text: `${accountString(e.data.account)} 正在輸入…`, tone: "neutral" };
    case "agent.turn.started":
      return { text: `回合開始 · ${contextShort(e.data.context)}`, tone: "accent" };
    case "agent.decision":
      return {
        text: `${e.data.respond ? "回應" : "略過"} · 分數 ${e.data.score.toFixed(2)}${e.data.reasons[0] ? ` · ${clip(e.data.reasons[0], 60)}` : ""}`,
        tone: e.data.respond ? "accent" : "neutral",
      };
    case "agent.turn.completed":
      return { text: `她說:${clip(e.data.text)}`, tone: "accent" };
    case "action.completed":
      return e.data.ok
        ? { text: "動作完成", tone: "ok" }
        : { text: `動作失敗:${clip(e.data.error ?? "未知錯誤")}`, tone: "danger" };
    case "voice.joined":
      return { text: `加入語音 · ${e.data.participants.length} 人`, tone: "ok" };
    case "voice.left":
      return { text: `離開語音${e.data.reason ? `(${e.data.reason})` : ""}`, tone: "neutral" };
    case "voice.participants":
      return { text: `語音成員變動 · ${e.data.participants.length} 人`, tone: "neutral" };
    case "voice.speaking":
      return { text: `${accountString(e.data.account)} ${e.data.speaking ? "開始說話" : "停止說話"}`, tone: "neutral" };
    case "voice.utterance":
      return { text: `${e.data.speaker.display_name}(語音):${clip(e.data.text)}`, tone: "neutral" };
    case "voice.playback": {
      const label = { started: "開始播放", finished: "播放結束", interrupted: "被打斷", failed: "播放失敗" }[e.data.state];
      return { text: `${label} · ${clip(e.data.text, 60)}`, tone: e.data.state === "failed" ? "danger" : e.data.state === "interrupted" ? "warn" : "accent" };
    }
    case "agent.initiative":
      return { text: `主動發言:${e.data.reason}${e.data.hint ? ` · ${clip(e.data.hint, 60)}` : ""}`, tone: "accent" };
    case "system.module.state": {
      const s = e.data.state;
      return {
        text: `${e.data.module} → ${s}${e.data.reason ? `(${clip(e.data.reason, 60)})` : ""}`,
        tone: s === "failed" ? "danger" : s === "degraded" ? "warn" : s === "running" ? "ok" : "neutral",
      };
    }
    default: {
      const payload = env.data;
      const text = payload === null || payload === undefined ? "" : clip(JSON.stringify(payload), 100);
      return { text, tone: env.type === "llm.budget" ? "warn" : "neutral" };
    }
  }
}
