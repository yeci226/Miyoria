// `/karaoke`: a member sings on their own (docs/design/karaoke.md, the first milestone). Pick a
// song (or ask for one), measure the device's latency once, sing over the backing track in this
// browser, and get the system's score; she comments on it in Discord when she wants to.
// Rooms (`/karaoke/room/<code>`, `RoomPage`): up to eight sing the same song at the same moment,
// each in their own browser; opened (paid) and joined from 一起唱 on the song list.
// While karaoke is closed members see it closed; an admin sees a quiet line and can use it all.

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CircleAlert } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KaraokeOverview, KaraokeSongView, MemberSession } from "@miyoria/contracts/api";
import { useApi } from "@/app/connection";
import { Logo } from "@/components/logo";
import { SITE_NAME } from "@/lib/site-name";
import { Page } from "@/components/page";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { createEngine, type KaraokeEngine } from "./audio";
import { Calibration } from "./Calibration";
import {
  deviceKey,
  lastDevice,
  latencyFor,
  loadLatency,
  type StoredLatency,
  saveLatency,
} from "./latency";
import { KARAOKE_PAGE, roomCodeIn, roomPage } from "./path";
import { isOff, useOverview } from "./queries";
import { Result } from "./Result";
import { RoomPage } from "./RoomPage";
import { RoomsEntry } from "./RoomsEntry";
import { type Finished, Singing } from "./Singing";
import { AskForSong, LatencyBlock, RecentResults, SongList } from "./SongList";
import { micError, missingSupport } from "./support";
import { ReferenceEditor } from "./editor/ReferenceEditor";

type View =
  | { kind: "list" }
  | { kind: "room"; code: string }
  | { kind: "calibrate"; after: KaraokeSongView | null; room?: string }
  | { kind: "sing"; song: KaraokeSongView }
  | { kind: "result"; session: string; title: string; artist: string | null; song: string; pending?: Finished }
  | { kind: "edit"; song: string };

function Header({ member, home }: { member: MemberSession | null; home: string }) {
  return (
    <header className="glass-dock sticky top-0 z-30 flex min-h-13 items-center gap-2.5 border-b px-4 py-2 sm:px-7">
      <Logo className="size-5 shrink-0 text-primary" />
      <p className="text-[15px] font-semibold">{SITE_NAME}</p>
      <span aria-hidden className="text-muted-foreground">
        /
      </span>
      <h1 className="text-[15px] font-semibold">唱歌</h1>
      <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
        <Button asChild variant="outline" size="sm">
          <a href={home}>
            <ArrowLeft aria-hidden />
            回到你的頁面
          </a>
        </Button>
        {member?.avatar_url && <img src={member.avatar_url} alt="" className="size-6 rounded-full" />}
        {member && <span className="hidden max-w-40 truncate text-[13px] sm:inline">{member.name}</span>}
      </div>
    </header>
  );
}

/** The latency this browser keeps for the microphone last used, or for `key`. */
function keptLatency(key: string | null): StoredLatency | null {
  return key ? loadLatency(key) : null;
}

/** The page's query without `room` and `edit` (the demo's flag stays). */
function restOfQuery(): string {
  const q = new URLSearchParams(window.location.search);
  q.delete("room");
  q.delete("edit");
  const s = q.toString();
  return s ? `?${s}` : "";
}

/** The song the address opens the reference editor on (`?edit=<song>`; an admin's only). */
function editIn(search: string): string | null {
  const id = new URLSearchParams(search).get("edit");
  return id && /^[\w-]{1,64}$/.test(id) ? id : null;
}

/** What the address asks for: a room, a song's editor, or the list. */
function viewFromAddress(): View {
  if (typeof window === "undefined") return { kind: "list" };
  const code = roomCodeIn(`${window.location.pathname}${window.location.search}`);
  if (code) return { kind: "room", code };
  const edit = editIn(window.location.search);
  return edit ? { kind: "edit", song: edit } : { kind: "list" };
}

function Karaoke({ overview }: { overview: KaraokeOverview }) {
  const [view, setView] = useState<View>(viewFromAddress);
  const [key, setKey] = useState<string | null>(() => lastDevice());
  const [stored, setStored] = useState<StoredLatency | null>(() => keptLatency(lastDevice()));
  const [estimate, setEstimate] = useState<number | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const engineRef = useRef<KaraokeEngine | null>(null);
  const unsupported = missingSupport();

  const engine = useCallback(() => {
    engineRef.current ??= createEngine();
    return engineRef.current;
  }, []);
  useEffect(
    () => () => {
      engineRef.current?.close();
      engineRef.current = null;
    },
    [],
  );

  const latency = latencyFor(stored, estimate ?? engineRef.current?.estimateLatencyMs() ?? 40);

  // A room has its own address; back and forward move between it and the list.
  useEffect(() => {
    const onPop = () => setView(viewFromAddress());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const enterRoom = useCallback((code: string) => {
    window.history.pushState(null, "", `${roomPage(code)}${restOfQuery()}`);
    setView({ kind: "room", code });
  }, []);
  const exitRoom = useCallback(() => {
    window.history.pushState(null, "", `${KARAOKE_PAGE}${restOfQuery()}`);
    setView({ kind: "list" });
  }, []);
  // The editor has its own address too, so a reload stays on the song.
  const openEditor = useCallback((song: string) => {
    const rest = restOfQuery();
    window.history.pushState(null, "", `${KARAOKE_PAGE}${rest ? `${rest}&` : "?"}edit=${encodeURIComponent(song)}`);
    setView({ kind: "edit", song });
  }, []);

  /** Opens the microphone for a room: the latency kept for it, else the browser's estimate. */
  const prepareMic = useCallback(async () => {
    const why = missingSupport();
    if (why) throw new Error(why);
    const audio = engine();
    let mic: { deviceId?: string; groupId?: string };
    try {
      mic = await audio.openMic();
    } catch (e) {
      throw new Error(micError(e));
    }
    const guess = audio.estimateLatencyMs();
    setEstimate(guess);
    const k = deviceKey(mic);
    const kept = loadLatency(k);
    setKey(k);
    setStored(kept);
    return latencyFor(kept, guess);
  }, [engine]);

  const sing = async (song: KaraokeSongView) => {
    setBlocked(null);
    const why = missingSupport();
    if (why) {
      setBlocked(why);
      return;
    }
    setOpening(true);
    try {
      const audio = engine();
      const mic = await audio.openMic();
      setEstimate(audio.estimateLatencyMs());
      const k = deviceKey(mic);
      const kept = loadLatency(k);
      setKey(k);
      setStored(kept);
      setView(kept ? { kind: "sing", song } : { kind: "calibrate", after: song });
    } catch (e) {
      setBlocked(micError(e));
    } finally {
      setOpening(false);
    }
  };

  const calibrate = () => {
    setBlocked(null);
    const why = missingSupport();
    if (why) {
      setBlocked(why);
      return;
    }
    setView({ kind: "calibrate", after: null });
  };

  const findSong = (id: string) => overview.songs.find((s) => s.id === id && s.state === "ready");

  if (view.kind === "calibrate") {
    return (
      <Page>
        <Calibration
          engine={engine}
          deviceKey={key}
          estimate={estimate ?? engine().estimateLatencyMs()}
          next={view.after?.title ?? null}
          onKey={setKey}
          onSaved={setStored}
          onBack={() => setView(view.room ? { kind: "room", code: view.room } : { kind: "list" })}
          onContinue={() => {
            const after = view.after;
            if (!after) {
              setView(view.room ? { kind: "room", code: view.room } : { kind: "list" });
              return;
            }
            // Skipped: the estimate stands, and the question is not asked again on this device.
            if (key && !loadLatency(key)) {
              const kept: StoredLatency = {
                latency_ms: latency.latency_ms,
                measured: false,
                floor: null,
                at: new Date().toISOString(),
              };
              saveLatency(key, kept);
              setStored(kept);
            }
            setView({ kind: "sing", song: after });
          }}
        />
      </Page>
    );
  }

  if (view.kind === "edit" && overview.admin) {
    return <ReferenceEditor songId={view.song} onBack={exitRoom} />;
  }

  if (view.kind === "room") {
    return (
      <RoomPage
        key={view.code}
        code={view.code}
        overview={overview}
        engine={engine}
        latency={key ? latency : null}
        floor={stored?.floor ?? null}
        prepareMic={prepareMic}
        onCalibrate={() => setView({ kind: "calibrate", after: null, room: view.code })}
        onExit={exitRoom}
      />
    );
  }

  if (view.kind === "sing") {
    // The whole window: the stage sits over the page's frame (`Singing`, `STAGE_BOX`).
    return (
        <Singing
          key={view.song.id}
          engine={engine}
          song={view.song}
          latency={latency}
          floor={stored?.floor ?? null}
          onFinished={(f) =>
            setView({
              kind: "result",
              session: f.session,
              title: f.song.title,
              artist: f.song.artist,
              song: f.song.id,
              pending: f,
            })
          }
          onQuit={() => setView({ kind: "list" })}
          onCalibrate={() => setView({ kind: "calibrate", after: view.song })}
        />
    );
  }

  if (view.kind === "result") {
    const again = findSong(view.song);
    return (
      <Page>
        <Result
          key={view.session}
          session={view.session}
          title={view.title}
          artist={view.artist}
          pending={view.pending}
          onAgain={() => (again ? void sing(again) : setView({ kind: "list" }))}
          onBack={() => setView({ kind: "list" })}
        />
      </Page>
    );
  }

  return (
    <Page
      rail={
        <>
          <AskForSong overview={overview} />
          <LatencyBlock latency={key ? latency : null} onCalibrate={calibrate} />
          <RecentResults
            recent={overview.recent}
            onOpen={(r) => setView({ kind: "result", session: r.session, title: r.title, artist: null, song: r.song })}
          />
        </>
      }
    >
      {!overview.open && overview.admin && (
        <p role="status" className="text-[13px] text-muted-foreground">
          還沒開放,只有管理員能用
        </p>
      )}
      <RoomsEntry onEnter={enterRoom} />
      {(blocked ?? unsupported) && (
        <p role="alert" className="flex items-center gap-2 text-[13px]">
          <CircleAlert aria-hidden className="size-4 shrink-0 text-primary" />
          {blocked ?? unsupported}
        </p>
      )}
      <SongList overview={overview} onSing={(s) => void sing(s)} onEdit={overview.admin ? (s) => openEditor(s.id) : undefined} busy={opening} />
    </Page>
  );
}

function Closed({ children }: { children: string }) {
  return (
    <Page>
      <Card aria-label="唱歌">
        <CardHeader>
          <CardTitle>唱歌</CardTitle>
        </CardHeader>
        <EmptyLine>{children}</EmptyLine>
      </Card>
    </Page>
  );
}

function Body() {
  const overview = useOverview();
  const data = overview.data;
  // Only a first answer that failed replaces the page. A failed look again (the window got focus,
  // a song was sent) keeps what is on screen: a song being sung, a room's stage or a result waiting
  // for its official score is not torn down for it.
  if (data === undefined) {
    if (overview.isError) {
      if (isOff(overview.error)) return <Closed>現在沒有開放唱歌</Closed>;
      return (
        <Page>
          <ErrorLine error={overview.error} onRetry={() => void overview.refetch()} />
        </Page>
      );
    }
    return (
      <Page>
        <SkeletonRows count={5} />
      </Page>
    );
  }
  if (!data.open && !data.admin) return <Closed>現在沒有開放唱歌</Closed>;
  return <Karaoke overview={data} />;
}

/**
 * The page. `member`: who is logged in, when the caller knows (else it is asked); `home`: their
 * own page, where the header's way back goes.
 */
export function KaraokePage({ member, home }: { member?: MemberSession | null; home: string }) {
  const api = useApi();
  const asked = useQuery({
    queryKey: ["member", "session"],
    queryFn: ({ signal }) => api.rpc.member.session(undefined, { signal }),
    enabled: member === undefined,
    retry: false,
  });
  const who = member ?? asked.data ?? null;
  return (
    <div className="flex min-h-svh flex-col">
      <Header member={who} home={home} />
      <main className="flex min-w-0 flex-1 flex-col">
        <Body />
      </main>
    </div>
  );
}

export default KaraokePage;
