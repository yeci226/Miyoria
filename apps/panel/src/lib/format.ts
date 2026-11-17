import type { AccountRef, ContextKey } from "@miyoria/contracts/wire";

const intFmt = new Intl.NumberFormat("zh-TW");
const compactFmt = new Intl.NumberFormat("zh-TW", { notation: "compact", maximumFractionDigits: 1 });
const usdFmt = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 4 });

export const fmtInt = (n: number): string => intFmt.format(n);
export const fmtCompact = (n: number): string => (Math.abs(n) < 10_000 ? intFmt.format(n) : compactFmt.format(n));
export const fmtUsd = (n: number): string => usdFmt.format(n);
export const fmtPct = (n: number, digits = 0): string => `${(n * 100).toFixed(digits)}%`;
export const fmtScore = (n: number): string => n.toFixed(2);

/** `contextKeyString` of `packages/types`, e.g. `discord:123:456` or `discord:dm:voice:789`. */
export function contextKeyString(c: ContextKey): string {
  const voice = c.kind === "voice" ? "voice:" : "";
  return `${c.platform}:${c.scope ?? "dm"}:${voice}${c.channel}`;
}

const KIND_LABEL: Record<ContextKey["kind"], string> = {
  channel: "頻道",
  thread: "討論串",
  dm: "私訊",
  voice: "語音",
};

export const contextKindLabel = (c: ContextKey): string => KIND_LABEL[c.kind] ?? c.kind;

/** Short label: `#456` / `私訊 789` / `語音 456`. */
export function contextShort(c: ContextKey): string {
  const tail = c.channel.length > 8 ? `…${c.channel.slice(-6)}` : c.channel;
  if (c.kind === "dm") return `私訊 ${tail}`;
  if (c.kind === "voice") return `語音 ${tail}`;
  return `#${tail}`;
}

export const accountString = (a: AccountRef): string => `${a.platform}:${a.id}`;

const timeFmt = new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const dateTimeFmt = new Intl.DateTimeFormat("zh-TW", {
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
});

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : timeFmt.format(d);
}

export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateTimeFmt.format(d);
}

const rtf = new Intl.RelativeTimeFormat("zh-TW", { numeric: "auto" });

export function fmtRelative(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.round((t - now) / 1000);
  const abs = Math.abs(s);
  if (abs < 45) return "剛剛";
  if (abs < 3600) return rtf.format(Math.round(s / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(s / 3600), "hour");
  if (abs < 86_400 * 30) return rtf.format(Math.round(s / 86_400), "day");
  return fmtDateTime(iso);
}
