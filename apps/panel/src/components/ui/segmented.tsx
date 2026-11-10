import { type KeyboardEvent, useRef } from "react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
  title?: string;
}

/**
 * A row of mutually exclusive choices (radio group semantics, arrow keys move). For a handful of
 * short options that read better side by side than in a select: time ranges, levels, scenes.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  disabled,
  size = "sm",
  className,
}: {
  value: T | null;
  options: SegmentedOption<T>[];
  onChange: (v: T) => void;
  label: string;
  disabled?: boolean;
  size?: "sm" | "md";
  className?: string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled || disabled ? -1 : i)).filter((i) => i >= 0);
  const current = options.findIndex((o) => o.value === value);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const at = enabled.indexOf(i);
    let next: number | undefined;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = enabled[(at + 1) % enabled.length];
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = enabled[(at - 1 + enabled.length) % enabled.length];
    if (next === undefined) return;
    e.preventDefault();
    refs.current[next]?.focus();
    const o = options[next];
    if (o) onChange(o.value);
  };

  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn("inline-flex max-w-full flex-wrap items-center gap-0.5 rounded-[7px] bg-well p-0.5", className)}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        const tabbable = on || (current === -1 && i === enabled[0]);
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={tabbable ? 0 : -1}
            disabled={disabled || o.disabled}
            title={o.title}
            onClick={() => !on && onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-[5px] px-2.5 font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-45 [&_svg]:size-3.5",
              size === "sm" ? "h-[22px] text-xs" : "h-7 text-[13px]",
              on && "bg-secondary text-secondary-foreground [text-shadow:none] hover:text-secondary-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
