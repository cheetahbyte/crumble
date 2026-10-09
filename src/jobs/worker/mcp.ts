import { createMcpExtension, type McpServerConfig } from "@earendil-works/pi-coding-agent";

// The runner passes the tenant's servers, already wrapped for the job's sandbox.
const servers = JSON.parse(process.env.CRUMBLE_MCP_SERVERS || "{}") as Record<string, McpServerConfig>;

export default createMcpExtension({
	loadConfig: () => ({
		servers: Object.entries(servers).map(([name, config]) => ({ name, config, source: "crumble.config.json" })),
		errors: [],
	}),
});
