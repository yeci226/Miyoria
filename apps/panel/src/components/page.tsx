import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";

/** The spot in the shell's header where a page puts its tags and actions. */
export const HeaderSlotContext = createContext<HTMLElement | null>(null);

/**
 * Names the page for assistive technology (the header already reads `分類 / 頁面`) and hands its
 * tags and actions to the header.
 */
export function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  const slot = useContext(HeaderSlotContext);
  return (
    <>
      <h1 className="sr-only">{title}</h1>
      {actions && (slot ? createPortal(actions, slot) : <div className="flex flex-wrap items-center gap-2">{actions}</div>)}
    </>
  );
}

/** The frame's right column: things to act on, split by hairlines. */
function Rail({ children }: { children: ReactNode }) {
  return (
    <aside
      data-slot="rail"
      aria-label="操作"
      className="glass-dock flex min-w-0 flex-col border-t px-4 pb-7 min-[1180px]:border-t-0 min-[1180px]:border-l sm:px-5 [&>*]:border-b [&>*]:py-4 [&>*:last-child]:border-b-0"
    >
      {children}
    </aside>
  );
}

/**
 * The content surface, flush to the frame. `rail` adds the right column; give it one only when the
 * page has real things to act on. The rail is a sibling of the surface, not a child of it, because
 * a nested backdrop filter would see nothing but its parent.
 */
export function Page({ className, rail, children }: { className?: string; rail?: ReactNode; children: ReactNode }) {
  const stage = (
    <div
      data-slot="stage"
      className={cn(
        "glass-sheet flex min-w-0 flex-1 flex-col gap-(--stage-gap) px-4 pt-5 pb-9 sm:px-7",
        className,
      )}
    >
      {children}
    </div>
  );
  if (!rail) return stage;
  return (
    <div className="flex min-w-0 flex-1 flex-col min-[1180px]:grid min-[1180px]:grid-cols-[minmax(0,1fr)_19.5rem]">
      {stage}
      <Rail>{rail}</Rail>
    </div>
  );
}

/** Search, filters and toggles above a table. */
export function Toolbar({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("flex flex-wrap items-center gap-2", className)}>{children}</div>;
}
