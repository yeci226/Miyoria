// Scripted feed for `?demo=1`: lets the overlay be designed, previewed in OBS and screenshotted
// without the Stage. It speaks the same messages the Stage sends, and walks through every activity
// (thinking, getting a line ready, preparing a song stage by stage, singing it) and queue change.
import type { Activity, FeedMessage, QueueItem } from "./feed.js";

interface Line {
  emotion: string;
  text: string;
}

const LINES: Line[] = [
  { emotion: "happy", text: "哈囉,今天也來聊天吧!欸等一下,你剛剛說的那個遊戲,我好像也有聽過。" },
  { emotion: "annoyed", text: "哼,才不是在等你呢。只是剛好有空而已。" },
  { emotion: "surprised", text: "咦?真的假的?!這首歌我還沒唱過耶,可以先排進去嗎?" },
  { emotion: "neutral", text: "好,那我們先來看一下接下來的順序。" },
];

/** Song requests, sung in turn (the second one has a title too long for the capsule). */
const SONGS = ["夜に駆ける", "残酷な天使のテーゼ (Director's Edit Version) - 高橋洋子"];
/** How a song's preparation goes: the worker's stages, end progress, seconds. */
const PREPARE: [label: string, upTo: number, seconds: number][] = [
  ["下載中", 0.16, 2],
  ["讓出顯示卡中", 0.16, 1.4],
  ["分離人聲", 0.46, 2.5],
  ["轉換歌聲", 0.9, 3],
  ["混音", 0.97, 1],
  ["找歌詞", 1, 0.6],
];
const SONG_SECONDS = 22;
const LYRICS = ["沈むように溶けてゆくように", "二人だけの空が広がる夜に", ""];

/** Requests that join the queue over time. */
const LATER: QueueItem[] = [
  { title: "アイドル", by: "Mia" },
  { title: "Minecraft:挖到鑽石", by: "小明" },
  { title: "講一個鬼故事", by: "阿翔" },
];

const busy = (kind: string, label: string): Activity => ({
  kind,
  label,
  detail: null,
  progress: null,
  elapsedMs: null,
  durationMs: null,
});

export function startDemo(emit: (m: FeedMessage) => void): () => void {
  let stopped = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });
  const activity = (a: Activity | null) => emit({ type: "activity", activity: a });

  // Voice levels while she "speaks": syllables (~6/s) with a little jitter, like real speech.
  let talking = false;
  let phase = 0;
  const levels = setInterval(() => {
    if (!talking) return;
    phase += 1000 / 60;
    const syllable = Math.max(0, Math.sin((phase / 1000) * Math.PI * 6.2)) ** 0.7;
    const phrase = 0.55 + 0.45 * Math.sin((phase / 1000) * Math.PI * 0.7);
    const rms = 0.012 + 0.16 * syllable * phrase * (0.75 + Math.random() * 0.5);
    // Six bands (low → high) whose balance drifts like changing vowels.
    const t = phase / 1000;
    const bands = [0, 1, 2, 3, 4, 5].map(
      (k) => rms * (1.1 - k * 0.14) * (0.6 + 0.4 * Math.sin(t * (2.3 + k * 0.9) + k)) * (0.8 + Math.random() * 0.4),
    );
    emit({ type: "levels", rms, bands });
  }, 1000 / 60);

  let queue: QueueItem[] = [
    { title: SONGS[0] as string, by: "小明" },
    { title: "Minecraft:蓋一座塔", by: "阿翔" },
    { title: "聊聊今天的天氣", by: "Mia" },
  ];
  const setQueue = (items: QueueItem[]) => {
    queue = items;
    emit({ type: "queue", items });
  };
  const status = (scene: string) =>
    emit({ type: "status", status: { core: true, vts: true, obs: true, scene, streaming: true } });

  const speak = async (turn: string, line: Line) => {
    // Her turn: thinking, then the line at TTS, then she speaks (the capsule goes away).
    activity(busy("thinking", "思考中…"));
    await wait(1500);
    activity(busy("synthesizing", "產生語音…"));
    await wait(900);
    activity(null);
    emit({ type: "emotion", name: line.emotion, intensity: line.emotion === "neutral" ? 0.6 : 1 });
    emit({ type: "speaking", state: "started" });
    talking = true;
    const chars = [...line.text];
    // Streamed in chunks, the way the agent's text arrives.
    for (let i = 0; i < chars.length && !stopped; i += 4) {
      emit({ type: "subtitle", turn, text: chars.slice(0, i + 4).join(""), final: false });
      await wait(260);
    }
    emit({ type: "subtitle", turn, text: line.text, final: true });
    await wait(900);
    talking = false;
    emit({ type: "levels", rms: 0, bands: null });
    emit({ type: "speaking", state: "stopped" });
  };

  const sing = async (n: number) => {
    const song = SONGS[(n - 1) % SONGS.length] as string;
    // The worker prepares the song, stage by stage, progress at ~4 updates a second.
    let progress = 0;
    for (const [label, upTo, seconds] of PREPARE) {
      const steps = Math.max(1, Math.round(seconds * 4));
      const from = progress;
      for (let i = 1; i <= steps && !stopped; i++) {
        progress = from + ((upTo - from) * i) / steps;
        activity({ kind: "song_prepare", label, detail: song, progress, elapsedMs: null, durationMs: null });
        await wait(250);
      }
    }
    activity(null);
    await wait(1200);
    // She sings it: the scene changes, the request leaves the queue, the bar runs on its own.
    status("唱歌");
    setQueue(queue.filter((q) => q.title !== song));
    activity({ kind: "singing", label: "正在唱", detail: song, progress: null, elapsedMs: 0, durationMs: SONG_SECONDS * 1000 });
    emit({ type: "emotion", name: "happy", intensity: 0.8 });
    emit({ type: "speaking", state: "started" });
    talking = true;
    for (let i = 0; i < LYRICS.length && !stopped; i++) {
      emit({ type: "subtitle", turn: `song-${n}:${i}`, text: LYRICS[i] as string, final: true });
      await wait((SONG_SECONDS * 1000) / LYRICS.length);
    }
    talking = false;
    emit({ type: "levels", rms: 0, bands: null });
    emit({ type: "speaking", state: "stopped" });
    activity(null);
    status("Game");
    // A request jumps the line, the next song is asked for, and the list reorders.
    const next = LATER[(n - 1) % LATER.length] as QueueItem;
    setQueue([next, ...queue, { title: SONGS[n % SONGS.length] as string, by: "Mia" }]);
  };

  void (async () => {
    status("Game");
    setQueue(queue);
    await wait(600);
    for (let turn = 1; !stopped; turn++) {
      const line = LINES[(turn - 1) % LINES.length] as Line;
      await speak(`demo-${turn}`, line);
      // The Stage merges gifts; the demo just shows a plain and a merged line in turn.
      emit({ type: "gift", text: turn % 2 === 1 ? "Owen 餵了她一碗白飯" : "Owen 和另外 3 人餵了她 5 碗白飯" });
      await wait(2600);
      emit({ type: "gift", text: null });
      // A paid message every other round, a dedication on the others (they queue, one at a time).
      if (turn % 2 === 1) emit({ type: "screen", kind: "message", name: "Mia", text: "今天的直播也太棒了吧", song: null });
      else {
        emit({ type: "screen", kind: "dedication", name: "Owen", text: "給正在加班的你", song: "春日影" });
        emit({ type: "screen", kind: "message", name: "Kai", text: "晚安大家,明天見", song: null });
      }
      if (turn % 2 === 0 && !stopped) {
        await sing(turn / 2);
        await wait(2000);
      }
    }
  })();

  return () => {
    stopped = true;
    clearInterval(levels);
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };
}
