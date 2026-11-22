// The front page of a profile other than the first character's (docs/design/v5-profiles.md): the
// profile's own content when it has a `landing.json` (`GET /api/public/landing`), else a plain page
// built from her name and the profile's words. The first character keeps her hand-made page
// (`Landing.tsx`); `front.ts` picks which one loads. Everything the Core sends is plain text,
// drawn as text; pictures are the same-origin paths it gives.

import { useQuery } from "@tanstack/react-query";
import { useApi, useConnection } from "@/app/connection";
import { loginNext } from "@/app/session";
import { Button } from "@/components/ui/button";
import { SITE_NAME } from "@/lib/site-name";
import { WORLD } from "@/lib/world";
import { LIVE_PAGE } from "../live/path";

export const LANDING_PATH = "/api/public/landing";

export interface LandingSection {
  title: string;
  text: string;
  image: string | null;
}

/** What a page draws: her name, one line, and (with its own content) a cover and sections. */
export interface LandingContent {
  name: string;
  line: string;
  cover: string | null;
  sections: LandingSection[];
}

/** The line of a profile with nothing of its own. */
export const plainLine = (name: string) => `${name} 是住在 Discord 和直播裡的 AI VTuber。`;

export const PLAIN: LandingContent = { name: SITE_NAME, line: plainLine(SITE_NAME), cover: null, sections: [] };

const text = (v: unknown, max: number): string | null => (typeof v === "string" && v.trim() !== "" ? v.trim().slice(0, max) : null);

/** A picture path the Core gave: same-origin and absolute, nothing else. */
const picture = (v: unknown): string | null =>
  typeof v === "string" && v.startsWith("/api/public/landing/files/") && !v.includes("..") ? v : null;

/** The Core's answer as content; anything unreadable is the plain page's. */
export function readLanding(body: unknown): LandingContent {
  if (body === null || typeof body !== "object") return PLAIN;
  const b = body as Record<string, unknown>;
  const name = text(b.name, 64) ?? SITE_NAME;
  const line = text(b.line, 400) ?? plainLine(name);
  if (b.kind !== "own") return { name, line, cover: null, sections: [] };
  const sections = Array.isArray(b.sections)
    ? b.sections.flatMap((s: unknown) => {
        if (s === null || typeof s !== "object") return [];
        const r = s as Record<string, unknown>;
        const title = text(r.title, 80);
        const body = text(r.text, 2000);
        if (title === null && body === null) return [];
        return [{ title: title ?? "", text: body ?? "", image: picture(r.image) }];
      })
    : [];
  return { name, line, cover: picture(b.cover), sections };
}

function useLandingContent(): LandingContent {
  const { client } = useConnection();
  const q = useQuery({
    queryKey: ["public", "landing"],
    queryFn: ({ signal }) => client.request<unknown>("GET", LANDING_PATH, { signal, public: true }),
    enabled: WORLD.landing === "own",
    staleTime: 5 * 60_000,
    retry: false,
  });
  // While it loads, or when it cannot be read, the plain page.
  return q.data === undefined ? PLAIN : readLanding(q.data);
}

/** The page itself, for `content` (exported for tests). */
export function LandingPage({ content, loginUrl, notice }: { content: LandingContent; loginUrl: string | null; notice?: string | null }) {
  const her = WORLD.pronoun;
  return (
    <div className="flex min-h-svh flex-col">
      <header className="glass-dock flex h-14 items-center gap-4 border-b px-4 sm:px-7">
        <span className="min-w-0 truncate font-medium">{content.name}</span>
        <nav aria-label="這一頁" className="ml-auto flex items-center gap-4 text-sm">
          <a href={LIVE_PAGE} className="text-muted-foreground hover:text-foreground">
            直播間
          </a>
          {loginUrl && <a href={loginUrl}>用 Discord 登入</a>}
        </nav>
      </header>
      <main className="glass-sheet flex flex-1 flex-col px-4 pt-10 pb-12 sm:px-7">
        <div className="mx-auto grid w-full max-w-3xl gap-10">
          <section aria-labelledby="landing-name" className="grid gap-4">
            {content.cover && <img src={content.cover} alt="" className="max-h-96 w-full rounded-lg object-cover" />}
            <h1 id="landing-name" className="text-2xl font-semibold">
              {content.name}
            </h1>
            <p className="whitespace-pre-line text-muted-foreground">{content.line}</p>
            {notice && (
              <p role="alert" className="text-[13px] text-primary">
                {notice}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {loginUrl && (
                <Button asChild>
                  <a href={loginUrl}>用 Discord 登入</a>
                </Button>
              )}
              <Button asChild variant={loginUrl ? "outline" : "default"}>
                <a href={LIVE_PAGE}>{`看${her}直播`}</a>
              </Button>
            </div>
          </section>
          {content.sections.map((s, i) => (
            <section key={`${s.title}-${i}`} aria-label={s.title || undefined} className="grid gap-3 border-t pt-8">
              {s.title && <h2 className="text-base font-medium">{s.title}</h2>}
              {s.image && <img src={s.image} alt="" loading="lazy" className="max-h-96 w-full rounded-lg object-cover" />}
              {s.text && <p className="whitespace-pre-line text-sm text-muted-foreground">{s.text}</p>}
            </section>
          ))}
        </div>
      </main>
      <footer className="glass-dock flex flex-wrap items-center gap-4 border-t px-4 py-4 text-xs text-muted-foreground sm:px-7">
        <span>{content.name}</span>
        <nav aria-label="其他" className="ml-auto flex gap-4">
          <a href={LIVE_PAGE}>直播間</a>
          {loginUrl && <a href={loginUrl}>登入</a>}
          <a href="/login">管理面板</a>
        </nav>
      </footer>
    </div>
  );
}

/** The front page of a profile without the first character's: same props as `Landing`. */
export default function ProfileLanding({ discord, notice }: { discord: boolean; notice?: string | null }) {
  const api = useApi();
  const content = useLandingContent();
  const loginUrl = discord ? api.discordLoginUrl(loginNext()) : null;
  return <LandingPage content={content} loginUrl={loginUrl} notice={notice} />;
}
