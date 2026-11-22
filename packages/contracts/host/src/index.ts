// @miyoria/contracts/host: what hostd, the per-machine supervisor, reads and speaks.
//
// `service.ts` and `host-config.ts` are the two TOML files (`service.toml`, `host.toml`); a
// descriptor's typo is an error because their objects are strict. `methods.ts` holds the params
// and results of the JSON-RPC methods between hostd, the CLI and Core; names and codes are
// constants in `protocol.ts` (docs/design/v5-hostd.md).

export * from "./gpu.js";
export * from "./host-config.js";
export * from "./methods.js";
export * from "./protocol.js";
export * from "./relay.js";
export * from "./routes.js";
export * from "./routing.js";
export * from "./service.js";
export * from "./upgrade.js";
