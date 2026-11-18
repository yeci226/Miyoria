// Module `voice.link`: serves the Voice Link WebSocket endpoint and provides `VoiceLink`.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  defineManifest,
  errorMessage,
  type Module,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { Events, is, type PlayChunk, type VoicePlayer, VoicePlayerKey } from "@miyoria/types";
import { WebSocketServer } from "ws";
import { aborted } from "../util.js";
import { VoiceLinkError } from "./conn.js";
import { DEFAULT_BIND, VoiceLink, VoiceLinkConfigSchema, VoiceLinkKey } from "./link.js";
import type { LeveledChunk } from "./playback.js";

/** `VoicePlayer` (songs and other sounds that are not her speech) over the link. */
export function voicePlayer(link: VoiceLink): VoicePlayer {
  return {
    channel: (guild) => link.channel(guild),
    play: (guild, sampleRate, audio, options = {}) => {
      async function* chunks(): AsyncGenerator<LeveledChunk> {
        for await (const c of audio as AsyncIterable<PlayChunk>) {
          yield c.levels
            ? { sampleRate, samples: c.samples, levels: c.levels }
            : { sampleRate, samples: c.samples };
        }
      }
      return link.play(guild, sampleRate, chunks(), options);
    },
  };
}

/** WebSocket path of the endpoint. */
export const VOICE_LINK_PATH = "/voice-link";
const MAX_MESSAGE = 1 << 20;

const EMPTY_TOKEN =
  '`[modules."voice.link"] token` is empty: set the VOICE_LINK_TOKEN environment variable ' +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: TOML interpolation syntax, not a template
  '(with `token = "${VOICE_LINK_TOKEN}"`)';

/** `host:port` / `[v6]:port`. */
function parseBind(bind: string): { host: string; port: number } | null {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d{1,5})$/.exec(bind.trim());
  if (!m) return null;
  const port = Number(m[3]);
  if (port > 65_535) return null;
  return { host: (m[1] ?? m[2]) as string, port };
}

function isLoopback(address: string): boolean {
  return address === "::1" || address.startsWith("127.") || address.startsWith("::ffff:127.");
}

function listen(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

/**
 * Module `voice.link`: serves the Voice Link WebSocket endpoint (`ws://<bind>/voice-link`) and
 * provides `VoiceLink` (`VoiceLinkKey`).
 *
 * ```toml
 * [modules."voice.link"]
 * bind = "127.0.0.1:7879"
 * token = "${VOICE_LINK_TOKEN}"
 * ```
 */
export class VoiceLinkModule implements Module {
  static readonly ID = "voice.link";
  static readonly DEFAULT_BIND = DEFAULT_BIND;
  readonly manifest = defineManifest(VoiceLinkModule.ID, "Voice Link", {
    icon: "cable",
    category: "platform",
    description: "WebSocket link to the self voice node (Discord voice I/O)",
    configSchema: VoiceLinkConfigSchema,
  });
  #addr: AddressInfo | null = null;
  #link: VoiceLink | null = null;

  /** The address the server is bound to while running (useful with port 0). */
  localAddr(): AddressInfo | null {
    return this.#addr;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(VoiceLinkConfigSchema);
    if (config.token.trim() === "") {
      throw new VoiceLinkError(EMPTY_TOKEN);
    }
    const bind = parseBind(config.bind);
    if (!bind) throw new VoiceLinkError(`cannot bind voice link to \`${config.bind}\``);

    const link = new VoiceLink({
      config,
      publish: ctx.publisher,
      signal: ctx.signal,
      log: ctx.log,
    });
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_MESSAGE,
      perMessageDeflate: false,
    });
    const server = createServer((_req, res) => {
      res.writeHead(426, { "content-type": "text/plain" }).end("upgrade required");
    });
    server.on("upgrade", (req, socket, head) => {
      const path = (req.url ?? "").split("?")[0];
      if (path !== VOICE_LINK_PATH) {
        socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => link.serve(ws));
    });
    try {
      await listen(server, bind.host, bind.port);
    } catch (error) {
      throw new VoiceLinkError(
        `cannot bind voice link to \`${config.bind}\`: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const addr = server.address() as AddressInfo;
    if (!isLoopback(addr.address)) {
      ctx.log.warn(
        { addr: `${addr.address}:${addr.port}` },
        "voice link is reachable from the network over plain WebSocket",
      );
    }
    this.#addr = addr;
    ctx.log.info({ addr: `${addr.address}:${addr.port}` }, "voice link listening");
    this.#link = link;
    ctx.provide(VoiceLinkKey, link);
    ctx.provide(VoicePlayerKey, voicePlayer(link));

    // Remember her other accounts (e.g. the bot account) for `isSelf`.
    const ready = ctx.subscribe(Events.PlatformReady.type);
    ctx.spawn("self-accounts", async () => {
      for await (const env of ready) {
        if (is(Events.PlatformReady, env)) link.addSelfAccount(env.data.self_account);
      }
    });

    ctx.spawn("server", async (signal) => {
      const failed = new Promise<never>((_, reject) => {
        server.on("error", (error) =>
          reject(new VoiceLinkError("voice link server failed", { cause: error })),
        );
      });
      try {
        await Promise.race([aborted(signal), failed]);
      } finally {
        wss.close();
        server.close();
        server.closeAllConnections();
      }
    });
  }

  async stop(): Promise<void> {
    this.#addr = null;
    this.#link?.closeAll();
    this.#link = null;
  }
}
