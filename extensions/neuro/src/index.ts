// Neuro Game SDK compatible bridge: a WebSocket server (loopback by default, off unless
// `serve = true`) that games integrating the Neuro Game SDK connect to. See README.md.

import { defineExtension } from "@miyoria/sdk";
import { NeuroAdapter } from "./adapter.js";
import { parseConfig } from "./config.js";
import { NeuroServer } from "./server.js";
import { Session } from "./session.js";
import { SpeechRelay } from "./speech.js";

export { GAME_ID, NeuroAdapter } from "./adapter.js";
export { isLoopback, type NeuroConfig, parseConfig } from "./config.js";
export * from "./protocol.js";
export { NeuroServer } from "./server.js";
export { Session } from "./session.js";

export default defineExtension({
  async activate(ctx) {
    const config = parseConfig(ctx.config);
    if (!config.serve) {
      ctx.log.info("Neuro Game SDK bridge is off (set serve = true to listen for games)");
      return;
    }
    let adapter: NeuroAdapter | undefined;
    const session = new Session({
      config,
      log: ctx.log,
      emit: (event) => adapter?.publish(event),
      goalsChanged: () => adapter?.goalsChanged(),
    });
    adapter = new NeuroAdapter({ session, ctx });
    await ctx.game.registerAdapter(adapter);
    adapter.markReady();

    const speech = new SpeechRelay((message) => session.link?.send(message));
    const off = ctx.events.on("voice.playback", (envelope) => {
      if (!session.connected || envelope.event.type !== "voice_playback") return;
      speech.playback(envelope.event.data.state);
    });

    const server = new NeuroServer(config, session, ctx.log);
    await server.start();
    ctx.onShutdown(async () => {
      off();
      speech.close();
      await server.close();
      session.close();
      adapter?.close();
    });
  },
});
