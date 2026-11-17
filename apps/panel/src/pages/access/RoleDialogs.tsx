import { useId, useState } from "react";
import type { RoleDefinition } from "@miyoria/contracts/api";
import { useAccessMutations } from "@/app/queries";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Field } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/lib/notify";

/** Permission nodes typed one per line (commas and spaces also split). */
export const parseNodes = (raw: string): string[] => [...new Set(raw.split(/[\s,,]+/).map((s) => s.trim()).filter(Boolean))];

export function RoleDialog({ role, taken, onClose }: { role: RoleDefinition | null; taken: string[]; onClose: () => void }) {
  const { upsertRole } = useAccessMutations();
  const id = useId();
  const [name, setName] = useState(role?.name ?? "");
  const [rank, setRank] = useState(String(role?.rank ?? 10));
  const [grants, setGrants] = useState((role?.grants ?? []).join("\n"));
  const [denies, setDenies] = useState((role?.denies ?? []).join("\n"));
  const n = name.trim();
  const rankNum = Number(rank);
  const nameError = !role && n && taken.includes(n) ? "已經有這個角色" : undefined;
  const valid = n !== "" && !nameError && Number.isInteger(rankNum);

  const save = () =>
    upsertRole.mutate(
      { name: n, req: { rank: rankNum, grants: parseNodes(grants), denies: parseNodes(denies) } },
      {
        onSuccess: () => {
          notify.ok(role ? `已更新 ${n}` : `已新增 ${n}`);
          onClose();
        },
        onError: (e) => notify.error(e, "儲存失敗"),
      },
    );

  return (
    <Dialog open onOpenChange={(o) => !o && !upsertRole.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{role ? `編輯「${role.name}」` : "新增角色"}</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) save();
          }}
        >
          <div className="grid gap-5 sm:grid-cols-[minmax(0,1fr)_7rem]">
            <Field label="名稱" htmlFor={`${id}-n`} error={nameError}>
              <Input
                id={`${id}-n`}
                className="font-mono"
                value={name}
                disabled={role !== null}
                onChange={(e) => setName(e.target.value)}
                aria-invalid={nameError ? true : undefined}
                placeholder="moderator"
              />
            </Field>
            <Field label="等級" htmlFor={`${id}-k`}>
              <Input id={`${id}-k`} type="number" step={1} value={rank} onChange={(e) => setRank(e.target.value)} />
            </Field>
          </div>
          <Field label="允許" htmlFor={`${id}-g`}>
            <Textarea
              id={`${id}-g`}
              rows={4}
              className="font-mono text-[13px]"
              placeholder={"persona.edit\nstream.*"}
              value={grants}
              onChange={(e) => setGrants(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <Field label="拒絕" htmlFor={`${id}-d`}>
            <Textarea
              id={`${id}-d`}
              rows={2}
              className="font-mono text-[13px]"
              value={denies}
              onChange={(e) => setDenies(e.target.value)}
              spellCheck={false}
            />
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={upsertRole.isPending}>
              取消
            </Button>
            <Button writes type="submit" busy={upsertRole.isPending} disabled={!valid}>
              儲存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function MappingDialog({
  platform,
  guild,
  roles,
  onClose,
}: {
  platform: string;
  guild: string;
  roles: string[];
  onClose: () => void;
}) {
  const { setMapping } = useAccessMutations();
  const id = useId();
  const [platformRole, setPlatformRole] = useState("");
  const [role, setRole] = useState(roles[0] ?? "");
  const pr = platformRole.trim();
  const save = () =>
    setMapping.mutate(
      { platform, guild, platform_role: pr, role },
      {
        onSuccess: () => {
          notify.ok("已新增對應");
          onClose();
        },
        onError: (e) => notify.error(e, "新增失敗"),
      },
    );
  return (
    <Dialog open onOpenChange={(o) => !o && !setMapping.isPending && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新增身分組對應</DialogTitle>
        </DialogHeader>
        <form
          className="grid gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (pr && role) save();
          }}
        >
          <p className="font-mono text-xs text-muted-foreground">
            {platform} · {guild}
          </p>
          <Field label="平台身分組 id" htmlFor={`${id}-pr`}>
            <Input id={`${id}-pr`} className="font-mono" inputMode="numeric" value={platformRole} onChange={(e) => setPlatformRole(e.target.value)} />
          </Field>
          <Field label="角色" htmlFor={`${id}-r`}>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger id={`${id}-r`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={setMapping.isPending}>
              取消
            </Button>
            <Button writes type="submit" busy={setMapping.isPending} disabled={!pr || !role}>
              新增
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
