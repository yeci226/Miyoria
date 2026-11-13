// Her Chinese in Traditional characters. She writes Traditional, but material in Simplified
// (a search result, a pasted answer) pulls her into it now and then (2026-11-10, in a DM:
// 「卤化银除了 AgF 以外全沉…」). What reaches people is converted with OpenCC (Simplified to
// Taiwan Traditional with Taiwan phrasing, as the voice package converts what it hears).
//
// Only what is Simplified is touched. A character counts as Simplified when it is not in Big5
// (the Traditional character set) and converts to something else: 「台」「后」「里」「丑」 are in
// Big5 and stay as she wrote them (「上台」 never becomes 「上臺」). A run of Han characters with
// no Traditional-only character is converted as a whole, so phrases convert as phrases; in a run
// that mixes both, only the Simplified characters are. Text with kana is Japanese and left alone.

import * as OpenCC from "opencc-js";

let toTw: ((text: string) => string) | undefined;
let toCn: ((text: string) => string) | undefined;
/** Big5's Han characters; empty when the runtime cannot decode Big5 (nothing is converted). */
let big5: ReadonlySet<string> | undefined;

const HAN = /\p{Script=Han}/u;
const HAN_RUN = /\p{Script=Han}+/gu;
const KANA = /[぀-ヿㇰ-ㇿｦ-ﾟ]/u;

function big5Han(): ReadonlySet<string> {
  if (big5 !== undefined) return big5;
  const out = new Set<string>();
  try {
    const decoder = new TextDecoder("big5");
    // Frequently and less frequently used characters (0xA440–0xC67E, 0xC940–0xF9D5); the lead
    // bytes outside are symbols and the Hong Kong extensions, which hold Simplified characters.
    for (let lead = 0xa4; lead <= 0xf9; lead++) {
      if (lead === 0xc7 || lead === 0xc8) continue;
      for (let trail = 0x40; trail <= 0xfe; trail++) {
        if (trail > 0x7e && trail < 0xa1) continue;
        const c = decoder.decode(new Uint8Array([lead, trail]));
        if (c.length === 1 && c !== "�") out.add(c);
      }
    }
  } catch {
    // No Big5 here: no character can be told to be Simplified.
  }
  big5 = out;
  return out;
}

/** `text` with what is written in Simplified Chinese converted to Traditional (see above). */
export function toTraditional(text: string): string {
  if (KANA.test(text) || !HAN.test(text)) return text;
  const known = big5Han();
  if (known.size === 0) return text;
  const tw = toTw ?? OpenCC.Converter({ from: "cn", to: "twp" });
  const cn = toCn ?? OpenCC.Converter({ from: "tw", to: "cn" });
  toTw = tw;
  toCn = cn;
  const simplified = (c: string) => !known.has(c) && tw(c) !== c;
  return text.replace(HAN_RUN, (run) => {
    const chars = [...run];
    if (!chars.some(simplified)) return run;
    if (cn(run) === run) return tw(run);
    return chars.map((c) => (simplified(c) ? tw(c) : c)).join("");
  });
}
