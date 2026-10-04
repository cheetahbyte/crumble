import { fileURLToPath } from "node:url";

// Headless RPC workers use the same pinned Pi package as the assistant SDK.
export const piCli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
