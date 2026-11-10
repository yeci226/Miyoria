import { Link, Outlet, useRouter, useRouterState } from "@tanstack/react-router";
import { IdCard, LogOut, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { CommandPalette } from "@/app/CommandPalette";
import { EmergencyStop, HER_NAME, useHerNow } from "@/components/live-state";
import { Logo } from "@/components/logo";
import { HeaderSlotContext } from "@/components/page";
import { Dot, type Tone } from "@/components/status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/misc";
import {
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
} from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { AppearancePopover } from "./AppearancePopover";
import { useConnection } from "./connection";
import { useEvents } from "./events-store";
import { groupFor, isActive, NAV, NAV_GROUPS, titleFor } from "./nav";
import { useHealth, useMind, useStage, useWorld } from "./queries";
import { READ_ONLY_HINT, useSession } from "./session";

const MOD_KEY = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl";

/** One dot for Core + event stream; the tooltip has the details. */
function ConnectionDot() {
  const health = useHealth();
  const { status } = useEvents();
  const { config } = useConnection();
  const { state } = useSidebar();
  const host = config.baseUrl ? config.baseUrl.replace(/^https?:\/\//, "") : window.location.host || "同源";

  const sse =
    status.state === "open"
      ? "事件串流已連線"
      : status.state === "retrying"
        ? `事件串流重連中(${Math.round(status.inMs / 1000)} 秒)`
        : status.state === "connecting"
          ? "事件串流連線中"
          : `事件串流已關閉${status.error ? `:${status.error}` : ""}`;
  const core = health.isSuccess ? `Core ${health.data.version}` : health.isError ? "Core 無回應" : "Core 連線中";

  let tone: Tone = "warning";
  if (health.isError || status.state === "closed") tone = "danger";
  else if (health.isSuccess && status.state === "open") tone = "success";
  const label = tone === "success" ? "已連線" : tone === "danger" ? "連線中斷" : "連線中";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${label}:${core},${sse}`}
          className="flex h-7 min-w-0 items-center gap-2.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <span className="flex size-4 shrink-0 items-center justify-center">
            <Dot tone={tone} pulse={tone === "warning"} />
          </span>
          {state === "expanded" && <span className="truncate">{label}</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right" align="end">
        <div className="grid gap-0.5">
          <span>{core}</span>
          <span className="text-muted-foreground">{sse}</span>
          <span className="font-mono text-muted-foreground">{host}</span>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

function SessionFooter() {
  const value = useSession();
  const router = useRouter();
  const { signOut } = useConnection();
  const { state, isMobile } = useSidebar();
  const user = value?.session.method === "discord" ? value.session.user : null;
  const readOnly = value ? !value.session.permissions.write : false;
  const logout = value?.logout ?? signOut;
  const expanded = state === "expanded" && !isMobile;
  return (
    <div className="flex items-center gap-1">
      {user && expanded && (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
          {user.avatar_url ? (
            <img
              src={user.avatar_url}
              alt=""
              width={20}
              height={20}
              referrerPolicy="no-referrer"
              className="size-5 shrink-0 rounded-full"
            />
          ) : (
            <span aria-hidden className="size-5 shrink-0 rounded-full bg-muted" />
          )}
          <span className="truncate text-xs" title={`Discord · ${user.name}`}>
            {user.name}
          </span>
          {readOnly && (
            <Badge variant="outline" title={READ_ONLY_HINT}>
              唯讀
            </Badge>
          )}
        </div>
      )}
      {!user && expanded && <span className="flex-1 truncate px-2 text-xs text-muted-foreground">Admin token</span>}
      {user && (
        <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground" title="我的頁面">
          <a
            href="/me"
            aria-label="我的頁面"
            onClick={(e) => {
              // Their own page is outside the admin routes; App switches to it on the new address.
              if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              e.preventDefault();
              router.history.push("/me");
            }}
          >
            <IdCard />
          </a>
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="text-muted-foreground"
        aria-label={user ? "登出" : "登出(清除 token)"}
        title={user ? "登出" : "登出(清除 token)"}
        onClick={logout}
      >
        <LogOut />
      </Button>
    </div>
  );
}

/** State worth seeing from anywhere: live on 直播, approvals waiting on 內心. */
function NavHint({ to }: { to: string }) {
  const stage = useStage();
  const world = useWorld();
  const mind = useMind();
  if (to === "/live" && (stage.data?.streaming || world.data?.her.golive === "live")) {
    return (
      <span className="ml-auto flex items-center group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:top-1 group-data-[collapsible=icon]:right-1" title="直播中">
        <Dot tone="brand" pulse className="size-1.5 [&>span]:size-1.5" />
        <span className="sr-only">直播中</span>
      </span>
    );
  }
  const n = mind.data?.pending_approvals ?? 0;
  if (to === "/inner" && n > 0) {
    return (
      <span className="ml-auto font-mono text-[11px] font-medium text-primary group-data-[collapsible=icon]:hidden" title={`${n} 件等待確認`}>
        {n}
      </span>
    );
  }
  return null;
}

/** Shown in the header on every page while her autonomy is stopped. */
function PausedPill() {
  const mind = useMind();
  if (!mind.data?.paused) return null;
  return (
    <Link
      to="/inner"
      search={{ tab: "thoughts" }}
      className="flex h-6 shrink-0 items-center gap-2 rounded-md border border-primary/50 bg-black/40 px-2 text-xs font-medium text-primary outline-none [text-shadow:none] hover:bg-black/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Dot tone="warning" />
      已緊急停止
    </Link>
  );
}

/** Her name and what she is doing, at the top of the sidebar. */
function HerCard() {
  const now = useHerNow();
  return (
    <Link
      to="/"
      aria-label={`${HER_NAME}:${now.label}${now.detail ? ` ${now.detail}` : ""}`}
      className="mx-2.5 flex items-center gap-2.5 rounded-lg bg-control p-2 outline-none transition-colors hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:mx-1.5 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:bg-transparent group-data-[collapsible=icon]:p-1"
    >
      <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-[13px] font-semibold text-primary-foreground [text-shadow:none]">
        {HER_NAME.slice(0, 1)}
      </span>
      <span className="grid min-w-0 group-data-[collapsible=icon]:hidden">
        <span className="truncate text-[13px] leading-tight font-medium">{HER_NAME}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-xs leading-tight text-sidebar-foreground">
          <Dot tone={now.tone} className="size-1.5 [&>span]:size-1.5" />
          <span className="truncate">{now.label}</span>
        </span>
      </span>
    </Link>
  );
}

function SearchButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="搜尋與跳轉"
      className="mx-2.5 flex h-8 items-center gap-2 rounded-md border bg-well px-2.5 text-[13px] text-sidebar-foreground outline-none transition-colors hover:border-line-strong hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:mx-2.5 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0"
    >
      <Search className="size-3.5 shrink-0" aria-hidden />
      <span className="group-data-[collapsible=icon]:hidden">搜尋</span>
      <Kbd className="ml-auto group-data-[collapsible=icon]:hidden">{MOD_KEY} K</Kbd>
    </button>
  );
}

function AppSidebar({ pathname, onSearch }: { pathname: string; onSearch: () => void }) {
  const { isMobile } = useSidebar();

  if (isMobile) {
    return (
      <Sidebar aria-label="主選單">
        <div className="flex h-11 items-center gap-1 pr-2">
          <Link to="/" className="mr-auto flex h-full items-center gap-2 px-4 text-sm font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring">
            <Logo className="size-4 shrink-0 text-primary" />
            Miyoria
          </Link>
          <ConnectionDot />
          <SessionFooter />
        </div>
        <nav aria-label="頁面" className="flex gap-px overflow-x-auto px-2 pb-2">
          {NAV.map((item) => (
            <SidebarMenuButton key={item.to} asChild className="w-auto shrink-0">
              <Link to={item.to} aria-current={isActive(item.to, pathname) ? "page" : undefined}>
                <item.icon aria-hidden />
                <span>{item.label}</span>
                <NavHint to={item.to} />
              </Link>
            </SidebarMenuButton>
          ))}
        </nav>
      </Sidebar>
    );
  }

  return (
    <Sidebar aria-label="主選單">
      <SidebarHeader className="pb-1">
        <Link
          to="/"
          className="flex h-15 items-center gap-2.5 px-[18px] text-sm font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <Logo className="size-[18px] shrink-0 text-primary" />
          <span className="truncate group-data-[collapsible=icon]:hidden">Miyoria</span>
        </Link>
        <HerCard />
        <SearchButton onOpen={onSearch} />
      </SidebarHeader>
      <SidebarContent>
        <nav aria-label="頁面">
          {NAV_GROUPS.map((group) => (
            <SidebarGroup key={group.label}>
              <h2 className="mt-2.5 mb-1 px-2.5 text-[11px] font-medium text-muted-foreground group-data-[collapsible=icon]:hidden">{group.label}</h2>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild tooltip={item.label}>
                      <Link to={item.to} aria-current={isActive(item.to, pathname) ? "page" : undefined}>
                        <item.icon aria-hidden />
                        <span>{item.label}</span>
                        <NavHint to={item.to} />
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarFooter className="border-t border-sidebar-border">
        <div className="flex items-center justify-between gap-1 group-data-[collapsible=icon]:flex-col">
          <ConnectionDot />
          <SidebarTrigger />
        </div>
        <SessionFooter />
      </SidebarFooter>
    </Sidebar>
  );
}

function AppHeader({ pathname, onSearch, onSlot }: { pathname: string; onSearch: () => void; onSlot: (el: HTMLElement | null) => void }) {
  const [scrolled, setScrolled] = useState(false);
  const group = groupFor(pathname);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 總覽 opens on the picture: the header only gains its surface once content slides under it.
  const stuck = pathname !== "/" || scrolled;

  return (
    <header
      data-slot="app-header"
      data-stuck={stuck || undefined}
      className={cn(
        "glass-dock z-30 flex min-h-13 flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b px-4 py-2 transition-[background-color,border-color] duration-150",
        "md:sticky md:top-0 md:h-15 md:flex-nowrap md:py-0 md:pr-4 md:pl-7",
      )}
    >
      <p className="truncate whitespace-nowrap text-sm text-foreground [text-shadow:0_1px_3px_rgba(0,0,0,0.6)]">
        {group && <span>{group} / </span>}
        <span className="font-medium">{titleFor(pathname)}</span>
      </p>
      <PausedPill />
      <div ref={onSlot} className="order-last flex w-full min-w-0 flex-wrap items-center gap-2 empty:hidden md:order-none md:w-auto md:flex-nowrap" />
      <span className="flex-1" />
      <Button variant="outline" size="icon" className="md:hidden" aria-label="搜尋" onClick={onSearch}>
        <Search />
      </Button>
      <AppearancePopover />
      <EmergencyStop />
    </header>
  );
}

export function Shell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [headerSlot, setHeaderSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    document.title = `${titleFor(pathname)} · Miyoria`;
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openPalette = () => setPaletteOpen(true);

  return (
    <SidebarProvider>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-black focus:px-3 focus:py-2"
      >
        跳到主要內容
      </a>
      <AppSidebar pathname={pathname} onSearch={openPalette} />
      <SidebarInset>
        <AppHeader pathname={pathname} onSearch={openPalette} onSlot={setHeaderSlot} />
        <main id="main" tabIndex={-1} className="flex min-w-0 flex-1 flex-col outline-none">
          <HeaderSlotContext.Provider value={headerSlot}>
            <Outlet />
          </HeaderSlotContext.Provider>
        </main>
      </SidebarInset>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </SidebarProvider>
  );
}
