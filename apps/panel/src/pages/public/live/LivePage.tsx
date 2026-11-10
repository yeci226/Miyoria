import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/app/connection";
import { Logo } from "@/components/logo";
import { Page } from "@/components/page";
import { LiveStage } from "./LiveStage";
import type { SourceFactory } from "./feed";

/**
 * The address of the live page: anyone may open it, logged in or not. Not `/live`: that is the
 * admin panel's 直播 page.
 */
export const LIVE_PAGE = "/watch";

/** Whether `path` (path and query) is the live page. */
export function isLivePath(path: string): boolean {
  const bare = path.split(/[?#]/)[0] ?? "";
  return bare === LIVE_PAGE || bare === `${LIVE_PAGE}/`;
}

/**
 * `/watch`: her, for anyone with the link. Watching needs nothing; patting needs a Discord login,
 * which comes back here. Nothing on it talks to an admin route.
 */
export function LivePage({ source }: { source?: SourceFactory | null }) {
  const api = useApi();
  const member = useQuery({
    queryKey: ["member", "session"],
    queryFn: ({ signal }) => api.memberSession({ signal }),
    retry: false,
  });
  const methods = useQuery({
    queryKey: ["auth", "methods"],
    queryFn: ({ signal }) => api.authMethods({ signal }),
    retry: false,
  });
  const who = member.data ?? null;
  const loginUrl = methods.data?.discord ? api.discordLoginUrl(LIVE_PAGE) : null;
  return (
    <div className="flex min-h-svh flex-col">
      <header className="glass-dock sticky top-0 z-30 flex min-h-13 items-center gap-2.5 border-b px-4 py-2 sm:px-7">
        <Logo className="size-5 shrink-0 text-primary" />
        <h1 className="text-[15px] font-semibold">Miyoria</h1>
        {who && (
          <div className="ml-auto flex min-w-0 items-center gap-2">
            {who.avatar_url && <img src={who.avatar_url} alt="" className="size-6 rounded-full" />}
            <span className="max-w-40 truncate text-[13px]">{who.name}</span>
          </div>
        )}
      </header>
      <main className="flex min-w-0 flex-1 flex-col">
        <Page>
          {member.isPending ? (
            <div className="min-h-80" aria-busy="true" aria-label="讀取中" />
          ) : (
            <LiveStage member={who} loginUrl={loginUrl} source={source} size="page" />
          )}
        </Page>
      </main>
    </div>
  );
}
