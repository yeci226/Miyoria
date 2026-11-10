import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { LIFE_TABS, type LifeTab } from "@/app/nav";
import { Page, PageHeader } from "@/components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ActivitiesTab } from "./ActivitiesTab";
import { RemindersTab } from "./RemindersTab";
import { SkillsTab } from "./SkillsTab";
import { TodayTab } from "./TodayTab";
import { WorkspaceTab } from "./WorkspaceTab";

const route = getRouteApi("/life");

/** What she does when nobody needs her: her day, her timers, what she can do, her skills and files. */
export function LifePage() {
  const tab = route.useSearch().tab ?? "today";
  const navigate = useNavigate();
  return (
    <Tabs value={tab} onValueChange={(t) => void navigate({ to: "/life", search: { tab: t as LifeTab }, replace: true })}>
      <TabsList>
        {LIFE_TABS.map((t) => (
          <TabsTrigger key={t.tab} value={t.tab}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <Page>
        <PageHeader title="生活" />
        <TabsContent value="today">
          <TodayTab />
        </TabsContent>
        <TabsContent value="reminders">
          <RemindersTab />
        </TabsContent>
        <TabsContent value="activities">
          <ActivitiesTab />
        </TabsContent>
        <TabsContent value="skills">
          <SkillsTab />
        </TabsContent>
        <TabsContent value="workspace">
          <WorkspaceTab />
        </TabsContent>
      </Page>
    </Tabs>
  );
}
