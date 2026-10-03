import { spawn } from "node:child_process";
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

function dockerExec(container: string, argv: string[], stdin?: string): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn("docker", ["exec", "-i", container, ...argv]);
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (data: Buffer) => out.push(data));
		child.stderr.on("data", (data: Buffer) => err.push(data));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(Buffer.concat(out));
			else reject(new Error(Buffer.concat(err).toString().trim() || `docker exec exited with code ${code}`));
		});
		child.stdin.end(stdin ?? "");
	});
}

// The worker's Pi process runs on the host; its file and shell tools act inside the sandbox container.
export default function (pi: ExtensionAPI) {
	const container = process.env.CRUMBLE_SANDBOX_CONTAINER;
	if (!container) throw new Error("CRUMBLE_SANDBOX_CONTAINER is not set");
	const hostCwd = process.cwd();
	const inside = (path: string) => (path.startsWith(hostCwd) ? CONTAINER_CWD + path.slice(hostCwd.length) : path);

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
		exec: (command, cwd, { onData, signal, timeout }) =>
			new Promise((resolve, reject) => {
				// `timeout` runs inside the container so the command itself is killed, not only the docker client.
				const argv = timeout ? ["timeout", "-k", "5", String(timeout), "bash", "-c", command] : ["bash", "-c", command];
				const child = spawn("docker", ["exec", "-w", inside(cwd), container, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
				child.stdout.on("data", onData);
				child.stderr.on("data", onData);
				child.on("error", reject);
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("close", (code) => {
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("aborted"));
					else if (timeout && code === 124) reject(new Error(`timeout:${timeout}`));
					else resolve({ exitCode: code });
				});
			}),
	};

	pi.registerTool(createReadToolDefinition(hostCwd, { operations: read }));
	pi.registerTool(createWriteToolDefinition(hostCwd, { operations: write }));
	pi.registerTool(
		createEditToolDefinition(hostCwd, {
			operations: { readFile: read.readFile, writeFile: write.writeFile, access: read.access },
		}),
	);
	pi.registerTool(createBashToolDefinition(hostCwd, { operations: bash }));

	pi.on("before_agent_start", async (event) => ({
		systemPrompt: event.systemPrompt.replace(
			`Current working directory: ${hostCwd}`,
			`Current working directory: ${CONTAINER_CWD} (inside a Linux sandbox container)`,
		),
	}));
}
