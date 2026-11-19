// Small pieces the karaoke screens share.

import { Headphones, ShieldCheck } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";
import { cn } from "@/lib/utils";

const REDUCE = "(prefers-reduced-motion: reduce)";

function reduceQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(REDUCE) : null;
}

/** Whether the viewer asked for less motion; follows the setting while the page is open. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (on) => {
      const q = reduceQuery();
      q?.addEventListener("change", on);
      return () => q?.removeEventListener("change", on);
    },
    () => reduceQuery()?.matches ?? false,
    () => false,
  );
}

/**
 * How a room's screen comes in when the room moves on (the lobby, 結算中, the results): a short fade
 * and rise; under reduced motion it is just there. The whole-window stages cut in (an animated stage
 * box left its glass plates see-through in Chromium); their countdown number pops in.
 */
export const ENTER = "animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out motion-reduce:animate-none";

/** Label over value, spaced, no cell walls. */
export function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-w-0 gap-0.5", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** The Core's sentence (or the browser's) for what did not happen. */
export function Refusal({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-[13px] text-primary">
      {children}
    </p>
  );
}

/** Wear headphones: the speakers would sing along. */
export function HeadphonesLine() {
  return (
    <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
      <Headphones aria-hidden className="mt-0.5 size-4 shrink-0" />
      請戴耳機:用喇叭的話,伴唱會被麥克風收進去
    </p>
  );
}

/** The words for what leaves the browser: with a recording for the official score, or without. */
export function privacyText(recording: boolean): string {
  return recording
    ? "唱完會把這首的錄音送出一次,只用來算正式分數,算完就刪掉,不會保存"
    : "麥克風的聲音只在這個瀏覽器裡處理,不會送出去;唱完只送出一小段音高紀錄";
}

/** What leaves the browser. */
export function PrivacyLine({ recording = false }: { recording?: boolean }) {
  return (
    <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
      <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0" />
      {privacyText(recording)}
    </p>
  );
}

/** A thin bar, 0..1, in the secondary line or the primary. */
export function Bar({ value, label, tone = "neutral" }: { value: number; label: string; tone?: "neutral" | "brand" }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(v.toFixed(2))}
      className="h-1.5 w-full min-w-12 overflow-hidden rounded-[2px] bg-muted"
    >
      <div
        className={cn("h-full rounded-[2px]", tone === "brand" ? "bg-primary" : "bg-secondary-line")}
        style={{ width: `${v * 100}%` }}
      />
    </div>
  );
}
