import { getRouteApi, useNavigate } from "@tanstack/react-router";
import { CHARACTER_TABS, type CharacterTab } from "@/app/nav";
import { Page, PageHeader } from "@/components/page";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MemoryTab } from "./MemoryTab";
import { NotebookTab } from "./NotebookTab";
import { PeopleTab } from "./PeopleTab";
import { PersonaTab } from "./PersonaTab";
import { PersonSheet } from "./PersonSheet";
import { RecentTab } from "./RecentTab";

const route = getRouteApi("/character");

export function CharacterPage() {
  const { tab = "persona", person } = route.useSearch();
  const navigate = useNavigate();
  return (
    <Tabs value={tab} onValueChange={(t) => void navigate({ to: "/character", search: { tab: t as CharacterTab }, replace: true })}>
      <TabsList>
        {CHARACTER_TABS.map((t) => (
          <TabsTrigger key={t.tab} value={t.tab}>
            {t.label}
          </TabsTrigger>
        ))}
      </TabsList>
      <Page>
        <PageHeader title="角色" />
        <TabsContent value="persona">
          <PersonaTab />
        </TabsContent>
        <TabsContent value="memory">
          <MemoryTab />
        </TabsContent>
        <TabsContent value="notebook">
          <NotebookTab />
        </TabsContent>
        <TabsContent value="recent">
          <RecentTab />
        </TabsContent>
        <TabsContent value="people">
          <PeopleTab onOpen={(id) => void navigate({ to: "/character", search: { tab: "people", person: id } })} />
        </TabsContent>
        <PersonSheet
          personId={person}
          onClose={() => void navigate({ to: "/character", search: { tab } })}
        />
      </Page>
    </Tabs>
  );
}
