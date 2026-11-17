import { PassThrough } from "node:stream";
import { type ExtensionDefinition, ExtensionRuntime, runExtension } from "../src/extension.js";
import { RpcPeer } from "../src/rpc.js";
import { type InitializeParams, type InitializeResult, PROTOCOL_VERSION } from "../src/types.js";

export interface Call {
  method: string;
  params: unknown;
}

/** A fake host connected to an extension runtime over in-memory streams. */
export function fakeHost(def: ExtensionDefinition, answer?: (call: Call) => unknown) {
  const hostToExt = new PassThrough();
  const extToHost = new PassThrough();
  const exits: number[] = [];
  const requests: Call[] = [];
  const notifications: Call[] = [];
  const runtime: ExtensionRuntime = runExtension(def, {
    input: hostToExt,
    output: extToHost,
    exit: (code) => exits.push(code),
    timeoutMs: 1000,
  });
  const host = new RpcPeer({
    input: extToHost,
    output: hostToExt,
    timeoutMs: 1000,
    onRequest: (method, params) => {
      const call = { method, params };
      requests.push(call);
      return answer ? answer(call) : {};
    },
    onNotification: (method, params) => notifications.push({ method, params }),
  });
  const initialize = (overrides: Partial<InitializeParams> = {}) =>
    host.request<InitializeResult>("initialize", { ...initParams(), ...overrides });
  return { host, runtime, requests, notifications, exits, initialize };
}

export function initParams(): InitializeParams {
  return {
    protocol: PROTOCOL_VERSION,
    host: { name: "miyoria", version: "0.1.0" },
    extension: { id: "test.ext", version: "1.0.0", dir: "/ext" },
    config: { greeting: "hi" },
    permissions: { events: ["custom.*"], tools: true, commands: true, network: [], input: [] },
  };
}

export const context = {
  platform: "discord",
  scope: null,
  channel: "c1",
  kind: "dm" as const,
};

export const account = { platform: "discord", id: "42" };

export const toolContext = {
  turn: "01J00000000000000000000000",
  context,
  account,
  message: { context, id: "m1" },
  priority: "direct" as const,
};

export function waitFor(predicate: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) resolve();
      else if (Date.now() - start > ms) reject(new Error("condition not met"));
      else setTimeout(tick, 5);
    };
    tick();
  });
}
