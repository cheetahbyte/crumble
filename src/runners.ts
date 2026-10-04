import { createHash } from "node:crypto";
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Job } from "./jobs.ts";
import { piCli } from "./pi-command.ts";
import { tenantEnvironment } from "./tenants.ts";

export interface WorkerRunner {
	sessionDir(job: Job): string;
	spawn(job: Job, piArgs: string[]): ChildProcessWithoutNullStreams;
}

export interface RunnerDirs {
	jobsDir: string;
	workspacesDir: string;
	/** Tenant ID is included in sandbox names when the runner is tenant-scoped. */
	tenantId?: string;
	homeDir?: string;
	agentDir?: string;
	rootDir?: string;
}

const SLUG = /^[a-z0-9](?:[a-z0-9_-]{0,62}[a-z0-9])?$/;

function isWithin(parent: string, child: string): boolean {
	const rel = relative(parent, child);
	return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function assertScopedPath(root: string | undefined, path: string, label: string): string {
	const actual = realpathSync(path);
	if (root) {
		const actualRoot = realpathSync(root);
		if (!isWithin(actualRoot, actual)) throw new Error(`${label} resolves outside the tenant directory`);
	}
	return actual;
}

function rejectSymlink(path: string, label: string): void {
	try {
		if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link`);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

function validateProject(project: string): string {
	if (!SLUG.test(project)) throw new Error(`Invalid project name ${JSON.stringify(project)}: use a lowercase slug`);
	return project;
}

export function resolveWorkspacePath(dirs: RunnerDirs, project: string): string {
	validateProject(project);
	if (dirs.rootDir) rejectSymlink(dirs.rootDir, "Tenant directory");
	rejectSymlink(dirs.workspacesDir, "Tenant workspaces directory");
	mkdirSync(dirs.workspacesDir, { recursive: true, mode: 0o700 });
	const workspaces = assertScopedPath(dirs.rootDir, dirs.workspacesDir, "Workspace directory");
	const workspace = resolve(workspaces, project);
	rejectSymlink(workspace, "Project workspace");
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	const actual = assertScopedPath(dirs.rootDir ? realpathSync(dirs.rootDir) : workspaces, workspace, "Project workspace");
	if (!isWithin(workspaces, actual)) throw new Error("Project workspace resolves outside the tenant workspaces directory");
	return actual;
}

function prepareSessionDir(dirs: RunnerDirs, job: Job): string {
	if (!SLUG.test(job.id)) throw new Error(`Invalid job id ${JSON.stringify(job.id)}`);
	if (dirs.rootDir) rejectSymlink(dirs.rootDir, "Tenant directory");
	rejectSymlink(dirs.jobsDir, "Tenant jobs directory");
	mkdirSync(dirs.jobsDir, { recursive: true, mode: 0o700 });
	assertScopedPath(dirs.rootDir, dirs.jobsDir, "Jobs directory");
	const jobDir = join(dirs.jobsDir, job.id);
	rejectSymlink(jobDir, "Job directory");
	const dir = join(jobDir, "sessions");
	rejectSymlink(dir, "Job session directory");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const actual = assertScopedPath(dirs.rootDir, dir, "Job session directory");
	if (!isWithin(realpathSync(dirs.jobsDir), actual)) throw new Error("Job session directory resolves outside the tenant jobs directory");
	return actual;
}

/** Pass only execution essentials and tenant-local Pi/HOME locations to workers. */
export function workerEnvironment(dirs: RunnerDirs, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = dirs.homeDir && dirs.agentDir
		? tenantEnvironment({ homeDir: dirs.homeDir, agentDir: dirs.agentDir })
		: { PATH: process.env.PATH, HOME: dirs.homeDir };
	if (dirs.agentDir) env.PI_CODING_AGENT_DIR = dirs.agentDir;
	return { ...env, ...extra };
}

// Unsandboxed: the worker's tools act directly on this machine.
export function hostRunner(dirs: RunnerDirs): WorkerRunner {
	return {
		sessionDir: (job) => prepareSessionDir(dirs, job),
		spawn(job, piArgs) {
			const workspace = resolveWorkspacePath(dirs, job.project);
			return spawn(process.execPath, [piCli, ...piArgs], { cwd: workspace, env: workerEnvironment(dirs) });
		},
	};
}

export interface SandboxOptions {
	image: string;
	sandboxExtension: string;
}

export function containerName(dirs: RunnerDirs, workspace: string, project: string): string {
	const scope = dirs.tenantId ? `${dirs.tenantId}-` : "";
	const hash = createHash("sha256").update(resolve(workspace)).digest("hex").slice(0, 12);
	return `crumble-sandbox-${scope}${project}-${hash}`.slice(0, 120);
}

function ensureSandbox(name: string, workspace: string, image: string): void {
	let running = "";
	try {
		running = execFileSync("docker", ["inspect", "-f", "{{.State.Running}}", name], { stdio: ["ignore", "pipe", "ignore"] })
			.toString()
			.trim();
	} catch {
		// No container with this name yet.
	}
	if (running === "true") return;
	if (running === "false") execFileSync("docker", ["rm", name], { stdio: "ignore" });
	execFileSync(
		"docker",
		[
			"run",
			"-d",
			"--name",
			name,
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--pids-limit",
			"512",
			"-v",
			`${workspace}:/workspace`,
			"-w",
			"/workspace",
			image,
			"sleep",
			"infinity",
		],
		{ stdio: "ignore" },
	);
}

// The worker's Pi process runs on the host with the tenant's Pi config; file and shell tools
// run in one long-lived container per tenant and full workspace path.
export function sandboxRunner(dirs: RunnerDirs, options: SandboxOptions): WorkerRunner {
	return {
		sessionDir: (job) => prepareSessionDir(dirs, job),
		spawn(job, piArgs) {
			const workspace = resolveWorkspacePath(dirs, job.project);
			const container = containerName(dirs, workspace, job.project);
			ensureSandbox(container, workspace, options.image);
			const env = workerEnvironment(dirs, { CRUMBLE_SANDBOX_CONTAINER: container });
			return spawn(process.execPath, [piCli, ...piArgs, "-e", options.sandboxExtension], { cwd: workspace, env });
		},
	};
}
