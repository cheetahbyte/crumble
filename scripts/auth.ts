import { loadAppConfig } from "../src/config/config.ts";
import { prepareTenant } from "../src/tenants/tenants.ts";
import { runAuthLogin } from "../src/auth/auth.ts";

const app = loadAppConfig();
const args = process.argv.slice(2).filter((arg) => arg !== "--");
const tenantArg = args.indexOf("--tenant");
const id = tenantArg >= 0 ? args[tenantArg + 1] : undefined;
if (!id || id.startsWith("--")) throw new Error("Usage: bun run auth --tenant <tenant-id> [--method oauth|api_key]");
const methodArg = args.indexOf("--method");
const method = methodArg < 0 ? undefined : args[methodArg + 1];
if (methodArg >= 0 && (!method || method.startsWith("--"))) {
	throw new Error('Usage: bun run auth --tenant <tenant-id> [--method oauth|api_key]');
}
if (method !== undefined && method !== "oauth" && method !== "api_key") {
	throw new Error('Authentication method must be "oauth" or "api_key"');
}
const tenant = app.tenants.find((item) => item.id === id);
if (!tenant) throw new Error(`Unknown tenant: ${id}`);
prepareTenant(tenant);
console.log(`Starting ${tenant.provider} authentication for tenant ${tenant.id}.`);
console.log(`Pi will save the login under ${tenant.agentDir}.`);
try {
	const completed = await runAuthLogin(tenant, method);
	process.exitCode = completed ? 0 : 130;
} catch (error) {
	console.error(`Authentication failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
