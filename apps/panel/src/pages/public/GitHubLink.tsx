// 連結 GitHub: a member links their own GitHub account, to be named on the issues their problem
// reports become. Optional, and only on a Core that has the GitHub App's user authorisation set.
// The link only reads who they are on GitHub; nothing is done as them there.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import type { GithubLinkView } from "@miyoria/contracts/api";
import { useApi } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/misc";
import { Switch } from "@/components/ui/switch";
import { notify } from "@/lib/notify";

export const GITHUB = ["member", "github"] as const;

/** What `?github=<outcome>` on the way back from GitHub means. */
export const LINK_OUTCOME: Record<string, { ok: boolean; text: string }> = {
  linked: { ok: true, text: "已連結 GitHub 帳號" },
  taken: { ok: false, text: "這個 GitHub 帳號已經連到另一個人了;要先從那邊解除連結" },
  state: { ok: false, text: "連結逾時或不是從這裡開始的,請再試一次" },
  cancelled: { ok: false, text: "你在 GitHub 上取消了連結" },
  exchange: { ok: false, text: "GitHub 沒有給出你的帳號,請再試一次" },
  unknown: { ok: false, text: "她還不認識你,先和她說說話再來連結" },
  off: { ok: false, text: "這裡現在不能連結 GitHub" },
};

/** The consent the member reads before linking and before turning the switch on. */
export const CONSENT =
  "打開「在我回報的問題上標記我」時,你透過她回報的問題變成 GitHub 上的 issue 後,最後一行會寫上你的 GitHub 名稱(@帳號),任何人都看得到,你的 GitHub 帳號會和這些回報公開連在一起。關掉就不寫,其他回報照常匿名。";

function useGitHubLink() {
  const api = useApi();
  return useQuery({
    queryKey: GITHUB,
    queryFn: ({ signal }) => api.rpc.githubLink.status(undefined, { signal }),
  });
}

/** Says once what came back from GitHub, then takes `?github=` off the address. */
function useOutcome(): void {
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("github");
    if (outcome === null) return;
    const said = LINK_OUTCOME[outcome] ?? { ok: false, text: "連結沒有完成" };
    if (said.ok) notify.ok(said.text);
    else notify.error(new Error(said.text), said.text);
    url.searchParams.delete("github");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
  }, []);
}

function Linked({ link }: { link: NonNullable<GithubLinkView["linked"]> }) {
  const api = useApi();
  const client = useQueryClient();
  const id = useId();
  const [unlinking, setUnlinking] = useState(false);
  const refresh = (v: GithubLinkView) => client.setQueryData(GITHUB, v);
  const mention = useMutation({
    mutationFn: (on: boolean) => api.rpc.githubLink.mention({ body: { on } }),
    onSuccess: (v) => {
      refresh(v);
      notify.ok(v.linked?.mention ? "之後的回報會標記你" : "之後的回報不會標記你");
    },
    onError: (e) => notify.error(e),
  });
  const unlink = useMutation({
    mutationFn: () => api.rpc.githubLink.unlink(),
    onSuccess: (v) => {
      refresh(v);
      setUnlinking(false);
      notify.ok("已解除連結");
    },
    onError: (e) => notify.error(e),
  });
  return (
    <div className="grid gap-3 text-[13px]">
      <p>
        已連結 <span className="font-mono">@{link.login}</span>
      </p>
      <div className="flex items-start gap-2.5">
        <Switch
          id={`${id}-m`}
          checked={link.mention}
          disabled={mention.isPending}
          onCheckedChange={(on) => mention.mutate(on)}
          aria-describedby={`${id}-c`}
        />
        <div className="grid gap-1">
          <Label htmlFor={`${id}-m`}>在我回報的問題上標記我</Label>
          <p id={`${id}-c`} className="text-xs text-muted-foreground">
            {CONSENT}
          </p>
        </div>
      </div>
      <div>
        <Button variant="outline" size="sm" onClick={() => setUnlinking(true)}>
          解除連結
        </Button>
      </div>
      <ConfirmDialog
        open={unlinking}
        title="解除 GitHub 連結?"
        confirmLabel="解除連結"
        busy={unlink.isPending}
        onConfirm={() => unlink.mutate()}
        onClose={() => setUnlinking(false)}
      >
        之後的回報不會再標記你。已經開出去的 issue 上的名字不會改。
      </ConfirmDialog>
    </div>
  );
}

function Unlinked() {
  const api = useApi();
  const id = useId();
  const [mention, setMention] = useState(true);
  return (
    <div className="grid gap-3 text-[13px]">
      <p className="text-muted-foreground">
        連結之後,維護她的人能知道哪些問題是你回報的。只會讀你的 GitHub 帳號名稱和編號,不會用你的身分做任何事。
      </p>
      <div className="flex items-start gap-2.5">
        <Checkbox id={`${id}-m`} checked={mention} onCheckedChange={(v) => setMention(v === true)} aria-describedby={`${id}-c`} />
        <div className="grid gap-1">
          <Label htmlFor={`${id}-m`}>在我回報的問題上標記我</Label>
          <p id={`${id}-c`} className="text-xs text-muted-foreground">
            {CONSENT}
          </p>
        </div>
      </div>
      <div>
        <Button asChild variant="outline">
          <a href={api.githubLinkUrl(mention)}>連結 GitHub</a>
        </Button>
      </div>
    </div>
  );
}

/** The member page's card; nothing at all where linking is not set up. */
export function GitHubLinkCard() {
  const link = useGitHubLink();
  useOutcome();
  if (!link.data?.available) return null;
  return (
    <Card aria-label="GitHub">
      <CardHeader>
        <CardTitle>GitHub</CardTitle>
      </CardHeader>
      {link.data.linked ? <Linked link={link.data.linked} /> : <Unlinked />}
    </Card>
  );
}
