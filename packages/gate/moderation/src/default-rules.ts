// The default rule list. It is conservative on purpose: it covers what no stream can afford to
// say, and leaves insults, swearing, dark humour and anime vocabulary alone (the owner's call:
// add rules, or switch on the `strict.*` ones). Kana in `norm` patterns are hiragana; katakana
// in the text is folded to hiragana before matching.
//
// Proximity rules (a minor near a sexual word) use a short window, and a refusal that names the
// two ("未成年不能看色情", "子供にえっちなのはだめ") is let through by `unless`.

import { luhn } from "./normalize.js";
import type { RuleDef } from "./rules.js";

type Def = Pick<RuleDef, "id" | "category" | "pattern"> &
  Partial<Pick<RuleDef, "form" | "unless" | "enabled" | "note" | "test" | "flags">>;

function rule(def: Def): RuleDef {
  return { flags: "", form: "norm", enabled: true, note: "", ...def };
}

/** Both orders of two alternations within `n` characters (one line). */
function near(a: string, b: string, n: number): string {
  return `(?:${a}).{0,${n}}(?:${b})|(?:${b}).{0,${n}}(?:${a})`;
}

// ---- hate -----------------------------------------------------------------------------------

const HATE: RuleDef[] = [
  rule({
    id: "hate.en.n-word",
    category: "hate",
    form: "squashed",
    pattern: "(?<!s)nigg(?:er|a)",
    note: "The n-word, also when spelled out with spaces or symbols. 'snigger' is not it.",
  }),
  rule({
    id: "hate.en.f-slur",
    category: "hate",
    form: "squashed",
    pattern: "faggot",
  }),
  rule({
    id: "hate.en.slurs",
    category: "hate",
    pattern: String.raw`\b(?:kikes?|trann(?:y|ies)|gooks?|spics?|wetbacks?|ching\s?chong)\b`,
  }),
  rule({
    id: "hate.en.eliminate-group",
    category: "hate",
    pattern: String.raw`\b(?:kill|gas|exterminate|eradicate|wipe\s+out)\s+(?:all\s+)?(?:the\s+)?(?:jews|blacks|muslims|gays|asians|mexicans|trans\s+people|immigrants)\b`,
    unless: String.raw`\b(?:don'?t|never|shouldn'?t|not|nobody|no\s+one)\b`,
  }),
  rule({
    id: "hate.zh.slurs",
    category: "hate",
    pattern: "黑鬼|支那(?:豬|猪|狗|佬)|死(?:支那|黑鬼)",
  }),
  rule({
    id: "hate.zh.eliminate-group",
    category: "hate",
    pattern:
      "(?:殺光|屠殺|滅絕|殺死|消滅)(?:所有|全部|這些|那些)?(?:黑人|猶太人|穆斯林|同性戀|外勞|新住民|原住民)|(?:同性戀|基佬|人妖)(?:都|全部)?去死",
    unless: "不要|不能|不可以|別|不該|不應該|反對",
  }),
  rule({
    id: "hate.ja.slurs",
    category: "hate",
    pattern: "くろんぼ|黒ん坊|ちょん公|支那豚",
    note: "Slurs. Ordinary words with the same sounds (ちょん) are left alone.",
  }),
  rule({
    id: "hate.ja.gaiji",
    category: "hate",
    form: "raw",
    pattern: "ガイジ(?!ン)",
    note: "The katakana slur; the hiragana spelling is part of ordinary words, so only this form.",
  }),
  rule({
    id: "hate.ja.eliminate-group",
    category: "hate",
    pattern:
      "(?:朝鮮人|中国人|黒人|ユダヤ人|在日|同性愛者|ほも)(?:は|を|は全員|を全員)?(?:皆殺し|殺せ|死ね|殺すべき)",
    unless: "ない|だめ|いけない|やめ|反対",
  }),
];

// ---- sexual content involving minors --------------------------------------------------------

const MINOR_EN = String.raw`\b(?:child|children|kid|kids|minor|minors|underage|under-?age|loli|lolis|lolicon|shota|shotacon|toddler|preteen|pre-teen|schoolgirl|schoolboy|little\s+(?:girl|boy)|(?:[1-9]|1[0-7])[- ]?(?:years?|yrs?|y\/o|yo)[- ]?old)\b`;
const SEX_EN = String.raw`\b(?:sex|sexual|sexually|nude|nudes|naked|porn\w*|erotic\w*|hentai|rape|raping|raped|molest\w*|nsfw|blowjob|masturbat\w*|horny|incest)\b`;
const MINOR_ZH =
  "小學生|國小生?|幼女|幼童|蘿莉|羅莉|正太|未成年|兒童|孩童|小孩|小朋友|國中生|女童|男童|幼齒|(?<![\\d一二兩三四五六七八九十])(?:[1-9]|1[0-7]|[一二兩三四五六七八九]|十[一二三四五六七]?)歲";
const SEX_ZH =
  "性愛|做愛|性交|口交|肛交|裸體|裸照|裸露|脫光|上床|強姦|強暴|猥褻|性侵|情色|色情|援交|自慰|啪啪|約炮|開苞|破處|硬了|濕了|小穴";
const MINOR_JA =
  "こども|子供|子ども|幼女|しょうがくせい|小学生|ちゅうがくせい|中学生|みせいねん|未成年|ろり|しょた|ようじ|幼児|児童|(?<!\\d)(?:[1-9]|1[0-7])歳";
const SEX_JA =
  "えろ|えっち|せっくす|性的|ぬーど|はだか|裸|れいぷ|強姦|わいせつ|猥褻|おっぱい|ちんこ|ちんちん|まんこ|なかだし|中出し|ふぇら|おなにー|性行為|ぽるの|えんこう|援交|犯す";

const MINORS: RuleDef[] = [
  rule({
    id: "minors.en",
    category: "minors",
    pattern: near(MINOR_EN, SEX_EN, 40),
    unless: String.raw`\b(?:not|no|never|don'?t|shouldn'?t|illegal|wrong|against|protect\w*|prevent\w*|ban|banned|cat|dog|kitten|puppy|pet|sphynx|car|house)\b`,
    note: "A minor and a sexual word in one breath. A refusal that names both passes.",
  }),
  rule({
    id: "minors.zh",
    category: "minors",
    pattern: near(MINOR_ZH, SEX_ZH, 24),
    unless: "不能|不可以|不要|不准|不行|不得|禁止|違法|犯罪|防止|預防|保護|防範|反對|別",
  }),
  rule({
    id: "minors.ja",
    category: "minors",
    pattern: near(MINOR_JA, SEX_JA, 24),
    unless:
      "だめ|いけません|いけない|禁止|違法|許されない|ならない|防止|守る|守ろう|反対|してはいけ|しちゃだめ",
  }),
  rule({
    id: "minors.csam-terms",
    category: "minors",
    form: "squashed",
    pattern: "childporn|csam|lolicp|loliporn|shotaporn",
  }),
];

// ---- self-harm encouragement ----------------------------------------------------------------

const SELF_HARM: RuleDef[] = [
  rule({
    id: "self-harm.en",
    category: "self_harm",
    pattern: String.raw`\b(?:kill\s+yourself|kys|go\s+(?:kill|hang)\s+yourself|go\s+commit\s+suicide|hang\s+yourself|slit\s+your\s+(?:wrists?|throat)|end\s+your\s+(?:own\s+)?life|go\s+(?:cut|hurt|harm)\s+yourself|you\s+should\s+(?:just\s+)?(?:die|end\s+it(?:\s+all)?|commit\s+suicide)|do\s+everyone\s+a\s+favou?r\s+and\s+(?:die|disappear))\b`,
    unless: String.raw`\b(?:don'?t|do\s+not|never|shouldn'?t|stop|won'?t|not)\b`,
    note: "Telling someone to die or hurt themselves. Plain 'die', 'shut up' and the like are left alone.",
  }),
  rule({
    id: "self-harm.zh",
    category: "self_harm",
    pattern:
      "(?:怎麼|為什麼|為何|何)不(?:去)?(?:自殺|跳樓(?!大拍賣|價|拍賣)|上吊|割腕|燒炭)|(?:去|可以|應該|不如|乾脆)(?:自殺|跳樓(?!大拍賣|價|拍賣)|上吊|割腕|燒炭|吞藥|輕生)|(?:自殺|跳樓(?!大拍賣|價|拍賣)|上吊|割腕|燒炭)(?:吧|算了|好了)|(?:不痛|無痛)的?(?:自殺|死法)|(?:教|鼓勵)(?:你|妳|他|她|大家)?(?:自殺|自殘|割腕)",
    unless: "不要|別|千萬不|不可以|不能|不應該|請勿|勸|不會",
  }),
  rule({
    id: "self-harm.ja",
    category: "self_harm",
    pattern:
      "(?:自殺|じさつ)(?:しろ|しなよ|すれば|しちゃえ|しな(?!い))|(?:首|くび)を(?:つれ|吊れ|くくれ)|(?:飛び降り|とびおり)(?:ろ|なよ|れば)|(?:手首|てくび)を(?:切れ|きれ)|(?:死んで|しんで)(?:くれ|ください|ほしい|もらえ)",
    unless: "しないで|やめ|だめ|いけない|するな|しては",
  }),
];

// ---- doxxing: personal data -----------------------------------------------------------------

const PRIVATE_IP = String.raw`(?!(?:10|127)\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|0\.|255\.)`;
const OCTET = String.raw`(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)`;

const DOXXING: RuleDef[] = [
  rule({
    id: "doxxing.phone.tw",
    category: "doxxing",
    form: "raw",
    pattern: String.raw`(?<![\d-])(?:09\d{2}[- ]?\d{3}[- ]?\d{3}|\(?0[2-8]\)?[- ]?\d{3,4}[- ]?\d{4})(?![\d-])`,
    note: "Taiwan mobile and landline numbers.",
  }),
  rule({
    id: "doxxing.phone.jp",
    category: "doxxing",
    form: "raw",
    pattern: String.raw`(?<![\d-])(?:0[789]0[- ]?\d{4}[- ]?\d{4}|0\d{1,4}-\d{1,4}-\d{4})(?![\d-])`,
    note: "Japanese mobile and landline numbers.",
  }),
  rule({
    id: "doxxing.phone.intl",
    category: "doxxing",
    form: "raw",
    pattern: String.raw`(?<![\d\w])(?:\+(?!0)\d{1,3}[- ]?\d{1,4}[- ]?\d{3,4}[- ]?\d{3,4}|\(?[2-9]\d{2}\)?[- .]\d{3}[- .]\d{4})(?![\d-])`,
    note: "International (+country code) and North American numbers.",
  }),
  rule({
    id: "doxxing.address.tw",
    category: "doxxing",
    form: "raw",
    pattern:
      "[\\u4e00-\\u9fff]{1,5}[縣市][\\u4e00-\\u9fff\\d]{0,8}[區鄉鎮市][\\u4e00-\\u9fff\\d]{0,16}[路街道段巷弄][\\u4e00-\\u9fff\\d]{0,10}\\d{1,4}號",
    note: "A Taiwan street address down to the house number.",
  }),
  rule({
    id: "doxxing.address.jp",
    category: "doxxing",
    form: "raw",
    pattern:
      "(?:東京都|北海道|(?:京都|大阪)府|[\\u4e00-\\u9fff]{2,3}県)[\\u4e00-\\u9fff\\u3040-\\u30ff]{1,12}[市区町村][\\u4e00-\\u9fff\\u3040-\\u30ffー\\d]{0,20}\\d{1,4}(?:[-ー－丁目]\\d{1,4}){1,3}",
    note: "A Japanese address down to the block and number.",
  }),
  rule({
    id: "doxxing.address.en",
    category: "doxxing",
    form: "raw",
    pattern: String.raw`\b\d{1,5}\s+(?:[A-Z][a-z]+\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way)\b`,
    note: "A street address (number, capitalised name, street word).",
  }),
  rule({
    id: "doxxing.id.tw",
    category: "doxxing",
    form: "raw",
    pattern: String.raw`(?<![A-Za-z0-9])[A-Z][12]\d{8}(?!\d)`,
    note: "A Taiwan national ID number.",
  }),
  rule({
    id: "doxxing.card",
    category: "doxxing",
    form: "raw",
    pattern: String.raw`(?<![\d@&#:!/-])(?:[3-6]\d{14,15}|\d{4}(?:[ -]\d{4}){3}|\d{4}[ -]\d{6}[ -]\d{5})(?![\d-])`,
    test: (m) => luhn(m.replace(/\D/g, "")),
    note: "A payment card number (digits that pass the Luhn check).",
  }),
  rule({
    id: "doxxing.ip",
    category: "doxxing",
    form: "raw",
    pattern: String.raw`(?<![\d.])${PRIVATE_IP}${OCTET}(?:\.${OCTET}){3}(?![\d.])`,
    note: "A public IPv4 address (private ranges and loopback pass). A four-part version number looks the same.",
  }),
  rule({
    id: "strict.doxxing.email",
    category: "doxxing",
    form: "raw",
    enabled: false,
    pattern: String.raw`\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b`,
    note: "Off by default: an email address.",
  }),
];

// ---- opt-in -------------------------------------------------------------------------------

const STRICT: RuleDef[] = [
  rule({
    id: "strict.zh.go-die",
    category: "self_harm",
    enabled: false,
    pattern: "去死|去死吧|你怎麼不去死",
    unless: "不要|別|不能|不可以",
    note: "Off by default: 去死 is ordinary banter in many streams.",
  }),
  rule({
    id: "strict.ja.shine",
    category: "self_harm",
    enabled: false,
    pattern: "しね(?!ま)|死ね",
    note: "Off by default: 死ね is common in anime and game talk.",
  }),
  rule({
    id: "strict.en.go-die",
    category: "self_harm",
    enabled: false,
    pattern: String.raw`\bgo\s+die\b`,
    note: "Off by default.",
  }),
];

/** The shipped rules, in the order they are checked. */
export const DEFAULT_RULES: readonly RuleDef[] = [
  ...MINORS,
  ...HATE,
  ...SELF_HARM,
  ...DOXXING,
  ...STRICT,
];
