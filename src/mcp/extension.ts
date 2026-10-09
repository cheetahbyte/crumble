import {
	createCodemodeExtension, createMcpExtension, createToolSearchExtension, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { McpServers } from "./mcp.ts";

/** Pi's MCP support, fed from Crumble's config instead of `mcp.json`. Codemode and tool search reach non-direct tools. */
export function mcpExtensions(servers: McpServers): ExtensionFactory[] {
	return [
		createCodemodeExtension(),
		createToolSearchExtension(),
		createMcpExtension({
			loadConfig: () => ({
				servers: Object.entries(servers).map(([name, config]) => ({ name, config, source: "crumble.config.json" })),
				errors: [],
			}),
		}),
	];
}
