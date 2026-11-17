// Messages someone asked her not to remember ("不要記住這個", `agent.message.excluded`).
//
// The agent hides the message from her prompts and tells the bus. The facts module redacts the
// message's events (docs/design/v5-data.md §2.4): its chat line and her observations of it keep
// their envelopes and lose their content, so nothing that reads the log (consolidation, evidence,
// "just now", a person's profile) can get the text back. Memory takes out what is already derived
// from them (`MemoryEngine.excludeMessage`). No list of excluded messages is kept.

/** The key a chat message is filed under on the event log: `msg:<platform>:<message id>`. */
export function messageKey(platform: string, id: string): string {
  return `msg:${platform}:${id}`;
}
