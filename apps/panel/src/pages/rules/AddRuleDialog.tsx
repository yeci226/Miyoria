import { useId, useState } from "react";
import type { DirectiveEffect } from "@/api/types";
import { useDirectiveMutations } from "@/app/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/lib/notify";
import { EFFECT_LABEL, EFFECTS } from "@/lib/rules";

/** How long a rule lasts, in minutes; `forever` is until someone revokes it. */
export const LASTS = [
  { value: "forever", label: "直到解除", minutes: null },
  { value: "30", label: "30 分鐘", minutes: 30 },
  { value: "60", label: "1 小時", minutes: 60 },
  { value: "360", label: "6 小時", minutes: 360 },
  { value: "1440", label: "24 小時", minutes: 1440 },
] as const;

/**
 * A new rule. The Core decides who may make which: a moderator has to give a time, and a rule that
 * forbids needs something to forbid. When it needs more, its question is shown here and nothing is
 * created.
 */
export function AddRuleDialog({ onClose }: { onClose: () => void }) {
  const { add } = useDirectiveMutations();
  const id = useId();
  const [text, setText] = useState("");
  const [effect, setEffect] = useState<DirectiveEffect>("deny");
  const [capability, setCapability] = useState("");
  const [activity, setActivity] = useState("");
  const [lasts, setLasts] = useState<string>("forever");
  const [question, setQuestion] = useState<string | null>(null);
  const t = text.trim();

  const save = () => {
    const scope = {
      ...(capability.trim() ? { capability: capability.trim() } : {}),
      ...(activity.trim() ? { activity: activity.trim() } : {}),
    };
    const minutes = LASTS.find((l) => l.value === lasts)?.minutes ?? null;
    setQuestion(null);
    add.mutate(
      { text: t, effect, scope, minutes },
      {
        onSuccess: (change) => {
          if (change.status === "question") {
            setQuestion(change.question);
            return;
          }
          notify.ok(change.status === "added" && change.note ? change.note : "已新增規則");
          onClose();
        },
        onError: (e) => notify.error(e, "新增失敗"),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !add.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增規則</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (t !== "") save();
          }}
        >
          <Field label="規則" htmlFor={`${id}-t`}>
            <Input id={`${id}-t`} value={text} onChange={(e) => setText(e.target.value)} placeholder="不要玩 Minecraft" autoFocus />
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="效果" htmlFor={`${id}-e`}>
              <Select value={effect} onValueChange={(v) => setEffect(v as DirectiveEffect)}>
                <SelectTrigger id={`${id}-e`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EFFECTS.map((e) => (
                    <SelectItem key={e} value={e}>
                      {EFFECT_LABEL[e]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="到期" htmlFor={`${id}-l`}>
              <Select value={lasts} onValueChange={setLasts}>
                <SelectTrigger id={`${id}-l`} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LASTS.map((l) => (
                    <SelectItem key={l.value} value={l.value}>
                      {l.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </div>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="動作" htmlFor={`${id}-c`}>
              <Input id={`${id}-c`} className="font-mono" value={capability} onChange={(e) => setCapability(e.target.value)} placeholder="game.*" spellCheck={false} />
            </Field>
            <Field label="活動" htmlFor={`${id}-a`}>
              <Input id={`${id}-a`} value={activity} onChange={(e) => setActivity(e.target.value)} placeholder="minecraft" spellCheck={false} />
            </Field>
          </div>
          {question && (
            <p role="alert" className="text-[13px] text-primary">
              {question}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={add.isPending}>
              取消
            </Button>
            <Button writes type="submit" busy={add.isPending} disabled={t === ""}>
              新增
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
