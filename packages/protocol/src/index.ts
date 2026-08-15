export * from "./checkpoints.js";
export * from "./events.js";
export * from "./wire.js";

// `./token.js` is deliberately NOT re-exported here. It touches the
// filesystem, and this entry point is the wire contract — it should stay
// importable from anywhere, including a browser client later. Reach it as
// `@mpa/protocol/token`.

export const DEFAULT_RELAY_PORT = 7331;
export const DEFAULT_RELAY_URL = `ws://127.0.0.1:${DEFAULT_RELAY_PORT}`;
