import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ECONOMY_TABS, type EconomyTab } from "@/app/nav";
import { Page, PageHeader } from "@/components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HealthTab } from "./HealthTab";
import { CommissionsTab, PredictionsTab, RoomTab } from "./OpenTabs";

const route = getRouteApi("/economy");

/** The coin economy as a whole (economy 2.0): health, commissions, predictions, her room. */
export function EconomyPage() {
  const tab = route.useSearch().tab ?? "health";
  const navigate = useNavigate();
  return (
    <Tabs value={tab} onValueChange={(t) => void navigate({ to: "/economy", search: { tab: t as EconomyTab }, replace: true })}>
      <TabsList>
        {ECONOMY_TABS.map((t) => (
          <TabsTrigger key={t.tab} value={t.tab}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <Page>
        <PageHeader title="經濟" />
        <TabsContent value="health">
          <HealthTab />
        </TabsContent>
        <TabsContent value="commissions">
          <CommissionsTab />
        </TabsContent>
        <TabsContent value="predictions">
          <PredictionsTab />
        </TabsContent>
        <TabsContent value="room">
          <RoomTab />
        </TabsContent>
      </Page>
    </Tabs>
  );
}
