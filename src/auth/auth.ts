import { join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { tenantEnvironment, type TenantConfig } from "../tenants/tenants.ts";

type AuthType = Parameters<ModelRuntime["login"]>[1];
type AuthInteraction = Parameters<ModelRuntime["login"]>[2];
type AuthPrompt = Parameters<AuthInteraction["prompt"]>[0];

export interface AuthLoginPaths {
	authPath: string;
	modelsPath: string;
	modelsStorePath: string;
}

export function authLoginPaths(tenant: TenantConfig): AuthLoginPaths {
	return {
		authPath: join(tenant.agentDir, "auth.json"),
		modelsPath: join(tenant.agentDir, "models.json"),
		modelsStorePath: join(tenant.agentDir, "models-cache.json"),
	};
}

export function selectAuthType(
	provider: { auth: { oauth?: unknown; apiKey?: { login?: unknown } } },
	requested?: AuthType,
): AuthType {
	const supportsOauth = Boolean(provider.auth.oauth);
	const supportsApiKey = typeof provider.auth.apiKey?.login === "function";
	const type = requested ?? (supportsOauth ? "oauth" : "api_key");
	if (type === "oauth" && !supportsOauth) throw new Error("This provider does not support OAuth login");
	if (type === "api_key" && !supportsApiKey) throw new Error("This provider does not support API key login");
	return type;
}

/** Run Pi's provider-owned login flow directly, without starting an agent or session. */
export async function runAuthLogin(tenant: TenantConfig, requestedType?: AuthType): Promise<boolean> {
	const tenantEnv = tenantEnvironment(tenant);
	for (const key of Object.keys(process.env)) {
		if (!(key in tenantEnv)) delete process.env[key];
	}
	Object.assign(process.env, tenantEnv);
	const runtime = await ModelRuntime.create({ ...authLoginPaths(tenant), refreshOnCreate: false });
	const provider = runtime.getProvider(tenant.provider);
	if (!provider) throw new Error(`Unknown Pi provider: ${tenant.provider}`);
	const type = selectAuthType(provider, requestedType);
	const settings = SettingsManager.create(tenant.homeDir, tenant.agentDir);
	const controller = new AbortController();
	const cancel = () => controller.abort(new Error("Login cancelled"));
	const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
	for (const signal of signals) process.once(signal, cancel);
	try {
		await runtime.login(tenant.provider, type, {
			signal: controller.signal,
			prompt: (prompt) => ask(prompt, cancel),
			notify: showAuthEvent,
		}, { getDeviceId: () => settings.getOrCreateDeviceId() });
		console.log(`Authentication saved for ${tenant.provider} in this tenant's private agent directory.`);
		return true;
	} catch (error) {
		if (controller.signal.aborted || (error instanceof Error && error.message === "Login cancelled")) return false;
		throw error;
	} finally {
		for (const signal of signals) process.off(signal, cancel);
		await settings.flush();
	}
}

async function ask(prompt: AuthPrompt, cancelLogin: () => void): Promise<string> {
	if (prompt.signal?.aborted) throw new Error("Login cancelled");
	if (prompt.type === "select") {
		console.log(prompt.message);
		prompt.options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
		const answer = await readLine(`Choose a number (1-${prompt.options.length}): `, prompt.signal, false, cancelLogin);
		const selected = prompt.options[Number.parseInt(answer, 10) - 1];
		if (!selected) throw new Error("Invalid selection");
		return selected.id;
	}
	const hint = prompt.placeholder ? ` (${prompt.placeholder})` : "";
	const question = `${prompt.message}${hint}: `;
	return readLine(question, prompt.signal, prompt.type === "secret", cancelLogin);
}

function readLine(question: string, signal?: AbortSignal, secret = false, cancelLogin?: () => void): Promise<string> {
	const input = process.stdin;
	if (!input.isTTY || typeof input.setRawMode !== "function") {
		return Promise.reject(new Error("Pi authentication prompts require an interactive terminal"));
	}
	return new Promise((resolve, reject) => {
		const wasRaw = input.isRaw;
		let answer = "";
		let settled = false;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			input.off("keypress", onKeypress);
			input.off("end", onEnd);
			signal?.removeEventListener("abort", onAbort);
			input.pause();
			if (input.isRaw !== wasRaw) input.setRawMode(wasRaw);
			process.stdout.write("\n");
			if (error) reject(error);
			else resolve(answer);
		};
		const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
			if (key.ctrl && key.name === "c") {
				cancelLogin?.();
				finish(new Error("Login cancelled"));
			} else if (key.name === "return" || key.name === "enter") {
				finish();
			} else if (key.name === "backspace" || key.name === "delete") {
				const letters = Array.from(answer);
				letters.pop();
				answer = letters.join("");
				if (!secret) process.stdout.write("\b \b");
			} else if (character && !key.ctrl && character >= " ") {
				answer += character;
				if (!secret) process.stdout.write(character);
			}
		};
		const onEnd = () => finish(new Error("Input closed before login completed"));
		const onAbort = () => finish(new Error("Login cancelled"));
		emitKeypressEvents(input);
		input.setRawMode(true);
		input.on("keypress", onKeypress);
		input.once("end", onEnd);
		signal?.addEventListener("abort", onAbort, { once: true });
		process.stdout.write(question);
		input.resume();
	});
}

function showAuthEvent(event: Parameters<AuthInteraction["notify"]>[0]): void {
	switch (event.type) {
		case "auth_url":
			console.log(`Open this URL in your browser:\n${event.url}`);
			if (event.instructions) console.log(event.instructions);
			break;
		case "device_code":
			console.log(`Open ${event.verificationUri} and enter code ${event.userCode}.`);
			break;
		case "info":
		case "progress":
			console.log(event.message);
			if (event.type === "info") {
				for (const link of event.links ?? []) console.log(`${link.label ?? "More information"}: ${link.url}`);
			}
			break;
	}
}
