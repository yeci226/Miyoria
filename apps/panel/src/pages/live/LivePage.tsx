import { useStage, useWorld } from "@/app/queries";
import { Page, PageHeader } from "@/components/page";
import { StatusBadge } from "@/components/status";
import { ChannelLevelsCard } from "./ChannelLevelsCard";
import { GameCard } from "./GameCard";
import { PartyCard } from "./PartyCard";
import { QueueCard } from "./QueueCard";
import { SayCard } from "./SayCard";
import { SceneRolesCard } from "./SceneRolesCard";
import { SongsCard } from "./SongsCard";
import { StageCard } from "./StageCard";
import { VoiceCard } from "./VoiceCard";

function LiveBadges() {
  const stage = useStage();
  const world = useWorld();
  const live = world.data?.her.golive === "live" || stage.data?.streaming;
  return (
    <>
      {live && (
        <StatusBadge tone="brand" pulse>
          直播中
        </StatusBadge>
      )}
      {stage.data?.speaking && (
        <StatusBadge tone="brand" pulse>
          說話中
        </StatusBadge>
      )}
    </>
  );
}

export function LivePage() {
  return (
    <Page
      rail={
        <>
          <VoiceCard />
          <SayCard />
          <GameCard />
          <ChannelLevelsCard />
        </>
      }
    >
      <PageHeader title="直播" actions={<LiveBadges />} />
      <StageCard />
      <SongsCard />
      <QueueCard />
      <PartyCard />
      <SceneRolesCard />
    </Page>
  );
}
