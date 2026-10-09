import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { execa } from "execa";

export interface PluginExecutionContext {
	snapshotDir: string;
	entry: string;
	dataDir: string;
	image: string;
	input: unknown;
	signal?: AbortSignal;
}

export type PluginExecutor = (context: PluginExecutionContext) => Promise<string>;

const INPUT_LIMIT = 64 * 1024;
const OUTPUT_LIMIT = 1024 * 1024;
const TIMEOUT_MS = 30_000;

/** Run plugin code only inside a fresh Docker container. No host environment is forwarded. */
export const dockerPluginExecutor: PluginExecutor = async (context) => {
	const input = JSON.stringify(context.input);
	if (Buffer.byteLength(input) > INPUT_LIMIT) throw new Error(`input exceeds ${INPUT_LIMIT} bytes`);
	if (context.signal?.aborted) throw new Error("plugin invocation aborted");
	const container = `crumble-plugin-${randomUUID()}`;
	const dockerEnvironment = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" };
	const args = [
		"run", "--rm", "-i", "--name", container, "--init", "--network", "bridge",
		"--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
		"--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64",
		"--memory=256m", "--cpus=1",
		"-v", `${context.snapshotDir}:/plugin:ro`,
		"-v", `${context.dataDir}:/data:rw`,
		"-w", "/plugin", context.image, "node", `/plugin/${context.entry}`,
	];
	const removeContainer = async () => {
		try {
			await execa("docker", ["rm", "-f", container], {
				cwd: process.cwd(),
				stdio: "ignore",
				env: dockerEnvironment,
				extendEnv: false,
				timeout: 5_000,
				forceKillAfterDelay: 0,
			});
		} catch { /* Cleanup must never crash the host process. */ }
	};
	try {
		const result = await execa("docker", args, {
			input,
			cwd: process.cwd(),
			env: dockerEnvironment,
			extendEnv: false,
			cancelSignal: context.signal,
			timeout: TIMEOUT_MS,
			forceKillAfterDelay: 0,
			encoding: "buffer",
			stripFinalNewline: false,
			maxBuffer: { stdout: OUTPUT_LIMIT, stderr: OUTPUT_LIMIT },
		});
		return Buffer.from(result.stdout as Uint8Array).toString();
	} catch (error: unknown) {
		await removeContainer();
		const result = error as { code?: string; isCanceled?: boolean; timedOut?: boolean; isMaxBuffer?: boolean; stderr?: Uint8Array; message?: string };
		if (result.isCanceled) throw new Error("plugin invocation aborted");
		if (result.timedOut) throw new Error(`plugin timed out after ${TIMEOUT_MS}ms`);
		if (result.isMaxBuffer) throw new Error(`plugin output exceeds ${OUTPUT_LIMIT} bytes`);
		const stderr = result.stderr ? Buffer.from(result.stderr).toString().trim().slice(0, 500) : "";
		if (result.code === "ENOENT") throw new Error(`could not start Docker: ${result.message ?? "docker executable not found"}`);
		throw new Error(stderr || result.message || "plugin execution failed");
	}
};

export function pluginDataPath(rootDir: string, tenantId: string, name: string): string {
	return join(rootDir, "data", tenantId, name);
}
