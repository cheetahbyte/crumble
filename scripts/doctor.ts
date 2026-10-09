import { spawnSync } from "node:child_process";
import { loadAppConfig } from "../src/config/config.ts";
import { piCli } from "../src/shared/pi-command.ts";
import { prepareTenant, tenantEnvironment } from "../src/tenants/tenants.ts";

const app = loadAppConfig();
let ready = true;
console.log(`Configuration: ${app.configPath}`);
if (app.runnerKind === "sandbox") {
	const docker = spawnSync("docker", ["image", "inspect", app.sandboxImage], { stdio: "ignore", timeout: 10_000 });
	console.log(`Docker and sandbox image: ${docker.status === 0 ? "ready" : "not ready; start Docker and run pnpm sandbox:build"}`);
	ready &&= docker.status === 0;
}
const browser = spawnSync("docker", ["image", "inspect", "crumble-browser"], { stdio: "ignore", timeout: 10_000 });
console.log(`Browser image: ${browser.status === 0 ? "ready" : "not ready; start Docker and run pnpm browser:build"}`);
ready &&= browser.status === 0;
const mapped = app.tenants.some((tenant) => tenant.discordUserId);
console.log(`Discord bot token: ${process.env.DISCORD_TOKEN ? "configured (not tested)" : "not configured"}`);
if (mapped && !process.env.DISCORD_TOKEN) ready = false;
for (const tenant of app.tenants) {
	prepareTenant(tenant);
	const auth = spawnSync(process.execPath, [piCli, "auth", "check", "--provider", tenant.provider, "--no-refresh"], {
		cwd: tenant.homeDir, env: tenantEnvironment(tenant), stdio: "ignore", timeout: 15_000,
	});
	console.log(`${tenant.id}: model auth ${auth.status === 0 ? "ready" : `not ready; run pnpm auth --tenant ${tenant.id}`}; Discord ${tenant.discordUserId ? "mapped" : "unmapped"}`);
	ready &&= auth.status === 0;
}
process.exitCode = ready ? 0 : 1;
