import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createTenantConfig, type TenantConfig, validateTenants } from "../tenants/tenants.ts";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const root = resolve(import.meta.dirname, "..", "..");

export interface AppConfig {
	configPath: string;
	dataDir: string;
	provider: string;
	model: string;
	sandboxImage: string;
	runnerKind: "sandbox" | "host";
	selectedTenantId: string;
	tenants: TenantConfig[];
}

export type RuntimeConfig = Pick<AppConfig, "runnerKind" | "sandboxImage">;

const RawTenantSchema = Type.Object({
	id: Type.String(),
	discordUserId: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	timezone: Type.Optional(Type.String()),
}, { additionalProperties: true });
const RawAppConfigSchema = Type.Object({
	dataDir: Type.Optional(Type.String()),
	provider: Type.Optional(Type.String()),
	model: Type.Optional(Type.String()),
	sandboxImage: Type.Optional(Type.String()),
	runner: Type.Optional(Type.Union([Type.Literal("sandbox"), Type.Literal("host")])),
	tenants: Type.Optional(Type.Array(RawTenantSchema)),
}, { additionalProperties: true });

type RawAppConfig = Static<typeof RawAppConfigSchema>;

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
	if (!Value.Check(RawAppConfigSchema, value)) {
		const error = Value.Errors(RawAppConfigSchema, value)[0];
		const path = String(error?.instancePath ?? "").replace(/^\//, "").replaceAll("/", ".") || "config";
		if (path === "config") throw new Error("Crumble config must be a JSON object");
		if (path === "tenants") throw new Error("tenants must be an array");
		if (/^tenants\.\d+$/.test(path)) throw new Error(`${path} must be an object`);
		if (/^tenants\.\d+\.id$/.test(path)) throw new Error(`${path} must be a string`);
		if (path === "runner") throw new Error('runner must be "sandbox" or "host"');
		throw new Error(`${path} must have a valid configuration value`);
	}
	const raw = value;
	const tenants = raw.tenants?.map((tenant, index) => {
		return {
			id: tenant.id,
			discordUserId: nonEmptyString(tenant.discordUserId, `tenants[${index}].discordUserId`),
			provider: nonEmptyString(tenant.provider, `tenants[${index}].provider`),
			model: nonEmptyString(tenant.model, `tenants[${index}].model`),
			timezone: nonEmptyString(tenant.timezone, `tenants[${index}].timezone`),
		};
	});
	const runner = raw.runner;
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
		provider,
		model,
		sandboxImage: raw.sandboxImage ?? "crumble-sandbox",
		runnerKind,
		selectedTenantId,
		tenants,
	};
}
