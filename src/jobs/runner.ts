import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Job } from "./jobs.ts";
import { isWithin, rejectSymlink, SLUG } from "../shared/paths.ts";
import { type TenantConfig, tenantEnvironment } from "../tenants/tenants.ts";

export interface WorkerRunner {
	sessionDir(job: Job): string;
	spawn(job: Job, piArgs: string[]): ChildProcessWithoutNullStreams;
}

export type RunnerDirs = Pick<TenantConfig, "id" | "rootDir" | "homeDir" | "agentDir" | "jobsDir" | "workspacesDir">;

export function assertScopedPath(root: string, path: string, label: string): string {
	const actual = realpathSync(path);
	if (!isWithin(realpathSync(root), actual)) throw new Error(`${label} resolves outside the tenant directory`);
	return actual;
}

export function resolveWorkspacePath(dirs: Pick<RunnerDirs, "rootDir" | "workspacesDir">, project: string): string {
	if (!SLUG.test(project)) throw new Error(`Invalid project name ${JSON.stringify(project)}: use a lowercase slug`);
	rejectSymlink(dirs.rootDir, "Tenant directory");
	rejectSymlink(dirs.workspacesDir, "Tenant workspaces directory");
	mkdirSync(dirs.workspacesDir, { recursive: true, mode: 0o700 });
	const workspaces = assertScopedPath(dirs.rootDir, dirs.workspacesDir, "Workspace directory");
	const workspace = resolve(workspaces, project);
	rejectSymlink(workspace, "Project workspace");
	mkdirSync(workspace, { recursive: true, mode: 0o700 });
	const actual = assertScopedPath(dirs.rootDir, workspace, "Project workspace");
	if (!isWithin(workspaces, actual)) throw new Error("Project workspace resolves outside the tenant workspaces directory");
	return actual;
}

export function prepareSessionDir(dirs: RunnerDirs, job: Job): string {
	if (!SLUG.test(job.id)) throw new Error(`Invalid job id ${JSON.stringify(job.id)}`);
	rejectSymlink(dirs.rootDir, "Tenant directory");
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
	return { ...tenantEnvironment(dirs), ...extra };
}
