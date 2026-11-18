// The way from the member page to singing, shown while this Core has karaoke on. Apart from the
// page so the member page does not load it.

import { MicVocal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { KARAOKE_PAGE } from "./path";
import { useOverview } from "./queries";

export function KaraokeLink() {
  const overview = useOverview();
  if (!overview.data?.open) return null;
  return (
    <Button asChild variant="outline" size="sm">
      <a href={KARAOKE_PAGE}>
        <MicVocal aria-hidden />
        唱歌
      </a>
    </Button>
  );
}
