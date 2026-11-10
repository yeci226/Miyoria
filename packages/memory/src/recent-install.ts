// The v4 §5 readers built on one memory engine, and the prompt contributors and tools they
// register: `just_now` (「剛才」), `elsewhere` (「別的地方」), `notebook` (her page index) and
// the `notebook_*` tools. Services are looked up when used, so the start order of modules does
// not matter.

import type { ServiceLookup } from "@miyoria/kernel";
import type { ToolRegistry } from "@miyoria/tools";
import {
  AffectStateKey,
  type Clock,
  ConversationStatesKey,
  ElsewhereKey,
  JustNowKey,
  KnowledgeKey,
  NotebookKey,
  PersonProfilesKey,
  PersonThreadsKey,
  PlaceAccessKey,
  type PromptContributor,
  type PromptContributors,
  type PromptRequest,
  type PromptSection,
  type ServiceKey,
  SocialSignalsKey,
  type Whereabouts,
} from "@miyoria/types";
import { speakingPeople } from "./contributor.js";
import type { MemoryEngine } from "./engine.js";
import { indexText, NotebookStore } from "./notebook.js";
import {
  NOTEBOOK_TOOLS,
  NotebookDeleteTool,
  NotebookReadTool,
  NotebookWriteTool,
} from "./notebook-tools.js";
import { Profiles } from "./profiles.js";
import { OtherPlaces, type RecentDeps, Timeline, viewerFor } from "./recent.js";
import { RecentLog } from "./recent-log.js";
import { presentPeople } from "./scope.js";
import { Threads } from "./threads.js";

export const JUST_NOW_CONTRIBUTOR = "just_now";
export const JUST_NOW_TITLE = "剛才(最近幾小時,各個地方)";
export const ELSEWHERE_CONTRIBUTOR = "elsewhere";
export const ELSEWHERE_TITLE = "你在的其他地方正在聊的";
export const NOTEBOOK_CONTRIBUTOR = "notebook";
export const NOTEBOOK_TITLE = "你的筆記本(目錄,用 notebook_read 讀)";

/** Where a prompt request is, as the readers take it. */
export function whereaboutsOf(request: PromptRequest): Whereabouts {
  return {
    context: request.context,
    present: presentPeople(request),
    talking_with: speakingPeople(request),
    accounts: [...request.participants.map((p) => p.account), ...request.speakers],
    now: request.now,
  };
}

/** The readers of one engine. */
export class RecentPast {
  readonly log: RecentLog;
  readonly timeline: Timeline;
  readonly elsewhere: OtherPlaces;
  readonly threads: Threads;
  readonly profiles: Profiles;
  readonly notebook: NotebookStore;
  readonly deps: RecentDeps;

  constructor(engine: MemoryEngine, services: ServiceLookup, clock: Clock) {
    const config = () => engine.config.recent;
    this.deps = {
      config,
      handles: () => engine.handles,
      access: () => services.get(PlaceAccessKey) ?? null,
      states: () => services.get(ConversationStatesKey) ?? null,
      utcOffsetMinutes: engine.config.utc_offset_minutes,
    };
    this.log = new RecentLog(
      config,
      () => engine.events,
      () => engine.exclusions,
    );
    this.timeline = new Timeline(this.log, this.deps);
    this.elsewhere = new OtherPlaces(this.log, this.deps);
    this.threads = new Threads(
      this.log,
      config,
      () => engine.handles,
      (where, window) => viewerFor(where, window, this.deps),
    );
    this.profiles = new Profiles(engine, this.log, this.threads, this.deps, {
      config: () => engine.config.profiles,
      affect: () => services.get(AffectStateKey) ?? null,
      social: () => services.get(SocialSignalsKey) ?? null,
      knowledge: () => services.get(KnowledgeKey) ?? null,
      events: () => engine.events,
      handles: () => engine.handles,
    });
    this.notebook = new NotebookStore({
      settings: engine.settings,
      profile: engine.profile,
      config: () => engine.config.notebook,
      handles: () => engine.handles,
      clock,
    });
  }

  /** What the module provides. */
  provide(provide: <T>(key: ServiceKey<T>, value: T) => void): void {
    provide(JustNowKey, this.timeline);
    provide(ElsewhereKey, this.elsewhere);
    provide(PersonThreadsKey, this.threads);
    provide(PersonProfilesKey, this.profiles);
    provide(NotebookKey, this.notebook);
  }

  /** The prompt contributors (none when `recent.contributors` is off, no index without pages). */
  contributors(engine: MemoryEngine): PromptContributor[] {
    const out: PromptContributor[] = [];
    const section = (key: string, title: string, body: string, order: number): PromptSection[] =>
      body.trim() === "" ? [] : [{ key, title, body, order }];
    if (engine.config.recent.contributors) {
      out.push({
        key: JUST_NOW_CONTRIBUTOR,
        contribute: async (request) =>
          section(
            JUST_NOW_CONTRIBUTOR,
            JUST_NOW_TITLE,
            await this.timeline.render(whereaboutsOf(request), engine.config.recent.just_now_chars),
            6,
          ),
      });
      out.push({
        key: ELSEWHERE_CONTRIBUTOR,
        contribute: async (request) =>
          section(
            ELSEWHERE_CONTRIBUTOR,
            ELSEWHERE_TITLE,
            await this.elsewhere.render(
              whereaboutsOf(request),
              engine.config.recent.elsewhere_chars,
            ),
            7,
          ),
      });
    }
    if (engine.config.notebook.enabled) {
      out.push({
        key: NOTEBOOK_CONTRIBUTOR,
        contribute: async (request) =>
          section(
            NOTEBOOK_CONTRIBUTOR,
            NOTEBOOK_TITLE,
            indexText(
              this.notebook.index({ context: request.context, accounts: request.speakers }),
              engine.config.notebook.index_chars,
            ),
            30,
          ),
      });
    }
    return out;
  }

  register(registry: PromptContributors, engine: MemoryEngine): string[] {
    const keys: string[] = [];
    for (const c of this.contributors(engine)) {
      registry.register(c);
      keys.push(c.key);
    }
    return keys;
  }

  registerTools(tools: ToolRegistry, engine: MemoryEngine): string[] {
    if (!engine.config.notebook.enabled) return [];
    const config = () => engine.config.notebook;
    tools.register(new NotebookReadTool(this.notebook, config));
    tools.register(new NotebookWriteTool(this.notebook));
    tools.register(new NotebookDeleteTool(this.notebook));
    return [...NOTEBOOK_TOOLS];
  }
}
