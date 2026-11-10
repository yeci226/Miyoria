import type { UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describeError, isApiError } from "@/api/http";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Dot } from "@/components/status";
import { Button } from "@/components/ui/button";

/** One line for a part of her whose module is not running, or that this Core does not have. */
export function OffLine({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <div role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3 text-[13px]">
      <Dot tone="neutral" className="[&>span]:bg-transparent [&>span]:ring-[1.5px] [&>span]:ring-inset [&>span]:ring-muted-foreground/70" />
      <span className="font-medium">{title}</span>
      {detail && <span className="min-w-0 text-muted-foreground break-words">{detail}</span>}
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry} className="ml-auto">
          重新檢查
        </Button>
      )}
    </div>
  );
}

/**
 * `QueryView` for the parts V4 added: besides loading, error and empty, a 503 reads as "module
 * off" (`module` names it) and a 404 on the route as "this Core does not have it".
 */
export function ModuleQuery<T>({
  query,
  module,
  isEmpty,
  empty,
  skeleton,
  children,
}: {
  query: UseQueryResult<T>;
  /** Display name of the module that provides it (`她的生活(mind)`). */
  module: string;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <>{skeleton ?? <SkeletonRows />}</>;
  if (query.isError) {
    const e = query.error;
    if (isApiError(e) && e.kind === "unavailable") {
      return <OffLine title={`${module}沒有啟動`} detail={describeError(e)} onRetry={() => void query.refetch()} />;
    }
    if (isApiError(e) && e.kind === "not_provided") {
      return <OffLine title="這個 Core 還沒有這項功能" detail={module} />;
    }
    return <ErrorLine error={e} onRetry={() => void query.refetch()} />;
  }
  if (empty !== undefined && isEmpty?.(query.data)) {
    return typeof empty === "string" ? <EmptyLine>{empty}</EmptyLine> : empty;
  }
  return <>{children(query.data)}</>;
}
