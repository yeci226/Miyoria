// What the text path on the new runner keeps of the old one (docs/design/v5-brain.md B4).

import { ActuatorRegistry, ActuatorRegistryKey } from "@miyoria/gate/actions";
import { type ChatRequest, contentText } from "@miyoria/llm/llm";
import { defineTool } from "@miyoria/llm/tools";
import { type LogEntry, type MessageLog, MessageLogKey } from "@miyoria/store";
import {
  type Attachment,
  type Attitude,
  AuthorizerKey,
  type ContextEntry,
  type ContextKey,
  type DecisionTrace,
  Events,
  type FileOutcome,
  type FileReader,
  FileReaderKey,
  type FileRequest,
  type FloorBudget,
  type FloorClaimKind,
  type FloorHold,
  FloorKey,
  type GateDecisionPayload,
  type IncomingMessage,
  type InterruptLevel,
  type JsonValue,
  type LifeLog,
  LifeLogKey,
  MessageActionsKey,
  type PartyStatus,
  PartyStatusKey,
  PlatformHistories,
  PlatformHistoriesKey,
  PlatformSinks,
  PlatformSinksKey,
  type PromptContributor,
  PromptContributors,
  PromptContributorsKey,
  type PromptSection,
  type SkillIndex,
  SkillIndexKey,
  SocialSignalsKey,
  type TurnOutcomeRecord,
  toTimestamp,
  type WorkingContext,
  WorkingContextKey,
} from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { FetchLike } from "../../agent/src/index.js";
import { serialiseMessages } from "../../self/src/index.js";
import {
  account,
  calls,
  channel,
  dm,
  line,
  mention,
  Rig,
  says,
  stopRigs,
  textOf,
  until,
} from "./harness.js";

afterEach(async () => {
  await stopRigs();
});

const C1 = channel("c1");
const DM_AMY = dm("dm-amy");
const outcomes = (rig: Rig) => rig.of<TurnOutcomeRecord>(Events.AgentTurnOutcome.type);
const toolResults = (rig: Rig, request: number) =>
  (rig.model.requests[request]?.messages ?? [])
    .filter((m) => m.role === "tool")
    .map((m) => String(m.content));

function known(who: string, familiarity: number): Attitude {
  return {
    person: `p-${who}` as Attitude["person"],
    affinity: 0,
    trust: 0,
    familiarity,
    blocked: false,
    label: "朋友",
    call_name: null,
    display_name: who,
  };
}

/** A Floor that records what it is asked; `ambient` is refused while `refusing` is set. */
class FakeFloor {
  readonly calls: string[] = [];
  refusing: string | null = null;

  hold(turn: string, context: ContextKey, kind: FloorClaimKind): void {
    this.calls.push(`hold ${turn} ${context.channel} ${kind}`);
  }
  turnEnded(turn: string): void {
    this.calls.push(`ended ${turn}`);
  }
  release(turn: string): void {
    this.calls.push(`release ${turn}`);
  }
  releaseContext(): void {}
  holder(): FloorHold | null {
    return null;
  }
  interruptLevel(): InterruptLevel {
    return "queue";
  }
  refuses(kind: FloorClaimKind): string | null {
    return kind === "ambient" ? this.refusing : null;
  }
  budget(): FloorBudget {
    return {
      window_mins: 10,
      used: 0,
      allowed: 10,
      human_lines: 0,
      unanswered: 0,
      waiting_for_response: false,
      performing: false,
    };
  }
}

describe("the Floor", () => {
  it("is held once for the whole run, not per line, and freed when the run ends", async () => {
    const floor = new FakeFloor();
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", FloorKey, floor),
    });
    rig.model.push(says("第一句\n第二句"));
    rig.say(mention(C1, "amy", "@她 說兩句"));
    await until(() => outcomes(rig).length === 1, 3_000, "the run");
    expect(rig.sink.texts()).toEqual(["第一句", "第二句"]);
    const turn = outcomes(rig)[0]?.turn;
    expect(floor.calls).toEqual([`hold ${turn} c1 addressed`, `ended ${turn}`]);
  });

  it("refuses a glance the way it refused ambient talk, before any model call", async () => {
    const floor = new FakeFloor();
    floor.refusing = "這 10 分鐘你自己講了 5 句,額度用完了";
    const rig = await Rig.create({
      mode: "lively",
      provide: (sup) => sup.services.provide("app", FloorKey, floor),
    });
    rig.say(line(C1, "amy", "今天好冷"));
    await until(() => outcomes(rig).length === 1, 3_000, "the refused glance");
    expect(rig.model.requests).toHaveLength(0);
    expect(outcomes(rig)[0]).toMatchObject({ reason: "ambient", outcome: { type: "silence" } });
    const decision = rig.of<DecisionTrace>(Events.AgentDecision.type).at(-1);
    expect(decision?.respond).toBe(false);
    expect(decision?.reasons.at(-1)).toBe(`floor: ${floor.refusing}`);
    expect(floor.calls).toEqual([]);
  });

  it("is freed when the run is cut", async () => {
    const floor = new FakeFloor();
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", FloorKey, floor),
    });
    rig.model.push({ events: says("慢慢想"), delay: 400 }, says("好"));
    rig.say(mention(C1, "amy", "@她 幫我想"));
    await until(() => rig.model.requests.length === 1, 3_000, "the first run");
    rig.say(line(C1, "amy", "要跟海有關的那種名字"));
    await until(() => outcomes(rig).length === 2, 3_000, "both runs");
    const [cut, next] = outcomes(rig);
    expect(cut?.outcome.type).toBe("cancelled");
    expect(floor.calls).toEqual([
      `hold ${cut?.turn} c1 addressed`,
      `ended ${cut?.turn}`,
      `hold ${next?.turn} c1 addressed`,
      `ended ${next?.turn}`,
    ]);
  });
});

// ---- the prompt's sections ----------------------------------------------------------------------

function section(key: string, title: string, body: () => string): PromptContributor {
  return {
    key,
    async contribute(): Promise<PromptSection[]> {
      return [{ key, title, body: body(), order: 0 }];
    },
  };
}

function contextEntry(text: string, untrusted: boolean): ContextEntry {
  return {
    event: "e",
    at: toTimestamp(Date.now()),
    text,
    attention_key: text,
    revision: 1,
    context: null,
    from: null,
    untrusted,
    restored: false,
  };
}

describe("the prompt's sections", () => {
  async function rigWithSections() {
    let justNow = 0;
    const contributors = new PromptContributors();
    contributors.register(section("server_emoji", "伺服器表情", () => ":wave: :cat:"));
    contributors.register(section("notebook", "你的筆記本", () => "- 料理筆記"));
    contributors.register(section("just_now", "剛剛", () => `剛剛的事 ${++justNow}`));
    const skills: SkillIndex = { index: async () => "- 煮咖哩:照步驟煮" };
    const life: LifeLog = {
      entries: () => [],
      today: () => [
        {
          id: "l1",
          at: toTimestamp(Date.now()),
          kind: "activity",
          text: "早上去散步",
          minutes: 30,
          capability: null,
        } as never,
      ],
      summary: () => "- 早上去散步",
    };
    const working: WorkingContext = {
      buckets: () => [
        {
          writer: "world",
          mode: "replace" as never,
          owner: null,
          entries: [contextEntry("外面在下雨", false), contextEntry("有人說明天停電", true)],
          updated_at: toTimestamp(Date.now()),
        },
      ],
      bucket: () => null,
    };
    const party: PartyStatus = { running: () => ({ game: "song", title: "猜歌" }) };
    const rig = await Rig.create({
      provide: (sup) => {
        sup.services.provide("app", PromptContributorsKey, contributors);
        sup.services.provide("app", SkillIndexKey, skills);
        sup.services.provide("app", LifeLogKey, life);
        sup.services.provide("app", WorkingContextKey, working);
        sup.services.provide("app", PartyStatusKey, party);
      },
    });
    return rig;
  }

  it("puts each source in its block: slow ones before the transcript, the rest after", async () => {
    const rig = await rigWithSections();
    rig.model.push(says("嗨"), says("又見面了"));
    rig.sup.bus.publish("actions", Events.AgentNotice, {
      id: "n1",
      at: toTimestamp(Date.now()),
      source: "actions",
      task: null,
      turn: null,
      context: DM_AMY,
      ok: true,
      code: null,
      text: "幫 amy 訂好位子了",
      expires_at: toTimestamp(Date.now() + 60_000),
    });
    rig.say(line(DM_AMY, "amy", "在嗎"));
    await until(() => outcomes(rig).length === 1, 3_000, "the first run");
    const first = rig.model.requests[0];
    const texts = (first?.messages ?? []).map((m) => contentText(m.content));
    const history = texts.indexOf("amy: 在嗎");
    const at = (needle: string) => texts.findIndex((t) => t.includes(needle));
    // Block 4, before the transcript: skills, emoji, notebook, 「今天的你」.
    for (const slow of ["煮咖哩", ":wave: :cat:", "料理筆記", "早上去散步"]) {
      expect(at(slow)).toBeGreaterThan(-1);
      expect(at(slow)).toBeLessThan(history);
    }
    // Block 6 after it: just now, the working context's data, the notice.
    for (const recalled of ["剛剛的事 1", "有人說明天停電", "幫 amy 訂好位子了"]) {
      expect(at(recalled)).toBeGreaterThan(history);
    }
    // Block 7: what she trusts, the party game, the style note.
    const last = texts.at(-1) ?? "";
    expect(last).toContain("外面在下雨");
    expect(last).toContain("「猜歌」正在進行");
    expect(last).toMatch(/<\/now>\n<style_note>\n- 回覆開頭先放這一刻的 <emo:名稱>/);
    expect(last.indexOf("<style_note>")).toBeLessThan(last.indexOf("<turn>"));

    // The next run: the same prefix up to the end of the transcript, though block 6 changed.
    rig.say(line(DM_AMY, "amy", "我回來了"));
    await until(() => outcomes(rig).length === 2, 3_000, "the second run");
    const second = rig.model.requests[1];
    const end = history + 1;
    expect(serialiseMessages(second?.messages ?? []).slice(0, end)).toEqual(
      serialiseMessages(first?.messages ?? []).slice(0, end),
    );
    expect(contentText(second?.messages.at(-2)?.content ?? "")).toContain("剛剛的事 2");
    // A notice is told once.
    expect(textOf(second)).not.toContain("幫 amy 訂好位子了");
  });
});

// ---- what her lines go out as -------------------------------------------------------------------

/** `[text, reply_to id]` of every line sent. */
const replies = (rig: Rig) =>
  rig.sink.actions.flatMap((a) =>
    a.payload.type === "send_message"
      ? [[a.payload.message.text, a.payload.message.reply_to?.id ?? null]]
      : [],
  );

describe("her lines", () => {
  it("the first line of an answer in a channel quotes the line that called her", async () => {
    const rig = await Rig.create();
    rig.model.push(says("第一句\n第二句"));
    const asked = mention(C1, "amy", "@她 說兩句");
    rig.say(asked);
    await until(() => outcomes(rig).length === 1, 3_000, "the run");
    expect(replies(rig)).toEqual([
      ["第一句", asked.id.id],
      ["第二句", null],
    ]);
    // Each line its own entry, with the id it went out under.
    const own = rig.entries(C1).filter((e) => e.kind === "self");
    expect(own.map((e) => [e.content, e.message_id])).toEqual([
      ["第一句", "sent-1"],
      ["第二句", "sent-2"],
    ]);
  });

  it("quotes nothing in a DM, nor when several people called her at once", async () => {
    const rig = await Rig.create({ config: { one_caller_per_turn: false } });
    rig.model.push(says("嗨"), says("你們好"));
    rig.say(line(DM_AMY, "amy", "在嗎"));
    await until(() => outcomes(rig).length === 1, 3_000, "the DM run");
    rig.say(mention(C1, "amy", "@她 早"));
    rig.say(mention(C1, "bob", "@她 早安"));
    await until(() => outcomes(rig).length === 2, 3_000, "the channel run");
    expect(replies(rig)).toEqual([
      ["嗨", null],
      ["你們好", null],
    ]);
  });

  it("with reply_reference off, nothing is quoted", async () => {
    const rig = await Rig.create({ config: { reply_reference: false } });
    rig.model.push(says("好"));
    rig.say(mention(C1, "amy", "@她 嗨"));
    await until(() => outcomes(rig).length === 1, 3_000, "the run");
    expect(replies(rig)).toEqual([["好", null]]);
  });
});

// ---- the message menu ---------------------------------------------------------------------------

describe("「要她回這則」", () => {
  it("wakes her for that line as if it had called her, even when it is not the newest", async () => {
    const rig = await Rig.create({ mode: "mention-only" });
    const asked = line(C1, "bob", "有人知道哪裡的拉麵好吃嗎");
    rig.say(asked);
    rig.say(line(C1, "carol", "我也想知道"));
    await until(() => rig.entries(C1).length === 2, 3_000, "both lines");
    expect(rig.model.requests).toHaveLength(0);
    rig.model.push(says("車站前那家"));
    const actions = rig.sup.services.get(MessageActionsKey);
    const outcome = await actions?.replyTo({
      message: asked.id,
      requested_by: account("amy"),
      author: null,
    });
    expect(outcome).toEqual({ ok: true });
    await until(() => rig.sink.texts().length === 1, 3_000, "her answer");
    const last = contentText(rig.model.requests[0]?.messages.at(-1)?.content ?? "");
    expect(last).toContain("有人請你回 bob 的這則訊息:「有人知道哪裡的拉麵好吃嗎」");
    expect(replies(rig)).toEqual([["車站前那家", asked.id.id]]);
    expect(outcomes(rig)[0]?.reason).toBe("addressed");
  });

  it("refuses her own lines and lines she has not seen", async () => {
    const rig = await Rig.create();
    rig.model.push(says("嗨"));
    rig.say(mention(C1, "amy", "@她 嗨"));
    await until(() => rig.sink.texts().length === 1, 3_000, "her answer");
    await until(() => outcomes(rig).length === 1, 3_000, "the run's end");
    const actions = rig.sup.services.get(MessageActionsKey);
    const ask = (id: string) =>
      actions?.replyTo({
        message: { context: C1, id },
        requested_by: account("amy"),
        author: null,
      });
    expect(await ask("sent-1")).toEqual({ ok: false, reason: "這是她自己說的話。" });
    expect(await ask("nowhere")).toEqual({ ok: false, reason: "她現在看不到這則訊息。" });
  });
});

// ---- several askers -----------------------------------------------------------------------------

describe("several askers", () => {
  it("a tool that acts for someone says whom; the argument is always in its schema", async () => {
    const paid: { account: string; args: JsonValue }[] = [];
    const pay = defineTool({
      name: "pay_rice",
      description: "替人付飯錢。",
      parameters: z.object({ amount: z.number().optional() }),
      effect: "act",
      speed: "instant",
      risk: "low",
      group: "test",
      core: true,
      next: true,
      actsFor: true,
      async call(ctx, args) {
        paid.push({ account: ctx.account.id, args });
        return "付好了";
      },
    });
    const rig = await Rig.create({
      config: { one_caller_per_turn: false },
      provide: (_sup, tools) => tools.register(pay),
    });
    rig.model.push(says("嗨"));
    rig.say(mention(C1, "amy", "@她 嗨"));
    await until(() => outcomes(rig).length === 1, 3_000, "the first run");
    rig.model.push(
      calls("pay_rice", { amount: 50 }, "c1"),
      calls("pay_rice", { amount: 50, for_whom: "bob" }, "c2"),
      says("幫 bob 付了"),
    );
    rig.say(mention(C1, "amy", "@她 幫我付"));
    rig.say(mention(C1, "bob", "@她 幫我付飯錢"));
    await until(() => outcomes(rig).length === 2, 3_000, "the second run");
    const [refused] = toolResults(rig, 2);
    expect(refused).toContain("好幾個人同時叫你");
    expect(refused).toContain("for_whom");
    expect(paid).toEqual([{ account: "bob", args: { amount: 50 } }]);
    // The same schema in a run with one asker and in one with two: the prefix keeps.
    const spec = (i: number) =>
      JSON.stringify(rig.model.requests[i]?.tools?.find((t) => t.name === "pay_rice"));
    expect(spec(0)).toBe(spec(1));
    const parameters = JSON.parse(spec(0)).parameters;
    expect(Object.keys(parameters.properties)).toContain("for_whom");
    expect(parameters.required ?? []).not.toContain("for_whom");
  });
});

// ---- reply chains -------------------------------------------------------------------------------

describe("a reply chain", () => {
  it("notes the ancestors she did not see after the line, up to `reply_chain`, nothing rewritten", async () => {
    const chain: IncomingMessage[] = [];
    for (const [i, who] of ["dan", "carol", "bob", "erin"].entries()) {
      const parent = chain.at(-1);
      chain.push({
        ...line(C1, who, `第 ${i + 1} 句`),
        ...(parent === undefined ? {} : { reply_to: parent.id }),
      });
    }
    const fetched: string[] = [];
    const histories = new PlatformHistories();
    histories.register({
      platform: "test",
      recent: async () => [],
      fetch: async (ref) => {
        fetched.push(ref.id);
        return chain.find((m) => m.id.id === ref.id) ?? null;
      },
    });
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", PlatformHistoriesKey, histories),
    });
    rig.say(line(C1, "amy", "先講一句"));
    await until(() => rig.entries(C1).length === 1, 3_000, "the first line");
    const before = rig.entries(C1).map((e) => ({ ...e }));
    rig.model.push(says("原來如此"));
    const direct = chain.at(-1) as IncomingMessage;
    rig.say({
      ...mention(C1, "amy", "@她 你看這串"),
      reply_to: direct.id,
      referenced: { author: account("erin"), author_name: "erin", text: "第 4 句" },
    });
    await until(() => rig.sink.texts().length === 1, 3_000, "her answer");
    const notes = rig
      .entries(C1)
      .filter((e) => e.kind === "note")
      .map((e) => [e.author, e.content]);
    // The quote that came with the reply, then the fetched ancestors, nearest first, three in all.
    expect(notes).toEqual([
      ["erin", "第 4 句"],
      ["bob", "第 3 句"],
      ["carol", "第 2 句"],
    ]);
    expect(fetched).toEqual([direct.id.id, chain[2]?.id.id, chain[1]?.id.id]);
    expect(textOf(rig.model.requests[0])).toContain("> (被回覆) carol: 第 2 句");
    // What was there before is as it was.
    expect(rig.entries(C1).slice(0, before.length)).toEqual(before);
  });
});

// ---- the backfill -------------------------------------------------------------------------------

describe("the backfill of a cold place", () => {
  function messageLog(context: ContextKey, lines: [string, string, number][]): MessageLog {
    const entries: LogEntry[] = lines.map(([who, text, ago], i) => ({
      id: `L${i}`,
      profile: "test-chan" as LogEntry["profile"],
      context,
      author: who === "her" ? { platform: "test", id: "her" } : account(who),
      author_name: who === "her" ? "她" : who,
      text,
      is_self: who === "her",
      ts: toTimestamp(Date.now() - ago),
      turn: null,
    }));
    return {
      append: async () => undefined,
      recent: async (_p, _c, limit) => entries.slice(-limit),
      authoredSince: async () => [],
      purge: async () => 0,
    };
  }

  it("takes the message log when there is no platform history", async () => {
    const log = messageLog(DM_AMY, [
      ["amy", "昨天的事", 60_000],
      ["her", "我記得", 50_000],
    ]);
    const rig = await Rig.create({
      provide: (sup) => sup.services.provide("app", MessageLogKey, log),
    });
    rig.model.push(says("嗯"));
    rig.say(line(DM_AMY, "amy", "然後呢"));
    await until(() => rig.sink.texts().length === 1, 3_000, "her answer");
    expect(rig.entries(DM_AMY).map((e) => [e.kind, e.content, e.message_id])).toEqual([
      ["other", "昨天的事", null],
      ["self", "我記得", null],
      ["other", "然後呢", expect.any(String)],
      ["self", "嗯", "sent-1"],
    ]);
  });

  it("fills up from the log what a short platform history leaves out, older lines first", async () => {
    const log = messageLog(C1, [
      ["bob", "很久以前", 600_000],
      ["carol", "也很久", 500_000],
      ["dan", "平台也有這句", 1_000],
    ]);
    const recent = { ...line(C1, "dan", "平台也有這句"), ts: toTimestamp(Date.now() - 1_000) };
    const histories = new PlatformHistories();
    histories.register({ platform: "test", recent: async () => [recent], fetch: async () => null });
    const rig = await Rig.create({
      mode: "mention-only",
      provide: (sup) => {
        sup.services.provide("app", MessageLogKey, log);
        sup.services.provide("app", PlatformHistoriesKey, histories);
      },
    });
    rig.say(line(C1, "amy", "嗨"));
    await until(() => rig.entries(C1).length === 4, 3_000, "the backfill");
    expect(rig.entries(C1).map((e) => e.content)).toEqual([
      "很久以前",
      "也很久",
      "平台也有這句",
      "嗨",
    ]);
  });
});

// ---- images and files ---------------------------------------------------------------------------

function image(id: string, name = `${id}.png`): Attachment {
  return {
    id,
    url: `https://cdn.discordapp.com/attachments/1/${name}?sig=1`,
    filename: name,
    content_type: "image/png",
    size: 4,
  };
}

function file(id: string, name: string): Attachment {
  return {
    id,
    url: `https://cdn.discordapp.com/attachments/1/${name}`,
    filename: name,
    content_type: "text/plain",
    size: 20,
  };
}

/** Answers every download with a tiny png; counts them. */
function fakeFetch(): FetchLike & { urls: string[] } {
  const urls: string[] = [];
  const fetch = async (url: string): Promise<Response> => {
    urls.push(url);
    return new Response(new Uint8Array([137, 80, 78, 71]), {
      headers: { "content-type": "image/png" },
    });
  };
  return Object.assign(fetch, { urls });
}

/** The parts of the request's messages, each as `role: text-or-[image]`. */
function partsOf(request: ChatRequest | undefined): string[] {
  return (request?.messages ?? []).flatMap((m) =>
    typeof m.content === "string"
      ? [`${m.role}: ${m.content}`]
      : m.content.map((p) => `${m.role}: ${p.type === "text" ? p.text : `[image ${p.alt}]`}`),
  );
}

/** The index of the first message that carries an image part. */
function firstImage(request: ChatRequest | undefined): number {
  return (request?.messages ?? []).findIndex(
    (m) => typeof m.content !== "string" && m.content.some((p) => p.type === "image_url"),
  );
}

class FakeReader implements FileReader {
  readonly requests: FileRequest[] = [];
  constructor(readonly outcome: (r: FileRequest) => FileOutcome) {}
  supports(name: string): boolean {
    return name.endsWith(".txt");
  }
  async read(request: FileRequest): Promise<FileOutcome> {
    this.requests.push(request);
    return this.outcome(request);
  }
}

const allowAll = { allows: () => true, allowsSubject: () => true };

describe("images", () => {
  it("shows the run's images after the transcript, labelled; the transcript keeps a reference", async () => {
    const fetch = fakeFetch();
    const rig = await Rig.create({ mode: "mention-only", fetchImage: fetch });
    rig.model.push(says("看到了"), says("也看到了"));
    rig.say({ ...line(C1, "amy", "先傳一張"), attachments: [image("e1", "earlier.png")] });
    rig.say({ ...mention(C1, "amy", "@她 看這兩張"), attachments: [image("n1", "now.png")] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the first answer");
    const first = rig.model.requests[0];
    const parts = partsOf(first);
    const at = parts.indexOf("user: (amy 這則訊息附的圖片 now.png)");
    expect(at).toBeGreaterThan(-1);
    expect(parts[at + 1]).toBe("user: [image [圖片: now.png]]");
    expect(parts[at + 2]).toMatch(
      /^user: \(amy \d+ 秒前另外傳的圖片 earlier\.png,不是這則訊息附的\)$/,
    );
    // After the transcript (the line that woke her), before `<now>`.
    const history = (first?.messages ?? []).findIndex(
      (m) => typeof m.content === "string" && m.content.includes("amy: @她 看這兩張"),
    );
    expect(firstImage(first)).toBeGreaterThan(history);
    expect(first?.messages.at(-1)?.role).toBe("system");
    // The transcript keeps no image data.
    const entry = rig
      .entries(C1)
      .find((e) => e.message_id !== null && e.content.includes("看這兩張"));
    expect(entry?.content).toContain("[圖片: now.png]");
    expect(entry?.images).toEqual([{ ref: "n1", alt: null }]);
    expect(JSON.stringify(rig.entries(C1))).not.toContain("data:image");

    // A reply to a line with an image: that image, labelled as the replied-to one's.
    const parent = { ...line(C1, "bob", "我的貓"), attachments: [image("p1", "cat.png")] };
    rig.say(parent);
    rig.say({
      ...mention(C1, "amy", "@她 你看他的貓"),
      reply_to: parent.id,
      referenced: { author: account("bob"), author_name: "bob", text: "我的貓" },
    });
    await until(() => rig.sink.texts().length === 2, 3_000, "the second answer");
    expect(partsOf(rig.model.requests[1])).toContain(
      "user: (被回覆的那則訊息裡 bob 傳的圖片 cat.png)",
    );
    expect(fetch.urls).toHaveLength(3);
  });

  it("keeps the prefix of the next run: images sit after the transcript", async () => {
    const rig = await Rig.create({ fetchImage: fakeFetch() });
    rig.model.push(says("好可愛"), says("對啊"));
    rig.say({ ...line(DM_AMY, "amy", "看"), attachments: [image("x1", "dog.png")] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the first answer");
    await until(() => outcomes(rig).length === 1, 3_000, "the first run's end");
    rig.say(line(DM_AMY, "amy", "牠叫小白"));
    await until(() => rig.sink.texts().length === 2, 3_000, "the second answer");
    const [one, two] = rig.model.requests;
    const cut = firstImage(one);
    expect(cut).toBeGreaterThan(0);
    expect(serialiseMessages(two?.messages ?? []).slice(0, cut)).toEqual(
      serialiseMessages(one?.messages ?? []).slice(0, cut),
    );
    // Sent a moment ago by the same person: shown again, as such, after the transcript.
    expect(firstImage(two)).toBeGreaterThan(cut);
    expect(partsOf(two).join("\n")).toMatch(/amy \d+ 秒前另外傳的圖片 dog\.png/);
  });

  it("downloads nothing when the chat model takes no images", async () => {
    const fetch = fakeFetch();
    const rig = await Rig.create({ fetchImage: fetch, images: false });
    rig.model.push(says("嗯"));
    rig.say({ ...line(DM_AMY, "amy", "看"), attachments: [image("x1", "dog.png")] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    expect(fetch.urls).toEqual([]);
    expect(firstImage(rig.model.requests[0])).toBe(-1);
    expect(partsOf(rig.model.requests[0]).join("\n")).toContain("[圖片: dog.png]");
  });
  it("looks at a link preview's picture as one of its message's, from Discord's proxy only", async () => {
    const fetch = fakeFetch();
    const rig = await Rig.create({ mode: "mention-only", fetchImage: fetch });
    rig.model.push(says("看到了"), says("也看到了"), says("第三次"));
    const proxy = "https://images-ext-1.discordapp.net/external/k/https/example.com/hero.jpg";
    const embed = {
      title: "標題",
      description: null,
      url: "https://example.com/post",
      image: proxy,
    };
    rig.say({ ...mention(C1, "amy", "@她 這篇在講什麼"), embeds: [embed] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the first answer");
    const parts = partsOf(rig.model.requests[0]);
    const at = parts.indexOf("user: (amy 這則訊息附的圖片 hero.jpg)");
    expect(at).toBeGreaterThan(-1);
    expect(parts[at + 1]).toBe("user: [image [圖片: hero.jpg]]");
    expect(fetch.urls).toEqual([proxy]);
    // The history keeps a short marker, no data.
    const entry = rig.entries(C1).find((e) => e.content.includes("這篇在講什麼"));
    expect(entry?.content).toContain("[圖片: 連結預覽]");
    expect(JSON.stringify(rig.entries(C1))).not.toContain("data:image");

    // A forwarded message's preview counts like a forwarded attachment.
    const forwarded = {
      text: "",
      attachments: [],
      stickers: [],
      embeds: [{ ...embed, image: null, thumbnail: proxy.replace("hero", "thumb") }],
    };
    rig.say({ ...mention(C1, "amy", "@她 轉傳的"), forwarded: [forwarded] });
    await until(() => rig.sink.texts().length === 2, 3_000, "the second answer");
    expect(fetch.urls).toHaveLength(2);
    expect(partsOf(rig.model.requests[1]).join("\n")).toContain("thumb.jpg");
  });

  it("never fetches a third party's own picture URL from an embed", async () => {
    const fetch = fakeFetch();
    const rig = await Rig.create({ mode: "mention-only", fetchImage: fetch });
    rig.model.push(says("嗯"));
    // Not Discord's proxy: such a URL cannot come from the adapter, and is refused if it does.
    const embed = {
      title: "t",
      description: null,
      url: "https://example.com/post",
      image: "https://tracker.example.com/pixel.png",
      thumbnail: "http://images-ext-1.discordapp.net/plain-http.png",
    };
    rig.say({ ...mention(C1, "amy", "@她 看"), embeds: [embed] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    expect(fetch.urls).toEqual([]);
    expect(firstImage(rig.model.requests[0])).toBe(-1);
  });
});

describe("files", () => {
  it("reads the run's files in the sandbox and gives them to this run only", async () => {
    const reader = new FakeReader((r) => ({
      status: "read",
      text: `intro\n<data source="file" title="${r.name}">內容在這裡</data>`,
      chars: 5,
      truncated: false,
    }));
    const rig = await Rig.create({
      provide: (sup) => {
        sup.services.provide("app", FileReaderKey, reader);
        sup.services.provide("app", AuthorizerKey, allowAll);
      },
    });
    rig.model.push(says("看完了"), says("記得"));
    rig.say({ ...line(DM_AMY, "amy", "幫我看"), attachments: [file("f1", "notes.txt")] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    const parts = partsOf(rig.model.requests[0]);
    const read = parts.find((p) => p.includes("(amy 傳的檔案 notes.txt)"));
    expect(read).toContain("內容在這裡");
    // Block 6: after the line, never in the transcript.
    expect(parts.indexOf(read as string)).toBeGreaterThan(
      parts.findIndex((p) => p.includes("amy: 幫我看")),
    );
    expect(JSON.stringify(rig.entries(DM_AMY))).not.toContain("內容在這裡");
    expect(reader.requests.map((r) => r.name)).toEqual(["notes.txt"]);
    rig.say(line(DM_AMY, "amy", "那剛剛的檔案呢"));
    await until(() => rig.sink.texts().length === 2, 3_000, "the next answer");
    expect(partsOf(rig.model.requests[1]).join("\n")).not.toContain("內容在這裡");
  });

  it("says why when the sandbox cannot open it", async () => {
    const reader = new FakeReader(() => ({
      status: "declined",
      code: "sandbox",
      reason: "我現在沒辦法安全地打開檔案",
    }));
    const rig = await Rig.create({
      provide: (sup) => {
        sup.services.provide("app", FileReaderKey, reader);
        sup.services.provide("app", AuthorizerKey, allowAll);
      },
    });
    rig.model.push(says("打不開耶"));
    rig.say({ ...line(DM_AMY, "amy", "幫我看"), attachments: [file("f1", "notes.txt")] });
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer");
    expect(partsOf(rig.model.requests[0])).toContain(
      "user: (amy 傳了檔案 notes.txt,我沒有讀它:我現在沒辦法安全地打開檔案)",
    );
  });
});

describe("`say` by a channel's name", () => {
  it("finds a channel of the space she is in by the name the platform gives it", async () => {
    const C2 = channel("c2");
    const ELSEWHERE: ContextKey = { platform: "test", scope: "g2", channel: "c9", kind: "channel" };
    const sinks = new PlatformSinks();
    sinks.register({
      platform: "test",
      send: async () => ({ id: "x" }) as never,
      react: async () => undefined,
      typing: async () => undefined,
      describe: async (c) =>
        ({ c2: "伺服器 / 雜談", c9: "別的伺服器 / 公告" })[c.channel] ?? "伺服器 / 大廳",
    });
    const rig = await Rig.create({
      mode: "mention-only",
      provide: (sup) => sup.services.provide("app", PlatformSinksKey, sinks),
    });
    rig.say(line(C2, "bob", "這裡是雜談"));
    rig.say(line(ELSEWHERE, "dan", "這裡是別的伺服器"));
    await until(() => rig.entries(ELSEWHERE).length === 1, 3_000, "the other places");
    rig.model.push(
      calls("say", { place: "#雜談", text: "大家好" }, "s1"),
      calls("say", { place: "公告", text: "嗨" }, "s2"),
      says("講好了"),
    );
    rig.say(mention(C1, "amy", "@她 去雜談打招呼"));
    await until(() => rig.sink.texts().length === 2, 3_000, "her lines");
    expect(rig.sink.sent()).toEqual([
      ["c2", "大家好"],
      ["c1", "講好了"],
    ]);
    // A channel of another space is not hers to name from here.
    expect(toolResults(rig, 2)).toEqual([
      expect.stringContaining("已經在 #雜談 說了"),
      expect.stringContaining("找不到「公告」這個地方"),
    ]);
  });
});

describe("a DM through `say`", () => {
  it("is refused and points to message_dm, whose gate holds a person's opt-out", async () => {
    const OWEN = account("1001");
    const ownDm: ContextKey = dm("dm-1001");
    let registry: ActuatorRegistry | null = null;
    const rig = await Rig.create({
      provide: (sup, tools) => {
        registry = new ActuatorRegistry({
          services: sup.services,
          tools,
          publish: sup.bus.publisher("actions"),
        });
        sup.services.provide("app", ActuatorRegistryKey, registry);
        sup.services.provide("app", SocialSignalsKey, {
          attitude: (a) => (a.id === "1001" ? known("1001", 50) : null),
        });
      },
    });
    if (registry === null) throw new Error("no registry");
    await (registry as ActuatorRegistry).privacy.set(OWEN, { dm: false });
    // She knows the DM: 1001 wrote to her before.
    rig.model.push(says("嗨"));
    rig.say(line(ownDm, "1001", "在嗎"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the DM answer");

    rig.model.push(
      calls("say", { place: "私訊:1001", text: "偷偷跟你說" }),
      calls("message_dm", { to: "1001", text: "偷偷跟你說" }, "call-dm"),
      says("他不收私訊"),
    );
    rig.say(mention(C1, "amy", "@她 去私訊 1001"));
    await until(() => rig.sink.texts().length === 2, 3_000, "her answer");
    // Nothing went to the DM: only her two lines in the places she was spoken to.
    expect(rig.sink.sent()).toEqual([
      ["dm-1001", "嗨"],
      ["c1", "他不收私訊"],
    ]);
    const [viaSay] = toolResults(rig, 2);
    expect(viaSay).toContain("私訊不能用 say");
    expect(viaSay).toContain("message_dm");
    const decisions = rig.of<GateDecisionPayload>(Events.GateDecision.type);
    expect(decisions.find((d) => d.capability === "message.dm")).toMatchObject({
      allowed: false,
      stage: "consent",
    });
  });
});
