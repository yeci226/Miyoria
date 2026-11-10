// The rules themselves: what is stored, who may change it, and the three layers (§9).
//
// `check` reads the store every time: it is on the action path, where a rule that cannot be read
// has to stop the action. `inject`, `filterTools` and `screen` run while a prompt is built, so they
// answer from the last read, which every write and every `check` keep current; expiry is compared
// at read time, so an expired rule never needs a timer to go away. Once a read fails they fail
// closed too, until a read works again.
//
// Nobody is exempt from a `deny`, the owner included: it ends when someone with the right removes
// it, never by asking around it. The one exception is stopping (see `isStopping`), because ending
// something can not break a rule about doing it, and an emergency stop must not depend on the
// store.

import { ActuatorRegistryKey, type Capability, capabilityMatches } from "@miyoria/actions";
import { errorMessage, getLogger, type ServiceLookup, withTimeout } from "@miyoria/kernel";
import { AuditLogKey, type DirectiveStore } from "@miyoria/store";
import { ToolRegistryKey } from "@miyoria/tools";
import {
  type AccountRef,
  ActivityManagerKey,
  AuthorizerKey,
  accountRefString,
  type Clock,
  type ContextKey,
  customEvent,
  DIRECTIVE_CHANGED_TOPIC,
  type Directive,
  type DirectiveActor,
  type DirectiveAuthority,
  type DirectiveChange,
  type DirectiveChangedBody,
  type DirectiveEffect,
  type DirectiveGoal,
  type DirectiveQuery,
  type DirectiveRecord,
  type DirectiveRefusal,
  type DirectiveRemoval,
  type DirectiveRequest,
  type DirectiveScope,
  type Directives,
  type DirectiveVerdict,
  directiveLive,
  type Event,
  EventLogKey,
  HandleDirectoryKey,
  type HerActivity,
  type JsonValue,
  newId,
  type Principal,
  Principals,
  type ProfileId,
  type Proposal,
  ProposalBoardKey,
  type ProposalResultBody,
  type Subject,
  sameAccount,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import { type DirectiveConfig, defaultDirectiveConfig } from "./config.js";
import {
  appliesIn,
  covers,
  isStopping,
  MIN_TERM,
  normalizeTerm,
  type RuleAction,
  subjectsOf,
} from "./match.js";

const log = getLogger("directive");

/** Lets a person make rules below the owner (moderators have it, admins through `admin.*`). */
export const NODE_MODERATE = "admin.directive.add";
/** Makes a person the owner of the rules (owners have it through `*`). */
export const NODE_OWNER = "owner.directive.manage";

/** What writes the log lines, and the actor of what the rules do on their own. */
const SOURCE = "directive";
/** How long the store may take to answer a check; after that the answer is no. */
const READ_TIMEOUT_MS = 2_000;
/** Rules a listing returns. */
const LIST_LIMIT = 200;
/** Longest rule text. */
const MAX_TEXT = 200;
/** Dropped proposals remembered, so a proposal is only written back once. */
const DROPPED_MEMORY = 256;
const DAY_MS = 86_400_000;

/** The capability that ends a song: the ActivityManager leaves songs to the singer. */
const SONG_STOP = "sing.stop";

/** Which capabilities are about each activity: a rule on `game.*` names the game she is playing. */
const ACTIVITY_ROOTS: Readonly<Record<string, string>> = { game: "game", singing: "sing" };

/** The tools that change the rules: always on the list, or a rule could never be lifted. */
export const RULE_TOOLS: ReadonlySet<string> = new Set(["directive_add", "directive_remove"]);

/** What goes in the system block while the rules cannot be read. */
export const RULES_UNREADABLE = "規則現在讀不到:先不要做任何動作,等規則恢復。";

/** A statement this unsure is not a rule yet. */
const HEDGED = /也許|或許|可能|好像|大概|看情況|不一定|要不要|是不是/;

/** Authorities that outrank each other, strongest first. */
const AUTHORITY_ORDER: Readonly<Record<DirectiveAuthority, number>> = {
  owner: 0,
  system: 1,
  moderator: 2,
  viewer: 3,
};

const AUTHORITY_LABEL: Readonly<Record<DirectiveAuthority, string>> = {
  owner: "主人",
  system: "系統",
  moderator: "管理員",
  viewer: "觀眾",
};

const EFFECT_LABEL: Readonly<Record<DirectiveEffect, string>> = {
  deny: "禁止",
  require_approval: "要先問過主人",
  avoid: "盡量不要",
  prefer: "偏好",
};

/** What a person is to the rules, weakest first. Nobody is `system`. */
const STANDINGS = ["blocked", "viewer", "moderator", "owner"] as const;

type Standing = (typeof STANDINGS)[number];

const ALLOW: DirectiveVerdict = { outcome: "allow" };

export interface DirectiveServiceOptions {
  services: ServiceLookup;
  store: DirectiveStore;
  profile: ProfileId;
  clock?: Clock;
  publish?: (event: Event) => void;
  config?: DirectiveConfig;
}

function enforced(rule: Pick<Directive, "effect">): boolean {
  return rule.effect === "deny" || rule.effect === "require_approval";
}

/** Whether a rule of `scope` names what is running: the thing itself, not "everything". */
function namesRunning(scope: DirectiveScope, running: HerActivity): boolean {
  if (running.type === "idle" || running.phase === "stopping" || running.phase === "failed") {
    return false;
  }
  if (scope.context !== undefined || scope.person !== undefined) return false;
  const { capability, activity } = scope;
  if (capability === undefined && activity === undefined) return false;
  if (capability !== undefined) {
    const root = capability.split(/[._]/)[0];
    if (root !== ACTIVITY_ROOTS[running.type] || isStopping(capability)) return false;
  }
  if (activity === undefined) return true;
  const term = normalizeTerm(activity);
  const doing = [running.type, running.target ?? ""].map(normalizeTerm);
  return term !== "" && doing.some((word) => word.includes(term));
}

function strongestFirst(a: Directive, b: Directive): number {
  return AUTHORITY_ORDER[a.authority] - AUTHORITY_ORDER[b.authority];
}

function reasonOf(rule: Directive): string {
  return `${AUTHORITY_LABEL[rule.authority]}定的規則:${rule.text}`;
}

/** One line with no control characters and an upper limit: this text ends up in a prompt. */
function cleanText(text: string): string {
  return text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_TEXT);
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("zh-TW", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function actorName(by: DirectiveActor): string {
  return by.type === "console" ? by.actor : accountRefString(by.subject.account);
}

function refused(reason: DirectiveRefusal, detail: string): DirectiveChange {
  return { status: "refused", reason, detail };
}

/** The other people a turn spoke for, as subjects of the same place. */
function subjectsIn(by: Extract<DirectiveActor, { type: "account" }>): Subject[] {
  const others = (by.askers ?? []).filter((a) => !sameAccount(a, by.subject.account));
  return [
    by.subject,
    ...others.map((account) => ({
      account,
      context: by.subject.context,
      platform_roles: [],
      is_guild_admin: false,
    })),
  ];
}

export class DirectiveService implements Directives {
  readonly #services: ServiceLookup;
  readonly #store: DirectiveStore;
  readonly #profile: ProfileId;
  readonly #clock: Clock;
  readonly #publish: (event: Event) => void;
  #config: DirectiveConfig;
  /** What the store said last; `null` until it said anything. */
  #rules: readonly Directive[] | null = null;
  #readable = false;
  readonly #dropped = new Set<string>();
  #prunedAt = 0;

  constructor(options: DirectiveServiceOptions) {
    this.#services = options.services;
    this.#store = options.store;
    this.#profile = options.profile;
    this.#clock = options.clock ?? systemClock;
    this.#publish = options.publish ?? (() => {});
    this.#config = options.config ?? defaultDirectiveConfig();
  }

  /** Applies `[modules.directive]`. */
  configure(config: DirectiveConfig): void {
    this.#config = config;
  }

  get config(): DirectiveConfig {
    return this.#config;
  }

  get healthy(): boolean {
    return this.#rules !== null && this.#readable;
  }

  #now(): number {
    return this.#clock.now();
  }

  // ---- reading --------------------------------------------------------------------------------

  /** The rules in force, from the store. Throws when it does not answer. */
  async #read(): Promise<readonly Directive[]> {
    try {
      const reading = this.#store.active(this.#profile, toTimestamp(this.#now()));
      // A late answer of a read that timed out must not surface as an unhandled rejection.
      reading.catch(() => undefined);
      const rules = await withTimeout(reading, READ_TIMEOUT_MS);
      if (rules === undefined) throw new Error("the store did not answer in time");
      this.#rules = rules;
      if (!this.#readable) log.info({ rules: rules.length }, "the rules can be read");
      this.#readable = true;
      return rules;
    } catch (error) {
      if (this.#readable) log.warn({ err: errorMessage(error) }, "cannot read the rules");
      this.#readable = false;
      throw error;
    }
  }

  /** Reads the rules again; never throws (a failure closes everything until the next read). */
  async refresh(): Promise<void> {
    try {
      await this.#read();
    } catch {
      return;
    }
    const now = this.#now();
    if (now - this.#prunedAt < DAY_MS) return;
    this.#prunedAt = now;
    const before = toTimestamp(now - this.#config.history_days * DAY_MS);
    try {
      await this.#store.prune(this.#profile, before);
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot prune ended rules");
    }
  }

  /** The last read, without what expired since. */
  #memory(): readonly Directive[] {
    const now = this.#now();
    return (this.#rules ?? []).filter((r) => directiveLive(r, now));
  }

  async list(options: { history?: boolean } = {}): Promise<DirectiveRecord[]> {
    if (options.history === true) return this.#store.all(this.#profile, LIST_LIMIT);
    // Not from the history: however many short requests came since, a rule in force is listed.
    const rules = await this.#store.active(this.#profile, toTimestamp(this.#now()));
    return rules.reverse();
  }

  // ---- layer 1: the system block --------------------------------------------------------------

  inject(context: ContextKey | null): string[] {
    if (!this.healthy) return [RULES_UNREADABLE];
    return this.#memory()
      .filter((r) => r.authority !== "viewer" && appliesIn(r.scope, context))
      .sort(strongestFirst)
      .map((r) => {
        const until =
          r.expires === "until_revoked" ? "直到解除" : `到 ${clockTime(Date.parse(r.expires))}`;
        return `${EFFECT_LABEL[r.effect]}:${r.text}(${AUTHORITY_LABEL[r.authority]},${until})`;
      });
  }

  wishes(context: ContextKey | null): string[] {
    if (!this.healthy) return [];
    return this.#memory()
      .filter((r) => r.authority === "viewer" && appliesIn(r.scope, context))
      .slice(-this.#config.max_viewer_wishes)
      .map((r) => `有觀眾希望「${r.text.replace(/[「」]/g, "")}」(不是規則,可以不理)`);
  }

  // ---- layer 2: the tool list -----------------------------------------------------------------

  filterTools<T extends { name: string }>(tools: readonly T[], context: ContextKey | null): T[] {
    const registry = this.#services.get(ActuatorRegistryKey);
    const byTool = new Map<string, Capability>();
    for (const name of registry?.names() ?? []) {
      const capability = registry?.get(name);
      if (capability?.tool) byTool.set(capability.tool.name, capability);
    }
    const open = this.healthy;
    const denies = this.#memory().filter((r) => r.effect === "deny");
    const principal = Principals.self(context);
    return tools.filter((tool) => {
      if (RULE_TOOLS.has(tool.name)) return true;
      const capability = byTool.get(tool.name);
      if (!open) return capability === undefined || isStopping(capability.name);
      // A tool is called with no arguments here: what it does by default is what it is.
      const action = capability
        ? this.#action({ capability: capability.name, args: {}, principal }, true)
        : { ...this.#action({ capability: null, args: {}, principal }), names: [tool.name] };
      return !denies.some((r) => covers(r.scope, action));
    });
  }

  // ---- layer 3: the action path ---------------------------------------------------------------

  /**
   * Everything the rules look at of one action. A capability's hooks answer for what `args` left
   * out; one that cannot makes `check` refuse, because then nobody knows what the action is
   * about. `guessing`: the arguments are not real yet (a tool list, a proposal), so that is fine.
   */
  #action(query: DirectiveQuery, guessing = false): RuleAction {
    const { capability: name, args = {}, principal } = query;
    const capability =
      name === null ? undefined : this.#services.get(ActuatorRegistryKey)?.get(name);
    const subjects = subjectsOf(args);
    if (name !== null) {
      const root = name.split(".")[0] ?? name;
      subjects.push(normalizeTerm(root));
      if (root === "game") {
        // `game.goal` does not say which game: the one she is playing.
        const activity = this.#services.get(ActivityManagerKey)?.snapshot().activity;
        if (activity?.type === "game") subjectsOf(activity.target, subjects);
      }
    }
    if (capability?.activity) {
      const requests = attempt(() => capability.activity?.(args, principal), guessing);
      for (const request of requests ?? []) {
        const { activity, target, goal } = request as {
          activity?: unknown;
          target?: unknown;
          goal?: unknown;
        };
        subjectsOf([activity, target, goal], subjects);
      }
    }
    const target =
      attempt(() => capability?.target?.(args, principal), guessing) ?? query.about ?? null;
    return {
      names: [name, capability?.tool?.name].filter((n) => typeof n === "string"),
      subjects,
      context: principal.context,
      people: target === null ? [] : this.#names(target),
      stopping: name !== null && isStopping(name),
    };
  }

  /** The names `account` goes by. */
  #names(account: AccountRef): string[] {
    const handles = this.#services.get(HandleDirectoryKey)?.list() ?? [];
    return [
      accountRefString(account),
      ...handles
        .filter((h) => h.account !== null && sameAccount(h.account, account))
        .map((h) => h.handle),
    ];
  }

  #decide(rules: readonly Directive[], action: RuleAction, principal: Principal): DirectiveVerdict {
    const hits = rules.filter((r) => enforced(r) && covers(r.scope, action)).sort(strongestFirst);
    const denied = hits.find((r) => r.effect === "deny");
    if (denied) return { outcome: "deny", directive: denied.id, reason: reasonOf(denied) };
    const ask = hits[0];
    if (ask === undefined || this.#ownerAsked(principal)) return ALLOW;
    return { outcome: "approval", directive: ask.id, reason: reasonOf(ask) };
  }

  /** The owner asked for this themselves: a `require_approval` rule has its approval. */
  #ownerAsked(principal: Principal): boolean {
    if (principal.kind === "panel") {
      const actor = principal.actor ?? "api";
      if (actor === "api") return true;
      const colon = actor.indexOf(":");
      if (colon <= 0) return false;
      const account = { platform: actor.slice(0, colon), id: actor.slice(colon + 1) };
      return this.#standing(account, principal.context) === "owner";
    }
    if (principal.kind !== "user" && principal.kind !== "command") return false;
    const requester = principal.requester;
    return requester !== null && this.#standing(requester, principal.context) === "owner";
  }

  async check(query: DirectiveQuery): Promise<DirectiveVerdict> {
    try {
      return this.#decide(await this.#read(), this.#action(query), query.principal);
    } catch (error) {
      // Stopping stays possible whatever is broken: it is what closed means.
      if (query.capability !== null && isStopping(query.capability)) return ALLOW;
      return {
        outcome: "deny",
        directive: null,
        reason: `讀不到規則(${errorMessage(error)}),先不動作`,
      };
    }
  }

  forbids(goal: DirectiveGoal): Directive | null {
    const action: RuleAction = {
      names: [],
      subjects: subjectsOf([goal.what, goal.why, goal.steps]),
      context: goal.context,
      people: goal.person === null ? [] : [goal.person],
      stopping: false,
    };
    const hits = this.#memory().filter((rule) => {
      const { capability, ...scope } = rule.scope;
      const words = scope.activity !== undefined;
      const about = scope.person !== undefined && capability === undefined;
      return rule.effect === "deny" && (words || about) && covers(scope, action);
    });
    return [...hits].sort(strongestFirst)[0] ?? null;
  }

  // ---- proposals ------------------------------------------------------------------------------

  screen(proposal: Proposal): DirectiveVerdict {
    const verdict = this.#screen(proposal);
    if (verdict.outcome !== "allow") this.#drop(proposal, verdict);
    return verdict;
  }

  #screen(proposal: Proposal): DirectiveVerdict {
    const principal = Principals.self(proposal.context);
    try {
      const action = this.#action(
        {
          capability: proposal.capability ?? null,
          args: proposal.args ?? {},
          principal,
          about: proposal.about,
        },
        true,
      );
      if (!this.healthy) {
        return action.stopping
          ? ALLOW
          : { outcome: "deny", directive: null, reason: "讀不到規則,背景的提案先不留" };
      }
      // A proposal is also what it says it wants, whatever it would run.
      const subjects = subjectsOf(
        [proposal.what, proposal.why, proposal.goal],
        [...action.subjects],
      );
      const people = proposal.person === null ? action.people : [...action.people, proposal.person];
      return this.#decide(this.#memory(), { ...action, subjects, people }, principal);
    } catch (error) {
      return { outcome: "deny", directive: null, reason: errorMessage(error) };
    }
  }

  /** Writes a dropped proposal back to the log; the `result` line takes it off the board. */
  #drop(proposal: Proposal, verdict: Exclude<DirectiveVerdict, { outcome: "allow" }>): void {
    if (this.#dropped.has(proposal.id)) return;
    this.#dropped.add(proposal.id);
    for (const old of this.#dropped) {
      if (this.#dropped.size <= DROPPED_MEMORY) break;
      this.#dropped.delete(old);
    }
    log.info({ proposal: proposal.id, reason: verdict.reason }, "a proposal hit a rule");
    const eventLog = this.#services.get(EventLogKey);
    if (eventLog === undefined) return;
    const said: DirectiveChangedBody = {
      op: "proposal_dropped",
      text: `提案作廢:${proposal.what}(${verdict.reason})`,
      directive: null,
      by: SOURCE,
      proposal: proposal.id,
    };
    const result: ProposalResultBody = {
      proposal: proposal.id,
      state: "dropped",
      detail: verdict.reason,
      turn: null,
    };
    try {
      const line = eventLog.append({
        kind: "directive",
        source: SOURCE,
        context: proposal.context,
        body: said as unknown as JsonValue,
      });
      eventLog.append({
        kind: "result",
        source: SOURCE,
        cause: line.id,
        context: proposal.context,
        body: result as unknown as JsonValue,
      });
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot write a dropped proposal back");
    }
  }

  /** Every proposal waiting on the board goes through the rules again (a rule just changed). */
  sweep(): void {
    const board = this.#services.get(ProposalBoardKey);
    if (board === undefined) return;
    for (const proposal of board.open()) this.screen(proposal);
  }

  // ---- authority ------------------------------------------------------------------------------

  /** What `subject` is to the rules, from its account and roles alone. */
  #standingOf(subject: Subject): Standing {
    const authorizer = this.#services.get(AuthorizerKey);
    if (authorizer === undefined) return "blocked";
    if (authorizer.allowsSubject(subject, NODE_OWNER)) return "owner";
    if (authorizer.allowsSubject(subject, NODE_MODERATE)) return "moderator";
    return authorizer.allowsSubject(subject, "") ? "viewer" : "blocked";
  }

  #standing(account: AccountRef, context: ContextKey | null): Standing {
    return this.#standingOf({ account, context, platform_roles: [], is_guild_admin: false });
  }

  /** The weakest of everyone a request speaks for. */
  #authority(by: DirectiveActor): Standing {
    if (by.type === "console") return "owner";
    const ranks = subjectsIn(by).map((s) => STANDINGS.indexOf(this.#standingOf(s)));
    return STANDINGS[Math.min(...ranks)] ?? "blocked";
  }

  // ---- changing the rules ---------------------------------------------------------------------

  async add(request: DirectiveRequest): Promise<DirectiveChange> {
    const authority = this.#authority(request.by);
    if (authority === "blocked") {
      return this.#refuse(request.by, request.text, "authority", "這個帳號不能要求她做這件事。");
    }
    const asked = request.question?.trim() ?? "";
    if (asked !== "") return { status: "question", question: cleanText(asked) };
    const text = cleanText(request.text);
    if (text === "") return { status: "question", question: "規則的內容是什麼?" };
    if (authority === "viewer") return this.#addWish(request, text);
    const unclear = this.#unclear(request, text, authority);
    if (unclear !== null) return { status: "question", question: unclear };
    const minutes = request.minutes;
    if (minutes !== null && (!Number.isFinite(minutes) || minutes <= 0)) {
      return refused("invalid", "時效要是大於 0 的分鐘數。");
    }
    let lasts = minutes;
    let note: string | null = null;
    if (authority === "moderator" && (lasts ?? 0) > this.#config.moderator_max_mins) {
      lasts = this.#config.moderator_max_mins;
      note = `管理員的規則最長 ${lasts} 分鐘,已經縮短。`;
    }
    const scope = cleanScope(request.scope);
    return this.#insert(request, authority, request.effect, scope, text, lasts, note);
  }

  /** What is still open in a rule, as the question to ask; `null` when it can be made. */
  #unclear(request: DirectiveRequest, text: string, authority: Standing): string | null {
    const { effect, scope, minutes } = request;
    if (enforced({ effect })) {
      if (HEDGED.test(text)) return `「${text}」是要禁止,還是只是不要太常?`;
      const target = scope.capability ?? scope.activity ?? scope.person;
      if (target === undefined || target.trim() === "") {
        return `「${text}」指的是哪個動作或哪個遊戲?`;
      }
    }
    if (scope.capability !== undefined && !this.#known(scope.capability)) {
      return `沒有叫 ${scope.capability} 的動作,指的是哪一個?`;
    }
    if (scope.activity !== undefined && normalizeTerm(scope.activity).length < MIN_TERM) {
      return `「${scope.activity}」太短了,指的是什麼?`;
    }
    if (authority === "moderator" && minutes === null) return `「${text}」要維持多久?`;
    return null;
  }

  /** Whether a rule on `pattern` can ever match anything she has. */
  #known(pattern: string): boolean {
    const registry = this.#services.get(ActuatorRegistryKey);
    if (registry === undefined) return true;
    const tools = this.#services.get(ToolRegistryKey)?.names() ?? [];
    return [...registry.names(), ...tools].some((name) => capabilityMatches(pattern, name));
  }

  /** A viewer's request: a short `prefer` here, whatever was asked for, and never over a rule. */
  async #addWish(request: DirectiveRequest, text: string): Promise<DirectiveChange> {
    if (request.by.type !== "account") return refused("invalid", "這個來源不能建立請求。");
    let rules: readonly Directive[];
    try {
      rules = await this.#read();
    } catch (error) {
      return refused("store", `讀不到規則(${errorMessage(error)})`);
    }
    const said = normalizeTerm(text);
    const over = rules.find((r) => {
      if (r.authority === "viewer" || !enforced(r) || r.scope.activity === undefined) return false;
      return said.includes(normalizeTerm(r.scope.activity));
    });
    if (over !== undefined) {
      return this.#refuse(
        request.by,
        text,
        "authority",
        `這件事有${AUTHORITY_LABEL[over.authority]}定的規則,觀眾不能改。`,
      );
    }
    const account = request.by.subject.account;
    const wishes = rules.filter((r) => r.authority === "viewer");
    const own = wishes.filter((r) => sameAccount(r.issuer, account));
    if (wishes.length - own.length >= this.#config.max_viewer_wishes) {
      return refused("full", "現在排著的觀眾請求太多了,等一下再說。");
    }
    try {
      const at = toTimestamp(this.#now());
      for (const old of own) {
        await this.#store.revoke(this.#profile, old.id, accountRefString(account), at);
      }
    } catch (error) {
      return refused("store", `寫不進規則(${errorMessage(error)})`);
    }
    const context = request.by.subject.context;
    return this.#insert(
      request,
      "viewer",
      "prefer",
      context === null ? {} : { context },
      text,
      this.#config.viewer_ttl_mins,
      "觀眾的要求只會記成短時間的偏好,不是規則。",
    );
  }

  async #insert(
    request: DirectiveRequest,
    authority: DirectiveAuthority,
    effect: DirectiveEffect,
    scope: DirectiveScope,
    text: string,
    minutes: number | null,
    note: string | null,
  ): Promise<DirectiveChange> {
    const now = this.#now();
    const directive: Directive = {
      id: newId(),
      issuer: issuerOf(request.by),
      authority,
      scope,
      effect,
      text,
      expires: minutes === null ? "until_revoked" : toTimestamp(now + minutes * 60_000),
      source_event: request.source_event,
      created_at: toTimestamp(now),
    };
    try {
      await this.#store.insert(this.#profile, directive);
    } catch (error) {
      await this.#audit(request.by, "directive.add", directive.id, { text }, false);
      return refused("store", `寫不進規則(${errorMessage(error)})`);
    }
    await this.refresh();
    this.#tell("add", `新規則:${text}`, directive, request.by);
    await this.#audit(request.by, "directive.add", directive.id, toJson(directive), true);
    // What a new rule forbids is off the board at once (§9), not when someone next looks.
    if (enforced(directive)) this.sweep();
    const stopped = effect === "deny" ? await this.#enforce(directive) : null;
    return { status: "added", directive, note: [note, stopped].filter(Boolean).join(" ") || null };
  }

  /**
   * §9: a rule takes effect, so what it forbids stops if it is running. Only what the rule names:
   * a rule about one channel, one person or everything leaves her game alone (the gate still
   * refuses what comes next). Stopping is the rules at work, so it is nobody's request: the
   * `panel` principal, like the emergency stop. Returns what to say about it.
   */
  async #enforce(directive: Directive): Promise<string | null> {
    const manager = this.#services.get(ActivityManagerKey);
    const running = manager?.snapshot().activity;
    if (!manager || !running || !namesRunning(directive.scope, running)) return null;
    if (running.type === "idle") return null;
    const principal = Principals.panel(SOURCE);
    const why = `規則:${directive.text}`;
    try {
      if (running.type === "singing") {
        const outcome = await this.#services.get(ActuatorRegistryKey)?.invoke({
          principal,
          capability: SONG_STOP,
          args: { all: false },
          why,
          turn: null,
        });
        if (outcome?.status !== "done") return "正在唱的歌停不下來。";
      } else {
        const result = await manager.request({
          request: { type: "stop", activity: running.type },
          principal,
          turn: null,
          context: null,
          why,
        });
        if (result.status === "refused") return `正在做的事停不下來:${result.detail}`;
      }
      log.info({ rule: directive.id, activity: running.type }, "a rule stopped what she was doing");
      return `正在停掉 ${running.target ?? running.type}。`;
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot stop what a rule forbids");
      return "正在做的事停不下來。";
    }
  }

  async remove(request: DirectiveRemoval): Promise<DirectiveChange> {
    const authority = this.#authority(request.by);
    if (authority === "blocked") {
      return this.#refuse(request.by, request.match ?? "", "authority", "這個帳號不能解除規則。");
    }
    let rules: readonly Directive[];
    try {
      rules = await this.#read();
    } catch (error) {
      return refused("store", `讀不到規則(${errorMessage(error)})`);
    }
    // A rule is its maker's to take back, when the maker is speaking for nobody else.
    const by = request.by;
    const alone = by.type === "account" && subjectsIn(by).length === 1;
    const mayRemove = (rule: Directive): boolean =>
      authority === "owner" ||
      (alone && by.type === "account" && sameAccount(rule.issuer, by.subject.account));
    const id = request.id?.trim() ?? "";
    const word = normalizeTerm(request.match ?? "");
    let found: readonly Directive[];
    if (id !== "") found = rules.filter((r) => r.id === id);
    else if (word !== "") found = rules.filter((r) => matchesWord(r, word));
    else return { status: "question", question: "要解除哪一條規則?" };
    if (found.length === 0) return refused("not_found", "沒有這條規則。");
    // Only what this person may remove can make the answer ambiguous.
    const theirs = found.filter(mayRemove);
    const rule = theirs[0];
    if (rule === undefined) {
      const top = [...found].sort(strongestFirst)[0] as Directive;
      return this.#refuse(
        request.by,
        top.text,
        "authority",
        `這條是${AUTHORITY_LABEL[top.authority]}定的規則,只有主人或定規則的人能解除。`,
      );
    }
    if (theirs.length > 1) {
      const lines = theirs.slice(0, 5).map((r) => `「${r.text}」`);
      return { status: "question", question: `要解除哪一條?${lines.join("、")}` };
    }
    const at = toTimestamp(this.#now());
    try {
      const ended = await this.#store.revoke(this.#profile, rule.id, actorName(by), at);
      if (!ended) return refused("not_found", "這條規則已經結束了。");
    } catch (error) {
      await this.#audit(request.by, "directive.remove", rule.id, { text: rule.text }, false);
      return refused("store", `解除不了規則(${errorMessage(error)})`);
    }
    await this.refresh();
    this.#tell("remove", `解除規則:${rule.text}`, rule, request.by);
    await this.#audit(request.by, "directive.remove", rule.id, toJson(rule), true);
    return { status: "removed", directive: rule };
  }

  /** A refusal that is itself worth a line: someone tried to change a rule they may not. */
  async #refuse(
    by: DirectiveActor,
    text: string,
    reason: DirectiveRefusal,
    detail: string,
  ): Promise<DirectiveChange> {
    log.info({ by: actorName(by), detail }, "a rule change was refused");
    this.#tell("refused", `被拒絕:${text}(${detail})`, null, by);
    await this.#audit(by, "directive.refused", text, { detail }, false);
    return refused(reason, detail);
  }

  // ---- what is written down -------------------------------------------------------------------

  /** A `directive` line of the log and the bus event. Never throws. */
  #tell(
    op: DirectiveChangedBody["op"],
    text: string,
    directive: Directive | null,
    by: DirectiveActor,
  ): void {
    const body: DirectiveChangedBody = { op, text, directive, by: actorName(by) };
    const json = body as unknown as JsonValue;
    const context = by.type === "account" ? by.subject.context : null;
    try {
      this.#services
        .get(EventLogKey)
        ?.append({ kind: "directive", source: SOURCE, context, body: json });
      this.#publish(customEvent(DIRECTIVE_CHANGED_TOPIC, json));
    } catch (error) {
      log.debug({ err: errorMessage(error) }, "cannot report a rule change");
    }
  }

  async #audit(
    by: DirectiveActor,
    action: string,
    target: string,
    detail: JsonValue,
    ok: boolean,
  ): Promise<void> {
    try {
      await this.#services.get(AuditLogKey)?.append({
        id: newId(),
        at: toTimestamp(this.#now()),
        actor: actorName(by),
        action,
        target,
        detail,
        ok,
      });
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot write a rule change to the audit log");
    }
  }
}

/** `run`'s answer; when `guessing`, one that throws is no answer. */
function attempt<T>(run: () => T, guessing: boolean): T | undefined {
  try {
    return run();
  } catch (error) {
    if (guessing) return undefined;
    throw error;
  }
}

function toJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function issuerOf(by: DirectiveActor): AccountRef {
  return by.type === "console" ? { platform: "panel", id: by.actor } : by.subject.account;
}

/** What a rule's scope holds, without blanks. */
function cleanScope(scope: DirectiveScope): DirectiveScope {
  const out: DirectiveScope = {};
  const capability = scope.capability?.trim();
  const activity = scope.activity?.trim();
  const person = scope.person?.trim();
  if (capability) out.capability = capability;
  if (activity) out.activity = activity;
  if (person) out.person = person;
  if (scope.context !== undefined) out.context = scope.context;
  return out;
}

/** Whether `word` (normalized) names `rule`: by its text, its scope or the end of its id. */
function matchesWord(rule: Directive, word: string): boolean {
  const { capability, activity, person } = rule.scope;
  const names = [rule.text, capability, activity, person].filter((n) => n !== undefined);
  return (
    rule.id.toLowerCase().endsWith(word) || names.some((name) => normalizeTerm(name).includes(word))
  );
}
