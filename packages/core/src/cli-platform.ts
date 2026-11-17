// `platform.cli`: talk to her from the terminal (`miyoria chat`), no Discord needed. Every line
// typed is a DM from "you"; her replies are printed.

import { createInterface } from "node:readline";
import { defineManifest, type Module, type ModuleContext } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  type ContextKey,
  Events,
  type MessageRef,
  newId,
  type OutgoingMessage,
  type PlatformSink,
  type PlatformSinks,
  PlatformSinksKey,
  toTimestamp,
} from "@miyoria/types";

export const CLI_PLATFORM = "cli";

export interface CliPlatformOptions {
  /** Default `process.stdin`. */
  input?: NodeJS.ReadableStream;
  /** Default `process.stdout`. */
  output?: NodeJS.WritableStream;
}

function context(): ContextKey {
  return { platform: CLI_PLATFORM, scope: null, channel: "repl", kind: "dm" };
}

function account(id: string): AccountRef {
  return { platform: CLI_PLATFORM, id };
}

class Sink implements PlatformSink {
  readonly platform = CLI_PLATFORM;

  constructor(
    readonly herName: string,
    readonly out: NodeJS.WritableStream,
  ) {}

  async send(ctx: ContextKey, message: OutgoingMessage): Promise<MessageRef> {
    this.out.write(`\n\x1b[36m${this.herName}\x1b[0m: ${message.text}\n\n> `);
    return { context: ctx, id: newId() };
  }

  async react(_message: MessageRef, emoji: string): Promise<void> {
    this.out.write(`  (${this.herName} reacted ${emoji})\n`);
  }

  async typing(): Promise<void> {}
}

export class CliPlatform implements Module {
  static readonly ID = "platform.cli";
  readonly manifest = defineManifest(CliPlatform.ID, "Terminal chat", {
    description: "Chat with her from the terminal",
  });
  readonly #userName: string;
  readonly #herName: string;
  readonly #input: NodeJS.ReadableStream;
  readonly #output: NodeJS.WritableStream;
  #sinks: PlatformSinks | undefined;

  constructor(userName: string, herName: string, options: CliPlatformOptions = {}) {
    this.#userName = userName;
    this.#herName = herName;
    this.#input = options.input ?? process.stdin;
    this.#output = options.output ?? process.stdout;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const sinks = ctx.services.require(PlatformSinksKey);
    sinks.register(new Sink(this.#herName, this.#output));
    this.#sinks = sinks;
    ctx.publish(Events.PlatformReady, { platform: CLI_PLATFORM, self_account: account("her") });

    const userName = this.#userName;
    const input = this.#input;
    const out = this.#output;
    ctx.spawn("stdin", async (signal) => {
      const lines = createInterface({ input, terminal: false });
      const close = () => lines.close();
      signal.addEventListener("abort", close, { once: true });
      out.write("> ");
      try {
        for await (const line of lines) {
          if (signal.aborted) return;
          const text = line.trim();
          if (text === "") {
            out.write("> ");
            continue;
          }
          ctx.publish(Events.PlatformMessageCreated, {
            id: { context: context(), id: newId() },
            author: { account: account("you"), display_name: userName, is_bot: false },
            text,
            mentions_self: false,
            reply_to_self: false,
            attachments: [],
            ts: toTimestamp(ctx.clock.now()),
          });
        }
      } finally {
        signal.removeEventListener("abort", close);
        lines.close();
      }
    });
  }

  async stop(): Promise<void> {
    this.#sinks?.unregister(CLI_PLATFORM);
    this.#sinks = undefined;
  }
}
