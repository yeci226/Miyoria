// Core's link address and token from the environment (hostd sets them on a machine that joined),
// over `[stage] core_url` and `token`; without them the config's own stay.

import { describe, expect, it } from "vitest";
import { parseStageConfig, stageLinkFromEnv } from "../src/index.js";

describe("stageLinkFromEnv", () => {
  const config = parseStageConfig({
    core_url: "ws://10.0.0.2:7882/stage-link",
    token: "from-toml",
  });

  it("keeps the config without the variables, or with empty ones", () => {
    expect(stageLinkFromEnv(config, {})).toEqual(config);
    const kept = stageLinkFromEnv(config, { STAGE_LINK_URL: " ", STAGE_LINK_TOKEN: "" });
    expect(kept.core_url).toBe("ws://10.0.0.2:7882/stage-link");
    expect(kept.token).toBe("from-toml");
  });

  it("takes each variable that is set over its key", () => {
    const both = stageLinkFromEnv(config, {
      STAGE_LINK_URL: "ws://core.tailnet:7882/stage-link",
      STAGE_LINK_TOKEN: "from-hostd",
    });
    expect(both.core_url).toBe("ws://core.tailnet:7882/stage-link");
    expect(both.token).toBe("from-hostd");
    expect(both.avatar).toBe(config.avatar);
    expect(stageLinkFromEnv(config, { STAGE_LINK_TOKEN: "t2" })).toMatchObject({
      core_url: "ws://10.0.0.2:7882/stage-link",
      token: "t2",
    });
  });
});
