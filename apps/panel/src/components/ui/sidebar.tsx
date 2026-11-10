// shadcn/ui Sidebar, trimmed to what the panel uses: flush frame glass, collapsible to icons on
// desktop (⌘/Ctrl+B), a row across the top on narrow screens, state remembered in localStorage.

import { Slot } from "@radix-ui/react-slot";
import { PanelLeftIcon } from "lucide-react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useIsMobile } from "@/hooks/use-mobile";
import { readStorage, writeStorage } from "@/lib/storage";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "miyoria.panel.sidebar";
const WIDTH = "13rem";
const WIDTH_ICON = "3.25rem";

interface SidebarContextValue {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  isMobile: boolean;
  toggleSidebar: () => void;
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null);

function useSidebar() {
  const ctx = React.useContext(SidebarContext);
  if (!ctx) throw new Error("useSidebar must be used within a SidebarProvider.");
  return ctx;
}

function SidebarProvider({ className, style, children, ...props }: React.ComponentProps<"div">) {
  const isMobile = useIsMobile();
  const [open, setOpenState] = React.useState(() => readStorage(STORAGE_KEY) !== "collapsed");
  const setOpen = React.useCallback((value: boolean) => {
    setOpenState(value);
    writeStorage(STORAGE_KEY, value ? "expanded" : "collapsed");
  }, []);
  const toggleSidebar = React.useCallback(() => {
    if (!isMobile) setOpen(!open);
  }, [isMobile, open, setOpen]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "b" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleSidebar]);

  const state = open ? "expanded" : "collapsed";
  const value = React.useMemo<SidebarContextValue>(
    () => ({ state, open, setOpen, isMobile, toggleSidebar }),
    [state, open, setOpen, isMobile, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={value}>
      <div
        data-slot="sidebar-wrapper"
        style={
          { "--sidebar-width": WIDTH, "--sidebar-width-icon": WIDTH_ICON, ...style } as React.CSSProperties
        }
        className={cn("group/sidebar-wrapper flex min-h-svh w-full flex-col md:flex-row", className)}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

function Sidebar({ className, children, ...props }: React.ComponentProps<"aside">) {
  const { isMobile, state } = useSidebar();

  if (isMobile) {
    return (
      <aside className={cn("glass-dock flex w-full flex-col border-b text-sidebar-foreground", className)} {...props}>
        {children}
      </aside>
    );
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={state === "collapsed" ? "icon" : ""}
      data-slot="sidebar"
    >
      <div
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-out",
          "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
        )}
      />
      <aside
        className={cn(
          "glass-dock fixed inset-y-0 left-0 z-20 hidden h-svh w-(--sidebar-width) flex-col overflow-hidden border-r border-sidebar-border transition-[width] duration-200 ease-out md:flex",
          "group-data-[collapsible=icon]:w-(--sidebar-width-icon)",
          className,
        )}
        {...props}
      >
        {children}
      </aside>
    </div>
  );
}

function SidebarTrigger({ className, onClick, ...props }: React.ComponentProps<typeof Button>) {
  const { toggleSidebar } = useSidebar();
  return (
    <Button
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon-sm"
      className={cn("hidden text-muted-foreground md:inline-flex", className)}
      onClick={(event) => {
        onClick?.(event);
        toggleSidebar();
      }}
      aria-label="切換側欄"
      {...props}
    >
      <PanelLeftIcon />
    </Button>
  );
}

function SidebarInset({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-inset"
      className={cn("relative flex w-full min-w-0 flex-1 flex-col", className)}
      {...props}
    />
  );
}

function SidebarHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sidebar-header" className={cn("flex flex-col gap-2", className)} {...props} />
  );
}

function SidebarFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div data-slot="sidebar-footer" className={cn("flex flex-col gap-1 px-2.5 py-2", className)} {...props} />
  );
}

function SidebarContent({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-content"
      className={cn(
        "flex min-h-0 flex-1 flex-col overflow-auto group-data-[collapsible=icon]:overflow-hidden",
        className,
      )}
      {...props}
    />
  );
}

function SidebarGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="sidebar-group"
      className={cn("relative flex w-full min-w-0 flex-col px-2.5 pt-1 pb-2.5", className)}
      {...props}
    />
  );
}

function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">) {
  return (
    <ul
      data-slot="sidebar-menu"
      className={cn("flex w-full min-w-0 flex-col gap-px", className)}
      {...props}
    />
  );
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">) {
  return (
    <li
      data-slot="sidebar-menu-item"
      className={cn("group/menu-item relative", className)}
      {...props}
    />
  );
}

const menuButton =
  "peer/menu-button flex h-(--nav-h) w-full items-center gap-2.5 overflow-hidden rounded-md px-2.5 text-left text-sm text-sidebar-foreground outline-hidden ring-sidebar-ring transition-[width,height,padding,background-color,color] hover:bg-hover hover:text-foreground focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50 aria-[current=page]:bg-sidebar-accent aria-[current=page]:font-medium aria-[current=page]:text-sidebar-accent-foreground group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:stroke-[1.75] [&[aria-current=page]>svg]:text-primary";

function SidebarMenuButton({
  asChild = false,
  tooltip,
  className,
  ...props
}: React.ComponentProps<"button"> & { asChild?: boolean; tooltip?: string }) {
  const Comp = asChild ? Slot : "button";
  const { isMobile, state } = useSidebar();
  const button = (
    <Comp data-slot="sidebar-menu-button" className={cn(menuButton, className)} {...props} />
  );
  if (!tooltip) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== "collapsed" || isMobile}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  );
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
};
