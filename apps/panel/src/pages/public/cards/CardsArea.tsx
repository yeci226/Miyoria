// 卡冊 on the member page: the cards she gave them, the dex, the odds and the wishlist, as tabs in one
// block of the main column. The rail keeps the newest card and getting a new one (`CardSection`).
// A Core without the cards routes shows one line; the cards module stopped shows another.

import type { UseQueryResult } from "@tanstack/react-query";
import { useState } from "react";
import { isApiError } from "@/api/http";
import { EmptyLine, ErrorLine, SkeletonRows } from "@/components/query-state";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { readStorage, writeStorage } from "@/lib/storage";
import { WORLD } from "@/lib/world";
import { useWallet } from "../spend";
import { catalogOf, useCatalogue, useDex, useMyCards, useOdds, usePity, useWishlist } from "./data";
import { Dex } from "./Dex";
import { MyCards } from "./MyCards";
import { Odds } from "./Odds";
import { Wishlist } from "./Wishlist";

type Tab = "mine" | "dex" | "odds" | "wish";
const TABS: readonly Tab[] = ["mine", "dex", "odds", "wish"];
const TAB_KEY = "miyoria.member.cards-tab";

/** Loading, the error with a retry, or the data: the states every tab goes through. */
function Loaded<T>({ query, rows = 4, children }: { query: UseQueryResult<T>; rows?: number; children: (data: T) => React.ReactNode }) {
  if (query.isPending) return <SkeletonRows count={rows} />;
  if (query.isError) return <ErrorLine error={query.error} onRetry={() => void query.refetch()} />;
  return <>{children(query.data)}</>;
}

function DexTab() {
  const dex = useDex();
  const catalogue = useCatalogue();
  // The parts they do not have come from the catalogue; without it the dex still shows theirs.
  if (dex.isPending || (catalogue.isPending && !catalogue.isError)) return <SkeletonRows count={6} />;
  return <Loaded query={dex}>{(d) => <Dex dex={d} catalogue={catalogue.data} />}</Loaded>;
}

function OddsTab({ currency }: { currency: string }) {
  const odds = useOdds();
  const pity = usePity();
  return <Loaded query={odds}>{(o) => <Odds odds={o} pity={pity.data ?? null} currency={currency} />}</Loaded>;
}

function WishTab() {
  const wish = useWishlist();
  const dex = useDex();
  const catalogue = useCatalogue();
  if (wish.isPending || dex.isPending || (catalogue.isPending && !catalogue.isError)) return <SkeletonRows count={4} />;
  if (dex.isError) return <ErrorLine error={dex.error} onRetry={() => void dex.refetch()} />;
  const catalog = catalogOf(dex.data, catalogue.data);
  return <Loaded query={wish}>{(w) => <Wishlist saved={w} catalog={catalog} />}</Loaded>;
}

export function CardsArea() {
  const mine = useMyCards();
  const currency = useWallet().data?.currency ?? WORLD.currency;
  const [tab, setTab] = useState<Tab>(() => {
    const saved = readStorage(TAB_KEY);
    return TABS.includes(saved as Tab) ? (saved as Tab) : "mine";
  });
  const pick = (v: string) => {
    if (!TABS.includes(v as Tab)) return;
    setTab(v as Tab);
    writeStorage(TAB_KEY, v);
  };
  const off = mine.isError && isApiError(mine.error) ? mine.error.kind : null;
  const count = mine.data?.cards.length;
  return (
    <Card aria-label="卡冊">
      <CardHeader>
        <CardTitle>卡冊</CardTitle>
      </CardHeader>
      {off === "not_provided" ? (
        <EmptyLine>這個 Core 還沒有卡冊</EmptyLine>
      ) : off === "unavailable" ? (
        <EmptyLine>卡片現在沒有開</EmptyLine>
      ) : (
        <Tabs value={tab} onValueChange={pick} className="gap-4">
          <TabsList variant="inline" aria-label="卡冊">
            <TabsTrigger value="mine">
              我的卡
              {count !== undefined && <span className="font-mono text-xs text-muted-foreground tabular-nums">{count}</span>}
            </TabsTrigger>
            <TabsTrigger value="dex">圖鑑</TabsTrigger>
            <TabsTrigger value="odds">機率表</TabsTrigger>
            <TabsTrigger value="wish">願望單</TabsTrigger>
          </TabsList>
          <TabsContent value="mine">
            <Loaded query={mine} rows={3}>
              {(m) => <MyCards view={m} currency={currency} />}
            </Loaded>
          </TabsContent>
          <TabsContent value="dex">
            <DexTab />
          </TabsContent>
          <TabsContent value="odds">
            <OddsTab currency={currency} />
          </TabsContent>
          <TabsContent value="wish">
            <WishTab />
          </TabsContent>
        </Tabs>
      )}
    </Card>
  );
}
