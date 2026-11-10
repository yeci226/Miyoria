import { MoreHorizontal, Search } from "lucide-react";
import type { ReactNode } from "react";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  label: string;
  className?: string;
}) {
  return (
    <div className={cn("relative w-full sm:w-72", className)}>
      <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className="pl-8"
      />
    </div>
  );
}

/** The "⋯" menu at the end of a row. Disabled with a hint for read-only accounts. */
export function RowActions({ label, children, writes = true }: { label: string; children: ReactNode; writes?: boolean }) {
  const canWrite = useCanWrite();
  const disabled = writes && !canWrite;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          title={disabled ? READ_ONLY_HINT : undefined}
          disabled={disabled}
          className="data-[state=open]:bg-control-hover"
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
