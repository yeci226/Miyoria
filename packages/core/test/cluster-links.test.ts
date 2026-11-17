// What Core tells hosts about its node links: the binds and tokens of `voice.link` and
// `stage.link`, a link that is off left out, and the public address when the cluster has one.

import { Config } from "@miyoria/runtime/kernel";
import { describe, expect, it } from "vitest";
import { clusterLinks } from "../src/cluster-links.js";

function toml(text: string): Config {
  return Config.fromToml(text, () => undefined);
}

describe("clusterLinks", () => {
  it("gives the port, path and token of each link that is on", () => {
    const config = toml(`
[modules."voice.link"]
bind = "0.0.0.0:7879"
token = "voice-secret"
[modules."stage.link"]
bind = "[::]:7882"
token = "stage-secret"
`);
    expect(clusterLinks(config)).toEqual({
      voice: { port: 7879, path: "/voice-link", token: "voice-secret" },
      stage: { port: 7882, path: "/stage-link", token: "stage-secret" },
    });
  });

  it("leaves out a link that is off, has no token, or no usable bind", () => {
    expect(clusterLinks(toml(""))).toEqual({});
    const config = toml(`
[modules."voice.link"]
enabled = false
token = "voice-secret"
[modules."stage.link"]
token = "  "
`);
    expect(clusterLinks(config)).toEqual({});
    expect(clusterLinks(toml(`[modules."voice.link"]\nbind = "nonsense"\ntoken = "t"\n`))).toEqual(
      {},
    );
    // The default bind when only the token is set.
    expect(clusterLinks(toml(`[modules."stage.link"]\ntoken = "t"\n`))).toEqual({
      stage: { port: 7882, path: "/stage-link", token: "t" },
    });
  });

  it("builds the address from the cluster's public_url, with the link's own port and path", () => {
    const config = toml(`
[modules.cluster]
public_url = "wss://core.example/cluster-link"
[modules."voice.link"]
bind = "0.0.0.0:7879"
token = "v"
`);
    expect(clusterLinks(config)).toEqual({
      voice: {
        url: "wss://core.example:7879/voice-link",
        port: 7879,
        path: "/voice-link",
        token: "v",
      },
    });
  });
});
