import { RefreshCw } from "lucide-react";
import { useId } from "react";
import type { SceneRoleState, SceneRolesState } from "@miyoria/contracts/api";
import { useSceneRoleMutations, useSceneRoles } from "@/app/queries";
import { READ_ONLY_HINT, useCanWrite } from "@/app/session";
import { QueryView, SkeletonRows } from "@/components/query-state";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { notify } from "@/lib/notify";

/** Select value meaning "no override: use the automatic classification". */
const AUTO = "__auto__";

const BY: Record<NonNullable<SceneRolesState["classified_by"]>, string> = {
  llm: "AI 判斷",
  heuristic: "關鍵字判斷",
};

function RoleRow({ r, scenes, disabled }: { r: SceneRoleState; scenes: string[]; disabled: boolean }) {
  const m = useSceneRoleMutations();
  const id = useId();
  const canWrite = useCanWrite();
  const value = r.source === "panel" && r.scene ? r.scene : AUTO;
  const autoLabel = r.auto ? `自動(${r.auto})` : "自動(沒有)";
  const title = !canWrite ? READ_ONLY_HINT : r.locked ? "在設定檔指定,這裡不能改" : undefined;
  return (
    <div className="flex min-h-9 flex-wrap items-center justify-between gap-x-6 gap-y-2">
      <Label htmlFor={id} className="font-normal text-muted-foreground">
        {r.label ?? r.role}
        <span className="ml-2 text-xs text-muted-foreground/70">{r.role}</span>
      </Label>
      {r.locked ? (
        <span title={title} className="text-sm text-foreground/90">
          {r.scene ?? "—"}
          <span className="ml-2 text-xs text-muted-foreground">設定檔</span>
        </span>
      ) : (
        <Select
          value={value}
          disabled={disabled || m.set.isPending}
          onValueChange={(next) =>
            m.set.mutate(
              { role: r.role, scene: next === AUTO ? null : next },
              { onError: (e) => notify.error(e, "設定場景失敗") },
            )
          }
        >
          <SelectTrigger id={id} className="w-56" title={title}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO}>{autoLabel}</SelectItem>
            {scenes.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
    </div>
  );
}

function RolesBody({ s }: { s: SceneRolesState }) {
  const canWrite = useCanWrite();
  const disabled = !canWrite || s.scenes.length === 0;
  return (
    <CardContent className="grid gap-3">
      {s.roles.map((r) => (
        <RoleRow key={r.role} r={r} scenes={s.scenes} disabled={disabled} />
      ))}
      <p className="text-xs text-muted-foreground">
        開台、玩遊戲、暫離和下播時,導演會切到對應的場景(帶設定的轉場)。
        {s.scenes.length === 0 ? "OBS 還沒回報場景。" : ""}
      </p>
    </CardContent>
  );
}

export function SceneRolesCard() {
  const roles = useSceneRoles();
  const m = useSceneRoleMutations();
  const canWrite = useCanWrite();
  const s = roles.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>場景用途</CardTitle>
        {s && (
          <CardAction>
            {s.classified_by && <StatusBadge tone="neutral">{BY[s.classified_by]}</StatusBadge>}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="重新判斷場景用途"
              title={!canWrite ? READ_ONLY_HINT : "重新判斷場景用途"}
              disabled={!canWrite || s.scenes.length === 0 || s.classifying || m.classify.isPending}
              onClick={() =>
                m.classify.mutate(undefined, {
                  onSuccess: () => notify.ok("已重新判斷場景用途"),
                  onError: (e) => notify.error(e, "判斷失敗"),
                })
              }
            >
              <RefreshCw className={m.classify.isPending || s.classifying ? "animate-spin" : undefined} />
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <QueryView query={roles} skeleton={<SkeletonRows count={5} />}>
        {(data) => <RolesBody s={data} />}
      </QueryView>
    </Card>
  );
}
