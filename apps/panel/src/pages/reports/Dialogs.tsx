import { useId, useState } from "react";
import type { ReportDraftView } from "@miyoria/contracts/api";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { notify } from "@/lib/notify";
import { parseIssue } from "./labels";
import { useReportMutations } from "./queries";

function Frame({
  title,
  busy,
  submit,
  disabled,
  onClose,
  onSubmit,
  children,
}: {
  title: string;
  busy: boolean;
  submit: string;
  disabled?: boolean;
  onClose: () => void;
  onSubmit: () => void;
  children: React.ReactNode;
}) {
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!disabled) onSubmit();
          }}
        >
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              取消
            </Button>
            <Button writes type="submit" busy={busy} disabled={disabled}>
              {submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 核准: the title and the body GitHub gets, as the report would send them, editable. */
export function ApproveDialog({ draft, onClose }: { draft: ReportDraftView; onClose: () => void }) {
  const { approve } = useReportMutations();
  const id = useId();
  const [title, setTitle] = useState(draft.issue_title);
  const [body, setBody] = useState(draft.issue_body);
  const save = () =>
    approve.mutate(
      {
        id: draft.id,
        ...(title.trim() !== draft.issue_title ? { title: title.trim() } : {}),
        ...(body.trim() !== draft.issue_body.trim() ? { body } : {}),
      },
      {
        onSuccess: (done) => {
          notify.ok(done.issue ? `已開 #${done.issue.number}` : "已開 issue");
          onClose();
        },
        onError: (e) => notify.error(e, "開 issue 失敗"),
      },
    );
  return (
    <Frame title="核准並開 issue" submit="開 issue" busy={approve.isPending} disabled={title.trim() === ""} onClose={onClose} onSubmit={save}>
      <Field label="標題" htmlFor={`${id}-t`}>
        <Input id={`${id}-t`} value={title} maxLength={256} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="內容(Markdown,會公開)" htmlFor={`${id}-b`}>
        <Textarea id={`${id}-b`} className="max-h-[50vh] font-mono text-xs" value={body} maxLength={20_000} onChange={(e) => setBody(e.target.value)} />
      </Field>
    </Frame>
  );
}

/** 加到 #N: the report as a comment on an existing issue, editable. */
export function CommentDialog({ draft, onClose }: { draft: ReportDraftView; onClose: () => void }) {
  const { comment } = useReportMutations();
  const id = useId();
  const [issue, setIssue] = useState(draft.likely_duplicate ? String(draft.likely_duplicate.number) : "");
  const [body, setBody] = useState(draft.comment_body);
  const number = parseIssue(issue);
  const save = () => {
    if (number === null) return;
    comment.mutate(
      { id: draft.id, issue: number, ...(body.trim() !== draft.comment_body.trim() ? { body } : {}) },
      {
        onSuccess: () => {
          notify.ok(`已加到 #${number}`);
          onClose();
        },
        onError: (e) => notify.error(e, "留言失敗"),
      },
    );
  };
  return (
    <Frame title="改成加到已有的 issue" submit="留言" busy={comment.isPending} disabled={number === null} onClose={onClose} onSubmit={save}>
      <Field label="Issue 編號" htmlFor={`${id}-n`} error={issue !== "" && number === null ? "要是 issue 的編號" : undefined}>
        <Input id={`${id}-n`} className="w-32 font-mono" inputMode="numeric" value={issue} placeholder="#12" onChange={(e) => setIssue(e.target.value)} />
      </Field>
      <Field label="留言(Markdown,會公開)" htmlFor={`${id}-b`}>
        <Textarea id={`${id}-b`} className="max-h-[50vh] font-mono text-xs" value={body} maxLength={20_000} onChange={(e) => setBody(e.target.value)} />
      </Field>
    </Frame>
  );
}

/** 標成重複: nothing is written on GitHub. */
export function DuplicateDialog({ draft, onClose }: { draft: ReportDraftView; onClose: () => void }) {
  const { duplicate } = useReportMutations();
  const id = useId();
  const [issue, setIssue] = useState(draft.likely_duplicate ? String(draft.likely_duplicate.number) : "");
  const number = parseIssue(issue);
  const save = () => {
    if (number === null) return;
    duplicate.mutate(
      { id: draft.id, issue: number },
      {
        onSuccess: () => {
          notify.ok(`已標成 #${number} 的重複`);
          onClose();
        },
        onError: (e) => notify.error(e, "標記失敗"),
      },
    );
  };
  return (
    <Frame title="標成重複" submit="標成重複" busy={duplicate.isPending} disabled={number === null} onClose={onClose} onSubmit={save}>
      <Field label="重複的 issue 編號" htmlFor={`${id}-n`} error={issue !== "" && number === null ? "要是 issue 的編號" : undefined}>
        <Input id={`${id}-n`} className="w-32 font-mono" inputMode="numeric" value={issue} placeholder="#12" onChange={(e) => setIssue(e.target.value)} />
      </Field>
      <p className="text-[13px] text-muted-foreground">GitHub 上不會留下任何東西;那個 issue 關掉時一樣會通知回報的人。</p>
    </Frame>
  );
}

export function RejectDialog({ draft, onClose }: { draft: ReportDraftView; onClose: () => void }) {
  const { reject } = useReportMutations();
  const id = useId();
  const [reason, setReason] = useState("");
  const save = () =>
    reject.mutate(
      { id: draft.id, reason: reason.trim() },
      {
        onSuccess: () => {
          notify.ok("已拒絕");
          onClose();
        },
        onError: (e) => notify.error(e, "拒絕失敗"),
      },
    );
  return (
    <Frame title={`拒絕「${draft.title}」`} submit="拒絕" busy={reject.isPending} disabled={reason.trim() === ""} onClose={onClose} onSubmit={save}>
      <Field label="原因(只留在這裡)" htmlFor={`${id}-r`}>
        <Textarea id={`${id}-r`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Frame>
  );
}
