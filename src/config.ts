import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { hostRunner, type WorkerRunner, sandboxRunner } from "./runners.ts";
import { createTenantConfig, type TenantConfig, validateTenants } from "./tenants.ts";

const root = resolve(import.meta.dirname, "..");

export interface AppConfig {
	configPath: string;
	dataDir: string;
	jobsDir: string;
	workspacesDir: string;
	provider: string;
	model: string;
	sandboxImage: string;
	askExtension: string;
	runnerKind: "sandbox" | "host";
	selectedTenantId: string;
	tenants: TenantConfig[];
}

export type RuntimeConfig = Pick<AppConfig, "runnerKind" | "sandboxImage" | "askExtension">;

interface RawAppConfig {
	dataDir?: string;
	provider?: string;
	model?: string;
	sandboxImage?: string;
	runner?: "sandbox" | "host";
	tenants?: Array<{
		id: string;
		discordUserId?: string;
		provider?: string;
		model?: string;
		timezone?: string;
	}>;
}

function nonEmptyString(value: unknown, label: string): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
	return value.trim();
}

function parseConfig(path: string): RawAppConfig {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Crumble config not found: ${path}`);
		throw new Error(`Could not parse Crumble config ${path}: ${(error as Error).message}`);
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Crumble config must be a JSON object");
	const raw = value as Record<string, unknown>;
	if (raw.tenants !== undefined && !Array.isArray(raw.tenants)) throw new Error("tenants must be an array");
	const tenants = raw.tenants?.map((candidate, index) => {
		if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error(`tenants[${index}] must be an object`);
		const tenant = candidate as Record<string, unknown>;
		if (typeof tenant.id !== "string") throw new Error(`tenants[${index}].id must be a string`);
		return {
			id: tenant.id,
			discordUserId: nonEmptyString(tenant.discordUserId, `tenants[${index}].discordUserId`),
			provider: nonEmptyString(tenant.provider, `tenants[${index}].provider`),
			model: nonEmptyString(tenant.model, `tenants[${index}].model`),
			timezone: nonEmptyString(tenant.timezone, `tenants[${index}].timezone`),
		};
	});
	const runner = raw.runner;
	if (runner !== undefined && runner !== "sandbox" && runner !== "host") throw new Error('runner must be "sandbox" or "host"');
	return {
		dataDir: nonEmptyString(raw.dataDir, "dataDir"),
		provider: nonEmptyString(raw.provider, "provider"),
		model: nonEmptyString(raw.model, "model"),
		sandboxImage: nonEmptyString(raw.sandboxImage, "sandboxImage"),
		runner,
		tenants,
	};
}

/** Load JSON configuration. Without a file, one private default tenant is enabled. */
export function loadAppConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
	const configPath = resolve(env.CRUMBLE_CONFIG ?? join(root, "crumble.config.json"));
	const hasConfig = existsSync(configPath);
	if (env.CRUMBLE_CONFIG && !hasConfig) throw new Error(`CRUMBLE_CONFIG points to a missing file: ${configPath}`);
	const raw = hasConfig ? parseConfig(configPath) : {};
	if (hasConfig && raw.tenants === undefined) throw new Error("Configured Crumble config must declare an explicit tenants array");
	const dataRoot = raw.dataDir ? resolve(dirname(configPath), raw.dataDir) : join(root, "data");
	const provider = raw.provider ?? env.CRUMBLE_PROVIDER ?? "openai";
	const model = raw.model ?? env.CRUMBLE_MODEL ?? "gpt-6-luna";
	const rawTenants = raw.tenants ?? [{ id: "default" }];
	if (rawTenants.length === 0) throw new Error("At least one tenant must be configured");
	const tenants = validateTenants(rawTenants.map((tenant) => createTenantConfig(dataRoot, tenant, { provider, model })));
	const selectedTenantId = env.CRUMBLE_TENANT ?? tenants[0]?.id;
	if (!selectedTenantId || !tenants.some((tenant) => tenant.id === selectedTenantId)) {
		throw new Error(`CRUMBLE_TENANT must name a configured tenant: ${selectedTenantId ?? "(none)"}`);
	}
	const runnerKind = raw.runner ?? env.CRUMBLE_RUNNER ?? "sandbox";
	if (runnerKind !== "sandbox" && runnerKind !== "host") throw new Error(`CRUMBLE_RUNNER must be "sandbox" or "host", got "${runnerKind}"`);
	if (runnerKind === "host" && tenants.length > 1) throw new Error("The host runner is only allowed when exactly one tenant is configured");
	return {
		configPath,
		dataDir: dataRoot,
		jobsDir: tenants.find((tenant) => tenant.id === selectedTenantId)!.jobsDir,
		workspacesDir: tenants.find((tenant) => tenant.id === selectedTenantId)!.workspacesDir,
		provider,
		model,
		sandboxImage: raw.sandboxImage ?? "crumble-sandbox",
		askExtension: join(root, "src", "worker", "ask.ts"),
		runnerKind,
		selectedTenantId,
		tenants,
	};
}

/** Create one tenant's worker runner. Zero-argument use stays for local scripts. */
export function createRunner(tenant?: TenantConfig, runtime?: RuntimeConfig): WorkerRunner {
	const fullConfig = runtime ? undefined : loadAppConfig();
	const app = runtime ?? fullConfig;
	const selected = tenant ?? fullConfig?.tenants.find((candidate) => candidate.id === fullConfig.selectedTenantId);
	if (!selected) throw new Error("No tenant is configured");
	if (!app) throw new Error("Runtime configuration is required when passing a tenant directly");
	const dirs = {
		tenantId: selected.id,
		rootDir: selected.rootDir,
		homeDir: selected.homeDir,
		jobsDir: selected.jobsDir,
		workspacesDir: selected.workspacesDir,
		agentDir: selected.agentDir,
	};
	if (app.runnerKind === "host") return hostRunner(dirs);
	return sandboxRunner(dirs, {
		image: app.sandboxImage,
		sandboxExtension: join(root, "src", "worker", "sandbox.ts"),
	});
}
