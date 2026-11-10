import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";

function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      className="toaster group"
      style={
        {
          "--normal-bg": "var(--float)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--line-strong)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{ classNames: { toast: "glass-float font-sans text-sm" } }}
      {...props}
    />
  );
}

export { Toaster };
