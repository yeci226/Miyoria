import { Check, Copy } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { ClusterHostView, ClusterInvite } from "@miyoria/contracts/api";
import { useClusterHostInfo, useClusterMutations } from "@/app/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, Label } from "@/components/ui/label";
import { Checkbox, Skeleton } from "@/components/ui/misc";
import { Segmented } from "@/components/ui/segmented";
import { notify } from "@/lib/notify";
import { fmtCountdown, parseCapabilities, reportedCapabilities } from "./labels";

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      size="icon-sm"
      variant="ghost"
      aria-label={copied ? "已複製" : label}
      onClick={() =>
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        })
      }
    >
      {copied ? <Check /> : <Copy />}
    </Button>
  );
}

// --- approve ---------------------------------------------------------------------

/**
 * 核可 (and editing an approved host's list). A connected host says what its services provide:
 * those are the choices. Otherwise the owner types the names.
 */
export function ApproveDialog({ host, onClose }: { host: ClusterHostView; onClose: () => void }) {
  const { approve } = useClusterMutations();
  const id = useId();
  const info = useClusterHostInfo(host.name, host.connected);
  const reported = info.data ? reportedCapabilities(info.data.services) : [];
  // What the host reports, then whatever is approved already and not reported now: dropping a
  // capability must be a click, never a side effect of the host being off.
  const options = [...new Set([...reported, ...host.capabilities])];
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [typed, setTyped] = useState("");
  const loading = host.connected && info.isLoading;
  const checked = picked ?? new Set(host.status === "pending" ? options : host.capabilities);
  const capabilities = [...options.filter((o) => checked.has(o)), ...parseCapabilities(typed).filter((c) => !options.includes(c))];
  const tooLong = capabilities.some((c) => c.length > 64);

  const toggle = (c: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(c);
    else next.delete(c);
    setPicked(next);
  };

  const save = () =>
    approve.mutate(
      { name: host.name, capabilities },
      {
        onSuccess: () => {
          notify.ok(host.status === "pending" ? `已核可 ${host.name}` : `已更新 ${host.name}`);
          onClose();
        },
        onError: (e) => notify.error(e, "核可失敗"),
      },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && !approve.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{host.status === "pending" ? `核可「${host.name}」` : `「${host.name}」可以做什麼`}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!loading && !tooLong) save();
          }}
        >
          {loading ? (
            <div className="grid gap-2" aria-busy="true" aria-label="載入中">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-4 w-1/2" />
            </div>
          ) : (
            <>
              {options.length > 0 ? (
                <fieldset className="grid gap-2.5">
                  <legend className="mb-1 text-[13px] font-medium">
                    {reported.length > 0 ? "這台電腦提供的能力" : "已核可的能力"}
                  </legend>
                  {options.map((c) => (
                    <div key={c} className="flex items-center gap-2.5">
                      <Checkbox id={`${id}-${c}`} checked={checked.has(c)} onCheckedChange={(v) => toggle(c, v === true)} />
                      <Label htmlFor={`${id}-${c}`} className="font-mono text-[13px] font-normal">
                        {c}
                      </Label>
                      {!reported.includes(c) && host.connected && <span className="text-xs text-muted-foreground">目前沒有服務提供</span>}
                    </div>
                  ))}
                </fieldset>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  {host.connected ? "這台電腦沒有回報任何能力。" : "這台電腦離線,沒有回報任何能力。"}
                </p>
              )}
              <Field label={options.length > 0 ? "其他能力" : "能力名稱"} htmlFor={`${id}-t`}>
                <Input
                  id={`${id}-t`}
                  className="font-mono"
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder="asr tts"
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby={`${id}-hint`}
                />
                <p id={`${id}-hint`} className="text-xs text-muted-foreground">
                  用空格或逗號分隔。
                </p>
              </Field>
              {info.isError && host.connected && <p className="text-[13px] text-muted-foreground">讀不到它回報的內容,可以直接輸入名稱。</p>}
              {capabilities.length === 0 && <p className="text-[13px] text-muted-foreground">沒有選任何能力:Core 不會把工作交給它。</p>}
            </>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={approve.isPending}>
              取消
            </Button>
            <Button writes type="submit" busy={approve.isPending} disabled={loading || tooLong}>
              {host.status === "pending" ? "核可" : "儲存"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// --- invite ----------------------------------------------------------------------

const VALIDITY = [
  { value: "600", label: "10 分鐘" },
  { value: "3600", label: "1 小時" },
  { value: "21600", label: "6 小時" },
  { value: "86400", label: "1 天" },
];

/** The shell word for a name: quoted when it holds anything a shell would split on. */
const shellWord = (s: string) => (/^[\w.@-]+$/.test(s) ? s : `"${s.replace(/(["\\$`])/g, "\\$1")}"`);

export function joinCommand(origin: string, code: string, name?: string): string {
  return `miyoria host join ${origin} --code ${code}${name ? ` --name ${shellWord(name)}` : ""}`;
}

function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function InviteResult({ invite, name, onClose }: { invite: ClusterInvite; name?: string; onClose: () => void }) {
  const now = useNow(1000);
  const left = new Date(invite.expires_at).getTime() - now;
  const command = joinCommand(window.location.origin, invite.code, name);
  return (
    <div className="grid gap-5">
      <div className="grid gap-1.5">
        <span className="text-[13px] font-medium">邀請代碼</span>
        <div className="flex items-center gap-1 rounded-md bg-well px-3 py-2.5">
          <code data-testid="invite-code" className="min-w-0 flex-1 select-all break-all font-mono text-2xl tracking-[0.12em]">
            {invite.code}
          </code>
          <CopyButton text={invite.code} label="複製代碼" />
        </div>
        <p className={left > 0 ? "text-xs text-muted-foreground" : "text-xs text-primary"} role="timer" aria-live="off">
          {left > 0 ? `還有 ${fmtCountdown(left)} 失效` : "代碼已失效"}
        </p>
      </div>
      <div className="grid gap-1.5">
        <span className="text-[13px] font-medium">在另一台電腦執行</span>
        <div className="flex items-start gap-1 rounded-md bg-well py-2 pr-1.5 pl-3">
          <code data-testid="invite-command" className="min-w-0 flex-1 select-all break-all font-mono text-[13px] leading-relaxed">
            {command}
          </code>
          <CopyButton text={command} label="複製指令" />
        </div>
      </div>
      <div className="grid gap-1 text-xs text-muted-foreground">
        <p>代碼只會顯示這一次,關掉這個視窗就看不到了。</p>
        <p>
          Core 所在的這台電腦不用邀請,執行 <code className="font-mono">miyoria host join --local</code>
        </p>
      </div>
      <DialogFooter>
        <Button onClick={onClose}>完成</Button>
      </DialogFooter>
    </div>
  );
}

export function InviteDialog({ onClose }: { onClose: () => void }) {
  const { invite } = useClusterMutations();
  const id = useId();
  const [name, setName] = useState("");
  const [ttl, setTtl] = useState("600");
  const n = name.trim();

  const create = () =>
    invite.mutate(
      { name: n || undefined, ttl_s: Number(ttl) },
      { onError: (e) => notify.error(e, "產生代碼失敗") },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && !invite.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>邀請電腦</DialogTitle>
        </DialogHeader>
        {invite.data ? (
          <InviteResult invite={invite.data} name={n || undefined} onClose={onClose} />
        ) : (
          <form
            className="grid gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <Field label="名稱(選填)" htmlFor={`${id}-n`}>
              <Input
                id={`${id}-n`}
                value={name}
                maxLength={64}
                onChange={(e) => setName(e.target.value)}
                placeholder="例如 studio-pc"
                autoComplete="off"
              />
            </Field>
            <div className="grid gap-2">
              <span className="text-[13px] font-medium">有效時間</span>
              <Segmented value={ttl} onChange={setTtl} options={VALIDITY} label="有效時間" size="md" className="w-fit" />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose} disabled={invite.isPending}>
                取消
              </Button>
              <Button writes type="submit" busy={invite.isPending}>
                產生代碼
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
