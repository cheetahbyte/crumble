import { fileURLToPath } from "node:url";

// Headless RPC workers use the same pinned Pi package as the assistant SDK.
const piCli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));

// Bun loads .env from the working directory by default, and workers run inside user workspaces.
export const piCliArgs: readonly string[] = ["--no-env-file", piCli];
