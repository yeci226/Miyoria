// What the segment pass shows the model: the instructions (her register, Traditional Chinese)
// and one message with the place, the people, the segment's lines and the documents she already
// has, each line of them with the id an edit names it by, and what is still open there (her
// follow-ups and promises, by the id a close names them by).

import { dataBlock, type PersonId } from "@miyoria/types";
import { fromElsewhere } from "../../memory/src/places.js";
import type { TranscriptEntry } from "../../transcript/src/types.js";
import type { DocumentKind, Provenance } from "./schema.js";
import { SECTIONS, sectionLabel, sectionOrder } from "./sections.js";
import type { NoteLine } from "./types.js";

/** What she is called in the lines shown. */
export const SELF_LABEL = "我";

/** How a provenance is written to and by the model. */
export const SOURCE_LABELS: Readonly<Record<Provenance, string>> = {
  told_by_subject: "本人說的",
  told_by_other: "別人說的",
  observed: "我看到的",
  concluded: "我推測的",
};

const sectionList = (kind: DocumentKind) =>
  SECTIONS[kind]
    .filter((s) => s.key !== "misc")
    .map((s) => s.label)
    .join("、");

/** The instructions of the segment pass. */
export function segmentPassPrompt(): string {
  return `你正在回想自己剛剛參與的一段對話,把值得留下的整理進「你自己的筆記」。逐字稿裡標成「${SELF_LABEL}」的是你自己說的話,其他人用名字標示,名字後面括號裡是代號(p1、p2…)。

你會拿到:這段對話的逐字稿(每行前面的 [n] 是行號)、在場的人、你對這些人、這個地方和相關主題已經寫下的筆記(每一條前面有編號,例如 #a1b2c3)、「還沒了結的事」(你之前記下、還沒問的追問 f1、f2…,和你答應過、還沒做到的事 c1、c2…),還有你寫給自己的「我最近是誰」。

要做這幾件事:
1. episode:用我的角度,一兩句話寫這段對話發生了什麼、跟誰,加上我當時的心情(幾個字)和重要程度。沒什麼事就給 null。
2. edits:把筆記改到和這段對話一致。
   - 新的事用 add,寫進哪一份(doc)、哪一節(section)。
   - 筆記裡已經有、但這段對話的說法不一樣的,一定用 replace 換掉那一條(寫它的編號),或用 outdate 標成過時;不要另外 add 一條和它矛盾的。
   - 已經記過、說法一樣的,不用再寫。
   - 每一條都要附 quote:逐字稿裡原話的一小段,和那一行的行號 seq。關於某個人的事,要用那個人自己說的話當根據;是別人說的,source 寫「別人說的」。
   - 只記對話裡真的出現的事,不要猜。「正在做什麼」「現在在哪」這類此刻的狀態不要記。
   - 一條寫一件事,寫成日後單獨看也懂的一句話;提到人寫名字,不要寫 p1 這類代號。
   - 我對某個人的想法寫在那個人的「我的看法」,source 寫「我推測的」。
   - 「我最近是誰」只給你參考,這裡不改。
3. close 和 update:整理「還沒了結的事」。
   - 這段對話裡你已經問了、對方已經回答了、或事情已經結束的追問,把編號(例如 "f1")放進 close,reason 寫幾個字的理由。
   - 你答應過的事,這段對話裡看得出你已經做到了,也把編號(例如 "c1")放進 close。還沒做到的不要放。
   - 追問還沒了結、但事情變了(例如考試延到下週),用 update 寫新的說法(about)或幾小時後再提(due_in_hours),不要另外寫一條新的。
4. followups:之後想問或提起的事:問誰(代號)、什麼事、大概幾小時後提。和「還沒了結的事」裡哪一條追問是同一件事(換句話說也算),就不要再寫。
5. promises:這段對話裡你答應別人、還沒做到的事(例如「我等等幫你查」「明天提醒你」):對誰(代號,沒有特定的人給 null)、答應了什麼、說了多久內做到就寫大概幾小時(沒說給 null),附上你答應的那一行的行號 seq。在這段裡已經做到的、已經用排程設好的,或和「還沒了結的事」裡哪一條承諾是同一件事的,都不用寫。

不要寫好感、親密度、信任這類分數。沒有值得留下的,就給 null 和空陣列,不要硬湊。

doc 的寫法:人用代號(p1);這個地方寫「地點」;主題寫「主題:名稱」(新的主題也可以)。
各種筆記的節:
- 人:${sectionList("person")}
- 地點:${sectionList("place")}
- 主題:${sectionList("topic")}
source 只能是:本人說的、別人說的、我看到的、我推測的。

只輸出一個 JSON 物件,格式如下:
{
  "episode": {"summary": "一兩句話,我的角度", "who": ["p1"], "feeling": "我當時的心情,幾個字", "importance": 0.0到1.0} 或 null,
  "edits": [
    {"op": "add", "doc": "p1", "section": "喜好", "text": "例如:Owen 喜歡吃拉麵", "source": "本人說的", "quote": "我超愛拉麵", "seq": 12},
    {"op": "replace", "line": "#a1b2c3", "text": "例如:Owen 搬到高雄了", "quote": "我上個月搬去高雄", "seq": 15},
    {"op": "outdate", "line": "#d4e5f6", "reason": "為什麼過時了,幾個字", "quote": "原神我已經退坑了", "seq": 16}
  ],
  "followups": [{"who": "p1", "about": "例如:問 Owen 考試考得怎樣", "due_in_hours": 24}],
  "close": [{"id": "f1", "reason": "例如:Owen 說考過了"}],
  "update": [{"id": "f2", "about": "例如:問 Owen 下週的考試考得怎樣", "due_in_hours": 168}],
  "promises": [{"to": "p1", "what": "例如:幫 Owen 查那家店幾點開", "due_in_hours": 1, "seq": 18}]
}`;
}

/** Something still open, as the pass shows it: a follow-up (`f1`) or a promise of hers (`c1`). */
export interface PromptOpen {
  ref: string;
  kind: "followup" | "promise";
  text: string;
  /** The name of whom it is about, when that person is in the segment. */
  who: string | null;
}

/** Someone in the segment, with the code the model names them by. */
export interface PromptPerson {
  code: string;
  person: PersonId;
  name: string;
  names: readonly string[];
}

/** A document as the pass shows it. */
export interface PromptDocument {
  /** What `doc` is written as: `p1`, `地點`, `主題:名稱`. */
  ref: string;
  title: string;
  kind: DocumentKind;
  /** The lines shown, by the id the model names them by. */
  lines: ReadonlyArray<{ ref: string; line: NoteLine }>;
}

const chars = (s: string) => [...s].length;
const cut = (s: string, max: number) => (chars(s) > max ? `${[...s].slice(0, max).join("")}…` : s);
const oneLine = (s: string) => s.replace(/\s*\n+\s*/g, " ").trim();

/** How an entry of the segment reads: `[12] Owen(p1): ...`; `null`: not shown. */
export function entryLine(
  entry: TranscriptEntry,
  codes: ReadonlyMap<PersonId, PromptPerson>,
): string | null {
  if (entry.redacted_at !== null) return null;
  const text = oneLine(entry.content);
  switch (entry.kind) {
    case "self":
      return text === "" ? null : `[${entry.seq}] ${SELF_LABEL}: ${cut(text, 400)}`;
    case "other": {
      if (text === "") return null;
      const who = entry.person_id === null ? undefined : codes.get(entry.person_id);
      const name = entry.author ?? who?.name ?? "某人";
      return `[${entry.seq}] ${name}${who ? `(${who.code})` : ""}: ${cut(text, 400)}`;
    }
    case "tool_result":
      // What she read of another place is that place's: never written up here.
      return text === "" || fromElsewhere(entry.content)
        ? null
        : `[${entry.seq}] (工具結果)${cut(text, 200)}`;
    default:
      return null;
  }
}

/** The one message the pass sends: place, people, lines, documents, what is open, herself. */
export function segmentPassMessage(input: {
  placeLabel: string;
  people: readonly PromptPerson[];
  entries: readonly TranscriptEntry[];
  documents: readonly PromptDocument[];
  /** What is still open there; absent or empty: none. */
  open?: readonly PromptOpen[];
  self: string;
}): string {
  const codes = new Map(input.people.map((p) => [p.person, p]));
  const people = input.people.map((p) => {
    const others = p.names.filter((n) => n !== p.name);
    return `- ${p.code}:${p.name}${others.length > 0 ? `(也叫:${others.join("、")})` : ""}`;
  });
  const lines = input.entries
    .map((e) => entryLine(e, codes))
    .filter((l): l is string => l !== null);
  const docs = input.documents.map((d) => {
    const head = `=== ${d.ref}${d.title !== "" && d.title !== d.ref ? ` ${d.title}` : ""} ===`;
    if (d.lines.length === 0) return `${head}\n(還沒有筆記)`;
    const bySection = new Map<string, string[]>();
    const ordered = [...d.lines].sort(
      (a, b) => sectionOrder(d.kind, a.line.section) - sectionOrder(d.kind, b.line.section),
    );
    for (const { ref, line } of ordered) {
      const label = sectionLabel(d.kind, line.section);
      const rows = bySection.get(label) ?? [];
      rows.push(`- ${ref} ${line.text}(${SOURCE_LABELS[line.provenance]})`);
      bySection.set(label, rows);
    }
    const body = [...bySection.entries()].map(
      ([label, rows]) => `【${label}】\n${rows.join("\n")}`,
    );
    return `${head}\n${body.join("\n")}`;
  });
  const open = (input.open ?? []).map((o) => {
    const about = o.who === null ? "" : `(關於 ${o.who})`;
    const kind = o.kind === "promise" ? "我答應過:" : "追問:";
    return `- ${o.ref} ${kind}${cut(oneLine(o.text), 200)}${about}`;
  });
  return [
    `地點:${input.placeLabel}`,
    `在場的人:\n${people.length > 0 ? people.join("\n") : "(沒有)"}`,
    dataBlock("transcript", "逐字稿", lines.join("\n")),
    dataBlock("notes", "現有的筆記", docs.join("\n\n")),
    dataBlock("open", "還沒了結的事", open.length > 0 ? open.join("\n") : "(沒有)"),
    dataBlock("self", "我最近是誰", input.self),
  ].join("\n\n");
}
