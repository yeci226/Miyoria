import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "@/lib/utils";

// State has no colours of its own: neutral tags, and the primary for what needs attention.
const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center justify-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md border border-transparent px-1.5 py-0.5 text-xs font-medium [text-shadow:none] transition-colors [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-control text-foreground",
        outline: "bg-black/40 text-muted-foreground",
        success: "bg-control text-foreground",
        warning: "border-primary/50 bg-black/40 text-primary",
        destructive: "bg-primary text-primary-foreground",
        brand: "bg-control text-primary",
      },
    },
    defaultVariants: { variant: "outline" },
  },
);

export type BadgeVariant = NonNullable<VariantProps<typeof badgeVariants>["variant"]>;

function Badge({
  className,
  variant,
  asChild = false,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot : "span";
  return (
    <Comp data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
