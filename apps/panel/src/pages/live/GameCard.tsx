import { Flag, Gamepad2, Square } from "lucide-react";
import { useId, useState } from "react";
import { useLiveControls, useVoice, useWorld } from "@/app/queries";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { ConfirmDialog } from "@/components/confirm";
import { Dot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { notify } from "@/lib/notify";

const DEFAULT_GAME = "minecraft";

/** Start and stop the game director, and give her a goal. Played where she is in voice. */
export function GameCard() {
  const world = useWorld();
  const voice = useVoice();
  const { gameStart, gameStop, gameGoal } = useLiveControls();
  const canWrite = useCanWrite();
  const id = useId();
  const [game, setGame] = useState(DEFAULT_GAME);
  const [goal, setGoal] = useState("");
  const [confirmStop, setConfirmStop] = useState(false);
  const playing = world.data?.her.game ?? null;
  const inVoice = (voice.data?.sessions.length ?? 0) > 0;
  const startHint = !canWrite ? READ_ONLY_HINT : !inVoice ? "她要先進語音頻道才能從面板開遊戲" : undefined;

  const start = (e: React.FormEvent) => {
    e.preventDefault();
    gameStart.mutate(
      { game: game.trim() || undefined, goal: goal.trim() || undefined },
      {
        onSuccess: () => {
          notify.ok(`她開始玩 ${game.trim() || DEFAULT_GAME}`);
          setGoal("");
        },
        onError: (err) => notify.error(err, "開始遊戲失敗"),
      },
    );
  };
  const setTarget = (e: React.FormEvent) => {
    e.preventDefault();
    const text = goal.trim();
    if (!text) return;
    gameGoal.mutate(text, {
      onSuccess: () => {
        notify.ok(`新目標:${text}`);
        setGoal("");
      },
      onError: (err) => notify.error(err, "設定目標失敗"),
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>遊戲</CardTitle>
        <span className="ml-auto flex items-center gap-2 text-[13px] text-muted-foreground">
          <Dot tone={playing ? "brand" : "neutral"} pulse={Boolean(playing)} />
          {playing ? `正在玩 ${playing}` : "沒有在玩"}
        </span>
      </CardHeader>
      <CardContent>
        {playing ? (
          <form onSubmit={setTarget} className="grid gap-3">
            <Label htmlFor={`${id}-goal`} className="text-[13px] font-normal text-muted-foreground">
              目標
            </Label>
            <div className="flex gap-2">
              <Input id={`${id}-goal`} value={goal} maxLength={200} onChange={(e) => setGoal(e.target.value)} placeholder="去挖鐵礦" disabled={!canWrite} className="h-8" />
              <Button writes type="submit" size="sm" variant="outline" busy={gameGoal.isPending} disabled={!goal.trim()}>
                <Flag />
                設定
              </Button>
            </div>
            <Button writes type="button" size="sm" variant="ghost" className="justify-self-start text-muted-foreground" onClick={() => setConfirmStop(true)}>
              <Square />
              停止遊戲
            </Button>
          </form>
        ) : (
          <form onSubmit={start} className="grid gap-3" title={startHint}>
            <div className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] gap-2">
              <Label htmlFor={`${id}-game`} className="sr-only">
                遊戲
              </Label>
              <Input id={`${id}-game`} value={game} maxLength={40} onChange={(e) => setGame(e.target.value)} disabled={!canWrite} className="h-8 font-mono text-[13px]" aria-label="遊戲 id" />
              <Input value={goal} maxLength={200} onChange={(e) => setGoal(e.target.value)} placeholder="第一個目標(可省略)" disabled={!canWrite} className="h-8" aria-label="第一個目標" />
            </div>
            <Button writes type="submit" size="sm" variant="secondary" busy={gameStart.isPending} disabled={!inVoice} className="justify-self-start">
              <Gamepad2 />
              開始玩
            </Button>
          </form>
        )}
      </CardContent>
      <ConfirmDialog
        open={confirmStop}
        title="停止遊戲?"
        confirmLabel="停止"
        busy={gameStop.isPending}
        onClose={() => setConfirmStop(false)}
        onConfirm={() =>
          gameStop.mutate(undefined, {
            onSuccess: () => {
              notify.ok("已停止遊戲");
              setConfirmStop(false);
            },
            onError: (e) => notify.error(e),
          })
        }
      >
        她會停止玩,遊戲導演也會停下來。
      </ConfirmDialog>
    </Card>
  );
}
