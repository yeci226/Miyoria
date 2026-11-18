// Subject `self`: the phase-3 turn runner (`@miyoria/brain/self`), one run of its text profile per
// scene, against whatever router the caller passes (the live one, or a scripted one in tests).
//
// What it is given:
// - block 1: her real persona (`Profile.personaPrompt`), then the runner's own rules (`rules.ts`);
// - block 4: the scene's people as person cards, rendered by today's people block (`peopleBody`)
//   from a heart row made of the closeness the scene sets;
// - block 7: the time (the scene's clock when it sets one), the place and her state line;
// - the transcript: the scene's lines in a fresh in-memory transcript store;
// - tools: a fresh registry with `find_tools` and `say`, and the scene's fake-world tools, all
//   always on except the ones `hidden` names for the scene: those she has to find first;
// - the guard: the service guard over the one service that runs without a network, the output
//   moderation's local rules (`Moderation`); no owner rules, no Floor, no gate, no budget;
// - what woke her: a mention or a DM as addressed, a scene nobody calls her in as a glance;
// - a scene she answers aloud (`spoken`) runs the voice profile: what the outlet gets are the
//   sentences she would say.
//
// Nothing carries over from one scene to the next.

import { PRESENT_TITLE, type PresentPerson, peopleBody } from "@miyoria/brain/agent";
import {
  type Outlet,
  PROFILES,
  type PromptSource,
  type RunEvent,
  SelfRunner,
  sayTool,
  serviceGuard,
  type Wake,
} from "@miyoria/brain/self";
import { Moderation, ModerationConfigSchema } from "@miyoria/gate/moderation";
import type { LlmRouter } from "@miyoria/llm/llm";
import { type Tool, type ToolEffect, ToolRegistry } from "@miyoria/llm/tools";
import { transcriptTables } from "@miyoria/memory/transcript";
import { getLogger } from "@miyoria/runtime/kernel";
import type { Profile } from "@miyoria/runtime/profile";
import { SqliteStore } from "@miyoria/store";
import {
  type AccountRef,
  type Attitude,
  type Clock,
  type ContextKey,
  contextKeyString,
  dataBlock,
  type HeartView,
  isJsonObject,
  ModerationKey,
  type PersonId,
  relationshipLabel,
  type ServiceKey,
  toTimestamp,
} from "@miyoria/types";
import { FAKE_TOOL_SPECS } from "./fake-tools.js";
import type { Meter } from "./meter.js";
import {
  type Closeness,
  type Reply,
  type ReplyCall,
  type Scene,
  type ScenePerson,
  type Subject,
  subUsage,
} from "./subject.js";

/** The scene in which a tool she needs is not offered at first: she finds it with `find_tools`. */
export const HIDDEN_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "tools-move-a-reminder": ["remind_me"],
};

export interface SelfOptions {
  router: LlmRouter;
  /** The meter the router's providers are wrapped with: a reply's usage is what it counted. */
  meter: Meter;
  profile: Profile;
  /** The longest one run may take (default 180 s). */
  timeoutMs?: number;
  /** The fake tools of `scene` that are not always offered. Default: `HIDDEN_TOOLS`. */
  hidden?: (scene: Scene) => readonly string[];
  /** Every event of a run (for looking into one). */
  onEvent?: (event: RunEvent) => void;
}

const PLATFORM = "eval";

/** What `find_tools` files a fake tool under, and what it does to the fake world. */
const FAKE_META: Readonly<Record<string, { group: string; effect: ToolEffect }>> = {
  web_search: { group: "web", effect: "read" },
  web_read: { group: "web", effect: "read" },
  code_run: { group: "code", effect: "act" },
  notebook_read: { group: "notebook", effect: "read" },
  notebook_write: { group: "notebook", effect: "act" },
  workspace_read: { group: "workspace", effect: "read" },
  workspace_write: { group: "workspace", effect: "act" },
  workspace_list: { group: "workspace", effect: "read" },
  remind_me: { group: "schedule", effect: "act" },
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi);

function accountOf(index: number): AccountRef {
  return { platform: PLATFORM, id: `u${index + 1}` };
}

function personOf(index: number): PersonId {
  return `eval-person-${index + 1}` as PersonId;
}

function attitudeOf(index: number, person: ScenePerson, c: Closeness): Attitude {
  const familiarity = clamp(c.familiarity ?? c.bond, 0, 100);
  return {
    person: personOf(index),
    affinity: clamp(c.bond, -100, 1000),
    trust: clamp(c.trust ?? c.bond, 0, 100),
    familiarity,
    blocked: false,
    label: relationshipLabel({ affinity: c.bond }),
    call_name: null,
    display_name: person.name,
  };
}

/** The heart's warmth baseline by bond (`heart/person/src/rules.ts`), through its own points. */
function warmthOf(bond: number): number {
  const points: readonly (readonly [number, number])[] = [
    [-100, -0.6],
    [-15, -0.1],
    [0, 0],
    [45, 0.2],
    [120, 0.4],
    [300, 0.55],
    [600, 0.7],
    [1000, 0.8],
  ];
  let [x0, y0] = points[0] as readonly [number, number];
  for (const [x1, y1] of points) {
    if (bond <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (bond - x0)) / (x1 - x0);
    [x0, y0] = [x1, y1];
  }
  return y0;
}

/** The heart row the scene's closeness stands for: the slow values set, the rest what they would normally be. */
function heartViewOf(index: number, c: Closeness): HeartView {
  return {
    person: personOf(index),
    bond: clamp(c.bond, -100, 1000),
    trust: clamp(c.trust ?? c.bond, 0, 100),
    familiarity: clamp(c.familiarity ?? c.bond, 0, 100),
    // What these are for someone she knows that well when nothing in particular is going on
    // (the heart's warmth baseline and the migration's starting ease and rapport, by hand: the
    // eval does not depend on the heart package). Left at zero, a close friend would read
    // 「拘謹、還沒默契」 beside a high bond.
    warmth: warmthOf(clamp(c.bond, -100, 1000)),
    respect: 0,
    ease: c.bond < 0 ? 0 : (0.8 * clamp(c.familiarity ?? c.bond, 0, 100)) / 100,
    grudge: 0,
    longing: 0,
    rapport: c.bond < 0 ? 0 : (0.6 * clamp(c.familiarity ?? c.bond, 0, 100)) / 100,
    stance: "",
    impression: "",
    call_name: null,
    tags: [],
    owner: false,
    blocked: false,
    last_seen: null,
    last_together: null,
  };
}

/** `YYYY-MM-DD HH:MM` in the local time zone, as epoch ms. */
function localMs(text: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/.exec(text);
  if (!m) throw new Error(`bad scene time ${text}`);
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
  ).getTime();
}

const WEEKDAYS = ["日", "一", "二", "三", "四", "五", "六"];

/** `2026-11-10 18:00(週二)`, local time. */
function localText(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes(),
  )}(週${WEEKDAYS[d.getDay()]})`;
}

export class SelfSubject implements Subject {
  readonly name = "self";
  readonly #o: SelfOptions;

  constructor(options: SelfOptions) {
    this.#o = options;
  }

  unsupported(scene: Scene): string | null {
    const unknown = (scene.tools?.tools ?? []).filter((t) => FAKE_TOOL_SPECS[t] === undefined);
    if (unknown.length > 0) return `no fake tool definition for ${unknown.join(", ")}`;
    if (scene.lines.length === 0 && scene.world === undefined) return "the scene has no line";
    if (scene.place === "dm" && scene.address !== "dm") return "a DM scene is addressed by `dm`";
    if (scene.place === "text" && scene.address === "dm") return "`dm` needs the place to be a DM";
    return null;
  }

  async respond(scene: Scene): Promise<Reply> {
    const shift = scene.now === undefined ? 0 : localMs(scene.now) - Date.now();
    const clock: Clock = { now: () => Date.now() + shift };
    const store = await SqliteStore.open(":memory:", { plugins: [transcriptTables], clock });
    try {
      return await this.#run(scene, store, clock);
    } finally {
      await store.close();
    }
  }

  async #run(scene: Scene, store: SqliteStore, clock: Clock): Promise<Reply> {
    const o = this.#o;
    const transcript = store.plugin(transcriptTables);
    const context: ContextKey =
      scene.place === "dm"
        ? { platform: PLATFORM, scope: null, channel: "dm-1", kind: "dm" }
        : { platform: PLATFORM, scope: "guild-1", channel: "channel-1", kind: "channel" };
    const session = { id: contextKeyString(context), context };

    // People and their lines.
    const accounts = new Map<string, AccountRef>();
    const attitudes = new Map<string, Attitude>();
    const views = new Map<PersonId, HeartView>();
    const present: PresentPerson[] = [];
    const last = scene.lines.at(-1);
    scene.people.forEach((p, i) => {
      const account = accountOf(i);
      accounts.set(p.name, account);
      if (p.closeness) {
        attitudes.set(account.id, attitudeOf(i, p, p.closeness));
        views.set(personOf(i), heartViewOf(i, p.closeness));
      }
      present.push({ account, handle: p.name, person: personOf(i), speaker: p.name === last?.who });
    });
    const accountFor = (who: string): AccountRef =>
      accounts.get(who) ?? { platform: PLATFORM, id: `guest-${who}` };
    let ts = clock.now() - scene.lines.length * 1000;
    if (scene.lines.length > 0) {
      transcript.append(
        session.id,
        scene.lines.map((line, i) => {
          ts += 1000;
          const lastLine = i === scene.lines.length - 1;
          return {
            kind: "other" as const,
            account: accountFor(line.who),
            author: line.who,
            content: line.text,
            message_id: `m${i + 1}`,
            addressed: lastLine && scene.address !== "none",
            at: toTimestamp(ts),
          };
        }),
        { context },
      );
    }

    // Tools: the fake world's, always on unless hidden for this scene.
    const calls: ReplyCall[] = [];
    const tools = new ToolRegistry();
    const hidden = new Set(o.hidden?.(scene) ?? HIDDEN_TOOLS[scene.id] ?? []);
    const env = scene.tools;
    for (const name of env?.tools ?? []) {
      const spec = FAKE_TOOL_SPECS[name];
      if (!spec || !env) continue;
      const meta = FAKE_META[name] ?? { group: "other", effect: spec.readOnly ? "read" : "act" };
      const tool: Tool = {
        spec: { name, description: spec.description, parameters: spec.parameters },
        meta: {
          effect: meta.effect,
          speed: "instant",
          risk: "low",
          group: meta.group,
          core: !hidden.has(name),
          next: true,
        },
        ...(spec.readOnly ? { readOnly: true } : {}),
        async call(_ctx, args) {
          const given = isJsonObject(args) ? (args as Record<string, unknown>) : {};
          const result = env.call(name, given);
          calls.push({ tool: name, args: given, ...result });
          if (!result.ok) throw new Error(result.text);
          return result.text;
        },
      };
      tools.register(tool);
    }

    // The blocks around the transcript.
    const attitude = (account: AccountRef) => attitudes.get(account.id) ?? null;
    const prompt: PromptSource = {
      fixed: async () => o.profile.personaPrompt(),
      pinned: async () => null,
      place: async () => {
        const body = peopleBody(present, {
          attitude,
          heart: { view: (person) => views.get(person) ?? null },
        });
        return body === "" ? null : dataBlock("people", PRESENT_TITLE, body);
      },
      recalled: async () => null,
      now: async () => {
        const lines = [`時間:${localText(clock.now())}`];
        lines.push(scene.place === "dm" ? `地點:${last?.who ?? ""} 的私訊` : "地點:文字頻道 #閒聊");
        if (scene.state !== undefined) lines.push(`你現在:${scene.state}`);
        return lines.join("\n");
      },
    };

    const said: string[] = [];
    const outlet: Outlet = {
      async deliver(line) {
        said.push(line.text);
        return { status: "delivered", message_id: `sent-${said.length}` };
      },
    };
    const moderation = new Moderation({ config: ModerationConfigSchema.parse({}) });
    const guard = serviceGuard({
      services: {
        get: <T>(key: ServiceKey<T>): T | undefined =>
          (key as ServiceKey<unknown>) === ModerationKey ? (moderation as T) : undefined,
      },
    });
    const runner = new SelfRunner(
      {
        transcript,
        tools,
        model: o.router,
        prompt,
        guard,
        outlet,
        clock,
        log: getLogger("eval.self"),
        ...(o.onEvent ? { onEvent: o.onEvent } : {}),
      },
      { compaction: null },
    );
    tools.register(sayTool({ resolve: () => null, sayIn: runner.sayIn }));

    const from = last === undefined ? null : { account: accountFor(last.who), name: last.who };
    const message = { context, id: `m${scene.lines.length}` };
    const wake: Wake =
      scene.world !== undefined
        ? { kind: "world", what: scene.world }
        : scene.address === "none" || from === null
          ? { kind: "glance", lines: scene.lines.length }
          : { kind: "addressed", reason: scene.address, from, message };

    const before = o.meter.usage();
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? 180_000);
    let timedOut = false;
    let feel: string[] = [];
    try {
      const result = await runner.run({
        session,
        wake,
        profile: scene.spoken ? PROFILES.voice : PROFILES.text,
        signal: controller.signal,
      });
      timedOut = result.outcome === "cancelled";
      feel = result.feel;
    } finally {
      clearTimeout(timer);
    }
    const lines = said.filter((l) => l.trim() !== "");
    return {
      lines,
      calls,
      silent: lines.length === 0,
      usage: subUsage(o.meter.usage(), before),
      ms: Math.max(0, Date.now() - started),
      ...(timedOut ? { timed_out: true } : {}),
      feel,
    };
  }
}
