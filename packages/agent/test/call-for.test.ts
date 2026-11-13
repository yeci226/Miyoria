// Whom a tool call acts for when several people called her in one turn (2026-11-11: 阿鰻 offered
// rice with an @-mention, ミルクねこ replied to her two seconds later about something else, both
// landed in one turn and the feed charged ミルクねこ).

import { MockProvider } from "@miyoria/llm";
import type { ToolContext } from "@miyoria/tools";
import type { IncomingMessage, JsonValue } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callFor, FOR_ARG } from "../src/focus.js";
import {
  account,
  channel,
  done,
  Harness,
  incoming,
  mention,
  noCheck,
  Probe,
  stopHarnesses,
  toolCall,
  wait,
} from "./harness.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  await stopHarnesses();
  vi.useRealTimers();
});

/** A probe that acts for the person who asked, like a capability (a feed, a deal). */
class Paying extends Probe {
  readonly actsFor = true;
}

const c = channel("c");

describe("callFor", () => {
  const eel = mention(c, "阿鰻", "@Miyoria 諾 吃🍚");
  const cat: IncomingMessage = {
    ...incoming(c, "ミルクねこ", "Facebook Marketplace"),
    reply_to_self: true,
  };
  const focus = [eel, cat];
  const targets = focus.map((m) => ({ id: m.id.id, account: m.author.account }));
  const asks = (m: IncomingMessage) => m.mentions_self || m.reply_to_self;
  const latest = () => cat;

  it("refuses a tool that acts for someone when it does not say whom", () => {
    const out = callFor(focus, targets, undefined, true, asks, latest);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toContain("[1] 阿鰻");
    expect(out.error).toContain("[2] ミルクねこ");
    expect(out.error).toContain(FOR_ARG);
  });

  it("takes the person by number or by name", () => {
    for (const pick of [1, "1", "[1]", "阿鰻", "@阿鰻", " 阿 鰻 "]) {
      const out = callFor(focus, targets, pick, true, asks, latest);
      expect(out, String(pick)).toEqual({ ok: true, message: eel });
    }
    expect(callFor(focus, targets, "2", true, asks, latest)).toEqual({ ok: true, message: cat });
  });

  it("refuses a name or number that is nobody in the focus", () => {
    for (const pick of ["3", "Owen", "0"]) {
      expect(callFor(focus, targets, pick, true, asks, latest).ok, pick).toBe(false);
    }
  });

  it("takes the person's message that asked her, not their chatter after it", () => {
    const after = incoming(c, "阿鰻", "快吃");
    const out = callFor([eel, cat, after], targets, "阿鰻", true, asks, latest);
    expect(out).toEqual({ ok: true, message: eel });
  });

  it("with one person, or a tool that acts for nobody, it is as before", () => {
    const one = callFor([eel], targets.slice(0, 1), undefined, true, asks, () => eel);
    expect(one).toEqual({ ok: true, message: eel });
    // What one person's call says does not matter: it can only be theirs.
    expect(callFor([eel], targets, "2", true, asks, () => eel)).toEqual({ ok: true, message: eel });
    expect(callFor(focus, targets, undefined, false, asks, latest)).toEqual({
      ok: true,
      message: cat,
    });
  });
});

describe("a paying tool with two people in the turn", () => {
  const lastToolResult = (mock: MockProvider, n: number): string => {
    const last = mock.requests()[n]?.messages.at(-1);
    expect(last?.role).toBe("tool");
    const content = last?.content;
    return typeof content === "string" ? content : JSON.stringify(content);
  };

  it("is refused until she says whom, then charges the one who offered", async () => {
    const feed = new Paying("accept_food");
    const mock = new MockProvider("chat")
      .events([toolCall(0, "a", "accept_food", '{"item":"rice"}'), done()])
      .events([toolCall(0, "b", "accept_food", `{"item":"rice","${FOR_ARG}":"1"}`), done()])
      .reply("謝謝阿鰻");
    // One turn for both (voice does this; text gives each caller a turn of their own).
    const config = { ...(noCheck() as object), one_caller_per_turn: false };
    const h = await Harness.build("always", config, mock, null, { tools: [feed] });
    const eel = mention(c, "阿鰻", "@Miyoria 諾 吃🍚");
    const cat: IncomingMessage = {
      ...incoming(c, "ミルクねこ", "Facebook Marketplace"),
      reply_to_self: true,
      reply_to: { context: c, id: "hers" },
    };
    h.say(eel);
    h.say(cat);
    await wait(5000);
    // Offered with whom it is for, required: several people called her.
    const spec = mock.requests()[0]?.tools?.find((t) => t.name === "accept_food");
    expect(JSON.stringify(spec?.parameters)).toContain(FOR_ARG);
    expect((spec?.parameters as { required?: string[] } | undefined)?.required).toContain(FOR_ARG);
    // Not said: refused, with the choices; nothing ran, nobody paid.
    expect(lastToolResult(mock, 1)).toContain("[1] 阿鰻");
    // Said: it runs for 阿鰻 and her message, and the tool never sees `for_whom`.
    expect(feed.calls).toHaveLength(1);
    const [ctx, args] = feed.calls[0] as [ToolContext, JsonValue];
    expect(ctx.account).toEqual(account("阿鰻"));
    expect(ctx.principal).toMatchObject({ kind: "user", requester: account("阿鰻") });
    expect(ctx.message).toEqual(eel.id);
    expect(args).toEqual({ item: "rice" });
  });

  it("one person asking: no question of whom, as before", async () => {
    const feed = new Paying("accept_food");
    const mock = new MockProvider("chat")
      .events([toolCall(0, "a", "accept_food", '{"item":"rice"}'), done()])
      .reply("謝謝");
    const h = await Harness.build("always", noCheck(), mock, null, { tools: [feed] });
    const eel = mention(c, "阿鰻", "@Miyoria 諾 吃🍚");
    h.say(eel);
    h.say(incoming(c, "路人", "哈哈"));
    await wait(5000);
    const spec = mock.requests()[0]?.tools?.find((t) => t.name === "accept_food");
    expect(JSON.stringify(spec?.parameters)).not.toContain(FOR_ARG);
    expect(feed.calls).toHaveLength(1);
    expect(feed.calls[0]?.[0].account).toEqual(account("阿鰻"));
  });
});
