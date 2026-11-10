import { Link } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { Button } from "@/components/ui/button";

export function NotFoundPage() {
  return (
    <Page className="items-center py-24 text-center">
      <h1 className="text-[15px] font-semibold">沒有這個頁面</h1>
      <Button asChild variant="outline">
        <Link to="/">回到總覽</Link>
      </Button>
    </Page>
  );
}
