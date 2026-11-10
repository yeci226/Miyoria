import { useMemo } from "react";
import type { Envelope, VoiceUtterance } from "@/api/types";
import { useEvents } from "@/app/events-store";
import { EmptyLine } from "@/components/query-state";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { fmtTime } from "@/lib/format";

interface Line {
  env: Envelope;
  utterance?: VoiceUtterance;
  /** Her own line (playback started). */
  self?: string;
}

/** Voice utterances and her playback, from the shared event stream (newest first). */
export function transcriptOf(events: Envelope[], max = 200): Line[] {
  const out: Line[] = [];
  for (const env of events) {
    const e = env.event;
    if (e.type === "voice_utterance") out.push({ env, utterance: e.data });
    else if (e.type === "voice_playback" && e.data.state === "started") out.push({ env, self: e.data.text });
    if (out.length >= max) break;
  }
  return out;
}

export function TranscriptTab() {
  const { events } = useEvents();
  const lines = useMemo(() => transcriptOf(events), [events]);
  return (
    <Card>
      {lines.length === 0 ? (
        <EmptyLine>還沒有語音轉錄</EmptyLine>
      ) : (
        <ul
          className="max-h-[calc(100dvh-14rem)] divide-y divide-line-soft overflow-y-auto"
          aria-label="即時轉錄"
          aria-live="polite"
          aria-relevant="additions"
        >
          {lines.map(({ env, utterance: u, self }) => (
            <li key={env.id} className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-3 py-2.5">
              <time dateTime={env.ts} className="pt-0.5 font-mono text-xs text-muted-foreground tabular-nums">
                {fmtTime(env.ts)}
              </time>
              <div className="grid min-w-0 gap-1">
                <p className="flex flex-wrap items-center gap-2 text-[13px]">
                  {u ? (
                    <span className="font-medium">{u.speaker.display_name}</span>
                  ) : (
                    <span className="font-medium text-primary">她</span>
                  )}
                  {u?.emotion && <Badge variant="outline">{u.emotion}</Badge>}
                  {u && <span className="font-mono text-xs text-muted-foreground">ASR {u.asr_ms} ms</span>}
                </p>
                <p className="break-words text-sm leading-relaxed">{u ? u.text : self}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
