// Web search and a page reader for her (module `web`).

export { type WebConfig, WebConfigSchema } from "./config.js";
export type { SearchHit } from "./html.js";
export { WebModule } from "./module.js";
export { checkUrl, isBlockedAddress, WebError } from "./net.js";
export { WEB_NODE, webCapabilities } from "./tools.js";
export { WebService } from "./web.js";
