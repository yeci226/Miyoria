import { describe, expect, it } from "vitest";
import {
  DEFAULT_PAUSE_MS,
  Expression,
  ExpressionParser,
  MAX_PAUSE_MS,
  type Segment,
} from "../src/index.js";

const emo = (emotion: string): Segment => ({ type: "emotion", emotion });
const text = (t: string): Segment => ({ type: "text", text: t });
const pause = (ms: number): Segment => ({ type: "pause", ms });
const SILENCE: Segment = { type: "silence" };

/** Parses `chunks` and merges adjacent text segments. */
function parseChunks(chunks: string[]): Segment[] {
  const parser = new ExpressionParser();
  const raw: Segment[] = [];
  for (const c of chunks) raw.push(...parser.push(c));
  raw.push(...parser.finish());
  const out: Segment[] = [];
  for (const seg of raw) {
    const prev = out.at(-1);
    if (prev?.type === "text" && seg.type === "text") prev.text += seg.text;
    else out.push(seg);
  }
  return out;
}

describe("expression", () => {
  it("parses_all_tag_kinds", () => {
    expect(
      parseChunks(["<emo:happy>欸你回來啦!<pause 300/>今天的考試怎麼樣?<emo:curious>"]),
    ).toEqual([
      emo("happy"),
      text("欸你回來啦!"),
      pause(300),
      text("今天的考試怎麼樣?"),
      emo("curious"),
    ]);
    expect(parseChunks(["<silence/>"])).toEqual([SILENCE]);
  });

  it("tags_split_across_chunks", () => {
    const expected = [emo("smug"), text("哼"), pause(500), text("。")];
    const whole = "<emo:smug>哼<pause 500/>。";
    expect(parseChunks([whole])).toEqual(expected);
    // Every possible split point.
    for (let i = 0; i <= whole.length; i++) {
      expect(parseChunks([whole.slice(0, i), whole.slice(i)]), `split at ${i}`).toEqual(expected);
    }
    // One character per chunk.
    expect(parseChunks([...whole])).toEqual(expected);
  });

  it("streams_text_before_a_pending_tag", () => {
    const p = new ExpressionParser();
    expect(p.push("你好<em")).toEqual([text("你好")]);
    expect(p.push("o:sad")).toEqual([]);
    expect(p.push(">嗚")).toEqual([emo("sad"), text("嗚")]);
    expect(p.finish()).toEqual([]);
  });

  it("voice_spans_are_spoken_lines_not_text", () => {
    const spoken = (t: string): Segment => ({ type: "spoken", text: t });
    const whole = "<voice>えっ、本当に?</voice>欸,真的嗎?<emo:happy><VOICE>よし!</voice>好!";
    const expected = [
      spoken("えっ、本当に?"),
      text("欸,真的嗎?"),
      emo("happy"),
      spoken("よし!"),
      text("好!"),
    ];
    expect(parseChunks([whole])).toEqual(expected);
    for (let i = 0; i <= whole.length; i++) {
      expect(parseChunks([whole.slice(0, i), whole.slice(i)]), `split at ${i}`).toEqual(expected);
    }
    // Unterminated at the end: still the spoken line. A stray closing tag says nothing.
    expect(parseChunks(["<voice>途中"])).toEqual([spoken("途中")]);
    expect(parseChunks(["好</voice>啊"])).toEqual([text("好啊")]);
    expect(Expression.parse("<voice>はい</voice>好").text).toBe("好");
  });

  it("malformed_tags_are_text", () => {
    expect(parseChunks(["a < b"])).toEqual([text("a < b")]);
    expect(parseChunks(["<3 你"])).toEqual([text("<3 你")]);
    expect(parseChunks(["<b>粗體</b>"])).toEqual([text("<b>粗體</b>")]);
    expect(parseChunks(["<emo:>x"])).toEqual([text("<emo:>x")]);
    expect(parseChunks(["<emo:開心>x"])).toEqual([text("<emo:開心>x")]);
    expect(parseChunks(["<pause abc/>"])).toEqual([text("<pause abc/>")]);
    expect(parseChunks(["<pauses/>"])).toEqual([text("<pauses/>")]);
    expect(parseChunks(["<silence please>"])).toEqual([text("<silence please>")]);
    // Unterminated tag at end of stream.
    expect(parseChunks(["好啦<emo:hap"])).toEqual([text("好啦<emo:hap")]);
    expect(parseChunks(["結尾<"])).toEqual([text("結尾<")]);
  });

  it("nested_angle_brackets_recover", () => {
    expect(parseChunks(["<<emo:happy>耶"])).toEqual([text("<"), emo("happy"), text("耶")]);
    expect(parseChunks(["<emo<emo:sad>"])).toEqual([text("<emo"), emo("sad")]);
  });

  it("overlong_tag_is_text", () => {
    const long = `<emo:${"a".repeat(60)}>`;
    expect(parseChunks([long])).toEqual([text(long)]);
    // Same when it arrives in pieces: the parser stops waiting.
    expect(parseChunks([long.slice(0, 55), long.slice(55)])).toEqual([text(long)]);
  });

  it("emotion_intensity", () => {
    const strong = (emotion: string, intensity: number): Segment => ({
      type: "emotion",
      emotion,
      intensity,
    });
    expect(parseChunks(["<emo:happy 0.5>耶"])).toStrictEqual([strong("happy", 0.5), text("耶")]);
    expect(parseChunks(["<emo:sad .3/>"])).toStrictEqual([strong("sad", 0.3)]);
    expect(parseChunks(["<emo:smug 1>"])).toStrictEqual([strong("smug", 1)]);
    expect(parseChunks(["<emo:smug 2>"])).toStrictEqual([strong("smug", 1)]);
    // Split across chunks while the number is still arriving.
    expect(parseChunks(["<emo:angry 0.", "8>!"])).toStrictEqual([strong("angry", 0.8), text("!")]);
    // Without a number the segment has no intensity key.
    expect(parseChunks(["<emo:happy>"])).toStrictEqual([emo("happy")]);
    // Anything else after the name is not a tag.
    expect(parseChunks(["<emo:happy very>"])).toEqual([text("<emo:happy very>")]);
    expect(parseChunks(["<emo:happy 0.5 x>"])).toEqual([text("<emo:happy 0.5 x>")]);
    expect(parseChunks(["<emo:happy -1>"])).toEqual([text("<emo:happy -1>")]);
  });

  it("lenient_tag_variants", () => {
    expect(parseChunks(["<EMO:Happy>"])).toEqual([emo("happy")]);
    expect(parseChunks(["<emo: angry >"])).toEqual([emo("angry")]);
    expect(parseChunks(["<emo:happy/>"])).toEqual([emo("happy")]);
    expect(parseChunks(["<pause 200>"])).toEqual([pause(200)]);
    expect(parseChunks(["<pause 200ms />"])).toEqual([pause(200)]);
    expect(parseChunks(["<pause=150/>"])).toEqual([pause(150)]);
    expect(parseChunks(["<pause/>"])).toEqual([pause(DEFAULT_PAUSE_MS)]);
    expect(parseChunks(["<pause 999999/>"])).toEqual([pause(MAX_PAUSE_MS)]);
    expect(parseChunks(["<silence />"])).toEqual([SILENCE]);
    expect(parseChunks(["<silence>"])).toEqual([SILENCE]);
    expect(parseChunks(["<SILENCE/>"])).toEqual([SILENCE]);
  });

  it("empty_and_plain_input", () => {
    expect(parseChunks([])).toEqual([]);
    expect(parseChunks(["", ""])).toEqual([]);
    expect(parseChunks(["只是文字"])).toEqual([text("只是文字")]);
    expect(parseChunks(["a>b"])).toEqual([text("a>b")]);
  });

  it("expression_folding_and_silence", () => {
    let e = Expression.parse("<emo:annoyed>現在都中午了好嗎……<emo:neutral>早啦。");
    expect(e.text).toBe("現在都中午了好嗎……早啦。");
    expect(e.emotions).toEqual(["annoyed", "neutral"]);
    expect(e.isSilent()).toBe(false);

    e = Expression.parse("  <silence/>");
    expect(e.silence && e.isSilent()).toBe(true);

    // Text after a leading silence is ignored.
    e = Expression.parse("<emo:sad><silence/>其實我想說");
    expect(e.isSilent()).toBe(true);
    expect(e.text).toBe("");

    // A silence tag after visible text is not a refusal.
    e = Expression.parse("嗯<silence/>好");
    expect(e.silence).toBe(false);
    expect(e.text).toBe("嗯好");

    expect(Expression.parse("<emo:happy>  ").isSilent()).toBe(true);
    expect(Expression.parse("").isSilent()).toBe(true);
  });
});

describe("markup the model imitates", () => {
  it("reads an emotion written as an attribute and shows no tags", () => {
    const e = Expression.parse('<span emo="smug">哼,才不要。</span>');
    expect(e.text).toBe("哼,才不要。");
    expect(e.emotions).toEqual(["smug"]);
  });

  it("takes a tool written as a tag out of the text", () => {
    const e = Expression.parse("<sing_start>");
    expect(e.text).toBe("");
    expect(e.tools).toEqual(["sing_start"]);
  });

  it("drops a span, also across chunks", () => {
    const parser = new ExpressionParser();
    const e = new Expression();
    for (const s of [
      ...parser.push("好<sp"),
      ...parser.push("an>啦</"),
      ...parser.push("span>"),
      ...parser.finish(),
    ]) {
      e.apply(s);
    }
    expect(e.text).toBe("好啦");
  });

  it("leaves what people really type alone", () => {
    for (const text of ["我愛你 <3", "<_<", "a < b 和 c > d", "<看什麼>"]) {
      expect(Expression.parse(text).text).toBe(text);
    }
  });
});

// 2026-11-09: `thinking` is one of her emotion names and the model used it as a thinking block:
// `<emo:thinking>the plan</emo:thinking>the reply` printed the plan and the closing tag.
describe("an emotion tag used as a thinking block", () => {
  const PLAN = "話題都跟我沒關係，插一句幫他把話講清楚就好，一句收。";
  const REPLY = "不是「做不到」，是他講的是「換模型」。";

  it("what is between the opening and the closing tag is not shown", () => {
    const e = Expression.parse(`<emo:thinking>${PLAN}</emo:thinking>${REPLY}`);
    expect(e.text).toBe(REPLY);
  });

  it("even when the tags and the plan arrive in small chunks", () => {
    const whole = `<emo:thinking>${PLAN}</emo:thinking><emo:smug>${REPLY}`;
    const chunks = [...whole].reduce<string[]>((acc, c, i) => {
      if (i % 3 === 0) acc.push("");
      acc[acc.length - 1] += c;
      return acc;
    }, []);
    const segments = parseChunks(chunks);
    expect(segments).toEqual([emo("smug"), text(REPLY)]);
  });

  it("an emotion she really means, with no closing tag, is still the emotion", () => {
    expect(parseChunks(["<emo:thinking>嗯……讓我想想。"])).toEqual([
      emo("thinking"),
      text("嗯……讓我想想。"),
    ]);
  });

  it("a closing emotion tag is never shown, and takes the text before it in that stretch", () => {
    expect(Expression.parse(`${PLAN}</emo:smug>${REPLY}`).text).toBe(REPLY);
    expect(Expression.parse(`<emo:smug>${REPLY}</emo:smug>`).text).toBe("");
    expect(Expression.parse(`好的</emo:`).text).toBe("好的</emo:");
  });

  it("other angle brackets stay text", () => {
    expect(Expression.parse("a </b> c").text).toBe("a </b> c");
  });
});
