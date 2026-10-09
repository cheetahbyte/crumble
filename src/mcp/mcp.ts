import type { McpServerConfig } from "@earendil-works/pi-coding-agent";

export type McpServers = Readonly<Record<string, McpServerConfig>>;

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const ENV_REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
	return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

/** Checks the shape Crumble relies on; Pi validates and reports the remaining fields. */
export function validateMcpServers(value: unknown, label: string): McpServers {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	for (const [name, config] of Object.entries(value)) {
		const path = `${label}.${name}`;
		if (!SERVER_NAME.test(name)) throw new Error(`${path}: server names may contain only letters, digits, _ and -`);
		if (!isRecord(config)) throw new Error(`${path} must be an object`);
		const hasCommand = typeof config.command === "string" && config.command !== "";
		const hasUrl = typeof config.url === "string" && config.url !== "";
		if (hasCommand === hasUrl) throw new Error(`${path} must set either command or url`);
		if (config.args !== undefined && !(Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string"))) {
			throw new Error(`${path}.args must be an array of strings`);
		}
		for (const key of ["env", "headers"]) {
			if (config[key] !== undefined && !isStringRecord(config[key])) throw new Error(`${path}.${key} must map names to strings`);
		}
	}
	return value as McpServers;
}

/** The `${NAME}` variables the servers reference, so the scrubbed tenant environment can carry them. */
export function mcpEnvironment(servers: McpServers, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [, name] of JSON.stringify(servers).matchAll(ENV_REFERENCE)) {
		const value = base[name!];
		if (value !== undefined) env[name!] = value;
	}
	return env;
}

export function hasLocalServers(servers: McpServers): boolean {
	return Object.values(servers).some((config) => "command" in config);
}

/**
 * Runs local servers inside a sandbox container through `docker exec`. Pi still resolves `env` on the
 * host and sets it on the docker client, which forwards each name with `-e`.
 */
export function sandboxMcpServers(servers: McpServers, container: string): McpServers {
	return Object.fromEntries(Object.entries(servers).map(([name, config]) => {
		if (!("command" in config)) return [name, config];
		const { command, args = [], cwd, ...rest } = config;
		const forwarded = Object.keys(config.env ?? {}).flatMap((key) => ["-e", key]);
		const workdir = cwd ? ["-w", cwd] : [];
		return [name, { ...rest, command: "docker", args: ["exec", "-i", ...forwarded, ...workdir, container, command, ...args] }];
	}));
}
