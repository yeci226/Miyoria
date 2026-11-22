import { resolve } from "node:path";
import { CommandMount } from "@miyoria/commands";
import { actuatorsFor } from "@miyoria/gate/actions";
import {
  defineManifest,
  HEALTHY,
  type Health,
  type Module,
  type ModuleCard,
  type ModuleCardFact,
  type ModuleContext,
  type ServiceLookup,
} from "@miyoria/runtime/kernel";
import {
  CurrencyKey,
  DEFAULT_CURRENCY,
  Events,
  type KaraokeWorker,
  KaraokeWorkerKey,
  type PromptContributors,
  PromptContributorsKey,
  SongClipsKey,
  SongTicketsKey,
  SpeechPauseKey,
  safeName,
  serviceKey,
  TaskSteerKey,
  VoiceFloorKey,
  VoicePlayerKey,
} from "@miyoria/types";
import { singCapabilities } from "./actions.js";
import { DiskSongAudio, type SongAudio } from "./audio.js";
import { type GpuContext, HttpSingWorker, type SingWorker, type SongTrack } from "./client.js";
import { SingClips } from "./clips.js";
import { registerCommands } from "./commands.js";
import { SingConfigSchema } from "./config.js";
import type { Endpoint, EndpointSource, EndpointsOption } from "./endpoints.js";
import { type FailoverEntry, FailoverSingWorker } from "./failover.js";
import { localVideoFetcher, type VideoSpawner } from "./local-video.js";
import { PROMPT_KEY, SingPrompt } from "./prompt.js";
import { ROOM_PROMPT_KEY, VoiceRoom, VoiceRoomPrompt } from "./room.js";
import { Singer } from "./singer.js";

/** The singing flow (set list, requests, playback), for the Admin API and tests. */
export const SingerKey = serviceKey<Singer>("Singer");

interface Running {
  singer: Singer;
  clips: SingClips | null;
  worker: FailoverSingWorker;
  commands: CommandMount;
  prompts: PromptContributors | null;
  capabilities: (() => void)[];
  /** Removes the steer route again. */
  unroute: (() => void) | null;
  /** Stops following the registry's `sing` endpoints. */
  unwatch: (() => void) | null;
}

/** Makes the client of one song worker (tests replace the HTTP client). */
export type SingWorkerFactory = (
  endpoint: Endpoint,
  timeoutMs: number,
  source: EndpointSource,
) => SingWorker;

/**
 * Where the songs' audio is kept on Core (tests keep it in memory). `keep`: the song ids still in
 * the set list.
 */
export type SongAudioFactory = (
  worker: SingWorker,
  tracks: readonly SongTrack[],
  keep: () => ReadonlySet<string>,
) => SongAudio;

/**
 * Where else who listens and which songs are needed now go, each time the song worker is told
 * (every poll while a song is prepared): Core's wiring sends them to the hosts' GPU arbiters
 * (`cluster.context`), so this package needs no cluster package.
 */
export type GpuContextSink = (services: ServiceLookup, context: GpuContext) => void;

/** What stays the same when a worker restarts elsewhere: its host and service. */
function endpointId(endpoint: Endpoint): string {
  return `${endpoint.host}/${endpoint.service}`;
}

/**
 * Module `sing`: song requests sung in her voice. The song workers (`workers/sing`, the `sing`
 * endpoints of Core's registry, in its order) prepare covers; this module keeps the set list,
 * offers ready songs to her mind, plays them through the voice node (`VoicePlayerKey`) with
 * lyrics cues and the vocal stem as the lip-sync track, and holds the voice channel while a song
 * plays (`VoiceFloorKey`).
 *
 * Also provides `SongClips` (`clips.ts`): short pieces of the songs she covered, played in voice
 * for the party game that guesses songs without being her singing.
 *
 * Registers `sing.request` / `sing.play` / `sing.stop` (tools `sing_request` / `sing_start` /
 * `sing_stop`), `/queue song ...` and the prompt section `sing`; sings `[modules.queue]` items
 * of kind `song` when they are called. Services used (all optional): `VoicePlayer` (to sing),
 * `Mind`, `RequestQueue`, `CommandRegistry`, `PromptContributors`, `ActuatorRegistry`,
 * `SettingsStore` (the set list survives a restart, key `_global` / `sing:setlist`).
 */
export class SingModule implements Module {
  static readonly ID = "sing";
  readonly manifest = defineManifest(SingModule.ID, "Singing", {
    icon: "music",
    category: "play",
    description: "Song requests: AI covers in her voice, sung in voice with lyrics",
    // `cluster`: its registry is where the song workers of other machines are listed, so it
    // starts first (the list is asked again before every use as well, see `refresh` below).
    optional: [
      "cluster",
      "voice.link",
      "arbiter",
      "queue",
      "commands",
      "actions",
      "agent",
      "activity",
    ],
    configSchema: SingConfigSchema,
  });
  readonly #worker: SingWorkerFactory | null;
  readonly #baseDir: string;
  readonly #endpoints: EndpointsOption | null;
  readonly #context: GpuContextSink | null;
  readonly #audio: SongAudioFactory | null;
  readonly #videoSpawner: VideoSpawner | null;
  #running: Running | null = null;

  /**
   * `worker`: replaces the HTTP client (tests). `baseDir`: what a relative `video_dir` or
   * `audio_dir` is relative to (the directory of `miyoria.toml`; default the working directory).
   * `endpoints`: Core's endpoint registry, where the song workers are. `context`: where else the
   * audience context goes (`GpuContextSink`). `audio`: replaces the songs' audio on disk (tests).
   * `videoSpawner`: starts yt-dlp for `video_source = "local"` (tests give a fake one).
   */
  constructor(
    worker: SingWorkerFactory | null = null,
    options: {
      baseDir?: string;
      endpoints?: EndpointsOption;
      context?: GpuContextSink;
      audio?: SongAudioFactory;
      videoSpawner?: VideoSpawner;
    } = {},
  ) {
    this.#worker = worker;
    this.#baseDir = options.baseDir ?? process.cwd();
    this.#endpoints = options.endpoints ?? null;
    this.#context = options.context ?? null;
    this.#audio = options.audio ?? null;
    this.#videoSpawner = options.videoSpawner ?? null;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = ctx.config(SingConfigSchema);
    const timeoutMs = cfg.timeout_secs * 1000;
    const source = this.#endpoints?.(ctx.services) ?? null;
    // The workers are the registry's `sing` endpoints, followed as they come and go. A client is
    // made again only when its endpoint changed (another address, another token).
    const clients = new Map<string, { key: string; endpoint: Endpoint; worker: SingWorker }>();
    const worker = new FailoverSingWorker([], {
      retryMs: cfg.fallback_retry_secs * 1000,
      now: () => ctx.clock.now(),
      failed: (id, error) => {
        const client = clients.get(id);
        if (client !== undefined) source?.failed(client.endpoint, error);
      },
      // The registry is looked up again at every use: one that was not there when this module
      // started (the `cluster` module restarted, or started later) is found then.
      refresh: () => follow(),
      // Each new song counts on its worker in the registry until its job ends (v5-hostd §15).
      reserve: (id, what) => {
        const client = clients.get(id);
        if (client === undefined || source?.reserve === undefined) return null;
        return source.reserve(client.endpoint, what === undefined ? {} : { what });
      },
      openSession: (room) => {
        const endpoint = source?.openSession?.("sing", `karaoke:${room}`) ?? null;
        return endpoint === null ? null : endpointId(endpoint);
      },
    });
    const follow = () => {
      if (source === null) return;
      // In the registry's order (for `job` work, its dispatch order), with the workers that take
      // no new work now (drained, excluded, her speech host) still listed for what they hold.
      const taking = new Set(
        source.candidates("sing", { ignoreResting: true }).map((endpoint) => endpointId(endpoint)),
      );
      const entries: FailoverEntry[] = source
        .candidates("sing", { ignoreResting: true, all: true })
        .map((endpoint) => {
          const id = endpointId(endpoint);
          const key = JSON.stringify([endpoint.via, endpoint.url, endpoint.headers]);
          let client = clients.get(id);
          if (client === undefined || client.key !== key) {
            const made =
              this.#worker?.(endpoint, timeoutMs, source) ??
              new HttpSingWorker(endpoint, timeoutMs, source, {
                stallMs: cfg.fetch_stall_secs * 1000,
              });
            client = { key, endpoint, worker: made };
            clients.set(id, client);
          } else client.endpoint = endpoint;
          return {
            id,
            name: endpoint.url,
            url: endpoint.url,
            worker: client.worker,
            takesWork: taking.has(id),
          };
        });
      worker.update(entries);
    };
    follow();
    const unwatch = source?.watch("sing", follow) ?? null;
    if (source === null) ctx.log.warn("no endpoint registry: there is no song worker");
    const workerDir = resolve(this.#baseDir, cfg.video_dir);
    const videoDir = cfg.video ? workerDir : null;
    const sink = this.#context;
    const tracks: SongTrack[] = cfg.lip_sync_vocals
      ? ["play_mix.pcm", "play_vocals.pcm"]
      : ["play_mix.pcm"];
    let listed: Singer | null = null;
    // The songs still in the set list stay on Core whatever the budget.
    const keep = (): ReadonlySet<string> =>
      new Set(listed?.list.open().flatMap((e) => (e.song === null ? [] : [e.song.id])) ?? []);
    const audio =
      this.#audio?.(worker, tracks, keep) ??
      new DiskSongAudio({
        dir: resolve(this.#baseDir, cfg.audio_dir),
        maxBytes: cfg.audio_cache_mb * 1024 * 1024,
        worker,
        tracks,
        localDir: workerDir,
        keep,
      });
    const singer = new Singer(
      cfg,
      ctx,
      worker,
      videoDir,
      sink === null ? null : (context) => sink(ctx.services, context),
      audio,
      localVideoFetcher(cfg, this.#videoSpawner ?? undefined),
    );
    listed = singer;
    const actuators = actuatorsFor(ctx);
    const capabilities = singCapabilities(singer, cfg.permissions).map((c) =>
      actuators.register(c),
    );

    let paths: string[] = [];
    const coin = () => ctx.services.get(CurrencyKey) ?? DEFAULT_CURRENCY;
    const commands = new CommandMount(
      "sing",
      (registry) => {
        paths = registerCommands(registry, cfg.permissions, actuators, singer, coin());
      },
      (registry) => {
        for (const path of paths) registry.unregister(path);
      },
    );
    commands.attach(ctx);
    const prompts = ctx.services.get(PromptContributorsKey) ?? null;
    prompts?.register(new SingPrompt(singer, coin));
    const room = new VoiceRoom(() => ctx.clock.now());
    prompts?.register(new VoiceRoomPrompt(room, singer.list));
    singer.setPresence((guild, who) => room.present(guild, who));
    ctx.provide(SingerKey, singer);
    ctx.provide(VoiceFloorKey, singer);
    ctx.provide(SpeechPauseKey, singer);
    // The market's pass asks whether a charged ticket's song is still in the set list.
    ctx.provide(SongTicketsKey, { holds: (key) => singer.holdsTicket(key) });
    // Karaoke prepares its songs on the same workers, through the same failover.
    ctx.provide(KaraokeWorkerKey, karaokeWorker(worker));
    let clips: SingClips | null = null;
    if (cfg.clips) {
      clips = new SingClips({
        cfg,
        clock: ctx.clock,
        worker,
        voice: () => ctx.services.get(VoicePlayerKey) ?? null,
        entries: () => singer.list.all(),
        waitQuiet: (guild, expectMs, signal) => singer.waitQuiet(guild, null, expectMs, signal),
        clipping: (guild, delta) => singer.clipping(guild, delta),
        singing: () => singer.playing() !== null,
        audio,
      });
      ctx.provide(SongClipsKey, clips);
      ctx.spawn("clips", (signal) => (clips as SingClips).run(signal));
    }

    const events = ctx.subscribe([
      Events.VoiceJoined.type,
      Events.VoiceLeft.type,
      Events.VoiceParticipants.type,
      Events.VoicePlaybackEvent.type,
      Events.AgentTurnCompleted.type,
      Events.ArbiterDecided.type,
      Events.QueueItemActivated.type,
    ]);
    ctx.spawn("events", async () => {
      for await (const env of events) {
        room.onEvent(env);
        singer.onEvent(env);
      }
    });
    await singer.restore();
    ctx.spawn("worker", (signal) => singer.run(signal));
    ctx.spawn("library", (signal) => singer.keepLibrary(signal));
    // The main line changes a song that has not started through the ActivityManager's steer.
    const unroute =
      ctx.services.get(TaskSteerKey)?.registerRoute("sing", {
        capability: "sing.steer",
        live: (task) => singer.steerable(task),
        args: (steer) => ({
          steer: {
            id: steer.id,
            task: steer.task,
            patch: steer.patch,
            why: steer.why,
            cause: steer.cause,
          },
        }),
      }) ?? null;
    this.#running = { singer, clips, worker, commands, prompts, capabilities, unroute, unwatch };
  }

  async health(): Promise<Health> {
    const running = this.#running;
    if (!running) return HEALTHY;
    const why = await running.worker.health(AbortSignal.timeout(3000));
    return why === null ? HEALTHY : { status: "degraded", reason: why };
  }

  /**
   * The set list (songs still open, the ones being prepared), what she is singing now, and whether
   * a song worker takes work (the failover's last word on each, never a request from here). While
   * a song plays, an action stops it (`sing.stop`, through the gate).
   */
  async card(): Promise<ModuleCard> {
    const running = this.#running;
    if (!running) return { facts: [] };
    const { singer, worker } = running;
    const playing = singer.playing();
    const facts: ModuleCardFact[] = [
      { label: "歌單", value: singer.list.open().length, unit: "首" },
      { label: "準備中", value: singer.list.preparing().length, unit: "首" },
    ];
    if (playing !== null) {
      // 正在唱 only once her voice is out; before that she is saying her opening line.
      facts.push({
        label: singer.singing() === playing ? "正在唱" : "準備開唱",
        value: safeName(playing.song?.title?.trim() || playing.query, 40),
      });
    }
    facts.push({ label: "worker", value: worker.current() === null ? "連不上" : "連得上" });
    return {
      facts,
      ...(playing === null
        ? {}
        : {
            actions: [
              {
                id: "stop",
                label: "停下這首",
                confirm: "停下她正在唱的歌?",
                capability: "sing.stop",
                args: {},
              },
            ],
          }),
    };
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    running.unwatch?.();
    await running.singer.save();
    running.singer.close();
    running.commands.detach();
    running.prompts?.unregister(PROMPT_KEY);
    running.prompts?.unregister(ROOM_PROMPT_KEY);
    running.unroute?.();
    for (const unregister of running.capabilities) unregister();
  }
}

/**
 * The karaoke port over the song workers (docs/design/karaoke.md §3): a job with
 * `purpose: "karaoke"`, its state, and its files from the worker that made it; the pitch of a
 * singer's recording from any worker that answers.
 */
export function karaokeWorker(worker: SingWorker): KaraokeWorker {
  return {
    prepare: (query, signal) =>
      worker.submit(
        {
          ...(query.url === undefined ? {} : { url: query.url }),
          ...(query.query === undefined ? {} : { query: query.query }),
          ...(query.title === undefined ? {} : { title: query.title }),
          ...(query.artist === undefined ? {} : { artist: query.artist }),
          force: query.force ?? false,
          purpose: "karaoke",
          ...(query.lyrics === undefined ? {} : { karaoke_lyrics: query.lyrics }),
          ...(query.video === undefined ? {} : { karaoke_video: query.video }),
        },
        signal,
      ),
    job: (id, signal) => worker.job(id, signal),
    cancel: (id) => worker.cancel(id),
    file: (song, name, dest, signal) => worker.karaokeFile(song, name, dest, signal),
    key: (song, semitones, signal) => worker.karaokeKey(song, semitones, signal),
    voice: (voice, signal) => worker.karaokeVoice(voice.bytes, voice.type, signal),
    stream: (request, signal) => worker.karaokeStream(request, signal),
  };
}

/**
 * `url`, then `fallback_urls`, each address once (a trailing slash does not make it another): the
 * static registry entries Core's wiring makes of them, in this order.
 */
export function workerUrls(url: string | undefined, fallbacks: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of url === undefined ? fallbacks : [url, ...fallbacks]) {
    const key = u.replace(/\/+$/, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(u);
  }
  return out;
}
