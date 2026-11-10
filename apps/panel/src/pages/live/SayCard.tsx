import { MessageSquareText } from "lucide-react";
import { useId, useState } from "react";
import { useStage, useStageMutations, useVoice } from "@/app/queries";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { notify } from "@/lib/notify";

export const MAX_SAY = 500;

const EMOTION_LABEL: Record<string, string> = {
  neutral: "平常",
  happy: "開心",
  smug: "得意",
  annoyed: "不耐煩",
  angry: "生氣",
  embarrassed: "害羞",
  sad: "難過",
  surprised: "驚訝",
  thinking: "思考",
};

export const emotionLabel = (e: string) => EMOTION_LABEL[e] ?? e;

export const NOT_IN_VOICE = "她不在語音頻道";

/** Speaks a line through TTS in the voice channel she is in, without the LLM. */
export function SayCard() {
  const voice = useVoice();
  const stage = useStage();
  const { say } = useStageMutations();
  const canWrite = useCanWrite();
  const id = useId();
  const [text, setText] = useState("");
  const [emotion, setEmotion] = useState("neutral");

  const inVoice = (voice.data?.sessions.length ?? 0) > 0;
  const emotions = stage.data?.emotions.length ? stage.data.emotions : ["neutral"];
  const reason = !canWrite ? READ_ONLY_HINT : voice.isPending ? null : !inVoice ? NOT_IN_VOICE : null;
  const blocked = !canWrite || !inVoice;
  const length = [...text.trim()].length;

  const submit = (e: { preventDefault: () => void }) => {
    e.preventDefault();
    const line = text.trim();
    if (!line || blocked) return;
    say.mutate(
      { text: line, emotion: emotion === "neutral" ? undefined : emotion },
      {
        onSuccess: () => {
          notify.ok("她開口了");
          setText("");
        },
        onError: (err) => notify.error(err, "說不出來"),
      },
    );
  };

  const form = (
    <form className="grid gap-3" onSubmit={submit}>
      <Label htmlFor={`${id}-text`} className="sr-only">
        台詞
      </Label>
      <Textarea
        id={`${id}-text`}
        rows={3}
        maxLength={MAX_SAY}
        value={text}
        disabled={blocked}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) submit(e);
        }}
        placeholder="哼,才不是特地為你唱的。"
        className="min-h-20 resize-none"
      />
      <div className="flex items-center gap-2">
        <Select value={emotion} onValueChange={setEmotion} disabled={blocked}>
          <SelectTrigger aria-label="情緒" className="w-32" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {emotions.map((e) => (
              <SelectItem key={e} value={e}>
                {emotionLabel(e)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {length > MAX_SAY * 0.8 && (
          <span className="font-mono text-xs text-muted-foreground tabular-nums">
            {length}/{MAX_SAY}
          </span>
        )}
        <Button type="submit" size="sm" className="ml-auto" disabled={blocked || !text.trim()} busy={say.isPending}>
          <MessageSquareText />
          說出來
        </Button>
      </div>
    </form>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>讓她說</CardTitle>
      </CardHeader>
      <CardContent>
        {reason ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <div tabIndex={0} aria-label={reason} className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {form}
              </div>
            </TooltipTrigger>
            <TooltipContent>{reason}</TooltipContent>
          </Tooltip>
        ) : (
          form
        )}
      </CardContent>
    </Card>
  );
}
