import { Check, Copy } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function JsonView({ value, label }: { value: unknown; label: string }) {
  const text = JSON.stringify(value, null, 2);
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre
        aria-label={label}
        className="max-h-[50dvh] overflow-auto rounded-md bg-well p-3 font-mono text-[12.5px] leading-relaxed text-foreground/90"
      >
        {text}
      </pre>
      <Button
        size="icon-sm"
        variant="ghost"
        className="absolute top-1.5 right-1.5"
        aria-label={copied ? "已複製" : "複製 JSON"}
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

/** Two-column facts list. */
export function Facts({ items }: { items: Record<string, React.ReactNode> }) {
  return (
    <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 text-sm">
      {Object.entries(items).map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
