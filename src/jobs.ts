import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type JobStatus = "running" | "waiting" | "done" | "failed" | "interrupted" | "cancelled";

export interface Job {
	id: string;
	project: string;
	brief: string;
	status: JobStatus;
	question: string | null;
	summary: string | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export interface JobNotification {
	job: Job;
	version: number;
}

export type JobPatch = Partial<Pick<Job, "status" | "question" | "summary" | "error">>;

interface JobRow {
	id: string;
	project: string;
	brief: string;
	status: string;
	question: string | null;
	summary: string | null;
	error: string | null;
	created_at: number;
	updated_at: number;
}

interface NotificationRow {
	job_id: string;
	version: number;
	job_json: string;
}

const STATUSES: readonly string[] = ["running", "waiting", "done", "failed", "interrupted", "cancelled"];
const NOTIFY_STATUSES: readonly JobStatus[] = ["waiting", "done", "failed", "interrupted", "cancelled"];

function toJob(row: JobRow): Job {
	if (!STATUSES.includes(row.status)) throw new Error(`Job ${row.id} has unknown status ${row.status}`);
	return {
		id: row.id,
		project: row.project,
		brief: row.brief,
		status: row.status as JobStatus,
		question: row.question,
		summary: row.summary,
		error: row.error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export class JobStore {
	private db: DatabaseSync;

	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS jobs (
				id TEXT PRIMARY KEY,
				project TEXT NOT NULL,
				brief TEXT NOT NULL,
				status TEXT NOT NULL,
				question TEXT,
				summary TEXT,
				error TEXT,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS job_notifications (
				job_id TEXT NOT NULL,
				version INTEGER NOT NULL,
				job_json TEXT NOT NULL,
				acknowledged_at INTEGER,
				PRIMARY KEY (job_id, version)
			);
		`);
	}

	create(project: string, brief: string): Job {
		const id = randomUUID();
		const now = Date.now();
		this.db
			.prepare("INSERT INTO jobs (id, project, brief, status, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?)")
			.run(id, project, brief, now, now);
		return this.require(id);
	}

	get(id: string): Job | undefined {
		const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
		return row ? toJob(row) : undefined;
	}

	require(id: string): Job {
		const job = this.get(id);
		if (!job) throw new Error(`No job with id ${id}`);
		return job;
	}

	list(): Job[] {
		const rows = this.db.prepare("SELECT * FROM jobs ORDER BY created_at DESC").all() as unknown as JobRow[];
		return rows.map(toJob);
	}

	update(id: string, patch: JobPatch): Job {
		const current = this.require(id);
		const now = Date.now();
		const next = { ...current, ...patch, updatedAt: now };
		this.db.exec("BEGIN IMMEDIATE");
		try {
			this.db
				.prepare("UPDATE jobs SET status = ?, question = ?, summary = ?, error = ?, updated_at = ? WHERE id = ?")
				.run(next.status, next.question, next.summary, next.error, now, id);
			if (NOTIFY_STATUSES.includes(next.status) && next.status !== current.status) {
				const version = Number(
					(this.db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM job_notifications WHERE job_id = ?").get(id) as { version: number }).version,
				) + 1;
				this.db
					.prepare("INSERT INTO job_notifications (job_id, version, job_json) VALUES (?, ?, ?)")
					.run(id, version, JSON.stringify(next));
			}
			this.db.exec("COMMIT");
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
		return next;
	}

	pendingNotifications(): JobNotification[] {
		const rows = this.db
			.prepare("SELECT job_id, version, job_json FROM job_notifications WHERE acknowledged_at IS NULL ORDER BY rowid")
			.all() as unknown as NotificationRow[];
		return rows.map((row) => ({ job: JSON.parse(row.job_json) as Job, version: row.version }));
	}

	acknowledgeNotification(jobId: string, version: number): boolean {
		const result = this.db
			.prepare("UPDATE job_notifications SET acknowledged_at = ? WHERE job_id = ? AND version = ? AND acknowledged_at IS NULL")
			.run(Date.now(), jobId, version);
		return Number(result.changes) > 0;
	}

	recoverInterrupted(): Job[] {
		const running = this.db.prepare("SELECT * FROM jobs WHERE status = 'running'").all() as unknown as JobRow[];
		return running.map((row) =>
			this.update(row.id, {
				status: "interrupted",
				question: null,
				error: "Worker was interrupted when the application stopped. Explicitly retry to continue this Pi session.",
			}),
		);
	}

	close(): void {
		this.db.close();
	}
}
