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
    // A span that arrives in pieces is announced once; what it says is the same.
    const lines = (segments: Segment[]) => segments.filter((s) => s.type !== "spoken_start");
    for (let i = 0; i <= whole.length; i++) {
      const got = parseChunks([whole.slice(0, i), whole.slice(i)]);
      expect(lines(got), `split at ${i}`).toEqual(expected);
      expect(got.length - lines(got).length, `split at ${i}`).toBeLessThanOrEqual(1);
    }
    // Unterminated at the end: still the spoken line. A stray closing tag says nothing.
    expect(lines(parseChunks(["<voice>途中"]))).toEqual([spoken("途中")]);
    expect(parseChunks(["好</voice>啊"])).toEqual([text("好啊")]);
    expect(Expression.parse("<voice>はい</voice>好").text).toBe("好");
  });

  it("an_opening_voice_span_says_the_text_before_it_is_complete", () => {
    const p = new ExpressionParser();
    expect(p.push("<voice>はい</voice>好。")).toEqual([
      { type: "spoken", text: "はい" },
      text("好。"),
    ]);
    // The tag itself may still be anything: nothing yet.
    expect(p.push("<voi")).toEqual([]);
    expect(p.push("ce>じゃ")).toEqual([{ type: "spoken_start" }]);
    // Once per span, however many chunks it takes.
    expect(p.push("あ行")).toEqual([]);
    expect(p.push("こう</voice>走吧。")).toEqual([
      { type: "spoken", text: "じゃあ行こう" },
      text("走吧。"),
    ]);
    expect(p.push("<voice>次")).toEqual([{ type: "spoken_start" }]);
    expect(p.finish()).toEqual([{ type: "spoken", text: "次" }]);
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

  it("takes a react tag out of the text and logs it as a tool", () => {
    for (const tag of ['<react emoji="👍"/>', '<react emoji=":BongoWow:"/>']) {
      const e = Expression.parse(`${tag}好喔`);
      expect(e.text).toBe("好喔");
      expect(e.tools).toEqual(["react"]);
    }
  });

  it("holds a react tag that arrives in pieces", () => {
    const parser = new ExpressionParser();
    const e = new Expression();
    for (const s of [
      ...parser.push('<react emoji="'),
      ...parser.push('👍"/>可以'),
      ...parser.finish(),
    ]) {
      e.apply(s);
    }
    expect(e.text).toBe("可以");
    expect(e.tools).toEqual(["react"]);
  });

  it("drops a DeepSeek tool call written as text, arguments and all", () => {
    const e = Expression.parse(
      '好喔<｜｜DSML｜｜ function_calls><｜｜DSML｜｜ invoke name="keep_note"><｜｜DSML｜｜ parameter name="text">等修好再唱</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ function_calls>',
    );
    expect(e.text).toBe("好喔");
  });

  it("drops stray DSML closing tags", () => {
    expect(Expression.parse("等修好再唱</｜DSML｜ parameter></｜DSML｜ invoke>").text).toBe(
      "等修好再唱",
    );
  });

  // 2026-11-11 in the channel: 「<react emoji="👍"/>」 went out as the first line of a reply.
  it("takes a tool written as a tag with attributes out of the text", () => {
    const cases: [string, string][] = [
      ['<react emoji="👍"/>\n可以啊,你看', "\n可以啊,你看"],
      ["<react emoji='💀' />笑死", "笑死"],
      ['好<react emoji="<:miyo_smug:112233445566778899>"/>', "好"],
      ['<remember text="他喜歡貓" about="owen">記住了', "記住了"],
      ["<react/>嗯", "嗯"],
    ];
    for (const [input, out] of cases) {
      const e = Expression.parse(input);
      expect(e.text, input).toBe(out);
      expect(e.tools.length, input).toBe(1);
    }
    expect(Expression.parse('<react emoji="👍"/>').tools).toEqual(["react"]);
    expect(Expression.parse('<react emoji="👍"/>').isSilent()).toBe(true);
  });

  it("also when the attribute tag arrives in pieces", () => {
    const tool: Segment = { type: "tool", name: "react" };
    expect(parseChunks(["<react emo", 'ji="', "👍", '"/', ">可以啊"])).toEqual([
      tool,
      text("可以啊"),
    ]);
    expect(parseChunks(['<react emoji="<:miyo', ":1122>", '"/>好'])).toEqual([tool, text("好")]);
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

  // 2026-11-10/11 in the channel: 「<h>我沒有亂…」, a line of `<section>`, `<p>…` and `</p>`.
  it("drops stray HTML tags and keeps their text", () => {
    const cases: [string, string][] = [
      ["<h>我沒有亂，只是同時有四件事在跑。", "我沒有亂，只是同時有四件事在跑。"],
      ["<section>", ""],
      ["<p>滑 X 吧，至少會看到有人在吵架。</p>", "滑 X 吧，至少會看到有人在吵架。"],
      ["</p>", ""],
      ['<div class="x">好<br/>啦</div>', "好啦"],
      ["<H2>標題</H2><strong>重點</strong>", "標題重點"],
      ["<emo:smug><em>哼</em><pause 200/>才不要", "哼才不要"],
    ];
    for (const [input, out] of cases) expect(Expression.parse(input).text, input).toBe(out);
    expect(Expression.parse("<emo:smug><p>哼</p>").emotions).toEqual(["smug"]);
  });

  it("also when a tag arrives in pieces", () => {
    expect(parseChunks(["<h", ">我沒有亂", "<", "/h", ">"])).toEqual([text("我沒有亂")]);
    expect(parseChunks(["<sec", "tion", ">"])).toEqual([]);
  });

  it("leaves Discord markup, code and names in brackets alone", () => {
    for (const text of [
      "<@123456789> 你好",
      "<#987654321>",
      "<:miyo_smug:112233>",
      "<a:dance:445566>",
      "<t:1794350884:R>",
      "<https://example.com>",
      "#include <bits/stdc++.h>",
      "vector<int> v; pair<int, int> p;",
      "for (int i = 0; i<n; i++) if (a<b && b>c) x = a<i>b;",
      "<Sakana2486> 說的",
      "<unistd.h>",
    ]) {
      expect(Expression.parse(text).text, text).toBe(text);
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
