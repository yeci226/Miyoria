import { LogOut } from "lucide-react";
import { useConnection } from "@/app/connection";
import { useHealth } from "@/app/queries";
import { useSession } from "@/app/session";
import { Facts } from "@/components/json-view";
import { Page, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { notify } from "@/lib/notify";
import { TokenForm } from "@/pages/login/TokenGate";

export function SettingsPage() {
  const { config, signOut } = useConnection();
  const session = useSession();
  const user = session?.session.method === "discord" ? session.session.user : null;
  const health = useHealth();
  return (
    <Page>
      <PageHeader
        title="設定"
        actions={
          <Button variant="outline" size="sm" onClick={session?.logout ?? signOut}>
            <LogOut />
            登出
          </Button>
        }
      />
      <Card className="max-w-2xl">
        <CardHeader>
          <CardTitle>連線</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6">
          <Facts
            items={{
              "位址": <span className="font-mono text-[13px]">{config.baseUrl || window.location.origin}</span>,
              "身分": user ? (
                  <>
                    Discord · {user.name} <span className="font-mono text-xs text-muted-foreground">{user.id}</span>
                    {!session?.session.permissions.write && <span className="text-muted-foreground"> · 唯讀</span>}
                  </>
                ) : (
                  "Admin token"
                ),
              Core: <span className="font-mono text-[13px]">{health.data?.version ?? (health.isError ? "無回應" : "…")}</span>,
            }}
          />
          <TokenForm initial={config} submitLabel="驗證並儲存" onSaved={(v) => notify.ok(`已連線到 Core ${v}`)} />
        </CardContent>
      </Card>
    </Page>
  );
}
