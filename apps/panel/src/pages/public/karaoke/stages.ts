// The song worker's stages while it prepares a karaoke song, as short words.

const STAGE_WORDS: Readonly<Record<string, string>> = {
  queued: "排隊中",
  resolve: "下載中",
  download: "下載中",
  separate: "分離人聲",
  lead: "分出主唱",
  reference: "抓旋律",
  encode: "做伴唱帶",
  lyrics: "找歌詞",
  fetch: "拿歌中",
};

/** The word for a stage; any other stage (or none) is 準備中. */
export function stageWord(stage: string | null | undefined): string {
  return (stage ? STAGE_WORDS[stage] : undefined) ?? "準備中";
}
