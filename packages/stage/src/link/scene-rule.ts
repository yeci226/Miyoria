// The scene as a function of her situation (docs/design/v2-architecture.md §3.2):
// `scene = f(presence, broadcast, activity, her override)`, plus the few windows only the stage
// knows (the starting scene after going live, the ending scene, brb after silence, back to the
// scene before a song). Pure: same inputs, same answer. The scene director switches OBS to it;
// the ActivityManager shows it in its snapshot (`SceneRuleKey`).

import type { SceneRuleInput } from "@miyoria/types";
import { ROLE_NAME, type ScenesConfig } from "./scenes.js";

/** Her situation as the scene rule sees it. */
export interface SceneFacts {
  /** Streaming in OBS or live on Discord (or about to be). */
  live: boolean;
  /** When the stream went live (epoch ms), `null` while not live. */
  liveSince: number | null;
  /** In a voice channel. */
  inVoice: boolean;
  playing: boolean;
  /** The game being played (its id, e.g. `threads`): a role of that name wins over `game`. */
  game: string | null;
  singing: boolean;
  /** Her timed override (`stage.scene`), `null` when none or expired. */
  override: { scene: string; until: number } | null;
}

/** What the director remembers over time (the windows the facts cannot tell). */
export interface SceneMemory {
  /** The stream ended (or is ending): hold the ending scene until `endingUntil`. */
  ended: boolean;
  endingUntil: number;
  /** After a song: the scene to go back to. */
  returnTo: string | null;
  /** Last time anyone talked (her speech, an utterance, a finished turn). */
  lastActivity: number;
  /** She was in voice at some point of this live session. */
  voiceThisLive: boolean;
}

/** Why a role (or a scene) is wanted (for the log and the audit `why`). */
export interface Want {
  /** `null`: a scene without a role (going back after a song, her override). */
  role: string | null;
  /** A scene of its own instead of the role's. */
  scene?: string;
  why: string;
  /** Skips the debounce, the minimum interval and the manual hold. */
  urgent: boolean;
}

export const NO_FACTS: SceneFacts = {
  live: false,
  liveSince: null,
  inVoice: false,
  playing: false,
  game: null,
  singing: false,
  override: null,
};

/** The scene facts of an ActivitySnapshot (`now`: epoch ms, for the override's expiry). */
export function factsOf(input: SceneRuleInput, now: number): SceneFacts {
  const b = input.broadcast;
  // Live once Go Live or OBS is actually up: a start that fails (OBS 沒開) never shows the
  // starting scene and then the ending one.
  const since = b.type === "starting" || b.type === "live" ? Date.parse(b.since) : null;
  const live = since !== null && b.type !== "off" && (b.golive || b.obs);
  const a = input.activity;
  const running = a.type !== "idle" && a.phase === "running";
  const until = input.override === null ? Number.NaN : Date.parse(input.override.until);
  return {
    live,
    liveSince: live ? since : null,
    inVoice: input.presence.type === "in" || input.presence.type === "leaving",
    // A game (or the browser) shows its scene while it runs; starting it is still chat.
    playing: running && (a.type === "game" || a.type === "browse"),
    game: running && (a.type === "game" || a.type === "browse") ? a.target : null,
    singing: running && a.type === "singing",
    override:
      input.override !== null && until > now ? { scene: input.override.scene, until } : null,
  };
}

/** Live, not playing or singing, and nobody talked for `brb_after_ms` (or she left voice). */
export function away(
  facts: SceneFacts,
  memory: SceneMemory,
  config: ScenesConfig,
  now: number,
): boolean {
  if (!facts.live || facts.playing || facts.singing) return false;
  if (config.brb_on_voice_leave && memory.voiceThisLive && !facts.inVoice) return true;
  const after = config.brb_after_ms;
  return after > 0 && now - memory.lastActivity >= after;
}

/**
 * The roles that fit her situation, most specific first; the first one with a scene wins (so
 * going live without a starting scene keeps the game scene while she plays).
 */
export function sceneWants(
  facts: SceneFacts,
  memory: SceneMemory,
  config: ScenesConfig,
  roleOf: (scene: string) => string | null,
  now: number,
): Want[] {
  const live = facts.live;
  const out: Want[] = [];
  if (memory.ended && (!live || now < memory.endingUntil)) {
    out.push({ role: "ending", why: "直播結束", urgent: true });
  }
  // Her own choice, for as long as she asked.
  if (facts.override !== null && facts.override.until > now) {
    const scene = facts.override.scene;
    out.push({ role: roleOf(scene), scene, why: "她自己選的畫面", urgent: true });
  }
  if (!live && config.only_while_live) return out;
  if (memory.returnTo !== null) {
    const scene = memory.returnTo;
    out.push({ role: roleOf(scene), scene, why: "唱完歌,回到原本的畫面", urgent: true });
  }
  if (facts.singing) out.push({ role: "sing", why: "唱歌", urgent: true });
  if (live && facts.liveSince !== null && now < facts.liveSince + config.starting_ms) {
    out.push({ role: "starting", why: "開台", urgent: true });
  }
  if (away(facts, memory, config, now)) {
    out.push({ role: "brb", why: "暫時沒有人在講話或她離開了語音", urgent: false });
  }
  if (facts.playing && facts.game !== null && ROLE_NAME.test(facts.game)) {
    out.push({ role: facts.game, why: `開始${facts.game}`, urgent: false });
  }
  if (facts.playing) out.push({ role: "game", why: "開始玩遊戲", urgent: false });
  out.push({ role: "chat", why: "回到聊天", urgent: false });
  return out;
}

/** The first want with a scene. */
export function pickScene(
  wants: readonly Want[],
  resolve: (role: string) => string | null,
): (Want & { scene: string }) | null {
  for (const want of wants) {
    const scene = want.scene ?? (want.role === null ? null : resolve(want.role));
    if (scene !== null) return { ...want, scene };
  }
  return null;
}
