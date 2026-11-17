// Threads posts as the page shows them, turned into something she can read. Pure: the browser
// hands over what it found in the page (`RawPost`), this file parses and describes it.

/** One post as found in the page: its visible text and what is attached. */
export interface RawPost {
  /** `/@name` of the author. */
  author: string | null;
  /** `/@name/post/<id>`: the post's own page. */
  link: string | null;
  /** ISO time of the post. */
  time: string | null;
  /** The post block's visible text, one line per element (`innerText`). */
  text: string;
  /** Pictures and videos bigger than an avatar. */
  images: number;
  /** Position in the viewport (px from its top), for scrolling. */
  top: number;
  height: number;
}

export interface Post {
  author: string;
  link: string | null;
  time: string | null;
  /** How the page says when it was posted (`1天`, `2026-10-13`). */
  age: string | null;
  body: string;
  images: number;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  shares: number | null;
}

/** `4,150` → 4150, `1.2萬` → 12000, `3.4K` → 3400, `2M` → 2000000; `null` when not a count. */
export function parseCount(text: string): number | null {
  const m = /^([\d.,]+)\s*(萬|万|億|亿|[kKmM])?$/.exec(text.trim());
  if (!m?.[1]) return null;
  const n = Number(m[1].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const unit = m[2] ?? "";
  const scale =
    unit === "萬" || unit === "万"
      ? 1e4
      : unit === "億" || unit === "亿"
        ? 1e8
        : unit.toLowerCase() === "k"
          ? 1e3
          : unit.toLowerCase() === "m"
            ? 1e6
            : 1;
  return Math.round(n * scale);
}

/** Lines that are only a relative time or a date (`1天`, `3 小時`, `2026-10-13`, `5h`). */
const AGE =
  /^(\d+\s*(秒|分鐘|分钟|小時|小时|天|週|周|個月|个月|年|[smhdwy])|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\/\d{1,2}(\/\d{2,4})?)$/;

/**
 * Reads a post block's text: the author's name, the age, the body, then the like / reply /
 * repost / share counts the page shows at the end (missing ones are `null`).
 */
export function toPost(raw: RawPost): Post {
  const lines = raw.text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const handle = raw.author?.replace(/^\/@/, "") ?? null;
  // The author's name comes first (sometimes twice, with a badge); the age right after.
  let i = 0;
  while (i < lines.length && i < 3 && (lines[i] === handle || i === 0) && !AGE.test(lines[i] ?? ""))
    i++;
  let age: string | null = null;
  if (i < lines.length && AGE.test(lines[i] ?? "")) {
    age = lines[i] ?? null;
    i++;
  }
  // The counts are the trailing lines that are numbers (at most four).
  let end = lines.length;
  const counts: number[] = [];
  while (end > i && counts.length < 4) {
    const n = parseCount(lines[end - 1] ?? "");
    if (n === null) break;
    counts.unshift(n);
    end--;
  }
  const [likes = null, replies = null, reposts = null, shares = null] = counts;
  return {
    author: handle ?? lines[0] ?? "?",
    link: raw.link,
    time: raw.time,
    age,
    body: lines.slice(i, end).join("\n"),
    images: raw.images,
    likes,
    replies,
    reposts,
    shares,
  };
}

const MAX_BODY = 600;

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A post in a few lines, for her: who, when, what, the pictures and how people reacted. */
export function describePost(post: Post, imageNote: string | null = null): string {
  const lines = [`@${post.author}${post.age ? `(${post.age})` : ""}:`];
  lines.push(post.body === "" ? "(沒有文字)" : cut(post.body, MAX_BODY));
  if (post.images > 0) {
    lines.push(imageNote ? `圖片:${imageNote}` : `附了 ${post.images} 張圖或影片(看不到內容)`);
  }
  const counts = [
    post.likes !== null ? `${post.likes} 讚` : null,
    post.replies !== null ? `${post.replies} 則留言` : null,
    post.reposts !== null ? `${post.reposts} 次轉發` : null,
  ].filter((c) => c !== null);
  if (counts.length > 0) lines.push(counts.join("、"));
  return lines.join("\n");
}
