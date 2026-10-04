import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

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
	const container = `crumble-plugin-${randomUUID()}`;
	const child = spawn(
		"docker",
		[
			"run", "--rm", "-i", "--name", container, "--init", "--network", "bridge",
			"--read-only", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
			"--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64",
			"--memory=256m", "--cpus=1",
			"-v", `${context.snapshotDir}:/plugin:ro`,
			"-v", `${context.dataDir}:/data:rw`,
			"-w", "/plugin", context.image, "node", `/plugin/${context.entry}`,
		],
		{ stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" } },
	);
	const output: Buffer[] = [];
	const errors: Buffer[] = [];
	let outputBytes = 0;
	let errorBytes = 0;
	let settled = false;
	let timer: NodeJS.Timeout | undefined;
	let abort: (() => void) | undefined;
	const bestEffortRemove = () => {
		try {
			const cleanup = spawn("docker", ["rm", "-f", container], { stdio: "ignore" });
			cleanup.on("error", () => {});
		} catch { /* Cleanup must never crash the host process. */ }
	};
	const killContainer = () => {
		child.kill("SIGKILL");
		bestEffortRemove();
	};
	return await new Promise<string>((resolve, reject) => {
		const finish = (error?: Error, result?: string) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (abort) context.signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve(result ?? "");
		};
		timer = setTimeout(() => {
			killContainer();
			finish(new Error(`plugin timed out after ${TIMEOUT_MS}ms`));
		}, TIMEOUT_MS);
		if (context.signal) {
			abort = () => {
				killContainer();
				finish(new Error("plugin invocation aborted"));
			};
			if (context.signal.aborted) abort();
			else context.signal.addEventListener("abort", abort, { once: true });
		}
		child.on("error", (error) => finish(new Error(`could not start Docker: ${error.message}`)));
		child.stdin.on("error", (error) => {
			killContainer();
			finish(new Error(`could not send plugin input: ${error.message}`));
		});
		child.stdout.on("data", (chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > OUTPUT_LIMIT) {
				killContainer();
				finish(new Error(`plugin output exceeds ${OUTPUT_LIMIT} bytes`));
			} else output.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			errorBytes += chunk.length;
			if (errorBytes > OUTPUT_LIMIT) {
				killContainer();
				finish(new Error(`plugin output exceeds ${OUTPUT_LIMIT} bytes`));
			} else errors.push(chunk);
		});
		child.on("close", (code) => {
			if (settled) return;
			if (code !== 0) finish(new Error(Buffer.concat(errors).toString().trim().slice(0, 500) || `plugin exited with code ${code}`));
			else finish(undefined, Buffer.concat(output).toString());
		});
		child.stdin.end(input);
	});
};

export function pluginDataPath(rootDir: string, tenantId: string, name: string): string {
	return join(rootDir, "data", tenantId, name);
}
