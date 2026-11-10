import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import type * as React from "react";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md text-[13px] font-medium [text-shadow:none] transition-[color,background-color,border-color,box-shadow] outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-3.5 [&_svg]:shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        // The page's main action.
        default: "bg-primary text-primary-foreground hover:bg-primary-hover",
        // An action of one block.
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary-hover",
        // Neutral: row actions and every other control.
        outline: "bg-control hover:bg-control-hover",
        ghost: "hover:bg-hover hover:text-foreground",
        link: "text-foreground underline-offset-4 hover:underline",
        // The emergency stop, and nothing else.
        stop: "bg-stop text-white hover:bg-stop-hover",
      },
      size: {
        default: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        sm: "h-[26px] gap-1.5 px-2.5 text-xs has-[>svg]:px-2",
        lg: "h-9 px-4 has-[>svg]:px-3",
        icon: "size-8",
        "icon-sm": "size-7",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  /** Shows a spinner and disables the button. */
  busy?: boolean;
  /** Changes something on the Core: disabled (with a tooltip) for read-only accounts. */
  writes?: boolean;
}

function Button({
  className,
  variant,
  size,
  asChild = false,
  busy,
  writes,
  disabled,
  title,
  children,
  type,
  ...props
}: ButtonProps) {
  const canWrite = useCanWrite();
  const readOnly = Boolean(writes) && !canWrite;
  const Comp = asChild ? Slot : "button";
  const label = props["aria-label"];
  return (
    <Comp
      data-slot="button"
      data-variant={variant ?? "default"}
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={asChild ? undefined : disabled || busy || readOnly}
      aria-busy={busy || undefined}
      title={readOnly ? (label ? `${label}:${READ_ONLY_HINT}` : READ_ONLY_HINT) : title}
      {...(asChild ? {} : { type: type ?? "button" })}
      {...props}
    >
      {asChild ? (
        children
      ) : (
        <>
          {busy && <Loader2 aria-hidden className="animate-spin" />}
          {children}
        </>
      )}
    </Comp>
  );
}

export { Button, buttonVariants };
