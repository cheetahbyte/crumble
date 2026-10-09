import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { relative, resolve, sep } from "node:path";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type ExtensionAPI,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";

const CONTAINER_CWD = "/workspace";
const IMAGE_TYPES: readonly string[] = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_COMMAND_TIMEOUT_SECONDS = 15 * 60;
const CANCEL_GRACE_MS = 2_500;

function dockerExec(container: string, argv: string[], stdin?: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", ["exec", "-i", container, ...argv]);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let settled = false;
		const finish = (error?: Error, result?: Buffer) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else resolve(result ?? Buffer.alloc(0));
		};
		child.stdout.on("data", (data: Buffer) => out.push(data));
		child.stderr.on("data", (data: Buffer) => err.push(data));
		child.on("error", (error) => finish(error));
		child.stdin.on("error", (error) => finish(error));
		child.on("close", (code) => {
			if (code === 0) finish(undefined, Buffer.concat(out));
			else finish(new Error(Buffer.concat(err).toString().trim() || `docker exec exited with code ${code}`));
		});
		child.stdin.end(stdin ?? "");
	});
}

export function workspacePath(hostCwd: string, path: string): string {
	if (path === CONTAINER_CWD || path.startsWith(`${CONTAINER_CWD}/`)) {
		const actual = resolve(path);
		const rel = relative(CONTAINER_CWD, actual);
		if (rel === ".." || rel.startsWith(`..${sep}`) || actual !== CONTAINER_CWD && !actual.startsWith(`${CONTAINER_CWD}/`)) {
			throw new Error(`sandbox path must stay inside the project workspace: ${path}`);
		}
		return actual;
	}
	const root = resolve(hostCwd);
	const actual = resolve(path);
	const rel = relative(root, actual);
	if (rel === ".." || rel.startsWith(`..${sep}`) || resolve(root, rel) !== actual) {
		throw new Error(`sandbox path must stay inside the project workspace: ${path}`);
	}
	return rel === "" ? CONTAINER_CWD : `${CONTAINER_CWD}/${rel.split(sep).join("/")}`;
}

function captureDockerExec(container: string, argv: string[], timeoutMs: number): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", ["exec", container, ...argv], { stdio: "ignore" });
		let finished = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error("sandbox process-group cleanup timed out"));
		}, timeoutMs);
		const finish = (error?: Error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve();
		};
		child.once("error", (error) => finish(error));
		child.once("close", (code) => code === 0 ? finish() : finish(new Error(`sandbox cleanup exited with code ${code}`)));
	});
}

async function killSandboxProcessGroup(container: string, marker: string): Promise<void> {
	const script = [
		'marker=$1',
		'for ((i=0; i<20; i++)); do [ -s "$marker" ] && break; sleep 0.05; done',
		'pid=$(cat -- "$marker" 2>/dev/null || true)',
		'case "$pid" in ""|*[!0-9]*) exit 0;; esac',
		'[ "$pid" -gt 1 ] || exit 0',
		'kill -TERM -- "-$pid" 2>/dev/null || exit 0',
		'for ((i=0; i<10; i++)); do kill -0 -- "-$pid" 2>/dev/null || exit 0; sleep 0.1; done',
		'kill -KILL -- "-$pid" 2>/dev/null || true',
	].join("\n");
	await captureDockerExec(container, ["bash", "-c", script, "crumble-cleanup", marker], CANCEL_GRACE_MS + 500);
}

export interface SandboxBashOptions {
	onData: (data: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
}

/** Run a shell command in its own container process group and clean descendants on exit/abort. */
export function runSandboxBash(container: string, cwd: string, command: string, options: SandboxBashOptions): Promise<{ exitCode: number | null }> {
	const { signal, onData } = options;
	if (signal?.aborted) return Promise.reject(new Error("aborted"));
	if (options.timeout !== undefined && (!Number.isFinite(options.timeout) || options.timeout <= 0)) {
		return Promise.reject(new Error("timeout must be a finite number of seconds greater than zero"));
	}
	const timeoutSeconds = Math.min(
		MAX_COMMAND_TIMEOUT_SECONDS,
		options.timeout === undefined ? MAX_COMMAND_TIMEOUT_SECONDS : Math.max(0.1, options.timeout),
	);
	const marker = `/tmp/crumble-command-${randomUUID()}.pid`;
	const script = [
		"set +e",
		"marker=$1; limit=$2; command=$3",
		"setsid --fork --wait bash -c 'printf \"%s\\n\" \"$$\" > \"$1\"; exec timeout -k 5 \"${2}s\" bash -c \"$3\"' crumble-command \"$marker\" \"$limit\" \"$command\" &",
		"launcher=$!",
		"wait \"$launcher\"",
		"status=$?",
		"pid=$(cat -- \"$marker\" 2>/dev/null || true)",
		"case \"$pid\" in \"\"|*[!0-9]*) ;; *)",
		"  kill -TERM -- \"-$pid\" 2>/dev/null || true",
		"  for ((i=0; i<10; i++)); do kill -0 -- \"-$pid\" 2>/dev/null || break; sleep 0.1; done",
		"  kill -KILL -- \"-$pid\" 2>/dev/null || true;;",
		"esac",
		"rm -f -- \"$marker\"",
		"exit \"$status\"",
	].join("\n");
	const child = spawn(
		"docker",
		["exec", "-w", cwd, container, "bash", "-c", script, "crumble-command-runner", marker, String(timeoutSeconds), command],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	return new Promise((resolve, reject) => {
		let settled = false;
		let cleanup: Promise<void> | undefined;
		let killTimer: NodeJS.Timeout | undefined;
		const finish = (error?: Error, exitCode?: number | null) => {
			if (settled) return;
			settled = true;
			if (killTimer) clearTimeout(killTimer);
			signal?.removeEventListener("abort", abort);
			if (error) reject(error);
			else resolve({ exitCode: exitCode ?? null });
		};
		const abort = () => {
			cleanup ??= killSandboxProcessGroup(container, marker).catch(() => {
				// A missing/unreachable Docker daemon prevents in-container cleanup; still stop waiting here.
			});
			void cleanup.finally(() => {
				if (settled) return;
				child.kill("SIGTERM");
				killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
			});
		};
		child.stdout.on("data", onData);
		child.stderr.on("data", onData);
		child.once("error", (error) => finish(error));
		child.once("close", (code) => {
			void (async () => {
				await cleanup;
				if (signal?.aborted) finish(new Error("aborted"));
				else if (options.timeout !== undefined && code === 124) finish(new Error(`timeout:${options.timeout}`));
				else finish(undefined, code);
			})();
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}

// The worker's Pi process runs on the host; its file and shell tools act inside the sandbox container.
export default function (pi: ExtensionAPI) {
	const container = process.env.CRUMBLE_SANDBOX_CONTAINER;
	if (!container) throw new Error("CRUMBLE_SANDBOX_CONTAINER is not set");
	const hostCwd = process.cwd();
	const inside = (path: string) => workspacePath(hostCwd, path);

	const read: ReadOperations = {
		readFile: (path) => dockerExec(container, ["cat", "--", inside(path)]),
		access: (path) => dockerExec(container, ["test", "-r", inside(path)]).then(() => {}),
		detectImageMimeType: async (path) => {
			try {
				const mime = (await dockerExec(container, ["file", "--mime-type", "-b", "--", inside(path)])).toString().trim();
				return IMAGE_TYPES.includes(mime) ? mime : null;
			} catch {
				return null;
			}
		},
	};

	const write: WriteOperations = {
		writeFile: (path, content) => dockerExec(container, ["sh", "-c", 'cat > "$1"', "sh", inside(path)], content).then(() => {}),
		mkdir: (dir) => dockerExec(container, ["mkdir", "-p", "--", inside(dir)]).then(() => {}),
	};

	const bash: BashOperations = {
		exec: (command, cwd, options) => runSandboxBash(container, inside(cwd), command, options),
	};

	pi.registerTool(createReadToolDefinition(hostCwd, { operations: read }));
	pi.registerTool(createWriteToolDefinition(hostCwd, { operations: write }));
	pi.registerTool(
		createEditToolDefinition(hostCwd, {
			operations: { readFile: read.readFile, writeFile: write.writeFile, access: read.access },
		}),
	);
	pi.registerTool(createBashToolDefinition(hostCwd, { operations: bash }));

	pi.on("before_agent_start", async (event) => {
		event.systemPromptOptions.cwd = CONTAINER_CWD;
		event.systemPromptOptions.sections.sandbox = "File and shell tools run inside a Linux sandbox container. " +
			"Your home directory (~) persists across jobs and projects: install tools there (npm install -g, pip install --user, or binaries in ~/.local/bin) and they stay available. Logins stored in ~ persist too. " +
			"Everything outside ~ and /workspace can be reset at any time. Check for already installed tools, such as claude, before installing.";
	});
}
