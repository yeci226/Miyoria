// Measuring the device's latency: a moment of quiet to hear the room, then eight beeps to clap or
// sing 「啦」 on. The median delay between each beep and the voice that answers it is the latency
// (docs/design/karaoke.md §6.3). Kept in this browser per microphone; a manual control moves it.

import { ArrowLeft, Play, RotateCcw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/misc";
import { cn } from "@/lib/utils";
import type { KaraokeEngine } from "./audio";
import { Fact, HeadphonesLine, PrivacyLine, Refusal } from "./bits";
import {
  BEEP_EVERY,
  BEEPS,
  clampLatency,
  detectOnsets,
  deviceKey,
  LATENCY_MAX,
  LATENCY_MIN,
  type Level,
  likelyBluetooth,
  loadLatency,
  type Measurement,
  measureLatency,
  noiseFloor,
  QUIET_S,
  type StoredLatency,
  saveLatency,
} from "./latency";
import { micError } from "./support";

type Phase = "intro" | "quiet" | "beeps" | "done" | "failed";

export function Calibration({
  engine,
  deviceKey: knownKey,
  estimate,
  next,
  onKey,
  onSaved,
  onContinue,
  onBack,
}: {
  engine: () => KaraokeEngine;
  /** The microphone's key, when it is already open. */
  deviceKey: string | null;
  /** The browser's guess, before anything is kept. */
  estimate: number;
  /** What 「繼續」 leads to: the song waiting, or nothing. */
  next: string | null;
  onKey: (key: string) => void;
  onSaved: (stored: StoredLatency) => void;
  onContinue: () => void;
  onBack: () => void;
}) {
  const [phase, setPhase] = useState<Phase>("intro");
  const [beat, setBeat] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [found, setFound] = useState<(Measurement & { floor: number }) | null>(null);
  const [key, setKey] = useState<string | null>(knownKey);
  const [stored, setStored] = useState<StoredLatency | null>(() => (knownKey ? loadLatency(knownKey) : null));
  const cleanup = useRef<(() => void) | null>(null);
  const sliderId = useId();

  useEffect(() => () => cleanup.current?.(), []);

  const keep = (value: StoredLatency) => {
    if (!key) return;
    saveLatency(key, value);
    setStored(value);
    onSaved(value);
  };

  const start = async () => {
    setError(null);
    setFound(null);
    let mic: { deviceId?: string; groupId?: string };
    const audio = engine();
    try {
      mic = await audio.openMic();
    } catch (e) {
      setError(micError(e));
      return;
    }
    const k = deviceKey(mic);
    setKey(k);
    setStored(loadLatency(k));
    onKey(k);

    const quietEnd = audio.now() + QUIET_S;
    const first = quietEnd + 0.4;
    const beeps = Array.from({ length: BEEPS }, (_, i) => first + i * BEEP_EVERY);
    const end = (beeps.at(-1) as number) + 0.9;
    const quiet: number[] = [];
    const levels: Level[] = [];
    const off = audio.onDetection((d) => {
      if (d.levelT < quietEnd) quiet.push(d.level);
      else levels.push({ t: d.levelT, rms: d.level });
    });
    audio.beeps(beeps);
    setPhase("quiet");
    setBeat(0);
    let timer = 0;
    const stop = () => {
      window.clearInterval(timer);
      off();
      cleanup.current = null;
    };
    cleanup.current = stop;
    timer = window.setInterval(() => {
      const now = audio.now();
      if (now < first - 0.05) return;
      setPhase("beeps");
      setBeat(beeps.filter((b) => b <= now).length);
      if (now < end) return;
      stop();
      const floor = noiseFloor(quiet);
      audio.setFloor(floor);
      const m = measureLatency(beeps, detectOnsets(levels, floor));
      if (m) {
        setFound({ ...m, floor });
        setPhase("done");
      } else {
        setPhase("failed");
      }
    }, 40);
  };

  const running = phase === "quiet" || phase === "beeps";
  const value = stored?.latency_ms ?? estimate;

  return (
    <Card aria-label="校正延遲" className="max-w-2xl gap-5">
      <CardHeader>
        <Button variant="ghost" size="icon-sm" aria-label="回去" onClick={onBack} disabled={running}>
          <ArrowLeft />
        </Button>
        <CardTitle>校正延遲</CardTitle>
      </CardHeader>

      <ol className="grid gap-1.5 text-sm">
        <li>1. 戴上耳機,保持安靜一秒。</li>
        <li>2. 接著會有 {BEEPS} 聲嗶,每一聲都跟著拍一下手,或唱一聲「啦」。</li>
      </ol>

      <div className="grid gap-3 rounded-md bg-well px-4 py-4">
        <div aria-hidden className="flex items-center gap-2">
          {Array.from({ length: BEEPS }, (_, i) => (
            <span
              key={i}
              className={cn(
                "size-3 rounded-full transition-colors duration-150",
                i < beat ? "bg-primary" : "bg-control",
              )}
            />
          ))}
        </div>
        <p role="status" aria-live="polite" className="text-[13px]">
          {phase === "intro" && "準備好就按開始"}
          {phase === "quiet" && "先安靜一下"}
          {phase === "beeps" && `${beat} / ${BEEPS}`}
          {phase === "done" && found && `量到 ${found.latency_ms} ms(${found.matched} / ${BEEPS} 聲有對到)`}
          {phase === "failed" && "沒有聽到夠多的拍手或「啦」,再試一次"}
        </p>
        {phase === "done" && found && likelyBluetooth(found.latency_ms) && (
          <Refusal>超過 250 ms,可能是藍牙耳機:換成有線耳機會準很多</Refusal>
        )}
        <div className="flex flex-wrap gap-2">
          {phase === "done" && found ? (
            <>
              <Button
                onClick={() => {
                  keep({
                    latency_ms: clampLatency(found.latency_ms),
                    measured: true,
                    floor: found.floor,
                    at: new Date().toISOString(),
                  });
                  onContinue();
                }}
              >
                {next ? `用這個結果,開始唱` : "用這個結果"}
              </Button>
              <Button variant="outline" onClick={() => void start()}>
                <RotateCcw aria-hidden />
                再量一次
              </Button>
            </>
          ) : (
            <Button onClick={() => void start()} disabled={running} busy={running}>
              {phase === "failed" ? <RotateCcw aria-hidden /> : <Play aria-hidden />}
              {phase === "failed" ? "再量一次" : "開始"}
            </Button>
          )}
          {next && phase !== "done" && (
            <Button variant="ghost" onClick={onContinue} disabled={running}>
              先不校正,直接唱
            </Button>
          )}
        </div>
        <Refusal>{error}</Refusal>
      </div>

      {key && (
        <div className="grid gap-3">
          <h3 className="text-[13px] font-medium">手動調整</h3>
          <dl className="flex flex-wrap gap-x-8 gap-y-3">
            <Fact label="這台裝置">{value} ms</Fact>
            <Fact label="狀態">{stored?.measured ? "校正過" : "估計值,節奏不計分"}</Fact>
          </dl>
          <div className="flex items-center gap-3">
            <label htmlFor={sliderId} className="sr-only">
              延遲(毫秒)
            </label>
            <Slider
              className="flex-1"
              aria-label="延遲(毫秒)"
              min={LATENCY_MIN}
              max={LATENCY_MAX}
              step={5}
              value={[value]}
              onValueChange={([v]) =>
                v !== undefined && setStored((s) => ({ ...(s ?? { measured: false, floor: null, at: "" }), latency_ms: v }))
              }
              onValueCommit={([v]) =>
                v !== undefined &&
                keep({
                  latency_ms: clampLatency(v),
                  measured: stored?.measured ?? false,
                  floor: stored?.floor ?? null,
                  at: new Date().toISOString(),
                })
              }
            />
            <Input
              id={sliderId}
              type="number"
              inputMode="numeric"
              min={LATENCY_MIN}
              max={LATENCY_MAX}
              step={5}
              className="w-24 tabular-nums"
              value={value}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                keep({
                  latency_ms: clampLatency(v),
                  measured: stored?.measured ?? false,
                  floor: stored?.floor ?? null,
                  at: new Date().toISOString(),
                });
              }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            唱出來的線總是落在音符後面,就調大;總是搶在前面,就調小。
          </p>
        </div>
      )}

      <div className="grid gap-1.5">
        <HeadphonesLine />
        <PrivacyLine />
      </div>
    </Card>
  );
}
