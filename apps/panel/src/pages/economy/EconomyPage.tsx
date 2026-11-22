import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { ECONOMY_TABS, type EconomyTab } from "@/app/nav";
import { Page, PageHeader } from "@/components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ExchangeTab } from "./ExchangeTab";
import { GiftsTab } from "./GiftsTab";
import { HealthTab } from "./HealthTab";
import { MarketTab } from "./MarketTab";
import { PredictionsTab, RoomTab } from "./OpenTabs";

const route = getRouteApi("/economy");

/** The coin economy as a whole (economy 2.0): health, predictions, her room, the weekly market. */
export function EconomyPage() {
  const tab = route.useSearch().tab ?? "health";
  const navigate = useNavigate();
  return (
    <Tabs
      value={tab}
      // The rest of the address (the server the page is about) stays when the tab changes.
      onValueChange={(t) => void navigate({ to: "/economy", search: (prev: Record<string, unknown>) => ({ ...prev, tab: t as EconomyTab }), replace: true })}
    >
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
        <TabsContent value="predictions">
          <PredictionsTab />
        </TabsContent>
        <TabsContent value="room">
          <RoomTab />
        </TabsContent>
        <TabsContent value="market">
          <MarketTab />
        </TabsContent>
        <TabsContent value="exchange">
          <ExchangeTab />
        </TabsContent>
        <TabsContent value="gifts">
          <GiftsTab />
        </TabsContent>
      </Page>
    </Tabs>
  );
}
