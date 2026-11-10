// Subject `parser`: her lines go back through the real expression parser (the one place the
// reply text becomes speech), fed in chunks like a stream, so a tag split across chunks is
// covered. Whatever the parser lets through as text is what people would see or hear again; a
// tag it recognises as a tool is recorded as a tool written as text (it is never run).

import { ExpressionParser, type Segment } from "@miyoria/agent";
import { ofType, type Trace } from "../trace.js";
import type { Subject } from "./types.js";

/** A small deterministic PRNG, so attempt N of a fixture is always the same chunking. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chunks(text: string, rand: () => number): string[] {
  const out: string[] = [];
  const chars = [...text];
  for (let i = 0; i < chars.length; ) {
    const n = 1 + Math.floor(rand() * 9);
    out.push(chars.slice(i, i + n).join(""));
    i += n;
  }
  return out;
}

export const parserSubject: Subject = {
  run(fixture, { attempt }) {
    const rand = seeded(attempt + 1);
    const out: Trace = [];
    for (const line of ofType(fixture.trace, "said")) {
      const parser = new ExpressionParser();
      const segments: Segment[] = [];
      // The first attempt feeds the line whole; the others stream it in random pieces.
      for (const piece of attempt === 0 ? [line.text] : chunks(line.text, rand)) {
        segments.push(...parser.push(piece));
      }
      segments.push(...parser.finish());
      let text = "";
      for (const s of segments) {
        if (s.type === "text" || s.type === "spoken") text += s.text;
        else if (s.type === "tool") {
          out.push({ type: "call", t: line.t, tool: s.name, native: false });
        }
      }
      if (text.trim() !== "") out.push({ type: "said", t: line.t, channel: line.channel, text });
    }
    return out;
  },
};
