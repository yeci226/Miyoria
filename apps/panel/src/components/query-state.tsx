import type { UseQueryResult } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { describeError, isApiError } from "@/api/http";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/misc";
import { cn } from "@/lib/utils";

/** One plain line where there is nothing to show. */
export function EmptyLine({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("py-3 text-[13px] text-muted-foreground", className)}>
      {children}
    </p>
  );
}

const ERROR_TITLE: Record<string, string> = {
  network: "連不上 Core",
  unauthorized: "登入已失效",
  unavailable: "服務未啟動",
};

export function ErrorLine({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const kind = isApiError(error) ? error.kind : "http";
  return (
    <div role="alert" className="flex flex-col items-start gap-2 py-3">
      <p className="text-[13px]">
        <span className="font-medium">{ERROR_TITLE[kind] ?? "讀取失敗"}</span>
        <span className="text-muted-foreground"> · {describeError(error)}</span>
      </p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          <RefreshCw />
          重試
        </Button>
      )}
    </div>
  );
}

/** Skeleton rows the height of real table rows. */
export function SkeletonRows({ count = 4, className }: { count?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col", className)} aria-busy="true" aria-label="載入中">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-4 border-b border-line-soft last:border-0">
          <Skeleton className="h-3.5 w-1/4" />
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="ml-auto h-3.5 w-16" />
        </div>
      ))}
    </div>
  );
}

/** Loading → error with retry → empty (one line) → data. */
export function QueryView<T>({
  query,
  isEmpty,
  empty,
  skeleton,
  children,
}: {
  query: UseQueryResult<T>;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <SkeletonRows />}</>;
  if (query.isError) return <ErrorLine error={query.error} onRetry={() => void query.refetch()} />;
  if (empty !== undefined && isEmpty?.(query.data)) {
    return typeof empty === "string" ? <EmptyLine>{empty}</EmptyLine> : empty;
  }
  return children(query.data);
}
