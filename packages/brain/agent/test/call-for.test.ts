// Whom a tool call acts for when several people called her in one turn (2026-11-11: 阿鰻 offered
// rice with an @-mention, ミルクねこ replied to her two seconds later about something else, both
// landed in one turn and the feed charged ミルクねこ). The runner asks this for every tool that
// acts for someone (`@miyoria/brain/self` run.ts).

import type { IncomingMessage } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { callFor, FOR_ARG } from "../src/focus.js";
import { channel, incoming, mention } from "./harness.js";

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

  it("takes the handle and her call name when it knows them, and refuses part of a name", () => {
    const names = (a: { id: string }) =>
      a.id === eel.author.account.id ? { handle: "鰻魚", call: "小鰻" } : null;
    for (const pick of ["鰻魚", "小鰻", "阿鰻"]) {
      const out = callFor(focus, targets, pick, true, asks, latest, names);
      expect(out, pick).toEqual({ ok: true, message: eel });
    }
    const part = callFor(focus, targets, "ミルク", true, asks, latest, names);
    expect(part.ok).toBe(false);
    if (!part.ok) expect(part.error).toContain("[1] 鰻魚(阿鰻)");
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
