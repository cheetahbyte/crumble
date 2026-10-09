import { lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { rejectSymlink, SLUG, validateTimezone } from "../shared/paths.ts";

export interface TenantInput {
	id: string;
	discordUserId?: string;
	provider?: string;
	model?: string;
	timezone?: string;
}

export interface TenantConfig extends TenantInput {
	provider: string;
	model: string;
	timezone: string;
	rootDir: string;
	homeDir: string;
	agentDir: string;
	jobsDir: string;
	workspacesDir: string;
	stateDatabasePath: string;
	jobsDatabasePath: string;
}

export interface TenantDefaults {
	provider: string;
	model: string;
	timezone?: string;
}

/** Minimal process environment for work performed on behalf of one tenant. */
export function tenantEnvironment(
	tenant: Pick<TenantConfig, "homeDir" | "agentDir">,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "TERM"]) {
		if (base[key] !== undefined) env[key] = base[key];
	}
	env.HOME = tenant.homeDir;
	env.XDG_CONFIG_HOME = join(tenant.homeDir, ".config");
	env.PI_CODING_AGENT_DIR = tenant.agentDir;
	return env;
}

const DISCORD_ID = /^\d{17,20}$/;

export function validateTenantId(id: string): string {
	if (!SLUG.test(id)) throw new Error(`Invalid tenant id ${JSON.stringify(id)}: use a lowercase slug`);
	return id;
}

export function createTenantConfig(dataDir: string, input: TenantInput, defaults: TenantDefaults): TenantConfig {
	const id = validateTenantId(input.id);
	if (input.discordUserId !== undefined && !DISCORD_ID.test(input.discordUserId)) {
		throw new Error(`Invalid Discord user id for tenant ${id}: expected a Discord snowflake`);
	}
	const timezone = validateTimezone(input.timezone ?? defaults.timezone ?? "Europe/Berlin");
	const rootDir = join(dataDir, "tenants", id);
	return {
		...input,
		id,
		provider: input.provider ?? defaults.provider,
		model: input.model ?? defaults.model,
		timezone,
		rootDir,
		homeDir: join(rootDir, "home"),
		agentDir: join(rootDir, "agent"),
		jobsDir: join(rootDir, "jobs"),
		workspacesDir: join(rootDir, "workspaces"),
		stateDatabasePath: join(rootDir, "assistant.db"),
		jobsDatabasePath: join(rootDir, "jobs", "jobs.db"),
	};
}

export function validateTenants(tenants: TenantConfig[]): TenantConfig[] {
	const ids = new Set<string>();
	const discordIds = new Set<string>();
	for (const tenant of tenants) {
		if (ids.has(tenant.id)) throw new Error(`Duplicate tenant id: ${tenant.id}`);
		ids.add(tenant.id);
		if (tenant.discordUserId) {
			if (discordIds.has(tenant.discordUserId)) throw new Error(`Discord user ${tenant.discordUserId} is assigned to more than one tenant`);
			discordIds.add(tenant.discordUserId);
		}
	}
	return tenants;
}

/** Prepare an owned tenant's private directories and its general-purpose personal workspace. */
export function prepareTenant(tenant: TenantConfig): void {
	mkdirSync(tenant.rootDir, { recursive: true, mode: 0o700 });
	assertDirectory(tenant.rootDir, "Tenant root");
	for (const path of [tenant.homeDir, tenant.agentDir, tenant.jobsDir, tenant.workspacesDir]) {
		mkdirSync(path, { recursive: true, mode: 0o700 });
		assertDirectory(path, "Tenant directory");
	}
	const personal = join(tenant.workspacesDir, "personal");
	mkdirSync(personal, { recursive: true, mode: 0o700 });
	assertDirectory(personal, "Personal workspace");
	for (const path of [
		tenant.stateDatabasePath,
		`${tenant.stateDatabasePath}-wal`,
		`${tenant.stateDatabasePath}-shm`,
		tenant.jobsDatabasePath,
		`${tenant.jobsDatabasePath}-wal`,
		`${tenant.jobsDatabasePath}-shm`,
		join(tenant.agentDir, "auth.json"),
		join(tenant.agentDir, "settings.json"),
		join(tenant.agentDir, "models.json"),
		join(tenant.agentDir, "models-cache.json"),
	]) {
		rejectSymlink(path, `Tenant file ${path}`);
	}
}

function assertDirectory(path: string, label: string): void {
	const stat = lstatSync(path);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be a real directory: ${path}`);
}
